import type { Key } from '@dbkl/shared';
import {
  COST,
  describePredicate,
  type IndexStats,
  type PhysicalPlan,
  type PlanCandidate,
  type PlanNode,
  type Predicate,
} from './types';

export interface PlanInput {
  table: string;
  primaryKey: string;
  predicate: Predicate;
  columns: string[] | '*';
  stats: IndexStats[];
  /** 'auto' 按代价选择；'none' 强制全表扫描；其它值 = 强制使用该索引。 */
  hint?: 'auto' | 'none' | string;
}

/**
 * 极简代价优化器。
 *
 * 它刻意保留了真实优化器的三个特征，方便教学对照：
 *  1. 用**统计信息估算**行数，因此估算行数与实际行数经常不一致；
 *  2. 索引不是永远更快 —— 回表是随机 IO，选择率高时全表扫描反而便宜；
 *  3. 覆盖索引（查询列都在索引里）可以省掉回表，代价断崖式下降。
 */
export function buildPlan(input: PlanInput): PhysicalPlan {
  const { predicate, columns, stats, primaryKey } = input;
  const hint = input.hint ?? 'auto';
  const clustered = stats.find((s) => s.clustered);
  if (!clustered) throw new Error('[dbkl] planner: 缺少聚簇索引统计信息');

  const candidates: PlanCandidate[] = [scanCandidate(clustered, predicate)];

  if (predicate.kind !== 'all') {
    for (const idx of stats) {
      if (idx.column !== predicate.column) continue;
      candidates.push(indexCandidate(idx, clustered, predicate, columns, primaryKey));
    }
  }

  let chosen: PlanCandidate;
  if (hint === 'none') {
    chosen = candidates[0];
    chosen.reason = '用户强制全表扫描';
  } else if (hint !== 'auto') {
    const forced = candidates.find((c) => c.indexId === hint);
    chosen = forced ?? candidates[0];
    chosen.reason = forced ? `用户强制使用索引 ${hint}` : `索引 ${hint} 不适用于该谓词，回退全表扫描`;
  } else {
    chosen = candidates.reduce((best, c) => (c.estCost < best.estCost ? c : best));
    const runnerUp = candidates.filter((c) => c !== chosen).sort((a, b) => a.estCost - b.estCost)[0];
    chosen.reason = runnerUp
      ? `代价最低（${chosen.estCost.toFixed(1)} < ${runnerUp.estCost.toFixed(1)}）`
      : '唯一可行方案';
  }
  for (const c of candidates) c.chosen = c === chosen;

  return {
    root: buildTree(chosen, clustered, predicate, columns, input.table),
    predicate,
    chosen: `${chosen.label} · ${chosen.reason}`,
    candidates,
    columns,
  };
}

function scanCandidate(clustered: IndexStats, predicate: Predicate): PlanCandidate {
  const estRows = Math.max(1, Math.round(clustered.entries * selectivity(predicate, clustered)));
  return {
    label: `全表扫描（聚簇索引 ${clustered.name}）`,
    strategy: 'table-scan',
    indexId: clustered.indexId,
    estRows: predicate.kind === 'all' ? clustered.entries : estRows,
    // 顺序扫描全部叶子页 + 逐行判断谓词
    estCost: clustered.leafPages * COST.pageIO + clustered.entries * COST.rowCpu,
    needsLookup: false,
    chosen: false,
    reason: '',
  };
}

function indexCandidate(
  idx: IndexStats,
  clustered: IndexStats,
  predicate: Predicate,
  columns: string[] | '*',
  primaryKey: string,
): PlanCandidate {
  const estRows = Math.max(1, Math.round(idx.entries * selectivity(predicate, idx)));
  const perLeaf = Math.max(1, idx.entries / Math.max(1, idx.leafPages));
  const leafReads = Math.max(1, Math.ceil(estRows / perLeaf));

  const covering = isCovering(idx, columns, primaryKey);
  const needsLookup = !idx.clustered && !covering;

  const treeCost = Math.max(1, idx.height) * COST.pageIO + leafReads * COST.pageIO + estRows * COST.rowCpu;
  const lookupCost = needsLookup ? estRows * Math.max(1, clustered.height) * COST.pageIO * COST.randomIO : 0;

  return {
    label: idx.clustered
      ? `聚簇索引${predicate.kind === 'eq' ? '点查' : '范围扫描'}（${idx.name}）`
      : `二级索引${predicate.kind === 'eq' ? '点查' : '范围扫描'} ${idx.name}${covering ? '（覆盖索引）' : '（需回表）'}`,
    strategy: predicate.kind === 'eq' ? 'index-seek' : 'index-range',
    indexId: idx.indexId,
    estRows,
    estCost: treeCost + lookupCost,
    needsLookup,
    chosen: false,
    reason: '',
  };
}

