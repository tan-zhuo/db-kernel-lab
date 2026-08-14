import { useEffect } from 'react';
import { TopBar } from '@/components/TopBar';
import { SceneOverlay } from '@/components/SceneOverlay';
import { SceneRoot } from '@/components/scene/SceneRoot';
import { OperationsPanel } from '@/components/panels/OperationsPanel';
import { ConfigPanel } from '@/components/panels/ConfigPanel';
import { InspectorPanel } from '@/components/panels/InspectorPanel';
import { MetricsPanel } from '@/components/panels/MetricsPanel';
import { EventLogPanel } from '@/components/panels/EventLogPanel';
import { TutorialPanel } from '@/components/panels/TutorialPanel';
import { Timeline } from '@/components/timeline/Timeline';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePlaybackDriver, useSimStore } from '@/state/store';

/**
 * 主布局（文档 §13）：
 * 左侧操作 / 参数，中央超大 3D 视口，右侧检查器与指标，底部时间轴。
 */
export function App() {
  const boot = useSimStore((s) => s.boot);
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
          <OperationsPanel />
          <ConfigPanel />
          <TutorialPanel />
        </aside>

        <main className="relative min-w-0 flex-1">
          <SceneRoot />
          <SceneOverlay />
        </main>

        <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-ink-700 bg-ink-900">
          <InspectorPanel />
          <MetricsPanel />
          <EventLogPanel />
        </aside>
      </div>
      <Timeline />
    </div>
  );
}
