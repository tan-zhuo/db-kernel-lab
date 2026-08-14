import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { DEFAULT_ENGINE_CONFIG, type Command, type EngineConfig } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

interface Scenario {
  id: string;
  title: string;
  goal: string;
  config: Partial<EngineConfig>;
  commands: Command[];
}

/**
 * 引导式实验（文档 §12「教程模式」）。
 * 每个实验 = 一组固定参数 + 一串命令，跑完后用时间轴单步观察即可。
 */
const SCENARIOS: Scenario[] = [
  {
    id: 'split',
    title: '① 页分裂与树的生长',
    goal: '阶数 4 的树里顺序插入 12 行：看叶子页装满 3 条后如何一分为二、中间键如何上浮成为根页的分隔键。',
    config: { order: 4, bufferPoolFrames: 8, fillFactor: 0.5 },
    commands: [{ kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'fill-factor',
    title: '② 填充因子的影响',
    goal: '把分裂点推到 0.9：右倾分裂让左页几乎装满、右页很空，页数更少但后续插入更容易再次分裂。',
    config: { order: 6, fillFactor: 0.9, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 30, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'sequential-opt',
    title: '③ 顺序插入右倾优化',
    goal: 'InnoDB 对自增主键的优化：最右叶子页分裂时几乎不搬数据，观察每次分裂只有 1 条记录被搬到新页。',
    config: { order: 6, sequentialInsertOptimization: true, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'random-vs-seq',
    title: '④ 随机主键的代价',
    goal: '随机主键插入 60 行：分裂遍布整棵树、页填充率参差不齐，与顺序插入形成对照。',
    config: { order: 5, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 60, pattern: 'random', max: 400 }],
  },
  {
    id: 'buffer-thrash',
    title: '⑤ 缓冲池抖动',
    goal: '只给 3 个帧再做全索引扫描：命中率暴跌、淘汰不断发生，脏页在淘汰前被强制刷盘。',
    config: { order: 4, bufferPoolFrames: 3, evictionPolicy: 'LRU' },
    commands: [
      { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 },
      { kind: 'full_scan' },
    ],
  },
  {
    id: 'merge',
    title: '⑥ 删除、借位与页合并',
    goal: '先插 24 行再删掉一半：观察叶子页低于半满时先向兄弟页借记录，借不到就合并并回收页，树高回落。',
    config: { order: 4, bufferPoolFrames: 8 },
    commands: [
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: 'delete', key: i * 2 + 1 }) as Command),
    ],
  },
  {
    id: 'point-vs-range',
    title: '⑦ 点查 vs 范围扫描',
    goal: '同一棵树上先点查再范围扫描：点查沿路径下降 O(logN) 次读页，范围扫描定位一次后沿叶子链表顺序前进。',
    config: { order: 5, bufferPoolFrames: 6 },
    commands: [
      { kind: 'bulk_insert', count: 50, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 37 },
      { kind: 'range_scan', from: 20, to: 34 },
    ],
  },
];

export function TutorialPanel() {
  const busy = useSimStore((s) => s.busy);
  const resetEngine = useSimStore((s) => s.resetEngine);
  const run = useSimStore((s) => s.run);
  const config = useSimStore((s) => s.config);
  const [running, setRunning] = useState<string | null>(null);

  const start = async (scenario: Scenario) => {
    setRunning(scenario.id);
    const store = useSimStore.getState();
    // 先安静地把整个场景跑完，再回到起点整体播放一遍。
    store.setAutoPlay(false);
    try {
      await resetEngine({ ...DEFAULT_ENGINE_CONFIG, ...config, ...scenario.config });
      const start = useSimStore.getState().history.length;
      for (const command of scenario.commands) {
        await run(command);
      }
      store.setAutoPlay(true);
      useSimStore.getState().goTo(start);
      useSimStore.getState().setSpeed(2);
      useSimStore.getState().play();
    } finally {
      store.setAutoPlay(true);
      setRunning(null);
    }
  };

  return (
    <Panel title="引导实验" subtitle="一键搭好场景，再用时间轴单步观察">
      <ul className="flex flex-col gap-1.5">
        {SCENARIOS.map((s) => (
          <li key={s.id} className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[12px] font-medium text-mute-200">{s.title}</h3>
              <button
                className="dbkl-btn shrink-0"
                disabled={busy || running !== null}
                onClick={() => void start(s)}
              >
                <GraduationCap size={13} />
                {running === s.id ? '进行中' : '开始'}
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-mute-400">{s.goal}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
