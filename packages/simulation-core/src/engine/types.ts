import type { EvictionPolicy, IsolationLevel, Key, Row, TableSchema } from '@dbkl/shared';
import type { SimulationEvent } from '../events';
import type { StructuralSnapshot } from '../state';
import type { Predicate } from '../query/types';

/** 聚簇索引（主键索引）的固定 id。 */
export const PRIMARY_INDEX_ID = 'PRIMARY';

/** 引擎能力声明：可视化层据此决定渲染哪些视图、控制面板显示哪些操作。 */
export type EngineCapability =
  | 'btree'
  | 'clustered-index'
  | 'secondary-index'
  | 'heap'
  | 'lsm'
  | 'buffer-pool'
  | 'mvcc'
  | 'vacuum'
  | 'transactions'
  | 'compaction'
  | 'bloom-filter'
  | 'wal'
  | 'raft'
  // Phase 3 续：列存与哈希索引 KV
  | 'columnar'
  | 'zone-map'
  | 'vectorized'
  | 'kv'
  | 'hash-index'
  // Phase 4：写时复制 B+ 树（LMDB 风格）
  | 'cow'
  | 'snapshot-reader'
  // Phase 4：Bε-树 / 分形树
  | 'message-buffer'
  | 'write-optimized';

export interface EngineConfig {
  /** B+ 树阶数：内部页最多 order 个子指针，叶子页最多 order-1 条记录。 */
  order: number;
  /** 页大小（字节），仅用于填充率/字节占用展示。 */
  pageSize: number;
  /** Buffer Pool 帧数。 */
  bufferPoolFrames: number;
  evictionPolicy: EvictionPolicy;
  /**
   * 分裂点位置（0.5 = 均分；接近 1 = 右倾，模拟 InnoDB 顺序插入优化）。
   * 也影响页的目标填充率。
   */
  fillFactor: number;
  /** 顺序插入时是否启用 InnoDB 风格的「最右页分裂优化」（几乎全部留在左页）。 */
  sequentialInsertOptimization: boolean;
  /** 随机数种子，保证仿真可复现。 */
  seed: number;

  // ——— Phase 2：PostgreSQL 堆表 + MVCC ———————————————————

  /** 一个堆页能容纳的元组数（等价于 PG 的页容量，此处用条数而非字节表达）。 */
  heapTuplesPerPage: number;
  /** 是否启用 HOT 更新：同页有空位且未改索引列时，新版本不写索引。 */
  hotUpdate: boolean;
  /** 隐式（自动提交）事务使用的隔离级别。 */
  isolation: IsolationLevel;
  /** 自动 VACUUM 阈值：死元组占比超过它就在写入后自动清理；0 = 关闭。 */
  autoVacuumRatio: number;

  // ——— Phase 3：LSM-Tree ———————————————————————————————

  /** MemTable 的条目上限，超过即冻结并刷成 L0 的 SST。 */
  memtableLimit: number;
  /** L0 的 SST 文件数达到该值就触发合并到 L1。 */
  l0CompactionTrigger: number;
  /** 每层容量相对上一层的放大倍数（leveled 压实的经典参数）。 */
  levelFanout: number;
  /** 布隆过滤器每个键分配的位数：越大假阳性越低，内存越多。0 = 不用布隆过滤器。 */
  bloomBitsPerKey: number;
  /** 压实策略：leveled（读放大低、写放大高）vs tiered（相反）。 */
  compactionStyle: 'leveled' | 'tiered';
  /**
   * 刷写与压实是否走后台任务队列。
   *
   * `true` = 真实行为：写路径只把 MemTable 冻结、往队列里塞一个任务就返回，
   * 真正的刷盘/压实由「后台线程」在命令间隙推进。压实追不上写入时任务会积压，
   * 积压到阈值就**写停顿**。
   * `false` = 教学用的同步模式：写路径当场把活全干完，永远没有积压，便于对照。
   */
  backgroundCompaction: boolean;
  /** 每条命令结束时后台最多推进几个任务（相当于后台线程的吞吐）。 */
  maxBackgroundJobs: number;
  /** 已冻结但还没刷盘的 MemTable 上限；超过就写停顿，等一个刷盘做完。 */
  maxImmutableMemtables: number;
  /** L0 文件数达到它就写停顿（对应 RocksDB 的 level0_stop_writes_trigger）。 */
  l0StopTrigger: number;

  // ——— Phase 3 续：列存 ———————————————————————————————

  /** 一个行组（row group / 数据块）装多少行 —— 列存的最小 IO 与剪枝单位。 */
  rowGroupSize: number;
  /** 是否为每个列块记录 min/max 区间统计，用来整块跳过。 */
  zoneMaps: boolean;
  /** 向量化执行一批处理多少行。 */
  vectorBatchSize: number;
  /** 列编码策略：auto 会按列的基数自动在字典/RLE/原样之间选。 */
  columnEncoding: 'auto' | 'plain' | 'dictionary' | 'rle';

  // ——— Phase 3 续：哈希索引 KV ————————————————————————

