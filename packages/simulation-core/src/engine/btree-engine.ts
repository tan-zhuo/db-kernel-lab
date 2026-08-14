import {
  Rng,
  assert,
  clamp,
  lowerBound,
  upperBound,
  type Key,
  type PageId,
  type PageType,
  type Row,
  type TableSchema,
} from '@dbkl/shared';
import type { EntryBatch, SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralSnapshot } from '../state';
import { DEFAULT_ENGINE_CONFIG, type Command, type EngineCapability, type EngineConfig, type StorageEngine } from './types';
import { BufferPool } from './buffer-pool';

/** 引擎内部的页对象（与 LabState.PageState 形状一致，但由算法直接维护）。 */
interface Node {
  id: PageId;
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

export const DEFAULT_SCHEMA: TableSchema = {
  name: 'users',
  columns: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'varchar', length: 32 },
    { name: 'city', type: 'varchar', length: 16 },
    { name: 'score', type: 'int' },
  ],
  primaryKey: 'id',
};

const CITIES = ['Beijing', 'Shanghai', 'Hangzhou', 'Shenzhen', 'Chengdu', 'Xian'];
const NAMES = ['ada', 'brin', 'codd', 'dean', 'edgar', 'fay', 'gray', 'hoare', 'ingres', 'jim'];

/**
 * Phase 0 / Phase 1 的核心引擎：聚簇 B+ 树 + Buffer Pool。
 *
 * 语义参照 InnoDB 的聚簇索引：叶子页承载完整行、叶子页之间双向链表相连、
 * 内部页只存 (分隔键, 子页号)。分裂点可通过 fillFactor 调整，并可开启
 * 顺序插入右倾优化。
 *
 * 与真实 InnoDB 的差异见 docs/architecture.md「简化点」。
 */
export class BTreeEngine implements StorageEngine {
  readonly name = 'InnoDB-like Clustered B+Tree';
  readonly capabilities: readonly EngineCapability[] = ['btree', 'clustered-index', 'buffer-pool'];

  config: EngineConfig;

