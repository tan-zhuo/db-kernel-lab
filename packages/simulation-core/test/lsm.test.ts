import { describe, expect, it } from 'vitest';
import { Rng, type Key } from '@dbkl/shared';
import {
  DEFAULT_SCHEMA,
  LsmEngine,
  applyEvent,
  createInitialState,
  lsmLiveKeys,
  lsmLevelStats,
  projectStructure,
  replay,
  spaceAmplification,
  writeAmplification,
  type Command,
  type EngineConfig,
  type SimulationEvent,
} from '../src';
import { config } from './helpers';

function run(cmds: Command[], patch: Partial<EngineConfig> = {}) {
  const cfg = config({ memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 10, ...patch });
  const engine = new LsmEngine(cfg);
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

describe('LSM 写路径：只追加，从不原地修改', () => {
  it('写入先进 MemTable，满了才冻结并刷成 L0 的 SST', () => {
    const { events, cfg } = run([create, { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 }]);
    expect(eventsOf(events, 'MEMTABLE_PUT')).toHaveLength(4);
    expect(eventsOf(events, 'MEMTABLE_FREEZE')).toHaveLength(1);
    const created = eventsOf(events, 'SST_CREATE');
    expect(created).toHaveLength(1);
    expect(created[0].level).toBe(0);
    expect(created[0].source).toBe('flush');
    expect(created[0].entries.map((e) => e.key)).toEqual([1, 2, 3, 4]);

    const state = replay(events, cfg);
    expect(state.lsm!.memtable.entries).toHaveLength(0);
    expect(state.lsm!.levels[0]).toHaveLength(1);
  });

  it('每次写入都先落 WAL', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 6, pattern: 'sequential', start: 1 }, { kind: 'delete', key: 3 }]);
    const wal = eventsOf(events, 'WAL_APPEND');
    expect(wal).toHaveLength(7);
    expect(wal.at(-1)!.op).toBe('delete');
    // lsn 单调递增
    expect(wal.map((e) => e.lsn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('更新同一个键 = 再写一条新版本，旧版本仍留在下层文件里', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 }, // 刷成 L0
      { kind: 'update', key: 2, row: { id: 2, name: 'v2', city: 'Xian', score: 1 } },
    ]);
    expect(engine.peek(2)).toMatchObject({ name: 'v2' });
    // MemTable 里有新版本，L0 文件里还有旧版本 —— 两份同时存在
    const snap = engine.snapshot().lsm!;
    expect(snap.memtable.map((e) => e.key)).toContain(2);
    expect(snap.levels[0][0].keys).toContain(2);
    expect(eventsOf(events, 'MEMTABLE_PUT').at(-1)!.overwrite).toBe(false);
  });

  it('删除写的是墓碑，不是移除', () => {
    const { engine, events } = run([create, { kind: 'insert', key: 5 }, { kind: 'delete', key: 5 }]);
    const put = eventsOf(events, 'MEMTABLE_PUT').at(-1)!;
    expect(put.tombstone).toBe(true);
    expect(put.overwrite).toBe(true);
    expect(engine.liveKeys()).toEqual([]);
  });
});

describe('LSM 读路径：自上而下 + 布隆过滤器', () => {
  it('点查从最新到最旧逐层探测，命中即停', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 3 },
    ]);
    const get = eventsOf(events, 'LSM_GET_RESULT').at(-1)!;
    expect(get.found).toBe(true);
    expect(get.source).toBe('sst');
  });

  it('布隆过滤器能挡掉整个文件；关掉它读放大立刻变高', () => {
    // 只写偶数键，再去查一个**落在键区间之内**的奇数键：
    // 这样区间剪枝没用（文件区间覆盖了它），能不能跳过完全取决于布隆过滤器。
    const cmds: Command[] = [create];
    for (let i = 1; i <= 24; i++) cmds.push({ kind: 'insert', key: i * 2 });
    // 5 是奇数（一定不存在），但它落在某个 SST 的键区间**内部**，区间剪枝挡不住
    cmds.push({ kind: 'search', key: 5 });

    const withBloom = run(cmds, { bloomBitsPerKey: 16 });
    const withoutBloom = run(cmds, { bloomBitsPerKey: 0 });

    const a = eventsOf(withBloom.events, 'LSM_GET_RESULT').at(-1)!;
    const b = eventsOf(withoutBloom.events, 'LSM_GET_RESULT').at(-1)!;
    expect(a.found).toBe(false);
    expect(b.found).toBe(false);
    expect(b.probes).toBeGreaterThan(0);
    expect(a.bloomSkips).toBeGreaterThan(0);
    expect(a.probes).toBeLessThan(b.probes);
  });

  it('查到墓碑就返回「不存在」，不再往下层看', () => {
    const { events, engine } = run([
      create,
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'delete', key: 4 },
      { kind: 'search', key: 4 },
    ]);
    const get = eventsOf(events, 'LSM_GET_RESULT').at(-1)!;
    expect(get.found).toBe(false);
    expect(engine.peek(4)).toBeUndefined();
  });

  it('区间扫描用不上布隆过滤器：每个重叠文件都要读', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 16, pattern: 'sequential', start: 1 },
      { kind: 'range_scan', from: 3, to: 9 },
    ]);
    const scanEvents = events.filter((e) => e.cmd === 3);
    expect(eventsOf(scanEvents, 'BLOOM_PROBE')).toHaveLength(0);
    expect(eventsOf(scanEvents, 'SCAN_END').at(-1)!.rows).toBe(7);
  });
});

