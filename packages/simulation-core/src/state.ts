import {
  INTERNAL_ENTRY_BYTES,
  PAGE_HEADER_BYTES,
  estimateRecordBytes,
  type Key,
  type PageId,
  type PageType,
  type Row,
  type TableSchema,
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
    lastStructuralSeq: -1,
    appliedSeq: -1,
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
  };
}

export function cloneState(state: LabState): LabState {
  return structuredClone(state);
}

const MAX_SCAN_OUTPUT = 200;

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
      };
      m.pageAllocs++;
      state.lastStructuralSeq = e.seq;
      break;
    }
    case 'PAGE_FREE': {
      const p = state.pages[e.pageId];
      if (p) {
        const ix = state.indexes[p.indexId];
        if (ix && ix.firstLeafId === e.pageId) ix.firstLeafId = p.next;
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