  /** 一个日志文件写满多少条就切下一个。 */
  kvLogFileRecords: number;
  /** 内存哈希表的桶数（决定冲突链长度）。 */
  kvHashBuckets: number;
  /** 失效数据占比超过它就触发合并（回收空间）。 */
  kvMergeThreshold: number;

  // ——— Phase 4：Bε-树 / 分形树 ————————————————————————

  /**
   * 内部节点的消息缓冲能放多少条消息。
   *
   * 它就是 Bε-树里那个 ε 旋钮的具体化：
   * 调到 **0** 退化成普通 B+ 树（写立刻下降到叶子），调得越大写越快、读越慢。
   */
  fractalBufferCapacity: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  order: 4,
  pageSize: 16384,
  bufferPoolFrames: 8,
  evictionPolicy: 'LRU',
  fillFactor: 0.5,
  sequentialInsertOptimization: false,
  seed: 20260814,

  heapTuplesPerPage: 4,
  hotUpdate: true,
  isolation: 'read-committed',
  autoVacuumRatio: 0,

  memtableLimit: 8,
  l0CompactionTrigger: 4,
  levelFanout: 4,
  bloomBitsPerKey: 10,
  compactionStyle: 'leveled',
  backgroundCompaction: true,
  maxBackgroundJobs: 2,
  maxImmutableMemtables: 2,
  l0StopTrigger: 8,

  rowGroupSize: 8,
  zoneMaps: true,
  vectorBatchSize: 4,
  columnEncoding: 'auto',

  kvLogFileRecords: 8,
  kvHashBuckets: 16,
  kvMergeThreshold: 0.4,

  fractalBufferCapacity: 8,
};

/** 用户级命令：worker 的输入单元，也是会话持久化的最小单位。 */
export type Command =
  | { kind: 'create_table'; schema: TableSchema }
  | { kind: 'create_index'; name: string; column: string }
  | { kind: 'drop_index'; name: string }
  | { kind: 'insert'; key: Key; row?: Row }
  | { kind: 'bulk_insert'; count: number; pattern: 'sequential' | 'random' | 'reverse'; start?: number; max?: number }
  | { kind: 'update'; key: Key; row: Row }
  | { kind: 'delete'; key: Key }
  | { kind: 'search'; key: Key }
  | { kind: 'range_scan'; from: Key; to: Key }
  | { kind: 'full_scan' }
  | {
      kind: 'query';
      predicate: Predicate;
      /** 投影列；`*` 表示整行（会触发回表）。 */
      columns?: string[] | '*';
      /** 'auto' 交给优化器；'none' 强制全表扫描；其它值 = 强制使用该索引。 */
      hint?: 'auto' | 'none' | string;
    }
  | { kind: 'flush_all' }
  | { kind: 'configure'; patch: Partial<EngineConfig> }
  // —— Phase 2：显式事务与 VACUUM（PostgreSQL 堆表引擎） ——
  | { kind: 'begin_txn'; isolation?: IsolationLevel }
  | { kind: 'commit_txn' }
  | { kind: 'abort_txn' }
  | { kind: 'vacuum'; full?: boolean }
  /**
   * 切换「当前会话」。
   *
   * 仿真是单线程的，但隔离级别的差异必须靠**并发**才能演示：
   * 会话 A 开着事务不提交，切到会话 B 写入并提交，再切回 A 重新查询 ——
   * READ COMMITTED 会看到新数据，REPEATABLE READ 不会。
   */
  | { kind: 'use_session'; session: string }
  // —— Phase 3：LSM 的手动刷写与压实 ——
  | { kind: 'flush_memtable' }
  | { kind: 'compact'; level?: number }
  /** 手动推进后台任务队列（相当于「给后台线程一点 CPU」）。 */
  | { kind: 'run_background'; jobs?: number }
  /**
   * 模拟进程崩溃并从 WAL 恢复。
   *
   * MemTable 与冻结队列都在内存里，崩溃后一起消失；只有已经落成 SST 的部分还在磁盘上。
   * 恢复靠重放 WAL —— 这正是「为什么写之前必须先写日志」的唯一实证。
   */
  | { kind: 'crash' };

/**
 * 存储引擎统一接口（纯前端，全部在 Worker 内执行）。
 *
 * 约定：`execute` 只允许通过返回的事件数组对外暴露状态变化；
 * `snapshot()` 仅用于测试与调试断言（校验 reducer 与引擎是否一致），
 * 可视化层不得直接消费 snapshot。
 */
export interface StorageEngine {
  readonly name: string;
  readonly capabilities: readonly EngineCapability[];
  readonly config: EngineConfig;

  execute(command: Command): SimulationEvent[];
  /** 供测试断言：引擎内部状态投影成与 reducer 结果可比较的结构快照。 */
  snapshot(): StructuralSnapshot;
  /** 已产生的事件总数（等于下一个事件的 seq）。 */
  readonly eventCount: number;
}

export interface EngineFactory {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly capabilities: readonly EngineCapability[];
  create(config: EngineConfig): StorageEngine;
}
