import { useEffect, useMemo, useRef, useState } from 'react';
import { EVENT_CATEGORY, describeEvent, type EventCategory } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

const CATEGORY_STYLE: Record<EventCategory, string> = {
  command: 'text-accent-400',
  meta: 'text-mute-400',
  structure: 'text-green-500',
  record: 'text-violet-400',
  buffer: 'text-orange-500',
  access: 'text-amber-500',
  plan: 'text-teal-500',
  txn: 'text-accent-400',
  mvcc: 'text-violet-400',
  lsm: 'text-teal-500',
  columnar: 'text-violet-400',
  kv: 'text-teal-500',
};

/** 过滤按钮：只显示当前引擎真正会产生的分类（由 capabilities 决定）。 */
const FILTERS: { id: 'all' | EventCategory; label: string; capability?: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'structure', label: '结构' },
  { id: 'record', label: '记录' },
  { id: 'buffer', label: '缓冲池', capability: 'buffer-pool' },
  { id: 'access', label: '访问' },
  { id: 'plan', label: '计划' },
  { id: 'txn', label: '事务', capability: 'transactions' },
  { id: 'mvcc', label: 'MVCC', capability: 'mvcc' },
  { id: 'lsm', label: 'LSM', capability: 'lsm' },
  { id: 'columnar', label: '列存', capability: 'columnar' },
  { id: 'kv', label: 'KV', capability: 'kv' },
];

/** 事件日志：游标附近的窗口，点击任意行即可把整个实验跳到那一刻。 */
export function EventLogPanel() {
  const cursor = useSimStore((s) => s.cursor);
  const version = useSimStore((s) => s.version);
  const history = useSimStore((s) => s.history);
  const goTo = useSimStore((s) => s.goTo);
  const [filter, setFilter] = useState<'all' | EventCategory>('all');
  const capabilities = useSimStore((s) => s.capabilities);
  const listRef = useRef<HTMLDivElement>(null);
  const filters = FILTERS.filter((f) => !f.capability || capabilities.includes(f.capability));

  const rows = useMemo(() => {
    void version;
    const start = Math.max(0, cursor - 80);
    const end = Math.min(history.length, cursor + 40);
    const out: { index: number; text: string; category: EventCategory }[] = [];
    for (let i = start; i < end; i++) {
      const e = history.at(i);
      if (!e) continue;
      const category = EVENT_CATEGORY[e.type];
      if (filter !== 'all' && category !== filter) continue;
      out.push({ index: i, text: describeEvent(e), category });
    }
    return out;
  }, [cursor, history, filter, version]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-current="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <Panel
      title="事件日志"
      subtitle={`${history.length} 个事件 · 游标 ${cursor}`}
      right={
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                filter === f.id ? 'bg-ink-600 text-strong' : 'text-mute-400 hover:text-mute-200'
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
      bodyClassName="pb-0"
    >
      <div ref={listRef} className="num max-h-[240px] overflow-y-auto rounded-md border border-ink-700 bg-ink-950/60">
        {rows.length === 0 && <p className="p-2 text-[11px] text-mute-400">没有匹配的事件</p>}
        {rows.map((row) => {
          const isCurrent = row.index === cursor - 1;
          return (
            <button
              key={row.index}
              data-current={isCurrent}
              onClick={() => goTo(row.index + 1)}
              className={`flex w-full items-start gap-2 px-2 py-[3px] text-left text-[11px] leading-tight hover:bg-ink-800 ${
                isCurrent ? 'bg-accent-500/15' : ''
              } ${row.index >= cursor ? 'opacity-40' : ''}`}
            >
              <span className="w-10 shrink-0 text-right text-mute-400/70">{row.index}</span>
              <span className={`min-w-0 flex-1 ${CATEGORY_STYLE[row.category]}`}>{row.text}</span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
