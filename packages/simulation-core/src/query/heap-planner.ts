import {
  COST,
  describePredicate,
  type IndexStats,
  type PhysicalPlan,
  type PlanCandidate,
  type PlanNode,
  type Predicate,
} from './types';

/**
 * 堆表世界的优化器（PostgreSQL 风格）。
 *
 * 与 InnoDB 版（`planner.ts`）的**根本区别**只有一条：这里没有聚簇索引。
 * 表就是一堆无序的堆页，所有索引都指向 TID，因此：
 *
 *  1. 「全表扫描」= Seq Scan，代价按**堆页数**算，与任何索引无关；
 *  2. 任何索引扫描都必须再去堆里取一次行（Index Scan = 索引 + Heap Fetch），
 *     哪怕是主键查询 —— 这正是 PostgreSQL 主键点查比 InnoDB 多一跳的原因；
 *  3. 只有当查询列全在索引里、**且**目标页在可见性映射里被标记为 all-visible 时，
 *     才能退化成 Index Only Scan 省掉那一跳。所以刚写完还没 VACUUM 的表，
 *     Index Only Scan 也会退回去读堆。
 */
export interface HeapPlanInput {
  table: string;
  primaryKey: string;
  predicate: Predicate;
  columns: string[] | '*';
  stats: IndexStats[];
  heap: {
    pages: number;
    liveTuples: number;
    deadTuples: number;
    /** 被可见性映射标记为 all-visible 的页占比（0..1），决定 Index Only Scan 能省掉多少堆访问。 */
    allVisibleRatio: number;
  };
  hint?: 'auto' | 'none' | string;
}

export function buildHeapPlan(input: HeapPlanInput): PhysicalPlan {
  const { predicate, columns, stats, heap, primaryKey } = input;
  const hint = input.hint ?? 'auto';

  const candidates: PlanCandidate[] = [seqScanCandidate(heap, predicate, stats)];
  if (predicate.kind !== 'all') {
    for (const idx of stats) {
      if (idx.column !== predicate.column) continue;
      candidates.push(indexScanCandidate(idx, heap, predicate, columns, primaryKey));
    }
  }

  let chosen: PlanCandidate;
  if (hint === 'none') {
    chosen = candidates[0];
    chosen.reason = '用户强制顺序扫描';
  } else if (hint !== 'auto') {
    const forced = candidates.find((c) => c.indexId === hint);
    chosen = forced ?? candidates[0];
    chosen.reason = forced ? `用户强制使用索引 ${hint}` : `索引 ${hint} 不适用于该谓词，回退顺序扫描`;
  } else {
    chosen = candidates.reduce((best, c) => (c.estCost < best.estCost ? c : best));
    const runnerUp = candidates.filter((c) => c !== chosen).sort((a, b) => a.estCost - b.estCost)[0];
    chosen.reason = runnerUp
      ? `代价最低（${chosen.estCost.toFixed(1)} < ${runnerUp.estCost.toFixed(1)}）`
      : '唯一可行方案';
  }
  for (const c of candidates) c.chosen = c === chosen;

  return {
    root: buildTree(chosen, heap, predicate, columns, input.table),
    predicate,
    chosen: `${chosen.label} · ${chosen.reason}`,
    candidates,
    columns,
  };
}

/**
 * Seq Scan 的代价里**包含死元组**：膨胀的表扫得更慢，
 * 这就是 VACUUM 之后同一条查询变快的原因，指标面板可以直接对比。
 */
function seqScanCandidate(
  heap: HeapPlanInput['heap'],
  predicate: Predicate,
  stats: IndexStats[],
): PlanCandidate {
  const idx = stats.find((s) => s.column === (predicate.kind === 'all' ? '' : predicate.column));
  const estRows =
    predicate.kind === 'all'
      ? heap.liveTuples
      : Math.max(1, Math.round(heap.liveTuples * selectivity(predicate, idx, heap.liveTuples)));
  const scanned = heap.liveTuples + heap.deadTuples;
  return {
    label: `顺序扫描 Seq Scan（${heap.pages} 个堆页）`,
    strategy: 'seq-scan',
    estRows,
    estCost: Math.max(1, heap.pages) * COST.pageIO + scanned * COST.rowCpu,
    needsLookup: false,
    chosen: false,
    reason: '',
  };
}

