import { describe, expect, it } from 'vitest';
import { Rng } from '@dbkl/shared';
import {
  BTreeEngine,
  DEFAULT_SCHEMA,
  PRIMARY_INDEX_ID,
  projectStructure,
  replay,
  type Command,
  type PhysicalPlan,
  type SimulationEvent,
} from '../src';
import { checkInvariants, config, primary, sortedEntries, sortedKeys } from './helpers';

function engineWith(patch = {}, rows = 0, pattern: 'sequential' | 'random' = 'sequential') {
  const cfg = config(patch);
  const engine = new BTreeEngine(cfg);
  engine.execute({ kind: 'create_table', schema: DEFAULT_SCHEMA });
  if (rows > 0) engine.execute({ kind: 'bulk_insert', count: rows, pattern, start: 1 });
  return { engine, cfg };
}

/** 表里 score = (id * 7919) % 100 —— 100 个不同值，便于构造重复键。 */
const scoreOf = (id: number) => (id * 7919) % 100;

function planOf(events: SimulationEvent[]): PhysicalPlan {
  const e = events.find((x) => x.type === 'PLAN_READY');
  if (!e || e.type !== 'PLAN_READY') throw new Error('没有产生执行计划');
  return e.plan;
}

function ops(events: SimulationEvent[]): string[] {
  return events.filter((e) => e.type === 'OPERATOR_OPEN').map((e) => (e.type === 'OPERATOR_OPEN' ? e.op : ''));
}

describe('二级索引', () => {
  it('建索引会扫描聚簇索引并灌入 (列值, 主键) 条目', () => {
    const { engine, cfg } = engineWith({ order: 4 }, 40);
    const events = engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });

    expect(events.some((e) => e.type === 'INDEX_CREATE')).toBe(true);
    expect(events.filter((e) => e.type === 'SCAN_STEP')).toHaveLength(40);

    const snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(snap.indexes.idx_score.entries).toBe(40);
    expect(snap.indexes.idx_score.clustered).toBe(false);

    const entries = sortedEntries(snap, 'idx_score');
    expect(entries).toHaveLength(40);
    // 索引项按列值有序，且每条都带回主键
    for (let i = 1; i < entries.length; i++) expect(entries[i - 1][0]).toBeLessThanOrEqual(entries[i][0]);
    expect(entries.map(([, pk]) => pk).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    for (const [key, pk] of entries) expect(key).toBe(scoreOf(pk));
  });

  it('建索引后的插入/删除会同时维护两棵树', () => {
    const { engine, cfg } = engineWith({ order: 4 }, 20);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });

    engine.execute({ kind: 'insert', key: 500 });
    let snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(snap.indexes[PRIMARY_INDEX_ID].entries).toBe(21);
    expect(snap.indexes.idx_score.entries).toBe(21);
    expect(sortedEntries(snap, 'idx_score')).toContainEqual([scoreOf(500), 500]);

    engine.execute({ kind: 'delete', key: 500 });
    snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(snap.indexes.idx_score.entries).toBe(20);
    expect(sortedEntries(snap, 'idx_score').some(([, pk]) => pk === 500)).toBe(false);
  });

  it('更新索引列会把二级索引项搬到新位置', () => {
    const { engine, cfg } = engineWith({ order: 4 }, 10);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    engine.execute({ kind: 'update', key: 3, row: { id: 3, name: 'x', city: 'Beijing', score: 999 } });

    const snap = engine.snapshot();
    checkInvariants(snap, cfg);
    const entries = sortedEntries(snap, 'idx_score');
    expect(entries).toContainEqual([999, 3]);
    expect(entries.some(([k, pk]) => pk === 3 && k === scoreOf(3))).toBe(false);
    expect(entries).toHaveLength(10);
  });

  it('重复键：同一个索引值下的多条记录都能被找到，删除互不影响', () => {
    const cfg = config({ order: 4 });
    const engine = new BTreeEngine(cfg);
    engine.execute({ kind: 'create_table', schema: DEFAULT_SCHEMA });
    // 20 行全部 score = 7
    for (let id = 1; id <= 20; id++) {
      engine.execute({ kind: 'insert', key: id, row: { id, name: `n${id}`, city: 'Beijing', score: 7 } });
    }
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    checkInvariants(engine.snapshot(), cfg);
    expect(sortedKeys(engine.snapshot(), 'idx_score')).toEqual(new Array(20).fill(7));

    // 相等键横跨多个页，点查必须沿叶子链表把它们全部扫出来
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: 7 } });
    const emitted = events.filter((e) => e.type === 'OPERATOR_ROW' && e.emitted);
    const project = planOf(events).root;
    const projectRows = events.filter((e) => e.type === 'OPERATOR_CLOSE' && e.nodeId === project.id);
    expect(projectRows[0]?.type === 'OPERATOR_CLOSE' && projectRows[0].actualRows).toBe(20);
    expect(emitted.length).toBeGreaterThanOrEqual(20);

    engine.execute({ kind: 'delete', key: 10 });
    const snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(snap.indexes.idx_score.entries).toBe(19);
    expect(sortedEntries(snap, 'idx_score').some(([, pk]) => pk === 10)).toBe(false);
  });

  it('随机负载下两棵树始终保持一致', () => {
    const cfg = config({ order: 4, bufferPoolFrames: 6 });
    const engine = new BTreeEngine(cfg);
    engine.execute({ kind: 'create_table', schema: DEFAULT_SCHEMA });
    engine.execute({ kind: 'bulk_insert', count: 60, pattern: 'random', max: 200 });
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });

    const rng = new Rng(2024);
    const live = new Set(sortedKeys(engine.snapshot()));
    for (let i = 0; i < 120; i++) {
      if (rng.next() < 0.5) {
        const key = rng.int(1, 200);
        engine.execute({ kind: 'insert', key });
        live.add(key);
      } else if (live.size > 0) {
        const key = [...live][rng.int(0, live.size - 1)];
        engine.execute({ kind: 'delete', key });
        live.delete(key);
      }
      const snap = engine.snapshot();
      checkInvariants(snap, cfg);
      expect(snap.indexes.idx_score.entries).toBe(snap.indexes[PRIMARY_INDEX_ID].entries);
    }
    // 每条聚簇记录都在二级索引里恰好出现一次，且键值正确
    const snap = engine.snapshot();
    const entries = sortedEntries(snap, 'idx_score');
    expect(entries.map(([, pk]) => pk).sort((a, b) => a - b)).toEqual(sortedKeys(snap));
    for (const [key, pk] of entries) expect(key).toBe(scoreOf(pk));
  });

  it('删除索引会回收它的全部页', () => {
    const { engine, cfg } = engineWith({ order: 4 }, 30);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const withIndex = Object.keys(engine.snapshot().pages).length;

    const events = engine.execute({ kind: 'drop_index', name: 'idx_score' });
    const snap = engine.snapshot();
    expect(events.filter((e) => e.type === 'PAGE_FREE').length).toBeGreaterThan(0);
    expect(snap.indexes.idx_score).toBeUndefined();
    expect(Object.keys(snap.pages).length).toBeLessThan(withIndex);
    expect(Object.values(snap.pages).every((p) => p.indexId === PRIMARY_INDEX_ID)).toBe(true);
    checkInvariants(snap, cfg);
  });

  it('拒绝在字符串列与主键上建二级索引', () => {
    const { engine } = engineWith({ order: 4 }, 5);
    const bad = engine.execute({ kind: 'create_index', name: 'idx_city', column: 'city' });
    expect(bad.find((e) => e.type === 'COMMAND_END')?.type === 'COMMAND_END' && bad.at(-1)).toBeTruthy();
    expect(bad.some((e) => e.type === 'NOTE' && e.level === 'error')).toBe(true);
    expect(engine.snapshot().indexes.idx_city).toBeUndefined();

    const pk = engine.execute({ kind: 'create_index', name: 'idx_id', column: 'id' });
    expect(pk.some((e) => e.type === 'NOTE' && e.level === 'error')).toBe(true);
  });
});

