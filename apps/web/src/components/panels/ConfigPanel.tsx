import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { EngineConfig } from '@dbkl/simulation-core';
import { useCapability, useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

/**
 * 参数实验面板。
 *
 * 阶数、堆页容量、MemTable 上限这类参数会改变已有结构的物理布局，
 * 所以修改后必须重置重建 —— 这也正是「参数敏感性实验」的正确做法：
 * 同一组命令 + 不同参数 = 可对比的两次运行。
 *
 * 显示哪些旋钮由引擎能力决定：LSM 引擎不需要 B+ 树阶数，InnoDB 不需要 MemTable 上限。
 */
export function ConfigPanel() {
  const config = useSimStore((s) => s.config);
  const resetEngine = useSimStore((s) => s.resetEngine);
  const busy = useSimStore((s) => s.busy);
  const hasBTree = useCapability('btree');
  const hasHeap = useCapability('heap');
  const hasLsm = useCapability('lsm');
  const hasBufferPool = useCapability('buffer-pool');
  const hasTransactions = useCapability('transactions');
  const [draft, setDraft] = useState<EngineConfig>(config);

  // 换引擎会带来一套新的推荐参数，草稿要跟着走，否则「应用并重置」会把它改回去。
  useEffect(() => setDraft(config), [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const patch = (p: Partial<EngineConfig>) => setDraft({ ...draft, ...p });

  return (
    <Panel
      title="引擎参数"
      subtitle="修改后需重置以重建结构"
      collapsible
      defaultOpen={false}
      right={
        <button className={`dbkl-btn ${dirty ? 'dbkl-btn-primary' : ''}`} disabled={busy} onClick={() => void resetEngine(draft)}>
          <RotateCcw size={13} /> 应用并重置
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        {hasBTree && (
          <Field label="B+ 树阶数 order" hint={`叶子 ${Math.max(1, draft.order - 1)} 槽`}>
            <input
              className="dbkl-input"
              type="number"
              min={3}
              max={32}
              value={draft.order}
              onChange={(e) => patch({ order: Math.min(32, Math.max(3, Number(e.target.value))) })}
            />
          </Field>
        )}
        {hasBufferPool && (
          <Field label="Buffer Pool 帧数">
            <input
              className="dbkl-input"
              type="number"
              min={1}
              max={64}
              value={draft.bufferPoolFrames}
              onChange={(e) => patch({ bufferPoolFrames: Math.min(64, Math.max(1, Number(e.target.value))) })}
            />
          </Field>
        )}
        {hasBufferPool && (
          <Field label="淘汰策略">
            <select
              className="dbkl-input"
              value={draft.evictionPolicy}
              onChange={(e) => patch({ evictionPolicy: e.target.value as EngineConfig['evictionPolicy'] })}
            >
              <option value="LRU">LRU</option>
              <option value="CLOCK">CLOCK</option>
            </select>
          </Field>
        )}
        {hasBTree && (
          <Field label="页大小" hint="仅用于字节估算">
            <select className="dbkl-input" value={draft.pageSize} onChange={(e) => patch({ pageSize: Number(e.target.value) })}>
              <option value={4096}>4 KB</option>
              <option value={8192}>8 KB</option>
              <option value={16384}>16 KB (InnoDB)</option>
              <option value={32768}>32 KB</option>
            </select>
          </Field>
        )}

        {hasBTree && (
          <div className="col-span-2">
            <Field label="分裂点 / 填充因子" hint={draft.fillFactor.toFixed(2)}>
              <input
                type="range"
                min={0.2}
                max={0.95}
                step={0.05}
                value={draft.fillFactor}
                onChange={(e) => patch({ fillFactor: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
        {hasBTree && !hasHeap && (
          <label className="col-span-2 flex items-center gap-2 text-[11px] text-mute-300">
            <input
              type="checkbox"
              checked={draft.sequentialInsertOptimization}
              onChange={(e) => patch({ sequentialInsertOptimization: e.target.checked })}
            />
            顺序插入右倾优化（InnoDB 最右页分裂）
          </label>
        )}

        {/* —— PostgreSQL 堆表 —— */}
        {hasHeap && (
          <Field label="堆页容量" hint="每页行指针数">
            <input
              className="dbkl-input"
              type="number"
              min={1}
              max={32}
              value={draft.heapTuplesPerPage}
              onChange={(e) => patch({ heapTuplesPerPage: Math.min(32, Math.max(1, Number(e.target.value))) })}
            />
          </Field>
        )}
        {hasTransactions && (
          <Field label="默认隔离级别" hint="隐式事务用它">
            <select
              className="dbkl-input"
              value={draft.isolation}
              onChange={(e) => patch({ isolation: e.target.value as EngineConfig['isolation'] })}
            >
              <option value="read-committed">READ COMMITTED</option>
              <option value="repeatable-read">REPEATABLE READ</option>
            </select>
          </Field>
        )}
        {hasHeap && (
          <label className="col-span-2 flex items-center gap-2 text-[11px] text-mute-300">
            <input type="checkbox" checked={draft.hotUpdate} onChange={(e) => patch({ hotUpdate: e.target.checked })} />
            启用 HOT 更新（同页 + 不改索引列 ⇒ 新版本不写索引）
          </label>
        )}

        {/* —— LSM —— */}
        {hasLsm && (
          <>
            <Field label="MemTable 上限" hint="条目数，满了就刷">
              <input
                className="dbkl-input"
                type="number"
                min={1}
                max={64}
                value={draft.memtableLimit}
                onChange={(e) => patch({ memtableLimit: Math.min(64, Math.max(1, Number(e.target.value))) })}
              />
            </Field>
            <Field label="L0 压实触发" hint="文件数">
              <input
                className="dbkl-input"
                type="number"
                min={1}
                max={16}
                value={draft.l0CompactionTrigger}
                onChange={(e) => patch({ l0CompactionTrigger: Math.min(16, Math.max(1, Number(e.target.value))) })}
              />
            </Field>
            <Field label="层容量倍数" hint="每层是上一层的几倍">
              <input
                className="dbkl-input"
                type="number"
                min={2}
                max={16}
                value={draft.levelFanout}
                onChange={(e) => patch({ levelFanout: Math.min(16, Math.max(2, Number(e.target.value))) })}
              />
            </Field>
            <Field label="布隆位数/键" hint={draft.bloomBitsPerKey === 0 ? '关闭' : `≈${falsePositive(draft.bloomBitsPerKey)}`}>
              <input
                className="dbkl-input"
                type="number"
                min={0}
                max={24}
                value={draft.bloomBitsPerKey}
                onChange={(e) => patch({ bloomBitsPerKey: Math.min(24, Math.max(0, Number(e.target.value))) })}
              />
            </Field>
            <div className="col-span-2">
              <Field label="压实策略" hint="读放大 vs 写放大">
                <select
                  className="dbkl-input"
                  value={draft.compactionStyle}
                  onChange={(e) => patch({ compactionStyle: e.target.value as EngineConfig['compactionStyle'] })}
                >
                  <option value="leveled">leveled（层内不重叠，读放大低）</option>
                  <option value="tiered">tiered（整层归并，层内可重叠）</option>
                </select>
              </Field>
            </div>
          </>
        )}

        <Field label="随机种子" hint="保证可复现">
          <input className="dbkl-input" type="number" value={draft.seed} onChange={(e) => patch({ seed: Number(e.target.value) })} />
        </Field>
        <div className="flex items-end">
          <button className="dbkl-btn w-full" disabled={busy} onClick={() => setDraft(config)}>
            还原当前值
          </button>
        </div>
      </div>
    </Panel>
  );
}

/** 布隆过滤器的理论假阳性率，让「位数」这个抽象参数有个直观解释。 */
function falsePositive(bitsPerKey: number): string {
  const k = Math.max(1, Math.round(bitsPerKey * 0.6931));
  const p = Math.pow(1 - Math.exp(-k / bitsPerKey), k);
  return `${(p * 100).toFixed(p < 0.1 ? 2 : 1)}% 假阳性`;
}
