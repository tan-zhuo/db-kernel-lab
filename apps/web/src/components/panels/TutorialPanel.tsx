import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { listEngines } from '@dbkl/simulation-core';
import { SCENARIOS, type Scenario } from '@/content/scenarios';
import { runScenario } from '@/content/run-scenario';
import { useSimStore } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

export function TutorialPanel() {
  const busy = useSimStore((s) => s.busy);
  const engineId = useSimStore((s) => s.engineId);
  const [running, setRunning] = useState<string | null>(null);
  const [onlyCurrent, setOnlyCurrent] = useState(true);

  const engines = listEngines();
  const visible = onlyCurrent ? SCENARIOS.filter((s) => s.engineId === engineId) : SCENARIOS;

  const start = async (scenario: Scenario) => {
    setRunning(scenario.id);
    try {
      await runScenario(scenario);
    } finally {
      setRunning(null);
    }
  };

  return (
    <Panel
      title="引导实验"
      subtitle="一键搭好场景，再用时间轴单步观察"
      right={
        <button className="dbkl-btn" onClick={() => setOnlyCurrent(!onlyCurrent)}>
          {onlyCurrent ? '显示全部引擎' : '只看当前引擎'}
        </button>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {engines.map((engine) => {
          const items = visible.filter((s) => s.engineId === engine.id);
          if (items.length === 0) return null;
          return (
            <li key={engine.id}>
              {!onlyCurrent && (
                <div className="mb-1 mt-1 text-[10px] uppercase tracking-[0.14em] text-mute-400">{engine.label}</div>
              )}
              <ul className="flex flex-col gap-1.5">
                {items.map((s) => (
                  <li key={s.id} className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[12px] font-medium text-mute-200">{s.title}</h3>
                      <button
                        className="dbkl-btn shrink-0"
                        data-testid={`scenario-${s.id}`}
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
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
