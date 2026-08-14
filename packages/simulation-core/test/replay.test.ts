import { describe, expect, it } from 'vitest';
import { Rng } from '@dbkl/shared';
import {
  BTreeEngine,
  DEFAULT_SCHEMA,
  HistoryManager,
  applyEvent,
  createInitialState,
  projectStructure,
  replay,
  type Command,
  type SimulationEvent,
} from '../src';
import { checkInvariants, config } from './helpers';

function mixedWorkload(seed: number, steps: number): Command[] {
  const rng = new Rng(seed);
  const cmds: Command[] = [{ kind: 'create_table', schema: DEFAULT_SCHEMA }];
  const live: number[] = [];
  for (let i = 0; i < steps; i++) {
    const roll = rng.next();
    if (roll < 0.55 || live.length < 4) {
      const key = rng.int(1, 400);
      cmds.push({ kind: 'insert', key });
      live.push(key);
    } else if (roll < 0.75) {
      const key = rng.pick(live);
      cmds.push({ kind: 'delete', key });
      live.splice(live.indexOf(key), 1);
    } else if (roll < 0.85) {
      cmds.push({ kind: 'search', key: rng.int(1, 400) });
    } else if (roll < 0.93) {
      const from = rng.int(1, 300);
      cmds.push({ kind: 'range_scan', from, to: from + rng.int(1, 60) });
    } else if (roll < 0.97) {
      cmds.push({ kind: 'bulk_insert', count: rng.int(3, 12), pattern: 'random', max: 400 });
    } else {
      cmds.push({ kind: 'flush_all' });
    }
  }
  return cmds;
}

function runAll(cmds: Command[], patch = {}) {
  const cfg = config(patch);
  const engine = new BTreeEngine(cfg);
  const events: SimulationEvent[] = [];
  for (const c of cmds) events.push(...engine.execute(c));
  return { engine, events, cfg };
}

describe('reducer 与引擎的一致性', () => {
  it('重放事件流得到的状态与引擎内部状态逐字段相等（混合负载）', () => {
    const { engine, events, cfg } = runAll(mixedWorkload(2026, 400));
    const state = replay(events, cfg);
    expect(projectStructure(state)).toEqual(engine.snapshot());
    checkInvariants(projectStructure(state), cfg);
  });

  it('不同阶数 / 淘汰策略下同样一致', () => {
    for (const patch of [
      { order: 3, bufferPoolFrames: 3 },
      { order: 6, bufferPoolFrames: 4, evictionPolicy: 'CLOCK' as const },
      { order: 12, bufferPoolFrames: 64, fillFactor: 0.75 },
    ]) {
      const { engine, events, cfg } = runAll(mixedWorkload(7, 220), patch);
      expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：任意前缀都是自洽的状态', () => {
    const { events, cfg } = runAll(mixedWorkload(11, 120));
    const state = createInitialState(cfg);
    for (const e of events) {
      applyEvent(state, e);
      expect(state.appliedSeq).toBe(e.seq);
    }
    // 事件下标就是 seq
    events.forEach((e, i) => expect(e.seq).toBe(i));
  });

  it('事件流是结构化克隆安全的纯数据', () => {
    const { events } = runAll(mixedWorkload(3, 60));
    expect(() => structuredClone(events)).not.toThrow();
    expect(JSON.parse(JSON.stringify(events)).length).toBe(events.length);
  });

  it('逻辑时钟单调递增', () => {
    const { events } = runAll(mixedWorkload(5, 80));
    for (let i = 1; i < events.length; i++) {
      expect(events[i].t).toBeGreaterThan(events[i - 1].t);
    }
  });
});

describe('HistoryManager 时间旅行', () => {
  it('stateAt(i) 与顺序重放到 i 的结果一致（含检查点抽稀）', () => {
    const { events, cfg } = runAll(mixedWorkload(101, 500));
    const history = new HistoryManager(cfg, 6, 50);
    history.push(events);
    expect(history.length).toBe(events.length);

    for (const i of [0, 1, 7, 50, 137, 400, Math.floor(events.length / 2), events.length]) {
      const target = Math.min(i, events.length);
      const expected = createInitialState(cfg);
      for (let k = 0; k < target; k++) applyEvent(expected, events[k]);
      expect(projectStructure(history.stateAt(target))).toEqual(projectStructure(expected));
    }
  });

  it('来回跳转不会污染状态', () => {
    const { events, cfg } = runAll(mixedWorkload(13, 200));
    const history = new HistoryManager(cfg, 8, 40);
    history.push(events);
    const a = projectStructure(history.stateAt(150));
    history.stateAt(3);
    history.stateAt(199);
    const b = projectStructure(history.stateAt(150));
    expect(b).toEqual(a);
  });

  it('head 状态等于全部事件应用后的状态', () => {
    const { engine, events, cfg } = runAll(mixedWorkload(17, 150));
    const history = new HistoryManager(cfg, 8, 40);
    history.push(events);
    expect(projectStructure(history.head)).toEqual(engine.snapshot());
  });

  it('命令区间索引覆盖整个事件流', () => {
    const cmds = mixedWorkload(19, 60);
    const { events, cfg } = runAll(cmds);
    const history = new HistoryManager(cfg);
    history.push(events);
    expect(history.commands).toHaveLength(cmds.length);
    for (const span of history.commands) {
      expect(events[span.startSeq].type).toBe('COMMAND_BEGIN');
      expect(events[span.endSeq].type).toBe('COMMAND_END');
      expect(span.endSeq).toBeGreaterThan(span.startSeq);
    }
    expect(history.commands[history.commands.length - 1].endSeq).toBe(events.length - 1);
  });

  it('按逻辑时间定位事件下标', () => {
    const { events, cfg } = runAll(mixedWorkload(23, 80));
    const history = new HistoryManager(cfg);
    history.push(events);
    const probe = events[42].t;
    expect(history.indexAtTime(probe)).toBe(42);
    expect(history.indexAtTime(0)).toBe(0);
    expect(history.indexAtTime(history.duration + 1)).toBe(events.length);
  });

  it('可以定位下一次页分裂', () => {
    const { events, cfg } = runAll(mixedWorkload(29, 100));
    const history = new HistoryManager(cfg);
    history.push(events);
    const next = history.nextMatching(0, (e) => e.type === 'PAGE_SPLIT');
    expect(next).not.toBeNull();
    expect(events[next!].type).toBe('PAGE_SPLIT');
    const prev = history.nextMatching(events.length - 1, (e) => e.type === 'PAGE_SPLIT', -1);
    expect(prev).not.toBeNull();
  });
});

describe('确定性重放（会话恢复）', () => {
  it('同一命令日志两次执行产生逐字节相同的事件流', () => {
    const cmds = mixedWorkload(31, 250);
    const a = runAll(cmds);
    const b = runAll(cmds);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});
