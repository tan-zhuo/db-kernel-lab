import { useEffect } from 'react';
import { useSimStore } from '@/state/store';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];

/** 全局快捷键（文档 §13）。输入框聚焦时全部让位。 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const s = useSimStore.getState();

      switch (e.key) {
        case ' ':
          e.preventDefault();
          s.togglePlay();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) s.jumpToCommand(-1);
          else s.step(e.altKey ? -10 : -1);
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) s.jumpToCommand(1);
          else s.step(e.altKey ? 10 : 1);
          return;
        case 'Home':
          s.pause();
          s.goTo(0);
          return;
        case 'End':
          s.pause();
          s.goTo(s.history.length);
          return;
        case 'f':
        case 'F':
          s.focusPage(s.selectedPageId);
          return;
        case 'g':
        case 'G':
          s.focusPage(null);
          return;
        case 'm':
        case 'M':
          s.toggleMarker();
          return;
        case 'b':
        case 'B':
          s.toggleBufferPool();
          return;
        case 'l':
        case 'L':
          s.toggleLabels();
          return;
        case 'Escape':
          s.select(null);
          return;
        default:
          break;
      }

      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= SPEEDS.length) {
        s.setSpeed(SPEEDS[digit - 1]);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
