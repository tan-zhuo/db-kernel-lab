import {
  formatTid,
  type CommandKind,
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
import type { EngineConfig } from './engine/types';
import type { PhysicalPlan } from './query/types';

/**
 * 事件协议 —— 整个平台的唯一真相来源。
 *
 * 规则（不可违反）：
 *  1. 引擎的任何状态变化都必须产生事件；
 *  2. 可视化层只能消费事件（经 reducer 归约成 LabState），禁止自己推断状态；
 *  3. 事件必须是纯数据（可 structuredClone / JSON 序列化），不能携带函数或类实例；
 *  4. `applyEvent(reducer)` 对事件流的重放结果必须与引擎自身快照逐字段相等（见 replay.test.ts）。
 *
 * 详细语义见 docs/event-protocol.md。
 */

export interface EventMeta {
  /** 全局单调递增序号，等于它在历史事件数组中的下标。 */
  seq: number;
  /** 逻辑时间戳（仿真时钟，单位：逻辑毫秒），用于动画节奏，不是墙钟时间。 */
  t: number;
  /** 所属命令 id，用于时间轴按命令分组与区间循环。 */
  cmd: number;
}

/** 页内被移动的一批条目（分裂 / 合并 / 再分配时用于让 reducer 一步完成结构变更）。 */
export interface EntryBatch {
  keys: Key[];
  /** 叶子页：与 keys 对齐的行数据。 */
  rows?: (Row | null)[];
  /** 内部页：被搬走的子页指针。 */
  children?: PageId[];
}

export type SimulationEventBody =
  // —— 命令边界 ——————————————————————————————————————————————
  | { type: 'COMMAND_BEGIN'; kind: CommandKind; label: string }
  | { type: 'COMMAND_END'; kind: CommandKind; label: string; ok: boolean; note?: string }
  | { type: 'NOTE'; message: string; level: 'info' | 'warn' | 'error' }

  // —— 元数据 ————————————————————————————————————————————————
  | { type: 'CONFIG_SET'; config: EngineConfig }
  | { type: 'TABLE_CREATE'; schema: TableSchema }
  | {
      type: 'INDEX_CREATE';
      indexId: string;
      name: string;
      column: string;
      clustered: boolean;
      unique: boolean;
    }
  | { type: 'INDEX_DROP'; indexId: string }
  /** 索引统计信息刷新（模拟 ANALYZE TABLE），供代价估算使用。 */
  | { type: 'INDEX_STATS'; indexId: string; entries: number; distinct: number; minKey: Key | null; maxKey: Key | null }

  // —— 页生命周期 ————————————————————————————————————————————
  | {
      type: 'PAGE_ALLOC';
      pageId: PageId;
      /** 页归属的索引（'PRIMARY' 为聚簇索引）。 */
      indexId: string;
      pageType: PageType;
      level: number;
      parentId: PageId | null;
      /** 新页的初始内容（新建根页时用于携带第一个子指针）。 */
      init?: { keys?: Key[]; children?: PageId[] };
      /** 堆页专用：文件内的块号（PostgreSQL 的 BlockNumber）。 */
      blockNo?: number;
      /** 堆页专用：该页的行指针容量。 */
      slots?: number;
    }
  | { type: 'PAGE_FREE'; pageId: PageId }
  | { type: 'PARENT_SET'; pageId: PageId; parentId: PageId | null }
  | { type: 'ROOT_CHANGE'; indexId: string; oldRootId: PageId | null; newRootId: PageId; height: number }
  | { type: 'LEAF_LINK'; pageId: PageId; prev: PageId | null; next: PageId | null }

  // —— 索引遍历 ————————————————————————————————————————————
  | { type: 'DESCEND'; pageId: PageId; childId: PageId; key: Key; slot: number; level: number }
  | { type: 'PAGE_READ'; pageId: PageId; purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain' }

  // —— 记录级变更（叶子页）————————————————————————————————
  | { type: 'RECORD_INSERT'; pageId: PageId; slot: number; key: Key; row: Row }
  | { type: 'RECORD_UPDATE'; pageId: PageId; slot: number; key: Key; row: Row; oldRow: Row | null }
  | { type: 'RECORD_DELETE'; pageId: PageId; slot: number; key: Key; row: Row | null }

  // —— 分隔键变更（内部页）————————————————————————————————
  | { type: 'SEPARATOR_INSERT'; pageId: PageId; slot: number; key: Key; childId: PageId }
  | { type: 'SEPARATOR_DELETE'; pageId: PageId; slot: number; key: Key; childId: PageId }
  | { type: 'SEPARATOR_UPDATE'; pageId: PageId; slot: number; key: Key; oldKey: Key }

  // —— 结构调整 ————————————————————————————————————————————
  | {
      type: 'PAGE_SPLIT';
      pageId: PageId;
      newPageId: PageId;
      /** 上浮到父页的键。叶子分裂时 = 右页首键（键仍保留在右页）；内部分裂时该键被移除。 */
      promotedKey: Key;
      pageType: PageType;
      /** 从左页搬到右页的条目，reducer 用它一次性完成搬迁。 */
      moved: EntryBatch;
      /** 触发分裂的键，用于动画标注。 */
      triggerKey: Key | null;
      fillFactor: number;
    }
  | {
      type: 'PAGE_MERGE';
      /** 保留页（左）。 */
      pageId: PageId;
      /** 被回收页（右）。 */
      victimPageId: PageId;
      pageType: PageType;
      /** 父页中被下沉/删除的分隔键。 */
      separatorKey: Key;
      moved: EntryBatch;
    }
  | {
      type: 'REDISTRIBUTE';
      fromPageId: PageId;
      toPageId: PageId;
      pageType: PageType;
      direction: 'left-to-right' | 'right-to-left';
      moved: EntryBatch;
      parentId: PageId;
      parentSlot: number;
      newSeparatorKey: Key;
      oldSeparatorKey: Key;
    }

  // —— 缓冲池 ————————————————————————————————————————————
  | { type: 'BUFFER_HIT'; pageId: PageId; frame: number }
  | { type: 'BUFFER_MISS'; pageId: PageId; frame: number }
  | { type: 'BUFFER_EVICT'; pageId: PageId; frame: number; reason: 'LRU' | 'CLOCK'; wasDirty: boolean }
  | { type: 'PAGE_MARK_DIRTY'; pageId: PageId }
  | { type: 'PAGE_FLUSH'; pageId: PageId; reason: 'evict' | 'checkpoint' | 'manual' }

  // —— 查询过程 ————————————————————————————————————————————
  | { type: 'SEARCH_BEGIN'; key: Key; mode: 'point' | 'range' | 'full' }
  | { type: 'SEARCH_RESULT'; key: Key; found: boolean; pageId: PageId | null; slot: number }
  | { type: 'SCAN_STEP'; pageId: PageId; slot: number; key: Key; row: Row | null; emitted: boolean }
  | { type: 'SCAN_END'; rows: number; pagesTouched: number }

  // —— 二级索引回表 ——————————————————————————————————————
  | {
      type: 'LOOKUP_BACK';
      /** 发起回表的二级索引。 */
      indexId: string;
      /** 二级索引叶子页与槽位。 */
      fromPageId: PageId;
      fromSlot: number;
      /** 二级索引键与它指向的主键。 */
      indexKey: Key;
      primaryKey: Key;
    }
  | { type: 'LOOKUP_DONE'; fromPageId: PageId; toPageId: PageId | null; slot: number; primaryKey: Key; found: boolean }

  // —— 执行计划 ————————————————————————————————————————
  | { type: 'PLAN_READY'; plan: PhysicalPlan }
  | { type: 'OPERATOR_OPEN'; nodeId: string; op: string; detail: string }
  | { type: 'OPERATOR_ROW'; nodeId: string; key: Key; emitted: boolean }
  | { type: 'OPERATOR_CLOSE'; nodeId: string; actualRows: number }

  // ══ Phase 2：事务与 MVCC（PostgreSQL 堆表引擎）══════════════
  | { type: 'TXN_BEGIN'; xid: Txid; isolation: IsolationLevel; implicit: boolean }
  | { type: 'TXN_COMMIT'; xid: Txid; writes: number }
  | { type: 'TXN_ABORT'; xid: Txid; writes: number; reason: string }
  /**
   * 取快照。READ COMMITTED 每条语句取一次，REPEATABLE READ 整个事务只取一次 ——
   * 这条事件是「为什么两次相同的查询看到不同结果」的唯一物理证据。
   */
  | {
      type: 'SNAPSHOT_TAKE';
      xid: Txid;
      /** 小于 xmin 的事务都已结束；≥ xmax 的都还没开始。 */
      xmin: Txid;
      xmax: Txid;
      active: Txid[];
      scope: 'statement' | 'transaction';
    }

  // —— 堆表（无序数据页 + 行指针 + 元组版本链）——————————————
  | {
      type: 'HEAP_INSERT';
      pageId: PageId;
      slot: number;
      key: Key;
      row: Row;
      xmin: Txid;
      /** 插入后该页还剩多少空槽（对应 PG 的 FSM）。 */
      freeSlots: number;
    }
  /** 给旧版本打上 xmax；`nextTid` 就是 t_ctid，指向新版本，构成版本链。 */
  | {
      type: 'HEAP_SET_XMAX';
      pageId: PageId;
      slot: number;
      xmax: Txid;
      nextTid: Tid | null;
      hot: boolean;
      op: 'update' | 'delete';
    }
  | { type: 'LINE_POINTER'; pageId: PageId; slot: number; state: LinePointerState; redirectTo: number | null }
  /** 索引项 → 堆元组的一跳。PostgreSQL 里**任何**索引扫描都要走这一步。 */
  | {
      type: 'HEAP_FETCH';
      indexId: string;
      fromPageId: PageId;
      fromSlot: number;
      tid: Tid;
      found: boolean;
      /** 沿 HOT 链走了多少步才找到可见版本。 */
      chainSteps: number;
    }
  | {
      type: 'VISIBILITY_CHECK';
      pageId: PageId;
      slot: number;
      xmin: Txid;
      xmax: Txid | null;
      visible: boolean;
      reason: string;
    }
  /** VACUUM 清理一个堆页：移除死元组、把 HOT 链头改成 redirect、回收行指针。 */
  | {
      type: 'HEAP_PRUNE';
      pageId: PageId;
      removed: number[];
      redirected: number[];
      deadLinePointers: number[];
      freeSlots: number;
    }
  /**
   * 可见性映射位（PostgreSQL 的 Visibility Map）。
   * VACUUM 把「所有元组对所有事务都可见」的页标成 all-visible，
   * Index Only Scan 才能跳过回堆；任何写入都会把它清掉。
   */
  | { type: 'VISIBILITY_MAP'; pageId: PageId; allVisible: boolean }
  | { type: 'VACUUM_BEGIN'; mode: 'lazy' | 'full'; deadTuples: number }
  | {
      type: 'VACUUM_END';
      mode: 'lazy' | 'full';
      tuplesRemoved: number;
      indexEntriesRemoved: number;
      pagesTouched: number;
      pagesFreed: number;
    }
  /** 表膨胀统计：活元组 / 死元组 / 堆页数，VACUUM 的效果一眼可见。 */
  | { type: 'BLOAT_STAT'; liveTuples: number; deadTuples: number; heapPages: number }

  // ══ Phase 3：LSM-Tree ═════════════════════════════════════
  /**
   * WAL 追加。**先写日志再改内存**，所以它必定排在同一次写入的 `MEMTABLE_PUT` 之前。
   * 记录进的是当前那个 WAL 段（`segmentId`），段的生命周期与一个 MemTable 绑定。
   */
  | { type: 'WAL_APPEND'; lsn: number; op: 'put' | 'delete'; key: Key; bytes: number; segmentId: string }
  /** MemTable 冻结时把当前 WAL 段封口，并开一个新段承接后续写入。 */
  | { type: 'WAL_SEAL'; segmentId: string; memtableId: string; records: number; bytes: number; nextSegmentId: string }
  /**
   * WAL 段被回收。
   *
   * 触发时机是「它对应的 MemTable 已经落成 SST」—— 数据进了磁盘，日志就没用了。
   * 这条事件是 WAL **不会无限增长**的唯一原因，也是「WAL 只保住还没落盘的那部分」这条不变式的体现。
   */
  | { type: 'WAL_TRUNCATE'; segmentId: string; records: number; bytes: number; reason: 'flushed' | 'recovered' }
  /** 模拟进程崩溃：内存里的 MemTable 与冻结队列全部丢失，只剩磁盘上的 SST 与 WAL。 */
  | {
      type: 'CRASH';
      lostMemtableEntries: number;
      lostImmutableTables: number;
      lostBackgroundJobs: number;
      retainedWalRecords: number;
      survivingSsts: number;
    }
  /** 重放一个 WAL 段，把丢失的数据装回 MemTable。 */
  | { type: 'WAL_REPLAY'; segmentId: string; records: number; fromLsn: number; toLsn: number }
  | { type: 'RECOVER_END'; replayedRecords: number; restoredKeys: number; flushedToSst: string | null }

  // —— 后台任务队列（刷写 / 压实都不在写路径上做）——
  | {
      type: 'BG_JOB_SCHEDULED';
      jobId: number;
      kind: 'flush' | 'compaction';
      level: number;
      reason: string;
      /** 入队后的积压深度 —— 这就是「压实债务」。 */
      queueDepth: number;
    }
  | {
      type: 'BG_JOB_RUN';
      jobId: number;
      kind: 'flush' | 'compaction';
      level: number;
      /** 从入队到真正执行之间隔了多少个事件，反映后台追得有多吃力。 */
      waitedSeq: number;
      queueDepth: number;
      /** 是否是被写停顿逼着在写路径上同步跑的。 */
      forced: boolean;
    }
  /**
   * 写停顿：写入跑得比后台快，只能让写路径停下来等。
   *
   * 这是 LSM 最著名的运维现象。真实 RocksDB 还有一档「限速」（soft slowdown），
   * 那需要墙钟才能表达，本仿真只建模硬停顿。
   */
  | {
      type: 'WRITE_STALL';
      reason: 'immutable-full' | 'l0-stop';
      l0Files: number;
      immutableTables: number;
      queueDepth: number;
      note: string;
    }
  | {
      type: 'MEMTABLE_PUT';
      key: Key;
      row: Row | null;
      tombstone: boolean;
      entries: number;
      limit: number;
      /** 覆盖同一个键时为 true —— LSM 的「更新」就是再写一条新版本。 */
      overwrite: boolean;
    }
  /**
   * MemTable 冻结成不可变表。
   *
   * **必须带上全部条目**：后台模式下它可能在队列里排很久才落盘，
   * 这段时间里这些数据是真实存在、也读得到的 —— 只带条数会让它们从可视化里凭空消失。
   */
  | { type: 'MEMTABLE_FREEZE'; tableId: string; entries: { key: Key; row: Row | null; tombstone: boolean }[] }
  | {
      type: 'SST_CREATE';
      sstId: string;
      level: number;
      entries: { key: Key; row: Row | null; tombstone: boolean }[];
      minKey: Key;
      maxKey: Key;
      bytes: number;
      source: 'flush' | 'compaction';
    }
  | { type: 'SST_DROP'; sstId: string; level: number; reason: 'compacted' | 'obsolete' }
  | { type: 'COMPACTION_BEGIN'; level: number; targetLevel: number; inputs: string[]; reason: string }
  | {
      type: 'COMPACTION_END';
      level: number;
      targetLevel: number;
      inputs: string[];
      outputs: string[];
      entriesIn: number;
      entriesOut: number;
      /** 被合并掉的重复版本与被回收的墓碑数量 —— 空间放大的直接来源。 */
      dropped: number;
    }
  /** 布隆过滤器探测：`maybe=false` 直接跳过整个文件，这是 LSM 读放大的主要缓解手段。 */
  | { type: 'BLOOM_PROBE'; sstId: string; level: number; key: Key; maybe: boolean; falsePositive: boolean }
  | { type: 'SST_PROBE'; sstId: string; level: number; key: Key; found: boolean; tombstone: boolean }
  | {
      type: 'LSM_GET_RESULT';
      key: Key;
      found: boolean;
      row: Row | null;
      source: 'memtable' | 'immutable' | 'sst' | 'miss';
      sstId: string | null;
      /** 实际读过的 SST 数（读放大）与被布隆过滤器挡掉的数量。 */
      probes: number;
      bloomSkips: number;
    }

  // ══ Phase 3 续：列存 ═══════════════════════════════════════
  | { type: 'ROW_GROUP_OPEN'; rowGroupId: string; index: number; capacity: number }
  /**
   * 一个列块落盘。
   *
   * 列存的全部价值都压在这条事件里：**同一列的值挨在一起**，
   * 所以能挑到合适的编码（基数低用字典、连续重复用 RLE），压缩比远高于行存；
   * 而且读的时候可以只读这一块，完全不碰其它列。
   */
  | {
      type: 'COLUMN_CHUNK_WRITE';
      rowGroupId: string;
      column: string;
      rows: number;
      encoding: 'plain' | 'dictionary' | 'rle' | 'delta';
      /** 未编码的原始字节 vs 编码后的字节，两者之比即压缩比。 */
      rawBytes: number;
      encodedBytes: number;
      distinct: number;
      minValue: Key | null;
      maxValue: Key | null;
    }
  | { type: 'ROW_GROUP_SEAL'; rowGroupId: string; rows: number; rawBytes: number; encodedBytes: number }
  /** 区间统计（zone map）判定整个行组不可能有匹配行，直接跳过 —— 一个字节都不用读。 */
  | {
      type: 'ZONE_MAP_SKIP';
      rowGroupId: string;
      column: string;
      minValue: Key | null;
      maxValue: Key | null;
      reason: string;
    }
  /** 真的读了某个列块。查询用到几列就只读几列，这是列存与行存最大的差别。 */
  | { type: 'COLUMN_READ'; rowGroupId: string; column: string; rows: number; bytes: number }
  /** 向量化执行：一次处理一批行而不是一行一行。 */
  | { type: 'VECTOR_BATCH'; rowGroupId: string; rows: number; matched: number }

  // ══ Phase 3 续：哈希索引 KV（Bitcask 风格）══════════════════
  | { type: 'LOG_FILE_OPEN'; fileId: string; index: number }
  | { type: 'LOG_FILE_SEAL'; fileId: string; records: number; bytes: number }
  /** 追加写日志：KV 的写入永远是顺序追加，没有原地修改。 */
  | {
      type: 'LOG_APPEND';
      fileId: string;
      offset: number;
      key: Key;
      bytes: number;
      tombstone: boolean;
    }
  /**
   * 内存哈希索引项更新：key → (文件, 偏移)。
   *
   * 索引**常驻内存**，所以点查只要一次磁盘寻址；代价是键的数量被内存卡死 ——
   * 这正是 Bitcask 这类设计的根本约束。
   */
  | {
      type: 'HASH_INDEX_SET';
      key: Key;
      bucket: number;
      fileId: string;
      offset: number;
      /** 覆盖旧值时为 true，旧记录随即变成垃圾。 */
      overwrite: boolean;
      /** 删除时把索引项摘掉。 */
      removed: boolean;
      keys: number;
      indexBytes: number;
    }
  /** 哈希探测：桶内冲突链走了几步。与数据量无关，永远 O(1)。 */
  | {
      type: 'HASH_PROBE';
      key: Key;
      bucket: number;
      chainSteps: number;
      found: boolean;
      fileId: string | null;
      offset: number;
    }
  | { type: 'MERGE_BEGIN'; inputs: string[]; reason: string; deadRatio: number }
  | {
      type: 'MERGE_END';
      inputs: string[];
      outputs: string[];
      liveRecords: number;
      deadRecords: number;
      reclaimedBytes: number;
    };

export type SimulationEvent = EventMeta & SimulationEventBody;
export type SimulationEventType = SimulationEventBody['type'];

/** 事件类型 → 展示分类，供时间轴染色与日志过滤。 */
export const EVENT_CATEGORY: Record<SimulationEventType, EventCategory> = {
  COMMAND_BEGIN: 'command',
  COMMAND_END: 'command',
  NOTE: 'command',
  CONFIG_SET: 'meta',
  TABLE_CREATE: 'meta',
  INDEX_CREATE: 'meta',
  INDEX_DROP: 'meta',
  INDEX_STATS: 'meta',
  PAGE_ALLOC: 'structure',
  PAGE_FREE: 'structure',
  PARENT_SET: 'structure',
  ROOT_CHANGE: 'structure',
  LEAF_LINK: 'structure',
  DESCEND: 'access',
  PAGE_READ: 'access',
  RECORD_INSERT: 'record',
  RECORD_UPDATE: 'record',
  RECORD_DELETE: 'record',
  SEPARATOR_INSERT: 'record',
  SEPARATOR_DELETE: 'record',
  SEPARATOR_UPDATE: 'record',
  PAGE_SPLIT: 'structure',
  PAGE_MERGE: 'structure',
  REDISTRIBUTE: 'structure',
  BUFFER_HIT: 'buffer',
  BUFFER_MISS: 'buffer',
  BUFFER_EVICT: 'buffer',
  PAGE_MARK_DIRTY: 'buffer',
  PAGE_FLUSH: 'buffer',
  SEARCH_BEGIN: 'access',
  SEARCH_RESULT: 'access',
  SCAN_STEP: 'access',
  SCAN_END: 'access',
  LOOKUP_BACK: 'access',
  LOOKUP_DONE: 'access',
  PLAN_READY: 'plan',
  OPERATOR_OPEN: 'plan',
  OPERATOR_ROW: 'plan',
  OPERATOR_CLOSE: 'plan',

  TXN_BEGIN: 'txn',
  TXN_COMMIT: 'txn',
  TXN_ABORT: 'txn',
  SNAPSHOT_TAKE: 'txn',
  HEAP_INSERT: 'record',
  HEAP_SET_XMAX: 'mvcc',
  LINE_POINTER: 'structure',
  HEAP_FETCH: 'access',
  VISIBILITY_CHECK: 'mvcc',
  HEAP_PRUNE: 'structure',
  VISIBILITY_MAP: 'mvcc',
  VACUUM_BEGIN: 'mvcc',
  VACUUM_END: 'mvcc',
  BLOAT_STAT: 'meta',

  WAL_APPEND: 'lsm',
  WAL_SEAL: 'lsm',
  WAL_TRUNCATE: 'lsm',
  CRASH: 'lsm',
  WAL_REPLAY: 'lsm',
  RECOVER_END: 'lsm',
  BG_JOB_SCHEDULED: 'lsm',
  BG_JOB_RUN: 'lsm',
  WRITE_STALL: 'lsm',
  MEMTABLE_PUT: 'record',
  MEMTABLE_FREEZE: 'lsm',
  SST_CREATE: 'lsm',
  SST_DROP: 'lsm',
  COMPACTION_BEGIN: 'lsm',
  COMPACTION_END: 'lsm',
  BLOOM_PROBE: 'access',
  SST_PROBE: 'access',
  LSM_GET_RESULT: 'access',

  ROW_GROUP_OPEN: 'columnar',
  COLUMN_CHUNK_WRITE: 'columnar',
  ROW_GROUP_SEAL: 'columnar',
  ZONE_MAP_SKIP: 'access',
  COLUMN_READ: 'access',
  VECTOR_BATCH: 'access',

  LOG_FILE_OPEN: 'kv',
  LOG_FILE_SEAL: 'kv',
  LOG_APPEND: 'record',
  HASH_INDEX_SET: 'kv',
  HASH_PROBE: 'access',
  MERGE_BEGIN: 'kv',
  MERGE_END: 'kv',
};

export type EventCategory =
  | 'command'
  | 'meta'
  | 'structure'
  | 'record'
  | 'buffer'
  | 'access'
  | 'plan'
  | 'txn'
  | 'mvcc'
  | 'lsm'
  | 'columnar'
  | 'kv';

/**
 * 每类事件占用的「逻辑时长」（毫秒）。
 *
 * 它不是墙钟时间，而是仿真时钟：时间轴按逻辑时间铺开，
 * 让页分裂这种关键事件在播放时自然停留更久，而缓冲池命中一闪而过。
 */
export const EVENT_DURATION: Record<SimulationEventType, number> = {
  COMMAND_BEGIN: 40,
  COMMAND_END: 40,
  NOTE: 60,
  CONFIG_SET: 40,
  TABLE_CREATE: 200,
  INDEX_CREATE: 300,
  INDEX_DROP: 200,
  INDEX_STATS: 40,
  PAGE_ALLOC: 220,
  PAGE_FREE: 220,
  PARENT_SET: 30,
  ROOT_CHANGE: 400,
  LEAF_LINK: 60,
  DESCEND: 160,
  PAGE_READ: 40,
  RECORD_INSERT: 180,
  RECORD_UPDATE: 180,
  RECORD_DELETE: 180,
  SEPARATOR_INSERT: 200,
  SEPARATOR_DELETE: 200,
  SEPARATOR_UPDATE: 120,
  PAGE_SPLIT: 700,
  PAGE_MERGE: 700,
  REDISTRIBUTE: 500,
  BUFFER_HIT: 40,
  BUFFER_MISS: 90,
  BUFFER_EVICT: 260,
  PAGE_MARK_DIRTY: 40,
  PAGE_FLUSH: 160,
  SEARCH_BEGIN: 80,
  SEARCH_RESULT: 260,
  SCAN_STEP: 90,
  SCAN_END: 120,
  LOOKUP_BACK: 260,
  LOOKUP_DONE: 160,
  PLAN_READY: 400,
  OPERATOR_OPEN: 120,
  OPERATOR_ROW: 70,
  OPERATOR_CLOSE: 120,

  TXN_BEGIN: 180,
  TXN_COMMIT: 260,
  TXN_ABORT: 320,
  SNAPSHOT_TAKE: 220,
  HEAP_INSERT: 200,
  HEAP_SET_XMAX: 240,
  LINE_POINTER: 120,
  HEAP_FETCH: 260,
  VISIBILITY_CHECK: 150,
  HEAP_PRUNE: 420,
  VISIBILITY_MAP: 90,
  VACUUM_BEGIN: 260,
  VACUUM_END: 320,
  BLOAT_STAT: 60,

  WAL_APPEND: 60,
  WAL_SEAL: 160,
  WAL_TRUNCATE: 200,
  CRASH: 900,
  WAL_REPLAY: 420,
  RECOVER_END: 600,
  BG_JOB_SCHEDULED: 90,
  BG_JOB_RUN: 220,
  WRITE_STALL: 520,
  MEMTABLE_PUT: 140,
  MEMTABLE_FREEZE: 420,
  SST_CREATE: 460,
  SST_DROP: 300,
  COMPACTION_BEGIN: 500,
  COMPACTION_END: 620,
  BLOOM_PROBE: 110,
  SST_PROBE: 170,
  LSM_GET_RESULT: 280,

  ROW_GROUP_OPEN: 180,
  COLUMN_CHUNK_WRITE: 260,
  ROW_GROUP_SEAL: 380,
  ZONE_MAP_SKIP: 220,
  COLUMN_READ: 240,
  VECTOR_BATCH: 150,

  LOG_FILE_OPEN: 180,
  LOG_FILE_SEAL: 260,
  LOG_APPEND: 130,
  HASH_INDEX_SET: 120,
  HASH_PROBE: 200,
  MERGE_BEGIN: 420,
  MERGE_END: 520,
};

/** 时间轴上值得停留的「关键帧」——单步/自动播放会在这些事件上放慢。 */
export const KEYFRAME_EVENTS: ReadonlySet<SimulationEventType> = new Set<SimulationEventType>([
  'PAGE_SPLIT',
  'PAGE_MERGE',
  'REDISTRIBUTE',
  'ROOT_CHANGE',
  'BUFFER_EVICT',
  'SEARCH_RESULT',
  'PLAN_READY',
  'LOOKUP_BACK',
  'INDEX_CREATE',
  'COMMAND_END',
  'TXN_COMMIT',
  'TXN_ABORT',
  'HEAP_PRUNE',
  'VACUUM_END',
  'MEMTABLE_FREEZE',
  'SST_CREATE',
  'COMPACTION_END',
  'LSM_GET_RESULT',
  'WRITE_STALL',
  'CRASH',
  'RECOVER_END',
  'WAL_TRUNCATE',
  'ROW_GROUP_SEAL',
  'ZONE_MAP_SKIP',
  'MERGE_END',
  'LOG_FILE_SEAL',
]);

/** 人类可读的一行事件描述，供事件日志与时间轴 tooltip 使用。 */
export function describeEvent(e: SimulationEvent): string {
  switch (e.type) {
    case 'COMMAND_BEGIN':
      return `▶ ${e.label}`;
    case 'COMMAND_END':
      return `■ ${e.label}${e.note ? ` — ${e.note}` : ''}`;
    case 'NOTE':
      return e.message;
    case 'CONFIG_SET':
      return `配置：order=${e.config.order}，buffer=${e.config.bufferPoolFrames} 帧，fill=${e.config.fillFactor}`;
    case 'TABLE_CREATE':
      return `CREATE TABLE ${e.schema.name} (PK: ${e.schema.primaryKey})`;
    case 'INDEX_CREATE':
      return `创建${e.clustered ? '聚簇' : '二级'}索引 ${e.name}(${e.column})`;
    case 'INDEX_DROP':
      return `删除索引 ${e.indexId}`;
    case 'INDEX_STATS':
      return `统计信息 ${e.indexId}：${e.entries} 条 / ${e.distinct} 个不同键 / [${e.minKey ?? '∅'}, ${e.maxKey ?? '∅'}]`;
    case 'PAGE_ALLOC':
      return `分配 ${e.pageType === 'leaf' ? '叶子' : '内部'}页 #${e.pageId}（${e.indexId} level ${e.level}）`;
    case 'PAGE_FREE':
      return `回收页 #${e.pageId}`;
    case 'PARENT_SET':
      return `页 #${e.pageId} 的父页 → ${e.parentId === null ? 'ROOT' : `#${e.parentId}`}`;
    case 'ROOT_CHANGE':
      return `${e.indexId} 根页 ${e.oldRootId === null ? '创建' : `#${e.oldRootId} →`} #${e.newRootId}，树高 ${e.height}`;
    case 'LEAF_LINK':
      return `叶子链表 #${e.pageId}: prev=${e.prev ?? '∅'}, next=${e.next ?? '∅'}`;
    case 'DESCEND':
      return `在 #${e.pageId} 定位 key=${e.key} → slot ${e.slot} → 子页 #${e.childId}`;
    case 'PAGE_READ':
      return `读取页 #${e.pageId}（${e.purpose}）`;
    case 'RECORD_INSERT':
      return `页 #${e.pageId} slot ${e.slot} 插入记录 key=${e.key}`;
    case 'RECORD_UPDATE':
      return `页 #${e.pageId} slot ${e.slot} 更新记录 key=${e.key}`;
    case 'RECORD_DELETE':
      return `页 #${e.pageId} slot ${e.slot} 删除记录 key=${e.key}`;
    case 'SEPARATOR_INSERT':
      return `内部页 #${e.pageId} 插入分隔键 ${e.key} → 子页 #${e.childId}`;
    case 'SEPARATOR_DELETE':
      return `内部页 #${e.pageId} 移除分隔键 ${e.key}（子页 #${e.childId}）`;
    case 'SEPARATOR_UPDATE':
      return `内部页 #${e.pageId} slot ${e.slot} 分隔键 ${e.oldKey} → ${e.key}`;
    case 'PAGE_SPLIT':
      return `页分裂：#${e.pageId} → #${e.newPageId}，上浮键 ${e.promotedKey}，搬移 ${e.moved.keys.length} 条`;
    case 'PAGE_MERGE':
      return `页合并：#${e.victimPageId} 并入 #${e.pageId}，下沉键 ${e.separatorKey}`;
    case 'REDISTRIBUTE':
      return `兄弟页借位：#${e.fromPageId} → #${e.toPageId}，新分隔键 ${e.newSeparatorKey}`;
    case 'BUFFER_HIT':
      return `Buffer 命中 页 #${e.pageId}（frame ${e.frame}）`;
    case 'BUFFER_MISS':
      return `Buffer 未命中 页 #${e.pageId} → 装入 frame ${e.frame}`;
    case 'BUFFER_EVICT':
      return `${e.reason} 淘汰 页 #${e.pageId}（frame ${e.frame}）${e.wasDirty ? '，脏页需刷盘' : ''}`;
    case 'PAGE_MARK_DIRTY':
      return `页 #${e.pageId} 变脏`;
    case 'PAGE_FLUSH':
      return `刷盘 页 #${e.pageId}（${e.reason}）`;
    case 'SEARCH_BEGIN':
      return `查找开始 key=${e.key}（${e.mode}）`;
    case 'SEARCH_RESULT':
      return e.found ? `命中 key=${e.key} @ 页 #${e.pageId} slot ${e.slot}` : `未找到 key=${e.key}`;
    case 'SCAN_STEP':
      return `扫描 页 #${e.pageId} slot ${e.slot} key=${e.key}${e.emitted ? ' ✓' : ''}`;
    case 'SCAN_END':
      return `扫描结束：${e.rows} 行，触达 ${e.pagesTouched} 页`;
    case 'LOOKUP_BACK':
      return `回表：${e.indexId} 键 ${e.indexKey} → 主键 ${e.primaryKey}`;
    case 'LOOKUP_DONE':
      return e.found ? `回表命中 主键 ${e.primaryKey} @ 页 #${e.toPageId} slot ${e.slot}` : `回表未命中 主键 ${e.primaryKey}`;
    case 'PLAN_READY':
      return `执行计划：${e.plan.chosen}`;
    case 'OPERATOR_OPEN':
      return `算子 ${e.nodeId} ${e.op} 开始（${e.detail}）`;
    case 'OPERATOR_ROW':
      return `算子 ${e.nodeId} 产出 key=${e.key}${e.emitted ? '' : '（被过滤）'}`;
    case 'OPERATOR_CLOSE':
      return `算子 ${e.nodeId} 结束，实际 ${e.actualRows} 行`;

    case 'TXN_BEGIN':
      return `${e.implicit ? '隐式' : 'BEGIN'} 事务 xid=${e.xid}（${
        e.isolation === 'repeatable-read' ? 'REPEATABLE READ' : 'READ COMMITTED'
      }）`;
    case 'TXN_COMMIT':
      return `COMMIT xid=${e.xid}，写入 ${e.writes} 个版本`;
    case 'TXN_ABORT':
      return `ROLLBACK xid=${e.xid}：${e.reason}（${e.writes} 个版本作废）`;
    case 'SNAPSHOT_TAKE':
      return `取${e.scope === 'statement' ? '语句' : '事务'}快照 xid=${e.xid}：[${e.xmin}, ${e.xmax})，活跃 [${e.active.join(',') || '—'}]`;
    case 'HEAP_INSERT':
      return `堆页 #${e.pageId} slot ${e.slot} 写入新版本 key=${e.key}（xmin=${e.xmin}，剩余 ${e.freeSlots} 槽）`;
    case 'HEAP_SET_XMAX':
      return `${e.op === 'delete' ? '删除' : '更新'}：旧版本 (${e.pageId},${e.slot}) 打上 xmax=${e.xmax}${
        e.nextTid ? ` → t_ctid ${formatTid(e.nextTid)}${e.hot ? '（HOT）' : ''}` : ''
      }`;
    case 'LINE_POINTER':
      return `行指针 (${e.pageId},${e.slot}) → ${e.state}${e.redirectTo !== null ? ` → slot ${e.redirectTo}` : ''}`;
    case 'HEAP_FETCH':
      return `回堆取行：${e.indexId} → ${formatTid(e.tid)}${e.chainSteps > 0 ? `，沿链走 ${e.chainSteps} 步` : ''}${
        e.found ? '' : '（无可见版本）'
      }`;
    case 'VISIBILITY_CHECK':
      return `可见性 (${e.pageId},${e.slot}) xmin=${e.xmin} xmax=${e.xmax ?? '∅'} → ${e.visible ? '可见' : '不可见'}：${e.reason}`;
    case 'HEAP_PRUNE':
      return `清理堆页 #${e.pageId}：移除 ${e.removed.length} 个死元组、${e.redirected.length} 个重定向、${e.deadLinePointers.length} 个死指针`;
    case 'VISIBILITY_MAP':
      return `可见性映射：堆页 #${e.pageId} → ${e.allVisible ? 'all-visible（Index Only Scan 可跳过回堆）' : '已失效'}`;
    case 'VACUUM_BEGIN':
      return `VACUUM${e.mode === 'full' ? ' FULL' : ''} 开始，当前死元组 ${e.deadTuples}`;
    case 'VACUUM_END':
      return `VACUUM 结束：清理 ${e.tuplesRemoved} 个死元组 / ${e.indexEntriesRemoved} 条索引项，触达 ${e.pagesTouched} 页，回收 ${e.pagesFreed} 页`;
    case 'BLOAT_STAT':
      return `表统计：活 ${e.liveTuples} / 死 ${e.deadTuples}，堆页 ${e.heapPages}`;

    case 'WAL_APPEND':
      return `WAL 追加 lsn=${e.lsn} @ ${e.segmentId}（${e.op} key=${e.key}，${e.bytes} B）`;
    case 'WAL_SEAL':
      return `WAL 段 ${e.segmentId} 封口（${e.records} 条 / ${e.bytes} B，绑定 ${e.memtableId}），新写入转入 ${e.nextSegmentId}`;
    case 'WAL_TRUNCATE':
      return `回收 WAL 段 ${e.segmentId}（${e.records} 条 / ${e.bytes} B）：${
        e.reason === 'flushed' ? '对应数据已落成 SST，日志不再需要' : '恢复完成后丢弃旧日志'
      }`;
    case 'CRASH':
      return `💥 进程崩溃：内存里的 ${e.lostMemtableEntries} 条 MemTable 记录 + ${e.lostImmutableTables} 个冻结表 + ${e.lostBackgroundJobs} 个后台任务全部丢失；磁盘上还剩 ${e.survivingSsts} 个 SST 与 ${e.retainedWalRecords} 条 WAL`;
    case 'WAL_REPLAY':
      return `重放 WAL 段 ${e.segmentId}：${e.records} 条（lsn ${e.fromLsn}–${e.toLsn}）`;
    case 'RECOVER_END':
      return `恢复完成：重放 ${e.replayedRecords} 条日志、还原 ${e.restoredKeys} 个键${
        e.flushedToSst ? `，并立即落成 ${e.flushedToSst}` : ''
      }`;
    case 'BG_JOB_SCHEDULED':
      return `后台任务入队 #${e.jobId}（${e.kind === 'flush' ? '刷写' : `压实 L${e.level}`}）：${e.reason} —— 积压 ${e.queueDepth}`;
    case 'BG_JOB_RUN':
      return `后台任务执行 #${e.jobId}（${e.kind === 'flush' ? '刷写' : `压实 L${e.level}`}）${
        e.forced ? '【被写停顿逼着同步跑】' : ''
      }，等待了 ${e.waitedSeq} 个事件，剩余积压 ${e.queueDepth}`;
    case 'WRITE_STALL':
      return `⚠ 写停顿（${e.reason === 'immutable-full' ? '冻结队列满' : 'L0 文件过多'}）：${e.note}`;
    case 'MEMTABLE_PUT':
      return `MemTable 写入 key=${e.key}${e.tombstone ? '（墓碑）' : ''}${e.overwrite ? '（覆盖旧版本）' : ''} — ${e.entries}/${e.limit}`;
    case 'MEMTABLE_FREEZE':
      return `MemTable 冻结为 ${e.tableId}（${e.entries.length} 条），等待刷成 SST`;
    case 'SST_CREATE':
      return `生成 SST ${e.sstId} @ L${e.level}：${e.entries.length} 条 [${e.minKey}, ${e.maxKey}]（${e.source === 'flush' ? '刷写' : '压实'}）`;
    case 'SST_DROP':
      return `丢弃 SST ${e.sstId} @ L${e.level}（${e.reason === 'compacted' ? '已被压实' : '过期'}）`;
    case 'COMPACTION_BEGIN':
      return `压实开始 L${e.level} → L${e.targetLevel}，输入 ${e.inputs.length} 个文件：${e.reason}`;
    case 'COMPACTION_END':
      return `压实结束 L${e.level} → L${e.targetLevel}：${e.entriesIn} 条 → ${e.entriesOut} 条，丢弃 ${e.dropped} 条旧版本/墓碑`;
    case 'BLOOM_PROBE':
      return `布隆过滤器 ${e.sstId}：key=${e.key} → ${e.maybe ? `可能存在${e.falsePositive ? '（假阳性）' : ''}` : '一定不存在，跳过'}`;
    case 'SST_PROBE':
      return `读 SST ${e.sstId} @ L${e.level}：key=${e.key} → ${e.found ? (e.tombstone ? '墓碑' : '命中') : '未命中'}`;
    case 'LSM_GET_RESULT':
      return `LSM 读取 key=${e.key} → ${
        e.found ? `命中于 ${e.source === 'sst' ? e.sstId : e.source}` : '不存在'
      }（读 ${e.probes} 个 SST，布隆跳过 ${e.bloomSkips} 个）`;

    case 'ROW_GROUP_OPEN':
      return `打开行组 ${e.rowGroupId}（第 ${e.index} 个，容量 ${e.capacity} 行）`;
    case 'COLUMN_CHUNK_WRITE':
      return `列块 ${e.rowGroupId}.${e.column}：${e.rows} 行 · ${e.encoding} 编码 · ${e.rawBytes}→${e.encodedBytes} B（${(
        e.rawBytes / Math.max(1, e.encodedBytes)
      ).toFixed(1)}×）· ${e.distinct} 个不同值`;
    case 'ROW_GROUP_SEAL':
      return `行组 ${e.rowGroupId} 封口：${e.rows} 行，${e.rawBytes}→${e.encodedBytes} B`;
    case 'ZONE_MAP_SKIP':
      return `跳过行组 ${e.rowGroupId}：${e.column} ∈ [${e.minValue}, ${e.maxValue}]，${e.reason} —— 一个字节都不用读`;
    case 'COLUMN_READ':
      return `读列块 ${e.rowGroupId}.${e.column}：${e.rows} 行 / ${e.bytes} B`;
    case 'VECTOR_BATCH':
      return `向量化批次 ${e.rowGroupId}：${e.rows} 行 → 命中 ${e.matched}`;

    case 'LOG_FILE_OPEN':
      return `新建日志文件 ${e.fileId}（第 ${e.index} 个）`;
    case 'LOG_FILE_SEAL':
      return `日志文件 ${e.fileId} 写满封口（${e.records} 条 / ${e.bytes} B）`;
    case 'LOG_APPEND':
      return `追加写 ${e.fileId}@${e.offset}：key=${e.key}${e.tombstone ? '（墓碑）' : ''}，${e.bytes} B`;
    case 'HASH_INDEX_SET':
      return e.removed
        ? `内存索引摘除 key=${e.key}（桶 ${e.bucket}）—— 现有 ${e.keys} 个键 / ${e.indexBytes} B`
        : `内存索引 key=${e.key} → ${e.fileId}@${e.offset}（桶 ${e.bucket}${e.overwrite ? '，覆盖旧值' : ''}）—— 现有 ${e.keys} 个键 / ${e.indexBytes} B`;
    case 'HASH_PROBE':
      return `哈希探测 key=${e.key} → 桶 ${e.bucket}，链上走 ${e.chainSteps} 步 → ${
        e.found ? `${e.fileId}@${e.offset}（一次磁盘读）` : '不存在（不用碰磁盘）'
      }`;
    case 'MERGE_BEGIN':
      return `合并开始：${e.inputs.length} 个文件，失效占比 ${(e.deadRatio * 100).toFixed(0)}% —— ${e.reason}`;
    case 'MERGE_END':
      return `合并结束：保留 ${e.liveRecords} 条、丢弃 ${e.deadRecords} 条，回收 ${e.reclaimedBytes} B（${e.inputs.length} → ${e.outputs.length} 个文件）`;
    default: {
      const never: never = e;
      return JSON.stringify(never);
    }
  }
}
