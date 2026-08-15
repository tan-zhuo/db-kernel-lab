import { describe, expect, it } from 'vitest';
import { Rng, type Key } from '@dbkl/shared';
import {
  DEFAULT_SCHEMA,
  KvHashEngine,
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
  const cfg = config({ kvLogFileRecords: 4, kvHashBuckets: 8, kvMergeThreshold: 0.4, ...patch });
  const engine = new KvHashEngine(cfg);
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

describe('写路径：追加 + 改内存索引', () => {
  it('每次写入都是「追加一条 + 索引指向新位置」', () => {
    const { events } = run([create, { kind: 'insert', key: 1 }]);
    const appendAt = events.findIndex((e) => e.type === 'LOG_APPEND');
    const indexAt = events.findIndex((e) => e.type === 'HASH_INDEX_SET');
    expect(appendAt).toBeGreaterThanOrEqual(0);
    expect(appendAt, '先落盘再改索引').toBeLessThan(indexAt);
  });

  it('更新同一个键 = 再追加一条，旧记录原地变垃圾', () => {
    const { engine, events } = run([
      create,
      { kind: 'insert', key: 1 },
      { kind: 'update', key: 1, row: { id: 1, name: 'v2', city: 'Xian', score: 9 } },
    ]);
    expect(eventsOf(events, 'LOG_APPEND')).toHaveLength(2);
    // 索引只有一个键，指向最新那条
    expect(engine.liveKeys()).toEqual([1]);
    expect(engine.peek(1)).toMatchObject({ name: 'v2' });
    // 旧记录成了垃圾
    expect(engine.garbageRatio()).toBeGreaterThan(0);
    expect(eventsOf(events, 'HASH_INDEX_SET').at(-1)!.overwrite).toBe(true);
  });

  it('活动文件写满就封口，之后只读不写', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 9, pattern: 'sequential', start: 1 }]);
    const seals = eventsOf(events, 'LOG_FILE_SEAL');
    expect(seals.length).toBeGreaterThanOrEqual(2); // 每 4 条封一个
    for (const s of seals) expect(s.records).toBeGreaterThan(0);
  });

  it('删除写墓碑并把索引项摘掉', () => {
    const { engine, events } = run([create, { kind: 'insert', key: 5 }, { kind: 'delete', key: 5 }]);
    const append = eventsOf(events, 'LOG_APPEND').at(-1)!;
    expect(append.tombstone).toBe(true);
    expect(eventsOf(events, 'HASH_INDEX_SET').at(-1)!.removed).toBe(true);
    expect(engine.liveKeys()).toEqual([]);
  });

  it('内存索引大小随键数线性增长 —— 这是哈希 KV 的硬上限', () => {
    const small = run([create, { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }]);
    const big = run([create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }]);
    expect(big.engine.indexMemoryBytes()).toBeCloseTo(small.engine.indexMemoryBytes() * 4, 5);
    // 反复更新同一批键不会撑大索引（键数没变），只会撑大磁盘
    const updated = run([
      create,
      { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 30 }, (_, i) => ({ kind: 'insert', key: (i % 10) + 1 }) as Command),
    ]);
    expect(updated.engine.indexMemoryBytes()).toBe(small.engine.indexMemoryBytes());
  });
});

describe('读路径：哈希一次 + 一次磁盘读', () => {
  it('点查的探测步数与数据量无关', () => {
    const small = run([create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }, { kind: 'search', key: 3 }]);
    const big = run([create, { kind: 'bulk_insert', count: 200, pattern: 'sequential', start: 1 }, { kind: 'search', key: 3 }], {
      kvHashBuckets: 64,
    });
    const a = eventsOf(small.events, 'HASH_PROBE').at(-1)!;
    const b = eventsOf(big.events, 'HASH_PROBE').at(-1)!;
    expect(a.found).toBe(true);
    expect(b.found).toBe(true);
    // 数据量翻 25 倍，链上仍然只走个位数步
    expect(b.chainSteps).toBeLessThanOrEqual(8);
  });

  it('键不存在时连磁盘都不用碰', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }, { kind: 'search', key: 999 }]);
    const probe = eventsOf(events, 'HASH_PROBE').at(-1)!;
    expect(probe.found).toBe(false);
    expect(probe.fileId).toBeNull();
  });

  it('桶越少冲突链越长 —— 哈希表的经典权衡', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }];
    const few = run(cmds, { kvHashBuckets: 4 });
    const many = run(cmds, { kvHashBuckets: 64 });
    expect(few.engine.longestChain()).toBeGreaterThan(many.engine.longestChain());
  });

  it('范围扫描直接拒绝，并说清为什么', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }, { kind: 'range_scan', from: 1, to: 5 }]);
    const note = eventsOf(events, 'NOTE').at(-1)!;
    expect(note.level).toBe('error');
    expect(note.message).toContain('哈希把键打散了');
    expect(eventsOf(events, 'COMMAND_END').at(-1)!.ok).toBe(false);
  });
});

