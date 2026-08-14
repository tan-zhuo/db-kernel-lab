import { describe, expect, it } from 'vitest';
import { Rng } from '@dbkl/shared';
import { BTreeEngine, DEFAULT_SCHEMA } from '../src';
import { checkInvariants, config, sortedKeys } from './helpers';

function freshEngine(patch = {}) {
  const cfg = config(patch);
  const engine = new BTreeEngine(cfg);
  engine.execute({ kind: 'create_table', schema: DEFAULT_SCHEMA });
  return { engine, cfg };
}

describe('B+ 树插入', () => {
  for (const order of [3, 4, 5, 8]) {
    it(`order=${order}：顺序插入 200 条后结构不变式成立`, () => {
      const { engine, cfg } = freshEngine({ order });
      for (let k = 1; k <= 200; k++) engine.execute({ kind: 'insert', key: k });
      const snap = engine.snapshot();
      checkInvariants(snap, cfg);
      expect(sortedKeys(snap)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      expect(snap.height).toBeGreaterThan(1);
    });

    it(`order=${order}：随机插入 300 条后结构不变式成立`, () => {
      const { engine, cfg } = freshEngine({ order });
      const rng = new Rng(7 + order);
      const expected = new Set<number>();
      for (let i = 0; i < 300; i++) {
        const k = rng.int(1, 500);
        expected.add(k);
        engine.execute({ kind: 'insert', key: k });
      }
      const snap = engine.snapshot();
      checkInvariants(snap, cfg);
      expect(sortedKeys(snap)).toEqual([...expected].sort((a, b) => a - b));
    });
  }

  it('逆序插入也能保持平衡', () => {
    const { engine, cfg } = freshEngine({ order: 4 });
    for (let k = 100; k >= 1; k--) engine.execute({ kind: 'insert', key: k });
    const snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(sortedKeys(snap)).toHaveLength(100);
  });

  it('重复键触发更新而不是插入', () => {
    const { engine } = freshEngine();
    engine.execute({ kind: 'insert', key: 10 });
    const events = engine.execute({ kind: 'insert', key: 10 });
    expect(events.some((e) => e.type === 'RECORD_UPDATE')).toBe(true);
    expect(events.some((e) => e.type === 'RECORD_INSERT')).toBe(false);
    expect(engine.snapshot().recordCount).toBe(1);
  });

  it('页分裂事件携带完整的搬迁数据与上浮键', () => {
    const { engine } = freshEngine({ order: 4 });
    let split;
    for (let k = 1; k <= 4 && !split; k++) {
      const events = engine.execute({ kind: 'insert', key: k });
      split = events.find((e) => e.type === 'PAGE_SPLIT');
    }
    expect(split, '插满 order-1 条后第 order 条必须触发分裂').toBeTruthy();
    if (split?.type !== 'PAGE_SPLIT') throw new Error('unreachable');
    expect(split.pageType).toBe('leaf');
    expect(split.moved.keys.length).toBeGreaterThan(0);
    expect(split.moved.rows?.length).toBe(split.moved.keys.length);
    expect(split.promotedKey).toBe(split.moved.keys[0]);
  });

  it('fillFactor 影响分裂点：0.9 让左页保留更多记录', () => {
    const even = freshEngine({ order: 10, fillFactor: 0.5 });
    const right = freshEngine({ order: 10, fillFactor: 0.9 });
    for (let k = 1; k <= 10; k++) {
      even.engine.execute({ kind: 'insert', key: k });
      right.engine.execute({ kind: 'insert', key: k });
    }
    const leftKeysEven = even.engine.snapshot().pages[even.engine.snapshot().firstLeafId!].keys.length;
    const leftKeysRight = right.engine.snapshot().pages[right.engine.snapshot().firstLeafId!].keys.length;
    expect(leftKeysRight).toBeGreaterThan(leftKeysEven);
    checkInvariants(even.engine.snapshot(), even.cfg);
  });

  it('顺序插入优化让最右页分裂几乎不搬数据', () => {
    const { engine } = freshEngine({ order: 6, sequentialInsertOptimization: true });
    const moved: number[] = [];
    for (let k = 1; k <= 40; k++) {
      for (const e of engine.execute({ kind: 'insert', key: k })) {
        if (e.type === 'PAGE_SPLIT' && e.pageType === 'leaf') moved.push(e.moved.keys.length);
      }
    }
    expect(moved.length).toBeGreaterThan(3);
    expect(Math.max(...moved)).toBe(1);
  });
});

describe('B+ 树查询', () => {
  it('点查命中与未命中都产生 SEARCH_RESULT', () => {
    const { engine } = freshEngine();
    for (let k = 1; k <= 50; k++) engine.execute({ kind: 'insert', key: k * 2 });

    const hit = engine.execute({ kind: 'search', key: 20 }).find((e) => e.type === 'SEARCH_RESULT');
    expect(hit?.type === 'SEARCH_RESULT' && hit.found).toBe(true);

    const miss = engine.execute({ kind: 'search', key: 21 }).find((e) => e.type === 'SEARCH_RESULT');
    expect(miss?.type === 'SEARCH_RESULT' && miss.found).toBe(false);
  });

  it('查找路径的 DESCEND 事件数量等于树高 - 1', () => {
    const { engine } = freshEngine({ order: 4 });
    for (let k = 1; k <= 100; k++) engine.execute({ kind: 'insert', key: k });
    const height = engine.snapshot().height;
    const descends = engine.execute({ kind: 'search', key: 55 }).filter((e) => e.type === 'DESCEND');
    expect(descends).toHaveLength(height - 1);
  });

  it('范围扫描沿叶子链表返回有序结果', () => {
    const { engine } = freshEngine({ order: 4 });
    for (let k = 1; k <= 100; k++) engine.execute({ kind: 'insert', key: k });
    const events = engine.execute({ kind: 'range_scan', from: 30, to: 45 });
    const emitted = events.filter((e) => e.type === 'SCAN_STEP' && e.emitted).map((e) => (e.type === 'SCAN_STEP' ? e.key : 0));
    expect(emitted).toEqual(Array.from({ length: 16 }, (_, i) => i + 30));
    const end = events.find((e) => e.type === 'SCAN_END');
    expect(end?.type === 'SCAN_END' && end.rows).toBe(16);
  });

  it('全表扫描覆盖所有记录', () => {
    const { engine } = freshEngine({ order: 5 });
    for (let k = 1; k <= 77; k++) engine.execute({ kind: 'insert', key: k });
    const end = engine.execute({ kind: 'full_scan' }).find((e) => e.type === 'SCAN_END');
    expect(end?.type === 'SCAN_END' && end.rows).toBe(77);
  });
});

describe('B+ 树删除', () => {
  for (const order of [3, 4, 6]) {
    it(`order=${order}：随机删除到空的过程中不变式始终成立`, () => {
      const { engine, cfg } = freshEngine({ order });
      const rng = new Rng(99 + order);
      const keys = rng.shuffle(Array.from({ length: 120 }, (_, i) => i + 1));
      for (const k of keys) engine.execute({ kind: 'insert', key: k });

      const remaining = new Set(keys);
      for (const k of rng.shuffle([...keys])) {
        engine.execute({ kind: 'delete', key: k });
        remaining.delete(k);
        const snap = engine.snapshot();
        checkInvariants(snap, cfg);
        expect(sortedKeys(snap)).toEqual([...remaining].sort((a, b) => a - b));
      }
      expect(engine.snapshot().height).toBe(1);
    });
  }

  it('删除会产生合并或借位事件，并回收页', () => {
    const { engine } = freshEngine({ order: 4 });
    for (let k = 1; k <= 40; k++) engine.execute({ kind: 'insert', key: k });
    let merges = 0;
    let redistributes = 0;
    let frees = 0;
    for (let k = 1; k <= 30; k++) {
      for (const e of engine.execute({ kind: 'delete', key: k })) {
        if (e.type === 'PAGE_MERGE') merges++;
        if (e.type === 'REDISTRIBUTE') redistributes++;
        if (e.type === 'PAGE_FREE') frees++;
      }
    }
    expect(merges + redistributes).toBeGreaterThan(0);
    expect(frees).toBeGreaterThan(0);
  });

  it('删除不存在的键是安全的 no-op', () => {
    const { engine, cfg } = freshEngine();
    for (let k = 1; k <= 10; k++) engine.execute({ kind: 'insert', key: k });
    const before = engine.snapshot();
    engine.execute({ kind: 'delete', key: 999 });
    const after = engine.snapshot();
    expect(after.recordCount).toBe(before.recordCount);
    checkInvariants(after, cfg);
  });

  it('删光之后根退化为单个叶子页', () => {
    const { engine, cfg } = freshEngine({ order: 4 });
    for (let k = 1; k <= 50; k++) engine.execute({ kind: 'insert', key: k });
    for (let k = 1; k <= 50; k++) engine.execute({ kind: 'delete', key: k });
    const snap = engine.snapshot();
    checkInvariants(snap, cfg);
    expect(snap.height).toBe(1);
    expect(snap.recordCount).toBe(0);
    expect(Object.keys(snap.pages)).toHaveLength(1);
    expect(snap.pages[snap.rootId!].type).toBe('leaf');
  });
});

describe('批量插入', () => {
  it('bulk_insert 与逐条插入产生相同的最终结构', () => {
    const a = freshEngine({ order: 5 });
    const b = freshEngine({ order: 5 });
    a.engine.execute({ kind: 'bulk_insert', count: 300, pattern: 'sequential', start: 1 });
    for (let k = 1; k <= 300; k++) b.engine.execute({ kind: 'insert', key: k });
    expect(a.engine.snapshot().pages).toEqual(b.engine.snapshot().pages);
  });

  it('随机模式在同一 seed 下可复现', () => {
    const a = freshEngine({ order: 5, seed: 1234 });
    const b = freshEngine({ order: 5, seed: 1234 });
    a.engine.execute({ kind: 'bulk_insert', count: 200, pattern: 'random', max: 400 });
    b.engine.execute({ kind: 'bulk_insert', count: 200, pattern: 'random', max: 400 });
    expect(sortedKeys(a.engine.snapshot())).toEqual(sortedKeys(b.engine.snapshot()));
  });
});