/** 查询列是否被索引完全覆盖（索引列 + 主键即可满足投影）。 */
function isCovering(idx: IndexStats, columns: string[] | '*', primaryKey: string): boolean {
  if (idx.clustered) return true;
  if (columns === '*') return false;
  return columns.every((c) => c === idx.column || c === primaryKey);
}

/** 选择率估算：等值用 1/distinct，范围按 min/max 线性插值。 */
function selectivity(predicate: Predicate, idx: IndexStats): number {
  if (predicate.kind === 'all') return 1;
  if (idx.entries === 0) return 1;
  if (predicate.kind === 'eq') {
    if (idx.unique || idx.clustered) return 1 / idx.entries;
    return 1 / Math.max(1, idx.distinct);
  }
  const min = idx.minKey;
  const max = idx.maxKey;
  if (min === null || max === null || max <= min) return 1 / Math.max(1, idx.distinct);
  const span = max - min + 1;
  const width = clampRange(predicate.from, predicate.to, min, max);
  return Math.min(1, Math.max(1 / idx.entries, width / span));
}

function clampRange(from: Key, to: Key, min: Key, max: Key): number {
  const lo = Math.max(from, min);
  const hi = Math.min(to, max);
  return Math.max(0, hi - lo + 1);
}

function buildTree(
  candidate: PlanCandidate,
  clustered: IndexStats,
  predicate: Predicate,
  columns: string[] | '*',
  table: string,
): PlanNode {
  let id = 0;
  const nextId = () => `n${id++}`;
  const cols = columns === '*' ? '*' : columns.join(', ');

  if (candidate.strategy === 'table-scan') {
    const scan: PlanNode = {
      id: nextId(),
      op: 'TableScan',
      detail: `${table} · 聚簇索引 ${clustered.name} 顺序扫描 ${clustered.leafPages} 个叶子页`,
      indexId: clustered.indexId,
      estRows: clustered.entries,
      estCost: clustered.leafPages * COST.pageIO,
      children: [],
    };
    let node = scan;
    if (predicate.kind !== 'all') {
      node = {
        id: nextId(),
        op: 'Filter',
        detail: describePredicate(predicate),
        estRows: candidate.estRows,
        estCost: scan.estCost + clustered.entries * COST.rowCpu,
        children: [scan],
      };
    }
    return {
      id: nextId(),
      op: 'Project',
      detail: cols,
      estRows: node.estRows,
      estCost: node.estCost,
      children: [node],
    };
  }

  const seek: PlanNode = {
    id: nextId(),
    op: candidate.strategy === 'index-seek' ? 'IndexSeek' : 'IndexRangeScan',
    detail: `${candidate.indexId} · ${describePredicate(predicate)}`,
    indexId: candidate.indexId,
    estRows: candidate.estRows,
    estCost: candidate.estCost - (candidate.needsLookup ? candidate.estRows * clustered.height * COST.pageIO * COST.randomIO : 0),
    children: [],
  };
  let node = seek;
  if (candidate.needsLookup) {
    node = {
      id: nextId(),
      op: 'RowIdLookup',
      detail: `回表：按主键回聚簇索引取整行（树高 ${clustered.height}）`,
      indexId: clustered.indexId,
      estRows: candidate.estRows,
      estCost: candidate.estCost,
      children: [seek],
    };
  }
  return {
    id: nextId(),
    op: 'Project',
    detail: cols,
    estRows: node.estRows,
    estCost: node.estCost,
    children: [node],
  };
}

/** 深度优先展开计划树，供面板渲染与执行器遍历。 */
export function flattenPlan(node: PlanNode, depth = 0): { node: PlanNode; depth: number }[] {
  return [{ node, depth }, ...node.children.flatMap((c) => flattenPlan(c, depth + 1))];
}

/** 找到计划里第一个匹配某算子类型的节点。 */
export function findPlanNode(node: PlanNode, op: PlanNode['op']): PlanNode | null {
  if (node.op === op) return node;
  for (const c of node.children) {
    const found = findPlanNode(c, op);
    if (found) return found;
  }
  return null;
}
