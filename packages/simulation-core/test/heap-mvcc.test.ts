import { describe, expect, it } from 'vitest';
import { Rng, type Key } from '@dbkl/shared';
import {
  DEFAULT_SCHEMA,
  PRIMARY_INDEX_ID,
  PostgresHeapEngine,
  applyEvent,
  bloatRatio,
  createInitialState,
  heapPages,
  projectStructure,
  replay,
  type Command,
  type EngineConfig,
  type SimulationEvent,
} from '../src';
import { checkInvariants, config } from './helpers';

function run(cmds: Command[], patch: Partial<EngineConfig> = {}) {
  const cfg = config({ heapTuplesPerPage: 4, ...patch });
  const engine = new PostgresHeapEngine(cfg);
  const events: SimulationEvent[] = [];
  for (const c of cmds) events.push(...engine.execute(c));
  return { engine, events, cfg };
}

const create: Command = { kind: 'create_table', schema: DEFAULT_SCHEMA };

/** 最后一次 SCAN_END 报告的行数 —— 用来断言「这条语句看到了几行」。 */
function lastScanRows(events: SimulationEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'SCAN_END') return e.rows;
  }
  return -1;
}

function eventsOf<T extends SimulationEvent['type']>(
  events: SimulationEvent[],
  type: T,
): Extract<SimulationEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<SimulationEvent, { type: T }>[];
}

describe('堆表基础：行放在堆里，索引只存 TID', () => {
  it('插入的行进了堆页，主键索引项指向 TID 而不是整行', () => {
    const { engine, events, cfg } = run([create, { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }]);
    expect(engine.visibleKeys()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const state = replay(events, cfg);
    const pages = heapPages(state);
    // heapTuplesPerPage = 4 ⇒ 10 行要 3 个堆页
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.heap!.blockNo)).toEqual([0, 1, 2]);
    expect(pages.flatMap((p) => p.heap!.tuples.map((t) => t.key))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // 主键索引的叶子项是 (id, ctid)，没有其它列
    const pkPages = Object.values(state.pages).filter((p) => p.indexId === PRIMARY_INDEX_ID && p.type === 'leaf');
    const entry = pkPages.flatMap((p) => p.rows).find((r) => r !== null)!;
    expect(Object.keys(entry).sort()).toEqual(['ctid', 'id']);
  });

  it('主键点查必须回堆一跳（这是与 InnoDB 聚簇索引的根本差别）', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }, { kind: 'search', key: 7 }]);
    const searchEvents = events.filter((e) => e.cmd === 3);
    const fetches = eventsOf(searchEvents, 'HEAP_FETCH');
    expect(fetches).toHaveLength(1);
    expect(fetches[0].found).toBe(true);
    // 命中的位置是堆里的 TID
    const result = eventsOf(searchEvents, 'SEARCH_RESULT')[0];
    expect(result.found).toBe(true);
    expect(result.pageId).toBe(fetches[0].tid.pageId);
  });

  it('顺序扫描完全不碰索引：只读堆页', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 9, pattern: 'sequential', start: 1 }, { kind: 'full_scan' }]);
    const scan = events.filter((e) => e.cmd === 3);
    expect(eventsOf(scan, 'DESCEND')).toHaveLength(0);
    expect(lastScanRows(scan)).toBe(9);
  });
});

