import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { PRIMARY_INDEX_ID, orderedIndexes, pageCountByIndex } from '@dbkl/simulation-core';
import { useCapability, useLabState, useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

/**
 * 索引管理：建二级索引会当场扫描聚簇索引灌数据，
 * 之后每一次 DML 都要同时维护它 —— 写放大在指标面板里立刻可见。
 */
export function IndexPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const hasHeap = useCapability('heap');
  const indexes = orderedIndexes(state);

  const indexable = (state.schema?.columns ?? []).filter(
    (c) => c.type !== 'varchar' && c.name !== state.schema?.primaryKey,
  );
  const [column, setColumn] = useState(indexable[0]?.name ?? '');
  const activeColumn = indexable.some((c) => c.name === column) ? column : (indexable[0]?.name ?? '');
  const name = activeColumn ? `idx_${activeColumn}` : '';
  const exists = indexes.some((ix) => ix.id === name);

  return (
    <Panel
      title="索引"
      subtitle={
        hasHeap
          ? `${indexes.length} 棵 B 树（全部指向 TID，主键索引也不例外）`
          : `${indexes.length} 棵 B+ 树（含聚簇索引）`
      }
    >
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {indexes.map((ix) => {
            const pages = pageCountByIndex(state, ix.id);
            const stale = ix.stats !== null && ix.stats.entries !== ix.entries;
            return (
              <li
                key={ix.id}
                className="flex items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-850/60 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`num text-[12px] ${
                        ix.clustered || ix.id === PRIMARY_INDEX_ID ? 'text-teal-500' : 'text-violet-400'
                      }`}
                    >
                      {ix.name}
                    </span>
                    <span className="rounded bg-ink-700 px-1 text-[9px] text-mute-300">
                      {ix.clustered ? '聚簇' : ix.id === PRIMARY_INDEX_ID ? '主键' : '二级'}
                    </span>
                  </div>
                  <div className="num text-[10.5px] text-mute-400">
                    ({ix.column}) · {ix.entries} 条 · 树高 {ix.height} · {pages} 页
                    {ix.stats && (
                      <span className={stale ? 'text-amber-500' : ''}>
                        {' '}
                        · 统计 {ix.stats.entries}/{ix.stats.distinct} 不同值{stale ? '（已过期）' : ''}
                      </span>
                    )}
                  </div>
                </div>
                {!ix.clustered && ix.id !== PRIMARY_INDEX_ID && (
                  <button
                    className="dbkl-btn shrink-0"
                    disabled={busy}
                    title="删除索引"
                    onClick={() => void run({ kind: 'drop_index', name: ix.id })}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {indexable.length === 0 ? (
          <p className="text-[11px] text-mute-400">当前表没有可建索引的数值列（Phase 1 的索引键只支持数值列）。</p>
        ) : (
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Field label="在列上建二级索引" hint={name}>
              <select className="dbkl-input" value={activeColumn} onChange={(e) => setColumn(e.target.value)}>
                {indexable.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}（{c.type}）
                  </option>
                ))}
              </select>
            </Field>
            <button
              data-testid="create-index"
              className="dbkl-btn dbkl-btn-primary"
              disabled={busy || exists || !activeColumn}
              onClick={() => void run({ kind: 'create_index', name, column: activeColumn })}
            >
              <Plus size={13} /> {exists ? '已存在' : '创建'}
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
