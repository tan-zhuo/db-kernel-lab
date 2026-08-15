import { describe, expect, it } from 'vitest';
import { Rng, type Key } from '@dbkl/shared';
import {
  DEFAULT_SCHEMA,
  FractalTreeEngine,
  applyEvent,
  createInitialState,
  projectStructure,
  replay,
  type Command,
  type EngineConfig,
  type SimulationEvent,
} from '../src';
import { config } from './helpers';

function run(cmds: Command[], patch: Partial<EngineConfig> = {}) {
  const cfg = config({ order: 4, fractalBufferCapacity: 8, ...patch });
  const engine = new FractalTreeEngine(cfg);
  const events: SimulationEvent[] = [];
  for (const c of cmds) events.push(...engine.execute(c));
  return { engine, events, cfg };
}

const create: Command = { kind: 'create_table', schema: DEFAULT_SCHEMA };

function eventsOf<T extends SimulationEvent['type']>(
  events: SimulationEvent[],
  type: T,
): Extract<SimulationEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<SimulationEvent, { type: T }>[];
}

function lastCommand(events: SimulationEvent[]): SimulationEvent[] {
  const cmd = events[events.length - 1].cmd;
  return events.filter((e) => e.cmd === cmd);
}

describe('写路径：只往根缓冲塞一条消息', () => {
  it('写入不下降到叶子 —— 一条 MSG_INJECT 就完事', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'insert', key: 500 },
    ]);
    const last = lastCommand(events);
    expect(eventsOf(last, 'MSG_INJECT')).toHaveLength(1);
    // 这次写入没有产生任何一次「下降到叶子」的记录级事件
    expect(eventsOf(last, 'RECORD_INSERT')).toHaveLength(0);
  });

  it('缓冲满了才把一整批推给同一个孩子', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 40, pattern: 'random', max: 200 }], {
      fractalBufferCapacity: 6,
    });
    const flushes = eventsOf(events, 'MSG_FLUSH');
    expect(flushes.length).toBeGreaterThan(0);
    // 每次刷写都是「一批」，不是一条一条挪
    const batchSizes = flushes.map((f) => f.keys.length);
    expect(Math.max(...batchSizes)).toBeGreaterThan(1);
    for (const f of flushes) expect(f.keys.length).toBe(f.ops.length);
  });

  it('缓冲容量调到 0 就退化成普通 B+ 树：写立刻到叶子', () => {
    const { engine, events } = run([create, { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 1 }], {
      fractalBufferCapacity: 0,
    });
    expect(eventsOf(events, 'MSG_INJECT')).toHaveLength(0);
    expect(eventsOf(events, 'MSG_FLUSH')).toHaveLength(0);
    expect(engine.pendingMessages()).toBe(0);
    // 数据全部落地
    expect(engine.leafKeys()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('缓冲越大，摊到每条写的重写次数越少 —— 这就是写优化的全部内容', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 120, pattern: 'random', max: 400 }];
    const small = run(cmds, { fractalBufferCapacity: 2 });
    const large = run(cmds, { fractalBufferCapacity: 32 });
    const amp = (e: FractalTreeEngine) => e.flushHops() / e.injectedMessages();
    expect(amp(large.engine)).toBeLessThan(amp(small.engine));
  });
});

describe('盲写：不读旧值就能改', () => {
  it('UPDATE 只投一条 upsert 消息，全程没读过那一行', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'update', key: 7, row: { score: 99 } },
    ]);
    const last = lastCommand(events);
    const inject = eventsOf(last, 'MSG_INJECT');
    expect(inject).toHaveLength(1);
    expect(inject[0].op).toBe('upsert');
    // 没有任何一次针对该键的查找
    expect(eventsOf(last, 'SEARCH_BEGIN')).toHaveLength(0);
  });

  it('upsert 落到叶子时与底稿合并，只覆盖它带的那几列', () => {
    const { engine } = run([
      create,
      { kind: 'insert', key: 5 },
      { kind: 'update', key: 5, row: { score: 42 } },
      { kind: 'flush_all' },
    ]);
    const row = engine.visibleRow(5)!;
    expect(row.score).toBe(42);
    // 其它列来自最初插入的那一行，没有被抹掉
    expect(row.id).toBe(5);
    expect(row.name).toBeDefined();
  });
});

describe('读路径：沿路把每层缓冲翻一遍', () => {
  it('每经过一个内部节点都要探一次缓冲', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 21 },
    ]);
    const probes = eventsOf(lastCommand(events), 'BUFFER_PROBE');
    // 树高 h 的树，读要翻 h-1 块缓冲（叶子没有缓冲）
    expect(probes.length).toBe(engine.treeHeight() - 1);
  });

  it('答案在缓冲里就当场返回，根本不用走到叶子', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 },
      { kind: 'insert', key: 900 },
      { kind: 'search', key: 900 },
    ]);
    const last = lastCommand(events);
    const decisive = eventsOf(last, 'BUFFER_PROBE').find((p) => p.decisive);
    expect(decisive, '应该在某层缓冲里直接命中').toBeDefined();
    const result = eventsOf(last, 'SEARCH_RESULT').at(-1)!;
    expect(result.found).toBe(true);
    expect(eventsOf(last, 'COMMAND_END').at(-1)!.note).toContain('没走到叶子');
  });

  it('删除消息还在缓冲里时，读就已经看不到那个键了', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'flush_all' },
      { kind: 'delete', key: 9 },
      { kind: 'search', key: 9 },
    ]);
    expect(eventsOf(lastCommand(events), 'SEARCH_RESULT').at(-1)!.found).toBe(false);
    // 叶子那边其实还留着 —— 删除只是一条消息
    expect(engine.leafKeys()).toContain(9);
    expect(engine.visibleKeys()).not.toContain(9);
  });
});

