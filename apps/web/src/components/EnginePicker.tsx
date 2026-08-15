import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { DEFAULT_ENGINE_CONFIG, listEngines, type EngineConfig } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';

/**
 * 每个引擎的推荐起步参数。
 *
 * 不是「更好的默认值」，而是**让这个引擎的特征在小规模下就看得见**：
 * 堆表要小页容量才容易看到跨页与膨胀，LSM 要小 MemTable 才会频繁刷写与压实，
 * 列存要够大的行组才压得动，KV 要小文件才看得到合并。
 */
export const ENGINE_PRESETS: Record<string, Partial<EngineConfig>> = {
  'innodb-btree': { order: 4, bufferPoolFrames: 8 },
  'postgres-heap': { order: 4, bufferPoolFrames: 10, heapTuplesPerPage: 4, hotUpdate: true },
  'lsm-tree': { memtableLimit: 6, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 10 },
  columnar: { rowGroupSize: 12, vectorBatchSize: 4, zoneMaps: true, columnEncoding: 'auto' },
  'kv-hash': { kvLogFileRecords: 6, kvHashBuckets: 12, kvMergeThreshold: 0.4 },
};

/** 每个引擎最值得先记住的一句话。 */
const ENGINE_HOOK: Record<string, string> = {
  'innodb-btree': '主键索引就是表：叶子页装着整行，二级索引要回表。',
  'postgres-heap': '表是一堆无序的页：索引只存 TID，取行必须再跳一次；更新写新版本，靠 VACUUM 回收。',
  'lsm-tree': '写只追加，从不原地改：装满就刷成文件、后台逐层压实；读要自上而下探测。',
  columnar: '数据按列放：同列同质所以压得极狠，查询只读用到的那几列。',
  'kv-hash': '全部键常驻内存哈希表：点查恒定一次寻址，但完全不支持范围扫描。',
};

/**
 * 引擎选择器。
 *
 * 从左侧栏挪到顶栏：它是**全局模式开关**，不该跟操作面板一样躺在会滚动的列里，
 * 更不该常年占掉一屏三分之一的高度。
 *
 * 换引擎 = 换一整套物理模型，所以会清空当前实验重新建表 ——
 * 「同一组操作在五种引擎下各自发生了什么」才是这个实验室的核心用法。
 */
export function EnginePicker() {
  const engineId = useSimStore((s) => s.engineId);
  const busy = useSimStore((s) => s.busy);
  const switchEngine = useSimStore((s) => s.switchEngine);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const engines = listEngines();
  const current = engines.find((e) => e.id === engineId);

  return (
    <div className="relative" ref={ref}>
      <button
        className="dbkl-btn"
        data-testid="engine-picker"
        disabled={busy}
        title="切换存储引擎（会清空实验并重新建表）"
        onClick={() => setOpen(!open)}
      >
        <Cpu size={13} className="text-accent-400" />
        <span className="max-w-[150px] truncate">{current?.label ?? '引擎加载中…'}</span>
        <ChevronDown size={12} className="text-mute-400" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[330px] rounded-md border border-ink-600 bg-ink-850 p-1.5 shadow-xl shadow-black/40"
          data-testid="engine-menu"
        >
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-[0.14em] text-mute-400">存储引擎</div>
          <ul className="flex flex-col gap-0.5">
            {engines.map((e) => {
              const active = e.id === engineId;
              return (
                <li key={e.id}>
                  <button
                    data-testid={`engine-${e.id}`}
                    className={`flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left transition-colors ${
                      active ? 'bg-accent-500/15' : 'hover:bg-ink-800'
                    }`}
                    onClick={() => {
                      setOpen(false);
                      if (active) return;
                      void switchEngine(e.id, { ...DEFAULT_ENGINE_CONFIG, ...ENGINE_PRESETS[e.id] });
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[12px] ${active ? 'text-accent-400' : 'text-mute-200'}`}>
                        {e.label}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] leading-snug text-mute-400">
                        {ENGINE_HOOK[e.id] ?? e.description}
                      </span>
                    </span>
                    {active && <Check size={13} className="mt-[3px] shrink-0 text-accent-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-1.5 pt-1.5 text-[10px] leading-relaxed text-mute-400/80">
            换引擎会清空当前实验并重新建表。想先了解各自的原理，点顶栏的「原理」。
          </p>
        </div>
      )}
    </div>
  );
}
