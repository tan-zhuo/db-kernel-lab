import { flattenPlan, type PlanNode } from '@dbkl/simulation-core';
import { useLabState } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

const OP_COLOR: Record<PlanNode['op'], string> = {
  Project: 'text-mute-200',
  Filter: 'text-amber-500',
  TableScan: 'text-orange-500',
  IndexSeek: 'text-teal-500',
  IndexRangeScan: 'text-teal-500',
  RowIdLookup: 'text-violet-400',
};

/**
 * 执行计划面板：物理算子树 + 估算行数 vs 实际行数 + 候选方案代价对比。
 *
 * 行数随时间轴游标实时增长 —— 拖回去就能看到某个算子「正在吐行」。
 */
export function PlanPanel() {
  const state = useLabState();
  const plan = state.plan;
  if (!plan) return null;

  const rows = flattenPlan(plan.root);

  return (
    <Panel title="执行计划" subtitle={plan.chosen}>
      <div className="flex flex-col gap-2" data-testid="plan-panel">
        <div className="overflow-hidden rounded-md border border-ink-700">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-ink-800 text-mute-400">
                <th className="px-2 py-1 text-left font-medium">算子</th>
                <th className="px-2 py-1 text-right font-medium">估算</th>
                <th className="px-2 py-1 text-right font-medium">实际</th>
                <th className="px-2 py-1 text-right font-medium">代价</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, depth }) => {
                const stat = state.operators[node.id];
                const actual = stat?.finished ? stat.rows : stat?.running ? stat.rows : null;
                const off = actual !== null && node.estRows > 0 ? actual / node.estRows : null;
                return (
                  <tr
                    key={node.id}
                    className={`border-t border-ink-700/70 ${stat?.running ? 'bg-accent-500/10' : ''}`}
                    title={node.detail}
                  >
                    <td className="px-2 py-1">
                      <span className="num" style={{ paddingLeft: depth * 10 }}>
                        {depth > 0 && <span className="text-mute-400">└ </span>}
                        <span className={OP_COLOR[node.op]}>{node.op}</span>
                      </span>
                      <div className="num truncate pl-3 text-[10px] text-mute-400" style={{ paddingLeft: depth * 10 + 12 }}>
                        {node.detail}
                      </div>
                    </td>
                    <td className="num px-2 py-1 text-right text-mute-400">{node.estRows}</td>
                    <td
                      className={`num px-2 py-1 text-right ${
                        off === null ? 'text-mute-400' : off > 3 || off < 0.34 ? 'text-red-500' : 'text-green-500'
                      }`}
                    >
                      {actual === null ? '—' : actual}
                    </td>
                    <td className="num px-2 py-1 text-right text-mute-400">{node.estCost.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">候选方案</div>
          <ul className="flex flex-col gap-1">
            {plan.candidates.map((c) => (
              <li key={c.label} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className={c.chosen ? 'text-accent-400' : 'text-mute-400'}>
                  {c.chosen ? '✓ ' : '　'}
                  {c.label}
                </span>
                <span className="num shrink-0 text-mute-400">
                  {c.estRows} 行 / 代价 {c.estCost.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] leading-relaxed text-mute-400/80">
            代价单位是「等效页 IO」：顺序读 1，回表按随机读 ×1.4 并乘以聚簇索引树高。
            估算行数来自统计信息，和实际行数不一致正是优化器选错计划的根源。
          </p>
        </div>
      </div>
    </Panel>
  );
}
