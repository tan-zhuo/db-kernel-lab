import { describe, expect, it } from 'vitest';
import { Rng } from '@dbkl/shared';
import {
  ColumnarEngine,
  DEFAULT_SCHEMA,
  applyEvent,
  bytesIfRowStore,
  columnarIoSaved,
  createInitialState,
  projectStructure,
  replay,
  type Command,
  type EngineConfig,
  type SimulationEvent,
} from '../src';
import { config } from './helpers';

function run(cmds: Command[], patch: Partial<EngineConfig> = {}) {
  const cfg = config({ rowGroupSize: 4, vectorBatchSize: 2, zoneMaps: true, ...patch });
  const engine = new ColumnarEngine(cfg);
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

describe('列存写入：行 → 列的转置', () => {
  it('攒够一个行组才落盘，每列各成一块', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }]);
    const groups = eventsOf(events, 'ROW_GROUP_SEAL');
    expect(groups).toHaveLength(2); // 8 行 / 每组 4 行

    const chunks = eventsOf(events, 'COLUMN_CHUNK_WRITE');
    // 每个行组给每一列写一块
    expect(chunks).toHaveLength(2 * DEFAULT_SCHEMA.columns.length);
    for (const chunk of chunks) expect(chunk.rows).toBe(4);
  });

  it('没攒满的行留在写缓冲里，查询前会先落盘', () => {
    const partial = run([create, { kind: 'bulk_insert', count: 6, pattern: 'sequential', start: 1 }]);
    expect(eventsOf(partial.events, 'ROW_GROUP_SEAL')).toHaveLength(1); // 只有前 4 行落了盘
    expect(partial.engine.allKeys()).toHaveLength(6); // 但逻辑上 6 行都在

    const scanned = run([create, { kind: 'bulk_insert', count: 6, pattern: 'sequential', start: 1 }, { kind: 'full_scan' }]);
    expect(eventsOf(scanned.events, 'ROW_GROUP_SEAL')).toHaveLength(2);
    expect(eventsOf(scanned.events, 'SCAN_END').at(-1)!.rows).toBe(6);
  });

  it('自动挑编码：自增主键走 delta，低基数列走字典/RLE', () => {
    const { events } = run([create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }], {
      rowGroupSize: 12,
    });
    const chunks = eventsOf(events, 'COLUMN_CHUNK_WRITE');
    const byColumn = Object.fromEntries(chunks.map((c) => [c.column, c]));

    // id 严格递增 ⇒ delta
    expect(byColumn.id.encoding).toBe('delta');
    // city 只有 6 个取值、12 行 ⇒ 基数低，走字典或 RLE
    expect(['dictionary', 'rle']).toContain(byColumn.city.encoding);
    // 编码后都不该比原样更大
    for (const c of chunks) expect(c.encodedBytes).toBeLessThanOrEqual(c.rawBytes);
  });

  it('同列同质所以压得动：整体压缩比 > 1', () => {
    const { engine } = run([create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }], {
      rowGroupSize: 10,
    });
    expect(engine.compressionRatio()).toBeGreaterThan(1);
  });

  it('强制 plain 编码时压缩比退化为 1（作为对照组）', () => {
    const { engine } = run([create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }], {
      columnEncoding: 'plain',
    });
    expect(engine.compressionRatio()).toBeCloseTo(1, 5);
  });
});

