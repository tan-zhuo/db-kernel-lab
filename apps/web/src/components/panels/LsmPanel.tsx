import { ArrowDownToLine, Layers } from 'lucide-react';
import { formatNumber } from '@dbkl/shared';
import { levelColor } from '@dbkl/visualization';
import {
  createLsmState,
  lsmLevelStats,
  lsmLiveKeys,
  spaceAmplification,
  writeAmplification,
  type Command,
} from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * LSM 面板：MemTable 水位、层级分布、三种放大、以及最近一次读取的探测轨迹。
 *
 * 三个放大数字是整个 LSM 调参的全部矛盾：
 *  - 写放大：一条记录被重写了几遍（压实越勤越大）
 *  - 读放大：一次点查读了几个文件（层数越多越大，布隆过滤器能压低它）
 *  - 空间放大：磁盘条目数 / 逻辑键数（压实越懒越大）
 * 改 `MemTable 上限` / `L0 触发值` / `层容量倍数` / `布隆位数`，三个数字会一起动。
 */
export function LsmPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  // 刚换到 LSM 引擎、还没写过任何数据时 state.lsm 还不存在；
  // 这时也要把面板画出来（空的 MemTable 本身就是有信息量的起点）。
  const l = state.lsm ?? createLsmState(state.config.memtableLimit);

  const exec = (command: Command) => void run(command);
  const levels = lsmLevelStats(l);
  const liveKeys = lsmLiveKeys(l).length;
  const writeAmp = writeAmplification(l);
  const spaceAmp = spaceAmplification(l);
  const memFill = l.memtable.limit === 0 ? 0 : l.memtable.entries.length / l.memtable.limit;
  const lastGet = l.lastGet;
  const capacityOf = (level: number) => state.config.memtableLimit * Math.pow(state.config.levelFanout, level);

  return (
    <Panel title="LSM 层级" subtitle="写只追加 · 读自上而下 · 压实换空间">
      <div className="flex flex-col gap-2.5">
        <div>
          <div className="mb-1 flex items-baseline justify-between text-[11px]">
            <span className="text-mute-400">MemTable</span>
            <span className="num text-teal-500">
              {l.memtable.entries.length}/{l.memtable.limit}
              {l.immutable.length > 0 && ` · 冻结 ${l.immutable.length}`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: `${Math.min(100, memFill * 100)}%`,
                background: memFill > 0.85 ? 'var(--color-orange-500)' : 'var(--color-teal-500)',
              }}
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-ink-700">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-ink-800 text-mute-400">
                <th className="px-2 py-1 text-left font-medium">层</th>
                <th className="px-2 py-1 text-right font-medium">文件</th>
                <th className="px-2 py-1 text-right font-medium">条目/容量</th>
                <th className="px-2 py-1 text-left font-medium">键区间</th>
              </tr>
            </thead>
            <tbody className="num">
              {levels.length === 0 && (
                <tr>
                  <td className="px-2 py-2 text-mute-400" colSpan={4}>
                    还没有 SST：写满一个 MemTable 就会刷出第一个文件
                  </td>
                </tr>
              )}
              {levels.map((lv) => {
                const ssts = l.levels[lv.level].map((id) => l.ssts[id]).filter(Boolean);
                const min = ssts.length ? Math.min(...ssts.map((s) => s.minKey)) : null;
                const max = ssts.length ? Math.max(...ssts.map((s) => s.maxKey)) : null;
                const over = lv.level > 0 && lv.entries > capacityOf(lv.level);
                return (
                  <tr key={lv.level} className="border-t border-ink-700/70">
                    <td className="px-2 py-1">
                      <span style={{ color: levelColor(lv.level) }}>L{lv.level}</span>
                    </td>
                    <td
                      className={`px-2 py-1 text-right ${
                        lv.level === 0 && lv.files >= state.config.l0CompactionTrigger ? 'text-orange-500' : 'text-mute-300'
                      }`}
                    >
                      {lv.files}
                    </td>
                    <td className={`px-2 py-1 text-right ${over ? 'text-orange-500' : 'text-mute-300'}`}>
                      {lv.entries}
                      {lv.level > 0 && <span className="text-mute-400">/{Math.round(capacityOf(lv.level))}</span>}
                    </td>
                    <td className="px-2 py-1 text-mute-400">{min === null ? '—' : `[${min}, ${max}]`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="逻辑键数" value={formatNumber(liveKeys)} tone="accent" hint="墓碑抵消之后真正存在的键" />
          <Stat
            label="写放大"
            value={Number.isNaN(writeAmp) ? '—' : `${writeAmp.toFixed(2)}×`}
            tone={writeAmp > 3 ? 'bad' : writeAmp > 1.8 ? 'warn' : 'good'}
            hint="落盘条目数 / 用户写入条目数"
          />
          <Stat
            label="空间放大"
            value={Number.isNaN(spaceAmp) ? '—' : `${spaceAmp.toFixed(2)}×`}
            tone={spaceAmp > 2.5 ? 'bad' : spaceAmp > 1.5 ? 'warn' : 'good'}
            hint="磁盘条目数 / 逻辑键数"
          />
          <Stat label="刷写" value={l.flushes} hint="MemTable → L0 的次数" />
          <Stat label="压实" value={l.compactions} />
          <Stat label="丢弃条目" value={formatNumber(l.droppedEntries)} hint="压实时被覆盖的旧版本与被回收的墓碑" />
          <Stat label="WAL 记录" value={formatNumber(l.wal.records)} />
          <Stat label="WAL 字节" value={formatNumber(l.wal.bytes)} />
          <Stat label="落盘条目" value={formatNumber(l.entriesWritten)} />
        </div>

        <div className="flex gap-2">
          <button
            className="dbkl-btn flex-1"
            data-testid="flush-memtable"
            disabled={busy}
            onClick={() => exec({ kind: 'flush_memtable' })}
          >
            <ArrowDownToLine size={13} /> 刷写 MemTable
          </button>
          <button
            className="dbkl-btn flex-1"
            data-testid="compact"
            disabled={busy}
            onClick={() => exec({ kind: 'compact' })}
          >
            <Layers size={13} /> 触发压实
          </button>
        </div>

        {lastGet && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="flex items-baseline justify-between">
              <span className="text-mute-400">最近一次点查 key={lastGet.key}</span>
              <span className={lastGet.found ? 'text-green-500' : 'text-red-500'}>
                {lastGet.found ? `命中于 ${lastGet.sstId ?? lastGet.source}` : '不存在'}
              </span>
            </div>
            <div className="num mt-1 text-[10.5px] text-mute-400">
              读放大 {lastGet.probes} 个 SST · 布隆过滤器挡掉 {lastGet.bloomSkips} 个
            </div>
            {l.probes.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {l.probes.slice(-14).map((p, i) => (
                  <span
                    key={i}
                    title={`${p.sstId} @ L${p.level} · ${PROBE_LABEL[p.kind]}${p.falsePositive ? '（假阳性）' : ''}`}
                    className={`num rounded px-1 py-[1px] text-[10px] ${PROBE_STYLE[p.kind]}`}
                  >
                    L{p.level}
                    {p.kind === 'bloom-skip' ? ' ⨯' : p.found ? ' ✓' : ' ·'}
                    {p.falsePositive ? '!' : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-[10.5px] leading-relaxed text-mute-400/80">
          场景里砖块的**宽度就是键区间**：L0 的文件互相重叠（所以点查要全看一遍），
          L1 及以下整齐排开、绝不重叠（所以每层最多读一个文件）。颜色越红表示墓碑占比越高。
        </p>
      </div>
    </Panel>
  );
}

const PROBE_LABEL: Record<string, string> = {
  'bloom-skip': '布隆过滤器判定一定不存在，整个文件跳过',
  'bloom-maybe': '布隆过滤器说可能存在，需要真的读',
  read: '读取了这个文件',
};

const PROBE_STYLE: Record<string, string> = {
  'bloom-skip': 'bg-green-500/15 text-green-500',
  'bloom-maybe': 'bg-amber-500/15 text-amber-500',
  read: 'bg-accent-500/15 text-accent-400',
};