describe('MVCC：版本链与可见性', () => {
  it('UPDATE 写新版本、旧版本打 xmax，形成 t_ctid 链', () => {
    const { engine, events } = run([
      create,
      { kind: 'insert', key: 1 },
      { kind: 'update', key: 1, row: { id: 1, name: 'v2', city: 'Beijing', score: 5 } },
    ]);
    const versions = engine.versionsOf(1);
    expect(versions).toHaveLength(2);
    // 旧版本被打上 xmax，并指向新版本
    const setXmax = eventsOf(events, 'HEAP_SET_XMAX');
    expect(setXmax).toHaveLength(1);
    expect(setXmax[0].op).toBe('update');
    expect(setXmax[0].nextTid).not.toBeNull();
    // 只有一个版本还活着
    expect(engine.visibleKeys()).toEqual([1]);
  });

  it('DELETE 只是打 xmax：行变成死元组，索引项还在', () => {
    const { engine, events, cfg } = run([
      create,
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 },
      { kind: 'delete', key: 2 },
    ]);
    expect(engine.visibleKeys()).toEqual([1, 3, 4]);
    const state = replay(events, cfg);
    expect(state.mvcc!.deadTuples).toBe(1);
    expect(state.mvcc!.liveTuples).toBe(3);
    // 索引项数量没变 —— 它还指着那个死元组
    expect(state.indexes[PRIMARY_INDEX_ID].entries).toBe(4);
  });

  it('回滚的事务写入的行对任何人都不可见', () => {
    const { engine } = run([
      create,
      { kind: 'insert', key: 1 },
      { kind: 'begin_txn' },
      { kind: 'insert', key: 2 },
      { kind: 'insert', key: 3 },
      { kind: 'abort_txn' },
    ]);
    expect(engine.visibleKeys()).toEqual([1]);
  });

  it('未提交的写对别的会话不可见', () => {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 3, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn' },
      { kind: 'insert', key: 99 },
      // 会话 B 此时去看：应该只看到 3 行
      { kind: 'use_session', session: 'B' },
      { kind: 'full_scan' },
    ]);
    const scanB = events.filter((e) => e.cmd === 6);
    expect(lastScanRows(scanB)).toBe(3);
  });
});

