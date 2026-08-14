import { describe, expect, it } from 'vitest';
import type { PageId } from '@dbkl/shared';
import { BufferPool, type SimulationEventBody } from '../src';
import { config } from './helpers';

function harness(patch = {}) {
  const cfg = config(patch);
  const events: SimulationEventBody[] = [];
  const dirty = new Set<PageId>();
  const pool = new BufferPool(cfg, {
    emit: (e) => events.push(e),
    isDirty: (id) => dirty.has(id),
    onFlushed: (id) => dirty.delete(id),
    exists: () => true,
  });
  return { pool, events, dirty, cfg };
}

describe('Buffer Pool', () => {
  it('冷启动全是 miss，重复访问是 hit', () => {
    const { pool, events } = harness({ bufferPoolFrames: 4 });
    pool.access(1);
    pool.access(2);
    pool.access(1);
    expect(events.map((e) => e.type)).toEqual(['BUFFER_MISS', 'BUFFER_MISS', 'BUFFER_HIT']);
    const hit = events[2];
    expect(hit.type === 'BUFFER_HIT' && hit.frame).toBe(0);
  });

  it('LRU 淘汰最久未使用的页', () => {
    const { pool, events } = harness({ bufferPoolFrames: 3, evictionPolicy: 'LRU' });
    pool.access(1);
    pool.access(2);
    pool.access(3);
    pool.access(1); // 1 变成最近使用，2 成为 LRU
    pool.access(4);
    const evict = events.find((e) => e.type === 'BUFFER_EVICT');
    expect(evict?.type === 'BUFFER_EVICT' && evict.pageId).toBe(2);
    expect(pool.residentPages().sort()).toEqual([1, 3, 4]);
  });

  it('淘汰脏页会先刷盘', () => {
    const { pool, events, dirty } = harness({ bufferPoolFrames: 1 });
    pool.access(1);
    dirty.add(1);
    pool.access(2);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['BUFFER_MISS', 'PAGE_FLUSH', 'BUFFER_EVICT', 'BUFFER_MISS']);
    const evict = events[2];
    expect(evict.type === 'BUFFER_EVICT' && evict.wasDirty).toBe(true);
    expect(dirty.has(1)).toBe(false);
  });

  it('CLOCK 策略给被引用过的页第二次机会', () => {
    const { pool, events } = harness({ bufferPoolFrames: 3, evictionPolicy: 'CLOCK' });
    pool.access(1);
    pool.access(2);
    pool.access(3);
    pool.access(4); // 所有页 refBit=1 → 转一圈清零后淘汰
    const evicted = events.filter((e) => e.type === 'BUFFER_EVICT');
    expect(evicted).toHaveLength(1);
    expect(pool.residentPages()).toContain(4);
    expect(pool.residentPages()).toHaveLength(3);
  });

  it('flushAll 只刷脏页', () => {
    const { pool, events, dirty } = harness({ bufferPoolFrames: 4 });
    pool.access(1);
    pool.access(2);
    pool.access(3);
    dirty.add(2);
    const n = pool.flushAll('manual');
    expect(n).toBe(1);
    const flush = events.filter((e) => e.type === 'PAGE_FLUSH');
    expect(flush).toHaveLength(1);
    expect(flush[0].type === 'PAGE_FLUSH' && flush[0].pageId).toBe(2);
  });

  it('页被回收后不再占用帧', () => {
    const { pool } = harness({ bufferPoolFrames: 2 });
    pool.access(1);
    pool.access(2);
    pool.forget(1);
    expect(pool.residentPages()).toEqual([2]);
    pool.access(3);
    expect(pool.residentPages().sort()).toEqual([2, 3]);
  });

  it('缓冲池越小，扫描时的 miss 越多', () => {
    const small = harness({ bufferPoolFrames: 2 });
    const big = harness({ bufferPoolFrames: 16 });
    for (let round = 0; round < 3; round++) {
      for (let p = 1; p <= 8; p++) {
        small.pool.access(p);
        big.pool.access(p);
      }
    }
    const missOf = (h: ReturnType<typeof harness>) => h.events.filter((e) => e.type === 'BUFFER_MISS').length;
    expect(missOf(small)).toBe(24);
    expect(missOf(big)).toBe(8);
  });
});
