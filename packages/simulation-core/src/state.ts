import {
  INTERNAL_ENTRY_BYTES,
  PAGE_HEADER_BYTES,
  estimateRecordBytes,
  type IsolationLevel,
  type Key,
  type LinePointerState,
  type PageId,
  type PageType,
  type Row,
  type TableSchema,
  type Tid,
  type Txid,
} from '@dbkl/shared';
import type { SimulationEvent } from './events';
import { DEFAULT_ENGINE_CONFIG, PRIMARY_INDEX_ID, type EngineConfig } from './engine/types';
import type { PhysicalPlan } from './query/types';

/**
 * LabState —— 事件归约出的可视化状态。
 *
 * 它必须满足：
 *  - 纯数据（structuredClone 安全），因为 HistoryManager 要对它做检查点快照；
 *  - 完全由 applyEvent 从事件流推导，任何字段都不允许由 UI 猜测或旁路写入。
 */

export interface PageState {
  id: PageId;
  /** 所属索引 id（'PRIMARY' 为聚簇索引）。 */
  indexId: string;
  type: PageType;
  /** 叶子 = 0，向上递增。 */
  level: number;
  parentId: PageId | null;
  /** 叶子页：记录键；内部页：分隔键（长度 = children.length - 1）。 */
  keys: Key[];
  /** 叶子页有效，与 keys 对齐。 */
  rows: (Row | null)[];
  /** 内部页有效。 */
  children: PageId[];
  prev: PageId | null;
  next: PageId | null;
  dirty: boolean;
  /** 是否驻留在 Buffer Pool 中。 */
  resident: boolean;
  frame: number | null;
  /** 最近一次修改对应的事件序号（可当作简化 LSN）。 */
  lsn: number;
  createdAtSeq: number;
  lastTouchedSeq: number;
  /** 堆页专用内容（PostgreSQL 引擎），B+ 树页为 undefined。 */
  heap?: HeapPageState;
}

/**
 * 堆表里的一个元组版本。
 *
 * `xmin` / `xmax` 就是 PostgreSQL 的元组头：谁插入的、谁删除的。
 * `next` 是 t_ctid，指向该行的**下一个版本**，一串版本就是版本链。
 */
export interface HeapTupleState {
  slot: number;
  key: Key;
  row: Row | null;
  xmin: Txid;
  xmax: Txid | null;
  /** t_ctid：指向新版本；为 null 表示这是链尾（最新版本）。 */
  next: Tid | null;
  /** 是否由 HOT 更新产生（HOT 版本没有自己的索引项）。 */
  hot: boolean;
  /** 行指针状态。 */
  lp: LinePointerState;
  /** `lp === 'redirect'` 时指向的槽位。 */
  redirectTo: number | null;
}

/** 堆页：一个行指针数组 + 若干元组版本，没有任何顺序保证。 */
export interface HeapPageState {
  blockNo: number;
  /** 下标即行指针编号（PostgreSQL 的 OffsetNumber - 1）。 */
  tuples: HeapTupleState[];
  /** 还能放几个新版本（对应 FSM 里的空闲空间）。 */
  freeSlots: number;
  slots: number;
  /** 可见性映射位：该页所有元组对所有事务都可见，Index Only Scan 可跳过回堆。 */
  allVisible: boolean;
}

/** 优化器看到的统计信息快照（可能是过期的）。 */
export interface IndexStatsState {
  entries: number;
  distinct: number;
  minKey: Key | null;
  maxKey: Key | null;
  /** 采集这份统计信息时的事件序号。 */
  atSeq: number;
}

export interface IndexState {
  id: string;
  name: string;
  column: string;
  clustered: boolean;
  unique: boolean;
  rootId: PageId | null;
  firstLeafId: PageId | null;
  height: number;
  /** 实时条目数（由记录事件维护）。 */
  entries: number;
  /** 最近一次 ANALYZE 的结果，可能落后于 entries。 */
  stats: IndexStatsState | null;
}

export interface BufferState {
  frames: (PageId | null)[];
  /** LRU 栈：下标 0 为最近使用，末尾为最久未使用。 */
  recency: PageId[];
  /** CLOCK 策略的引用位。 */
  refBits: Record<PageId, boolean>;
  clockHand: number;
}

export interface Metrics {
  logicalReads: number;
  bufferHits: number;
  bufferMisses: number;
  evictions: number;
  flushes: number;
  pageAllocs: number;
  pageFrees: number;
  leafSplits: number;
  internalSplits: number;
  merges: number;
  redistributes: number;
  rootChanges: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsDeleted: number;
  separatorWrites: number;
  scanRows: number;
  /** 回表次数：二级索引查询的主要成本来源。 */
  lookups: number;

  // —— Phase 2：堆表 / MVCC ——
  /** 索引项 → 堆元组的取行次数（PostgreSQL 里任何索引扫描都要付这笔钱）。 */
  heapFetches: number;
  /** 写入的元组版本总数（UPDATE 会写新版本，因此 > 行数）。 */
  versionsWritten: number;
  hotUpdates: number;
  coldUpdates: number;
  /** 可见性判定次数。 */
  visibilityChecks: number;
  vacuumedTuples: number;

  // —— Phase 3：LSM ——
  memtableWrites: number;
  memtableFlushes: number;
  compactions: number;
  /** 实际读过的 SST 数（读放大）。 */
  sstReads: number;
  /** 被布隆过滤器挡掉、免于读取的 SST 数。 */
  bloomSkips: number;
  /** 落盘的条目总数（含压实重写），与 memtableWrites 之比即写放大。 */
  entriesWritten: number;
  walBytes: number;
}

export interface ActiveCommand {
  cmd: number;
  kind: string;
  label: string;
  running: boolean;
}

export interface SearchResultState {
  key: Key;
  found: boolean;
  pageId: PageId | null;
  slot: number;
}

/** 一次回表连线：二级索引叶子 → 聚簇索引叶子。 */
export interface LookupLink {
  indexId: string;
  fromPageId: PageId;
  fromSlot: number;
  toPageId: PageId | null;
  toSlot: number;
  indexKey: Key;
  primaryKey: Key;
  done: boolean;
}

// ——— Phase 2：事务 / MVCC ————————————————————————————————

export interface SnapshotState {
  xmin: Txid;
  xmax: Txid;
  active: Txid[];
  scope: 'statement' | 'transaction';
}

export interface TxnState {
  xid: Txid;
  isolation: IsolationLevel;
  implicit: boolean;
  writes: number;
  status: 'running' | 'committed' | 'aborted';
}

export interface VisibilityProbe {
  pageId: PageId;
  slot: number;
  xmin: Txid;
  xmax: Txid | null;
  visible: boolean;
  reason: string;
}

/** 索引项 → 堆元组的一跳，3D 里画成一条跨结构的连线。 */
export interface HeapFetchLink {
  indexId: string;
  fromPageId: PageId;
  fromSlot: number;
  tid: Tid;
  found: boolean;
  chainSteps: number;
}