describe('隔离级别：READ COMMITTED vs REPEATABLE READ', () => {
  /** A 开事务读一次 → B 插入并提交 → A 再读一次。返回 A 两次读到的行数。 */
  function twoReads(isolation: 'read-committed' | 'repeatable-read'): [number, number] {
    const { events } = run([
      create,
      { kind: 'bulk_insert', count: 3, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn', isolation },
      { kind: 'full_scan' }, // cmd 4：A 的第一次读
      { kind: 'use_session', session: 'B' },
      { kind: 'insert', key: 50 }, // 隐式事务，立即提交
      { kind: 'use_session', session: 'A' },
      { kind: 'full_scan' }, // cmd 8：A 的第二次读
      { kind: 'commit_txn' },
    ]);
    return [lastScanRows(events.filter((e) => e.cmd === 4)), lastScanRows(events.filter((e) => e.cmd === 8))];
  }

  it('READ COMMITTED：同一个事务里两次读到的行数不同（不可重复读）', () => {
    expect(twoReads('read-committed')).toEqual([3, 4]);
  });

  it('REPEATABLE READ：整个事务看到同一份快照', () => {
    expect(twoReads('repeatable-read')).toEqual([3, 3]);
  });

  it('REPEATABLE READ 的快照只取一次，READ COMMITTED 每条语句都取', () => {
    const rr = run([
      create,
      { kind: 'begin_txn', isolation: 'repeatable-read' },
      { kind: 'full_scan' },
      { kind: 'full_scan' },
      { kind: 'commit_txn' },
    ]);
    const rc = run([
      create,
      { kind: 'begin_txn', isolation: 'read-committed' },
      { kind: 'full_scan' },
      { kind: 'full_scan' },
      { kind: 'commit_txn' },
    ]);
    expect(eventsOf(rr.events, 'SNAPSHOT_TAKE').filter((e) => e.scope === 'transaction')).toHaveLength(1);
    expect(eventsOf(rr.events, 'SNAPSHOT_TAKE').filter((e) => e.scope === 'statement')).toHaveLength(0);
    expect(eventsOf(rc.events, 'SNAPSHOT_TAKE').filter((e) => e.scope === 'statement')).toHaveLength(2);
  });
});

describe('HOT 更新', () => {
  const unchangedIndexed = { id: 1, name: 'renamed', city: 'Beijing', score: 7919 % 100 };

  it('未改索引列且同页有空位 ⇒ HOT：新版本不写任何索引项', () => {
    const { events, cfg } = run([create, { kind: 'insert', key: 1 }, { kind: 'update', key: 1, row: unchangedIndexed }], {
      hotUpdate: true,
    });
    const setXmax = eventsOf(events, 'HEAP_SET_XMAX');
    expect(setXmax[0].hot).toBe(true);
    const state = replay(events, cfg);
    // 主键索引仍然只有 1 条项（指向旧版本，读时沿链跳到新版本）
    expect(state.indexes[PRIMARY_INDEX_ID].entries).toBe(1);
    expect(state.mvcc!.hotUpdates).toBe(1);
    expect(state.mvcc!.coldUpdates).toBe(0);
  });

  it('关掉 HOT ⇒ 每次更新都要给所有索引写新条目（写放大）', () => {
    const { events, cfg } = run([create, { kind: 'insert', key: 1 }, { kind: 'update', key: 1, row: unchangedIndexed }], {
      hotUpdate: false,
    });
    expect(eventsOf(events, 'HEAP_SET_XMAX')[0].hot).toBe(false);
    const state = replay(events, cfg);
    expect(state.indexes[PRIMARY_INDEX_ID].entries).toBe(2);
    expect(state.mvcc!.coldUpdates).toBe(1);
  });

  it('改了被索引的列 ⇒ 一定不是 HOT', () => {
    const { events } = run(
      [
        create,
        { kind: 'insert', key: 1 },
        { kind: 'create_index', name: 'idx_score', column: 'score' },
        { kind: 'update', key: 1, row: { id: 1, name: 'a', city: 'Beijing', score: 12345 } },
      ],
      { hotUpdate: true },
    );
    expect(eventsOf(events, 'HEAP_SET_XMAX')[0].hot).toBe(false);
  });
});

describe('VACUUM', () => {
  it('清理死元组并同步删除索引项，膨胀率回落', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }];
    for (let k = 1; k <= 6; k++) cmds.push({ kind: 'delete', key: k });

    const before = run(cmds);
    const stateBefore = replay(before.events, before.cfg);
    expect(stateBefore.mvcc!.deadTuples).toBe(6);
    expect(bloatRatio(stateBefore)).toBeCloseTo(0.5, 5);
    expect(stateBefore.indexes[PRIMARY_INDEX_ID].entries).toBe(12);

    const after = run([...cmds, { kind: 'vacuum' }]);
    const stateAfter = replay(after.events, after.cfg);
    expect(stateAfter.mvcc!.deadTuples).toBe(0);
    expect(stateAfter.mvcc!.liveTuples).toBe(6);
    // 死元组的索引项被一并清掉
    expect(stateAfter.indexes[PRIMARY_INDEX_ID].entries).toBe(6);
    expect(after.engine.visibleKeys()).toEqual([7, 8, 9, 10, 11, 12]);

    const end = eventsOf(after.events, 'VACUUM_END')[0];
    expect(end.tuplesRemoved).toBe(6);
    expect(end.indexEntriesRemoved).toBe(6);
  });

  it('VACUUM 之后行指针被释放，新插入可以复用槽位（页数不再增长）', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    for (let k = 1; k <= 8; k++) cmds.push({ kind: 'delete', key: k });
    cmds.push({ kind: 'vacuum' });
    const { events, cfg } = run(cmds);
    const stateA = replay(events, cfg);
    const pagesAfterVacuum = heapPages(stateA).length;

    const more = run([...cmds, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 100 }]);
    const stateB = replay(more.events, more.cfg);
    expect(heapPages(stateB).length).toBe(pagesAfterVacuum);
    expect(more.engine.visibleKeys()).toHaveLength(8);
  });

  it('VACUUM 之后页被标成 all-visible，Index Only Scan 才能跳过回堆', () => {
    const base: Command[] = [create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }];
    // 强制走索引，好把「回不回堆」这件事单独拎出来看（不加 hint 的话 8 行小表当然是顺序扫描更便宜）
    const query: Command = {
      kind: 'query',
      predicate: { kind: 'range', column: 'id', from: 1, to: 4 },
      columns: ['id'],
      hint: PRIMARY_INDEX_ID,
    };
    const noVacuum = run([...base, query]);
    // 没 VACUUM ⇒ 一个页都不是 all-visible ⇒ 计划里必然带 HeapFetch
    const planA = eventsOf(noVacuum.events, 'PLAN_READY').at(-1)!.plan;
    expect(JSON.stringify(planA.root)).toContain('HeapFetch');

    const vacuumed = run([...base, { kind: 'vacuum' }, query]);
    const stateV = replay(vacuumed.events, vacuumed.cfg);
    expect(heapPages(stateV).every((p) => p.heap!.allVisible)).toBe(true);
    const planB = eventsOf(vacuumed.events, 'PLAN_READY').at(-1)!.plan;
    expect(planB.chosen).toContain('Index Only Scan');
    // Index Only Scan 命中 all-visible 页 ⇒ 这条查询一次堆都没回
    const queryEvents = vacuumed.events.filter((e) => e.cmd === 4);
    expect(eventsOf(queryEvents, 'HEAP_FETCH')).toHaveLength(0);
  });

  it('任何写入都会清掉 all-visible 位', () => {
    const { events } = run([
      create,
      // 3 行 ⇒ 第 0 号堆页还有空槽，新插入会落回同一页并把它的 all-visible 位打掉
      { kind: 'bulk_insert', count: 3, pattern: 'sequential', start: 1 },
      { kind: 'vacuum' },
      { kind: 'insert', key: 99 },
    ]);
    const vmEvents = eventsOf(events, 'VISIBILITY_MAP');
    expect(vmEvents.some((e) => e.allVisible)).toBe(true);
    expect(vmEvents.at(-1)!.allVisible).toBe(false);
  });
});

