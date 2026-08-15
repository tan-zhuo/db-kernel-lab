import { BTreeEngine } from './btree-engine';
import { PostgresHeapEngine } from './heap-engine';
import { LsmEngine } from './lsm-engine';
import { ColumnarEngine } from './columnar-engine';
import { KvHashEngine } from './kv-engine';
import type { EngineConfig, EngineFactory, StorageEngine } from './types';

/**
 * 引擎注册表。
 *
 * 每个引擎都实现同一个 `StorageEngine` 接口、只通过事件对外表达状态，
 * 因此可视化层不需要知道自己在画哪一种数据库 —— 它只按 `capabilities` 决定挂哪些视图。
 * 用户插件可以走动态 `import()` 后 `registerEngine()`，协议与内置引擎完全一致。
 */
const registry = new Map<string, EngineFactory>();

export function registerEngine(factory: EngineFactory): void {
  registry.set(factory.id, factory);
}

export function getEngineFactory(id: string): EngineFactory | undefined {
  return registry.get(id);
}

export function listEngines(): EngineFactory[] {
  return [...registry.values()];
}

export function createEngine(id: string, config: EngineConfig): StorageEngine {
  const factory = registry.get(id);
  if (!factory) throw new Error(`[dbkl] unknown engine '${id}'`);
  return factory.create(config);
}

export const INNODB_BTREE_ENGINE_ID = 'innodb-btree';
export const POSTGRES_HEAP_ENGINE_ID = 'postgres-heap';
export const LSM_ENGINE_ID = 'lsm-tree';
export const COLUMNAR_ENGINE_ID = 'columnar';
export const KV_HASH_ENGINE_ID = 'kv-hash';

/** 默认引擎：Phase 1 的 InnoDB 聚簇 B+ 树。 */
export const DEFAULT_ENGINE_ID = INNODB_BTREE_ENGINE_ID;

registerEngine({
  id: INNODB_BTREE_ENGINE_ID,
  label: 'MySQL · InnoDB',
  description: '聚簇 B+ 树：主键索引就是表本身，二级索引存 (列, 主键) 因而需要回表',
  capabilities: ['btree', 'clustered-index', 'secondary-index', 'buffer-pool'],
  create: (config) => new BTreeEngine(config),
});

registerEngine({
  id: POSTGRES_HEAP_ENGINE_ID,
  label: 'PostgreSQL · 堆表 + MVCC',
  description: '无序堆文件 + 独立 B 树索引：任何索引扫描都要回堆一跳，更新写新版本、靠 VACUUM 回收',
  capabilities: ['btree', 'secondary-index', 'heap', 'mvcc', 'vacuum', 'transactions', 'buffer-pool'],
  create: (config) => new PostgresHeapEngine(config),
});

registerEngine({
  id: LSM_ENGINE_ID,
  label: 'LSM-Tree · RocksDB 风格',
  description: '写入只追加进 MemTable，冻结后刷成 SST 并逐层压实；读要自上而下探测，靠布隆过滤器减少读放大',
  capabilities: ['lsm', 'compaction', 'bloom-filter', 'wal'],
  create: (config) => new LsmEngine(config),
});

registerEngine({
  id: COLUMNAR_ENGINE_ID,
  label: '列存 · ClickHouse 风格',
  description: '数据按列存放：同列同质所以压得极狠，查询只读用到的那几列，区间统计还能整块跳过',
  capabilities: ['columnar', 'zone-map', 'vectorized'],
  create: (config) => new ColumnarEngine(config),
});

registerEngine({
  id: KV_HASH_ENGINE_ID,
  label: 'KV · 哈希索引（Bitcask）',
  description: '全部键常驻内存哈希表：点查恒定一次磁盘读，但完全不支持范围扫描，规模被内存卡死',
  capabilities: ['kv', 'hash-index', 'wal'],
  create: (config) => new KvHashEngine(config),
});
