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
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralFractal, StructuralSnapshot } from '../state';
import {
  DEFAULT_ENGINE_CONFIG,
  PRIMARY_INDEX_ID,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { commandKind, commandLabel, makeRow } from './common';
import { DEFAULT_SCHEMA } from './btree-engine';

/** 缓冲里的一条消息。它描述「要对这个键做什么」，而不是数据本身。 */
export type MessageOp = 'insert' | 'delete' | 'upsert';

interface Message {
  /** 注入序号：同一个键的多条消息靠它定序，越大越新。 */
  seq: number;
  key: Key;
  op: MessageOp;
  /** insert 带整行；upsert 只带要改的那几列；delete 不带。 */
  payload: Row | null;
}

interface FractalNode {
  id: PageId;
  type: PageType;
  level: number;
  parentId: PageId | null;
  keys: Key[];
  rows: (Row | null)[];
  children: PageId[];
  prev: PageId | null;
  next: PageId | null;
  /** 只有内部节点有消息缓冲。 */
  buffer: Message[];
}

/**
 * Bε-树（分形树，TokuDB / PerconaFT 风格）。
 *
 * 它填的是 **B 树 ↔ LSM 之间那段空白**。三者其实是同一根轴上的三个点：
 *
 * ```
 *   读优化 ◀────────────────────────────────────▶ 写优化
 *    B+ 树            Bε-树              LSM-Tree
 *   写立刻到叶子    写先攒在节点缓冲     写只追加进内存表
 *   读一次下降      读要沿路合并缓冲     读要逐层探测
 * ```
 *
 * 核心结构：**内部节点除了分隔键与子指针，还带一块消息缓冲**。
 * 写入不下降到叶子，只往**根节点的缓冲里塞一条消息**就返回；缓冲满了，
 * 把「发往同一个孩子」的那一批整体推下去。于是：
 *
 *  - 一条消息从根走到叶要经过 h 层，但**每层都是跟着一大批一起走的**，
 *    摊到单条上的重写次数因此被批大小除掉了 —— 这就是它写得比 B 树快几十倍的全部原因；
 *  - 代价是**读要沿路把每层缓冲都翻一遍**（读放大），
 *    以及**范围扫描前得先把消息推到叶子**（否则叶子不是最新的）；
 *  - 附送一个 B 树给不了的能力：**盲写**。`UPDATE ... SET score=score+1` 可以
 *    只投一条 upsert 消息，**完全不用先把那一行读出来**。
 *
 * 缓冲容量就是那个旋钮：调到 0 它退化成普通 B+ 树，调到很大就越来越像 LSM。
 */
export class FractalTreeEngine implements StorageEngine {
  readonly name = 'Bε-Tree / Fractal Tree (TokuDB-like)';
  readonly capabilities: readonly EngineCapability[] = [
    'btree',
    'clustered-index',
    'message-buffer',
    'write-optimized',
  ];

  config: EngineConfig;

  private nodes = new Map<PageId, FractalNode>();
  private rootId: PageId = 0;
  private height = 1;
  private nextPageId = 1;
  private msgSeq = 0;

  private injected = 0;
  private flushedHops = 0;
  private applied = 0;
  private pathFlushes = 0;

  private schema: TableSchema | null = null;
  private rng: Rng;

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
  }

  get eventCount(): number {
    return this.seq;
  }

  emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
  }

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
        this.ensureTable();
        const row = command.row ?? makeRow(this.schema!, command.key);
        const depth = this.inject(command.key, 'insert', row);
        return `写入 key=${command.key} —— 只往根缓冲塞了一条消息${
          depth > 0 ? `，顺带把 ${depth} 条消息往下推了一层` : '，没有下降到叶子'
        }`;
      }
      case 'update': {
        this.ensureTable();
        // 盲写：不读旧值，只投一条「改这几列」的消息。B 树做不到这件事。
        const patch = command.row;
        this.inject(command.key, 'upsert', patch);
        return `盲写 key=${command.key} —— 只投一条 upsert 消息，**完全没有读过那一行**`;
      }
      case 'delete': {
        this.ensureTable();
        this.inject(command.key, 'delete', null);
        return `删除 key=${command.key} —— 同样只是一条消息，叶子还不知道这回事`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'search':
        return this.search(command.key);
      case 'range_scan':
        return this.rangeScan(command.from, command.to);
      case 'full_scan':
        return this.rangeScan(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      case 'flush_all':
      case 'compact':
        return this.flushAll('用户手动触发');
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return `配置已更新（缓冲容量 ${this.bufferCapacity()} 条 —— 调到 0 它就退化成普通 B+ 树）`;
      }
      case 'query':
        throw new Error(
          'Bε-树的优化器不在这个仿真的范围内：它只有主键一条访问路径。' +
            '用「点查」看沿路缓冲合并，用「范围扫描」看查询前的强制刷写',
        );
      case 'create_index':
      case 'drop_index':
        throw new Error(
          'Bε-树的二级索引要靠「索引也是一棵 Bε-树 + 往它的根缓冲投消息」实现，本仿真未建模',
        );
      default:
        throw new Error(`Bε-树引擎不支持命令 ${command.kind}`);
    }
  }

  // ——— 建表 ————————————————————————————————————————————

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    this.emit({
      type: 'INDEX_CREATE',
      indexId: PRIMARY_INDEX_ID,
      name: PRIMARY_INDEX_ID,
      column: schema.primaryKey,
      clustered: true,
      unique: true,
    });
    const root = this.allocPage('leaf', 0, null);
    this.rootId = root.id;
    this.emit({ type: 'ROOT_CHANGE', indexId: PRIMARY_INDEX_ID, oldRootId: null, newRootId: root.id, height: 1 });
    this.emit({ type: 'LEAF_LINK', pageId: root.id, prev: null, next: null });
    // 建表就把缓冲水位报一次：面板与 3D 从第一帧起就有东西可画。
    this.emit({ type: 'BUFFER_STATE', nodeId: root.id, size: 0, capacity: this.bufferCapacity() });
    return `表 ${schema.name} 已创建（Bε-树 · 内部节点缓冲 ${this.bufferCapacity()} 条消息）`;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  private capacity(): number {
    return Math.max(1, this.config.order - 1);
  }

  /** 内部节点的消息缓冲容量。0 = 退化成普通 B+ 树（写立刻到叶子）。 */
  private bufferCapacity(): number {
    return Math.max(0, this.config.fractalBufferCapacity);
  }

  private allocPage(
    type: PageType,
    level: number,
    parentId: PageId | null,
    init?: { keys?: Key[]; children?: PageId[] },
  ): FractalNode {
    const id = this.nextPageId++;
    const node: FractalNode = {
      id,
      type,
      level,
      parentId,
      keys: init?.keys?.slice() ?? [],
      rows: [],
      children: init?.children?.slice() ?? [],
      prev: null,
      next: null,
      buffer: [],
    };
    this.nodes.set(id, node);
    this.emit({
      type: 'PAGE_ALLOC',
      pageId: id,
      indexId: PRIMARY_INDEX_ID,
      pageType: type,
      level,
      parentId,
      init: init ? { keys: node.keys.slice(), children: node.children.slice() } : undefined,
    });
    return node;
  }

  private node(id: PageId): FractalNode {
    const n = this.nodes.get(id);
    assert(n !== undefined, `fractal: missing node #${id}`);
    return n;
  }

  private read(pageId: PageId, purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain'): void {
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  // ——— 写路径：往根缓冲投一条消息就返回 ————————————

  /**
   * 注入一条消息。
   *
   * **这就是 Bε-树的整个写路径**：不下降、不定位、不读旧值，
   * 只往根节点的缓冲里追加一条。返回本次顺带推下去的消息数（0 表示没触发刷写）。
   */
  private inject(key: Key, op: MessageOp, payload: Row | null): number {
    const root = this.node(this.rootId);
    const msg: Message = { seq: this.msgSeq++, key, op, payload: payload ? structuredClone(payload) : null };
    this.injected++;

    // 根是叶子（树还很小）或者缓冲容量为 0 时，消息当场落地 —— 此时它就是一棵普通 B+ 树。
    if (root.type === 'leaf' || this.bufferCapacity() === 0) {
      this.read(this.rootId, 'insert');
      const landed = this.routeDirect(msg);
      return landed;
    }

    root.buffer.push(msg);
    this.emit({
      type: 'MSG_INJECT',
      nodeId: root.id,
      msgId: msg.seq,
      key,
      op,
      bufferSize: root.buffer.length,
      capacity: this.bufferCapacity(),
    });
    const before = this.flushedHops;
    this.drain(root);
    return this.flushedHops - before;
  }

  /** 缓冲容量为 0 / 根就是叶子时的退化路径：消息直接下降到叶子应用。 */
  private routeDirect(msg: Message): number {
    let current = this.node(this.rootId);
    while (current.type !== 'leaf') {
      const slot = upperBound(current.keys, msg.key);
      const childId = current.children[slot];
      this.emit({ type: 'DESCEND', pageId: current.id, childId, key: msg.key, slot, level: current.level });
      this.read(childId, 'insert');
      current = this.node(childId);
    }
    this.applyToLeaf(current, [msg]);
    return 0;
  }

  /**
   * 把一个节点的缓冲刷到它的孩子上，直到不再超容量。
   *
   * 挑的是**消息最多的那个孩子**，然后把发往它的消息**整批**推下去 ——
   * 「攒够一批再一起走」正是写放大被摊薄的地方：
   * 一条消息独自走完 h 层要付 h 次重写，一百条一起走，每条只付 h/100。
   */
  private drain(node: FractalNode): void {
    const cap = this.bufferCapacity();
    let guard = 0;
    while (node.buffer.length > cap) {
      assert(guard++ < 10_000, 'fractal: drain 没有收敛');
      const groups = new Map<number, Message[]>();
      for (const msg of node.buffer) {
        const slot = upperBound(node.keys, msg.key);
        const list = groups.get(slot) ?? [];
        list.push(msg);
        groups.set(slot, list);
      }
      // 消息最多的孩子优先 —— 一次刷得越多，摊薄得越狠。slot 小的优先以保证确定性。
      let bestSlot = -1;
      let bestCount = -1;
      for (const [slot, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        if (list.length > bestCount) {
          bestCount = list.length;
          bestSlot = slot;
        }
      }
      if (bestSlot < 0) break;

      const batch = groups.get(bestSlot)!;
      const batchKeys = new Set(batch.map((m) => m.seq));
      node.buffer = node.buffer.filter((m) => !batchKeys.has(m.seq));
      const childId = node.children[bestSlot];
      assert(childId !== undefined, `fractal: node #${node.id} 缺子指针 ${bestSlot}`);
      const child = this.node(childId);

      this.flushedHops += batch.length;
      this.emit({
        type: 'MSG_FLUSH',
        fromNodeId: node.id,
        toNodeId: childId,
        childSlot: bestSlot,
        msgIds: batch.map((m) => m.seq),
        keys: batch.map((m) => m.key),
        ops: batch.map((m) => m.op),
        toLeaf: child.type === 'leaf',
        remaining: node.buffer.length,
        reason: `缓冲 ${node.buffer.length + batch.length}/${cap} 溢出，第 ${bestSlot} 个孩子攒了最多（${batch.length} 条）`,
      });

      this.read(childId, 'maintain');
      if (child.type === 'leaf') {
        this.applyToLeaf(child, batch);
      } else {
        child.buffer.push(...batch);
        this.emit({
          type: 'BUFFER_STATE',
          nodeId: child.id,
          size: child.buffer.length,
          capacity: cap,
        });
        this.drain(child);
      }
      // 叶子分裂可能把当前节点也撑裂，pivot 变了要重新分组，所以回到 while 顶部。
    }
  }

  /**
   * 一批消息落到叶子上，按注入顺序真正生效 —— 到这里它们才变成数据。
   *
   * 注意批中途可能把叶子撑裂：分裂之后这一批剩下的消息有一部分已经不属于原来那个叶子了，
   * 所以每条消息都要**重新定位**一次目标叶子（只可能往右走：整批本来就属于同一棵子树）。
   */
  private applyToLeaf(startLeaf: FractalNode, batch: Message[]): void {
    for (const msg of [...batch].sort((a, b) => a.seq - b.seq)) {
      const leaf = this.resolveLeaf(startLeaf, msg.key);
      const idx = lowerBound(leaf.keys, msg.key);
      const exists = leaf.keys[idx] === msg.key;
      this.applied++;

      if (msg.op === 'delete') {
        if (!exists) continue;
        this.emit({ type: 'RECORD_DELETE', pageId: leaf.id, slot: idx, key: msg.key, row: leaf.rows[idx] ?? null });
        leaf.keys.splice(idx, 1);
        leaf.rows.splice(idx, 1);
        continue;
      }

      if (msg.op === 'upsert') {
        if (!exists) {
          // 盲写落到一个不存在的键上：当成插入（真实实现里由 upsert 函数决定）。
          const row = msg.payload ?? makeRow(this.schema!, msg.key);
          this.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key: msg.key, row });
          leaf.keys.splice(idx, 0, msg.key);
          leaf.rows.splice(idx, 0, structuredClone(row));
        } else {
          const merged = { ...(leaf.rows[idx] ?? {}), ...(msg.payload ?? {}) };
          this.emit({
            type: 'RECORD_UPDATE',
            pageId: leaf.id,
            slot: idx,
            key: msg.key,
            row: merged,
            oldRow: leaf.rows[idx] ?? null,
          });
          leaf.rows[idx] = merged;
        }
      } else if (exists) {
        const row = msg.payload ?? makeRow(this.schema!, msg.key);
        this.emit({
          type: 'RECORD_UPDATE',
          pageId: leaf.id,
          slot: idx,
          key: msg.key,
          row,
          oldRow: leaf.rows[idx] ?? null,
        });
        leaf.rows[idx] = structuredClone(row);
      } else {
        const row = msg.payload ?? makeRow(this.schema!, msg.key);
        this.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key: msg.key, row });
        leaf.keys.splice(idx, 0, msg.key);
        leaf.rows.splice(idx, 0, structuredClone(row));
      }

      if (leaf.keys.length > this.capacity()) this.splitLeaf(leaf, msg.key);
    }
  }

  /** 从某个叶子出发向右找到 key 真正该落的那个叶子。 */
  private resolveLeaf(start: FractalNode, key: Key): FractalNode {
    let leaf = start;
    for (;;) {
      if (leaf.next === null) return leaf;
      const next = this.node(leaf.next);
      if (next.keys.length === 0 || key < next.keys[0]) return leaf;
      leaf = next;
    }
  }

  // ——— 分裂 ————————————————————————————————————————————

  private splitLeaf(leaf: FractalNode, triggerKey: Key): void {
    const n = leaf.keys.length;
    const splitAt = clamp(Math.round(n * this.config.fillFactor), 1, n - 1);
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
      moved: { keys: movedKeys.slice(), rows: structuredClone(movedRows) },
      triggerKey,
      fillFactor: this.config.fillFactor,
    });
    leaf.keys.length = splitAt;
    leaf.rows.length = splitAt;
    right.keys = movedKeys;
    right.rows = movedRows;

    // Bε-树保留叶子链表：它的叶子只被「批量刷写」改动，不会因为一次点写就连带邻居。
    right.next = leaf.next;
    right.prev = leaf.id;
    if (leaf.next !== null) {
      const after = this.node(leaf.next);
      after.prev = right.id;
      this.emit({ type: 'LEAF_LINK', pageId: after.id, prev: after.prev, next: after.next });
    }
    leaf.next = right.id;
    this.emit({ type: 'LEAF_LINK', pageId: leaf.id, prev: leaf.prev, next: leaf.next });
    this.emit({ type: 'LEAF_LINK', pageId: right.id, prev: right.prev, next: right.next });

    this.insertIntoParent(leaf, promotedKey, right);
  }

  private insertIntoParent(left: FractalNode, key: Key, right: FractalNode): void {
    if (left.parentId === null) {
      // 新根带着左子一起分配；右子与分隔键由紧随其后的 SEPARATOR_INSERT 补上 ——
      // 那个事件的语义就是「在 slot 处插分隔键，在 slot+1 处插右子」。
      const root = this.allocPage('internal', left.level + 1, null, { children: [left.id] });
      root.keys = [key];
      root.children = [left.id, right.id];
      left.parentId = root.id;
      right.parentId = root.id;
      this.emit({ type: 'PARENT_SET', pageId: left.id, parentId: root.id });
      this.emit({ type: 'PARENT_SET', pageId: right.id, parentId: root.id });
      this.emit({ type: 'SEPARATOR_INSERT', pageId: root.id, slot: 0, key, childId: right.id });
      this.rootId = root.id;
      this.height++;
      this.emit({
        type: 'ROOT_CHANGE',
        indexId: PRIMARY_INDEX_ID,
        oldRootId: left.id,
        newRootId: root.id,
        height: this.height,
      });
      return;
    }

    const parent = this.node(left.parentId);
    const at = parent.children.indexOf(left.id);
    const slot = at >= 0 ? at : upperBound(parent.keys, key);
    parent.keys.splice(slot, 0, key);
    parent.children.splice(slot + 1, 0, right.id);
    right.parentId = parent.id;
    this.emit({ type: 'PARENT_SET', pageId: right.id, parentId: parent.id });
    this.emit({ type: 'SEPARATOR_INSERT', pageId: parent.id, slot, key, childId: right.id });

    if (parent.keys.length > this.capacity()) this.splitInternal(parent);
  }

  /**
   * 内部节点分裂 —— 比 B 树多一步：**缓冲也要按分隔键劈成两半**。
   * 消息属于哪个孩子，就跟着那个孩子走。
   */
  private splitInternal(node: FractalNode): void {
    const n = node.keys.length;
    const mid = Math.floor(n / 2);
    const promotedKey = node.keys[mid];
    const movedKeys = node.keys.slice(mid + 1);
    const movedChildren = node.children.slice(mid + 1);
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

    node.keys.length = mid;
    node.children.length = mid + 1;
    right.keys = movedKeys;
    right.children = movedChildren;
    for (const childId of right.children) {
      const child = this.nodes.get(childId);
      if (child) {
        child.parentId = right.id;
        this.emit({ type: 'PARENT_SET', pageId: childId, parentId: right.id });
      }
    }

    // 缓冲跟着孩子走：>= promotedKey 的消息归右边。
    const stay = node.buffer.filter((m) => m.key < promotedKey);
    const move = node.buffer.filter((m) => m.key >= promotedKey);
    node.buffer = stay;
    right.buffer = move;
    if (move.length > 0) {
      this.emit({
        type: 'BUFFER_SPLIT',
        pageId: node.id,
        newPageId: right.id,
        movedIds: move.map((m) => m.seq),
        movedKeys: move.map((m) => m.key),
        stayed: stay.length,
      });
    }
    this.emit({ type: 'BUFFER_STATE', nodeId: node.id, size: node.buffer.length, capacity: this.bufferCapacity() });
    this.emit({ type: 'BUFFER_STATE', nodeId: right.id, size: right.buffer.length, capacity: this.bufferCapacity() });

    this.insertIntoParent(node, promotedKey, right);
  }

  // ——— 读路径：沿路把每层缓冲都翻一遍 ————————————

  /**
   * 点查。
   *
   * 从根往下走，**每经过一个内部节点都要在它的缓冲里找一遍这个键**。
   * 越靠近根的消息越新（消息只会往下走），所以：
   *  - 撞到 insert / delete 就可以当场返回 —— 它描述的是整条记录的最终状态；
   *  - 撞到 upsert 不能停：它只改了几列，还得继续往下拿底稿再合并。
   *
   * 读放大就长在这里：树高 h 的 B 树读 h 个页，Bε-树读 h 个页 + 翻 h 块缓冲。
   */
  private search(key: Key): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });

    let current = this.node(this.rootId);
    this.read(current.id, 'search');
    const pending: Message[] = [];
    let decidedBy: 'buffer' | 'leaf' | 'miss' = 'miss';
    let probedBuffers = 0;

    while (current.type !== 'leaf') {
      const hits = current.buffer.filter((m) => m.key === key);
      probedBuffers++;
      this.emit({
        type: 'BUFFER_PROBE',
        nodeId: current.id,
        level: current.level,
        key,
        messages: current.buffer.length,
        hits: hits.length,
        decisive: hits.some((h) => h.op !== 'upsert'),
      });

      if (hits.length > 0) {
        const newest = hits[hits.length - 1];
        if (newest.op !== 'upsert') {
          // 整条记录的最终状态就在这里，**根本不用走到叶子**。
          const found = newest.op === 'insert';
          this.emit({
            type: 'SEARCH_RESULT',
            key,
            found,
            pageId: current.id,
            slot: -1,
          });
          return found
            ? `命中 key=${key} —— 答案在第 ${current.level} 层的缓冲里，**没走到叶子**（翻了 ${probedBuffers} 块缓冲）`
            : `key=${key} 已删除 —— 删除消息还在第 ${current.level} 层的缓冲里，叶子那边其实还留着`;
        }
        pending.unshift(...hits);
      }

      const slot = upperBound(current.keys, key);
      const childId = current.children[slot];
      this.emit({ type: 'DESCEND', pageId: current.id, childId, key, slot, level: current.level });
      this.read(childId, 'search');
      current = this.node(childId);
    }

    const idx = lowerBound(current.keys, key);
    const base = current.keys[idx] === key ? current.rows[idx] : undefined;
    const found = base !== undefined || pending.some((m) => m.op !== 'delete');
    if (found) decidedBy = pending.length > 0 ? 'buffer' : 'leaf';
    this.emit({ type: 'SEARCH_RESULT', key, found, pageId: current.id, slot: found ? idx : -1 });

    if (!found) return `未找到 key=${key}（翻了 ${probedBuffers} 块缓冲 + 1 个叶子）`;
    return pending.length > 0
      ? `命中 key=${key} —— 叶子里的底稿 + 沿路 ${pending.length} 条 upsert 消息合并出来的（翻了 ${probedBuffers} 块缓冲）`
      : `命中 key=${key} @ 叶子 #${current.id} 槽 ${idx}（翻了 ${probedBuffers} 块缓冲，都没命中）${
          decidedBy === 'leaf' ? '' : ''
        }`;
  }

  // ——— 范围扫描：先把消息推到叶子 ————————————————

  /**
   * 范围扫描。
   *
   * 这是 Bε-树最贵的操作：叶子里的数据**不一定是最新的**，
   * 最新状态可能还躺在沿途某个缓冲里。所以扫描之前必须先把相关消息推下去。
   *
   * 这也是它没能取代 B+ 树的核心原因之一 —— 写得快是攒出来的，
   * 而范围扫描逼着你把攒的账**当场结清**。
   */
  private rangeScan(from: Key, to: Key): string {
    this.ensureTable();
    const pushed = this.flushAllInternal('范围扫描要求叶子是最新的');
    if (pushed > 0) this.pathFlushes++;

    this.emit({ type: 'SEARCH_BEGIN', key: Number.isFinite(from) ? from : 0, mode: 'range' });
    let cursor: PageId | null = this.leftmostLeaf();
    let rows = 0;
    let pages = 0;
    while (cursor !== null) {
      const leaf = this.node(cursor);
      pages++;
      this.read(leaf.id, 'scan');
      for (let i = 0; i < leaf.keys.length; i++) {
        const key = leaf.keys[i];
        if (key < from) continue;
        if (key > to) {
          this.emit({ type: 'SCAN_END', rows, pagesTouched: pages });
          return this.scanNote(rows, pushed);
        }
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot: i, key, row: leaf.rows[i] ?? null, emitted: true });
        rows++;
      }
      cursor = leaf.next;
    }
    this.emit({ type: 'SCAN_END', rows, pagesTouched: pages });
    return this.scanNote(rows, pushed);
  }

  private scanNote(rows: number, pushed: number): string {
    return pushed > 0
      ? `扫描返回 ${rows} 行 —— 但开扫之前先被迫把 ${pushed} 条消息推到了叶子：攒下的账，范围查询要当场结清`
      : `扫描返回 ${rows} 行（缓冲本来就是空的，没有额外开销）`;
  }

  private leftmostLeaf(): PageId {
    let current = this.node(this.rootId);
    while (current.type !== 'leaf') current = this.node(current.children[0]);
    return current.id;
  }

  /**
   * 把所有缓冲彻底推空（供范围扫描与手动 flush 使用）。返回推下去的消息条次。
   *
   * **每次只推一组，然后重新评估**：把一批消息推到叶子可能撑裂叶子，
   * 叶子分裂又可能把当前这个内部节点自己也劈开 —— 它的分隔键与子指针当场就变了。
   * 一次性算好分组再照着推，后面几组的子指针就会指向不存在的位置。
   */
  private flushAllInternal(reason: string): number {
    const before = this.flushedHops;
    const announced = new Set<PageId>();
    let guard = 0;
    for (;;) {
      assert(guard++ < 20_000, 'fractal: flushAll 没有收敛');
      const node = this.shallowestNonEmptyBuffer();
      if (!node) break;
      if (!announced.has(node.id)) {
        announced.add(node.id);
        this.emit({
          type: 'PATH_FLUSH',
          nodeId: node.id,
          level: node.level,
          messages: node.buffer.length,
          reason,
        });
      }

      // 取第一条消息所属的那个孩子，把发往它的整批一起推下去。
      const slot = upperBound(node.keys, node.buffer[0].key);
      const batch = node.buffer.filter((m) => upperBound(node.keys, m.key) === slot);
      const moving = new Set(batch.map((m) => m.seq));
      node.buffer = node.buffer.filter((m) => !moving.has(m.seq));

      const childId = node.children[slot];
      assert(childId !== undefined, `fractal: node #${node.id} 缺子指针 ${slot}`);
      const child = this.node(childId);
      this.flushedHops += batch.length;
      this.emit({
        type: 'MSG_FLUSH',
        fromNodeId: node.id,
        toNodeId: childId,
        childSlot: slot,
        msgIds: batch.map((m) => m.seq),
        keys: batch.map((m) => m.key),
        ops: batch.map((m) => m.op),
        toLeaf: child.type === 'leaf',
        remaining: node.buffer.length,
        reason,
      });
      this.read(childId, 'maintain');
      if (child.type === 'leaf') {
        this.applyToLeaf(child, batch);
      } else {
        child.buffer.push(...batch);
        this.emit({ type: 'BUFFER_STATE', nodeId: child.id, size: child.buffer.length, capacity: this.bufferCapacity() });
      }
    }
    return this.flushedHops - before;
  }

  /**
   * 找一个还有消息的内部节点，**从最浅的开始**。
   *
   * 自上而下推，消息整体往下沉，一轮扫下来就干净了；
   * 反过来自下而上推，上层的消息会掉进刚清空的节点里，还得再来一遍。
   */
  private shallowestNonEmptyBuffer(): FractalNode | null {
    let best: FractalNode | null = null;
    for (const node of this.nodes.values()) {
      if (node.type === 'leaf' || node.buffer.length === 0) continue;
      // level 越大越靠近根。同层按页号定序，保证可复现。
      if (best === null || node.level > best.level || (node.level === best.level && node.id < best.id)) {
        best = node;
      }
    }
    return best;
  }

  private flushAll(reason: string): string {
    this.ensureTable();
    const pushed = this.flushAllInternal(reason);
    return pushed === 0
      ? '所有缓冲本来就是空的'
      : `把 ${pushed} 条消息推到了叶子 —— 现在叶子是最新的，但这笔账刚刚才结清`;
  }

  // ——— 批量写 ————————————————————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.liveKeyCount() + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    const before = this.flushedHops;
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      this.inject(key, 'insert', makeRow(this.schema!, key));
    }
    const hops = this.flushedHops - before;
    const perRow = count === 0 ? 0 : hops / count;
    return (
      `批量写入 ${count} 条（${pattern}）—— 每条只是往根缓冲追加一次；` +
      `期间总共下推 ${hops} 条次，摊到每行 ${perRow.toFixed(2)} 次重写（B+ 树是树高 ${this.height}）`
    );
  }

  private liveKeyCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.type === 'leaf') n += node.keys.length;
    return n;
  }

  // ——— 结构投影 ————————————————————————————————————————

  snapshot(): StructuralSnapshot {
    const pages: StructuralSnapshot['pages'] = {};
    for (const [id, n] of this.nodes) {
      pages[id] = {
        id,
        indexId: PRIMARY_INDEX_ID,
        type: n.type,
        level: n.level,
        parentId: n.parentId,
        keys: n.keys.slice(),
        rows: structuredClone(n.rows),
        children: n.children.slice(),
        prev: n.prev,
        next: n.next,
        dirty: false,
        resident: false,
      };
    }
    return {
      indexes: {
        [PRIMARY_INDEX_ID]: {
          id: PRIMARY_INDEX_ID,
          name: PRIMARY_INDEX_ID,
          column: this.schema?.primaryKey ?? 'id',
          clustered: true,
          unique: true,
          rootId: this.rootId,
          firstLeafId: this.schema === null ? null : this.leftmostLeaf(),
          height: this.height,
          // 「有多少条」在 Bε-树里是个含糊的问题：叶子里的数量不算还在路上的消息。
          entries: this.liveKeyCount(),
        },
      },
      recordCount: this.liveKeyCount(),
      pages,
      bufferFrames: new Array<null>(Math.max(1, this.config.bufferPoolFrames)).fill(null),
      bufferRecency: [],
      fractal: this.projectFractal(),
    };
  }

  private projectFractal(): StructuralFractal {
    const buffers: StructuralFractal['buffers'] = [];
    for (const node of [...this.nodes.values()].sort((a, b) => a.id - b.id)) {
      if (node.type === 'leaf' || node.buffer.length === 0) continue;
      buffers.push({
        nodeId: node.id,
        messages: node.buffer.map((m) => ({ id: m.seq, key: m.key, op: m.op })),
      });
    }
    return { buffers };
  }

  // ——— 仅供测试 ————————————————————————————————————————

  /** 叶子里已经落地的键（还在缓冲里的消息不算）。 */
  leafKeys(): Key[] {
    const out: Key[] = [];
    let cursor: PageId | null = this.leftmostLeaf();
    while (cursor !== null) {
      const leaf = this.node(cursor);
      out.push(...leaf.keys);
      cursor = leaf.next;
    }
    return out;
  }

  /** 逻辑上可见的键：叶子内容 + 沿路所有消息合并后的结果。 */
  visibleKeys(): Key[] {
    const map = new Map<Key, boolean>();
    let cursor: PageId | null = this.leftmostLeaf();
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (const k of leaf.keys) map.set(k, true);
      cursor = leaf.next;
    }
    // 消息按注入顺序生效；同一个键以最新的那条为准。
    const msgs: Message[] = [];
    for (const node of this.nodes.values()) if (node.type !== 'leaf') msgs.push(...node.buffer);
    for (const m of msgs.sort((a, b) => a.seq - b.seq)) {
      if (m.op === 'delete') map.delete(m.key);
      else map.set(m.key, true);
    }
    return [...map.keys()].sort((a, b) => a - b);
  }

  /** 逻辑上可见的行（含 upsert 合并）。 */
  visibleRow(key: Key): Row | undefined {
    let base: Row | undefined;
    let cursor: PageId | null = this.leftmostLeaf();
    while (cursor !== null) {
      const leaf = this.node(cursor);
      const idx = lowerBound(leaf.keys, key);
      if (leaf.keys[idx] === key) {
        base = structuredClone(leaf.rows[idx] ?? undefined) as Row | undefined;
        break;
      }
      cursor = leaf.next;
    }
    const msgs: Message[] = [];
    for (const node of this.nodes.values()) if (node.type !== 'leaf') msgs.push(...node.buffer.filter((m) => m.key === key));
    for (const m of msgs.sort((a, b) => a.seq - b.seq)) {
      if (m.op === 'delete') base = undefined;
      else if (m.op === 'upsert') base = base === undefined ? { ...(m.payload ?? {}) } : { ...base, ...(m.payload ?? {}) };
      else base = { ...(m.payload ?? {}) };
    }
    return base;
  }

  pendingMessages(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.type !== 'leaf') n += node.buffer.length;
    return n;
  }

  injectedMessages(): number {
    return this.injected;
  }

  flushHops(): number {
    return this.flushedHops;
  }

  treeHeight(): number {
    return this.height;
  }
}
