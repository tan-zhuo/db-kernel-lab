import {
  assert,
  clamp,
  lowerBound,
  upperBound,
  type Key,
  type PageId,
  type PageType,
  type Row,
} from '@dbkl/shared';
import type { EntryBatch, SimulationEventBody } from '../events';
import type { StructuralIndex } from '../state';
import type { EngineConfig } from './types';

/**
 * 可复用的 B+ 树。
 *
 * 从 Phase 1 的 InnoDB 引擎里抽出来，因为 Phase 2 的 PostgreSQL 引擎同样需要 B 树 ——
 * 区别只在**叶子项里放什么**：
 *
 *  - InnoDB 聚簇索引：叶子项 = 整行；二级索引叶子项 = (索引列, 主键)；
 *  - PostgreSQL：所有索引都是「二级」的，叶子项 = (索引列, TID)，
 *    因此**任何**索引扫描都必须再去堆表取一次行。
 *
 * 树本身对这个差异一无所知：它只要求宿主提供一个 `tieBreak(row)`，
 * 用来在允许重复键的树里给相等的键定序（InnoDB 用主键，PostgreSQL 用 TID）。
 */

export type AccessPurpose = 'search' | 'insert' | 'delete' | 'scan' | 'maintain';

/** 树内部的页对象（与 LabState.PageState 形状一致，但由算法直接维护）。 */
export interface TreeNode {
  id: PageId;
  /** 所属索引；同一个引擎里可以并存多棵 B+ 树。 */
  indexId: string;
  type: PageType;
  level: number;
  parentId: PageId | null;
  keys: Key[];
  rows: (Row | null)[];
  children: PageId[];
  prev: PageId | null;
  next: PageId | null;
  dirty: boolean;
}

/**
 * 宿主引擎必须提供的能力。
 *
 * 页表 `nodes` 由宿主持有（页号在整个引擎里全局唯一，缓冲池也要按页号索引），
 * 树只负责往里增删。
 */
export interface TreeHost {
  readonly config: EngineConfig;
  readonly nodes: Map<PageId, TreeNode>;
  emit(body: SimulationEventBody): void;
  allocPageId(): PageId;
  /** 一次逻辑页访问：宿主负责缓冲池 + `PAGE_READ` 事件。 */
  access(pageId: PageId, purpose: AccessPurpose): void;
  /** 页被回收时从缓冲池摘除。 */
  forgetPage(pageId: PageId): void;
  /**
   * 相等键之间的次级排序值。允许重复键的树用它定位「具体是哪一条」。
   * 无意义时返回 `Number.NEGATIVE_INFINITY`。
   */
  tieBreak(row: Row | null | undefined): number;
}

export interface TreeSpec {
  id: string;
  name: string;
  column: string;
  clustered: boolean;
  unique: boolean;
}

export type InsertMode = 'unique' | 'duplicates';

export class BPlusTree {
  readonly id: string;
  readonly name: string;
  readonly column: string;
  readonly clustered: boolean;
  readonly unique: boolean;

  rootId: PageId;
  firstLeafId: PageId;
  height = 1;
  entries = 0;
  distinct = 0;
  minKey: Key | null = null;
  maxKey: Key | null = null;

  constructor(
    private readonly host: TreeHost,
    spec: TreeSpec,
  ) {
    this.id = spec.id;
    this.name = spec.name;
    this.column = spec.column;
    this.clustered = spec.clustered;
    this.unique = spec.unique;

    this.host.emit({
      type: 'INDEX_CREATE',
      indexId: this.id,
      name: this.name,
      column: this.column,
      clustered: this.clustered,
      unique: this.unique,
    });
    const root = this.allocPage('leaf', 0, null);
    this.rootId = root.id;
    this.firstLeafId = root.id;
    this.host.emit({ type: 'ROOT_CHANGE', indexId: this.id, oldRootId: null, newRootId: root.id, height: 1 });
    this.host.emit({ type: 'LEAF_LINK', pageId: root.id, prev: null, next: null });
  }

  // ——— 插入 / 删除 ————————————————————————————————————

