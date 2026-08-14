import { useCallback, useMemo, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from 'lucide-react';
import { useSimStore } from '@/state/store';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];
/** 轨道上最多绘制的关键帧刻度，超出则抽样。 */
const MAX_TICKS = 400;

/**
 * 时间轴：视频剪辑器式的实验回放控制。
 *
 * 位置按事件下标线性映射（而不是逻辑时间），这样每一步都可精确点选；
 * 逻辑时间显示在右侧读数里。
 */
export function Timeline() {
  const cursor = useSimStore((s) => s.cursor);
  const version = useSimStore((s) => s.version);
  const history = useSimStore((s) => s.history);
  const playing = useSimStore((s) => s.playing);
  const speed = useSimStore((s) => s.speed);
  const markers = useSimStore((s) => s.markers);
  const loop = useSimStore((s) => s.loop);
  const store = useSimStore;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'cursor' | 'loop' | null>(null);
  const loopAnchor = useRef(0);

  const total = history.length;
  const pct = (index: number) => (total === 0 ? 0 : (index / total) * 100);

  const { spans, ticks } = useMemo(() => {
    void version;
    const spanList = history.commands.map((s) => ({
      cmd: s.cmd,
      label: s.label,
      left: pct(s.startSeq),
      width: Math.max(0.25, pct(s.endSeq - s.startSeq + 1)),
      ok: s.ok,
    }));
    const found: { index: number; kind: 'split' | 'merge' | 'evict' | 'root' }[] = [];
    for (let i = 0; i < history.length; i++) {
      const e = history.at(i)!;
      if (e.type === 'PAGE_SPLIT') found.push({ index: i, kind: 'split' });
      else if (e.type === 'PAGE_MERGE' || e.type === 'REDISTRIBUTE') found.push({ index: i, kind: 'merge' });
      else if (e.type === 'BUFFER_EVICT') found.push({ index: i, kind: 'evict' });
      else if (e.type === 'ROOT_CHANGE') found.push({ index: i, kind: 'root' });
    }
    const step = Math.ceil(found.length / MAX_TICKS);
    return { spans: spanList, ticks: step > 1 ? found.filter((_, i) => i % step === 0) : found };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, total, version]);

  const indexFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || total === 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(ratio * total);
    },
    [total],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const index = indexFromEvent(e.clientX);
    if (e.shiftKey) {
      dragging.current = 'loop';
      loopAnchor.current = index;
      store.getState().setLoop({ from: index, to: index });
    } else {
      dragging.current = 'cursor';
      store.getState().pause();
      store.getState().goTo(index);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const index = indexFromEvent(e.clientX);
    if (dragging.current === 'loop') {
      store.getState().setLoop({ from: Math.min(loopAnchor.current, index), to: Math.max(loopAnchor.current, index) });
    } else {
      store.getState().goTo(index);
    }
  };

  const onPointerUp = () => {
    dragging.current = null;
  };

  const currentSpan = history.commands.find((s) => cursor - 1 >= s.startSeq && cursor - 1 <= s.endSeq);
  const currentEvent = cursor > 0 ? history.at(cursor - 1) : undefined;

  return (
    <div className="flex flex-col gap-1.5 border-t border-ink-700 bg-ink-900 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <button
          className="dbkl-btn"
          title="回到开头 (Home)"
          onClick={() => {
            store.getState().pause();
            store.getState().goTo(0);
          }}
        >
          <SkipBack size={14} />
        </button>
        <button className="dbkl-btn" title="上一条命令 (Shift+←)" onClick={() => store.getState().jumpToCommand(-1)}>
          <ChevronLeft size={14} />
        </button>
        <button className="dbkl-btn" title="后退一步 (←)" onClick={() => store.getState().step(-1)}>
          <StepBack size={14} />
        </button>
        <button
          className="dbkl-btn dbkl-btn-primary w-16"
          title="播放 / 暂停 (空格)"
          onClick={() => store.getState().togglePlay()}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="dbkl-btn" title="前进一步 (→)" onClick={() => store.getState().step(1)}>
          <StepForward size={14} />
        </button>
        <button className="dbkl-btn" title="下一条命令 (Shift+→)" onClick={() => store.getState().jumpToCommand(1)}>
          <ChevronRight size={14} />
        </button>
        <button
          className="dbkl-btn"
          title="跳到结尾 (End)"
          onClick={() => {
            store.getState().pause();
            store.getState().goTo(total);
          }}
        >
          <SkipForward size={14} />
        </button>

        <div className="mx-1 h-5 w-px bg-ink-600" />

        <select
          className="dbkl-input w-20"
          value={speed}
          onChange={(e) => store.getState().setSpeed(Number(e.target.value))}
          title="播放速度 (数字键 1–7)"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>

        <button
          className={`dbkl-btn ${markers.includes(cursor) ? 'text-amber-500' : ''}`}
          title="在当前位置打点 (M)"
          onClick={() => store.getState().toggleMarker()}
        >
          <Flag size={14} />
        </button>
        <button
          className={`dbkl-btn ${loop ? 'text-teal-500' : ''}`}
          title="循环当前命令区间（Shift+拖动轨道可自定义区间）"
          onClick={() => {
            if (loop) store.getState().setLoop(null);
            else if (currentSpan) store.getState().setLoop({ from: currentSpan.startSeq, to: currentSpan.endSeq + 1 });
          }}
        >
          <Repeat size={14} />
        </button>

        <div className="mx-1 h-5 w-px bg-ink-600" />

        <button
          className="dbkl-btn"
          title="跳到下一次页分裂"
          onClick={() => store.getState().jumpToEvent((e) => e.type === 'PAGE_SPLIT', 1)}
        >
          下一次分裂
        </button>
        <button
          className="dbkl-btn"
          title="跳到下一次缓冲池淘汰"
          onClick={() => store.getState().jumpToEvent((e) => e.type === 'BUFFER_EVICT', 1)}
        >
          下一次淘汰
        </button>

        <div className="num ml-auto flex items-center gap-3 text-[11px] text-mute-400">
          <span className="max-w-[280px] truncate text-mute-300">{currentSpan?.label ?? '—'}</span>
          <span data-testid="timeline-counter">
            {cursor} / {total}
          </span>
          <span>{((currentEvent?.t ?? 0) / 1000).toFixed(2)}s</span>
        </div>
      </div>

      <div
        ref={trackRef}
        className="relative h-14 cursor-col-resize select-none rounded-md border border-ink-700 bg-ink-950"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="拖动定位；Shift+拖动设置循环区间"
      >
        {/* 命令块 */}
        <div className="pointer-events-none absolute inset-x-0 top-1 h-5">
          {spans.map((s) => (
            <div
              key={s.cmd}
              className={`absolute top-0 h-full overflow-hidden rounded-sm border text-[9px] leading-5 ${
                s.ok ? 'border-accent-500/40 bg-accent-500/15 text-accent-400' : 'border-red-500/50 bg-red-500/20'
              }`}
              style={{ left: `${s.left}%`, width: `${s.width}%` }}
            >
              <span className="pl-1 opacity-80">{s.width > 6 ? s.label : ''}</span>
            </div>
          ))}
        </div>

        {/* 关键帧刻度 */}
        <div className="pointer-events-none absolute inset-x-0 top-7 h-4">
          {ticks.map((t) => (
            <div
              key={`${t.kind}-${t.index}`}
              className={`absolute top-0 h-full w-[2px] ${
                t.kind === 'split'
                  ? 'bg-green-500'
                  : t.kind === 'merge'
                    ? 'bg-orange-500'
                    : t.kind === 'root'
                      ? 'bg-teal-500'
                      : 'bg-red-500'
              }`}
              style={{ left: `${pct(t.index)}%`, opacity: 0.8 }}
            />
          ))}
        </div>

        {/* 循环区间 */}
        {loop && (
          <div
            className="pointer-events-none absolute inset-y-0 border-x border-teal-500/70 bg-teal-500/10"
            style={{ left: `${pct(loop.from)}%`, width: `${Math.max(0.3, pct(loop.to - loop.from))}%` }}
          />
        )}

        {/* 打点 */}
        {markers.map((m) => (
          <div
            key={m}
            className="pointer-events-none absolute bottom-0 h-3 w-[2px] bg-amber-500"
            style={{ left: `${pct(m)}%` }}
          >
            <div className="absolute -left-[3px] -top-[4px] h-2 w-2 rotate-45 bg-amber-500" />
          </div>
        ))}

        {/* 游标 */}
        <div className="pointer-events-none absolute inset-y-0 w-[2px] bg-white/90" style={{ left: `${pct(cursor)}%` }}>
          <div className="absolute -left-[4px] top-0 h-2.5 w-2.5 rotate-45 bg-white" />
        </div>
      </div>
    </div>
  );
}