describe('压实（compaction）', () => {
  it('L0 文件数达到触发值就合并到 L1（同步模式：写路径上当场做完）', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }], {
      backgroundCompaction: false,
    });
    const begins = eventsOf(events, 'COMPACTION_BEGIN');
    expect(begins.length).toBeGreaterThan(0);
    expect(begins[0].level).toBe(0);
    expect(begins[0].targetLevel).toBe(1);
    expect(begins[0].reason).toContain('L0 文件数');
  });

  it('压实丢掉重复版本：合并后同一个键只剩最新的一份', () => {
    const cmds: Command[] = [create];
    // 反复更新同一批键，制造大量旧版本
    for (let round = 0; round < 4; round++) {
      for (let k = 1; k <= 4; k++) {
        cmds.push({ kind: 'update', key: k, row: { id: k, name: `r${round}`, city: 'Xian', score: round } });
      }
    }
    cmds.push({ kind: 'flush_memtable' });
    const { engine, events, cfg } = run(cmds);
    const state = replay(events, cfg);

    expect(engine.liveKeys()).toEqual([1, 2, 3, 4]);
    // 每个键的最新版本是最后一轮写的
    for (let k = 1; k <= 4; k++) expect(engine.peek(k)).toMatchObject({ name: 'r3' });

    const ends = eventsOf(events, 'COMPACTION_END');
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.some((e) => e.dropped > 0)).toBe(true);
    expect(state.lsm!.droppedEntries).toBeGreaterThan(0);
  });

  it('墓碑只有压到最底层才会被真正丢弃', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    for (let k = 1; k <= 4; k++) cmds.push({ kind: 'delete', key: k });
    cmds.push({ kind: 'flush_memtable' }, { kind: 'compact' }, { kind: 'compact' }, { kind: 'compact' });
    const { engine } = run(cmds);
    expect(engine.liveKeys()).toEqual([5, 6, 7, 8]);
  });

  it('leveled 保证层内不重叠 ⇒ 点查读放大更低；两种策略的数据必须完全一致', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }];
    // 关掉布隆过滤器，才能看到「结构本身」带来的读放大差别
    const leveled = run([...cmds, { kind: 'search', key: 21 }], { compactionStyle: 'leveled', bloomBitsPerKey: 0 });
    const tiered = run([...cmds, { kind: 'search', key: 21 }], { compactionStyle: 'tiered', bloomBitsPerKey: 0 });
    const a = replay(leveled.events, leveled.cfg).lsm!;
    const b = replay(tiered.events, tiered.cfg).lsm!;

    // 两种策略都会产生写放大（同一条数据被重写多次）
    expect(writeAmplification(a)).toBeGreaterThan(1);
    expect(writeAmplification(b)).toBeGreaterThan(1);

    // leveled：每层至多一个候选文件；tiered：同层文件区间可以重叠
    const overlapping = (l: typeof a) =>
      l.levels.slice(1).some((ids) => {
        const ssts = ids.map((id) => l.ssts[id]);
        return ssts.some((s, i) => i > 0 && s.minKey <= ssts[i - 1].maxKey);
      });
    expect(overlapping(a)).toBe(false);

    const probesA = eventsOf(leveled.events, 'LSM_GET_RESULT').at(-1)!.probes;
    const probesB = eventsOf(tiered.events, 'LSM_GET_RESULT').at(-1)!.probes;
    expect(probesA).toBeLessThanOrEqual(probesB);

    // 无论怎么压实，逻辑数据都必须一模一样
    expect(lsmLiveKeys(a)).toEqual(lsmLiveKeys(b));
    expect(leveled.engine.liveKeys()).toEqual(tiered.engine.liveKeys());
  });

  it('压实会降低空间放大', () => {
    const cmds: Command[] = [create];
    for (let round = 0; round < 5; round++) {
      for (let k = 1; k <= 6; k++) cmds.push({ kind: 'insert', key: k });
    }
    const before = run([...cmds, { kind: 'flush_memtable' }], { l0CompactionTrigger: 99 });
    const after = run([...cmds, { kind: 'flush_memtable' }, { kind: 'compact', level: 0 }], {
      l0CompactionTrigger: 99,
    });
    const sa = spaceAmplification(replay(before.events, before.cfg).lsm!);
    const sb = spaceAmplification(replay(after.events, after.cfg).lsm!);
    expect(sa).toBeGreaterThan(1);
    expect(sb).toBeLessThan(sa);
  });

  it('每层的层级结构可读：L0 之外的层内文件区间不重叠', () => {
    const { events, cfg } = run([create, { kind: 'bulk_insert', count: 60, pattern: 'sequential', start: 1 }]);
    const l = replay(events, cfg).lsm!;
    const stats = lsmLevelStats(l);
    expect(stats.length).toBeGreaterThan(1);
    for (let level = 1; level < l.levels.length; level++) {
      const ssts = l.levels[level].map((id) => l.ssts[id]);
      for (let i = 1; i < ssts.length; i++) {
        expect(ssts[i].minKey).toBeGreaterThan(ssts[i - 1].maxKey);
      }
    }
  });
});

