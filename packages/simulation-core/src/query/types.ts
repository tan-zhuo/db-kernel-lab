import type { Key } from '@dbkl/shared';

/**
 * 查询谓词（Phase 1 的最小子集）。
 * 对应 SQL：`WHERE col = v` / `WHERE col BETWEEN a AND b` / 无条件。
 */
export type Predicate =
  | { kind: 'all' }
  | { kind: 'eq'; column: string; value: Key }
  | { kind: 'range'; column: string; from: Key; to: Key };

export type PlanOp =
  // InnoDB 风格（聚簇索引世界）
  | 'Project'
  | 'Filter'
  | 'TableScan'
  | 'IndexSeek'
  | 'IndexRangeScan'
  | 'RowIdLookup'
  // PostgreSQL 风格（堆表世界）
  | 'SeqScan'
  | 'IndexScan'
  | 'IndexOnlyScan'
  | 'HeapFetch';

export interface PlanNode {
  id: string;
  op: PlanOp;
  /** 一行说明，例如 `idx_score (score = 42)`。 */
  detail: string;
  indexId?: string;
  /** 优化器估算的输出行数与累计代价。 */
  estRows: number;
  estCost: number;
  children: PlanNode[];
}

export interface PlanCandidate {
  label: string;
  strategy: 'table-scan' | 'index-seek' | 'index-range' | 'seq-scan' | 'index-scan' | 'index-only-scan';
  indexId?: string;
  estRows: number;
  estCost: number;
  /** 是否需要回表（覆盖索引则不需要）。 */
  needsLookup: boolean;
  chosen: boolean;
  reason: string;
}

export interface PhysicalPlan {
  root: PlanNode;
  predicate: Predicate;
  /** 选中方案的一句话说明，显示在事件日志与计划面板顶部。 */
  chosen: string;
  candidates: PlanCandidate[];
  /** 投影列，`*` 表示全部列。 */
  columns: string[] | '*';
}

/** 优化器可见的索引统计信息（模拟 ANALYZE 收集的结果）。 */
export interface IndexStats {
  indexId: string;
  name: string;
  column: string;
  clustered: boolean;
  unique: boolean;
  height: number;
  leafPages: number;
  entries: number;
  /** 不同键值的数量，用于等值选择率估算。 */
  distinct: number;
  minKey: Key | null;
  maxKey: Key | null;
}

/** 代价模型常量（单位是「等效页 IO」，纯教学用途）。 */
export const COST = {
  /** 一次逻辑页读。 */
  pageIO: 1,
  /** 处理一行的 CPU 代价。 */
  rowCpu: 0.02,
  /** 回表的一次随机读放大系数：随机 IO 比顺序 IO 贵。 */
  randomIO: 1.4,
} as const;

export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case 'all':
      return '无条件（全表）';
    case 'eq':
      return `${p.column} = ${p.value}`;
    case 'range':
      return `${p.column} BETWEEN ${p.from} AND ${p.to}`;
  }
}

/** 把谓词渲染成 SQL 片段，便于面板展示。 */
export function predicateToSql(p: Predicate, table: string, columns: string[] | '*'): string {
  const cols = columns === '*' ? '*' : columns.join(', ');
  const where = p.kind === 'all' ? '' : ` WHERE ${describePredicate(p)}`;
  return `SELECT ${cols} FROM ${table}${where};`;
}

export function matchesPredicate(p: Predicate, value: Key | undefined): boolean {
  if (p.kind === 'all') return true;
  if (value === undefined) return false;
  if (p.kind === 'eq') return value === p.value;
  return value >= p.from && value <= p.to;
}
