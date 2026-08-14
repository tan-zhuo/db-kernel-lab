import type { ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`border-b border-ink-700/80 ${className}`}>
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mute-400">{title}</h2>
          {subtitle && <p className="truncate text-[11px] text-mute-400/70">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className={`px-3 pb-3 ${bodyClassName}`}>{children}</div>
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
