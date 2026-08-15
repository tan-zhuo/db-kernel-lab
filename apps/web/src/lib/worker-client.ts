import type { Command, EngineConfig, SimulationEvent, WorkerResponse } from '@dbkl/simulation-core';

type EventSink = (events: SimulationEvent[], progress?: { done: number; total: number }) => void;

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
  onEvents: EventSink;
}

/**
 * 主线程侧的 Worker 客户端：把 postMessage 往返包装成 Promise + 事件流回调。
 */
export class SimulationClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private engineInfo: { id: string; name: string; capabilities: readonly string[] } | null = null;

  constructor() {
    this.worker = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), {
      type: 'module',
      name: 'dbkl-simulation',
    });
    this.worker.onmessage = (m: MessageEvent<WorkerResponse>) => this.handle(m.data);
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'worker crashed'));
      this.pending.clear();
    };
  }

  get engine(): { id: string; name: string; capabilities: readonly string[] } | null {
    return this.engineInfo;
  }

  init(engineId: string, config: EngineConfig, replay: Command[] | undefined, onEvents: EventSink): Promise<void> {
    return this.request((requestId) => ({ type: 'init', requestId, engineId, config, replay }), onEvents);
  }

  reset(engineId: string, config: EngineConfig, onEvents: EventSink): Promise<void> {
    return this.request((requestId) => ({ type: 'reset', requestId, engineId, config }), onEvents);
  }

  run(command: Command, onEvents: EventSink): Promise<void> {
    return this.request((requestId) => ({ type: 'run', requestId, command }), onEvents);
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }

  private request(build: (id: number) => import('@dbkl/simulation-core').WorkerRequest, onEvents: EventSink): Promise<void> {
    const requestId = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onEvents });
      this.worker.postMessage(build(requestId));
    });
  }

  private handle(res: WorkerResponse): void {
    const pending = this.pending.get(res.requestId);
    switch (res.type) {
      case 'ready':
        this.engineInfo = res.engine;
        break;
      case 'events':
        if (!pending) return;
        pending.onEvents(res.events, res.progress);
        if (res.done) {
          this.pending.delete(res.requestId);
          pending.resolve();
        }
        break;
      case 'error':
        if (!pending) return;
        this.pending.delete(res.requestId);
        pending.reject(new Error(res.message));
        break;
    }
  }
}