export interface MvccState {
  /** 当前正在执行的事务（隐式事务也会出现在这里）。 */
  current: TxnState | null;
  /** 最近若干个事务的结局，供事务面板展示。 */
  recent: TxnState[];
  snapshot: SnapshotState | null;
  /** 最近一次查询的可见性判定轨迹（上限 40 条）。 */
  probes: VisibilityProbe[];
  liveTuples: number;
  deadTuples: number;
  heapPages: number;
  hotUpdates: number;
  coldUpdates: number;
  vacuums: number;
  lastVacuum: {
    mode: 'lazy' | 'full';
    tuplesRemoved: number;
    indexEntriesRemoved: number;
    pagesFreed: number;
  } | null;
  fetch: HeapFetchLink | null;
  /** 最近一次沿 t_ctid 走过的版本链。 */
  chain: Tid[];
}

// ——— Phase 3：LSM-Tree ————————————————————————————————

export interface SstEntryState {
  key: Key;
  row: Row | null;
  tombstone: boolean;
}

export interface SstState {
  id: string;
  level: number;
  entries: SstEntryState[];
  minKey: Key;
  maxKey: Key;
  bytes: number;
  source: 'flush' | 'compaction';
  createdAtSeq: number;
  /** 正在被压实（3D 里闪烁提示）。 */
  compacting: boolean;
}

/** 一个 WAL 段：生命周期与一个 MemTable 绑定，那份数据落成 SST 后它就被回收。 */
export interface WalSegmentState {
  id: string;
  records: { lsn: number; op: 'put' | 'delete'; key: Key }[];
  bytes: number;
  sealed: boolean;
  /** 封口时绑定的 MemTable id；未封口为 null。 */
  memtableId: string | null;
}

/** 后台任务：刷写或压实。排在队列里的长度就是「压实债务」。 */
export interface BgJobState {
  id: number;
  kind: 'flush' | 'compaction';
  level: number;
  reason: string;
  scheduledAtSeq: number;
}

export interface LsmProbe {
  sstId: string;
  level: number;
  kind: 'bloom-skip' | 'bloom-maybe' | 'read';
  found: boolean;
  falsePositive: boolean;
}

export interface LsmState {
  memtable: { entries: SstEntryState[]; limit: number };
  /** 已冻结、等待刷盘的 MemTable。后台跟不上时这里会排队，里面的数据依然读得到。 */
  immutable: { id: string; entries: SstEntryState[] }[];
  ssts: Record<string, SstState>;
  /** levels[i] = 第 i 层的 SST id，按键区间升序（L0 例外：按新旧排列）。 */
  levels: string[][];
  /**
   * 预写日志。`segments` 里是**当前仍需保留**的段 —— 对应数据一旦落成 SST 就会被回收，
   * 所以它的长度直接回答了「崩溃的话要重放多少」。
   */
  wal: {
    segments: WalSegmentState[];
    records: number;
    bytes: number;
    lsn: number;
    truncatedRecords: number;
    truncatedBytes: number;
  };
  /** 后台任务队列（刷写 / 压实）。 */
  bgQueue: BgJobState[];
  /** 历史最大积压深度。 */
  maxQueueDepth: number;
  stalls: number;
  lastStall: {
    reason: 'immutable-full' | 'l0-stop';
    l0Files: number;
    immutableTables: number;
    queueDepth: number;
    note: string;
  } | null;
  crashes: number;
  lastRecovery: { replayedRecords: number; restoredKeys: number; flushedToSst: string | null } | null;
  /** 最近一次读取的探测轨迹。 */
  probes: LsmProbe[];
  lastGet: {
    key: Key;
    found: boolean;
    row: Row | null;
    source: 'memtable' | 'immutable' | 'sst' | 'miss';
    sstId: string | null;
    probes: number;
    bloomSkips: number;
  } | null;
  activeCompaction: { level: number; targetLevel: number; inputs: string[] } | null;
  flushes: number;
  compactions: number;
  droppedEntries: number;
  /** 写放大：用户写入的条目数 vs 实际落盘的条目数。 */
  userWrites: number;
  entriesWritten: number;
}

export interface OperatorStat {
  nodeId: string;
  op: string;
  detail: string;
  rows: number;
  filtered: number;
  running: boolean;
  finished: boolean;
}

export interface LabState {
  config: EngineConfig;
  schema: TableSchema | null;
  pages: Record<PageId, PageState>;
  /** 所有索引（含聚簇索引）。 */
  indexes: Record<string, IndexState>;
  /** 聚簇索引里的行数。 */
  recordCount: number;
  buffer: BufferState;
  metrics: Metrics;
  /** 当前查找/插入的下降路径（从根到叶），用于黄色高亮。 */
  path: PageId[];
  /** 当前操作聚焦的键。 */
  focusKey: Key | null;
  /** 最近一次被写入/命中的 (页, 槽)。 */
  focusPageId: PageId | null;
  focusSlot: number;
  lastResult: SearchResultState | null;
  /** 当前扫描已产出的键（上限 200，避免快照膨胀）。 */
  scanOutput: Key[];
  activeCommand: ActiveCommand | null;
  /** 当前查询的物理执行计划。 */
  plan: PhysicalPlan | null;
  /** 计划各算子的运行时统计（估算 vs 实际）。 */
  operators: Record<string, OperatorStat>;
  /** 最近一次回表连线，用于 3D 中画出跨树跳转。 */
  lookup: LookupLink | null;
  /** PostgreSQL 引擎的事务 / MVCC 状态；其它引擎为 null。 */
  mvcc: MvccState | null;
  /** LSM 引擎的 MemTable / SST 层级状态；其它引擎为 null。 */
  lsm: LsmState | null;
  /** 最近一次结构性事件的序号，供可视化触发一次性动画。 */
  lastStructuralSeq: number;
  appliedSeq: number;
}

export function createInitialState(config: EngineConfig = DEFAULT_ENGINE_CONFIG): LabState {
  return {
    config: { ...config },
    schema: null,
    pages: {},
    indexes: {},
    recordCount: 0,
    buffer: {
      frames: new Array<PageId | null>(config.bufferPoolFrames).fill(null),
      recency: [],
      refBits: {},
      clockHand: 0,
    },
    metrics: createMetrics(),
    path: [],
    focusKey: null,
    focusPageId: null,
    focusSlot: -1,
    lastResult: null,
    scanOutput: [],
    activeCommand: null,
    plan: null,
    operators: {},
    lookup: null,
    mvcc: null,
    lsm: null,
    lastStructuralSeq: -1,
    appliedSeq: -1,
  };
}

export function createMvccState(): MvccState {
  return {
    current: null,
    recent: [],
    snapshot: null,
    probes: [],
    liveTuples: 0,
    deadTuples: 0,
    heapPages: 0,
    hotUpdates: 0,
    coldUpdates: 0,
    vacuums: 0,
    lastVacuum: null,
    fetch: null,
    chain: [],
  };
}