describe('正确性：与一份「参考实现」逐键比对', () => {
  it('随机读写删之后，LSM 的可见数据与普通 Map 完全一致', () => {
    const rng = new Rng(4242);
    const cmds: Command[] = [create];
    const reference = new Map<Key, number>();
    for (let i = 0; i < 400; i++) {
      const roll = rng.next();
      const key = rng.int(1, 60);
      if (roll < 0.65) {
        cmds.push({ kind: 'update', key, row: { id: key, name: `n${i}`, city: 'Xian', score: i % 100 } });
        reference.set(key, i % 100);
      } else if (roll < 0.85) {
        cmds.push({ kind: 'delete', key });
        reference.delete(key);
      } else {
        cmds.push({ kind: 'search', key });
      }
    }
    const { engine } = run(cmds, { memtableLimit: 6, l0CompactionTrigger: 4 });
    expect(engine.liveKeys()).toEqual([...reference.keys()].sort((a, b) => a - b));
    for (const [key, score] of reference) {
      expect(engine.peek(key), `key=${key}`).toMatchObject({ score });
    }
  });
});

describe('reducer 与引擎一致性（LSM 引擎）', () => {
  function workload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      const key = rng.int(1, 80);
      if (roll < 0.55) cmds.push({ kind: 'insert', key });
      else if (roll < 0.7) cmds.push({ kind: 'delete', key });
      else if (roll < 0.8) cmds.push({ kind: 'search', key });
      else if (roll < 0.88) cmds.push({ kind: 'range_scan', from: key, to: key + 20 });
      else if (roll < 0.94) cmds.push({ kind: 'flush_memtable' });
      else cmds.push({ kind: 'compact' });
    }
    return cmds;
  }

  it('重放事件流得到的 LSM 结构与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(workload(2026, 300));
    expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
  });

  it('不同参数下同样一致', () => {
    for (const patch of [
      { memtableLimit: 2, l0CompactionTrigger: 2, levelFanout: 2 },
      { memtableLimit: 10, l0CompactionTrigger: 6, levelFanout: 5, bloomBitsPerKey: 4 },
      { memtableLimit: 5, compactionStyle: 'tiered' as const },
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

describe('后台任务：刷写与压实不在写路径上', () => {
  it('写路径只排队不干活：冻结产生的是任务，不是当场刷盘', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }], {
      memtableLimit: 4,
      maxBackgroundJobs: 0, // 后台完全不给 CPU，好看清「只排队」这件事
      maxImmutableMemtables: 99,
      l0StopTrigger: 99,
    });
    const freezes = eventsOf(events, 'MEMTABLE_FREEZE');
    const scheduled = eventsOf(events, 'BG_JOB_SCHEDULED');
    expect(freezes).toHaveLength(2);
    // 每次冻结排一个刷写任务，但一个都没执行 ⇒ 一个 SST 都还没生成
    expect(scheduled.filter((e) => e.kind === 'flush')).toHaveLength(2);
    expect(eventsOf(events, 'SST_CREATE')).toHaveLength(0);
    expect(eventsOf(events, 'BG_JOB_RUN')).toHaveLength(0);
  });

  it('积压的任务在命令间隙被后台推进', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    const stalled = run(cmds, { memtableLimit: 4, maxBackgroundJobs: 0, maxImmutableMemtables: 99, l0StopTrigger: 99 });
    expect(stalled.engine.backlog()).toBe(2);

    const drained = run([...cmds, { kind: 'run_background' }], {
      memtableLimit: 4,
      maxBackgroundJobs: 0,
      maxImmutableMemtables: 99,
      l0StopTrigger: 99,
    });
    expect(drained.engine.backlog()).toBe(0);
    expect(eventsOf(drained.events, 'SST_CREATE').length).toBeGreaterThan(0);
    // 数据在积压期间依然读得到（冻结队列也在读路径上）
    expect(stalled.engine.liveKeys()).toEqual(drained.engine.liveKeys());
  });

  it('积压在队列里的数据对可视化层同样可见（不能凭空消失）', () => {
    const { events, engine, cfg } = run([create, { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }], {
      memtableLimit: 4,
      maxBackgroundJobs: 0,
      maxImmutableMemtables: 99,
      l0StopTrigger: 99,
    });
    const l = replay(events, cfg).lsm!;
    // 8 条卡在两个冻结表里、2 条还在 MemTable，一个 SST 都没有 ——
    // 但从事件流归约出来的「逻辑键数」必须仍然是 10。
    expect(Object.keys(l.ssts)).toHaveLength(0);
    expect(l.immutable).toHaveLength(2);
    expect(lsmLiveKeys(l)).toHaveLength(10);
    expect(lsmLiveKeys(l)).toEqual(engine.liveKeys());
  });

  it('写入跑赢后台 ⇒ 冻结队列满 ⇒ 写停顿', () => {
    const { events, engine } = run([create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }], {
      memtableLimit: 2,
      maxBackgroundJobs: 0, // 后台一点都推不动，写入只能自己还债
      maxImmutableMemtables: 2,
      l0StopTrigger: 99,
    });
    const stalls = eventsOf(events, 'WRITE_STALL');
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls[0].reason).toBe('immutable-full');
    // 停顿时是写路径被迫同步跑了后台任务
    expect(eventsOf(events, 'BG_JOB_RUN').some((e) => e.forced)).toBe(true);
    // 停顿只是变慢，数据一条不能少
    expect(engine.liveKeys()).toHaveLength(40);
  });

  it('L0 堆到停写阈值也会触发写停顿', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 60, pattern: 'sequential', start: 1 }], {
      memtableLimit: 2,
      maxBackgroundJobs: 0,
      maxImmutableMemtables: 1, // 逼着写路径不停刷盘，L0 才会涨起来
      l0CompactionTrigger: 99, // 软触发值故意配得很高：不主动压实，让 L0 一路堆高
      l0StopTrigger: 4,
    });
    const stalls = eventsOf(events, 'WRITE_STALL');
    expect(stalls.some((e) => e.reason === 'l0-stop')).toBe(true);
    // 撞上停写阈值就必须压实，哪怕软触发值配得再高
    expect(eventsOf(events, 'COMPACTION_BEGIN').length).toBeGreaterThan(0);
  });

  it('同步模式没有任何积压与停顿（作为对照组）', () => {
    const { events, engine } = run([create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }], {
      backgroundCompaction: false,
    });
    expect(eventsOf(events, 'BG_JOB_SCHEDULED')).toHaveLength(0);
    expect(eventsOf(events, 'WRITE_STALL')).toHaveLength(0);
    expect(engine.backlog()).toBe(0);
  });

  it('无论同步还是后台，最终数据必须完全一致', () => {
    const cmds: Command[] = [create];
    const rng = new Rng(99);
    for (let i = 0; i < 120; i++) {
      const key = rng.int(1, 40);
      cmds.push(rng.next() < 0.8 ? { kind: 'insert', key } : { kind: 'delete', key });
    }
    // 把积压清干净再比，否则比的是「进度」而不是「数据」
    const withBg = run([...cmds, { kind: 'run_background' }], { backgroundCompaction: true });
    const sync = run(cmds, { backgroundCompaction: false });
    expect(withBg.engine.liveKeys()).toEqual(sync.engine.liveKeys());
  });
});