  private nodes = new Map<PageId, Node>();
  private nextPageId = 1;
  private rootId: PageId | null = null;
  private firstLeafId: PageId | null = null;
  private height = 0;
  private recordCount = 0;
  private schema: TableSchema | null = null;
  private buffer: BufferPool;
  private rng: Rng;

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.buffer = new BufferPool(this.config, {
      emit: (body) => this.emit(body),
      isDirty: (id) => this.nodes.get(id)?.dirty ?? false,
      onFlushed: (id) => {
        const n = this.nodes.get(id);
        if (n) n.dirty = false;
      },
      exists: (id) => this.nodes.has(id),
    });
  }

  get eventCount(): number {
    return this.seq;
  }

  // ——— 命令入口 ————————————————————————————————————————

  execute(command: Command): SimulationEvent[] {
    this.out = [];
    this.cmdId++;
    const label = commandLabel(command);
    this.emit({ type: 'COMMAND_BEGIN', kind: commandKind(command), label });

    let note: string | undefined;
    let ok = true;
    try {
      note = this.dispatch(command);
    } catch (err) {
      ok = false;
      note = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'NOTE', message: note, level: 'error' });
    }

    this.emit({ type: 'COMMAND_END', kind: commandKind(command), label, ok, note });
    return this.out;
  }

  private dispatch(command: Command): string | undefined {
    switch (command.kind) {
      case 'create_table':
        return this.createTable(command.schema);
      case 'insert': {
        const row = command.row ?? this.makeRow(command.key);
        const res = this.insertRecord(command.key, row);
        return res === 'updated' ? `key=${command.key} 已存在，执行更新` : `插入 key=${command.key}`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'update': {
        const res = this.insertRecord(command.key, command.row);
        return res === 'updated' ? `更新 key=${command.key}` : `key=${command.key} 不存在，已按插入处理`;
      }
      case 'delete':
        return this.deleteRecord(command.key);
      case 'search': {
        const found = this.pointSearch(command.key);
        return found ? `命中 key=${command.key}` : `未找到 key=${command.key}`;
      }
      case 'range_scan':
        return this.rangeScan(command.from, command.to);
      case 'full_scan':
        return this.rangeScan(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 'full');
      case 'flush_all': {
        const n = this.buffer.flushAll('manual');
        return `刷盘 ${n} 个脏页`;
      }
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.buffer.reconfigure(this.config);
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（阶数变化不会重排已有页，请重置以重建）';
      }
      default: {
        const never: never = command;
        throw new Error(`unknown command ${JSON.stringify(never)}`);
      }
    }
  }

  // ——— DDL ——————————————————————————————————————————————

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    const root = this.allocPage('leaf', 0, null);
    this.emit({ type: 'ROOT_CHANGE', oldRootId: null, newRootId: root.id, height: 1 });
    this.rootId = root.id;
    this.firstLeafId = root.id;
    this.height = 1;
    this.emit({ type: 'LEAF_LINK', pageId: root.id, prev: null, next: null });
    return `表 ${schema.name} 已创建，根页 #${root.id}`;
  }

  // ——— DML ——————————————————————————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.recordCount + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    let inserted = 0;
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      const res = this.insertRecord(key, this.makeRow(key));
      if (res === 'inserted') inserted++;
    }
    return `批量插入 ${count} 次，新增 ${inserted} 行（${pattern}）`;
  }

  private insertRecord(key: Key, row: Row): 'inserted' | 'updated' {
    this.ensureTable();
    const leafId = this.descend(key, 'insert');
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);

    if (leaf.keys[idx] === key) {
      const oldRow = leaf.rows[idx] ?? null;
      this.emit({ type: 'RECORD_UPDATE', pageId: leaf.id, slot: idx, key, row, oldRow });
      leaf.rows[idx] = row;
      this.markDirty(leaf);
      return 'updated';
    }

    this.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key, row });
    leaf.keys.splice(idx, 0, key);
    leaf.rows.splice(idx, 0, row);
    this.recordCount++;
    this.markDirty(leaf);

    if (leaf.keys.length > this.capacity()) this.splitLeaf(leaf, key);
    return 'inserted';
  }

  private deleteRecord(key: Key): string {
    this.ensureTable();
    const leafId = this.descend(key, 'delete');
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    if (leaf.keys[idx] !== key) {
      this.emit({ type: 'SEARCH_RESULT', key, found: false, pageId: leaf.id, slot: -1 });
      return `key=${key} 不存在`;
    }
    this.emit({ type: 'RECORD_DELETE', pageId: leaf.id, slot: idx, key, row: leaf.rows[idx] ?? null });
    leaf.keys.splice(idx, 1);
    leaf.rows.splice(idx, 1);
    this.recordCount--;
    this.markDirty(leaf);

    // 如果删掉的是页内首键，父页的分隔键仍然合法（分隔键是下界，不必等于实际存在的键），
    // 与 InnoDB 一致：不为此重写父页。
    this.rebalance(leaf);
    return `删除 key=${key}`;
  }

  // ——— 查询 ————————————————————————————————————————————

  private pointSearch(key: Key): boolean {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const leafId = this.descend(key, 'search');
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    const found = leaf.keys[idx] === key;
    this.emit({ type: 'SEARCH_RESULT', key, found, pageId: leaf.id, slot: found ? idx : -1 });
    return found;
  }

  private rangeScan(from: Key, to: Key, mode: 'range' | 'full' = 'range'): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key: Number.isFinite(from) ? from : 0, mode });
    let leafId: PageId;
    if (mode === 'full') {
      leafId = this.firstLeafId ?? this.leftmostLeaf();
      this.access(leafId, 'scan');
    } else {
      leafId = this.descend(from, 'scan');
    }

    let rows = 0;
    const touched = new Set<PageId>();
    let cursor: PageId | null = leafId;
    let stop = false;
    while (cursor !== null && !stop) {
      const leaf = this.node(cursor);
      touched.add(leaf.id);
      for (let i = 0; i < leaf.keys.length; i++) {
        const k = leaf.keys[i];
        if (k > to) {
          stop = true;
          break;
        }
        const emitted = k >= from;
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot: i, key: k, row: leaf.rows[i] ?? null, emitted });
        if (emitted) rows++;
      }
      if (stop) break;
      cursor = leaf.next;
      if (cursor !== null) this.access(cursor, 'scan');
    }
    this.emit({ type: 'SCAN_END', rows, pagesTouched: touched.size });
    return `扫描返回 ${rows} 行，触达 ${touched.size} 个叶子页`;
  }

  // ——— 树遍历 ————————————————————————————————————————

  private descend(key: Key, purpose: 'search' | 'insert' | 'delete' | 'scan'): PageId {
    assert(this.rootId !== null, 'tree has no root; create table first');
    let current = this.rootId;
    this.access(current, purpose);
    for (;;) {
      const node = this.node(current);
      if (node.type === 'leaf') return current;
      const childIndex = upperBound(node.keys, key);
      const childId = node.children[childIndex];
      assert(childId !== undefined, `internal page #${node.id} missing child at ${childIndex}`);
      this.emit({ type: 'DESCEND', pageId: node.id, childId, key, slot: childIndex, level: node.level });
      this.access(childId, purpose);
      current = childId;
    }
  }

  private leftmostLeaf(): PageId {
    assert(this.rootId !== null, 'tree has no root');
    let cur = this.node(this.rootId);
    while (cur.type === 'internal') cur = this.node(cur.children[0]);
    return cur.id;
  }

  // ——— 分裂 ————————————————————————————————————————————

  private splitLeaf(leaf: Node, triggerKey: Key): void {
    const n = leaf.keys.length;
    let splitAt = clamp(Math.round(n * this.config.fillFactor), 1, n - 1);
    if (this.config.sequentialInsertOptimization && leaf.next === null && triggerKey === leaf.keys[n - 1]) {
      // InnoDB 对「最右页 + 递增主键」的优化：几乎不搬数据，新页从空开始。
      splitAt = n - 1;
    }

    const movedKeys = leaf.keys.slice(splitAt);
    const movedRows = leaf.rows.slice(splitAt);
    const right = this.allocPage('leaf', 0, leaf.parentId);
    const promotedKey = movedKeys[0];

    this.emit({
      type: 'PAGE_SPLIT',
      pageId: leaf.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'leaf',
      moved: { keys: movedKeys.slice(), rows: movedRows.slice() },
      triggerKey,
      fillFactor: this.config.fillFactor,
    });
    leaf.keys.length = splitAt;
    leaf.rows.length = splitAt;
    right.keys = movedKeys;
    right.rows = movedRows;

    const oldNext = leaf.next;
    right.prev = leaf.id;
    right.next = oldNext;
    leaf.next = right.id;
    this.emit({ type: 'LEAF_LINK', pageId: right.id, prev: right.prev, next: right.next });
    this.emit({ type: 'LEAF_LINK', pageId: leaf.id, prev: leaf.prev, next: leaf.next });
    if (oldNext !== null) {
      const nextNode = this.node(oldNext);
      nextNode.prev = right.id;
      this.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
    }

    this.markDirty(leaf);
    this.markDirty(right);
    this.insertIntoParent(leaf, promotedKey, right);
  }

  private splitInternal(node: Node): void {
    const n = node.keys.length;
    // 内部页始终均分：floor(n/2) 保证两侧都不低于 ceil(order/2)-1 个分隔键。
    // （fillFactor 只作用于叶子页——真实系统的填充因子同样只影响数据页。）
    const splitAt = clamp(Math.floor(n / 2), 1, n - 1);
    const promotedKey = node.keys[splitAt];
    const movedKeys = node.keys.slice(splitAt + 1);
    const movedChildren = node.children.slice(splitAt + 1);

    const right = this.allocPage('internal', node.level, node.parentId);
    this.emit({
      type: 'PAGE_SPLIT',
      pageId: node.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'internal',
      moved: { keys: movedKeys.slice(), children: movedChildren.slice() },
      triggerKey: null,
      fillFactor: this.config.fillFactor,
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

  private insertIntoParent(left: Node, key: Key, right: Node): void {
    if (left.parentId === null) {
      const newRoot = this.allocPage('internal', left.level + 1, null, { children: [left.id] });
      this.emit({ type: 'ROOT_CHANGE', oldRootId: this.rootId, newRootId: newRoot.id, height: this.height + 1 });
      this.rootId = newRoot.id;
      this.height += 1;
      this.reparent(left.id, newRoot.id);
      this.emit({ type: 'SEPARATOR_INSERT', pageId: newRoot.id, slot: 0, key, childId: right.id });
      newRoot.keys.push(key);
      newRoot.children.push(right.id);
      this.reparent(right.id, newRoot.id);
      this.markDirty(newRoot);
      return;
    }

    const parent = this.node(left.parentId);
    this.access(parent.id, 'maintain');
    const slot = upperBound(parent.keys, key);
    this.emit({ type: 'SEPARATOR_INSERT', pageId: parent.id, slot, key, childId: right.id });
    parent.keys.splice(slot, 0, key);
    parent.children.splice(slot + 1, 0, right.id);
    this.reparent(right.id, parent.id);
    this.markDirty(parent);

    if (parent.keys.length > this.capacity()) {
      this.splitInternal(parent);
    }
  }

  // ——— 删除后的再平衡 ————————————————————————————————

  private rebalance(node: Node): void {
    if (node.parentId === null) {
      this.shrinkRootIfNeeded(node);
      return;
    }
    const min = node.type === 'leaf' ? this.minLeafKeys() : this.minInternalKeys();
    if (node.keys.length >= min) return;

    const parent = this.node(node.parentId);
    this.access(parent.id, 'maintain');
    const idx = parent.children.indexOf(node.id);
    assert(idx >= 0, `page #${node.id} not found in parent #${parent.id}`);

    const leftId = idx > 0 ? parent.children[idx - 1] : null;
    const rightId = idx < parent.children.length - 1 ? parent.children[idx + 1] : null;

    if (leftId !== null) {
      const left = this.node(leftId);
      if (left.keys.length > min) {
        this.access(left.id, 'maintain');
        this.borrow(left, node, parent, idx - 1, 'left-to-right');
        return;
      }
    }
    if (rightId !== null) {
      const right = this.node(rightId);
      if (right.keys.length > min) {
        this.access(right.id, 'maintain');
        this.borrow(right, node, parent, idx, 'right-to-left');
        return;
      }
    }

    if (leftId !== null) {
      this.access(leftId, 'maintain');
      this.merge(this.node(leftId), node, parent, idx - 1);
    } else if (rightId !== null) {
      this.access(rightId, 'maintain');
      this.merge(node, this.node(rightId), parent, idx);
    }

    if (parent.parentId === null) this.shrinkRootIfNeeded(parent);
    else if (parent.keys.length < this.minInternalKeys()) this.rebalance(parent);
  }

  /** 从 `from` 借一个条目给 `to`，并更新父页分隔键。 */
  private borrow(from: Node, to: Node, parent: Node, parentSlot: number, direction: 'left-to-right' | 'right-to-left'): void {
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

    this.emit({
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
  private merge(keep: Node, victim: Node, parent: Node, separatorSlot: number): void {
    const separatorKey = parent.keys[separatorSlot];
    const moved: EntryBatch =
      keep.type === 'leaf'
        ? { keys: victim.keys.slice(), rows: victim.rows.slice() }
        : { keys: victim.keys.slice(), children: victim.children.slice() };

    this.emit({
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
      this.emit({ type: 'LEAF_LINK', pageId: keep.id, prev: keep.prev, next: keep.next });
      if (oldNext !== null) {
        const nextNode = this.node(oldNext);
        nextNode.prev = keep.id;
        this.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
      }
    } else {
      keep.keys.push(separatorKey, ...victim.keys);
      keep.children.push(...victim.children);
      for (const childId of victim.children) this.reparent(childId, keep.id);
    }

    this.emit({ type: 'SEPARATOR_DELETE', pageId: parent.id, slot: separatorSlot, key: separatorKey, childId: victim.id });
    parent.keys.splice(separatorSlot, 1);
    parent.children.splice(separatorSlot + 1, 1);

    this.freePage(victim);
    this.markDirty(keep);
    this.markDirty(parent);
  }

  private shrinkRootIfNeeded(root: Node): void {
    if (root.type !== 'internal') return;
    if (root.children.length > 1) return;
    const onlyChild = this.node(root.children[0]);
    this.emit({ type: 'ROOT_CHANGE', oldRootId: root.id, newRootId: onlyChild.id, height: this.height - 1 });
    this.rootId = onlyChild.id;
    this.height -= 1;
    onlyChild.parentId = null;
    this.emit({ type: 'PARENT_SET', pageId: onlyChild.id, parentId: null });
    this.freePage(root);
  }

  // ——— 页管理 ————————————————————————————————————————

  private allocPage(type: PageType, level: number, parentId: PageId | null, init?: { keys?: Key[]; children?: PageId[] }): Node {
    const id = this.nextPageId++;
    const node: Node = {
      id,
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
    this.nodes.set(id, node);
    this.emit({ type: 'PAGE_ALLOC', pageId: id, pageType: type, level, parentId, init: init ? structuredClone(init) : undefined });
    this.access(id, 'maintain');
    return node;
  }

  private freePage(node: Node): void {
    this.nodes.delete(node.id);
    this.buffer.forget(node.id);
    if (this.firstLeafId === node.id) this.firstLeafId = node.next;
    this.emit({ type: 'PAGE_FREE', pageId: node.id });
  }

  private reparent(childId: PageId, parentId: PageId | null): void {
    const child = this.node(childId);
    if (child.parentId === parentId) return;
    child.parentId = parentId;
    this.emit({ type: 'PARENT_SET', pageId: childId, parentId });
  }

  private markDirty(node: Node): void {
    if (node.dirty) return;
    node.dirty = true;
    this.emit({ type: 'PAGE_MARK_DIRTY', pageId: node.id });
  }

  private access(pageId: PageId, purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain'): void {
    this.buffer.access(pageId);
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  private node(id: PageId): Node {
    const n = this.nodes.get(id);
    assert(n !== undefined, `page #${id} does not exist`);
    return n;
  }

  private capacity(): number {
    return Math.max(1, this.config.order - 1);
  }

  private minLeafKeys(): number {
    return Math.ceil((this.config.order - 1) / 2);
  }

  private minInternalKeys(): number {
    return Math.ceil(this.config.order / 2) - 1;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  private makeRow(key: Key): Row {
    const schema = this.schema ?? DEFAULT_SCHEMA;
    const row: Row = {};
    for (const col of schema.columns) {
      if (col.name === schema.primaryKey) {
        row[col.name] = key;
        continue;
      }
      switch (col.type) {
        case 'varchar':
          row[col.name] =
            col.name === 'city' ? CITIES[key % CITIES.length] : `${NAMES[key % NAMES.length]}-${key}`;
          break;
        case 'bool':
          row[col.name] = key % 2 === 0;
          break;
        case 'timestamp':
          row[col.name] = 1700000000 + key * 3600;
          break;
        default:
          row[col.name] = (key * 7919) % 1000;
      }
    }
    return row;
  }

  private emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
  }

  // ——— 测试/调试用的结构投影 ————————————————————————

  snapshot(): StructuralSnapshot {
    const pages: StructuralSnapshot['pages'] = {};
    for (const [id, n] of this.nodes) {
      pages[id] = {
        id,
        type: n.type,
        level: n.level,
        parentId: n.parentId,
        keys: n.keys.slice(),
        rows: structuredClone(n.rows),
        children: n.children.slice(),
        prev: n.prev,
        next: n.next,
        dirty: n.dirty,
        resident: this.buffer.residentPages().includes(id),
      };
    }
    return {
      rootId: this.rootId,
      firstLeafId: this.firstLeafId,
      height: this.height,
      recordCount: this.recordCount,
      pages,
      bufferFrames: this.buffer.snapshotFrames(),
      bufferRecency: this.buffer.snapshotRecency(),
    };
  }

  /** 仅供测试：按叶子链表顺序返回全部键。 */
  scanKeys(): Key[] {
    const out: Key[] = [];
    let cur = this.firstLeafId;
    const seen = new Set<PageId>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const n = this.node(cur);
      out.push(...n.keys);
      cur = n.next;
    }
    return out;
  }
}

function commandKind(c: Command): import('@dbkl/shared').CommandKind {
  switch (c.kind) {
    case 'bulk_insert':
      return 'bulk_insert';
    case 'flush_all':
      return 'flush';
    case 'full_scan':
      return 'full_scan';
    case 'range_scan':
      return 'range_scan';
    default:
      return c.kind;
  }
}

function commandLabel(c: Command): string {
  switch (c.kind) {
    case 'create_table':
      return `CREATE TABLE ${c.schema.name}`;
    case 'insert':
      return `INSERT key=${c.key}`;
    case 'bulk_insert':
      return `BULK INSERT ×${c.count} (${c.pattern})`;
    case 'update':
      return `UPDATE key=${c.key}`;
    case 'delete':
      return `DELETE key=${c.key}`;
    case 'search':
      return `SELECT … WHERE pk=${c.key}`;
    case 'range_scan':
      return `SELECT … WHERE pk BETWEEN ${c.from} AND ${c.to}`;
    case 'full_scan':
      return 'SELECT … (full index scan)';
    case 'flush_all':
      return 'FLUSH DIRTY PAGES';
    case 'configure':
      return `SET ${Object.keys(c.patch).join(', ')}`;
    default:
      return 'UNKNOWN';
  }
}