export function createLsmState(limit: number): LsmState {
  return {
    memtable: { entries: [], limit },
    immutable: [],
    ssts: {},
    levels: [],
    wal: { segments: [], records: 0, bytes: 0, lsn: 0, truncatedRecords: 0, truncatedBytes: 0 },
    bgQueue: [],
    maxQueueDepth: 0,
    stalls: 0,
    lastStall: null,
    crashes: 0,
    lastRecovery: null,
    probes: [],
    lastGet: null,
    activeCompaction: null,
    flushes: 0,
    compactions: 0,
    droppedEntries: 0,
    userWrites: 0,
    entriesWritten: 0,
  };
}

export function createMetrics(): Metrics {
  return {
    logicalReads: 0,
    bufferHits: 0,
    bufferMisses: 0,
    evictions: 0,
    flushes: 0,
    pageAllocs: 0,
    pageFrees: 0,
    leafSplits: 0,
    internalSplits: 0,
    merges: 0,
    redistributes: 0,
    rootChanges: 0,
    recordsInserted: 0,
    recordsUpdated: 0,
    recordsDeleted: 0,
    separatorWrites: 0,
    scanRows: 0,
    lookups: 0,
    heapFetches: 0,
    versionsWritten: 0,
    hotUpdates: 0,
    coldUpdates: 0,
    visibilityChecks: 0,
    vacuumedTuples: 0,
    memtableWrites: 0,
    memtableFlushes: 0,
    compactions: 0,
    sstReads: 0,
    bloomSkips: 0,
    entriesWritten: 0,
    walBytes: 0,
  };
}

export function cloneState(state: LabState): LabState {
  return structuredClone(state);
}

const MAX_SCAN_OUTPUT = 200;
const MAX_TXN_HISTORY = 12;
const MAX_VISIBILITY_PROBES = 40;
const MAX_LSM_PROBES = 40;

/** MVCC 子状态是懒创建的：只有产生过事务/堆表事件的引擎才有它。 */
function mvcc(state: LabState): MvccState {
  if (!state.mvcc) state.mvcc = createMvccState();
  return state.mvcc;
}

function lsm(state: LabState): LsmState {
  if (!state.lsm) state.lsm = createLsmState(state.config.memtableLimit);
  return state.lsm;
}

function heapOf(p: PageState): HeapPageState {
  if (!p.heap) p.heap = { blockNo: 0, tuples: [], freeSlots: 0, slots: 0, allVisible: false };
  return p.heap;
}

function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function insertSorted(entries: SstEntryState[], entry: SstEntryState): void {
  const at = entries.findIndex((x) => x.key > entry.key);
  if (at < 0) entries.push(entry);
  else entries.splice(at, 0, entry);
}

function page(state: LabState, id: PageId): PageState {
  const p = state.pages[id];
  if (!p) throw new Error(`[dbkl] reducer: unknown page #${id} (seq ${state.appliedSeq})`);
  return p;
}

function touch(state: LabState, id: PageId, seq: number): PageState {
  const p = page(state, id);
  p.lastTouchedSeq = seq;
  return p;
}

/** 页所属索引的可变引用（页可能已被回收，故可能为 undefined）。 */
function indexOf(state: LabState, pageId: PageId): IndexState | undefined {
  const p = state.pages[pageId];
  return p ? state.indexes[p.indexId] : undefined;
}

/**
 * 把一个事件归约进状态（原地修改）。
 *
 * 该函数必须是纯的（相同 state + 相同事件 ⇒ 相同结果），不得访问外部可变量、
 * 时间或随机数，否则时间旅行与检查点重放会漂移。
 */
