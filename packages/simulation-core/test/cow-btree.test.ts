import { describe, expect, it } from 'vitest';
import { Rng, type Key } from '@dbkl/shared';
import {
  CowBTreeEngine,
  DEFAULT_SCHEMA,
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
  const cfg = config({ order: 4, ...patch });
  const engine = new CowBTreeEngine(cfg);
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

/** 只看最后一条命令产生的事件 —— 前面的建表/铺数据不算。 */
function lastCommand(events: SimulationEvent[]): SimulationEvent[] {
  const cmd = events[events.length - 1].cmd;
  return events.filter((e) => e.cmd === cmd);
}

describe('写时复制：改一行要复制整条路径', () => {
  it('单条写复制的页数正好等于树高', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 1 },
      { kind: 'insert', key: 7, row: { id: 7, name: 'x', city: 'Xian', score: 1 } },
    ]);
    const copies = eventsOf(lastCommand(events), 'COW_COPY');
    expect(engine.treeHeight()).toBeGreaterThan(1);
    expect(copies).toHaveLength(engine.treeHeight());
    // 从根开始，一层一层往下
    const levels = copies.map((c) => c.level);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
  });

  it('同一个写事务里同一页只复制一次 —— 所以批量写摊薄了开销', () => {
    const one = run([
      create,
      { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 1 },
      { kind: 'insert', key: 3, row: { id: 3, name: 'a', city: 'Xian', score: 1 } },
    ]);
    const perRowSingle = eventsOf(lastCommand(one.events), 'COW_COPY').length;

    const batch = run([create, { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 1 }]);
    const batchCopies = eventsOf(lastCommand(batch.events), 'COW_COPY').length;
    // 20 行只有一个写事务：平均每行复制的页数远小于单条写
    expect(batchCopies / 20).toBeLessThan(perRowSingle);
  });

  it('提交就是翻 meta 页，而且两个槽轮流用', () => {
    const { events } = run([
      create,
      { kind: 'insert', key: 1 },
      { kind: 'insert', key: 2 },
      { kind: 'insert', key: 3 },
    ]);
    const flips = eventsOf(events, 'META_FLIP');
    // 建表 1 次 + 3 次写事务
    expect(flips).toHaveLength(4);
    expect(flips.map((f) => f.slot)).toEqual([0, 1, 0, 1]);
    // 每次翻转都把根换掉（复制过路径，根一定是新页）
    for (const f of flips.slice(1)) expect(f.rootId).not.toBe(f.prevRootId);
  });

  it('提交前旧版本一个字节都没被改过：新根与旧根是两个不同的页', () => {
    const { engine, events } = run([create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }]);
    const commit = eventsOf(events, 'WRITE_TXN_COMMIT').at(-1)!;
    expect(commit.rootId).toBe(engine.currentRoot());
    expect(commit.retiredPages.length).toBeGreaterThan(0);
  });
});

describe('没有叶子链表：范围扫描靠游标栈', () => {
  it('叶子页的 prev/next 永远是空', () => {
    const { engine } = run([create, { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 }]);
    for (const page of Object.values(engine.snapshot().pages)) {
      expect(page.prev).toBeNull();
      expect(page.next).toBeNull();
    }
  });

  it('扫描要沿路径栈回溯，跨的叶子越多回溯越多', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }];
    const short = run([...cmds, { kind: 'range_scan', from: 1, to: 3 }]);
    const long = run([...cmds, { kind: 'range_scan', from: 1, to: 40 }]);
    const shortNote = eventsOf(short.events, 'COMMAND_END').at(-1)!.note!;
    const longNote = eventsOf(long.events, 'COMMAND_END').at(-1)!.note!;
    const hops = (s: string) => Number(/回溯了 (\d+) 次/.exec(s)![1]);
    expect(hops(longNote)).toBeGreaterThan(hops(shortNote));
    expect(longNote).toContain('没有叶子链表');
  });

  it('全表扫描仍然按键序返回全部数据', () => {
    const { engine, events } = run([
      create,
      { kind: 'bulk_insert', count: 30, pattern: 'random', start: 1, max: 200 },
      { kind: 'full_scan' },
    ]);
    const scanned = eventsOf(lastCommand(events), 'SCAN_STEP').map((e) => e.key);
    expect(scanned).toEqual([...scanned].sort((a, b) => a - b));
    expect(scanned).toEqual(engine.allKeys());
  });
});

