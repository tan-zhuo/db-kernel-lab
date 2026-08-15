import { useState } from 'react';
import { Brush, Play, RotateCcw, Square } from 'lucide-react';
import { formatPercent, type IsolationLevel } from '@dbkl/shared';
import { bloatRatio, type Command } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Field, Panel, Stat } from '@/components/ui/Panel';

const SESSIONS = ['A', 'B'];

/**
 * 事务 / MVCC 面板（PostgreSQL 堆表引擎）。
 *
 * 这里的「会话」是演示隔离级别的关键：仿真是单线程的，
 * 但可以同时挂着多个未提交的事务 —— 切到 B 写点东西再切回 A 重查，
 * READ COMMITTED 会看到新数据，REPEATABLE READ 不会。
 * 面板顶部的快照 [xmin, xmax) 与活跃事务列表就是「A 为什么看不见」的物证。
 */
export function TransactionPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const [session, setSession] = useState('A');
  const [isolation, setIsolation] = useState<IsolationLevel>('read-committed');

  const mv = state.mvcc;
  const current = mv?.current ?? null;
  const snapshot = mv?.snapshot ?? null;
  const bloat = bloatRatio(state);
  const exec = (command: Command) => void run(command);

  const useSession = (name: string) => {
    setSession(name);
    exec({ kind: 'use_session', session: name });
  };

  return (
    <Panel title="事务 / MVCC" subtitle="多会话并存，隔离级别的差别可以真的跑出来">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-end gap-2">
          <Field label="当前会话">
            <div className="flex gap-1">
              {SESSIONS.map((s) => (
                <button
                  key={s}
                  data-testid={`session-${s}`}
                  className={`dbkl-btn flex-1 ${session === s ? 'dbkl-btn-primary' : ''}`}
                  disabled={busy}
                  onClick={() => useSession(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>
          <Field label="隔离级别">
            <select
              className="dbkl-input"
              data-testid="isolation"
              value={isolation}
              onChange={(e) => setIsolation(e.target.value as IsolationLevel)}
            >
              <option value="read-committed">READ COMMITTED</option>
              <option value="repeatable-read">REPEATABLE READ</option>
            </select>
          </Field>
        </div>

        <div className="flex gap-2">
          <button
            className="dbkl-btn dbkl-btn-primary flex-1"
            data-testid="begin-txn"
            disabled={busy}
            onClick={() => exec({ kind: 'begin_txn', isolation })}
          >
            <Play size={13} /> BEGIN
          </button>
          <button
            className="dbkl-btn flex-1"
            data-testid="commit-txn"
            disabled={busy}
            onClick={() => exec({ kind: 'commit_txn' })}
          >
            <Square size={13} /> COMMIT
          </button>
          <button className="dbkl-btn flex-1" disabled={busy} onClick={() => exec({ kind: 'abort_txn' })}>
            <RotateCcw size={13} /> ROLLBACK
          </button>
        </div>

        <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
          {current ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-mute-400">进行中的事务</span>
                <span className="num text-accent-400">
                  xid={current.xid} · {current.isolation === 'repeatable-read' ? 'REPEATABLE READ' : 'READ COMMITTED'}
                  {current.implicit ? ' · 隐式' : ''}
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-mute-400">已写入版本</span>
                <span className="num text-mute-200">{current.writes}</span>
              </div>
            </>
          ) : (
            <div className="text-mute-400">当前没有显式事务（每条语句自成一个隐式事务，执行完立即提交）</div>
          )}

          {snapshot && (
            <div className="mt-1.5 border-t border-ink-700 pt-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-mute-400">{snapshot.scope === 'transaction' ? '事务级快照' : '语句级快照'}</span>
                <span className="num text-teal-500">
                  [{snapshot.xmin}, {snapshot.xmax})
                </span>
              </div>
              <div className="num mt-0.5 text-[10.5px] text-mute-400">
                活跃事务 [{snapshot.active.join(', ') || '—'}] —— 它们写的东西对本快照一律不可见
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="活元组" value={mv?.liveTuples ?? 0} tone="good" />
          <Stat
            label="死元组"
            value={mv?.deadTuples ?? 0}
            tone={(mv?.deadTuples ?? 0) > 0 ? 'warn' : 'default'}
            hint="已被 xmax 标记，还占着空间"
          />
          <Stat
            label="膨胀率"
            value={Number.isNaN(bloat) ? '—' : formatPercent(bloat, 0)}
            tone={bloat > 0.3 ? 'bad' : bloat > 0.1 ? 'warn' : 'good'}
            hint="死元组 / (活 + 死)：VACUUM 就是为了把它压下去"
          />
          <Stat label="HOT 更新" value={mv?.hotUpdates ?? 0} tone="good" hint="新版本同页且不改索引列 ⇒ 不写索引" />
          <Stat label="非 HOT 更新" value={mv?.coldUpdates ?? 0} tone={(mv?.coldUpdates ?? 0) > 0 ? 'warn' : 'default'} hint="所有索引都要写一条新项" />
          <Stat label="堆页" value={mv?.heapPages ?? 0} />
        </div>

        <div className="flex gap-2">
          <button className="dbkl-btn flex-1" data-testid="vacuum" disabled={busy} onClick={() => exec({ kind: 'vacuum' })}>
            <Brush size={13} /> VACUUM
          </button>
          <button className="dbkl-btn flex-1" disabled={busy} onClick={() => exec({ kind: 'vacuum', full: true })}>
            VACUUM FULL
          </button>
        </div>
        {mv?.lastVacuum && (
          <p className="text-[10.5px] leading-relaxed text-mute-400">
            上次 VACUUM{mv.lastVacuum.mode === 'full' ? ' FULL' : ''}：清理 {mv.lastVacuum.tuplesRemoved} 个死元组、
            {mv.lastVacuum.indexEntriesRemoved} 条索引项，回收 {mv.lastVacuum.pagesFreed} 个堆页。
          </p>
        )}

        {mv && mv.probes.length > 0 && (
          <div className="overflow-hidden rounded-md border border-ink-700">
            <div className="bg-ink-800 px-2 py-1 text-[10px] uppercase tracking-wide text-mute-400">
              最近的可见性判定
            </div>
            <ul className="num max-h-[132px] overflow-y-auto">
              {mv.probes
                .slice(-12)
                .reverse()
                .map((p, i) => (
                  <li
                    key={i}
                    className="flex items-baseline gap-2 border-t border-ink-700/70 px-2 py-[3px] text-[10.5px]"
                  >
                    <span className="text-mute-400">
                      ({p.pageId},{p.slot})
                    </span>
                    <span className="text-mute-400/80">
                      xmin={p.xmin} xmax={p.xmax ?? '∅'}
                    </span>
                    <span className={`ml-auto shrink-0 ${p.visible ? 'text-green-500' : 'text-red-500'}`}>
                      {p.visible ? '可见' : '不可见'}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