describe('reducer 与引擎一致性（堆表引擎）', () => {
  function mixedWorkload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    const live: Key[] = [];
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      if (roll < 0.45 || live.length < 4) {
        const key = rng.int(1, 200);
        cmds.push({ kind: 'insert', key });
        if (!live.includes(key)) live.push(key);
      } else if (roll < 0.6) {
        const key = rng.pick(live);
        cmds.push({ kind: 'update', key, row: { id: key, name: `u${i}`, city: 'Xian', score: rng.int(0, 99) } });
      } else if (roll < 0.72) {
        const key = rng.pick(live);
        cmds.push({ kind: 'delete', key });
        live.splice(live.indexOf(key), 1);
      } else if (roll < 0.8) {
        cmds.push({ kind: 'search', key: rng.int(1, 200) });
      } else if (roll < 0.87) {
        const from = rng.int(1, 150);
        cmds.push({ kind: 'range_scan', from, to: from + rng.int(1, 40) });
      } else if (roll < 0.93) {
        cmds.push({ kind: 'full_scan' });
      } else if (roll < 0.97) {
        cmds.push({ kind: 'vacuum' });
      } else {
        cmds.push({ kind: 'flush_all' });
      }
    }
    return cmds;
  }

  it('重放事件流得到的状态与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(mixedWorkload(2026, 300));
    const state = replay(events, cfg);
    expect(projectStructure(state)).toEqual(engine.snapshot());
    checkInvariants(projectStructure(state), cfg);
  });

  it('不同堆页容量 / HOT 开关下同样一致', () => {
    for (const patch of [
      { heapTuplesPerPage: 2, order: 3 },
      { heapTuplesPerPage: 8, order: 6, hotUpdate: false },
      { heapTuplesPerPage: 3, order: 5, isolation: 'repeatable-read' as const },
    ]) {
      const { engine, events, cfg } = run(mixedWorkload(11, 180), patch);
      expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：任意前缀都是自洽的状态，且 seq 就是下标', () => {
    const { events, cfg } = run(mixedWorkload(7, 120));
    const state = createInitialState(cfg);
    events.forEach((e, i) => {
      applyEvent(state, e);
      expect(e.seq).toBe(i);
    });
  });

  it('事件流是纯数据，逻辑时钟严格递增', () => {
    const { events } = run(mixedWorkload(5, 90));
    expect(() => structuredClone(events)).not.toThrow();
    for (let i = 1; i < events.length; i++) expect(events[i].t).toBeGreaterThan(events[i - 1].t);
  });

  it('同一命令日志两次执行产生逐字节相同的事件流（会话恢复的前提）', () => {
    const cmds = mixedWorkload(31, 200);
    expect(JSON.stringify(run(cmds).events)).toBe(JSON.stringify(run(cmds).events));
  });
});
