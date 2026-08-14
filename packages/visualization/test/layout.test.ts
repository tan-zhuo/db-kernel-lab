import { describe, expect, it } from 'vitest';
import {
  BTreeEngine,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_SCHEMA,
  replay,
  type Command,
  type EngineConfig,
  type LabState,
  type SimulationEvent,
} from '@dbkl/simulation-core';
import { DEFAULT_LAYOUT, HighlightTracker, highlightsForEvent, layoutTree, slotOffsetX } from '../src';

function build(patch: Partial<EngineConfig>, commands: Command[]): { state: LabState; events: SimulationEvent[] } {
  const config = { ...DEFAULT_ENGINE_CONFIG, ...patch };
  const engine = new BTreeEngine(config);
  const events: SimulationEvent[] = [];
  events.push(...engine.execute({ kind: 'create_table', schema: DEFAULT_SCHEMA }));
  for (const c of commands) events.push(...engine.execute(c));
  return { state: replay(events, config), events };
}

describe('B+ 树 3D 布局', () => {
  it('每个页都有一个布局节点，且同层不重叠', () => {
    const { state } = build({ order: 4 }, [{ kind: 'bulk_insert', count: 60, pattern: 'sequential', start: 1 }]);
    const layout = layoutTree(state);
    expect(layout.nodes).toHaveLength(Object.keys(state.pages).length);

    const byLevel = new Map<number, typeof layout.nodes>();
    for (const n of layout.nodes) {
      const list = byLevel.get(n.level) ?? [];
      list.push(n);
      byLevel.set(n.level, list);
    }
    for (const [, list] of byLevel) {
      const sorted = [...list].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].x - sorted[i].width / 2 - (sorted[i - 1].x + sorted[i - 1].width / 2);
        expect(gap, `level ${sorted[i].level} 页 #${sorted[i].id} 与前一页重叠`).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });

  it('叶子按键序从左到右排列，内部页位于子页跨度之上', () => {
    const { state } = build({ order: 5 }, [{ kind: 'bulk_insert', count: 40, pattern: 'random', max: 200 }]);
    const layout = layoutTree(state);

    const leaves = layout.nodes.filter((n) => n.type === 'leaf');
    for (let i = 1; i < leaves.length; i++) {
      const prevMax = Math.max(...state.pages[leaves[i - 1].id].keys);
      const curMin = Math.min(...state.pages[leaves[i].id].keys);
      if (Number.isFinite(prevMax) && Number.isFinite(curMin)) {
        expect(prevMax, '左边的叶子页键更小').toBeLessThan(curMin);
      }
    }

    for (const n of layout.nodes.filter((x) => x.type === 'internal')) {
      const children = state.pages[n.id].children.map((c) => layout.byId.get(c)!).filter(Boolean);
      const min = Math.min(...children.map((c) => c.x));
      const max = Math.max(...children.map((c) => c.x));
      expect(n.x).toBeGreaterThanOrEqual(min - 1e-6);
      expect(n.x).toBeLessThanOrEqual(max + 1e-6);
      expect(n.y).toBeGreaterThan(children[0].y);
    }
  });

  it('边覆盖所有父子指针与叶子链表', () => {
    const { state } = build({ order: 4 }, [{ kind: 'bulk_insert', count: 25, pattern: 'sequential', start: 1 }]);
    const layout = layoutTree(state);
    const childEdges = layout.edges.filter((e) => e.kind === 'child');
    const siblingEdges = layout.edges.filter((e) => e.kind === 'sibling');
    const expectedChildren = Object.values(state.pages).reduce((n, p) => n + p.children.length, 0);
    const expectedSiblings = Object.values(state.pages).filter((p) => p.type === 'leaf' && p.next !== null).length;
    expect(childEdges).toHaveLength(expectedChildren);
    expect(siblingEdges).toHaveLength(expectedSiblings);
  });

  it('空树（仅根叶子页）也能布局', () => {
    const { state } = build({ order: 4 }, []);
    const layout = layoutTree(state);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].x).toBeCloseTo(0);
  });

  it('槽位偏移在页宽内均匀分布', () => {
    const capacity = 5;
    const offsets = Array.from({ length: capacity }, (_, i) => slotOffsetX(i, capacity));
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] - offsets[i - 1]).toBeCloseTo(DEFAULT_LAYOUT.slotWidth);
    }
    expect(offsets[0]).toBeCloseTo(-offsets[offsets.length - 1]);
  });
});

describe('高亮映射', () => {
  it('结构性事件点亮相关的两个页', () => {
    const { events } = build({ order: 4 }, [{ kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }]);
    const split = events.find((e) => e.type === 'PAGE_SPLIT');
    expect(split).toBeTruthy();
    const hl = highlightsForEvent(split!);
    expect(hl).toHaveLength(2);
    expect(hl.every((h) => h.kind === 'split')).toBe(true);
  });

  it('高亮会随时间衰减，回退时可整体清空', () => {
    const { events } = build({ order: 4 }, [{ kind: 'insert', key: 1 }]);
    const tracker = new HighlightTracker();
    const insert = events.find((e) => e.type === 'RECORD_INSERT')!;
    tracker.ingest([insert], 1000);
    const at = insert.type === 'RECORD_INSERT' ? insert.pageId : 0;
    expect(tracker.page(at, 1000)?.[1]).toBeCloseTo(1);
    expect(tracker.page(at, 1450)?.[1]).toBeLessThan(1);
    expect(tracker.page(at, 5000)).toBeNull();

    tracker.ingest([insert], 6000);
    expect(tracker.page(at, 6000)).not.toBeNull();
    tracker.clear();
    expect(tracker.page(at, 6000)).toBeNull();
  });

  it('分裂高亮不会被随后的路径高亮覆盖', () => {
    const tracker = new HighlightTracker();
    const base = { seq: 0, t: 0, cmd: 1 };
    tracker.ingest(
      [
        {
          ...base,
          type: 'PAGE_SPLIT',
          pageId: 1,
          newPageId: 2,
          promotedKey: 5,
          pageType: 'leaf',
          moved: { keys: [5] },
          triggerKey: 5,
          fillFactor: 0.5,
        },
        { ...base, seq: 1, type: 'PAGE_READ', pageId: 1, purpose: 'search' },
      ],
      100,
    );
    expect(tracker.page(1, 100)?.[0]).toBe('split');
  });
});