describe('范围扫描：攒下的账要当场结清', () => {
  it('扫描前会强制把缓冲推到叶子', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 40, pattern: 'random', max: 300 },
      { kind: 'full_scan' },
    ]);
    const last = lastCommand(events);
    expect(eventsOf(last, 'PATH_FLUSH').length).toBeGreaterThan(0);
    expect(eventsOf(last, 'COMMAND_END').at(-1)!.note).toContain('当场结清');
  });

  it('结清之后叶子就是最新的，扫描结果按键序完整', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 40, pattern: 'random', max: 300 },
      { kind: 'full_scan' },
    ]);
    const scanned = eventsOf(lastCommand(events), 'SCAN_STEP').map((e) => e.key);
    expect(scanned).toEqual([...scanned].sort((a, b) => a - b));
    expect(scanned).toEqual(engine.visibleKeys());
    expect(engine.pendingMessages()).toBe(0);
  });
});

describe('正确性：消息乱序下沉之后语义仍然正确', () => {
  it('随机插入 / 盲写 / 删除之后，可见数据与参考实现一致', () => {
    const rng = new Rng(9090);
    const cmds: Command[] = [create];
    const reference = new Map<Key, number>();
    for (let i = 0; i < 400; i++) {
      const roll = rng.next();
      const key = rng.int(1, 40);
      if (roll < 0.55) {
        cmds.push({ kind: 'insert', key, row: { id: key, name: `n${i}`, city: 'Xian', score: i % 100 } });
        reference.set(key, i % 100);
      } else if (roll < 0.8) {
        cmds.push({ kind: 'update', key, row: { score: i % 100 } });
        // 盲写落到不存在的键上也算插入（与引擎语义一致）
        reference.set(key, i % 100);
      } else {
        cmds.push({ kind: 'delete', key });
        reference.delete(key);
      }
    }
    const { engine } = run(cmds, { fractalBufferCapacity: 6 });
    expect(engine.visibleKeys()).toEqual([...reference.keys()].sort((a, b) => a - b));
    for (const [key, score] of reference) {
      expect(engine.visibleRow(key)?.score, `key=${key}`).toBe(score);
    }
  });

  it('全部结清之后，叶子里的内容与逻辑可见内容完全一致', () => {
    const rng = new Rng(31337);
    const cmds: Command[] = [create];
    for (let i = 0; i < 300; i++) {
      const key = rng.int(1, 60);
      cmds.push(rng.next() < 0.75 ? { kind: 'insert', key } : { kind: 'delete', key });
    }
    cmds.push({ kind: 'flush_all' });
    const { engine } = run(cmds, { fractalBufferCapacity: 5 });
    expect(engine.pendingMessages()).toBe(0);
    expect(engine.leafKeys()).toEqual(engine.visibleKeys());
  });
});

describe('reducer 与引擎一致性（Bε-树）', () => {
  function workload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      const key = rng.int(1, 50);
      if (roll < 0.5) cmds.push({ kind: 'insert', key });
      else if (roll < 0.68) cmds.push({ kind: 'update', key, row: { score: i % 100 } });
      else if (roll < 0.8) cmds.push({ kind: 'delete', key });
      else if (roll < 0.93) cmds.push({ kind: 'search', key });
      else cmds.push({ kind: 'range_scan', from: key, to: key + 10 });
    }
    return cmds;
  }

  it('重放事件流得到的结构与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(workload(2026, 260));
    expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
  });

  it('不同阶数 / 缓冲容量下同样一致', () => {
    for (const patch of [
      { order: 3, fractalBufferCapacity: 2 },
      { order: 6, fractalBufferCapacity: 16 },
      { order: 4, fractalBufferCapacity: 0 },
      { order: 8, fractalBufferCapacity: 32 },
    ]) {
      const { engine, events, cfg } = run(workload(77, 200), patch);
      expect(projectStructure(replay(events, cfg)), JSON.stringify(patch)).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：seq 就是下标，逻辑时钟严格递增', () => {
    const { events, cfg } = run(workload(13, 150));
    const state = createInitialState(cfg);
    events.forEach((e, i) => {
      applyEvent(state, e);
      expect(e.seq).toBe(i);
      if (i > 0) expect(e.t).toBeGreaterThan(events[i - 1].t);
    });
  });

  it('同一命令日志两次执行产生逐字节相同的事件流', () => {
    const cmds = workload(41, 200);
    expect(JSON.stringify(run(cmds).events)).toBe(JSON.stringify(run(cmds).events));
  });
});

describe('它落在 B+ 树与 LSM 之间', () => {
  it('缓冲容量就是那个旋钮：从 0 到大，写放大单调下降', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 150, pattern: 'random', max: 500 }];
    const amps = [0, 4, 16, 64].map((capacity) => {
      const { engine } = run(cmds, { fractalBufferCapacity: capacity });
      // 容量为 0 时消息直接下降，重写次数按树高算
      const hops = capacity === 0 ? engine.injectedMessages() * engine.treeHeight() : engine.flushHops();
      return hops / engine.injectedMessages();
    });
    for (let i = 1; i < amps.length; i++) {
      expect(amps[i], `capacity 档位 ${i}`).toBeLessThanOrEqual(amps[i - 1]);
    }
  });
});
