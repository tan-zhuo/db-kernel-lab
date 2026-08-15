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
import type { StructuralCow, StructuralSnapshot } from '../state';
import { describePredicate, matchesPredicate, type PhysicalPlan, type Predicate } from '../query/types';
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

/** 页对象。形状与 LabState.PageState 的公共子集一致，便于快照比对。 */
interface CowNode {
  id: PageId;
  type: PageType;
  level: number;
  parentId: PageId | null;
  keys: Key[];
  rows: (Row | null)[];
  children: PageId[];
}

interface Reader {
  id: string;
  session: string;
  txnId: number;
  rootId: PageId;
}

/** 一个已提交事务留下的旧页；等到没有读者还看得见它，才能进空闲表。 */
interface PendingFree {
  txnId: number;
  pages: PageId[];
}

/**
 * 写时复制 B+ 树引擎（LMDB / 影子页 风格）。
 *
 * 它和 InnoDB 共用 B+ 树骨架，但**持久化哲学完全相反**：
 *
 * | | InnoDB（原地更新） | 本引擎（写时复制） |
 * |---|---|---|
 * | 改一行 | 就地改页，页变脏 | **复制根到叶的整条路径**，改副本 |
 * | 怎么算提交 | 写 redo 日志并 fsync | **翻转 meta 页**（指向新根），仅此一步 |
 * | 崩溃恢复 | 重放 redo / 回滚 undo | **不需要恢复**：meta 页要么旧要么新 |
 * | 读者 | 要么加锁要么读 undo 链 | 拿着旧根，**完全不加锁**，快照天然一致 |
 * | 并发写 | 多写者 + 行锁 | **单写者**，写与写之间串行 |
 * | 代价 | 写放大来自 redo + 双写 | 写放大来自**复制整条路径**；读者拖着不放会撑爆空间 |
 *
 * 三个只有它才有、而且必须看见的现象：
 *
 *  1. **改一行要复制 h 个页**（h = 树高）。批量写摊薄了这笔开销，单条写没得摊；
 *  2. **叶子之间没有链表**。链表会让每次修改再拖上左右邻居，级联到整层 ——
 *     所以范围扫描只能靠游标栈回到父页再往下走；
 *  3. **旧版本页不能立刻复用**：只要还有读者拿着旧根，这些页就得留着。
 *     长事务读者 = 空间放大，这是 LMDB 用户最常踩的坑。
 */
export class CowBTreeEngine implements StorageEngine {
  readonly name = 'Copy-on-Write B+Tree (LMDB-like)';
  readonly capabilities: readonly EngineCapability[] = [
    'btree',
    'clustered-index',
    'cow',
    'snapshot-reader',
    'transactions',
  ];

  config: EngineConfig;

  private nodes = new Map<PageId, CowNode>();
  private rootId: PageId = 0;
  private height = 1;
  private entries = 0;
  private distinct = 0;
  private minKey: Key | null = null;
  private maxKey: Key | null = null;
  private nextPageId = 1;

  /** 两个 meta 页轮流写：提交就是把「当前 meta」翻到另一个槽。 */
  private meta: { txnId: number; rootId: PageId; height: number }[] = [];
  private metaSlot: 0 | 1 = 0;
  private txnId = 0;
  /** 上一次通过 ROOT_CHANGE 对外宣告过的根。写时复制下根几乎每次提交都在变。 */
  private announcedRoot: PageId = 0;

  private freelist: PageId[] = [];
  private pendingFree: PendingFree[] = [];
  private readers: Reader[] = [];
  private session = 'A';
  private nextReaderId = 1;