describe('列存读取：列裁剪 + 区间剪枝 + 向量化', () => {
  const seed: Command[] = [create, { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 }];

  it('只读查询用到的列 —— 这是列存最大的卖点', () => {
    const narrow = run([...seed, { kind: 'query', predicate: { kind: 'all' }, columns: ['id'] }]);
    const wide = run([...seed, { kind: 'query', predicate: { kind: 'all' }, columns: '*' }]);

    const narrowCols = new Set(eventsOf(narrow.events, 'COLUMN_READ').map((e) => e.column));
    const wideCols = new Set(eventsOf(wide.events, 'COLUMN_READ').map((e) => e.column));
    expect([...narrowCols]).toEqual(['id']);
    expect(wideCols.size).toBe(DEFAULT_SCHEMA.columns.length);

    // 读的字节数也应该差一大截
    const narrowBytes = eventsOf(narrow.events, 'COLUMN_READ').reduce((n, e) => n + e.bytes, 0);
    const wideBytes = eventsOf(wide.events, 'COLUMN_READ').reduce((n, e) => n + e.bytes, 0);
    expect(narrowBytes).toBeLessThan(wideBytes / 2);
  });

  it('谓词列也会被读到（哪怕不在投影里）', () => {
    const { events } = run([...seed, { kind: 'query', predicate: { kind: 'eq', column: 'score', value: 7 }, columns: ['id'] }]);
    const cols = new Set(eventsOf(events, 'COLUMN_READ').map((e) => e.column));
    expect([...cols].sort()).toEqual(['id', 'score']);
  });

  it('区间统计能整块跳过：窄区间只碰一个行组', () => {
    const { events } = run([...seed, { kind: 'range_scan', from: 1, to: 3 }], { rowGroupSize: 4 });
    const scanEvents = events.filter((e) => e.cmd === 3);
    const skips = eventsOf(scanEvents, 'ZONE_MAP_SKIP');
    // 24 行 / 每组 4 行 = 6 组，只有第一组的 id 区间与 [1,3] 有交集
    expect(skips).toHaveLength(5);
    expect(eventsOf(scanEvents, 'SCAN_END').at(-1)!.rows).toBe(3);
  });

  it('关掉区间统计就只能全扫（对照组）', () => {
    const withZone = run([...seed, { kind: 'range_scan', from: 1, to: 3 }], { zoneMaps: true });
    const without = run([...seed, { kind: 'range_scan', from: 1, to: 3 }], { zoneMaps: false });

    const readsWith = eventsOf(withZone.events.filter((e) => e.cmd === 3), 'COLUMN_READ').length;
    const readsWithout = eventsOf(without.events.filter((e) => e.cmd === 3), 'COLUMN_READ').length;
    expect(readsWith).toBeLessThan(readsWithout);
    // 但结果必须完全一致 —— 剪枝只能省 IO，不能改答案
    expect(eventsOf(withZone.events, 'SCAN_END').at(-1)!.rows).toBe(
      eventsOf(without.events, 'SCAN_END').at(-1)!.rows,
    );
  });

  it('向量化：按批处理而不是一行一行', () => {
    const { events } = run([...seed, { kind: 'full_scan' }], { rowGroupSize: 8, vectorBatchSize: 4 });
    const batches = eventsOf(events.filter((e) => e.cmd === 3), 'VECTOR_BATCH');
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) expect(b.rows).toBeLessThanOrEqual(4);
    expect(batches.reduce((n, b) => n + b.rows, 0)).toBe(24);
  });

  it('IO 账单：只读一列时省下的比例可以直接算出来', () => {
    const { events, cfg } = run([...seed, { kind: 'query', predicate: { kind: 'all' }, columns: ['id'] }]);
    const c = replay(events, cfg).columnar!;
    expect(c.lastScan).not.toBeNull();
    expect(c.lastScan!.columnsRead).toEqual(['id']);
    // 行存的分母 = 所有行组 × 所有列
    expect(bytesIfRowStore(c)).toBeGreaterThan(c.lastScan!.bytesRead);
    expect(columnarIoSaved(c)).toBeGreaterThan(0.5);
  });

  it('整片被剪枝掉也要有账单（0 列 / 全跳过 也是结果）', () => {
    // 查一个所有行组都不可能有的键
    const { events, cfg } = run([...seed, { kind: 'query', predicate: { kind: 'eq', column: 'id', value: 9999 } }]);
    const c = replay(events, cfg).columnar!;
    expect(c.lastScan, '全跳过时账单不能是 null').not.toBeNull();
    expect(c.lastScan!.columnsRead).toEqual([]);
    expect(c.lastScan!.bytesRead).toBe(0);
    expect(c.lastScan!.rowGroupsSkipped).toBe(c.rowGroups.length);
    expect(columnarIoSaved(c)).toBe(1); // 一个字节都没读
  });

  it('不支持原地更新与删除，并给出可读的理由', () => {
    const { events } = run([...seed, { kind: 'delete', key: 3 }]);
    const note = eventsOf(events, 'NOTE').at(-1)!;
    expect(note.level).toBe('error');
    expect(note.message).toContain('重写整个行组');
  });
});

describe('reducer 与引擎一致性（列存）', () => {
  function workload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      if (roll < 0.55) cmds.push({ kind: 'insert', key: rng.int(1, 200) });
      else if (roll < 0.7) cmds.push({ kind: 'bulk_insert', count: rng.int(2, 8), pattern: 'sequential' });
      else if (roll < 0.8) cmds.push({ kind: 'full_scan' });
      else if (roll < 0.9) {
        const from = rng.int(1, 100);
        cmds.push({ kind: 'range_scan', from, to: from + rng.int(1, 30) });
      } else cmds.push({ kind: 'flush_all' });
    }
    return cmds;
  }

  it('重放事件流得到的结构与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(workload(2026, 200));
    expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
  });

  it('不同行组大小 / 编码策略下同样一致', () => {
    for (const patch of [
      { rowGroupSize: 2, vectorBatchSize: 1 },
      { rowGroupSize: 16, columnEncoding: 'plain' as const },
      { rowGroupSize: 6, zoneMaps: false },
    ]) {
      const { engine, events, cfg } = run(workload(11, 150), patch);
      expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：seq 就是下标，逻辑时钟严格递增', () => {
    const { events, cfg } = run(workload(7, 120));
    const state = createInitialState(cfg);
    events.forEach((e, i) => {
      applyEvent(state, e);
      expect(e.seq).toBe(i);
      if (i > 0) expect(e.t).toBeGreaterThan(events[i - 1].t);
    });
  });

  it('同一命令日志两次执行产生逐字节相同的事件流', () => {
    const cmds = workload(31, 150);
    expect(JSON.stringify(run(cmds).events)).toBe(JSON.stringify(run(cmds).events));
  });
});