function indexScanCandidate(
  idx: IndexStats,
  heap: HeapPlanInput['heap'],
  predicate: Predicate,
  columns: string[] | '*',
  primaryKey: string,
): PlanCandidate {
  const estRows = Math.max(1, Math.round(idx.entries * selectivity(predicate, idx, idx.entries)));
  const perLeaf = Math.max(1, idx.entries / Math.max(1, idx.leafPages));
  const leafReads = Math.max(1, Math.ceil(estRows / perLeaf));
  const treeCost = Math.max(1, idx.height) * COST.pageIO + leafReads * COST.pageIO + estRows * COST.rowCpu;

  const covering = isCovering(idx, columns, primaryKey);
  // Index Only Scan 仍然要为「不是 all-visible 的页」回堆一次。
  const heapVisitRatio = covering ? 1 - heap.allVisibleRatio : 1;
  const heapCost = estRows * heapVisitRatio * COST.pageIO * COST.randomIO;

  const indexOnly = covering && heap.allVisibleRatio > 0;
  return {
    label: indexOnly
      ? `Index Only Scan ${idx.name}（可见性映射覆盖 ${(heap.allVisibleRatio * 100).toFixed(0)}%）`
      : `Index Scan ${idx.name}（索引 → 堆，每行一跳）`,
    strategy: indexOnly ? 'index-only-scan' : 'index-scan',
    indexId: idx.indexId,
    estRows,
    estCost: treeCost + heapCost,
    needsLookup: heapVisitRatio > 0,
    chosen: false,
    reason: '',
  };
}

function isCovering(idx: IndexStats, columns: string[] | '*', primaryKey: string): boolean {
  if (columns === '*') return false;
  return columns.every((c) => c === idx.column || c === primaryKey);
}

function selectivity(predicate: Predicate, idx: IndexStats | undefined, total: number): number {
  if (predicate.kind === 'all') return 1;
  if (!idx || idx.entries === 0 || total === 0) return 1;
  if (predicate.kind === 'eq') {
    return idx.unique ? 1 / Math.max(1, idx.entries) : 1 / Math.max(1, idx.distinct);
  }
  const { minKey: min, maxKey: max } = idx;
  if (min === null || max === null || max <= min) return 1 / Math.max(1, idx.distinct);
  const span = max - min + 1;
  const lo = Math.max(predicate.from, min);
  const hi = Math.min(predicate.to, max);
  const width = Math.max(0, hi - lo + 1);
  return Math.min(1, Math.max(1 / idx.entries, width / span));
}

function buildTree(
  candidate: PlanCandidate,
  heap: HeapPlanInput['heap'],
  predicate: Predicate,
  columns: string[] | '*',
  table: string,
): PlanNode {
  let id = 0;
  const nextId = () => `n${id++}`;
  const cols = columns === '*' ? '*' : columns.join(', ');

  if (candidate.strategy === 'seq-scan') {
    const scan: PlanNode = {
      id: nextId(),
      op: 'SeqScan',
      detail: `${table} · 顺序读 ${heap.pages} 个堆页（含 ${heap.deadTuples} 个死元组）`,
      estRows: heap.liveTuples,
      estCost: Math.max(1, heap.pages) * COST.pageIO,
      children: [],
    };
    let node: PlanNode = scan;
    if (predicate.kind !== 'all') {
      node = {
        id: nextId(),
        op: 'Filter',
        detail: describePredicate(predicate),
        estRows: candidate.estRows,
        estCost: scan.estCost + (heap.liveTuples + heap.deadTuples) * COST.rowCpu,
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

  const indexOnly = candidate.strategy === 'index-only-scan';
  const scan: PlanNode = {
    id: nextId(),
    op: indexOnly ? 'IndexOnlyScan' : 'IndexScan',
    detail: `${candidate.indexId} · ${describePredicate(predicate)}`,
    indexId: candidate.indexId,
    estRows: candidate.estRows,
    estCost: candidate.estCost * 0.4,
    children: [],
  };
  let node: PlanNode = scan;
  if (candidate.needsLookup) {
    node = {
      id: nextId(),
      op: 'HeapFetch',
      detail: indexOnly
        ? `回堆取行：可见性映射未覆盖的 ${(100 - heap.allVisibleRatio * 100).toFixed(0)}% 页`
        : '回堆取行：按 TID 读堆页并做可见性判断',
      estRows: candidate.estRows,
      estCost: candidate.estCost,
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
