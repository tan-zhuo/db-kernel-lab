import { useEffect } from 'react';
import { TopBar } from '@/components/TopBar';
import { SceneOverlay } from '@/components/SceneOverlay';
import { GuideOverlay } from '@/components/GuideOverlay';
import { SceneRoot } from '@/components/scene/SceneRoot';
import { OperationsPanel } from '@/components/panels/OperationsPanel';
import { QueryPanel } from '@/components/panels/QueryPanel';
import { IndexPanel } from '@/components/panels/IndexPanel';
import { SchemaPanel } from '@/components/panels/SchemaPanel';
import { PlanPanel } from '@/components/panels/PlanPanel';
import { ConfigPanel } from '@/components/panels/ConfigPanel';
import { InspectorPanel } from '@/components/panels/InspectorPanel';
import { MetricsPanel } from '@/components/panels/MetricsPanel';
import { EventLogPanel } from '@/components/panels/EventLogPanel';
import { TutorialPanel } from '@/components/panels/TutorialPanel';
import { TransactionPanel } from '@/components/panels/TransactionPanel';
import { LsmPanel } from '@/components/panels/LsmPanel';
import { ColumnarPanel } from '@/components/panels/ColumnarPanel';
import { KvPanel } from '@/components/panels/KvPanel';
import { CowPanel } from '@/components/panels/CowPanel';
import { FractalPanel } from '@/components/panels/FractalPanel';
import { Timeline } from '@/components/timeline/Timeline';
import { Rail, type RailTab } from '@/components/ui/Rail';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCapability, usePlaybackDriver, useSimStore } from '@/state/store';

/**
 * 主布局：左侧「做什么」，中央 3D 视口，右侧「发生了什么」，底部时间轴。
 *
 * 两条侧栏都是**分组标签页**而不是一长列面板 —— 五个引擎各带一套面板之后，
 * 全部平铺会让人滚半天才找得到东西，而主角（画面）反被挤在中间。
 * 侧栏还能整条收起，把宽度全让给 3D 视图。
 *
 * 标签内容按**引擎能力**裁剪：LSM 没有索引面板，哈希 KV 连查询构造器都没有意义。
 */
export function App() {
  const boot = useSimStore((s) => s.boot);
  // 事务面板讲的是 MVCC 那套（版本链 / 快照 / VACUUM），所以按 mvcc 挂而不是 transactions ——
  // 写时复制引擎也有事务，但它的事务是另一回事，由 CowPanel 自己讲。
  const hasMvcc = useCapability('mvcc');
  const hasLsm = useCapability('lsm');
  const hasColumnar = useCapability('columnar');
  const hasKv = useCapability('kv');
  const hasCow = useCapability('cow');
  const hasMessageBuffer = useCapability('message-buffer');
  const hasSecondaryIndex = useCapability('secondary-index');
  // 哈希 KV 只有「按键点查」一条路，查询构造器对它没有意义。
  const hasQuery = !hasKv;

  useKeyboardShortcuts();
  usePlaybackDriver();

  useEffect(() => {
    void boot();
  }, [boot]);

  const leftTabs: RailTab[] = [
    {
      id: 'ops',
      label: '操作',
      render: () => (
        <>
          <OperationsPanel />
          {hasMvcc && <TransactionPanel />}
          {hasSecondaryIndex && <IndexPanel />}
        </>
      ),
    },
    {
      id: 'query',
      label: '查询',
      available: hasQuery,
      // 计划面板跟着查询走：它就是「这条查询会怎么执行」的答案。
      // 之前它在右栏，看的时候要左右来回扫。
      render: () => (
        <>
          <QueryPanel />
          <PlanPanel />
        </>
      ),
    },
    {
      id: 'config',
      label: '参数',
      render: () => (
        <>
          <ConfigPanel />
          <SchemaPanel />
        </>
      ),
    },
    { id: 'tutorial', label: '实验', render: () => <TutorialPanel /> },
  ];

  const rightTabs: RailTab[] = [
    {
      id: 'state',
      label: '状态',
      // 引擎专属面板 + 通用指标：「这个引擎现在什么样」和「数字是多少」本来就是一起看的。
      render: () => (
        <>
          {hasLsm && <LsmPanel />}
          {hasColumnar && <ColumnarPanel />}
          {hasKv && <KvPanel />}
          {hasCow && <CowPanel />}
          {hasMessageBuffer && <FractalPanel />}
          <MetricsPanel />
        </>
      ),
    },
    { id: 'inspect', label: '检查器', render: () => <InspectorPanel /> },
    { id: 'log', label: '事件日志', render: () => <EventLogPanel /> },
  ];

  return (
    <div className="relative flex h-full flex-col bg-ink-950">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Rail side="left" tabs={leftTabs} storageKey="dbkl-rail-left" />
        <main className="relative min-w-0 flex-1">
          <SceneRoot />
          <SceneOverlay />
        </main>
        <Rail side="right" tabs={rightTabs} storageKey="dbkl-rail-right" />
      </div>
      <Timeline />
      <GuideOverlay />
    </div>
  );
}
