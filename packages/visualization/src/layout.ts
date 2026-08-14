import type { PageId, PageType } from '@dbkl/shared';
import { orderedIndexes, pageCapacity, type IndexState, type LabState } from '@dbkl/simulation-core';

export interface LayoutOptions {
  /** 单个槽位的宽度。 */
  slotWidth: number;
  /** 页盒子的高度与厚度。 */
  pageHeight: number;
  pageDepth: number;
  /** 页左右内边距。 */
  padX: number;
  /** 同层相邻页之间的最小间距。 */
  siblingGap: number;
  /** 层与层之间的垂直距离。 */
  levelGap: number;
  /** 两棵索引树之间的水平间距。 */
  indexGap: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  slotWidth: 0.62,
  pageHeight: 0.5,
  pageDepth: 0.9,
  padX: 0.22,
  siblingGap: 1.1,
  levelGap: 3.4,
  indexGap: 7,
};

export interface LayoutNode {
  id: PageId;
  indexId: string;
  type: PageType;
  level: number;
  parentId: PageId | null;
  /** 是否是所属索引的根页。 */
  isRoot: boolean;
  /** 页盒子中心坐标。 */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  /** 槽位容量与已用槽位。 */
  capacity: number;
  used: number;
  fill: number;
  /** 稳定的绘制下标（用于 InstancedMesh 的实例槽）。 */
  index: number;
  /** 该页在其所在层中的次序。 */
  rank: number;
}

export type EdgeKind = 'child' | 'sibling';

export interface LayoutEdge {
  from: PageId;
  to: PageId;
  kind: EdgeKind;
  /** 父页中该子指针对应的槽位（用于把连线从具体槽位下方引出）。 */
  fromSlot: number;
}

/** 一棵索引树在场景中的占位，用于画标题与分区。 */
export interface LayoutGroup {
  indexId: string;
  name: string;
  column: string;
  clustered: boolean;
  minX: number;
  maxX: number;
  centerX: number;
  topY: number;
  pages: number;
}

export interface TreeLayout {
  nodes: LayoutNode[];
  byId: Map<PageId, LayoutNode>;
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  levels: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** 槽位总数（InstancedMesh 需要预分配）。 */
  totalSlots: number;
}

/**
 * 多索引 B+ 树森林布局。
 *
 * 每棵索引树独立布局后横向并排（聚簇索引在最左），这样「二级索引 → 回表」
 * 就能画成一条跨树的连线。单棵树内部：叶子层水平铺开、内部页居中于子页跨度之上、
 * 同层做一次左到右的推挤消重叠。
 *
 * 复杂度 O(n log n)（每层一次排序），n 为页数。
 */
export function layoutTree(state: LabState, options: Partial<LayoutOptions> = {}): TreeLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  const capacity = pageCapacity(state.config);
  const width = capacity * opt.slotWidth + opt.padX * 2;

  const nodes: LayoutNode[] = [];
  const byId = new Map<PageId, LayoutNode>();
  const groups: LayoutGroup[] = [];
  const placed = new Set<PageId>();

  let cursorX = 0;
  let maxLevelAll = 0;

  for (const ix of orderedIndexes(state)) {
    const start = cursorX;
    const created = layoutIndex(state, ix, opt, width, capacity, cursorX, nodes, byId, placed);
    if (created.count === 0) continue;
    groups.push({
      indexId: ix.id,
      name: ix.name,
      column: ix.column,
      clustered: ix.clustered,
      minX: start,
      maxX: created.maxX,
      centerX: (start + created.maxX) / 2,
      topY: created.topY,
      pages: created.count,
    });
    maxLevelAll = Math.max(maxLevelAll, created.maxLevel);
    cursorX = created.maxX + opt.indexGap;
  }

  // 尚未挂到任何索引上的页（分裂动画中间态）也要渲染出来。
  for (const key in state.pages) {
    const p = state.pages[key];
    if (placed.has(p.id)) continue;
    const node = makeNode(p.id, state, opt, width, capacity, cursorX + width / 2, p.level * opt.levelGap, false);
    nodes.push(node);
    byId.set(p.id, node);
    placed.add(p.id);
    cursorX += width + opt.siblingGap;
  }

  // 整体居中 + 序号
  const xs = nodes.map((n) => n.x);
  const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const perLevelRank = new Map<string, number>();
  nodes.sort((a, b) => (a.level === b.level ? a.x - b.x : a.level - b.level));
  nodes.forEach((n, i) => {
    n.x -= centerX;
    n.index = i;
    const rankKey = `${n.indexId}:${n.level}`;
    const rank = perLevelRank.get(rankKey) ?? 0;
    n.rank = rank;
    perLevelRank.set(rankKey, rank + 1);
    minX = Math.min(minX, n.x - n.width / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  });
  for (const g of groups) {
    g.minX -= centerX;
    g.maxX -= centerX;
    g.centerX -= centerX;
  }

  // 边：父子指针 + 叶子链表
  const edges: LayoutEdge[] = [];
  for (const n of nodes) {
    const p = state.pages[n.id];
    if (!p) continue;
    if (p.type === 'internal') {
      p.children.forEach((childId, slot) => {
        if (byId.has(childId)) edges.push({ from: n.id, to: childId, kind: 'child', fromSlot: slot });
      });
    } else if (p.next !== null && byId.has(p.next)) {
      edges.push({ from: n.id, to: p.next, kind: 'sibling', fromSlot: -1 });
    }
  }

  return {
    nodes,
    byId,
    edges,
    groups,
    levels: maxLevelAll + 1,
    bounds: {
      minX: Number.isFinite(minX) ? minX : -1,
      maxX: Number.isFinite(maxX) ? maxX : 1,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 1,
    },
    totalSlots: nodes.length * capacity,
  };
}

