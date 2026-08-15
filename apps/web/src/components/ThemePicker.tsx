import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { THEME_LIST } from '@dbkl/visualization';
import { useSimStore } from '@/state/store';

/**
 * 主题选择器。
 *
 * 换主题会同时改三处：CSS 变量（面板）、3D 调色板、文字贴图缓存 ——
 * 全部由 store 的 `setTheme` 统一处理，这里只负责挑。
 */
export function ThemePicker() {
  const theme = useSimStore((s) => s.theme);
  const setTheme = useSimStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点外面关掉；Esc 也关。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = THEME_LIST.find((t) => t.id === theme) ?? THEME_LIST[0];

  return (
    <div className="relative" ref={ref}>
      <button
        className="dbkl-btn"
        data-testid="theme-picker"
        title={`配色主题：${current.label}`}
        onClick={() => setOpen(!open)}
      >
        <Palette size={13} />
        <span className="flex items-center gap-[3px]">
          {current.swatch.map((c, i) => (
            <span
              key={i}
              className="h-2.5 w-2.5 rounded-[2px] border border-ink-600"
              style={{ background: c }}
            />
          ))}
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-[248px] rounded-md border border-ink-600 bg-ink-850 p-1.5 shadow-xl shadow-black/40"
          data-testid="theme-menu"
        >
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-[0.14em] text-mute-400">配色主题</div>
          <ul className="flex flex-col gap-0.5">
            {THEME_LIST.map((t) => {
              const active = t.id === theme;
              return (
                <li key={t.id}>
                  <button
                    data-testid={`theme-${t.id}`}
                    className={`flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left transition-colors ${
                      active ? 'bg-accent-500/15' : 'hover:bg-ink-800'
                    }`}
                    onClick={() => {
                      setTheme(t.id);
                      setOpen(false);
                    }}
                  >
                    <span className="mt-[3px] flex shrink-0 items-center gap-[3px]">
                      {t.swatch.map((c, i) => (
                        <span
                          key={i}
                          className="h-3 w-3 rounded-[2px] border border-ink-600"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[12px] ${active ? 'text-accent-400' : 'text-mute-200'}`}>
                        {t.label}
                        <span className="ml-1 text-[10px] text-mute-400">{t.dark ? '深色' : '浅色'}</span>
                      </span>
                      <span className="block text-[10.5px] leading-snug text-mute-400">{t.hint}</span>
                    </span>
                    {active && <Check size={13} className="mt-[3px] shrink-0 text-accent-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-1.5 pt-1.5 text-[10px] leading-relaxed text-mute-400/80">
            主题同时作用于面板与 3D 场景，选择会记在本机。
          </p>
        </div>
      )}
    </div>
  );
}
