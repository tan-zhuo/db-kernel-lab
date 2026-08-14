import { PALETTE } from '@dbkl/visualization';
import { useLabState, useSimStore } from '@/state/store';

const LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.root, label: '根页' },
  { color: PALETTE.leaf, label: '叶子页' },
  { color: PALETTE.internal, label: '内部页' },
  { color: PALETTE.dirty, label: '脏页' },
  { color: PALETTE.searchPath, label: '查找路径' },
  { color: PALETTE.split, label: '分裂/新建' },
  { color: PALETTE.remove, label: '删除/淘汰' },
];

const SHORTCUTS = [
  ['空格', '播放 / 暂停'],
  ['← →', '单步'],
  ['Shift+← →', '上/下一条命令'],
  ['1–7', '切换速度'],
  ['F / G', '飞入选中页 / 适应视图'],
  ['M', '打点'],
  ['B / L', '缓冲池 / 标签'],
];

/** 3D 视口上的 2D 覆盖层：图例、当前操作、快捷键提示。 */
export function SceneOverlay() {
  const state = useLabState();
  const selectedPageId = useSimStore((s) => s.selectedPageId);
  const activeCommand = state.activeCommand;
  const result = state.lastResult;

  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
        <div className="rounded-md border border-ink-700 bg-ink-900/85 px-2.5 py-2 backdrop-blur">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-mute-400">当前操作</div>
          <div className="num text-[12px] text-mute-200">
            {activeCommand ? activeCommand.label : '空闲'}
            {activeCommand?.running && <span className="ml-1 text-accent-400">执行中…</span>}
          </div>
          {state.path.length > 0 && (
            <div className="num mt-1 text-[11px] text-amber-500">
              路径 {state.path.map((p) => `#${p}`).join(' → ')}
            </div>
          )}
          {result && (
            <div className={`num mt-1 text-[11px] ${result.found ? 'text-green-500' : 'text-red-500'}`}>
              {result.found ? `命中 key=${result.key} @ #${result.pageId} slot ${result.slot}` : `未找到 key=${result.key}`}
            </div>
          )}
          {state.scanOutput.length > 0 && (
            <div className="num mt-1 max-w-[260px] truncate text-[11px] text-teal-500">
              扫描输出 {state.scanOutput.slice(0, 12).join(', ')}
              {state.scanOutput.length > 12 ? ' …' : ''}
            </div>
          )}
        </div>

        <div className="rounded-md border border-ink-700 bg-ink-900/85 px-2.5 py-2 backdrop-blur">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-mute-400">图例</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {LEGEND.map((l) => (
              <div key={l.label} className="flex items-center gap-1.5 text-[11px] text-mute-300">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-ink-700 bg-ink-900/70 px-2.5 py-2 backdrop-blur">
        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <kbd className="num text-[10px] text-accent-400">{k}</kbd>
              <span className="text-[10px] text-mute-400">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {selectedPageId !== null && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-accent-500/40 bg-ink-900/85 px-2.5 py-1.5 backdrop-blur">
          <span className="num text-[11px] text-accent-400">已选中页 #{selectedPageId}</span>
        </div>
      )}
    </>
  );
}
