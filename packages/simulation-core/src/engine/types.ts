import type { EvictionPolicy, Key, Row, TableSchema } from '@dbkl/shared';
import type { SimulationEvent } from '../events';
import type { StructuralSnapshot } from '../state';

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
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  order: 4,
  pageSize: 16384,
  bufferPoolFrames: 8,
  evictionPolicy: 'LRU',
  fillFactor: 0.5,
  sequentialInsertOptimization: false,
  seed: 20260814,
};

/** 用户级命令：worker 的输入单元，也是会话持久化的最小单位。 */
export type Command =
  | { kind: 'create_table'; schema: TableSchema }
  | { kind: 'insert'; key: Key; row?: Row }
  | { kind: 'bulk_insert'; count: number; pattern: 'sequential' | 'random' | 'reverse'; start?: number; max?: number }
  | { kind: 'update'; key: Key; row: Row }
  | { kind: 'delete'; key: Key }
  | { kind: 'search'; key: Key }
  | { kind: 'range_scan'; from: Key; to: Key }
  | { kind: 'full_scan' }
  | { kind: 'flush_all' }
  | { kind: 'configure'; patch: Partial<EngineConfig> };

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