describe('WAL：先写日志，落盘后回收，崩溃靠它还原', () => {
  it('每条写入都先落 WAL，再改 MemTable', () => {
    const { events } = run([create, { kind: 'insert', key: 1 }]);
    const walAt = events.findIndex((e) => e.type === 'WAL_APPEND');
    const memAt = events.findIndex((e) => e.type === 'MEMTABLE_PUT');
    expect(walAt).toBeGreaterThanOrEqual(0);
    expect(walAt).toBeLessThan(memAt);
  });

  it('WAL 段随 MemTable 冻结而封口，随数据落成 SST 而回收', () => {
    const { events, cfg } = run([create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }], {
      memtableLimit: 4,
      maxBackgroundJobs: 4,
    });
    const seals = eventsOf(events, 'WAL_SEAL');
    const truncates = eventsOf(events, 'WAL_TRUNCATE');
    expect(seals).toHaveLength(2);
    expect(truncates).toHaveLength(2);
    // 被回收的段正是被封口的那两个
    expect(truncates.map((t) => t.segmentId).sort()).toEqual(seals.map((s) => s.segmentId).sort());
    expect(truncates.every((t) => t.reason === 'flushed')).toBe(true);

    // 数据全落盘之后，WAL 只剩一个空的当前段 —— 它不会无限增长
    const l = replay(events, cfg).lsm!;
    expect(l.wal.segments.filter((s) => s.records.length > 0)).toHaveLength(0);
  });

  it('还没落盘的部分一定还在 WAL 里（这就是它存在的意义）', () => {
    const { engine } = run([create, { kind: 'bulk_insert', count: 6, pattern: 'sequential', start: 1 }], {
      memtableLimit: 4,
      maxBackgroundJobs: 0, // 一条都没刷下去
    });
    // 6 条写入全部还只在内存 + WAL 里
    expect(engine.walRecordCount()).toBe(6);
  });

  it('崩溃后内存全丢，重放 WAL 能一条不少地还原', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }];
    const before = run(cmds, { memtableLimit: 4, maxBackgroundJobs: 0 });
    const keysBefore = before.engine.liveKeys();

    const after = run([...cmds, { kind: 'crash' }], { memtableLimit: 4, maxBackgroundJobs: 0 });
    const crash = eventsOf(after.events, 'CRASH')[0];
    expect(crash.lostMemtableEntries + crash.lostImmutableTables).toBeGreaterThan(0);
    expect(crash.retainedWalRecords).toBe(10);

    // 关键断言：崩溃前后逻辑数据完全一致
    expect(after.engine.liveKeys()).toEqual(keysBefore);
    const recover = eventsOf(after.events, 'RECOVER_END')[0];
    expect(recover.replayedRecords).toBe(10);
    expect(recover.restoredKeys).toBe(10);
    expect(recover.flushedToSst).not.toBeNull();
  });

  it('删除也能被 WAL 还原：崩溃后墓碑依然生效', () => {
    const cmds: Command[] = [
      create,
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'delete', key: 3 },
      { kind: 'delete', key: 5 },
    ];
    const after = run([...cmds, { kind: 'crash' }], { memtableLimit: 4, maxBackgroundJobs: 0 });
    expect(after.engine.liveKeys()).toEqual([1, 2, 4, 6, 7, 8]);
    expect(after.engine.peek(3)).toBeUndefined();
  });

  it('已经落成 SST 的数据不依赖 WAL：崩溃时它本来就在磁盘上', () => {
    const cmds: Command[] = [
      create,
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'flush_memtable' }, // 全部落盘，WAL 被回收干净
    ];
    const { engine, events } = run([...cmds, { kind: 'crash' }], { memtableLimit: 4 });
    const crash = eventsOf(events, 'CRASH')[0];
    expect(crash.retainedWalRecords).toBe(0);
    expect(crash.survivingSsts).toBeGreaterThan(0);
    // 没有任何日志要重放，数据照样在
    expect(eventsOf(events, 'WAL_REPLAY')).toHaveLength(0);
    expect(engine.liveKeys()).toHaveLength(8);
  });

  it('恢复之后旧日志被丢弃，新的写入进新段', () => {
    const { events, cfg } = run(
      [create, { kind: 'bulk_insert', count: 6, pattern: 'sequential', start: 1 }, { kind: 'crash' }, { kind: 'insert', key: 99 }],
      { memtableLimit: 4, maxBackgroundJobs: 0 },
    );
    expect(eventsOf(events, 'WAL_TRUNCATE').some((e) => e.reason === 'recovered')).toBe(true);
    const l = replay(events, cfg).lsm!;
    // 恢复后只剩一个新段，里面是崩溃之后写的那条
    expect(l.wal.segments).toHaveLength(1);
    expect(l.wal.segments[0].records.map((r) => r.key)).toEqual([99]);
  });
});