export function applyEvent(state: LabState, e: SimulationEvent): LabState {
  state.appliedSeq = e.seq;
  const m = state.metrics;

  switch (e.type) {
    case 'COMMAND_BEGIN': {
      state.activeCommand = { cmd: e.cmd, kind: e.kind, label: e.label, running: true };
      state.path = [];
      state.focusKey = null;
      state.focusPageId = null;
      state.focusSlot = -1;
      state.scanOutput = [];
      state.lastResult = null;
      state.lookup = null;
      if (state.mvcc) {
        state.mvcc.probes = [];
        state.mvcc.fetch = null;
        state.mvcc.chain = [];
      }
      if (state.lsm) {
        state.lsm.probes = [];
      }
      if (e.kind === 'query') {
        state.plan = null;
        state.operators = {};
      }
      break;
    }
    case 'COMMAND_END': {
      state.activeCommand = { cmd: e.cmd, kind: e.kind, label: e.label, running: false };
      break;
    }
    case 'NOTE':
      break;

    case 'CONFIG_SET': {
      state.config = { ...e.config };
      if (state.buffer.frames.length !== e.config.bufferPoolFrames) {
        state.buffer.frames = new Array<PageId | null>(e.config.bufferPoolFrames).fill(null);
        state.buffer.recency = [];
        state.buffer.refBits = {};
        state.buffer.clockHand = 0;
      }
      if (state.lsm) state.lsm.memtable.limit = e.config.memtableLimit;
      break;
    }
    case 'TABLE_CREATE': {
      state.schema = structuredClone(e.schema);
      break;
    }
    case 'INDEX_CREATE': {
      state.indexes[e.indexId] = {
        id: e.indexId,
        name: e.name,
        column: e.column,
        clustered: e.clustered,
        unique: e.unique,
        rootId: null,
        firstLeafId: null,
        height: 0,
        entries: 0,
        stats: null,
      };
      break;
    }
    case 'INDEX_DROP': {
      delete state.indexes[e.indexId];
      break;
    }
    case 'INDEX_STATS': {
      const ix = state.indexes[e.indexId];
      if (ix) {
        ix.stats = { entries: e.entries, distinct: e.distinct, minKey: e.minKey, maxKey: e.maxKey, atSeq: e.seq };
      }
      break;
    }

    case 'PAGE_ALLOC': {
      state.pages[e.pageId] = {
        id: e.pageId,
        indexId: e.indexId,
        type: e.pageType,
        level: e.level,
        parentId: e.parentId,
        keys: e.init?.keys?.slice() ?? [],
        rows: [],
        children: e.init?.children?.slice() ?? [],
        prev: null,
        next: null,
        dirty: false,
        resident: false,
        frame: null,
        lsn: e.seq,
        createdAtSeq: e.seq,
        lastTouchedSeq: e.seq,
        heap:
          e.pageType === 'heap'
            ? {
                blockNo: e.blockNo ?? 0,
                tuples: [],
                freeSlots: e.slots ?? 0,
                slots: e.slots ?? 0,
                allVisible: false,
              }
            : undefined,
      };
      if (e.pageType === 'heap' && state.mvcc) state.mvcc.heapPages++;
      m.pageAllocs++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'PAGE_FREE': {
      const p = state.pages[e.pageId];
      if (p) {
        const ix = state.indexes[p.indexId];
        if (ix && ix.firstLeafId === e.pageId) ix.firstLeafId = p.next;
        if (p.type === 'heap' && state.mvcc) state.mvcc.heapPages--;
        delete state.pages[e.pageId];
      }
      releaseFrame(state, e.pageId);
      m.pageFrees++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'PARENT_SET': {
      const p = state.pages[e.pageId];
      if (p) p.parentId = e.parentId;
      break;
    }
    case 'ROOT_CHANGE': {
      const ix = state.indexes[e.indexId];
      if (ix) {
        ix.rootId = e.newRootId;
        ix.height = e.height;
        const p = state.pages[e.newRootId];
        if (p) p.parentId = null;
        if (ix.firstLeafId === null && p && p.type === 'leaf') ix.firstLeafId = e.newRootId;
      }
      m.rootChanges++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'LEAF_LINK': {
      const p = touch(state, e.pageId, e.seq);
      p.prev = e.prev;
      p.next = e.next;
      const ix = state.indexes[p.indexId];
      if (ix && e.prev === null && p.type === 'leaf') ix.firstLeafId = e.pageId;
      break;
    }

    case 'DESCEND': {
      // 每次下降都从某棵树的根页开始：看到根页的 DESCEND 就重置路径，
      // 否则批量插入会把成百上千次下降拼成一条无意义的长路径。
      const ix = indexOf(state, e.pageId);
      if (ix && ix.rootId === e.pageId) {
        state.path = [e.pageId];
      } else if (state.path.length === 0 || state.path[state.path.length - 1] !== e.pageId) {
        state.path.push(e.pageId);
      }
      state.path.push(e.childId);
      state.focusKey = e.key;
      break;
    }
    case 'PAGE_READ': {
      touch(state, e.pageId, e.seq);
      m.logicalReads++;
      break;
    }

    case 'RECORD_INSERT': {
      const p = touch(state, e.pageId, e.seq);
      p.keys.splice(e.slot, 0, e.key);
      p.rows.splice(e.slot, 0, e.row);
      p.lsn = e.seq;
      const ix = state.indexes[p.indexId];
      if (ix) {
        ix.entries++;
        if (ix.clustered) state.recordCount++;
      }
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      state.focusKey = e.key;
      m.recordsInserted++;
      break;
    }
    case 'RECORD_UPDATE': {
      const p = touch(state, e.pageId, e.seq);
      p.rows[e.slot] = e.row;
      p.lsn = e.seq;
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      state.focusKey = e.key;
      m.recordsUpdated++;
      break;
    }
    case 'RECORD_DELETE': {
      const p = touch(state, e.pageId, e.seq);
      p.keys.splice(e.slot, 1);
      p.rows.splice(e.slot, 1);
      p.lsn = e.seq;
      const ix = state.indexes[p.indexId];
      if (ix) {
        ix.entries--;
        if (ix.clustered) state.recordCount--;
      }
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      state.focusKey = e.key;
      m.recordsDeleted++;
      break;
    }

    case 'SEPARATOR_INSERT': {
      const p = touch(state, e.pageId, e.seq);
      // slot 表示分隔键下标；对应的子指针落在 slot + 1（右子）。
      p.keys.splice(e.slot, 0, e.key);
      p.children.splice(e.slot + 1, 0, e.childId);
      p.lsn = e.seq;
      m.separatorWrites++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'SEPARATOR_DELETE': {
      const p = touch(state, e.pageId, e.seq);
      p.keys.splice(e.slot, 1);
      p.children.splice(e.slot + 1, 1);
      p.lsn = e.seq;
      m.separatorWrites++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'SEPARATOR_UPDATE': {
      const p = touch(state, e.pageId, e.seq);
      p.keys[e.slot] = e.key;
      p.lsn = e.seq;
      m.separatorWrites++;
      break;
    }

    case 'PAGE_SPLIT': {
      const left = touch(state, e.pageId, e.seq);
      const right = touch(state, e.newPageId, e.seq);
      const n = e.moved.keys.length;
      if (e.pageType === 'leaf') {
        left.keys.splice(left.keys.length - n, n);
        left.rows.splice(left.rows.length - n, n);
        right.keys = e.moved.keys.slice();
        right.rows = (e.moved.rows ?? e.moved.keys.map(() => null)).slice();
        m.leafSplits++;
      } else {
        // 内部页分裂：上浮键从左页移除，不落在任何一侧。
        const movedChildren = e.moved.children ?? [];
        left.keys.splice(left.keys.length - n - 1, n + 1);
        left.children.splice(left.children.length - movedChildren.length, movedChildren.length);
        right.keys = e.moved.keys.slice();
        right.children = movedChildren.slice();
        m.internalSplits++;
      }
      left.lsn = e.seq;
      right.lsn = e.seq;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'PAGE_MERGE': {
      const keep = touch(state, e.pageId, e.seq);
      const n = e.moved.keys.length;
      if (e.pageType === 'leaf') {
        keep.keys.push(...e.moved.keys);
        keep.rows.push(...(e.moved.rows ?? new Array<Row | null>(n).fill(null)));
      } else {
        keep.keys.push(e.separatorKey, ...e.moved.keys);
        keep.children.push(...(e.moved.children ?? []));
      }
      keep.lsn = e.seq;
      m.merges++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'REDISTRIBUTE': {
      const from = touch(state, e.fromPageId, e.seq);
      const to = touch(state, e.toPageId, e.seq);
      const parent = touch(state, e.parentId, e.seq);
      const n = e.moved.keys.length;
      if (e.pageType === 'leaf') {
        const rows = e.moved.rows ?? new Array<Row | null>(n).fill(null);
        if (e.direction === 'left-to-right') {
          from.keys.splice(from.keys.length - n, n);
          from.rows.splice(from.rows.length - n, n);
          to.keys.unshift(...e.moved.keys);
          to.rows.unshift(...rows);
        } else {
          from.keys.splice(0, n);
          from.rows.splice(0, n);
          to.keys.push(...e.moved.keys);
          to.rows.push(...rows);
        }
      } else {
        const children = e.moved.children ?? [];
        if (e.direction === 'left-to-right') {
          // 左兄弟的末尾 child 上移做新分隔键，旧分隔键下沉到右页首位。
          from.children.splice(from.children.length - children.length, children.length);
          from.keys.splice(from.keys.length - n, n);
          to.children.unshift(...children);
          to.keys.unshift(e.oldSeparatorKey);
        } else {
          from.children.splice(0, children.length);
          from.keys.splice(0, n);
          to.children.push(...children);
          to.keys.push(e.oldSeparatorKey);
        }
      }
      parent.keys[e.parentSlot] = e.newSeparatorKey;
      from.lsn = e.seq;
      to.lsn = e.seq;
      parent.lsn = e.seq;
      m.redistributes++;
      state.lastStructuralSeq = e.seq;
      break;
    }

    case 'BUFFER_HIT': {
      const p = state.pages[e.pageId];
      if (p) {
        p.resident = true;
        p.frame = e.frame;
      }
      state.buffer.frames[e.frame] = e.pageId;
      state.buffer.refBits[e.pageId] = true;
      state.buffer.clockHand = (e.frame + 1) % Math.max(1, state.buffer.frames.length);
      bumpRecency(state, e.pageId);
      m.bufferHits++;
      break;
    }
    case 'BUFFER_MISS': {
      const p = state.pages[e.pageId];
      if (p) {
        p.resident = true;
        p.frame = e.frame;
      }
      state.buffer.frames[e.frame] = e.pageId;
      state.buffer.refBits[e.pageId] = true;
      state.buffer.clockHand = (e.frame + 1) % Math.max(1, state.buffer.frames.length);
      bumpRecency(state, e.pageId);
      m.bufferMisses++;
      break;
    }
    case 'BUFFER_EVICT': {
      const p = state.pages[e.pageId];
      if (p) {
        p.resident = false;
        p.frame = null;
        if (e.wasDirty) p.dirty = false;
      }
      state.buffer.frames[e.frame] = null;
      delete state.buffer.refBits[e.pageId];
      state.buffer.recency = state.buffer.recency.filter((id) => id !== e.pageId);
      m.evictions++;
      break;
    }
    case 'PAGE_MARK_DIRTY': {
      const p = state.pages[e.pageId];
      if (p) p.dirty = true;
      break;
    }
    case 'PAGE_FLUSH': {
      const p = state.pages[e.pageId];
      if (p) p.dirty = false;
      m.flushes++;
      break;
    }

    case 'SEARCH_BEGIN': {
      state.path = [];
      state.focusKey = e.key;
      state.lastResult = null;
      state.scanOutput = [];
      break;
    }
    case 'SEARCH_RESULT': {
      state.lastResult = { key: e.key, found: e.found, pageId: e.pageId, slot: e.slot };
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      break;
    }
    case 'SCAN_STEP': {
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      state.focusKey = e.key;
      if (e.emitted) {
        if (state.scanOutput.length < MAX_SCAN_OUTPUT) state.scanOutput.push(e.key);
        m.scanRows++;
      }
      break;
    }
    case 'SCAN_END':
      break;

    case 'LOOKUP_BACK': {
      state.lookup = {
        indexId: e.indexId,
        fromPageId: e.fromPageId,
        fromSlot: e.fromSlot,
        toPageId: null,
        toSlot: -1,
        indexKey: e.indexKey,
        primaryKey: e.primaryKey,
        done: false,
      };
      m.lookups++;
      break;
    }
    case 'LOOKUP_DONE': {
      if (state.lookup && state.lookup.fromPageId === e.fromPageId) {
        state.lookup.toPageId = e.toPageId;
        state.lookup.toSlot = e.slot;
        state.lookup.done = true;
      }
      break;
    }

    case 'PLAN_READY': {
      state.plan = structuredClone(e.plan);
      state.operators = {};
      break;
    }
    case 'OPERATOR_OPEN': {
      state.operators[e.nodeId] = {
        nodeId: e.nodeId,
        op: e.op,
        detail: e.detail,
        rows: 0,
        filtered: 0,
        running: true,
        finished: false,
      };
      break;
    }
    case 'OPERATOR_ROW': {
      const stat = state.operators[e.nodeId];
      if (stat) {
        if (e.emitted) stat.rows++;
        else stat.filtered++;
      }
      break;
    }
    case 'OPERATOR_CLOSE': {
      const stat = state.operators[e.nodeId];
      if (stat) {
        stat.running = false;
        stat.finished = true;
        stat.rows = e.actualRows;
      }
      break;
    }

    // ══ Phase 2：事务 / MVCC ═══════════════════════════════
    case 'TXN_BEGIN': {
      const mv = mvcc(state);
      mv.current = { xid: e.xid, isolation: e.isolation, implicit: e.implicit, writes: 0, status: 'running' };
      break;
    }
    case 'TXN_COMMIT': {
      const mv = mvcc(state);
      const txn: TxnState = {
        xid: e.xid,
        isolation: mv.current?.isolation ?? 'read-committed',
        implicit: mv.current?.implicit ?? true,
        writes: e.writes,
        status: 'committed',
      };
      pushCapped(mv.recent, txn, MAX_TXN_HISTORY);
      mv.current = null;
      mv.snapshot = null;
      break;
    }
    case 'TXN_ABORT': {
      const mv = mvcc(state);
      const txn: TxnState = {
        xid: e.xid,
        isolation: mv.current?.isolation ?? 'read-committed',
        implicit: mv.current?.implicit ?? true,
        writes: e.writes,
        status: 'aborted',
      };
      pushCapped(mv.recent, txn, MAX_TXN_HISTORY);
      mv.current = null;
      mv.snapshot = null;
      break;
    }
    case 'SNAPSHOT_TAKE': {
      mvcc(state).snapshot = { xmin: e.xmin, xmax: e.xmax, active: e.active.slice(), scope: e.scope };
      break;
    }

    case 'HEAP_INSERT': {
      const p = touch(state, e.pageId, e.seq);
      const heap = heapOf(p);
      heap.tuples[e.slot] = {
        slot: e.slot,
        key: e.key,
        row: e.row,
        xmin: e.xmin,
        xmax: null,
        next: null,
        hot: false,
        lp: 'normal',
        redirectTo: null,
      };
      heap.freeSlots = e.freeSlots;
      p.lsn = e.seq;
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      state.focusKey = e.key;
      const mv = mvcc(state);
      mv.liveTuples++;
      if (mv.current) mv.current.writes++;
      m.versionsWritten++;
      m.recordsInserted++;
      break;
    }
    case 'HEAP_SET_XMAX': {
      const p = touch(state, e.pageId, e.seq);
      const tuple = heapOf(p).tuples[e.slot];
      if (tuple) {
        tuple.xmax = e.xmax;
        tuple.next = e.nextTid ? { ...e.nextTid } : null;
        // 新版本继承 HOT 标记：链上除链头以外的版本都没有独立索引项。
        if (e.nextTid) {
          const target = state.pages[e.nextTid.pageId]?.heap?.tuples[e.nextTid.slot];
          if (target) target.hot = e.hot;
        }
      }
      p.lsn = e.seq;
      const mv = mvcc(state);
      mv.liveTuples = Math.max(0, mv.liveTuples - 1);
      mv.deadTuples++;
      if (e.op === 'update') {
        if (e.hot) mv.hotUpdates++;
        else mv.coldUpdates++;
        if (e.hot) m.hotUpdates++;
        else m.coldUpdates++;
        m.recordsUpdated++;
      } else {
        m.recordsDeleted++;
      }
      state.focusPageId = e.pageId;
      state.focusSlot = e.slot;
      break;
    }
    case 'LINE_POINTER': {
      const p = touch(state, e.pageId, e.seq);
      const heap = heapOf(p);
      const tuple = heap.tuples[e.slot];
      if (tuple) {
        tuple.lp = e.state;
        tuple.redirectTo = e.redirectTo;
        // 只有 normal 行指针才指向真正的元组内容。
        if (e.state !== 'normal') {
          tuple.row = null;
          tuple.next = null;
        }
      } else if (e.state !== 'unused') {
        heap.tuples[e.slot] = {
          slot: e.slot,
          key: Number.NaN,
          row: null,
          xmin: 0,
          xmax: null,
          next: null,
          hot: false,
          lp: e.state,
          redirectTo: e.redirectTo,
        };
      }
      p.lsn = e.seq;
      break;
    }
    case 'HEAP_FETCH': {
      const mv = mvcc(state);
      mv.fetch = {
        indexId: e.indexId,
        fromPageId: e.fromPageId,
        fromSlot: e.fromSlot,
        tid: { ...e.tid },
        found: e.found,
        chainSteps: e.chainSteps,
      };
      m.heapFetches++;
      break;
    }
    case 'VISIBILITY_CHECK': {
      const mv = mvcc(state);
      pushCapped(
        mv.probes,
        { pageId: e.pageId, slot: e.slot, xmin: e.xmin, xmax: e.xmax, visible: e.visible, reason: e.reason },
        MAX_VISIBILITY_PROBES,
      );
      m.visibilityChecks++;
      break;
    }
    case 'HEAP_PRUNE': {
      const p = touch(state, e.pageId, e.seq);
      const heap = heapOf(p);
      for (const slot of e.removed) {
        const t = heap.tuples[slot];
        if (t) {
          heap.tuples[slot] = {
            slot,
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
      }
      for (const slot of e.deadLinePointers) {
        const t = heap.tuples[slot];
        if (t) {
          t.lp = 'dead';
          t.row = null;
        }
      }
      heap.freeSlots = e.freeSlots;
      p.lsn = e.seq;
      const mv = mvcc(state);
      mv.deadTuples = Math.max(0, mv.deadTuples - e.removed.length);
      m.vacuumedTuples += e.removed.length;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'VISIBILITY_MAP': {
      const p = state.pages[e.pageId];
      if (p?.heap) p.heap.allVisible = e.allVisible;
      break;
    }
    case 'VACUUM_BEGIN':
      break;
    case 'VACUUM_END': {
      const mv = mvcc(state);
      mv.vacuums++;
      mv.lastVacuum = {
        mode: e.mode,
        tuplesRemoved: e.tuplesRemoved,
        indexEntriesRemoved: e.indexEntriesRemoved,
        pagesFreed: e.pagesFreed,
      };
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'BLOAT_STAT': {
      const mv = mvcc(state);
      mv.liveTuples = e.liveTuples;
      mv.deadTuples = e.deadTuples;
      mv.heapPages = e.heapPages;
      // 堆表引擎没有聚簇索引，行数只能由这条权威统计给出。
      state.recordCount = e.liveTuples;
      break;
    }

    // ══ Phase 3：LSM-Tree ══════════════════════════════════
    case 'WAL_APPEND': {
      const l = lsm(state);
      let segment = l.wal.segments.find((seg) => seg.id === e.segmentId);
      if (!segment) {
        segment = { id: e.segmentId, records: [], bytes: 0, sealed: false, memtableId: null };
        l.wal.segments.push(segment);
      }
      segment.records.push({ lsn: e.lsn, op: e.op, key: e.key });
      segment.bytes += e.bytes;
      l.wal.records++;
      l.wal.bytes += e.bytes;
      l.wal.lsn = e.lsn;
      m.walBytes += e.bytes;
      break;
    }
    case 'WAL_SEAL': {
      const l = lsm(state);
      const segment = l.wal.segments.find((seg) => seg.id === e.segmentId);
      if (segment) {
        segment.sealed = true;
        segment.memtableId = e.memtableId;
      }
      // 后续写入转入新段
      if (!l.wal.segments.some((seg) => seg.id === e.nextSegmentId)) {
        l.wal.segments.push({ id: e.nextSegmentId, records: [], bytes: 0, sealed: false, memtableId: null });
      }
      break;
    }
    case 'WAL_TRUNCATE': {
      const l = lsm(state);
      l.wal.segments = l.wal.segments.filter((seg) => seg.id !== e.segmentId);
      l.wal.truncatedRecords += e.records;
      l.wal.truncatedBytes += e.bytes;
      break;
    }
    case 'CRASH': {
      const l = lsm(state);
      // MemTable、冻结队列、后台任务都在内存里，崩溃后一起没了；SST 与 WAL 在磁盘上还在。
      l.memtable.entries = [];
      l.immutable = [];
      l.bgQueue = [];
      l.probes = [];
      l.activeCompaction = null;
      l.crashes++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'WAL_REPLAY':
      break;
    case 'RECOVER_END': {
      const l = lsm(state);
      l.lastRecovery = {
        replayedRecords: e.replayedRecords,
        restoredKeys: e.restoredKeys,
        flushedToSst: e.flushedToSst,
      };
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'BG_JOB_SCHEDULED': {
      const l = lsm(state);
      l.bgQueue.push({
        id: e.jobId,
        kind: e.kind,
        level: e.level,
        reason: e.reason,
        scheduledAtSeq: e.seq,
      });
      l.maxQueueDepth = Math.max(l.maxQueueDepth, l.bgQueue.length);
      break;
    }
    case 'BG_JOB_RUN': {
      const l = lsm(state);
      const at = l.bgQueue.findIndex((j) => j.id === e.jobId);
      if (at >= 0) l.bgQueue.splice(at, 1);
      break;
    }
    case 'WRITE_STALL': {
      const l = lsm(state);
      l.stalls++;
      l.lastStall = {
        reason: e.reason,
        l0Files: e.l0Files,
        immutableTables: e.immutableTables,
        queueDepth: e.queueDepth,
        note: e.note,
      };
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'MEMTABLE_PUT': {
      const l = lsm(state);
      l.memtable.limit = e.limit;
      const idx = l.memtable.entries.findIndex((x) => x.key === e.key);
      const entry: SstEntryState = { key: e.key, row: e.row, tombstone: e.tombstone };
      if (idx >= 0) l.memtable.entries[idx] = entry;
      else insertSorted(l.memtable.entries, entry);
      l.userWrites++;
      state.focusKey = e.key;
      m.memtableWrites++;
      break;
    }
    case 'MEMTABLE_FREEZE': {
      const l = lsm(state);
      l.immutable.push({
        id: e.tableId,
        entries: e.entries.map((x) => ({ key: x.key, row: x.row, tombstone: x.tombstone })),
      });
      l.memtable.entries = [];
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'SST_CREATE': {
      const l = lsm(state);
      l.ssts[e.sstId] = {
        id: e.sstId,
        level: e.level,
        entries: e.entries.map((x) => ({ key: x.key, row: x.row, tombstone: x.tombstone })),
        minKey: e.minKey,
        maxKey: e.maxKey,
        bytes: e.bytes,
        source: e.source,
        createdAtSeq: e.seq,
        compacting: false,
      };
      while (l.levels.length <= e.level) l.levels.push([]);
      // L0 的文件区间可以重叠，按「新的在前」排；其它层按键区间排。
      if (e.level === 0) l.levels[0].unshift(e.sstId);
      else {
        const level = l.levels[e.level];
        const at = level.findIndex((id) => (l.ssts[id]?.minKey ?? Infinity) > e.minKey);
        if (at < 0) level.push(e.sstId);
        else level.splice(at, 0, e.sstId);
      }
      if (e.source === 'flush') {
        l.flushes++;
        l.immutable.shift();
        m.memtableFlushes++;
      }
      l.entriesWritten += e.entries.length;
      m.entriesWritten += e.entries.length;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'SST_DROP': {
      const l = lsm(state);
      delete l.ssts[e.sstId];
      const level = l.levels[e.level];
      if (level) {
        const at = level.indexOf(e.sstId);
        if (at >= 0) level.splice(at, 1);
      }
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'COMPACTION_BEGIN': {
      const l = lsm(state);
      l.activeCompaction = { level: e.level, targetLevel: e.targetLevel, inputs: e.inputs.slice() };
      for (const id of e.inputs) {
        const sst = l.ssts[id];
        if (sst) sst.compacting = true;
      }
      break;
    }
    case 'COMPACTION_END': {
      const l = lsm(state);
      l.activeCompaction = null;
      l.compactions++;
      l.droppedEntries += e.dropped;
      m.compactions++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'BLOOM_PROBE': {
      const l = lsm(state);
      pushCapped(
        l.probes,
        {
          sstId: e.sstId,
          level: e.level,
          kind: e.maybe ? 'bloom-maybe' : 'bloom-skip',
          found: false,
          falsePositive: e.falsePositive,
        },
        MAX_LSM_PROBES,
      );
      if (!e.maybe) m.bloomSkips++;
      break;
    }
    case 'SST_PROBE': {
      const l = lsm(state);
      pushCapped(
        l.probes,
        { sstId: e.sstId, level: e.level, kind: 'read', found: e.found, falsePositive: false },
        MAX_LSM_PROBES,
      );
      m.sstReads++;
      break;
    }
    case 'LSM_GET_RESULT': {
      const l = lsm(state);
      l.lastGet = {
        key: e.key,
        found: e.found,
        row: e.row,
        source: e.source,
        sstId: e.sstId,
        probes: e.probes,
        bloomSkips: e.bloomSkips,
      };
      state.lastResult = { key: e.key, found: e.found, pageId: null, slot: -1 };
      break;
    }

    default: {
      const never: never = e;
      throw new Error(`[dbkl] reducer: unhandled event ${JSON.stringify(never)}`);
    }
  }

  return state;
}

function bumpRecency(state: LabState, id: PageId): void {
  const r = state.buffer.recency;
  const i = r.indexOf(id);
  if (i >= 0) r.splice(i, 1);
  r.unshift(id);
}

function releaseFrame(state: LabState, id: PageId): void {
  const idx = state.buffer.frames.indexOf(id);
  if (idx >= 0) state.buffer.frames[idx] = null;
  delete state.buffer.refBits[id];
  state.buffer.recency = state.buffer.recency.filter((x) => x !== id);
}

// ——— 结构投影（引擎 ↔ reducer 一致性校验） ——————————————————

export interface StructuralPage {
  id: PageId;
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
  resident: boolean;
  /** 堆页内容（PostgreSQL 引擎）。 */
  heap?: HeapPageState;
}

/** LSM 的结构投影：只比较「文件里有哪些键、是不是墓碑」，不比较行内容。 */
export interface StructuralLsm {
  memtable: { key: Key; tombstone: boolean }[];
  immutable: { id: string; keys: Key[] }[];
  levels: { id: string; level: number; minKey: Key; maxKey: Key; keys: Key[]; tombstones: Key[] }[][];
  /** 仍需保留的 WAL 段（对应数据还没落成 SST）。 */
  wal: { id: string; sealed: boolean; records: number; memtableId: string | null }[];
  /** 待执行的后台任务。 */
  bgQueue: { id: number; kind: 'flush' | 'compaction'; level: number }[];
}

export interface StructuralIndex {
  id: string;
  name: string;
  column: string;
  clustered: boolean;
  unique: boolean;
  rootId: PageId | null;
  firstLeafId: PageId | null;
  height: number;
  entries: number;
}

/**
 * 引擎内部状态与 reducer 归约结果的公共子集。
 *
 * 测试断言 `projectStructure(replay(events))` 与 `engine.snapshot()` 深度相等，
 * 从而保证「可视化只消费事件」这条铁律在实现层面成立。
 */
export interface StructuralSnapshot {
  indexes: Record<string, StructuralIndex>;
  recordCount: number;
  pages: Record<PageId, StructuralPage>;
  bufferFrames: (PageId | null)[];
  bufferRecency: PageId[];
  /** LSM 引擎专用；其它引擎不设置该字段。 */
  lsm?: StructuralLsm;
}

/** 把 LabState 里的 LSM 子状态投影成可与引擎快照比较的形状。 */
export function projectLsm(lsmState: LsmState): StructuralLsm {
  return {
    memtable: lsmState.memtable.entries.map((e) => ({ key: e.key, tombstone: e.tombstone })),
    immutable: lsmState.immutable.map((t) => ({ id: t.id, keys: t.entries.map((e) => e.key) })),
    levels: lsmState.levels.map((ids) =>
      ids
        .map((id) => lsmState.ssts[id])
        .filter((s): s is SstState => !!s)
        .map((s) => ({
          id: s.id,
          level: s.level,
          minKey: s.minKey,
          maxKey: s.maxKey,
          keys: s.entries.map((e) => e.key),
          tombstones: s.entries.filter((e) => e.tombstone).map((e) => e.key),
        })),
    ),
    wal: lsmState.wal.segments.map((seg) => ({
      id: seg.id,
      sealed: seg.sealed,
      records: seg.records.length,
      memtableId: seg.memtableId,
    })),
    bgQueue: lsmState.bgQueue.map((j) => ({ id: j.id, kind: j.kind, level: j.level })),
  };
}

export function projectStructure(state: LabState): StructuralSnapshot {
  const pages: Record<PageId, StructuralPage> = {};
  for (const id in state.pages) {
    const p = state.pages[id];
    pages[p.id] = {
      id: p.id,
      indexId: p.indexId,
      type: p.type,
      level: p.level,
      parentId: p.parentId,
      keys: p.keys.slice(),
      rows: structuredClone(p.rows),
      children: p.children.slice(),
      prev: p.prev,
      next: p.next,
      dirty: p.dirty,
      resident: p.resident,
      heap: p.heap ? structuredClone(p.heap) : undefined,
    };
  }
  const indexes: Record<string, StructuralIndex> = {};
  for (const id in state.indexes) {
    const ix = state.indexes[id];
    indexes[id] = {
      id: ix.id,
      name: ix.name,
      column: ix.column,
      clustered: ix.clustered,
      unique: ix.unique,
      rootId: ix.rootId,
      firstLeafId: ix.firstLeafId,
      height: ix.height,
      entries: ix.entries,
    };
  }
  return {
    indexes,
    recordCount: state.recordCount,
    pages,
    bufferFrames: state.buffer.frames.slice(),
    bufferRecency: state.buffer.recency.slice(),
    lsm: state.lsm ? projectLsm(state.lsm) : undefined,
  };
}

// ——— 派生量（可视化与检查面板使用） —————————————————————————

/** 页的槽位容量：叶子 order-1 条记录，内部页 order-1 个分隔键。 */
export function pageCapacity(config: EngineConfig): number {
  return Math.max(1, config.order - 1);
}

export function pageUsedBytes(p: PageState, schema: TableSchema | null): number {
  const per = p.type === 'leaf' ? estimateRecordBytes(schema) : INTERNAL_ENTRY_BYTES;
  return PAGE_HEADER_BYTES + p.keys.length * per;
}

/** 槽位填充率（0..1），可视化中页面「装满程度」的主要依据。 */
export function pageFill(p: PageState, config: EngineConfig): number {
  return p.keys.length / pageCapacity(config);
}

export function primaryIndex(state: LabState): IndexState | null {
  return state.indexes[PRIMARY_INDEX_ID] ?? null;
}

export function secondaryIndexes(state: LabState): IndexState[] {
  return Object.values(state.indexes).filter((ix) => !ix.clustered);
}

/** 按索引分组的索引列表，聚簇索引永远排在最前。 */
export function orderedIndexes(state: LabState): IndexState[] {
  return Object.values(state.indexes).sort((a, b) => {
    if (a.clustered !== b.clustered) return a.clustered ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** 沿叶子链表返回某棵索引的叶子页顺序。 */
export function leafOrder(state: LabState, indexId = PRIMARY_INDEX_ID): PageId[] {
  const out: PageId[] = [];
  let cur = state.indexes[indexId]?.firstLeafId ?? null;
  const seen = new Set<PageId>();
  while (cur !== null && state.pages[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = state.pages[cur].next;
  }
  return out;
}

export function hitRate(m: Metrics): number {
  const total = m.bufferHits + m.bufferMisses;
  return total === 0 ? Number.NaN : m.bufferHits / total;
}

export function dirtyPageCount(state: LabState): number {
  let n = 0;
  for (const id in state.pages) if (state.pages[id].dirty) n++;
  return n;
}

export function pageCountByIndex(state: LabState, indexId: string): number {
  let n = 0;
  for (const id in state.pages) if (state.pages[id].indexId === indexId) n++;
  return n;
}

// ——— 堆表 / MVCC 派生量 ————————————————————————————————

/** 堆文件里的所有页，按块号升序（这就是「顺序扫描」看到的顺序）。 */
export function heapPages(state: LabState): PageState[] {
  return Object.values(state.pages)
    .filter((p) => p.type === 'heap')
    .sort((a, b) => (a.heap?.blockNo ?? 0) - (b.heap?.blockNo ?? 0));
}

/** 表膨胀率：死元组 / (活 + 死)。VACUUM 就是为了把它压下去。 */
export function bloatRatio(state: LabState): number {
  const mv = state.mvcc;
  if (!mv) return Number.NaN;
  const total = mv.liveTuples + mv.deadTuples;
  return total === 0 ? 0 : mv.deadTuples / total;
}

/** 沿 t_ctid 展开一条版本链（从给定 TID 开始）。 */
export function versionChain(state: LabState, start: Tid): HeapTupleState[] {
  const out: HeapTupleState[] = [];
  const seen = new Set<string>();
  let cur: Tid | null = start;
  while (cur !== null) {
    const key = `${cur.pageId}:${cur.slot}`;
    if (seen.has(key)) break;
    seen.add(key);
    const tuple: HeapTupleState | undefined = state.pages[cur.pageId]?.heap?.tuples[cur.slot];
    if (!tuple) break;
    out.push(tuple);
    cur = tuple.next;
  }
  return out;
}

/** 一个键在堆里的全部版本（跨页扫描，仅用于检查器面板）。 */
export function tupleVersionsOf(state: LabState, key: Key): { tid: Tid; tuple: HeapTupleState }[] {
  const out: { tid: Tid; tuple: HeapTupleState }[] = [];
  for (const p of heapPages(state)) {
    p.heap?.tuples.forEach((t, slot) => {
      if (t && t.key === key && t.lp !== 'unused') out.push({ tid: { pageId: p.id, slot }, tuple: t });
    });
  }
  return out;
}

// ——— LSM 派生量 ————————————————————————————————————————

/** 每层的文件数与条目数，供层级视图与指标面板使用。 */
export function lsmLevelStats(l: LsmState): { level: number; files: number; entries: number; bytes: number }[] {
  return l.levels.map((ids, level) => {
    const ssts = ids.map((id) => l.ssts[id]).filter((s): s is SstState => !!s);
    return {
      level,
      files: ssts.length,
      entries: ssts.reduce((n, s) => n + s.entries.length, 0),
      bytes: ssts.reduce((n, s) => n + s.bytes, 0),
    };
  });
}

/** 写放大：实际落盘条目数 / 用户写入条目数。压实越激进它越大。 */
export function writeAmplification(l: LsmState): number {
  return l.userWrites === 0 ? Number.NaN : l.entriesWritten / l.userWrites;
}

/** 空间放大：磁盘上的条目数 / 逻辑上仍存活的键数。 */
export function spaceAmplification(l: LsmState): number {
  const live = new Set<Key>();
  let onDisk = 0;
  for (const level of l.levels) {
    for (const id of level) {
      const sst = l.ssts[id];
      if (!sst) continue;
      onDisk += sst.entries.length;
    }
  }
  // 从最新到最旧扫一遍，第一次见到的键才算「活」的。
  for (const e of l.memtable.entries) if (!e.tombstone) live.add(e.key);
  for (let i = l.immutable.length - 1; i >= 0; i--) {
    for (const e of l.immutable[i].entries) if (!e.tombstone) live.add(e.key);
  }
  for (const level of l.levels) {
    for (const id of level) {
      const sst = l.ssts[id];
      if (!sst) continue;
      for (const e of sst.entries) if (!e.tombstone) live.add(e.key);
    }
  }
  return live.size === 0 ? Number.NaN : onDisk / live.size;
}

/** LSM 里逻辑上仍然存在的键（memtable 优先、层号越小越新）。 */
export function lsmLiveKeys(l: LsmState): Key[] {
  const seen = new Map<Key, boolean>();
  const consider = (e: SstEntryState) => {
    if (!seen.has(e.key)) seen.set(e.key, !e.tombstone);
  };
  for (const e of l.memtable.entries) consider(e);
  // 冻结但还没刷盘的表也是「活」数据：后台积压时它们可能排很久。
  for (let i = l.immutable.length - 1; i >= 0; i--) {
    for (const e of l.immutable[i].entries) consider(e);
  }
  for (const level of l.levels) {
    for (const id of level) {
      const sst = l.ssts[id];
      if (!sst) continue;
      for (const e of sst.entries) consider(e);
    }
  }
  return [...seen.entries()].filter(([, alive]) => alive).map(([k]) => k).sort((a, b) => a - b);
}