describe('查询优化器与算子执行', () => {
  it('等值查询走二级索引并回表', () => {
    const { engine } = engineWith({ order: 5 }, 120);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const target = scoreOf(7);
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: target } });

    const plan = planOf(events);
    expect(plan.candidates.find((c) => c.chosen)?.strategy).toBe('index-seek');
    expect(ops(events)).toContain('IndexSeek');
    expect(ops(events)).toContain('RowIdLookup');

    const lookups = events.filter((e) => e.type === 'LOOKUP_BACK');
    const dones = events.filter((e) => e.type === 'LOOKUP_DONE');
    expect(lookups.length).toBeGreaterThan(0);
    expect(dones).toHaveLength(lookups.length);
    expect(dones.every((e) => e.type === 'LOOKUP_DONE' && e.found)).toBe(true);

    // 回表拿到的主键必须真的对应该索引值
    for (const e of lookups) {
      if (e.type !== 'LOOKUP_BACK') continue;
      expect(scoreOf(e.primaryKey)).toBe(target);
    }
  });

  it('覆盖索引不需要回表', () => {
    const { engine } = engineWith({ order: 5 }, 80);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const events = engine.execute({
      kind: 'query',
      predicate: { kind: 'eq', column: 'score', value: scoreOf(3) },
      columns: ['score', 'id'],
    });
    expect(ops(events)).toContain('IndexSeek');
    expect(ops(events)).not.toContain('RowIdLookup');
    expect(events.some((e) => e.type === 'LOOKUP_BACK')).toBe(false);
    expect(planOf(events).candidates.find((c) => c.chosen)?.needsLookup).toBe(false);
  });

  it('没有可用索引时退化为全表扫描 + Filter', () => {
    const { engine } = engineWith({ order: 5 }, 50);
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: scoreOf(9) } });
    expect(ops(events)).toEqual(expect.arrayContaining(['TableScan', 'Filter', 'Project']));
    expect(planOf(events).candidates.find((c) => c.chosen)?.strategy).toBe('table-scan');
  });

  it('hint=none 可以强制全表扫描，用于对比实验', () => {
    const { engine } = engineWith({ order: 5 }, 80);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const forced = engine.execute({
      kind: 'query',
      predicate: { kind: 'eq', column: 'score', value: scoreOf(5) },
      hint: 'none',
    });
    expect(ops(forced)).toContain('TableScan');
    expect(planOf(forced).chosen).toContain('强制');

    // 强制全表扫描的逻辑读应显著多于走索引
    const auto = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: scoreOf(5) } });
    const reads = (evs: SimulationEvent[]) => evs.filter((e) => e.type === 'PAGE_READ').length;
    expect(reads(forced)).toBeGreaterThan(reads(auto));
  });

  it('宽范围查询时优化器主动放弃索引（回表太贵）', () => {
    const { engine } = engineWith({ order: 5 }, 200);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const wide = engine.execute({
      kind: 'query',
      predicate: { kind: 'range', column: 'score', from: 0, to: 99 },
    });
    expect(planOf(wide).candidates.find((c) => c.chosen)?.strategy).toBe('table-scan');

    const narrow = engine.execute({
      kind: 'query',
      predicate: { kind: 'range', column: 'score', from: 40, to: 41 },
    });
    expect(planOf(narrow).candidates.find((c) => c.chosen)?.strategy).toBe('index-range');
  });

  it('主键谓词直接走聚簇索引，不需要回表', () => {
    const { engine } = engineWith({ order: 5 }, 100);
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'id', value: 42 } });
    expect(ops(events)).toContain('IndexSeek');
    expect(ops(events)).not.toContain('RowIdLookup');
    const plan = planOf(events);
    expect(plan.candidates.find((c) => c.chosen)?.indexId).toBe(PRIMARY_INDEX_ID);
  });

  it('算子记录实际行数，可与估算行数对比', () => {
    const { engine } = engineWith({ order: 5 }, 100);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: scoreOf(11) } });
    const plan = planOf(events);
    const closes = events.filter((e) => e.type === 'OPERATOR_CLOSE');
    expect(closes.length).toBe(countNodes(plan));

    const projectClose = closes.find((e) => e.type === 'OPERATOR_CLOSE' && e.nodeId === plan.root.id);
    const actual = projectClose?.type === 'OPERATOR_CLOSE' ? projectClose.actualRows : -1;
    // 表里恰好有 1 行 score = scoreOf(11)（100 个不同值、100 行）
    expect(actual).toBe(1);
    expect(plan.root.estRows).toBeGreaterThan(0);
  });

  it('查询前会刷新统计信息（模拟 ANALYZE）', () => {
    const { engine } = engineWith({ order: 5 }, 30);
    engine.execute({ kind: 'create_index', name: 'idx_score', column: 'score' });
    const events = engine.execute({ kind: 'query', predicate: { kind: 'eq', column: 'score', value: 1 } });
    const stats = events.filter((e) => e.type === 'INDEX_STATS');
    expect(stats.length).toBeGreaterThanOrEqual(2);
    const idxStats = stats.find((e) => e.type === 'INDEX_STATS' && e.indexId === 'idx_score');
    expect(idxStats?.type === 'INDEX_STATS' && idxStats.entries).toBe(30);
  });
});