function layoutIndex(
  state: LabState,
  ix: IndexState,
  opt: LayoutOptions,
  width: number,
  capacity: number,
  startX: number,
  nodes: LayoutNode[],
  byId: Map<PageId, LayoutNode>,
  placed: Set<PageId>,
): { count: number; maxX: number; maxLevel: number; topY: number } {
  if (ix.rootId === null || !state.pages[ix.rootId]) return { count: 0, maxX: startX, maxLevel: 0, topY: 0 };

  // 深度优先确定左右次序（比依赖叶子链表更稳健：分裂中间态也能画）
  const order: PageId[] = [];
  const guard = new Set<PageId>();
  const visit = (id: PageId): void => {
    if (guard.has(id)) return;
    guard.add(id);
    const p = state.pages[id];
    if (!p) return;
    if (p.type === 'internal') for (const c of p.children) visit(c);
    order.push(id);
  };
  visit(ix.rootId);

  let cursorX = startX;
  const created: LayoutNode[] = [];

  // 叶子层等距排布
  for (const id of order) {
    const p = state.pages[id];
    if (!p || p.type !== 'leaf') continue;
    const node = makeNode(id, state, opt, width, capacity, cursorX + width / 2, 0, id === ix.rootId);
    created.push(node);
    nodes.push(node);
    byId.set(id, node);
    placed.add(id);
    cursorX += width + opt.siblingGap;
  }

  // 自底向上放置内部页：居中于子页跨度
  const maxLevel = order.reduce((mx, id) => Math.max(mx, state.pages[id]?.level ?? 0), 0);
  for (let level = 1; level <= maxLevel; level++) {
    for (const id of order) {
      const p = state.pages[id];
      if (!p || p.level !== level) continue;
      const childNodes = p.children.map((c) => byId.get(c)).filter((n): n is LayoutNode => !!n);
      const x =
        childNodes.length > 0
          ? (Math.min(...childNodes.map((c) => c.x)) + Math.max(...childNodes.map((c) => c.x))) / 2
          : cursorX + width / 2;
      const node = makeNode(id, state, opt, width, capacity, x, level * opt.levelGap, id === ix.rootId);
      created.push(node);
      nodes.push(node);
      byId.set(id, node);
      placed.add(id);
    }
    // 同层消重叠（保持相对次序）
    const levelNodes = created.filter((n) => n.level === level).sort((a, b) => a.x - b.x);
    for (let i = 1; i < levelNodes.length; i++) {
      const prev = levelNodes[i - 1];
      const cur = levelNodes[i];
      const min = prev.x + prev.width / 2 + opt.siblingGap + cur.width / 2;
      if (cur.x < min) cur.x = min;
    }
  }

  const maxX = Math.max(...created.map((n) => n.x + n.width / 2));
  return { count: created.length, maxX, maxLevel, topY: maxLevel * opt.levelGap };
}

function makeNode(
  id: PageId,
  state: LabState,
  opt: LayoutOptions,
  width: number,
  capacity: number,
  x: number,
  y: number,
  isRoot: boolean,
): LayoutNode {
  const p = state.pages[id];
  return {
    id,
    indexId: p.indexId,
    type: p.type,
    level: p.level,
    parentId: p.parentId,
    isRoot,
    x,
    y,
    z: 0,
    width,
    height: opt.pageHeight,
    depth: opt.pageDepth,
    capacity,
    used: p.keys.length,
    fill: p.keys.length / capacity,
    index: 0,
    rank: 0,
  };
}

/** 页内第 slot 个槽位相对于页中心的局部 x 偏移。 */
export function slotOffsetX(slot: number, capacity: number, opt: LayoutOptions = DEFAULT_LAYOUT): number {
  const inner = capacity * opt.slotWidth;
  return -inner / 2 + opt.slotWidth * (slot + 0.5);
}
