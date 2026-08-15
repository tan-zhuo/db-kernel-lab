import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Download, Eye, Fullscreen, Loader2, RotateCcw, Type } from 'lucide-react';
import { useCapability, useSimStore } from '@/state/store';
import { captureScreenshot } from '@/components/scene/SceneRoot';
import { ThemePicker } from '@/components/ThemePicker';
import { EnginePicker } from '@/components/EnginePicker';

/**
 * 顶栏。
 *
 * 排布按「多久用一次」分三组，而不是把按钮平铺出去：
 *  左：身份 + **引擎选择**（全局模式开关）+ 当前状态；
 *  中：视图开关（看画面时经常按，直接给按钮）；
 *  右：原理 / 导出 / 主题 / 重置（低频，导出三项收进一个下拉）。
 */
export function TopBar() {
  const status = useSimStore((s) => s.status);
  const error = useSimStore((s) => s.error);
  const busy = useSimStore((s) => s.busy);
  const engineName = useSimStore((s) => s.engineName);
  const showBufferPool = useSimStore((s) => s.showBufferPool);
  const showLabels = useSimStore((s) => s.showLabels);
  const hasBufferPool = useCapability('buffer-pool');
  const store = useSimStore;

  return (
    <header className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-1.5">
      <span className="shrink-0 text-[14px] font-semibold tracking-tight text-strong">DB Kernel Lab</span>

      <EnginePicker />

      <div className="num min-w-0 flex-1 truncate text-[11px]" title={error ?? status}>
        {busy && <Loader2 size={12} className="mr-1 inline animate-spin text-accent-400" />}
        <span className={error ? 'text-red-500' : 'text-mute-400'}>{error ?? status}</span>
      </div>

      {/* —— 视图开关：看画面时经常按，留在外面 —— */}
      {hasBufferPool && (
        <button
          className={`dbkl-btn ${showBufferPool ? 'text-accent-400' : ''}`}
          onClick={() => store.getState().toggleBufferPool()}
          title="显示/隐藏 Buffer Pool 视图 (B)"
        >
          <Eye size={13} />
        </button>
      )}
      <button
        className={`dbkl-btn ${showLabels ? 'text-accent-400' : ''}`}
        onClick={() => store.getState().toggleLabels()}
        title="显示/隐藏场景内文字标签 (L)"
      >
        <Type size={13} />
      </button>
      <button className="dbkl-btn" onClick={() => store.getState().focusPage(null)} title="适应视图 (G)">
        <Fullscreen size={13} />
      </button>

      <span className="mx-0.5 h-4 w-px bg-ink-600" />

      <button
        className="dbkl-btn"
        data-testid="open-guide"
        onClick={() => store.getState().setGuideOpen(true)}
        title="原理讲解：五种存储引擎的物理模型、机制与取舍"
      >
        <BookOpen size={13} /> 原理
      </button>
      <ExportMenu />
      <ThemePicker />
      <button
        className="dbkl-btn"
        title={`重置实验（当前引擎：${engineName || '加载中'}）`}
        onClick={() => {
          if (confirm('重置实验？当前命令日志与事件流会被清空（IndexedDB 中的会话也会被覆盖）。')) {
            void store.getState().resetEngine();
          }
        }}
      >
        <RotateCcw size={13} />
      </button>
    </header>
  );
}

/** 导出三件套收进一个下拉：都是低频操作，不值得各占一个按钮位。 */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const store = useSimStore;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const item = (label: string, hint: string, onClick: () => void, testId: string) => (
    <button
      data-testid={testId}
      className="w-full rounded px-1.5 py-1.5 text-left hover:bg-ink-800"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      <span className="block text-[12px] text-mute-200">{label}</span>
      <span className="block text-[10.5px] text-mute-400">{hint}</span>
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button className="dbkl-btn" data-testid="export-menu" title="导出实验" onClick={() => setOpen(!open)}>
        <Download size={13} />
        <ChevronDown size={11} className="text-mute-400" />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[236px] rounded-md border border-ink-600 bg-ink-850 p-1.5 shadow-xl shadow-black/40">
          {item('事件流 JSON', '完整事件流 + 命令日志，可还原整场实验', () => store.getState().exportEvents(), 'export-events')}
          {item('当前状态 JSON', '时间轴当前时刻的 LabState 快照', () => store.getState().exportState(), 'export-state')}
          {item(
            '场景截图 PNG',
            '当前 3D 视口的高清截图',
            () => {
              const url = captureScreenshot();
              if (!url) return;
              const a = document.createElement('a');
              a.href = url;
              a.download = `dbkl-scene-${Date.now()}.png`;
              a.click();
            },
            'export-shot',
          )}
        </div>
      )}
    </div>
  );
}