  /** 本次写事务里已经复制过的页：同一页只复制一次。 */
  private copiedThisTxn = new Map<PageId, PageId>();
  private freedThisTxn: PageId[] = [];
  private copies = 0;
  private reused = 0;

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
      case 'insert':
        return this.writeTxn(() => {
          const row = command.row ?? makeRow(this.schema ?? DEFAULT_SCHEMA, command.key);
          const r = this.put(command.key, row);
          return r === 'updated' ? `更新 key=${command.key}` : `插入 key=${command.key}`;
        });
      case 'update':
        return this.writeTxn(() => {
          if (this.lookup(command.key) === undefined) throw new Error(`key=${command.key} 不存在`);
          this.put(command.key, command.row);
          return `更新 key=${command.key}（同样是复制整条路径，没有「就地改」这回事）`;
        });
      case 'delete':
        return this.writeTxn(() => {
          const ok = this.erase(command.key);
          if (!ok) throw new Error(`key=${command.key} 不存在`);
          return `删除 key=${command.key}`;
        });
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'search':
        return this.search(command.key);
      case 'range_scan':
        return this.rangeScan(command.from, command.to);
      case 'full_scan':
        return this.rangeScan(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      case 'query':
        return this.query(command.predicate, command.columns ?? '*');
      case 'begin_txn':
        return this.openReader();
      case 'commit_txn':
      case 'abort_txn':
        return this.closeReader();
      case 'use_session':
        this.session = command.session;
        return `切换到会话 ${command.session}${this.readerOf(command.session) ? '（该会话持有一个只读快照）' : ''}`;
      case 'flush_all':
        return this.reclaim(true);
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新';
      }
      case 'create_index':
      case 'drop_index':
        throw new Error(
          '写时复制 B+ 树没有自动维护的二级索引：LMDB 只提供多个命名子库，' +
            '要建索引得应用层自己在另一个子库里维护 —— 而且每次写都要复制两棵树的路径',
        );
      case 'vacuum':
        return this.reclaim(true);
      default:
        throw new Error(`写时复制引擎不支持命令 ${command.kind}`);
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
    this.announcedRoot = root.id;
    this.emit({ type: 'ROOT_CHANGE', indexId: PRIMARY_INDEX_ID, oldRootId: null, newRootId: root.id, height: 1 });

    // 两个 meta 页从同一个根开始：还没有任何写事务，两边一样。
    this.meta = [
      { txnId: 0, rootId: root.id, height: 1 },
      { txnId: 0, rootId: root.id, height: 1 },
    ];
    this.metaSlot = 0;
    this.emitMeta(0, null);
    return `表 ${schema.name} 已创建（写时复制 B+ 树 · 两个 meta 页轮流写 · 没有 WAL）`;
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

  // ——— 页分配：优先从空闲表复用 ————————————————————

  private allocPage(
    type: PageType,
    level: number,
    parentId: PageId | null,
    init?: { keys: Key[]; rows: (Row | null)[]; children: PageId[] },
  ): CowNode {
    let id: PageId;
    const recycled = this.freelist.shift();
    if (recycled !== undefined) {
      id = recycled;
      this.reused++;
      this.emit({ type: 'FREELIST_POP', pageId: id, txnId: this.txnId, remaining: this.freelist.length });
    } else {
      id = this.nextPageId++;
    }
    const node: CowNode = {
      id,
      type,
      level,
      parentId,
      keys: init ? init.keys.slice() : [],
      rows: init ? structuredClone(init.rows) : [],
      children: init ? init.children.slice() : [],
    };
    this.nodes.set(id, node);
    this.emit({
      type: 'PAGE_ALLOC',
      pageId: id,
      indexId: PRIMARY_INDEX_ID,
      pageType: type,
      level,
      parentId,
      init: init ? { keys: node.keys.slice(), rows: structuredClone(node.rows), children: node.children.slice() } : undefined,
    });
    return node;
  }

  private node(id: PageId): CowNode {
    const n = this.nodes.get(id);
    assert(n !== undefined, `cow: missing page #${id}`);
    return n;
  }

