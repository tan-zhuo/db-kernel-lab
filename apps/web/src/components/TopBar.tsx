import { BookOpen, Camera, Download, Eye, Fullscreen, Loader2, RotateCcw, Type } from 'lucide-react';
import { useCapability, useSimStore } from '@/state/store';
import { captureScreenshot } from '@/components/scene/SceneRoot';
import { ThemePicker } from '@/components/ThemePicker';

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
    <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-strong">DB Kernel Lab</span>
        <span className="text-[11px] text-mute-400">数据库内核可视化实验室 · InnoDB / PostgreSQL / LSM</span>
      </div>
      <span className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 text-[10px] text-teal-500">
        {engineName || '引擎加载中…'}
      </span>

      <div className="num min-w-0 flex-1 truncate text-[11px]">
        {busy && <Loader2 size={12} className="mr-1 inline animate-spin text-accent-400" />}
        <span className={error ? 'text-red-500' : 'text-mute-300'}>{error ?? status}</span>
      </div>

      {hasBufferPool && (
        <button
          className={`dbkl-btn ${showBufferPool ? 'text-accent-400' : ''}`}
          onClick={() => store.getState().toggleBufferPool()}
          title="显示/隐藏 Buffer Pool 视图 (B)"
        >
          <Eye size={13} /> 缓冲池
        </button>
      )}
      <button
        className={`dbkl-btn ${showLabels ? 'text-accent-400' : ''}`}
        onClick={() => store.getState().toggleLabels()}
        title="显示/隐藏页面文字标签 (L)"
      >
        <Type size={13} />
      </button>
      <button
        className="dbkl-btn"
        data-testid="open-guide"
        onClick={() => store.getState().setGuideOpen(true)}
        title="打开原理讲解：五种存储引擎的物理模型、机制与取舍"
      >
        <BookOpen size={13} /> 原理
      </button>
      <ThemePicker />
      <button className="dbkl-btn" onClick={() => store.getState().focusPage(null)} title="适应视图 (G)">
        <Fullscreen size={13} />
      </button>
      <button
        className="dbkl-btn"
        onClick={() => {
          const url = captureScreenshot();
          if (!url) return;
          const a = document.createElement('a');
          a.href = url;
          a.download = `dbkl-scene-${Date.now()}.png`;
          a.click();
        }}
        title="导出当前场景高清截图"
      >
        <Camera size={13} />
      </button>
      <button className="dbkl-btn" onClick={() => store.getState().exportEvents()} title="导出事件序列 JSON">
        <Download size={13} /> 事件
      </button>
      <button className="dbkl-btn" onClick={() => store.getState().exportState()} title="导出当前状态 JSON">
        <Download size={13} /> 状态
      </button>
      <button
        className="dbkl-btn"
        onClick={() => {
          if (confirm('重置实验？当前命令日志与事件流会被清空（IndexedDB 中的会话也会被覆盖）。')) {
            void store.getState().resetEngine();
          }
        }}
        title="重置实验"
      >
        <RotateCcw size={13} />
      </button>
    </header>
  );
}
