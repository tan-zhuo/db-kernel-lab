import type { SimulationEvent } from './events';
import type { Command, EngineConfig } from './engine/types';

/**
 * 主线程 ↔ Web Worker 协议。
 *
 * 所有消息都必须是结构化克隆安全的纯数据。事件按批回传（chunk），
 * 这样批量插入几万条时主线程可以边收边渲染，不会等待整个命令结束。
 */

export interface RunCommandRequest {
  type: 'run';
  requestId: number;
  command: Command;
}

export interface InitRequest {
  type: 'init';
  requestId: number;
  config: EngineConfig;
  /** 重放命令日志以恢复上次会话（引擎确定性保证事件流一致）。 */
  replay?: Command[];
}

export interface ResetRequest {
  type: 'reset';
  requestId: number;
  config: EngineConfig;
}

export type WorkerRequest = InitRequest | RunCommandRequest | ResetRequest;

export interface EventsResponse {
  type: 'events';
  requestId: number;
  events: SimulationEvent[];
  /** 该请求是否已产出全部事件。 */
  done: boolean;
  /** 已完成的命令数（replay 进度）。 */
  progress?: { done: number; total: number };
}

export interface ReadyResponse {
  type: 'ready';
  requestId: number;
  engine: { name: string; capabilities: readonly string[] };
}

export interface ErrorResponse {
  type: 'error';
  requestId: number;
  message: string;
  stack?: string;
}

export type WorkerResponse = EventsResponse | ReadyResponse | ErrorResponse;

/** 一批最多回传多少事件，避免单条 postMessage 过大。 */
export const EVENT_CHUNK_SIZE = 4000;
