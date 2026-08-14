import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = '',
  bodyClassName = '',
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = !collapsible || open;

  return (
    <section className={`border-b border-ink-700/80 ${className}`}>
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className={`flex min-w-0 items-center gap-1 text-left ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
          onClick={() => collapsible && setOpen(!open)}
          disabled={!collapsible}
        >
          {collapsible &&
            (open ? (
              <ChevronDown size={12} className="shrink-0 text-mute-400" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-mute-400" />
            ))}
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-mute-400">{title}</span>
            {subtitle && <span className="block truncate text-[11px] text-mute-400/70">{subtitle}</span>}
          </span>
        </button>
        {right}
      </header>
      {showBody && <div className={`px-3 pb-3 ${bodyClassName}`}>{children}</div>}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[11px] text-mute-400">
        {label}
        {hint && <span className="num text-[10px] text-mute-400/70">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Stat({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent';
  hint?: string;
}) {
  const toneClass = {
    default: 'text-mute-200',
    good: 'text-green-500',
    warn: 'text-amber-500',
    bad: 'text-red-500',
    accent: 'text-accent-400',
  }[tone];
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/70 px-2 py-1.5" title={hint} data-stat={label}>
      <div className="truncate text-[10px] uppercase tracking-wide text-mute-400">{label}</div>
      <div className={`num text-[15px] leading-tight ${toneClass}`} data-stat-value>
        {value}
      </div>
    </div>
  );
}
