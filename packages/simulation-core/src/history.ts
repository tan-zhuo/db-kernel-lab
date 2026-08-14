import type { CommandKind } from '@dbkl/shared';
import type { SimulationEvent } from './events';
import { applyEvent, cloneState, createInitialState, type LabState } from './state';
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from './engine/types';

export interface CommandSpan {
  cmd: number;
  kind: CommandKind;
  label: string;
  /** 该命令第一个事件的下标。 */
  startSeq: number;
  /** 该命令最后一个事件的下标（含）。 */
  endSeq: number;
  startTime: number;
  endTime: number;
  ok: boolean;
  note?: string;
}

interface Checkpoint {
  /** 已应用的事件数量（= 下一个待应用事件的下标）。 */
  index: number;
  state: LabState;
}

/**
 * 时间旅行的基础设施：完整事件流 + 稀疏检查点。
 *
 * 跳到任意时间点 = 从最近的检查点克隆，再重放不超过 `interval` 个事件。
 * 检查点数量有上限，超过后间隔翻倍并抽稀，保证长实验下内存不爆。
 */
export class HistoryManager {
  private events: SimulationEvent[] = [];
  private checkpoints: Checkpoint[] = [];
  private headState: LabState;
  private spans: CommandSpan[] = [];
  private interval: number;

  constructor(
    private config: EngineConfig = DEFAULT_ENGINE_CONFIG,
    private readonly maxCheckpoints = 24,
    initialInterval = 200,
  ) {
    this.interval = initialInterval;
    this.headState = createInitialState(config);
    this.checkpoints.push({ index: 0, state: cloneState(this.headState) });
  }

  get length(): number {
    return this.events.length;
  }

  get all(): readonly SimulationEvent[] {
    return this.events;
  }

  get commands(): readonly CommandSpan[] {
    return this.spans;
  }

  /** 事件流覆盖的逻辑总时长。 */
  get duration(): number {
    return this.events.length === 0 ? 0 : this.events[this.events.length - 1].t;
  }

  at(index: number): SimulationEvent | undefined {
    return this.events[index];
  }

  /** 追加一批事件；同时推进 head 状态、维护检查点与命令区间索引。 */
  push(batch: readonly SimulationEvent[]): void {
    for (const e of batch) {
      this.events.push(e);
      applyEvent(this.headState, e);
      this.indexCommand(e);
      if (this.events.length % this.interval === 0) {
        this.checkpoints.push({ index: this.events.length, state: cloneState(this.headState) });
        this.compactCheckpoints();
      }
    }
  }

  /** 应用了前 `index` 个事件之后的状态（返回可安全修改的副本）。 */
  stateAt(index: number): LabState {
    const target = Math.max(0, Math.min(index, this.events.length));
    const cp = this.nearestCheckpoint(target);
    const state = cloneState(cp.state);
    for (let i = cp.index; i < target; i++) applyEvent(state, this.events[i]);
    return state;
  }

  /** 只读的最新状态（全部事件应用后）。调用方不得修改。 */
  get head(): LabState {
    return this.headState;
  }

  /** 逻辑时间 → 事件下标（用于时间轴按时间拖动）。 */
  indexAtTime(t: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 从 `index` 起，下一个「关键帧」事件的下标（用于跳到下一次分裂等）。 */
  nextMatching(index: number, predicate: (e: SimulationEvent) => boolean, direction: 1 | -1 = 1): number | null {
    for (let i = index + direction; i >= 0 && i < this.events.length; i += direction) {
      if (predicate(this.events[i])) return i;
    }
    return null;
  }

  reset(config: EngineConfig = this.config): void {
    this.config = config;
    this.events = [];
    this.spans = [];
    this.headState = createInitialState(config);
    this.checkpoints = [{ index: 0, state: cloneState(this.headState) }];
  }

  private nearestCheckpoint(index: number): Checkpoint {
    let best = this.checkpoints[0];
    for (const cp of this.checkpoints) {
      if (cp.index <= index && cp.index >= best.index) best = cp;
    }
    return best;
  }

  private compactCheckpoints(): void {
    if (this.checkpoints.length <= this.maxCheckpoints) return;
    // 抽稀：保留第 0 个与偶数位检查点，间隔翻倍。
    const kept: Checkpoint[] = [];
    for (let i = 0; i < this.checkpoints.length; i++) {
      if (i === 0 || i % 2 === 0 || i === this.checkpoints.length - 1) kept.push(this.checkpoints[i]);
    }
    this.checkpoints = kept;
    this.interval *= 2;
  }

  private indexCommand(e: SimulationEvent): void {
    if (e.type === 'COMMAND_BEGIN') {
      this.spans.push({
        cmd: e.cmd,
        kind: e.kind,
        label: e.label,
        startSeq: e.seq,
        endSeq: e.seq,
        startTime: e.t,
        endTime: e.t,
        ok: true,
      });
      return;
    }
    const span = this.spans[this.spans.length - 1];
    if (!span || span.cmd !== e.cmd) return;
    span.endSeq = e.seq;
    span.endTime = e.t;
    if (e.type === 'COMMAND_END') {
      span.ok = e.ok;
      span.note = e.note;
    }
  }
}

/** 便捷函数：把一段事件流重放成状态（测试与导入外部轨迹时使用）。 */
export function replay(events: readonly SimulationEvent[], config: EngineConfig = DEFAULT_ENGINE_CONFIG): LabState {
  const state = createInitialState(config);
  for (const e of events) applyEvent(state, e);
  return state;
}
