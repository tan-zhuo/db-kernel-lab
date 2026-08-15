import { ArrowDownToLine } from 'lucide-react';
import { formatNumber } from '@dbkl/shared';
import type { Command } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * Bε-树面板。
 *
 * 一个数字撑起整个引擎：**写放大 = 下推条次 / 写入次数**。
 * B+ 树的这个数恒等于树高（每写一条就得走到叶子），Bε-树把它压到 1 以下都可能 ——
 * 因为一批消息是一起走的。旁边那条「在途消息」则是它的另一面：
 * 数据还没到叶子，范围扫描随时会被迫把这笔账结清。
 */
export function FractalPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const f = state.fractal;

  if (!f) {
    return (
      <Panel title="消息缓冲" subtitle="写只碰根 · 攒够一批再下推">
        <p className="text-[12px] leading-relaxed text-mute-400">
          还没有数据。写几条就能看到消息堆在根节点的缓冲里，而叶子那边一动不动。
        </p>
      </Panel>
    );
  }

  const exec = (command: Command) => void run(command);
  const pending = Object.values(f.buffers).reduce((n, b) => n + b.length, 0);
  const height = state.indexes['PRIMARY']?.height ?? 1;
  const amp = f.injected === 0 ? 0 : f.flushedHops / f.injected;
  const probe = f.lastProbe;
  // 缓冲里压着的消息按操作分类：删除消息还没到叶子时，叶子那边其实还留着数据。
  const byOp = { insert: 0, upsert: 0, delete: 0 };
  for (const list of Object.values(f.buffers)) for (const m of list) byOp[m.op]++;

  return (
    <Panel title="消息缓冲" subtitle={`容量 ${f.capacity} 条/节点 · 在途 ${pending} 条`}>
      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="写入次数" value={formatNumber(f.injected)} tone="accent" hint="每次写只往根缓冲追加一条消息" />
          <Stat
            label="写放大"
            value={f.injected === 0 ? '—' : `${amp.toFixed(2)}×`}
            tone={amp < height ? 'good' : 'warn'}
            hint={`下推条次 / 写入次数。B+ 树的这个数恒等于树高 ${height}`}
          />
          <Stat label="下推条次" value={formatNumber(f.flushedHops)} hint="消息一共被重写了多少次" />
          <Stat
            label="在途消息"
            value={pending}
            tone={pending > 0 ? 'warn' : 'good'}
            hint="还压在缓冲里、没到叶子的消息。范围扫描会逼着它们当场落地"
          />
          <Stat label="已落地" value={formatNumber(f.applied)} tone="good" hint="推到叶子、变成真正数据的消息" />
          <Stat label="强制清空" value={f.pathFlushes} hint="范围扫描 / 手动 flush 触发的整体下推" />
        </div>

        {pending > 0 && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">在途消息的构成</div>
            <div className="num flex gap-3 text-[10.5px] text-mute-300">
              <span>
                插入 <span className="text-green-500">{byOp.insert}</span>
              </span>
              <span>
                盲写 <span className="text-orange-500">{byOp.upsert}</span>
              </span>
              <span>
                删除 <span className="text-red-500">{byOp.delete}</span>
              </span>
            </div>
            {byOp.delete > 0 && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-mute-400/80">
                这 {byOp.delete} 条删除消息还没到叶子 —— 叶子里那些行其实**还在**，只是读的时候会先在缓冲里被拦下。
              </p>
            )}
          </div>
        )}

        {probe && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="flex items-baseline justify-between">
              <span className="text-mute-400">最近一次点查 key={probe.key}</span>
              <span className={probe.decidedInBuffer ? 'text-teal-500' : 'text-mute-400'}>
                {probe.decidedInBuffer ? '答案在缓冲里' : '走到了叶子'}
              </span>
            </div>
            <div className="num mt-1 text-[10.5px] text-mute-400">
              翻了 {probe.levels.length} 块缓冲（
              {probe.levels.map((l) => `#${l.nodeId}:${l.hits}/${l.messages}`).join(' · ')}）
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-mute-400/80">
              读放大就长在这里：B+ 树读 {height} 个页，它要读 {height} 个页**加**翻 {probe.levels.length} 块缓冲。
            </p>
          </div>
        )}

        <button
          className="dbkl-btn"
          data-testid="fractal-flush"
          disabled={busy}
          onClick={() => exec({ kind: 'flush_all' })}
          title="把所有缓冲里的消息强制推到叶子"
        >
          <ArrowDownToLine size={13} /> 把消息全部推到叶子
        </button>

        <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">它落在 B+ 树与 LSM 之间</div>
          <div className="num mb-1.5 text-[10px] leading-relaxed text-mute-400">
            读优化 ◀── B+ 树 ── <span className="text-orange-500">Bε-树</span> ── LSM ──▶ 写优化
          </div>
          <ul className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-mute-400">
            <li>
              <span className="text-green-500">✓</span> 写只碰根，攒批下推 —— 写放大 {amp.toFixed(2)}× 而不是 {height}×
            </li>
            <li>
              <span className="text-green-500">✓</span> 盲写：改一行**不用先读**（B 树给不了这个）
            </li>
            <li>
              <span className="text-green-500">✓</span> 数据仍然有序，范围扫描天然支持（LSM 要归并）
            </li>
            <li>
              <span className="text-red-500">✗</span> 读要沿路翻 {Math.max(0, height - 1)} 块缓冲
            </li>
            <li>
              <span className="text-red-500">✗</span> 范围扫描前得把在途消息全推下去
            </li>
          </ul>
          <p className="mt-1 text-[10.5px] leading-relaxed text-mute-400/80">
            到「参数」标签把缓冲容量调成 0：它会当场退化成一棵普通 B+ 树。这个旋钮就是 ε。
          </p>
        </div>
      </div>
    </Panel>
  );
}
