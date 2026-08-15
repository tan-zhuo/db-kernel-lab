import { Cpu } from 'lucide-react';
import { DEFAULT_ENGINE_CONFIG, listEngines, type EngineConfig } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

/**
 * 每个引擎的推荐起步参数。
 *
 * 不是「更好的默认值」，而是**让这个引擎的特征在小规模下就看得见**：
 * 堆表要小页容量才容易看到跨页与膨胀，LSM 要小 MemTable 才会频繁刷写与压实。
 */
const ENGINE_PRESETS: Record<string, Partial<EngineConfig>> = {
  'innodb-btree': { order: 4, bufferPoolFrames: 8 },
  'postgres-heap': { order: 4, bufferPoolFrames: 10, heapTuplesPerPage: 4, hotUpdate: true },
  'lsm-tree': { memtableLimit: 6, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 10 },
  columnar: { rowGroupSize: 12, vectorBatchSize: 4, zoneMaps: true, columnEncoding: 'auto' },
  'kv-hash': { kvLogFileRecords: 6, kvHashBuckets: 12, kvMergeThreshold: 0.4 },
};

/** 每个引擎最值得先看的一句话。 */
const ENGINE_HOOK: Record<string, string> = {
  'innodb-btree': '主键索引**就是**表：叶子页装着整行，二级索引要回表。',
  'postgres-heap': '表是一堆无序的页：索引只存 TID，取行必须再跳一次；更新写新版本，旧版本靠 VACUUM 回收。',
  'lsm-tree': '写只追加，从不原地改：装满就刷成文件、逐层压实；读要自上而下探测，靠布隆过滤器省 IO。',
  columnar: '数据按列放：同列同质所以压得极狠，查询**只读用到的那几列**，区间统计还能整块跳过。',
  'kv-hash': '全部键常驻内存哈希表：点查恒定一次磁盘读，但**完全不支持范围扫描**，规模被内存卡死。',
};

/**
 * 引擎选择面板。
 *
 * 换引擎 = 换一整套物理模型，所以会清空当前实验重新建表 ——
 * 「同一组操作在三种引擎下各自发生了什么」才是这个实验室的核心用法。
 */
export function EnginePanel() {
  const engineId = useSimStore((s) => s.engineId);
  const busy = useSimStore((s) => s.busy);
  const switchEngine = useSimStore((s) => s.switchEngine);
  const engines = listEngines();

  return (
    <Panel title="存储引擎" subtitle="换引擎会清空实验并重新建表">
      <ul className="flex flex-col gap-1.5">
        {engines.map((e) => {
          const active = e.id === engineId;
          return (
            <li key={e.id}>
              <button
                data-testid={`engine-${e.id}`}
                className={`w-full rounded-md border p-2 text-left transition-colors ${
                  active
                    ? 'border-accent-500/60 bg-accent-500/12'
                    : 'border-ink-700 bg-ink-850/60 hover:border-ink-500 hover:bg-ink-800'
                } ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
                disabled={busy}
                onClick={() => {
                  if (active) return;
                  void switchEngine(e.id, { ...DEFAULT_ENGINE_CONFIG, ...ENGINE_PRESETS[e.id] });
                }}
              >
                <div className="flex items-center gap-1.5">
                  <Cpu size={13} className={active ? 'text-accent-400' : 'text-mute-400'} />
                  <span className={`text-[12px] font-medium ${active ? 'text-accent-400' : 'text-mute-200'}`}>
                    {e.label}
                  </span>
                  {active && <span className="ml-auto text-[10px] text-accent-400">当前</span>}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-mute-400">{ENGINE_HOOK[e.id] ?? e.description}</p>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