  /**
   * 插入一条索引项。
   * `duplicates` 模式允许重复键，重复键之间按 `tieBreak(row)` 升序排列。
   */
  insert(key: Key, row: Row, mode: InsertMode): { result: 'inserted' | 'updated'; oldRow: Row | null } {
    const leafId = this.descend(key, 'insert');
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    const hadEqual = leaf.keys[idx] === key;

    if (mode === 'unique' && hadEqual) {
      const oldRow = leaf.rows[idx] ?? null;
      this.host.emit({ type: 'RECORD_UPDATE', pageId: leaf.id, slot: idx, key, row, oldRow });
      leaf.rows[idx] = row;
      this.markDirty(leaf);
      return { result: 'updated', oldRow };
    }

    this.host.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key, row });
    leaf.keys.splice(idx, 0, key);
    leaf.rows.splice(idx, 0, row);
    this.markDirty(leaf);

    this.entries++;
    if (!hadEqual) this.distinct++;
    this.minKey = this.minKey === null ? key : Math.min(this.minKey, key);
    this.maxKey = this.maxKey === null ? key : Math.max(this.maxKey, key);

    if (leaf.keys.length > this.capacity()) this.splitLeaf(leaf, key);
    return { result: 'inserted', oldRow: null };
  }

  /** 删除一条索引项，返回被删除的叶子行；未找到返回 undefined。 */
  remove(key: Key, tie?: number): Row | null | undefined {
    const startLeafId = this.descend(key, 'delete');
    const hit = this.locate(startLeafId, key, this.unique ? undefined : tie);
    if (!hit) return undefined;
    const leaf = this.node(hit.pageId);
    const idx = hit.slot;

    const removed = leaf.rows[idx] ?? null;
    this.host.emit({ type: 'RECORD_DELETE', pageId: leaf.id, slot: idx, key, row: removed });
    leaf.keys.splice(idx, 1);
    leaf.rows.splice(idx, 1);
    this.markDirty(leaf);

    this.entries--;
    const stillHasKey =
      leaf.keys[idx] === key || (idx > 0 && leaf.keys[idx - 1] === key) || this.leafNeighborHasKey(leaf, key);
    if (!stillHasKey) this.distinct = Math.max(0, this.distinct - 1);

    // 分隔键是下界，删掉页内首键后父页分隔键仍然合法，与 InnoDB 一致：不重写父页。
    this.rebalance(leaf);
    return removed;
  }

  /**
   * 从 `startLeafId` 开始，在相等键区间内定位一条记录。
   * 传入 `tie` 时会沿叶子链表继续向右找，直到找到次级键匹配的那一条。
   */
  private locate(startLeafId: PageId, key: Key, tie?: number): { pageId: PageId; slot: number } | null {
    let cursor: PageId | null = startLeafId;
    let idx = lowerBound(this.node(startLeafId).keys, key);
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (; idx < leaf.keys.length; idx++) {
        if (leaf.keys[idx] !== key) return null;
        if (tie === undefined || this.host.tieBreak(leaf.rows[idx]) === tie) {
          return { pageId: leaf.id, slot: idx };
        }
      }
      cursor = leaf.next;
      idx = 0;
      if (cursor !== null) this.host.access(cursor, 'delete');
    }
    return null;
  }

  private leafNeighborHasKey(leaf: TreeNode, key: Key): boolean {
    for (const sibling of [leaf.prev, leaf.next]) {
      if (sibling === null) continue;
      const n = this.host.nodes.get(sibling);
      if (n && n.keys.includes(key)) return true;
    }
    return false;
  }

  // ——— 遍历 ————————————————————————————————————————————

  /** 找到 key 在树里的第一条匹配项（不产生 SEARCH_RESULT）。 */
  findEntry(key: Key, purpose: AccessPurpose = 'search'): { pageId: PageId; slot: number } | null {
    const leafId = this.descend(key, purpose);
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    return leaf.keys[idx] === key ? { pageId: leaf.id, slot: idx } : null;
  }

  /**
   * 从根页下降到叶子页。
   *
   * 唯一键树用 upperBound：分隔键 == 查找键时该键一定在右子树。
   * 允许重复键的树必须用 lowerBound 落到**最左**的候选页，
   * 因为一串相等的键可能横跨页边界，随后再沿叶子链表向右扫描。
   */
  descend(key: Key, purpose: AccessPurpose): PageId {
    let current = this.rootId;
    this.host.access(current, purpose);
    for (;;) {
      const node = this.node(current);
      if (node.type === 'leaf') return current;
      const childIndex = this.unique ? upperBound(node.keys, key) : lowerBound(node.keys, key);
      const childId = node.children[childIndex];
      assert(childId !== undefined, `internal page #${node.id} missing child at ${childIndex}`);
      this.host.emit({ type: 'DESCEND', pageId: node.id, childId, key, slot: childIndex, level: node.level });
      this.host.access(childId, purpose);
      current = childId;
    }
  }

  /** 从某个叶子页起沿链表遍历，回调返回 'stop' 即终止。 */
  walkLeaves(
    startLeafId: PageId,
    visit: (leaf: TreeNode, slot: number, key: Key, row: Row | null) => 'continue' | 'stop',
  ): void {
    let cursor: PageId | null = startLeafId;
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (let i = 0; i < leaf.keys.length; i++) {
        if (visit(leaf, i, leaf.keys[i], leaf.rows[i] ?? null) === 'stop') return;
      }
      cursor = leaf.next;
      if (cursor !== null) this.host.access(cursor, 'scan');
    }
  }

  /** 按叶子链表顺序返回全部键（测试与调试用）。 */
  allKeys(): Key[] {
    const out: Key[] = [];
    let cur: PageId | null = this.firstLeafId;
    const seen = new Set<PageId>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const n = this.node(cur);
      out.push(...n.keys);
      cur = n.next;
    }
    return out;
  }

  leafPageCount(): number {
    let n = 0;
    for (const node of this.host.nodes.values()) {
      if (node.indexId === this.id && node.type === 'leaf') n++;
    }
    return n;
  }

  emitStats(): void {
    this.host.emit({
      type: 'INDEX_STATS',
      indexId: this.id,
      entries: this.entries,
      distinct: this.distinct,
      minKey: this.minKey,
      maxKey: this.maxKey,
    });
  }

  /** 删除索引时逐页回收，返回回收页数。 */
  dropAllPages(): number {
    const pages = [...this.host.nodes.values()].filter((n) => n.indexId === this.id);
    for (const page of pages) {
      this.host.nodes.delete(page.id);
      this.host.forgetPage(page.id);
      this.host.emit({ type: 'PAGE_FREE', pageId: page.id });
    }
    return pages.length;
  }

  toStructuralIndex(): StructuralIndex {
    return {
      id: this.id,
      name: this.name,
      column: this.column,
      clustered: this.clustered,
      unique: this.unique,
      rootId: this.rootId,
      firstLeafId: this.firstLeafId,
      height: this.height,
      entries: this.entries,
    };
  }

  // ——— 分裂 ————————————————————————————————————————————

  private splitLeaf(leaf: TreeNode, triggerKey: Key): void {
    const cfg = this.host.config;
    const n = leaf.keys.length;
    let splitAt = clamp(Math.round(n * cfg.fillFactor), 1, n - 1);
    if (cfg.sequentialInsertOptimization && leaf.next === null && triggerKey === leaf.keys[n - 1]) {
      // InnoDB 对「最右页 + 递增主键」的优化：几乎不搬数据，新页从空开始。
      splitAt = n - 1;
    }

    const movedKeys = leaf.keys.slice(splitAt);
    const movedRows = leaf.rows.slice(splitAt);
    const right = this.allocPage('leaf', 0, leaf.parentId);
    const promotedKey = movedKeys[0];

    this.host.emit({
      type: 'PAGE_SPLIT',
      pageId: leaf.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'leaf',
      moved: { keys: movedKeys.slice(), rows: movedRows.slice() },
      triggerKey,
      fillFactor: cfg.fillFactor,
    });
    leaf.keys.length = splitAt;
    leaf.rows.length = splitAt;
    right.keys = movedKeys;
    right.rows = movedRows;

    const oldNext = leaf.next;
    right.prev = leaf.id;
    right.next = oldNext;
    leaf.next = right.id;
    this.host.emit({ type: 'LEAF_LINK', pageId: right.id, prev: right.prev, next: right.next });
    this.host.emit({ type: 'LEAF_LINK', pageId: leaf.id, prev: leaf.prev, next: leaf.next });
    if (oldNext !== null) {
      const nextNode = this.node(oldNext);
      nextNode.prev = right.id;
      this.host.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
    }

    this.markDirty(leaf);
    this.markDirty(right);
    this.insertIntoParent(leaf, promotedKey, right);
  }

  private splitInternal(node: TreeNode): void {
    const n = node.keys.length;
    // 内部页始终均分：floor(n/2) 保证两侧都不低于 ceil(order/2)-1 个分隔键。
    // （fillFactor 只作用于叶子页——真实系统的填充因子同样只影响数据页。）
    const splitAt = clamp(Math.floor(n / 2), 1, n - 1);
    const promotedKey = node.keys[splitAt];
    const movedKeys = node.keys.slice(splitAt + 1);
    const movedChildren = node.children.slice(splitAt + 1);

    const right = this.allocPage('internal', node.level, node.parentId);
    this.host.emit({
      type: 'PAGE_SPLIT',
      pageId: node.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'internal',
      moved: { keys: movedKeys.slice(), children: movedChildren.slice() },
      triggerKey: null,
      fillFactor: this.host.config.fillFactor,
    });
    node.keys.length = splitAt;
    node.children.length = splitAt + 1;
    right.keys = movedKeys;
    right.children = movedChildren;
    for (const childId of right.children) this.reparent(childId, right.id);

    this.markDirty(node);
    this.markDirty(right);
    this.insertIntoParent(node, promotedKey, right);
  }

  private insertIntoParent(left: TreeNode, key: Key, right: TreeNode): void {
    if (left.parentId === null) {
      const newRoot = this.allocPage('internal', left.level + 1, null, { children: [left.id] });
      this.host.emit({
        type: 'ROOT_CHANGE',
        indexId: this.id,
        oldRootId: this.rootId,
        newRootId: newRoot.id,
        height: this.height + 1,
      });
      this.rootId = newRoot.id;
      this.height += 1;
      this.reparent(left.id, newRoot.id);
      this.host.emit({ type: 'SEPARATOR_INSERT', pageId: newRoot.id, slot: 0, key, childId: right.id });
      newRoot.keys.push(key);
      newRoot.children.push(right.id);
      this.reparent(right.id, newRoot.id);
      this.markDirty(newRoot);
      return;
    }

    const parent = this.node(left.parentId);
    this.host.access(parent.id, 'maintain');
    // 分隔键必须紧跟在 left 这个子指针后面，而不是按键比较去找位置：
    // 允许重复键的树里 upperBound 会把新子页排到所有相等分隔键之后，
    // 导致父页的子指针顺序与叶子链表顺序不一致（进而把不相邻的页错误合并）。
    const slot = parent.children.indexOf(left.id);
    assert(slot >= 0, `page #${left.id} not found in parent #${parent.id}`);
    this.host.emit({ type: 'SEPARATOR_INSERT', pageId: parent.id, slot, key, childId: right.id });
    parent.keys.splice(slot, 0, key);
    parent.children.splice(slot + 1, 0, right.id);
    this.reparent(right.id, parent.id);
    this.markDirty(parent);

    if (parent.keys.length > this.capacity()) {
      this.splitInternal(parent);
    }
  }

  // ——— 删除后的再平衡 ————————————————————————————————

  private rebalance(node: TreeNode): void {
    if (node.parentId === null) {
      this.shrinkRootIfNeeded(node);
      return;
    }
    const min = node.type === 'leaf' ? this.minLeafKeys() : this.minInternalKeys();
    if (node.keys.length >= min) return;

    const parent = this.node(node.parentId);
    this.host.access(parent.id, 'maintain');
    const idx = parent.children.indexOf(node.id);
    assert(idx >= 0, `page #${node.id} not found in parent #${parent.id}`);

    const leftId = idx > 0 ? parent.children[idx - 1] : null;
    const rightId = idx < parent.children.length - 1 ? parent.children[idx + 1] : null;

    if (leftId !== null) {
      const left = this.node(leftId);
      if (left.keys.length > min) {
        this.host.access(left.id, 'maintain');
        this.borrow(left, node, parent, idx - 1, 'left-to-right');
        return;
      }
    }
    if (rightId !== null) {
      const right = this.node(rightId);
      if (right.keys.length > min) {
        this.host.access(right.id, 'maintain');
        this.borrow(right, node, parent, idx, 'right-to-left');
        return;
      }
    }

    if (leftId !== null) {
      this.host.access(leftId, 'maintain');
      this.merge(this.node(leftId), node, parent, idx - 1);
    } else if (rightId !== null) {
      this.host.access(rightId, 'maintain');
      this.merge(node, this.node(rightId), parent, idx);
    }

    if (parent.parentId === null) this.shrinkRootIfNeeded(parent);
    else if (parent.keys.length < this.minInternalKeys()) this.rebalance(parent);
  }

  /** 从 `from` 借一个条目给 `to`，并更新父页分隔键。 */
  private borrow(
    from: TreeNode,
    to: TreeNode,
    parent: TreeNode,
    parentSlot: number,
    direction: 'left-to-right' | 'right-to-left',
  ): void {
    const oldSeparatorKey = parent.keys[parentSlot];
    let moved: EntryBatch;
    let newSeparatorKey: Key;

    if (to.type === 'leaf') {
      if (direction === 'left-to-right') {
        const key = from.keys[from.keys.length - 1];
        const row = from.rows[from.rows.length - 1] ?? null;
        moved = { keys: [key], rows: [row] };
        newSeparatorKey = key;
      } else {
        const key = from.keys[0];
        const row = from.rows[0] ?? null;
        moved = { keys: [key], rows: [row] };
        newSeparatorKey = from.keys[1];
      }
    } else {
      if (direction === 'left-to-right') {
        moved = { keys: [from.keys[from.keys.length - 1]], children: [from.children[from.children.length - 1]] };
        newSeparatorKey = from.keys[from.keys.length - 1];
      } else {
        moved = { keys: [from.keys[0]], children: [from.children[0]] };
        newSeparatorKey = from.keys[0];
      }
    }

    this.host.emit({
      type: 'REDISTRIBUTE',
      fromPageId: from.id,
      toPageId: to.id,
      pageType: to.type,
      direction,
      moved: structuredClone(moved),
      parentId: parent.id,
      parentSlot,
      newSeparatorKey,
      oldSeparatorKey,
    });

    if (to.type === 'leaf') {
      if (direction === 'left-to-right') {
        const key = from.keys.pop() as Key;
        const row = from.rows.pop() ?? null;
        to.keys.unshift(key);
        to.rows.unshift(row);
      } else {
        const key = from.keys.shift() as Key;
        const row = from.rows.shift() ?? null;
        to.keys.push(key);
        to.rows.push(row);
      }
    } else {
      if (direction === 'left-to-right') {
        const child = from.children.pop() as PageId;
        from.keys.pop();
        to.children.unshift(child);
        to.keys.unshift(oldSeparatorKey);
        this.reparent(child, to.id);
      } else {
        const child = from.children.shift() as PageId;
        from.keys.shift();
        to.children.push(child);
        to.keys.push(oldSeparatorKey);
        this.reparent(child, to.id);
      }
    }
    parent.keys[parentSlot] = newSeparatorKey;
    this.markDirty(from);
    this.markDirty(to);
    this.markDirty(parent);
  }

  /** 把 `victim`（右）并入 `keep`（左），并从父页移除分隔键。 */
  private merge(keep: TreeNode, victim: TreeNode, parent: TreeNode, separatorSlot: number): void {
    const separatorKey = parent.keys[separatorSlot];
    const moved: EntryBatch =
      keep.type === 'leaf'
        ? { keys: victim.keys.slice(), rows: victim.rows.slice() }
        : { keys: victim.keys.slice(), children: victim.children.slice() };

    this.host.emit({
      type: 'PAGE_MERGE',
      pageId: keep.id,
      victimPageId: victim.id,
      pageType: keep.type,
      separatorKey,
      moved: structuredClone(moved),
    });

    if (keep.type === 'leaf') {
      keep.keys.push(...victim.keys);
      keep.rows.push(...victim.rows);
      const oldNext = victim.next;
      keep.next = oldNext;
      this.host.emit({ type: 'LEAF_LINK', pageId: keep.id, prev: keep.prev, next: keep.next });
      if (oldNext !== null) {
        const nextNode = this.node(oldNext);
        nextNode.prev = keep.id;
        this.host.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
      }
    } else {
      keep.keys.push(separatorKey, ...victim.keys);
      keep.children.push(...victim.children);
      for (const childId of victim.children) this.reparent(childId, keep.id);
    }

    this.host.emit({
      type: 'SEPARATOR_DELETE',
      pageId: parent.id,
      slot: separatorSlot,
      key: separatorKey,
      childId: victim.id,
    });
    parent.keys.splice(separatorSlot, 1);
    parent.children.splice(separatorSlot + 1, 1);

    this.freePage(victim);
    this.markDirty(keep);
    this.markDirty(parent);
  }

  private shrinkRootIfNeeded(root: TreeNode): void {
    if (root.type !== 'internal') return;
    if (root.children.length > 1) return;
    const onlyChild = this.node(root.children[0]);
    this.host.emit({
      type: 'ROOT_CHANGE',
      indexId: this.id,
      oldRootId: root.id,
      newRootId: onlyChild.id,
      height: this.height - 1,
    });
    this.rootId = onlyChild.id;
    this.height -= 1;
    onlyChild.parentId = null;
    this.host.emit({ type: 'PARENT_SET', pageId: onlyChild.id, parentId: null });
    this.freePage(root);
  }

  // ——— 页管理 ————————————————————————————————————————

  private allocPage(
    type: PageType,
    level: number,
    parentId: PageId | null,
    init?: { keys?: Key[]; children?: PageId[] },
  ): TreeNode {
    const id = this.host.allocPageId();
    const node: TreeNode = {
      id,
      indexId: this.id,
      type,
      level,
      parentId,
      keys: init?.keys?.slice() ?? [],
      rows: [],
      children: init?.children?.slice() ?? [],
      prev: null,
      next: null,
      dirty: false,
    };
    this.host.nodes.set(id, node);
    this.host.emit({
      type: 'PAGE_ALLOC',
      pageId: id,
      indexId: this.id,
      pageType: type,
      level,
      parentId,
      init: init ? structuredClone(init) : undefined,
    });
    this.host.access(id, 'maintain');
    return node;
  }

  private freePage(node: TreeNode): void {
    this.host.nodes.delete(node.id);
    this.host.forgetPage(node.id);
    if (this.firstLeafId === node.id && node.next !== null) this.firstLeafId = node.next;
    this.host.emit({ type: 'PAGE_FREE', pageId: node.id });
  }

  private reparent(childId: PageId, parentId: PageId | null): void {
    const child = this.node(childId);
    if (child.parentId === parentId) return;
    child.parentId = parentId;
    this.host.emit({ type: 'PARENT_SET', pageId: childId, parentId });
  }

  private markDirty(node: TreeNode): void {
    if (node.dirty) return;
    node.dirty = true;
    this.host.emit({ type: 'PAGE_MARK_DIRTY', pageId: node.id });
  }

  private node(id: PageId): TreeNode {
    const n = this.host.nodes.get(id);
    assert(n !== undefined, `page #${id} does not exist`);
    return n;
  }

  private capacity(): number {
    return Math.max(1, this.host.config.order - 1);
  }

  private minLeafKeys(): number {
    return Math.ceil((this.host.config.order - 1) / 2);
  }

  private minInternalKeys(): number {
    return Math.ceil(this.host.config.order / 2) - 1;
  }
}