  private read(pageId: PageId, purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain'): void {
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  // ——— 写时复制的核心：复制一页 ————————————————————

  /**
   * 把一页复制成新页，返回新页。
   *
   * 三条规则：
   *  1. **同一个写事务里同一页只复制一次** —— 否则一次批量写会把同一条路径复制 N 遍；
   *  2. 新页优先从空闲表拿 —— 空闲表就是「之前的旧版本腾出来的位置」；
   *  3. 旧页不能立刻丢：它还属于**上一个已提交版本**，读者可能正看着。
   */
  private cow(pageId: PageId, reason: string): CowNode {
    const already = this.copiedThisTxn.get(pageId);
    if (already !== undefined) return this.node(already);

    const old = this.node(pageId);
    const copy = this.allocPage(old.type, old.level, old.parentId, old);
    this.copiedThisTxn.set(pageId, copy.id);
    this.freedThisTxn.push(pageId);
    this.copies++;
    this.emit({
      type: 'COW_COPY',
      fromPageId: pageId,
      toPageId: copy.id,
      pageType: old.type,
      level: old.level,
      reason,
      copiesInTxn: this.copiedThisTxn.size,
    });

    // 子页的 parentId 要跟着换到副本上（内部页复制后，它的孩子改认新父亲）。
    for (const childId of copy.children) {
      const child = this.nodes.get(childId);
      if (child) {
        child.parentId = copy.id;
        this.emit({ type: 'PARENT_SET', pageId: childId, parentId: copy.id });
      }
    }
    return copy;
  }

  // ——— 写事务 ————————————————————————————————————————

  /**
   * 一次写事务：复制路径 → 改副本 → 翻 meta 页。
   *
   * 这里刻意做成**自动提交**：每条写命令自己就是一个写事务。
   * 真实 LMDB 允许一个写事务里塞很多次修改（那样才能摊薄复制开销），
   * 批量插入走的正是那条路 —— 对比单条插入就能看出差别。
   */
  private writeTxn<T>(body: () => T): T {
    this.ensureTable();
    this.beginWrite();
    const result = body();
    this.commitWrite();
    return result;
  }

  private beginWrite(): void {
    this.txnId++;
    this.copiedThisTxn.clear();
    this.freedThisTxn = [];
    this.emit({
      type: 'WRITE_TXN_BEGIN',
      txnId: this.txnId,
      rootId: this.rootId,
      readers: this.readers.length,
    });
  }

  /**
   * 提交 = 把新根写进另一个 meta 页并翻过去。
   *
   * 这一步之前，磁盘上的旧版本一个字节都没被改动过 —— 所以崩在任何位置都无所谓：
   * meta 页要么还指着旧根（整个事务丢失），要么已经指着新根（整个事务生效）。
   * 没有中间态，也就不需要 WAL 和恢复流程。
   */
  private commitWrite(): void {
    // 写时复制下根**几乎每次提交都换**（它总是被复制的第一页），
    // 所以提交前必须把新根宣告出去，索引元数据才跟得上。
    if (this.rootId !== this.announcedRoot) {
      this.emit({
        type: 'ROOT_CHANGE',
        indexId: PRIMARY_INDEX_ID,
        oldRootId: this.announcedRoot,
        newRootId: this.rootId,
        height: this.height,
      });
      this.announcedRoot = this.rootId;
    }
    const prevRoot = this.meta[this.metaSlot].rootId;
    this.metaSlot = this.metaSlot === 0 ? 1 : 0;
    this.meta[this.metaSlot] = { txnId: this.txnId, rootId: this.rootId, height: this.height };
    this.emitMeta(this.txnId, prevRoot);

    // 旧版本的页进「挂起回收」队列，等没有读者看得见它们再进空闲表。
    if (this.freedThisTxn.length > 0) {
      this.pendingFree.push({ txnId: this.txnId, pages: this.freedThisTxn.slice() });
    }
    this.emit({
      type: 'WRITE_TXN_COMMIT',
      txnId: this.txnId,
      rootId: this.rootId,
      copiedPages: this.copiedThisTxn.size,
      retiredPages: this.freedThisTxn.slice(),
      height: this.height,
      entries: this.entries,
    });
    this.reclaim(false);
  }

  private emitMeta(txnId: number, prevRootId: PageId | null): void {
    this.emit({
      type: 'META_FLIP',
      slot: this.metaSlot,
      txnId,
      rootId: this.rootId,
      prevRootId,
      height: this.height,
      freePages: this.freelist.length,
      pendingPages: this.pendingFree.reduce((n, p) => n + p.pages.length, 0),
    });
  }

  // ——— 空闲页回收 ————————————————————————————————————

  /** 最老的读者：比它更新的版本才可以回收。没有读者时就是当前事务。 */
  private oldestReaderTxn(): number {
    return this.readers.reduce((min, r) => Math.min(min, r.txnId), Number.POSITIVE_INFINITY);
  }

  /**
   * 把「已经没人看得见」的旧页放进空闲表。
   *
   * 判定条件只有一条：某个事务留下的旧页，只要**最老的读者**比这个事务还新，
   * 就再也没人能通过任何一个活着的根走到它们。
   *
   * 反过来，一个开着不放的读事务会让这些页永远卡在挂起队列里 ——
   * 数据库文件于是只涨不缩。这就是「长读事务撑爆 LMDB」的全部机理。
   */
  private reclaim(manual: boolean): string {
    const oldest = this.oldestReaderTxn();
    const releasable: PendingFree[] = [];
    const blocked: PendingFree[] = [];
    for (const p of this.pendingFree) {
      if (p.txnId <= oldest) releasable.push(p);
      else blocked.push(p);
    }

    let released = 0;
    for (const batch of releasable) {
      for (const pageId of batch.pages) {
        this.nodes.delete(pageId);
        this.emit({ type: 'PAGE_FREE', pageId });
        this.freelist.push(pageId);
        released++;
      }
    }
    if (released > 0) {
      this.emit({
        type: 'FREELIST_PUSH',
        pageIds: releasable.flatMap((b) => b.pages),
        releasedTxns: releasable.map((b) => b.txnId),
        txnId: this.txnId,
        freePages: this.freelist.length,
      });
    }
    this.pendingFree = blocked;

    const retained = blocked.reduce((n, b) => n + b.pages.length, 0);
    if (!manual && retained === 0 && released === 0) return '';
    const blocker = this.readers.length > 0 ? `（${this.readers.length} 个读者占着最老版本 txn=${oldest}）` : '';
    return `回收 ${released} 页进空闲表（现有 ${this.freelist.length} 页可复用）；还有 ${retained} 页挂着回收不了${blocker}`;
  }

  // ——— 只读快照（读者）——————————————————————————————

  private readerOf(session: string): Reader | undefined {
    return this.readers.find((r) => r.session === session);
  }

  /**
   * 开一个只读快照事务。
   *
   * 它做的事只有一件：**记下当前的根页号**。没有锁、没有版本链、没有可见性判定 ——
   * 那个根往下的整棵树本身就是一个完整且不可变的历史版本。
   */
  private openReader(): string {
    this.ensureTable();
    if (this.readerOf(this.session)) throw new Error(`会话 ${this.session} 已经持有一个只读快照，先提交或中止它`);
    const reader: Reader = {
      id: `r${this.nextReaderId++}`,
      session: this.session,
      txnId: this.meta[this.metaSlot].txnId,
      rootId: this.rootId,
    };
    this.readers.push(reader);
    this.emit({
      type: 'SNAPSHOT_OPEN',
      readerId: reader.id,
      session: reader.session,
      txnId: reader.txnId,
      rootId: reader.rootId,
      readers: this.readers.length,
    });
    return `会话 ${this.session} 打开只读快照 ${reader.id}（钉住根页 #${reader.rootId} / txn=${reader.txnId}）—— 全程零加锁`;
  }

  private closeReader(): string {
    const reader = this.readerOf(this.session);
    if (!reader) throw new Error(`会话 ${this.session} 没有打开的只读快照`);
    this.readers = this.readers.filter((r) => r.id !== reader.id);
    this.emit({
      type: 'SNAPSHOT_CLOSE',
      readerId: reader.id,
      session: reader.session,
      txnId: reader.txnId,
      readers: this.readers.length,
    });
    const note = this.reclaim(true);
    return `关闭快照 ${reader.id}${note ? ` —— ${note}` : ''}`;
  }

  // ——— 查找 ————————————————————————————————————————————

  /** 从某个根下降到叶子，返回路径栈（供范围扫描当游标用）。 */
  private descend(rootId: PageId, key: Key, purpose: 'search' | 'insert' | 'delete' | 'scan'): PageId[] {
    const stack: PageId[] = [];
    let current = rootId;
    this.read(current, purpose);
    for (;;) {
      stack.push(current);
      const node = this.node(current);
      if (node.type === 'leaf') return stack;
      const childIndex = upperBound(node.keys, key);
      const childId = node.children[childIndex];
      assert(childId !== undefined, `cow: internal page #${node.id} missing child ${childIndex}`);
      this.emit({ type: 'DESCEND', pageId: node.id, childId, key, slot: childIndex, level: node.level });
      this.read(childId, purpose);
      current = childId;
    }
  }

  private lookup(key: Key, rootId = this.rootId): Row | null | undefined {
    if (this.entriesOf(rootId) === 0 && this.nodes.get(rootId)?.keys.length === 0) {
      // 空树也要走一次下降，读路径才完整。
    }
    const stack = this.descend(rootId, key, 'search');
    const leaf = this.node(stack[stack.length - 1]);
    const idx = lowerBound(leaf.keys, key);
    return leaf.keys[idx] === key ? (leaf.rows[idx] ?? null) : undefined;
  }

  private entriesOf(_rootId: PageId): number {
    return this.entries;
  }

  private search(key: Key): string {
    this.ensureTable();
    // 有只读快照就从快照的根出发 —— 这才是「读者看到的是哪一版」的关键。
    const reader = this.readerOf(this.session);
    const rootId = reader?.rootId ?? this.rootId;
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const stack = this.descend(rootId, key, 'search');
    const leaf = this.node(stack[stack.length - 1]);
    const idx = lowerBound(leaf.keys, key);
    const found = leaf.keys[idx] === key;
    this.emit({ type: 'SEARCH_RESULT', key, found, pageId: leaf.id, slot: found ? idx : -1 });
    const from = reader ? `快照 ${reader.id}（txn=${reader.txnId}）` : `最新版本（txn=${this.meta[this.metaSlot].txnId}）`;
    return found
      ? `命中 key=${key} @ 页 #${leaf.id} 槽 ${idx} —— 读自${from}，全程没有加过任何锁`
      : `未找到 key=${key}（读自${from}）`;
  }

  // ——— 范围扫描：没有叶子链表，只能靠游标栈 ————————

  /**
   * 范围扫描。
   *
   * **这里没有叶子链表可用**：写时复制的树如果维护 prev/next，
   * 那么改一个叶子就得连它左右邻居一起复制，邻居的父页也跟着复制 ——
   * 一次点写会级联成整层重写。代价太大，所以 LMDB 干脆不要链表。
   *
   * 换来的是扫描要贵一点：走完一个叶子得**沿路径栈回到父页**，
   * 找到下一个子指针再往下钻。树高 h 的树，每跨一个叶子最多多走 h 步。
   */
  private rangeScan(from: Key, to: Key): string {
    this.ensureTable();
    const reader = this.readerOf(this.session);
    const rootId = reader?.rootId ?? this.rootId;
    this.emit({ type: 'SEARCH_BEGIN', key: Number.isFinite(from) ? from : 0, mode: 'range' });

    let stack = this.descend(rootId, Number.isFinite(from) ? from : Number.NEGATIVE_INFINITY, 'scan');
    let rows = 0;
    let hops = 0;
    let steps = 0;
    for (;;) {
      const leaf = this.node(stack[stack.length - 1]);
      for (let i = 0; i < leaf.keys.length; i++) {
        const key = leaf.keys[i];
        if (key < from) continue;
        if (key > to) {
          this.emit({ type: 'SCAN_END', rows, pagesTouched: steps });
          return this.scanNote(rows, hops, steps, reader);
        }
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot: i, key, row: leaf.rows[i] ?? null, emitted: true });
        rows++;
        steps++;
      }
      const next = this.nextLeaf(stack);
      if (!next) break;
      stack = next.stack;
      hops += next.climbed;
    }
    this.emit({ type: 'SCAN_END', rows, pagesTouched: steps });
    return this.scanNote(rows, hops, steps, reader);
  }

  private scanNote(rows: number, hops: number, _steps: number, reader: Reader | undefined): string {
    const from = reader ? `快照 ${reader.id}` : '最新版本';
    return `扫描返回 ${rows} 行（读自${from}）—— 跨叶子时游标栈回溯了 ${hops} 次：写时复制的树没有叶子链表`;
  }

  /**
   * 游标栈前进到下一个叶子：向上爬到还有右兄弟的那一层，再一路向下走到最左叶子。
   * 返回爬了几层，用来量化「没有叶子链表」的代价。
   */
  private nextLeaf(stack: PageId[]): { stack: PageId[]; climbed: number } | null {
    const path = stack.slice();
    let climbed = 0;
    while (path.length > 1) {
      const childId = path.pop()!;
      climbed++;
      const parent = this.node(path[path.length - 1]);
      const at = parent.children.indexOf(childId);
      if (at >= 0 && at + 1 < parent.children.length) {
        let cur = parent.children[at + 1];
        this.read(cur, 'scan');
        path.push(cur);
        while (this.node(cur).type !== 'leaf') {
          const child = this.node(cur).children[0];
          this.emit({ type: 'DESCEND', pageId: cur, childId: child, key: this.node(cur).keys[0] ?? 0, slot: 0, level: this.node(cur).level });
          this.read(child, 'scan');
          path.push(child);
          cur = child;
          climbed++;
        }
        return { stack: path, climbed };
      }
    }
    return null;
  }

  // ——— 插入 / 删除（全部走复制路径）————————————————

  private put(key: Key, row: Row): 'inserted' | 'updated' {
    // 下降的同时把整条路径复制一遍：根先复制，然后每往下一层复制一个子页。
    let parent: CowNode | null = null;
    let parentSlot = -1;
    let current = this.cow(this.rootId, '写事务要改这棵树，根页先复制');
    if (current.id !== this.rootId) {
      this.rootId = current.id;
      current.parentId = null;
    }

    for (;;) {
      if (current.type === 'leaf') break;
      const childIndex = upperBound(current.keys, key);
      const childId = current.children[childIndex];
      this.emit({ type: 'DESCEND', pageId: current.id, childId, key, slot: childIndex, level: current.level });
      this.read(childId, 'insert');
      const childCopy = this.cow(childId, `路径经过第 ${current.level - 1} 层`);
      if (childCopy.id !== childId) {
        current.children[childIndex] = childCopy.id;
        this.emit({ type: 'CHILD_REPOINT', pageId: current.id, slot: childIndex, oldChildId: childId, newChildId: childCopy.id });
        childCopy.parentId = current.id;
        this.emit({ type: 'PARENT_SET', pageId: childCopy.id, parentId: current.id });
      }
      parent = current;
      parentSlot = childIndex;
      current = childCopy;
    }
    void parent;
    void parentSlot;

    const leaf = current;
    const idx = lowerBound(leaf.keys, key);
    if (leaf.keys[idx] === key) {
      const oldRow = leaf.rows[idx] ?? null;
      this.emit({ type: 'RECORD_UPDATE', pageId: leaf.id, slot: idx, key, row, oldRow });
      leaf.rows[idx] = structuredClone(row);
      return 'updated';
    }

    this.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key, row });
    leaf.keys.splice(idx, 0, key);
    leaf.rows.splice(idx, 0, structuredClone(row));
    this.entries++;
    this.distinct++;
    this.minKey = this.minKey === null ? key : Math.min(this.minKey, key);
    this.maxKey = this.maxKey === null ? key : Math.max(this.maxKey, key);

    if (leaf.keys.length > this.capacity()) this.splitLeaf(leaf, key);
    return 'inserted';
  }

  private splitLeaf(leaf: CowNode, triggerKey: Key): void {
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

    // 叶子之间**不连链表** —— 这正是写时复制付出的代价。
    this.insertIntoParent(leaf, promotedKey, right);
  }

  private insertIntoParent(left: CowNode, key: Key, right: CowNode): void {
    if (left.parentId === null) {
      // 新根带着左子一起分配；右子与分隔键由紧随其后的 SEPARATOR_INSERT 补上。
      const root = this.allocPage('internal', left.level + 1, null, { keys: [], rows: [], children: [left.id] });
      root.keys = [key];
      root.children = [left.id, right.id];
      left.parentId = root.id;
      right.parentId = root.id;
      this.emit({ type: 'PARENT_SET', pageId: left.id, parentId: root.id });
      this.emit({ type: 'PARENT_SET', pageId: right.id, parentId: root.id });
      this.emit({ type: 'SEPARATOR_INSERT', pageId: root.id, slot: 0, key, childId: right.id });
      this.rootId = root.id;
      this.height++;
      this.announcedRoot = root.id;
      this.emit({ type: 'ROOT_CHANGE', indexId: PRIMARY_INDEX_ID, oldRootId: left.id, newRootId: root.id, height: this.height });
      return;
    }

    // 父页在下降时已经复制过了，直接改。
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

  private splitInternal(node: CowNode): void {
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
    this.insertIntoParent(node, promotedKey, right);
  }

  /**
   * 删除。
   *
   * 简化点（诚实标注）：这里**不做页合并**，只把记录从复制出来的叶子里摘掉。
   * 真实 LMDB 也倾向于不急着合并 —— 空出来的位置会被后续写入填回去，
   * 而合并意味着还要复制更多页。空页会在提交时随旧版本一起进空闲表。
   */
  private erase(key: Key): boolean {
    let current = this.cow(this.rootId, '写事务要改这棵树，根页先复制');
    if (current.id !== this.rootId) {
      this.rootId = current.id;
      current.parentId = null;
    }
    for (;;) {
      if (current.type === 'leaf') break;
      const childIndex = upperBound(current.keys, key);
      const childId = current.children[childIndex];
      this.emit({ type: 'DESCEND', pageId: current.id, childId, key, slot: childIndex, level: current.level });
      this.read(childId, 'delete');
      const childCopy = this.cow(childId, `路径经过第 ${current.level - 1} 层`);
      if (childCopy.id !== childId) {
        current.children[childIndex] = childCopy.id;
        this.emit({ type: 'CHILD_REPOINT', pageId: current.id, slot: childIndex, oldChildId: childId, newChildId: childCopy.id });
        childCopy.parentId = current.id;
        this.emit({ type: 'PARENT_SET', pageId: childCopy.id, parentId: current.id });
      }
      current = childCopy;
    }

    const leaf = current;
    const idx = lowerBound(leaf.keys, key);
    if (leaf.keys[idx] !== key) return false;
    const removed = leaf.rows[idx] ?? null;
    this.emit({ type: 'RECORD_DELETE', pageId: leaf.id, slot: idx, key, row: removed });
    leaf.keys.splice(idx, 1);
    leaf.rows.splice(idx, 1);
    this.entries--;
    this.distinct = Math.max(0, this.distinct - 1);
    return true;
  }

  // ——— 批量写：一个事务里改很多次，摊薄复制开销 ————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.entries + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);

    this.beginWrite();
    const before = this.copies;
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      this.put(key, makeRow(this.schema!, key));
    }
    const copied = this.copies - before;
    this.commitWrite();
    const perRow = count === 0 ? 0 : copied / count;
    return (
      `批量插入 ${count} 条（${pattern}）—— 整批只有 1 个写事务，一共复制 ${copied} 页，` +
      `摊到每行 ${perRow.toFixed(2)} 页。单条插入时这个数字就是树高 ${this.height}`
    );
  }

  // ——— 查询（只有主键这一条路）——————————————————

  private query(predicate: Predicate, columns: string[] | '*'): string {
    this.ensureTable();
    const pk = this.schema!.primaryKey;
    const onKey = predicate.kind !== 'all' && predicate.column === pk;
    const plan: PhysicalPlan = {
      root: {
        id: 'n0',
        op: 'Project',
        detail: columns === '*' ? '整行' : columns.join(', '),
        estRows: this.entries,
        estCost: 0,
        children: [
          {
            id: 'n1',
            op: onKey ? (predicate.kind === 'eq' ? 'IndexSeek' : 'IndexRangeScan') : 'TableScan',
            detail: onKey
              ? `PRIMARY (${describePredicate(predicate)})`
              : `全树扫描 + 过滤（${describePredicate(predicate)}）`,
            indexId: PRIMARY_INDEX_ID,
            estRows: onKey && predicate.kind === 'eq' ? 1 : this.entries,
            estCost: onKey ? this.height : Math.max(1, this.entries / this.capacity()),
            children: [],
          },
        ],
      },
      predicate,
      chosen: onKey
        ? '主键就是唯一的索引：谓词落在主键上才有得走'
        : '谓词不在主键上 —— 没有二级索引可选，只能整棵树扫一遍再过滤',
      candidates: [
        {
          label: onKey ? '主键下降' : '全树扫描',
          strategy: onKey ? (predicate.kind === 'eq' ? 'index-seek' : 'index-range') : 'table-scan',
          indexId: PRIMARY_INDEX_ID,
          estRows: onKey && predicate.kind === 'eq' ? 1 : this.entries,
          estCost: onKey ? this.height : Math.max(1, this.entries),
          needsLookup: false,
          chosen: true,
          reason: onKey ? '主键有序，直接下降' : '写时复制引擎没有自动维护的二级索引',
        },
      ],
      columns,
    };
    this.emit({ type: 'PLAN_READY', plan });

    const reader = this.readerOf(this.session);
    const rootId = reader?.rootId ?? this.rootId;
    this.emit({ type: 'OPERATOR_OPEN', nodeId: 'n1', op: plan.root.children[0].op, detail: plan.root.children[0].detail });

    let matched = 0;
    let scanned = 0;
    if (onKey && predicate.kind === 'eq') {
      const stack = this.descend(rootId, predicate.value, 'search');
      const leaf = this.node(stack[stack.length - 1]);
      const idx = lowerBound(leaf.keys, predicate.value);
      scanned = 1;
      if (leaf.keys[idx] === predicate.value) {
        matched = 1;
        this.emit({ type: 'OPERATOR_ROW', nodeId: 'n1', key: predicate.value, emitted: true });
      }
      this.emit({ type: 'SEARCH_RESULT', key: predicate.value, found: matched > 0, pageId: leaf.id, slot: matched ? idx : -1 });
    } else {
      const lo = predicate.kind === 'range' && onKey ? predicate.from : Number.NEGATIVE_INFINITY;
      const hi = predicate.kind === 'range' && onKey ? predicate.to : Number.POSITIVE_INFINITY;
      let stack = this.descend(rootId, Number.isFinite(lo) ? lo : Number.NEGATIVE_INFINITY, 'scan');
      outer: for (;;) {
        const leaf = this.node(stack[stack.length - 1]);
        for (let i = 0; i < leaf.keys.length; i++) {
          const key = leaf.keys[i];
          if (key < lo) continue;
          if (key > hi) break outer;
          scanned++;
          const value = onKey ? key : (leaf.rows[i]?.[predicate.kind === 'all' ? pk : predicate.column] as Key | undefined);
          const passed = matchesPredicate(predicate, onKey ? key : value);
          if (passed) matched++;
          this.emit({ type: 'OPERATOR_ROW', nodeId: 'n1', key, emitted: passed });
        }
        const next = this.nextLeaf(stack);
        if (!next) break;
        stack = next.stack;
      }
    }
    this.emit({ type: 'OPERATOR_CLOSE', nodeId: 'n1', actualRows: matched });
    this.emit({ type: 'OPERATOR_CLOSE', nodeId: 'n0', actualRows: matched });
    return `查询返回 ${matched} 行（扫了 ${scanned} 条）—— ${plan.chosen}`;
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
        prev: null,
        next: null,
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
          // 没有叶子链表，所以也就没有「第一个叶子」这个概念。
          firstLeafId: null,
          height: this.height,
          entries: this.entries,
        },
      },
      recordCount: this.entries,
      pages,
      bufferFrames: new Array<null>(Math.max(1, this.config.bufferPoolFrames)).fill(null),
      bufferRecency: [],
      cow: this.projectCow(),
    };
  }

  private projectCow(): StructuralCow {
    return {
      metaSlot: this.metaSlot,
      rootId: this.rootId,
      txnId: this.meta[this.metaSlot]?.txnId ?? 0,
      freelist: this.freelist.slice(),
      readers: this.readers.map((r) => ({ id: r.id, txnId: r.txnId, rootId: r.rootId })),
      pending: this.pendingFree.map((p) => ({ txnId: p.txnId, pages: p.pages.slice() })),
    };
  }

  // ——— 仅供测试 ————————————————————————————————————————

  /** 按键序返回全部键（没有叶子链表，只能靠中序遍历）。 */
  allKeys(): Key[] {
    const out: Key[] = [];
    const walk = (id: PageId): void => {
      const n = this.nodes.get(id);
      if (!n) return;
      if (n.type === 'leaf') {
        out.push(...n.keys);
        return;
      }
      for (const c of n.children) walk(c);
    };
    walk(this.rootId);
    return out;
  }

  /** 某个历史根下的全部键 —— 用来断言「读者看到的是旧版本」。 */
  keysAtRoot(rootId: PageId): Key[] {
    const out: Key[] = [];
    const walk = (id: PageId): void => {
      const n = this.nodes.get(id);
      if (!n) return;
      if (n.type === 'leaf') {
        out.push(...n.keys);
        return;
      }
      for (const c of n.children) walk(c);
    };
    walk(rootId);
    return out;
  }

  copiedPages(): number {
    return this.copies;
  }

  reusedPages(): number {
    return this.reused;
  }

  freePages(): number {
    return this.freelist.length;
  }

  retainedPages(): number {
    return this.pendingFree.reduce((n, p) => n + p.pages.length, 0);
  }

  currentRoot(): PageId {
    return this.rootId;
  }

  treeHeight(): number {
    return this.height;
  }

  openReaders(): { id: string; txnId: number; rootId: PageId }[] {
    return this.readers.map((r) => ({ id: r.id, txnId: r.txnId, rootId: r.rootId }));
  }
}
