import { BTreeEngine } from './btree-engine';
import type { EngineConfig, EngineFactory, StorageEngine } from './types';

/**
 * 引擎注册表。Phase 0 只有一个 B+ 树引擎；
 * Postgres 堆表 / LSM / 列存在后续 Phase 以同样方式注册（也支持动态 import 的用户插件）。
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

registerEngine({
  id: INNODB_BTREE_ENGINE_ID,
  label: 'InnoDB 风格聚簇 B+ 树',
  description: '聚簇索引 + 页分裂/合并 + Buffer Pool（LRU / CLOCK）',
  capabilities: ['btree', 'clustered-index', 'buffer-pool'],
  create: (config) => new BTreeEngine(config),
});