describe('多索引下的事件重放一致性', () => {
  it('含建索引/查询/回表的完整负载，重放结果与引擎快照一致', () => {
    const cfg = config({ order: 4, bufferPoolFrames: 5 });
    const engine = new BTreeEngine(cfg);
    const commands: Command[] = [
      { kind: 'create_table', schema: DEFAULT_SCHEMA },
      { kind: 'bulk_insert', count: 50, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'insert', key: 500 },
      { kind: 'query', predicate: { kind: 'eq', column: 'score', value: scoreOf(500) } },
      { kind: 'query', predicate: { kind: 'range', column: 'score', from: 10, to: 20 } },
      { kind: 'query', predicate: { kind: 'all' } },
      { kind: 'delete', key: 7 },
      { kind: 'query', predicate: { kind: 'eq', column: 'score', value: scoreOf(7) }, columns: ['id', 'score'] },
      { kind: 'drop_index', name: 'idx_score' },
      { kind: 'create_index', name: 'idx_score2', column: 'score' },
      { kind: 'bulk_insert', count: 20, pattern: 'random', max: 100 },
    ];
    const events: SimulationEvent[] = [];
    for (const c of commands) events.push(...engine.execute(c));

    const state = replay(events, cfg);
    expect(projectStructure(state)).toEqual(engine.snapshot());
    checkInvariants(projectStructure(state), cfg);
    expect(state.metrics.lookups).toBeGreaterThan(0);
    expect(state.plan).not.toBeNull();
    expect(primary(engine.snapshot()).entries).toBe(state.recordCount);
  });
});

function countNodes(plan: PhysicalPlan): number {
  const walk = (n: PhysicalPlan['root']): number => 1 + n.children.reduce((s, c) => s + walk(c), 0);
  return walk(plan.root);
}