describe('只读快照：零加锁，看到的是打开那一刻的版本', () => {
  it('读者拿着旧根，之后的写入对它完全不可见', () => {
    const { engine } = run([
      create,
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn' },
    ]);
    const reader = engine.openReaders()[0];
    const before = engine.keysAtRoot(reader.rootId);
    expect(before).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // 换个会话写入新数据
    engine.execute({ kind: 'use_session', session: 'B' });
    engine.execute({ kind: 'insert', key: 99 });
    engine.execute({ kind: 'use_session', session: 'A' });

    // 最新版本有 99，快照里没有 —— 而且快照那棵树一个页都没被动过
    expect(engine.allKeys()).toContain(99);
    expect(engine.keysAtRoot(reader.rootId)).toEqual(before);
  });

  it('读者开着的时候旧页回收不了 —— 这就是长读事务撑爆库的机理', () => {
    const setup: Command[] = [create, { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }];
    const writes: Command[] = Array.from(
      { length: 10 },
      (_, i) => ({ kind: 'insert', key: (i % 12) + 1, row: { id: (i % 12) + 1, name: `v${i}`, city: 'Xian', score: i } }) as Command,
    );

    const withReader = run([...setup, { kind: 'begin_txn' }, ...writes]);
    const withoutReader = run([...setup, ...writes]);

    expect(withReader.engine.retainedPages()).toBeGreaterThan(0);
    expect(withoutReader.engine.retainedPages()).toBe(0);
    // 没有读者时旧页立刻回到空闲表，可以被复用
    expect(withoutReader.engine.reusedPages()).toBeGreaterThan(0);
  });

  it('关掉读者，挂起的页立刻回到空闲表', () => {
    const cmds: Command[] = [
      create,
      { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn' },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'insert', key: i + 1 }) as Command),
    ];
    const held = run(cmds);
    expect(held.engine.retainedPages()).toBeGreaterThan(0);

    const released = run([...cmds, { kind: 'commit_txn' }]);
    expect(released.engine.retainedPages()).toBe(0);
    expect(released.engine.freePages()).toBeGreaterThan(0);
  });

  it('空闲页会被后续写事务复用，页号不会无限增长', () => {
    const cmds: Command[] = [create, { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }];
    for (let i = 0; i < 40; i++) cmds.push({ kind: 'insert', key: (i % 10) + 1 });
    const { engine } = run(cmds);
    expect(engine.reusedPages()).toBeGreaterThan(10);
    // 复用之后总页数保持在一个小常数级别，而不是随写入次数线性增长
    expect(Object.keys(engine.snapshot().pages).length).toBeLessThan(20);
  });
});

describe('正确性：与参考实现逐键比对', () => {
  it('随机读写删之后可见数据与 Map 完全一致', () => {
    const rng = new Rng(4242);
    const cmds: Command[] = [create];
    const reference = new Map<Key, number>();
    for (let i = 0; i < 300; i++) {
      const roll = rng.next();
      const key = rng.int(1, 40);
      if (roll < 0.7) {
        cmds.push({ kind: 'insert', key, row: { id: key, name: `n${i}`, city: 'Xian', score: i % 100 } });
        reference.set(key, i % 100);
      } else if (roll < 0.85) {
        if (reference.has(key)) {
          cmds.push({ kind: 'delete', key });
          reference.delete(key);
        }
      } else {
        cmds.push({ kind: 'search', key });
      }
    }
    const { engine } = run(cmds);
    expect(engine.allKeys()).toEqual([...reference.keys()].sort((a, b) => a - b));
  });
});

describe('reducer 与引擎一致性（写时复制 B+ 树）', () => {
  function workload(seed: number, steps: number): Command[] {
    const rng = new Rng(seed);
    const cmds: Command[] = [create];
    const live = new Set<Key>();
    for (let i = 0; i < steps; i++) {
      const roll = rng.next();
      const key = rng.int(1, 50);
      if (roll < 0.55) {
        cmds.push({ kind: 'insert', key });
        live.add(key);
      } else if (roll < 0.68 && live.has(key)) {
        cmds.push({ kind: 'delete', key });
        live.delete(key);
      } else if (roll < 0.82) {
        cmds.push({ kind: 'search', key });
      } else if (roll < 0.9) {
        cmds.push({ kind: 'range_scan', from: key, to: key + 8 });
      } else if (roll < 0.95) {
        cmds.push({ kind: 'begin_txn' });
      } else {
        cmds.push({ kind: 'commit_txn' });
      }
    }
    return cmds;
  }

  it('重放事件流得到的结构与引擎内部状态逐字段相等', () => {
    const { engine, events, cfg } = run(workload(2026, 260));
    expect(projectStructure(replay(events, cfg))).toEqual(engine.snapshot());
  });

  it('不同阶数下同样一致', () => {
    for (const order of [3, 4, 6, 10]) {
      const { engine, events, cfg } = run(workload(88, 180), { order });
      expect(projectStructure(replay(events, cfg)), `order=${order}`).toEqual(engine.snapshot());
    }
  });

  it('逐事件重放：seq 就是下标，逻辑时钟严格递增', () => {
    const { events, cfg } = run(workload(11, 150));
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
