import { DEFAULT_ENGINE_CONFIG } from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import type { Scenario } from './scenarios';

/**
 * 跑一个引导实验：切到它所属的引擎、按它的参数重置、依次执行命令，
 * 最后回到起点整体播放一遍。
 *
 * 先把整场安静地跑完再回放，是为了让用户看到的是一段**完整**的动画，
 * 而不是一边执行一边跳。
 */
export async function runScenario(scenario: Scenario): Promise<void> {
  const store = useSimStore.getState();
  store.setAutoPlay(false);
  try {
    await store.switchEngine(scenario.engineId, { ...DEFAULT_ENGINE_CONFIG, ...scenario.config });
    const from = useSimStore.getState().history.length;
    for (const command of scenario.commands) {
      await useSimStore.getState().run(command);
    }
    useSimStore.getState().setAutoPlay(true);
    useSimStore.getState().goTo(from);
    useSimStore.getState().setSpeed(2);
    useSimStore.getState().play();
  } finally {
    useSimStore.getState().setAutoPlay(true);
  }
}