describe('合并：回收被覆盖的旧记录', () => {
  it('失效占比超过阈值就自动合并，数据一条不少', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    // 反复覆盖同一批键，制造大量垃圾
    for (let round = 0; round < 4; round++) {
      for (let k = 1; k <= 8; k++) cmds.push({ kind: 'insert', key: k });
    }
    const { engine, events } = run(cmds);
    expect(eventsOf(events, 'MERGE_END').length).toBeGreaterThan(0);
    expect(engine.liveKeys()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const end = eventsOf(events, 'MERGE_END').at(-1)!;
    expect(end.deadRecords).toBeGreaterThan(0);
    expect(end.reclaimedBytes).toBeGreaterThan(0);
  });

  it('合并之后索引重新指向新文件，点查照样命中', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    for (let round = 0; round < 4; round++) {
      for (let k = 1; k <= 8; k++) cmds.push({ kind: 'insert', key: k });
    }
    cmds.push({ kind: 'search', key: 5 });
    const { engine, events } = run(cmds);
    expect(eventsOf(events, 'HASH_PROBE').at(-1)!.found).toBe(true);
    expect(engine.peek(5)).toMatchObject({ id: 5 });
    // 合并把垃圾清掉了
    expect(engine.garbageRatio()).toBeLessThan(0.5);
  });

  it('关掉自动合并（阈值调到 1）垃圾就一直堆着', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    for (let round = 0; round < 4; round++) {
      for (let k = 1; k <= 8; k++) cmds.push({ kind: 'insert', key: k });
    }
    const lazy = run(cmds, { kvMergeThreshold: 1.1 });
    expect(eventsOf(lazy.events, 'MERGE_END')).toHaveLength(0);
    expect(lazy.engine.garbageRatio()).toBeGreaterThan(0.5);
    // 数据依然正确 —— 合并只影响空间，不影响正确性
    expect(lazy.engine.liveKeys()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('正确性：与一份参考实现逐键比对', () => {
  it('随机读写删之后，可见数据与普通 Map 完全一致', () => {
    const rng = new Rng(777);
    const cmds: Command[] = [create];
    const reference = new Map<Key, number>();
    for (let i = 0; i < 400; i++) {
      const roll = rng.next();
      const key = rng.int(1, 50);
      if (roll < 0.7) {
        cmds.push({ kind: 'update', key, row: { id: key, name: `n${i}`, city: 'Xian', score: i % 100 } });
        reference.set(key, i % 100);
      } else if (roll < 0.9) {
        cmds.push({ kind: 'delete', key });
        reference.delete(key);
      } else {
        cmds.push({ kind: 'search', key });
      }
    }
    const { engine } = run(cmds, { kvLogFileRecords: 6, kvHashBuckets: 16 });
    expect(engine.liveKeys()).toEqual([...reference.keys()].sort((a, b) => a - b));
    for (const [key, score] of reference) {
      expect(engine.peek(key), `key=${key}`).toMatchObject({ score });
    }
  });
});

describe('reducer 与引擎一致性（哈希 KV）', () => {
  function workload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      const key = rng.int(1, 60);
      if (roll < 0.6) cmds.push({ kind: 'insert', key });
      else if (roll < 0.75) cmds.push({ kind: 'delete', key });
      else if (roll < 0.9) cmds.push({ kind: 'search', key });
      else cmds.push({ kind: 'compact' });
    }
    return cmds;
  }

  it('重放事件流得到的结构与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(workload(2026, 300));
    expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
  });

  it('不同桶数 / 文件大小 / 合并阈值下同样一致', () => {
    for (const patch of [
      { kvHashBuckets: 2, kvLogFileRecords: 2 },
      { kvHashBuckets: 64, kvLogFileRecords: 16, kvMergeThreshold: 0.8 },
      { kvHashBuckets: 8, kvMergeThreshold: 1.1 },
    ]) {
      const { engine, events, cfg } = run(workload(19, 200), patch);
      expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：seq 就是下标，逻辑时钟严格递增', () => {
    const { events, cfg } = run(workload(7, 150));
    const state = createInitialState(cfg);
    events.forEach((e, i) => {
      applyEvent(state, e);
      expect(e.seq).toBe(i);
      if (i > 0) expect(e.t).toBeGreaterThan(events[i - 1].t);
    });
  });

  it('同一命令日志两次执行产生逐字节相同的事件流', () => {
    const cmds = workload(31, 200);
    expect(JSON.stringify(run(cmds).events)).toBe(JSON.stringify(run(cmds).events));
  });
});
