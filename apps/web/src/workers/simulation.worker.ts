/// <reference lib="webworker" />
import {
  DEFAULT_ENGINE_ID,
  EVENT_CHUNK_SIZE,
  createEngine,
  type SimulationEvent,
  type StorageEngine,
  type WorkerRequest,
  type WorkerResponse,
} from '@dbkl/simulation-core';

/**
 * 仿真 Worker：所有引擎计算都在这里执行，主线程只负责渲染与交互。
 *
 * 批量插入十万级事件时，事件按 chunk 回传，主线程可以边收边画，
 * 不会因为一次巨大的 postMessage 而掉帧。
 *
 * 引擎由 `engineId` 从注册表里取（InnoDB / PostgreSQL 堆表 / LSM），
 * Worker 本身对具体引擎一无所知 —— 它只搬运命令与事件。
 */

let engine: StorageEngine | null = null;

function post(message: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

function stream(requestId: number, events: SimulationEvent[], done: boolean, progress?: { done: number; total: number }): void {
  if (events.length <= EVENT_CHUNK_SIZE) {
    post({ type: 'events', requestId, events, done, progress });
    return;
  }
  for (let i = 0; i < events.length; i += EVENT_CHUNK_SIZE) {
    const chunk = events.slice(i, i + EVENT_CHUNK_SIZE);
    const last = i + EVENT_CHUNK_SIZE >= events.length;
    post({ type: 'events', requestId, events: chunk, done: done && last, progress });
  }
}

self.onmessage = (message: MessageEvent<WorkerRequest>) => {
  const req = message.data;
  try {
    switch (req.type) {
      case 'init':
      case 'reset': {
        const engineId = req.engineId ?? DEFAULT_ENGINE_ID;
        engine = createEngine(engineId, req.config);
        post({
          type: 'ready',
          requestId: req.requestId,
          engine: { id: engineId, name: engine.name, capabilities: engine.capabilities },
        });
        const replayCommands = req.type === 'init' ? (req.replay ?? []) : [];
        if (replayCommands.length === 0) {
          post({ type: 'events', requestId: req.requestId, events: [], done: true });
          break;
        }
        // 会话恢复：确定性重放命令日志，事件流与上次逐字节一致。
        replayCommands.forEach((command, i) => {
          const events = engine!.execute(command);
          stream(req.requestId, events, i === replayCommands.length - 1, {
            done: i + 1,
            total: replayCommands.length,
          });
        });
        break;
      }
      case 'run': {
        if (!engine) throw new Error('engine not initialised');
        stream(req.requestId, engine.execute(req.command), true);
        break;
      }
      default: {
        const never: never = req;
        throw new Error(`unknown request ${JSON.stringify(never)}`);
      }
    }
  } catch (err) {
    post({
      type: 'error',
      requestId: req.requestId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
};
