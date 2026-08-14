import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { EngineConfig } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Field, Panel } from '@/components/ui/Panel';

/**
 * 参数实验面板。
 *
 * 阶数、缓冲池大小这类参数会改变已有页的物理布局，所以修改后必须重置重建，
 * 这也正是「参数敏感性实验」的正确做法：同一组命令 + 不同参数 = 可对比的两次运行。
 */
export function ConfigPanel() {
  const config = useSimStore((s) => s.config);
  const resetEngine = useSimStore((s) => s.resetEngine);
  const busy = useSimStore((s) => s.busy);
  const [draft, setDraft] = useState<EngineConfig>(config);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const patch = (p: Partial<EngineConfig>) => setDraft({ ...draft, ...p });

  return (
    <Panel
      title="引擎参数"
      subtitle="修改后需重置以重建结构"
      collapsible
      defaultOpen={false}
      right={
        <button
          className={`dbkl-btn ${dirty ? 'dbkl-btn-primary' : ''}`}
          disabled={busy}
          onClick={() => void resetEngine(draft)}
        >
          <RotateCcw size={13} /> 应用并重置
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
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
        <Field label="页大小" hint="仅用于字节估算">
          <select
            className="dbkl-input"
            value={draft.pageSize}
            onChange={(e) => patch({ pageSize: Number(e.target.value) })}
          >
            <option value={4096}>4 KB</option>
            <option value={8192}>8 KB</option>
            <option value={16384}>16 KB (InnoDB)</option>
            <option value={32768}>32 KB</option>
          </select>
        </Field>
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
        <label className="col-span-2 flex items-center gap-2 text-[11px] text-mute-300">
          <input
            type="checkbox"
            checked={draft.sequentialInsertOptimization}
            onChange={(e) => patch({ sequentialInsertOptimization: e.target.checked })}
          />
          顺序插入右倾优化（InnoDB 最右页分裂）
        </label>
        <Field label="随机种子" hint="保证可复现">
          <input
            className="dbkl-input"
            type="number"
            value={draft.seed}
            onChange={(e) => patch({ seed: Number(e.target.value) })}
          />
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
