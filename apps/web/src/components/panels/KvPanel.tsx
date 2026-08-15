import { Layers } from 'lucide-react';
import { formatBytes, formatNumber, formatPercent } from '@dbkl/shared';
import type { Command } from '@dbkl/simulation-core';
import { useLabState, useSimStore } from '@/state/store';
import { Panel, Stat } from '@/components/ui/Panel';

/**
 * 哈希索引 KV 面板。
 *
 * 三个数字是这类引擎的全部性格：
 *  - **内存索引大小**：键数 × 每项开销。它就是数据规模的硬上限；
 *  - **探测步数**：桶内冲突链长度，与数据量无关 —— 点查恒定一次磁盘读；
 *  - **垃圾占比**：被覆盖的旧记录还躺在文件里，靠合并回收。
 */
export function KvPanel() {
  const state = useLabState();
  const run = useSimStore((s) => s.run);
  const busy = useSimStore((s) => s.busy);
  const k = state.kv;
  if (!k) {
    return (
      <Panel title="哈希索引 KV" subtitle="点查恒定一跳 · 不支持范围扫描">
        <p className="text-[12px] leading-relaxed text-mute-400">还没有数据。写入几条就能看到内存哈希表与磁盘日志文件。</p>
      </Panel>
    );
  }

  const exec = (command: Command) => void run(command);
  const chains = new Map<number, number>();
  for (const e of k.index) chains.set(e.bucket, (chains.get(e.bucket) ?? 0) + 1);
  const longest = chains.size === 0 ? 0 : Math.max(...chains.values());
  const used = chains.size;
  const totalRecords = k.files.reduce((n, f) => n + f.records, 0);
  const liveRecords = k.index.length;
  const garbage = totalRecords === 0 ? 0 : 1 - liveRecords / totalRecords;
  const probe = k.lastProbe;

  return (
    <Panel title="哈希索引 KV" subtitle="内存索引 + 追加写日志 · 一次寻址">
      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="键数" value={formatNumber(k.index.length)} tone="accent" />
          <Stat
            label="索引内存"
            value={formatBytes(k.indexBytes)}
            tone="warn"
            hint="全部键常驻内存 —— 这就是哈希 KV 的规模上限"
          />
          <Stat label="日志文件" value={k.files.length} />
          <Stat label="桶使用" value={`${used}/${k.buckets}`} hint="用到的桶 / 总桶数" />
          <Stat
            label="最长冲突链"
            value={longest}
            tone={longest > 4 ? 'warn' : 'good'}
            hint="桶配少了链就长，点查要多走几步（但仍与数据量无关）"
          />
          <Stat
            label="垃圾占比"
            value={formatPercent(garbage, 0)}
            tone={garbage > 0.4 ? 'bad' : garbage > 0.2 ? 'warn' : 'good'}
            hint="被覆盖/删除的旧记录还躺在文件里，靠合并回收"
          />
          <Stat label="磁盘记录" value={formatNumber(totalRecords)} hint="含已失效的" />
          <Stat label="有效记录" value={formatNumber(liveRecords)} tone="good" />
          <Stat label="合并次数" value={k.merges} />
        </div>

        {probe && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2 text-[11px]">
            <div className="flex items-baseline justify-between">
              <span className="text-mute-400">最近一次点查 key={probe.key}</span>
              <span className={probe.found ? 'text-green-500' : 'text-red-500'}>
                {probe.found ? '命中' : '不存在'}
              </span>
            </div>
            <div className="num mt-1 text-[10.5px] text-mute-400">
              桶 {probe.bucket} · 链上走 {probe.chainSteps} 步 ·{' '}
              {probe.found ? `${probe.fileId}@${probe.offset} —— 一次磁盘读` : '全程没碰磁盘'}
            </div>
          </div>
        )}

        <button className="dbkl-btn" data-testid="kv-merge" disabled={busy} onClick={() => exec({ kind: 'compact' })}>
          <Layers size={13} /> 合并（回收失效记录）
        </button>
        {k.lastMerge && (
          <p className="text-[10.5px] leading-relaxed text-mute-400">
            上次合并：保留 {k.lastMerge.liveRecords} 条、丢弃 {k.lastMerge.deadRecords} 条，回收{' '}
            {formatBytes(k.lastMerge.reclaimedBytes)}。
          </p>
        )}

        <div className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-mute-400">和 LSM 的分水岭</div>
          <ul className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-mute-400">
            <li>
              <span className="text-green-500">✓</span> 点查一次寻址，延迟与数据量**完全无关**
            </li>
            <li>
              <span className="text-red-500">✗</span> 范围扫描**根本做不到** —— 哈希把键打散了
            </li>
            <li>
              <span className="text-red-500">✗</span> 键数被内存卡死（现在 {formatBytes(k.indexBytes)}）
            </li>
          </ul>
          <p className="mt-1 text-[10.5px] leading-relaxed text-mute-400/80">
            需要范围扫描或键多到内存放不下，就得换成有序结构（B+ 树或 LSM）。选型的全部内容就这三条。
          </p>
        </div>
      </div>
    </Panel>
  );
}
