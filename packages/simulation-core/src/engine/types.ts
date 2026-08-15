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
  | 'columnar'
  | 'buffer-pool'
  | 'mvcc'
  | 'vacuum'
  | 'transactions'
  | 'compaction'
  | 'bloom-filter'
  | 'wal'
  | 'raft';

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
  | { kind: 'compact'; level?: number };

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
