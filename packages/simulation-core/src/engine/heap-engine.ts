import {
  Rng,
  assert,
  packTid,
  type IsolationLevel,
  type Key,
  type LinePointerState,
  type PageId,
  type Row,
  type TableSchema,
  type Tid,
  type Txid,
} from '@dbkl/shared';
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralSnapshot } from '../state';
import { buildHeapPlan } from '../query/heap-planner';
import { matchesPredicate, type IndexStats, type PhysicalPlan, type PlanNode, type Predicate } from '../query/types';
import {
  DEFAULT_ENGINE_CONFIG,
  PRIMARY_INDEX_ID,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { BufferPool } from './buffer-pool';
import { BPlusTree, type AccessPurpose, type TreeHost, type TreeNode } from './bplus-tree';
import { commandKind, commandLabel, makeRow } from './common';
import { DEFAULT_SCHEMA } from './btree-engine';

/** 堆表里的一个元组版本（引擎内部形态，与 LabState.HeapTupleState 对齐）。 */
interface HeapTuple {
  key: Key;
  row: Row | null;
  xmin: Txid;
  xmax: Txid | null;
  /** t_ctid：指向下一个版本。 */
  next: Tid | null;
  hot: boolean;
  lp: LinePointerState;
  redirectTo: number | null;
}

interface HeapPage {
  id: PageId;
  blockNo: number;
  tuples: HeapTuple[];
  dirty: boolean;
  allVisible: boolean;
  /** 行指针容量，建页时定死（后续改配置不影响已有页）。 */
  slots: number;
}

interface Snapshot {
  xmin: Txid;
  xmax: Txid;
  active: Txid[];
}

interface Txn {
  xid: Txid;
  isolation: IsolationLevel;
  implicit: boolean;
  writes: number;
  /** REPEATABLE READ 的事务级快照；READ COMMITTED 下为 null（每条语句重新取）。 */
  snapshot: Snapshot | null;
}

interface Visibility {
  visible: boolean;
  reason: string;
}

/** 第一个用户事务号。留出低位给「引导数据」，方便阅读。 */
const FIRST_XID = 100;

/**
 * Phase 2 引擎：PostgreSQL 风格的堆表 + 独立 B 树索引 + MVCC。
 *
 * 与 InnoDB 引擎的**根本区别**（这也是把两个引擎并排放进同一个实验室的意义）：
 *
 * | | InnoDB（Phase 1） | PostgreSQL（本引擎） |
 * |---|---|---|
 * | 表的物理形态 | 主键 B+ 树，叶子页就是数据 | 无序堆文件，行指针 + 元组 |
 * | 主键查询 | 一次树下降就拿到整行 | 树下降拿到 TID，**再回堆一跳** |
 * | 更新 | 就地改叶子记录 | 写**新版本**，旧版本打 xmax，形成版本链 |
 * | 旧版本放哪 | Undo 日志（表外） | 就在表里 → 表膨胀 → 需要 VACUUM |
 * | 二级索引项 | (列, 主键) | (列, TID) |
 * | 删除后的空间 | 页内立即回收 | 死元组，等 VACUUM |
 *
 * MVCC 语义：每个元组带 (xmin, xmax)，读的时候拿快照判可见性。
 * 仿真是单线程的，但通过「会话」命令可以让多个事务同时处于进行中，
 * 因此 READ COMMITTED 与 REPEATABLE READ 的差别是**真的能跑出来**的。
 *
 * 未实现（见 docs/architecture.md 差异表）：行锁与等待（写冲突直接报错而不是阻塞）、
 * 子事务、freeze / 事务号回卷、TOAST、Bitmap Heap Scan。
 */
export class PostgresHeapEngine implements StorageEngine, TreeHost {
  readonly name = 'PostgreSQL-like Heap + MVCC';
  readonly capabilities: readonly EngineCapability[] = [
    'btree',
    'secondary-index',
    'heap',
    'mvcc',
    'vacuum',
    'transactions',
    'buffer-pool',
  ];

  config: EngineConfig;

  readonly nodes = new Map<PageId, TreeNode>();
  private heapPages = new Map<PageId, HeapPage>();
  private heapOrder: PageId[] = [];
  private indexes = new Map<string, BPlusTree>();
  /** 逻辑上唯一的索引（主键索引）——B 树本身允许重复键，因为同一行的多个版本各有一条索引项。 */
  private uniqueIndexes = new Set<string>();
  private nextPageId = 1;
  private nextBlockNo = 0;
  private schema: TableSchema | null = null;
  private buffer: BufferPool;
  private rng: Rng;

  private nextXid: Txid = FIRST_XID;
  private committed = new Set<Txid>();
  private aborted = new Set<Txid>();
  /** 会话名 → 进行中的事务；仿真单线程，但可以有多个会话同时开着事务。 */
  private sessions = new Map<string, Txn>();
  private currentSession = 'A';

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.buffer = new BufferPool(this.config, {
      emit: (body) => this.emit(body),
      isDirty: (id) => this.nodes.get(id)?.dirty ?? this.heapPages.get(id)?.dirty ?? false,
      onFlushed: (id) => {
        const n = this.nodes.get(id);
        if (n) n.dirty = false;
        const h = this.heapPages.get(id);
        if (h) h.dirty = false;
      },
      exists: (id) => this.nodes.has(id) || this.heapPages.has(id),
    });
  }

  get eventCount(): number {
    return this.seq;
  }

  // ——— TreeHost ————————————————————————————————————————

  allocPageId(): PageId {
    return this.nextPageId++;
  }

  access(pageId: PageId, purpose: AccessPurpose): void {
    this.buffer.access(pageId);
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  forgetPage(pageId: PageId): void {
    this.buffer.forget(pageId);
  }

  /** 索引项之间靠 TID 定序 —— PostgreSQL 的索引元组就是 (键, ctid)。 */
  tieBreak(row: Row | null | undefined): number {
    if (!row) return Number.NEGATIVE_INFINITY;
    const v = row.ctid;
    return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
  }

  emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
  }

  // ——— 命令入口 ————————————————————————————————————————

  execute(command: Command): SimulationEvent[] {
    this.out = [];
    this.cmdId++;
    const label = `${commandLabel(command)}${this.sessions.size > 0 || command.kind === 'use_session' ? `  [会话 ${this.currentSession}]` : ''}`;
    this.emit({ type: 'COMMAND_BEGIN', kind: commandKind(command), label });

    let note: string | undefined;
    let ok = true;
    try {
      note = this.dispatch(command);
    } catch (err) {
      ok = false;
      note = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'NOTE', message: note, level: 'error' });
      // 隐式事务遇错就地回滚，跟 psql 的自动提交行为一致。
      const txn = this.sessions.get(this.currentSession);
      if (txn?.implicit) this.rollback(txn, note);
    }

    if (this.schema !== null) this.emitBloat();
    this.emit({ type: 'COMMAND_END', kind: commandKind(command), label, ok, note });
    return this.out;
  }

  private dispatch(command: Command): string | undefined {
    switch (command.kind) {
      case 'create_table':
        return this.createTable(command.schema);
      case 'create_index':
        return this.createIndex(command.name, command.column);
      case 'drop_index':
        return this.dropIndex(command.name);
      case 'use_session': {
        this.currentSession = command.session;
        const txn = this.sessions.get(command.session);
        return `当前会话 = ${command.session}${txn ? `（事务 xid=${txn.xid} 进行中）` : '（无进行中的事务）'}`;
      }
      case 'begin_txn': {
        const txn = this.beginTxn(false, command.isolation ?? this.config.isolation);
        return `会话 ${this.currentSession} 开启事务 xid=${txn.xid}`;
      }
      case 'commit_txn': {
        const txn = this.requireTxn();
        const writes = txn.writes;
        this.commit(txn);
        return `提交 xid=${txn.xid}，写入 ${writes} 个版本`;
      }
      case 'abort_txn': {
        const txn = this.requireTxn();
        const writes = txn.writes;
        this.rollback(txn, '用户回滚');
        return `回滚 xid=${txn.xid}，${writes} 个版本作废`;
      }
      case 'insert': {
        const row = command.row ?? makeRow(this.schema ?? DEFAULT_SCHEMA, command.key);
        return this.inTxn(() => this.upsert(command.key, row));
      }
      case 'bulk_insert':
        return this.inTxn(() => this.bulkInsert(command));
      case 'update':
        return this.inTxn(() => this.upsert(command.key, command.row));
      case 'delete':
        return this.inTxn(() => this.deleteRow(command.key));
      case 'search':
        return this.inTxn(() => this.pointSearch(command.key));
      case 'range_scan':
        return this.inTxn(() => this.indexRangeScan(command.from, command.to));
      case 'full_scan':
        return this.inTxn(() => this.seqScan());
      case 'query':
        return this.inTxn(() => this.runQuery(command.predicate, command.columns ?? '*', command.hint ?? 'auto'));
      case 'vacuum':
        return this.vacuum(command.full ? 'full' : 'lazy');
      case 'flush_all': {
        const n = this.buffer.flushAll('manual');
        return `刷盘 ${n} 个脏页`;
      }
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.buffer.reconfigure(this.config);
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（堆页容量变化不影响已有页，请重置以重建）';
      }
      default:
        throw new Error(`PostgreSQL 堆表引擎不支持命令 ${command.kind}`);
    }
  }

  // ——— 事务 ————————————————————————————————————————————

  private beginTxn(implicit: boolean, isolation: IsolationLevel): Txn {
    assert(!this.sessions.has(this.currentSession), `会话 ${this.currentSession} 已有进行中的事务，请先 COMMIT/ROLLBACK`);
    const txn: Txn = { xid: this.nextXid++, isolation, implicit, writes: 0, snapshot: null };
    this.sessions.set(this.currentSession, txn);
    this.emit({ type: 'TXN_BEGIN', xid: txn.xid, isolation, implicit });
    if (isolation === 'repeatable-read') {
      // REPEATABLE READ：事务开始时就把快照钉死，之后整个事务都用它。
      txn.snapshot = this.takeSnapshot(txn, 'transaction');
    }
    return txn;
  }

  /** 隐式事务：没有显式 BEGIN 时，每条语句自成一个事务（psql 的自动提交）。 */
  private inTxn(body: () => string): string {
    const existing = this.sessions.get(this.currentSession);
    if (existing) return body();
    const txn = this.beginTxn(true, this.config.isolation);
    try {
      const note = body();
      this.commit(txn);
      return note;
    } catch (err) {
      this.rollback(txn, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private commit(txn: Txn): void {
    this.committed.add(txn.xid);
    this.sessions.delete(sessionOf(this.sessions, txn) ?? this.currentSession);
    this.emit({ type: 'TXN_COMMIT', xid: txn.xid, writes: txn.writes });
  }

  private rollback(txn: Txn, reason: string): void {
    this.aborted.add(txn.xid);
    this.sessions.delete(sessionOf(this.sessions, txn) ?? this.currentSession);
    this.emit({ type: 'TXN_ABORT', xid: txn.xid, writes: txn.writes, reason });
  }

  private requireTxn(): Txn {
    const txn = this.sessions.get(this.currentSession);
    assert(txn !== undefined, `会话 ${this.currentSession} 没有进行中的事务`);
    return txn;
  }

  /**
   * 取快照：记录「现在哪些事务还没结束」。
   *
   * READ COMMITTED 每条语句取一次，因此能看到期间提交的新数据；
   * REPEATABLE READ 只在事务开始时取一次，整个事务看到同一份世界。
   */
  private takeSnapshot(txn: Txn, scope: 'statement' | 'transaction'): Snapshot {
    const active = [...this.sessions.values()].map((t) => t.xid).filter((x) => x !== txn.xid).sort((a, b) => a - b);
    const snapshot: Snapshot = {
      xmin: active.length > 0 ? Math.min(...active, txn.xid) : txn.xid,
      xmax: this.nextXid,
      active,
    };
    this.emit({
      type: 'SNAPSHOT_TAKE',
      xid: txn.xid,
      xmin: snapshot.xmin,
      xmax: snapshot.xmax,
      active: snapshot.active.slice(),
      scope,
    });
    return snapshot;
  }

  /** 当前语句应该用的快照。 */
  private snapshotFor(txn: Txn): Snapshot {
    if (txn.snapshot) return txn.snapshot;
    return this.takeSnapshot(txn, 'statement');
  }

  /**
   * 可见性判定 —— 整个 MVCC 的核心，也是最值得单步观察的一段。
   */
  private visible(t: HeapTuple, snap: Snapshot, xid: Txid): Visibility {
    if (t.lp !== 'normal') return { visible: false, reason: `行指针为 ${t.lp}` };

    // 1. 插入者可见吗？
    if (t.xmin === xid) {
      if (t.xmax === xid) return { visible: false, reason: '本事务插入后又删除了它' };
      return { visible: true, reason: '本事务自己插入的' };
    }
    if (this.aborted.has(t.xmin)) return { visible: false, reason: `插入事务 ${t.xmin} 已回滚` };
    if (t.xmin >= snap.xmax) return { visible: false, reason: `插入事务 ${t.xmin} 在快照之后开始` };
    if (snap.active.includes(t.xmin)) return { visible: false, reason: `插入事务 ${t.xmin} 快照时仍在进行` };
    if (!this.committed.has(t.xmin)) return { visible: false, reason: `插入事务 ${t.xmin} 尚未提交` };

    // 2. 删除者可见吗？可见 ⇒ 这一版已经死了。
    if (t.xmax === null) return { visible: true, reason: '未被删除' };
    if (t.xmax === xid) return { visible: false, reason: '本事务已删除/更新它' };
    if (this.aborted.has(t.xmax)) return { visible: true, reason: `删除事务 ${t.xmax} 已回滚` };
    if (t.xmax >= snap.xmax) return { visible: true, reason: `删除事务 ${t.xmax} 在快照之后开始` };
    if (snap.active.includes(t.xmax)) return { visible: true, reason: `删除事务 ${t.xmax} 快照时仍在进行` };
    if (!this.committed.has(t.xmax)) return { visible: true, reason: `删除事务 ${t.xmax} 尚未提交` };
    return { visible: false, reason: `已被事务 ${t.xmax} 删除` };
  }

  private checkVisible(tid: Tid, t: HeapTuple, snap: Snapshot, xid: Txid): boolean {
    const v = this.visible(t, snap, xid);
    this.emit({
      type: 'VISIBILITY_CHECK',
      pageId: tid.pageId,
      slot: tid.slot,
      xmin: t.xmin,
      xmax: t.xmax,
      visible: v.visible,
      reason: v.reason,
    });
    return v.visible;
  }

  /** 所有进行中事务里最小的 xid：比它更早被删除的版本，谁都看不见了 ⇒ VACUUM 可以清。 */
  private globalXmin(): Txid {
    const active = [...this.sessions.values()].map((t) => t.xid);
    return active.length === 0 ? this.nextXid : Math.min(...active);
  }

  // ——— DDL ——————————————————————————————————————————————

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    // PostgreSQL 的主键 = 一棵普通的唯一 B 树索引，绝不是「表本身」。
    this.newIndex(PRIMARY_INDEX_ID, `${schema.name}_pkey`, schema.primaryKey, true);
    return `表 ${schema.name} 已创建（堆文件 + 主键索引 ${schema.name}_pkey(${schema.primaryKey})）`;
  }

  private createIndex(name: string, column: string): string {
    this.ensureTable();
    assert(!this.indexes.has(name), `索引 ${name} 已存在`);
    assert(this.schema!.columns.some((c) => c.name === column), `列 ${column} 不存在于表 ${this.schema!.name}`);
    const columnType = this.schema!.columns.find((c) => c.name === column)!.type;
    assert(columnType !== 'varchar', `索引键目前只支持数值列，${column} 是 varchar`);

    const ix = this.newIndex(name, name, column, false);
    // 建索引 = 顺序扫一遍堆，把每个**活着的**版本的 (列值, TID) 灌进树。
    let built = 0;
    for (const pageId of this.heapOrder) {
      const page = this.heapPage(pageId);
      this.access(pageId, 'scan');
      page.tuples.forEach((t, slot) => {
        if (t.lp !== 'normal' || !t.row) return;
        if (this.aborted.has(t.xmin)) return;
        const tid: Tid = { pageId, slot };
        this.emit({ type: 'SCAN_STEP', pageId, slot, key: t.key, row: t.row, emitted: true });
        ix.insert(Number(t.row[column] ?? 0), this.indexEntry(column, Number(t.row[column] ?? 0), tid), 'duplicates');
        built++;
      });
    }
    ix.emitStats();
    return `索引 ${name}(${column}) 创建完成，灌入 ${built} 条索引项（指向 TID，不是主键）`;
  }

  private dropIndex(name: string): string {
    assert(name !== PRIMARY_INDEX_ID, '主键索引不可删除');
    const ix = this.indexes.get(name);
    assert(ix !== undefined, `索引 ${name} 不存在`);
    const freed = ix.dropAllPages();
    this.indexes.delete(name);
    this.uniqueIndexes.delete(name);
    this.emit({ type: 'INDEX_DROP', indexId: name });
    return `索引 ${name} 已删除，回收 ${freed} 个页`;
  }

  private newIndex(id: string, name: string, column: string, unique: boolean): BPlusTree {
    // 树本身必须允许重复键：同一行的每个版本都有自己的索引项（键相同、TID 不同）。
    const tree = new BPlusTree(this, { id, name, column, clustered: false, unique: false });
    this.indexes.set(id, tree);
    if (unique) this.uniqueIndexes.add(id);
    return tree;
  }

  private indexEntry(column: string, value: Key, tid: Tid): Row {
    return { [column]: value, ctid: packTid(tid) };
  }

  // ——— DML ——————————————————————————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.liveTupleCount() + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    let inserted = 0;
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      if (this.upsertOnce(key, makeRow(this.schema!, key)) === 'inserted') inserted++;
    }
    return `批量插入 ${count} 次，新增 ${inserted} 行（${pattern}）`;
  }

  private upsert(key: Key, row: Row): string {
    this.ensureTable();
    const res = this.upsertOnce(key, row);
    if (res === 'inserted') return `插入 key=${key}（新元组，xmin=${this.requireTxn().xid}）`;
    return res === 'hot' ? `更新 key=${key}（HOT：新版本同页，不写索引）` : `更新 key=${key}（新版本 + 全部索引都要写一条）`;
  }

  private upsertOnce(key: Key, row: Row): 'inserted' | 'hot' | 'cold' {
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    const existing = this.findVisibleByKey(key, snap, txn.xid, 'insert');
    if (!existing) {
      this.insertTuple(key, row, txn);
      return 'inserted';
    }
    return this.updateTuple(existing.tid, existing.tuple, row, txn, snap);
  }

  private insertTuple(key: Key, row: Row, txn: Txn): Tid {
    const tid = this.placeTuple(key, row, txn.xid, null);
    // 每个索引都要写一条 (列值, TID)。
    for (const ix of this.indexes.values()) {
      const value = Number(row[ix.column] ?? 0);
      ix.insert(value, this.indexEntry(ix.column, value, tid), 'duplicates');
    }
    txn.writes++;
    return tid;
  }

  /**
   * 更新 = 写一个新版本 + 给旧版本打 xmax。
   *
   * HOT（Heap-Only Tuple）成立的条件：没有改动任何被索引的列，且**同一页**还有空位。
   * 满足时新版本不写任何索引项，索引仍然指向旧版本，读的时候沿 t_ctid 走到新版本。
   */
  private updateTuple(tid: Tid, old: HeapTuple, row: Row, txn: Txn, snap: Snapshot): 'hot' | 'cold' {
    if (old.xmax !== null && !this.aborted.has(old.xmax) && old.xmax !== txn.xid) {
      const owner = old.xmax;
      if (!this.committed.has(owner)) {
        throw new Error(`行 key=${old.key} 正被事务 ${owner} 修改（本仿真不实现行锁等待，直接报冲突 —— 行锁见 Phase 4）`);
      }
      if (txn.isolation === 'repeatable-read' && owner >= snap.xmax) {
        throw new Error(`无法串行化：行 key=${old.key} 已被并发事务 ${owner} 修改（REPEATABLE READ）`);
      }
    }

    const indexedColumns = [...this.indexes.values()].map((ix) => ix.column);
    const changedIndexed = indexedColumns.some((c) => Number(row[c] ?? 0) !== Number(old.row?.[c] ?? 0));
    const samePage = this.heapPage(tid.pageId);
    const hasRoom = this.freeSlotCount(samePage) > 0;
    const hot = this.config.hotUpdate && !changedIndexed && hasRoom;

    const newTid = hot
      ? this.placeTuple(old.key, row, txn.xid, tid.pageId)
      : this.placeTuple(old.key, row, txn.xid, null);

    this.emit({
      type: 'HEAP_SET_XMAX',
      pageId: tid.pageId,
      slot: tid.slot,
      xmax: txn.xid,
      nextTid: { ...newTid },
      hot,
      op: 'update',
    });
    old.xmax = txn.xid;
    old.next = newTid;
    this.heapTuple(newTid).hot = hot;
    this.markHeapDirty(this.heapPage(tid.pageId));

    if (!hot) {
      // 非 HOT：**所有**索引都要插入新条目，哪怕那一列根本没改 —— PostgreSQL 写放大的来源。
      for (const ix of this.indexes.values()) {
        const value = Number(row[ix.column] ?? 0);
        ix.insert(value, this.indexEntry(ix.column, value, newTid), 'duplicates');
      }
    }
    txn.writes++;
    return hot ? 'hot' : 'cold';
  }

  private deleteRow(key: Key): string {
    this.ensureTable();
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    const hit = this.findVisibleByKey(key, snap, txn.xid, 'delete');
    if (!hit) {
      this.emit({ type: 'SEARCH_RESULT', key, found: false, pageId: null, slot: -1 });
      return `key=${key} 不存在（或对本快照不可见）`;
    }
    this.emit({
      type: 'HEAP_SET_XMAX',
      pageId: hit.tid.pageId,
      slot: hit.tid.slot,
      xmax: txn.xid,
      nextTid: null,
      hot: false,
      op: 'delete',
    });
    hit.tuple.xmax = txn.xid;
    this.markHeapDirty(this.heapPage(hit.tid.pageId));
    txn.writes++;
    // 注意：索引项**不会**立刻删除，它还指着这个死元组 —— 要等 VACUUM。
    return `删除 key=${key}（打上 xmax=${txn.xid}，成为死元组，索引项仍然存在，等 VACUUM 清理）`;
  }

  // ——— 堆页管理 ————————————————————————————————————————

  /** 把一个新版本放进堆：优先复用空闲行指针，其次追加，最后才开新页。 */
  private placeTuple(key: Key, row: Row, xmin: Txid, preferPageId: PageId | null): Tid {
    const page = this.pickHeapPage(preferPageId);
    this.access(page.id, 'insert');
    let slot = page.tuples.findIndex((t) => t.lp === 'unused');
    if (slot < 0) slot = page.tuples.length;

    const tuple: HeapTuple = {
      key,
      row: structuredClone(row),
      xmin,
      xmax: null,
      next: null,
      hot: false,
      lp: 'normal',
      redirectTo: null,
    };
    page.tuples[slot] = tuple;
    this.emit({
      type: 'HEAP_INSERT',
      pageId: page.id,
      slot,
      key,
      row: structuredClone(row),
      xmin,
      freeSlots: this.freeSlotCount(page),
    });
    this.markHeapDirty(page);
    this.clearAllVisible(page);
    return { pageId: page.id, slot };
  }

  private pickHeapPage(preferPageId: PageId | null): HeapPage {
    if (preferPageId !== null) {
      const p = this.heapPages.get(preferPageId);
      if (p && this.freeSlotCount(p) > 0) return p;
    }
    for (const id of this.heapOrder) {
      const p = this.heapPage(id);
      if (this.freeSlotCount(p) > 0) return p;
    }
    return this.allocHeapPage();
  }

  private allocHeapPage(): HeapPage {
    const id = this.allocPageId();
    const blockNo = this.nextBlockNo++;
    const page: HeapPage = {
      id,
      blockNo,
      tuples: [],
      dirty: false,
      allVisible: false,
      slots: this.config.heapTuplesPerPage,
    };
    this.heapPages.set(id, page);
    this.heapOrder.push(id);
    this.emit({
      type: 'PAGE_ALLOC',
      pageId: id,
      indexId: HEAP_RELATION_ID,
      pageType: 'heap',
      level: 0,
      parentId: null,
      blockNo,
      slots: page.slots,
    });
    this.access(id, 'maintain');
    return page;
  }

  private freeSlotCount(page: HeapPage): number {
    const used = page.tuples.filter((t) => t.lp !== 'unused').length;
    return Math.max(0, page.slots - used);
  }

  private markHeapDirty(page: HeapPage): void {
    if (page.dirty) return;
    page.dirty = true;
    this.emit({ type: 'PAGE_MARK_DIRTY', pageId: page.id });
  }

  private clearAllVisible(page: HeapPage): void {
    if (!page.allVisible) return;
    page.allVisible = false;
    this.emit({ type: 'VISIBILITY_MAP', pageId: page.id, allVisible: false });
  }

  private heapPage(id: PageId): HeapPage {
    const p = this.heapPages.get(id);
    assert(p !== undefined, `heap page #${id} does not exist`);
    return p;
  }

  private heapTuple(tid: Tid): HeapTuple {
    const t = this.heapPage(tid.pageId).tuples[tid.slot];
    assert(t !== undefined, `heap tuple ${tid.pageId}/${tid.slot} does not exist`);
    return t;
  }

  // ——— 读路径 ————————————————————————————————————————————

  /**
   * 通过主键索引找到某个键当前可见的版本。
   * 这一条路径就把 PostgreSQL 的代价说清楚了：索引下降 → 拿 TID → 回堆 → 判可见性。
   */
  private findVisibleByKey(
    key: Key,
    snap: Snapshot,
    xid: Txid,
    purpose: AccessPurpose,
  ): { tid: Tid; tuple: HeapTuple } | null {
    const pk = this.index(PRIMARY_INDEX_ID);
    const startLeaf = pk.descend(key, purpose);
    let result: { tid: Tid; tuple: HeapTuple } | null = null;
    pk.walkLeaves(startLeaf, (leaf, slot, entryKey, row) => {
      // walkLeaves 从叶子页的第 0 槽开始，而 descend 只保证目标键落在这一页里，
      // 所以要先跳过页内比目标小的键，遇到更大的键才算扫完。
      if (entryKey < key) return 'continue';
      if (entryKey > key) return 'stop';
      const tid = unpackTid(Number(row?.ctid ?? -1));
      if (!tid) return 'continue';
      const hit = this.fetchVisible(pk.id, leaf.id, slot, tid, snap, xid);
      if (hit) {
        result = hit;
        return 'stop';
      }
      return 'continue';
    });
    return result;
  }

  /**
   * 索引项 → 堆的一跳，并沿 redirect / HOT 链找到可见版本。
   */
  private fetchVisible(
    indexId: string,
    fromPageId: PageId,
    fromSlot: number,
    tid: Tid,
    snap: Snapshot,
    xid: Txid,
  ): { tid: Tid; tuple: HeapTuple } | null {
    this.access(tid.pageId, 'search');
    let cursor: Tid | null = tid;
    let steps = 0;
    let found: { tid: Tid; tuple: HeapTuple } | null = null;
    const seen = new Set<string>();

    while (cursor !== null) {
      const guard = `${cursor.pageId}:${cursor.slot}`;
      if (seen.has(guard)) break;
      seen.add(guard);
      const page = this.heapPages.get(cursor.pageId);
      const tuple: HeapTuple | undefined = page?.tuples[cursor.slot];
      if (!tuple) break;
      if (tuple.lp === 'redirect' && tuple.redirectTo !== null) {
        cursor = { pageId: cursor.pageId, slot: tuple.redirectTo };
        steps++;
        continue;
      }
      if (this.checkVisible(cursor, tuple, snap, xid)) {
        found = { tid: { ...cursor }, tuple };
        break;
      }
      // 不可见但被本快照之外的事务更新过 ⇒ 沿 t_ctid 继续找新版本（HOT 链）。
      const next: Tid | null = tuple.next;
      if (next === null) break;
      cursor = { ...next };
      steps++;
    }

    this.emit({
      type: 'HEAP_FETCH',
      indexId,
      fromPageId,
      fromSlot,
      tid: { ...tid },
      found: found !== null,
      chainSteps: steps,
    });
    return found;
  }

  private pointSearch(key: Key): string {
    this.ensureTable();
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const hit = this.findVisibleByKey(key, snap, txn.xid, 'search');
    this.emit({
      type: 'SEARCH_RESULT',
      key,
      found: hit !== null,
      pageId: hit?.tid.pageId ?? null,
      slot: hit?.tid.slot ?? -1,
    });
    return hit ? `命中 key=${key} @ 堆 (${hit.tid.pageId},${hit.tid.slot})` : `未找到 key=${key}`;
  }

  /** 顺序扫描：按块号读堆页，逐个行指针判可见性 —— 完全不碰任何索引。 */
  private seqScan(): string {
    this.ensureTable();
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    this.emit({ type: 'SEARCH_BEGIN', key: 0, mode: 'full' });
    let rows = 0;
    let scanned = 0;
    for (const pageId of this.heapOrder) {
      const page = this.heapPage(pageId);
      this.access(pageId, 'scan');
      for (let slot = 0; slot < page.tuples.length; slot++) {
        const tuple = page.tuples[slot];
        if (!tuple || tuple.lp !== 'normal') continue;
        scanned++;
        const visible = this.checkVisible({ pageId, slot }, tuple, snap, txn.xid);
        this.emit({ type: 'SCAN_STEP', pageId, slot, key: tuple.key, row: tuple.row, emitted: visible });
        if (visible) rows++;
      }
    }
    this.emit({ type: 'SCAN_END', rows, pagesTouched: this.heapOrder.length });
    return `顺序扫描返回 ${rows} 行，读了 ${this.heapOrder.length} 个堆页、判定 ${scanned} 个元组版本`;
  }

  private indexRangeScan(from: Key, to: Key): string {
    this.ensureTable();
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    const pk = this.index(PRIMARY_INDEX_ID);
    this.emit({ type: 'SEARCH_BEGIN', key: from, mode: 'range' });
    let rows = 0;
    const startLeaf = pk.descend(from, 'scan');
    const pending: { pageId: PageId; slot: number; key: Key; tid: Tid }[] = [];
    pk.walkLeaves(startLeaf, (leaf, slot, key, row) => {
      if (key > to) return 'stop';
      if (key < from) return 'continue';
      const tid = unpackTid(Number(row?.ctid ?? -1));
      if (tid) pending.push({ pageId: leaf.id, slot, key, tid });
      return 'continue';
    });
    for (const p of pending) {
      const hit = this.fetchVisible(pk.id, p.pageId, p.slot, p.tid, snap, txn.xid);
      if (hit) {
        this.emit({ type: 'SCAN_STEP', pageId: hit.tid.pageId, slot: hit.tid.slot, key: p.key, row: hit.tuple.row, emitted: true });
        rows++;
      }
    }
    this.emit({ type: 'SCAN_END', rows, pagesTouched: this.heapOrder.length });
    return `索引范围扫描返回 ${rows} 行（走了 ${pending.length} 次索引项 → 堆的跳转）`;
  }

  // ——— 查询：优化器 + 算子 ————————————————————————————

  private runQuery(predicate: Predicate, columns: string[] | '*', hint: string): string {
    this.ensureTable();
    const stats = this.collectStats(predicate);
    for (const s of stats) {
      this.emit({
        type: 'INDEX_STATS',
        indexId: s.indexId,
        entries: s.entries,
        distinct: s.distinct,
        minKey: s.minKey,
        maxKey: s.maxKey,
      });
    }
    const { live, dead } = this.tupleCounts();
    const allVisiblePages = this.heapOrder.filter((id) => this.heapPage(id).allVisible).length;
    const plan = buildHeapPlan({
      table: this.schema!.name,
      primaryKey: this.schema!.primaryKey,
      predicate,
      columns,
      stats,
      heap: {
        pages: this.heapOrder.length,
        liveTuples: live,
        deadTuples: dead,
        allVisibleRatio: this.heapOrder.length === 0 ? 0 : allVisiblePages / this.heapOrder.length,
      },
      hint,
    });
    this.emit({ type: 'PLAN_READY', plan });
    const rows = this.executePlan(plan);
    return `${plan.chosen}；估算 ${plan.root.estRows} 行 / 实际 ${rows} 行`;
  }

  private executePlan(plan: PhysicalPlan): number {
    const txn = this.requireTxn();
    const snap = this.snapshotFor(txn);
    const nodes = collectNodes(plan.root);
    for (const n of nodes) this.emit({ type: 'OPERATOR_OPEN', nodeId: n.id, op: n.op, detail: n.detail });

    const counts = new Map<string, number>();
    const bump = (nodeId: string, key: Key, emitted: boolean) => {
      if (emitted) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      this.emit({ type: 'OPERATOR_ROW', nodeId, key, emitted });
    };

    const seq = nodes.find((n) => n.op === 'SeqScan');
    const idxScan = nodes.find((n) => n.op === 'IndexScan' || n.op === 'IndexOnlyScan');
    const fetch = nodes.find((n) => n.op === 'HeapFetch');
    const filter = nodes.find((n) => n.op === 'Filter');
    const project = nodes.find((n) => n.op === 'Project')!;
    let output = 0;

    if (seq) {
      for (const pageId of this.heapOrder) {
        const page = this.heapPage(pageId);
        this.access(pageId, 'scan');
        for (let slot = 0; slot < page.tuples.length; slot++) {
          const tuple = page.tuples[slot];
          if (!tuple || tuple.lp !== 'normal') continue;
          const ok = this.checkVisible({ pageId, slot }, tuple, snap, txn.xid);
          if (!ok) continue;
          this.emit({ type: 'SCAN_STEP', pageId, slot, key: tuple.key, row: tuple.row, emitted: true });
          bump(seq.id, tuple.key, true);
          const pass = matchesPredicate(plan.predicate, columnValue(tuple.row, plan.predicate));
          if (filter) bump(filter.id, tuple.key, pass);
          if (pass) {
            bump(project.id, tuple.key, true);
            output++;
          }
        }
      }
    } else if (idxScan) {
      const ix = this.index(idxScan.indexId ?? PRIMARY_INDEX_ID);
      const from =
        plan.predicate.kind === 'eq'
          ? plan.predicate.value
          : plan.predicate.kind === 'range'
            ? plan.predicate.from
            : Number.NEGATIVE_INFINITY;
      const to =
        plan.predicate.kind === 'eq'
          ? plan.predicate.value
          : plan.predicate.kind === 'range'
            ? plan.predicate.to
            : Number.POSITIVE_INFINITY;
      const startLeaf = ix.descend(from, 'search');
      const pending: { pageId: PageId; slot: number; key: Key; tid: Tid }[] = [];
      ix.walkLeaves(startLeaf, (leaf, slot, key, row) => {
        if (key > to) return 'stop';
        if (key < from) return 'continue';
        const tid = unpackTid(Number(row?.ctid ?? -1));
        if (!tid) return 'continue';
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot, key, row, emitted: true });
        bump(idxScan.id, key, true);
        pending.push({ pageId: leaf.id, slot, key, tid });
        return 'continue';
      });

      for (const entry of pending) {
        // Index Only Scan：目标页在可见性映射里是 all-visible 就不用回堆。
        const targetPage = this.heapPages.get(entry.tid.pageId);
        const skipHeap = idxScan.op === 'IndexOnlyScan' && targetPage?.allVisible === true;
        if (skipHeap) {
          bump(project.id, entry.key, true);
          output++;
          continue;
        }
        const hit = this.fetchVisible(ix.id, entry.pageId, entry.slot, entry.tid, snap, txn.xid);
        if (fetch) bump(fetch.id, entry.key, hit !== null);
        if (!hit) continue;
        bump(project.id, entry.key, true);
        output++;
      }
    }

    for (const n of [...nodes].reverse()) {
      this.emit({ type: 'OPERATOR_CLOSE', nodeId: n.id, actualRows: counts.get(n.id) ?? 0 });
    }
    return output;
  }

  private collectStats(predicate: Predicate): IndexStats[] {
    const relevant = [...this.indexes.values()].filter(
      (ix) => predicate.kind === 'all' || ix.column === predicate.column,
    );
    return relevant.map((ix) => ({
      indexId: ix.id,
      name: ix.name,
      column: ix.column,
      clustered: false,
      unique: this.uniqueIndexes.has(ix.id),
      height: ix.height,
      leafPages: Math.max(1, ix.leafPageCount()),
      entries: ix.entries,
      distinct: Math.max(1, ix.distinct),
      minKey: ix.minKey,
      maxKey: ix.maxKey,
    }));
  }

  // ——— VACUUM ————————————————————————————————————————————

  /**
   * VACUUM：把「谁都看不见了」的死元组清掉，并同步删除指向它们的索引项。
   *
   * 三种结局，对应 PostgreSQL 的三种行指针状态：
   *  - 普通死元组 → 索引项删掉、行指针置 `unused`，空间可复用；
   *  - HOT 链的**链头**死了但链上还有活版本 → 行指针改成 `redirect`，
   *    索引项照旧指向它，读的时候多跳一步（这就是 HOT 不需要改索引的原因）；
   *  - 死元组的索引项已经先被清掉、但行指针还不能马上复用 → `dead`。
   */
  private vacuum(mode: 'lazy' | 'full'): string {
    this.ensureTable();
    const { dead } = this.tupleCounts();
    this.emit({ type: 'VACUUM_BEGIN', mode, deadTuples: dead });

    const horizon = this.globalXmin();
    let removed = 0;
    let indexEntriesRemoved = 0;
    let pagesFreed = 0;
    const touched: PageId[] = [];

    for (const pageId of [...this.heapOrder]) {
      const page = this.heapPage(pageId);
      this.access(pageId, 'maintain');
      touched.push(pageId);

      const toRemove: number[] = [];
      const toRedirect: number[] = [];

      for (let slot = 0; slot < page.tuples.length; slot++) {
        const t = page.tuples[slot];
        if (!t || t.lp === 'unused') continue;
        if (!this.isDeadForEveryone(t, horizon)) continue;

        // 链头还有活着的后继 ⇒ 改成 redirect，索引项保持有效。
        const liveSuccessor = t.next !== null ? this.liveSuccessor(t.next, horizon) : null;
        if (liveSuccessor && liveSuccessor.pageId === pageId && !t.hot) {
          this.emit({ type: 'LINE_POINTER', pageId, slot, state: 'redirect', redirectTo: liveSuccessor.slot });
          t.lp = 'redirect';
          t.redirectTo = liveSuccessor.slot;
          t.row = null;
          t.next = null;
          toRedirect.push(slot);
          removed++;
          continue;
        }

        // 非 HOT 版本才有自己的索引项，需要一并删除。
        if (!t.hot && t.row) {
          for (const ix of this.indexes.values()) {
            const value = Number(t.row[ix.column] ?? 0);
            if (ix.remove(value, packTid({ pageId, slot })) !== undefined) indexEntriesRemoved++;
          }
        }
        toRemove.push(slot);
        removed++;
      }

      if (toRemove.length === 0 && toRedirect.length === 0) {
        this.maybeMarkAllVisible(page, horizon);
        continue;
      }

      for (const slot of toRemove) {
        page.tuples[slot] = {
          key: Number.NaN,
          row: null,
          xmin: 0,
          xmax: null,
          next: null,
          hot: false,
          lp: 'unused',
          redirectTo: null,
        };
      }
      this.emit({
        type: 'HEAP_PRUNE',
        pageId,
        removed: toRemove,
        redirected: toRedirect,
        // 真实 PostgreSQL 的 VACUUM 分两趟（先删索引项、再回收行指针），
        // 中间那一段行指针处于 `dead` 状态。本仿真一趟做完，所以这里永远是空的。
        deadLinePointers: [],
        freeSlots: this.freeSlotCount(page),
      });
      this.markHeapDirty(page);
      this.maybeMarkAllVisible(page, horizon);
    }

    if (mode === 'full') {
      // VACUUM FULL：把完全空掉的堆页还给操作系统（普通 VACUUM 只在文件末尾才敢截断）。
      for (const pageId of [...this.heapOrder]) {
        const page = this.heapPage(pageId);
        if (page.tuples.some((t) => t.lp !== 'unused')) continue;
        this.heapPages.delete(pageId);
        this.heapOrder = this.heapOrder.filter((id) => id !== pageId);
        this.buffer.forget(pageId);
        this.emit({ type: 'PAGE_FREE', pageId });
        pagesFreed++;
      }
    }

    this.emit({
      type: 'VACUUM_END',
      mode,
      tuplesRemoved: removed,
      indexEntriesRemoved,
      pagesTouched: touched.length,
      pagesFreed,
    });
    return `VACUUM${mode === 'full' ? ' FULL' : ''}：清理 ${removed} 个死元组、${indexEntriesRemoved} 条索引项，回收 ${pagesFreed} 个堆页`;
  }

  /** 该版本是否已经「对所有可能的读者都不可见」。 */
  private isDeadForEveryone(t: HeapTuple, horizon: Txid): boolean {
    if (t.lp !== 'normal') return false;
    if (this.aborted.has(t.xmin)) return true;
    if (t.xmax === null) return false;
    if (this.aborted.has(t.xmax)) return false;
    if (!this.committed.has(t.xmax)) return false;
    return t.xmax < horizon;
  }

  private liveSuccessor(start: Tid, horizon: Txid): Tid | null {
    let cursor: Tid | null = start;
    const seen = new Set<string>();
    while (cursor !== null) {
      const guard = `${cursor.pageId}:${cursor.slot}`;
      if (seen.has(guard)) return null;
      seen.add(guard);
      const t: HeapTuple | undefined = this.heapPages.get(cursor.pageId)?.tuples[cursor.slot];
      if (!t) return null;
      if (!this.isDeadForEveryone(t, horizon) && t.lp === 'normal') return { ...cursor };
      cursor = t.next ? { ...t.next } : null;
    }
    return null;
  }

  /** 页里没有任何死元组、且所有活元组都已提交 ⇒ 可以标 all-visible。 */
  private maybeMarkAllVisible(page: HeapPage, horizon: Txid): void {
    const clean = page.tuples.every(
      (t) => t.lp === 'unused' || (t.lp === 'normal' && t.xmax === null && this.committed.has(t.xmin) && t.xmin < horizon),
    );
    if (!clean || page.allVisible) return;
    page.allVisible = true;
    this.emit({ type: 'VISIBILITY_MAP', pageId: page.id, allVisible: true });
  }

  // ——— 统计 ————————————————————————————————————————————

  private tupleCounts(): { live: number; dead: number } {
    let live = 0;
    let dead = 0;
    const horizon = this.nextXid;
    for (const page of this.heapPages.values()) {
      for (const t of page.tuples) {
        if (t.lp !== 'normal') continue;
        if (this.aborted.has(t.xmin)) {
          dead++;
          continue;
        }
        // 「活」= 最新且未被已提交事务删除。
        if (t.xmax !== null && this.committed.has(t.xmax) && t.xmax <= horizon) dead++;
        else live++;
      }
    }
    return { live, dead };
  }

  private liveTupleCount(): number {
    return this.tupleCounts().live;
  }

  private emitBloat(): void {
    const { live, dead } = this.tupleCounts();
    this.emit({ type: 'BLOAT_STAT', liveTuples: live, deadTuples: dead, heapPages: this.heapOrder.length });
  }

  // ——— 辅助 ————————————————————————————————————————————

  private index(id: string): BPlusTree {
    const ix = this.indexes.get(id);
    assert(ix !== undefined, `索引 ${id} 不存在`);
    return ix;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  // ——— 结构投影 ————————————————————————————————————————

  snapshot(): StructuralSnapshot {
    const pages: StructuralSnapshot['pages'] = {};
    for (const [id, n] of this.nodes) {
      pages[id] = {
        id,
        indexId: n.indexId,
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
    for (const [id, h] of this.heapPages) {
      pages[id] = {
        id,
        indexId: HEAP_RELATION_ID,
        type: 'heap',
        level: 0,
        parentId: null,
        keys: [],
        rows: [],
        children: [],
        prev: null,
        next: null,
        dirty: h.dirty,
        resident: this.buffer.residentPages().includes(id),
        heap: {
          blockNo: h.blockNo,
          slots: h.slots,
          freeSlots: this.freeSlotCount(h),
          allVisible: h.allVisible,
          tuples: h.tuples.map((t, slot) => ({
            slot,
            key: t.key,
            row: structuredClone(t.row),
            xmin: t.xmin,
            xmax: t.xmax,
            next: t.next ? { ...t.next } : null,
            hot: t.hot,
            lp: t.lp,
            redirectTo: t.redirectTo,
          })),
        },
      };
    }
    const indexes: StructuralSnapshot['indexes'] = {};
    for (const [id, ix] of this.indexes) indexes[id] = ix.toStructuralIndex();
    return {
      indexes,
      recordCount: this.liveTupleCount(),
      pages,
      bufferFrames: this.buffer.snapshotFrames(),
      bufferRecency: this.buffer.snapshotRecency(),
    };
  }

  /** 仅供测试：当前所有可见行的主键（用默认快照，即「所有已提交事务的视角」）。 */
  visibleKeys(): Key[] {
    const snap: Snapshot = { xmin: this.nextXid, xmax: this.nextXid, active: [] };
    const out: Key[] = [];
    for (const pageId of this.heapOrder) {
      const page = this.heapPage(pageId);
      page.tuples.forEach((t) => {
        if (t.lp !== 'normal') return;
        if (this.visible(t, snap, -1).visible) out.push(t.key);
      });
    }
    return out.sort((a, b) => a - b);
  }

  /** 仅供测试：某个键在堆里的全部版本。 */
  versionsOf(key: Key): { tid: Tid; xmin: Txid; xmax: Txid | null; hot: boolean; lp: LinePointerState }[] {
    const out: { tid: Tid; xmin: Txid; xmax: Txid | null; hot: boolean; lp: LinePointerState }[] = [];
    for (const pageId of this.heapOrder) {
      this.heapPage(pageId).tuples.forEach((t, slot) => {
        if (t.key === key && t.lp !== 'unused') {
          out.push({ tid: { pageId, slot }, xmin: t.xmin, xmax: t.xmax, hot: t.hot, lp: t.lp });
        }
      });
    }
    return out;
  }
}

/** 堆文件在事件里的「索引 id」——它不是索引，但页需要一个归属标签。 */
export const HEAP_RELATION_ID = 'HEAP';

function unpackTid(packed: number): Tid | null {
  if (!Number.isFinite(packed) || packed < 0) return null;
  return { pageId: Math.floor(packed / 4096), slot: packed % 4096 };
}

function columnValue(row: Row | null, predicate: Predicate): Key | undefined {
  if (predicate.kind === 'all' || !row) return undefined;
  const v = row[predicate.column];
  return typeof v === 'number' ? v : undefined;
}

function collectNodes(root: PlanNode): PlanNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function sessionOf(sessions: Map<string, Txn>, txn: Txn): string | undefined {
  for (const [name, t] of sessions) if (t === txn) return name;
  return undefined;
}
