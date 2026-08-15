import { useState } from 'react';
import { Camera, Recycle } from 'lucide-react';
import { formatNumber } from '@dbkl/shared';
import type { Command } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * 写时复制面板。
 *
 * 四个数字撑起这类引擎的全部性格：
 *  - **每次写复制几页**：等于树高。这就是写放大的来源，也是它换来"不需要 WAL"的价钱；
 *  - **meta 槽**：翻到哪一边就是提交到哪一版；
 *  - **空闲表**：上一版腾出来的位置，下一个写事务直接拿来用 —— 文件因此不会一直涨；
 *  - **被钉住的页**：只读快照不放手，这些页就回收不了。它是 LMDB 唯一的空间放大来源。
 */
export function CowPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const [session, setSession] = useState('A');
  const c = state.cow;

  if (!c) {
    return (
      <Panel title="写时复制" subtitle="复制路径 · 翻 meta 页 = 提交">
        <p className="text-[12px] leading-relaxed text-mute-400">
          还没有数据。写入几条就能看到「改一行要复制根到叶的整条路径」。
        </p>
      </Panel>
    );
  }

  const exec = (command: Command) => void run(command);
  const pinned = c.pending.reduce((n, p) => n + p.pages.length, 0);
  const height = state.indexes['PRIMARY']?.height ?? 1;
  const lastCopied = c.lastCommit?.copiedPages ?? 0;
  const totalPages = Object.keys(state.pages).length;

  return (
    <Panel title="写时复制" subtitle={`meta[${c.metaSlot}] · txn=${c.txnId}`}>
      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="写事务" value={formatNumber(c.writeTxns)} tone="accent" hint="同一时刻只允许一个写者" />
          <Stat label="累计复制页" value={formatNumber(c.copies)} tone="warn" hint="写放大的全部来源：改一行要复制整条路径" />
          <Stat
            label="上次复制"
            value={lastCopied}
            tone={lastCopied > height ? 'warn' : 'good'}
            hint={`单条写等于树高 ${height}；批量写摊薄之后会低于它`}
          />
          <Stat label="空闲页" value={c.freelist.length} tone="good" hint="上一版腾出来的位置，下个写事务直接复用" />
          <Stat label="已复用" value={formatNumber(c.reused)} tone="good" hint="复用得越多，文件涨得越慢" />
          <Stat
            label="钉住不放"
            value={pinned}
            tone={pinned > 0 ? 'bad' : 'good'}
            hint="被只读快照占着、回收不了的旧页 —— LMDB 唯一的空间放大来源"
          />
          <Stat label="只读快照" value={c.readers.length} tone={c.readers.length > 0 ? 'warn' : undefined} />
          <Stat label="当前根" value={c.rootId === null ? '∅' : `#${c.rootId}`} />
          <Stat label="在用页" value={totalPages} hint="复用生效时它会稳在一个常数附近，而不是一直涨" />
        </div>

        {/* meta 页双缓冲：提交就是把亮的那个换一边 */}
        <div className="grid grid-cols-2 gap-1.5">
          {c.meta.slice(0, 2).map((m, i) => {
            const active = c.metaSlot === i;
            return (
              <div
                key={i}
                data-testid={`cow-meta-${i}`}
                className={`rounded-md border p-2 text-[11px] ${
                  active ? 'border-teal-500/60 bg-teal-500/10' : 'border-ink-700 bg-ink-850/60'
                }`}
              >
                <div className={`flex items-baseline justify-between ${active ? 'text-teal-500' : 'text-mute-400'}`}>
                  <span>meta[{i}]</span>
                  {active && <span className="text-[9.5px]">当前版本</span>}
                </div>
                <div className="num mt-1 text-[10.5px] text-mute-400">
                  txn={m.txnId} · 根 {m.rootId === null ? '∅' : `#${m.rootId}`}
                </div>
              </div>
            );
          })}
        </div>

        {c.readers.length > 0 && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">在跑的只读快照</div>
            <ul className="flex flex-col gap-0.5">
              {c.readers.map((r) => (
                <li key={r.id} className="num flex justify-between text-[10.5px] text-mute-300">
                  <span>
                    {r.id} · 会话 {r.session}
                  </span>
                  <span className="text-mute-400">
                    txn={r.txnId} · 钉住 #{r.rootId}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10.5px] leading-relaxed text-mute-400/80">
              读者全程不加锁：它看到的那棵树是不可变的历史版本。代价是这 {pinned} 页回收不了。
            </p>
          </div>
        )}

        {/*
          会话切换是演示「读者看到旧版本」的必要条件：
          A 开快照 → 切到 B 写入 → 切回 A 再查，读到的仍是打开快照那一刻的数据。
        */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-mute-400">会话</span>
          {['A', 'B'].map((s) => {
            const active = s === session;
            const held = c.readers.some((r) => r.session === s);
            return (
              <button
                key={s}
                data-testid={`cow-session-${s}`}
                className={`dbkl-btn !px-2 ${active ? 'text-accent-400' : ''}`}
                disabled={busy}
                onClick={() => {
                  setSession(s);
                  exec({ kind: 'use_session', session: s });
                }}
                title={held ? `会话 ${s} 持有一个只读快照` : `切换到会话 ${s}`}
              >
                {s}
                {held && <span className="text-teal-500">●</span>}
              </button>
            );
          })}
          <span className="text-[10px] text-mute-400/80">A 开快照 → 切 B 写入 → 切回 A 再查</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            className="dbkl-btn"
            data-testid="cow-snapshot"
            disabled={busy}
            onClick={() => exec({ kind: c.readers.some((r) => r.session === session) ? 'commit_txn' : 'begin_txn' })}
            title="在当前会话打开/关闭一个只读快照（钉住当前根）"
          >
            <Camera size={13} /> {c.readers.some((r) => r.session === session) ? '关快照' : '开快照'}
          </button>
          <button
            className="dbkl-btn"
            data-testid="cow-reclaim"
            disabled={busy}
            onClick={() => exec({ kind: 'flush_all' })}
            title="把已经没人看得见的旧页放进空闲表"
          >
            <Recycle size={13} /> 回收旧页
          </button>
        </div>

        <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">和 InnoDB 的分水岭</div>
          <ul className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-mute-400">
            <li>
              <span className="text-green-500">✓</span> 提交只是翻一下 meta 页 ——{' '}
              <span className="text-mute-300">没有 WAL，崩溃也不需要恢复</span>
            </li>
            <li>
              <span className="text-green-500">✓</span> 读者零加锁，快照天然一致
            </li>
            <li>
              <span className="text-red-500">✗</span> 改一行要复制 {height} 页（树高），单条写没得摊
            </li>
            <li>
              <span className="text-red-500">✗</span> 单写者：写与写之间完全串行
            </li>
            <li>
              <span className="text-red-500">✗</span> 长读事务钉着旧页不放，文件只涨不缩
            </li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}
