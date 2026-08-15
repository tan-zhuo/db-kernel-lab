import { useEffect } from 'react';
import { TopBar } from '@/components/TopBar';
import { SceneOverlay } from '@/components/SceneOverlay';
import { SceneRoot } from '@/components/scene/SceneRoot';
import { EnginePanel } from '@/components/panels/EnginePanel';
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
import { Timeline } from '@/components/timeline/Timeline';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCapability, usePlaybackDriver, useSimStore } from '@/state/store';

/**
 * 主布局（文档 §13）：
 * 左侧操作 / 参数，中央超大 3D 视口，右侧检查器与指标，底部时间轴。
 *
 * 面板按**引擎能力**挂载：换成 LSM 引擎时索引面板会消失、LSM 层级面板出现，
 * 换成 PostgreSQL 堆表时多出事务 / MVCC 面板。
 */
export function App() {
  const boot = useSimStore((s) => s.boot);
  const hasTransactions = useCapability('transactions');
  const hasLsm = useCapability('lsm');
  const hasSecondaryIndex = useCapability('secondary-index');
  useKeyboardShortcuts();
  usePlaybackDriver();

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-ink-700 bg-ink-900">
          <EnginePanel />
          <OperationsPanel />
          {hasTransactions && <TransactionPanel />}
          <QueryPanel />
          {hasSecondaryIndex && <IndexPanel />}
          <ConfigPanel />
          <SchemaPanel />
          <TutorialPanel />
        </aside>

        <main className="relative min-w-0 flex-1">
          <SceneRoot />
          <SceneOverlay />
        </main>

        <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-ink-700 bg-ink-900">
          {hasLsm && <LsmPanel />}
          <PlanPanel />
          <InspectorPanel />
          <MetricsPanel />
          <EventLogPanel />
        </aside>
      </div>
      <Timeline />
    </div>
  );
}
