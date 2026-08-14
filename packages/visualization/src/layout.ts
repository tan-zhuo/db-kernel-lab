import type { PageId, PageType } from '@dbkl/shared';
import { pageCapacity, type LabState } from '@dbkl/simulation-core';

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
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  slotWidth: 0.62,
  pageHeight: 0.5,
  pageDepth: 0.9,
  padX: 0.22,
  siblingGap: 1.1,
  levelGap: 3.4,
};

export interface LayoutNode {
  id: PageId;
  type: PageType;
  level: number;
  parentId: PageId | null;
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

export interface TreeLayout {
  nodes: LayoutNode[];
  byId: Map<PageId, LayoutNode>;
  edges: LayoutEdge[];
  levels: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** 槽位总数（InstancedMesh 需要预分配）。 */
  totalSlots: number;
}

/**
 * B+ 树 3D 布局。
 *
 * 叶子层按叶子链表 / 深度优先顺序水平铺开，内部页居中于其子页跨度之上；
 * 同层做一次左到右的推挤消重叠，再整体居中到原点。
 *
 * 复杂度 O(n log n)（每层一次排序），n 为页数。
 */
export function layoutTree(state: LabState, options: Partial<LayoutOptions> = {}): TreeLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  const capacity = pageCapacity(state.config);
  const nodes: LayoutNode[] = [];
  const byId = new Map<PageId, LayoutNode>();
  const edges: LayoutEdge[] = [];

  const widthOf = (): number => capacity * opt.slotWidth + opt.padX * 2;

  // 1) 深度优先确定左右次序（比依赖叶子链表更稳健：分裂中间态也能画）。
  const order: PageId[] = [];
  const visit = (id: PageId, guard: Set<PageId>): void => {
    if (guard.has(id)) return;
    guard.add(id);
    const p = state.pages[id];
    if (!p) return;
    if (p.type === 'internal') {
      for (const c of p.children) visit(c, guard);
    }
    order.push(id);
  };
  const guard = new Set<PageId>();
  if (state.rootId !== null) visit(state.rootId, guard);
  // 尚未挂上父页的新页（分裂动画的中间帧）也要渲染出来。
  for (const key in state.pages) {
    const id = state.pages[key].id;
    if (!guard.has(id)) order.push(id);
  }

  // 2) 叶子层等距排布。
  let cursorX = 0;
  const leafOrder = order.filter((id) => state.pages[id]?.type === 'leaf');
  for (const id of leafOrder) {
    const p = state.pages[id];
    const w = widthOf();
    const node: LayoutNode = {
      id,
      type: p.type,
      level: p.level,
      parentId: p.parentId,
      x: cursorX + w / 2,
      y: 0,
      z: 0,
      width: w,
      height: opt.pageHeight,
      depth: opt.pageDepth,
      capacity,
      used: p.keys.length,
      fill: p.keys.length / capacity,
      index: 0,
      rank: 0,
    };
    nodes.push(node);
    byId.set(id, node);
    cursorX += w + opt.siblingGap;
  }

  // 3) 自底向上放置内部页：居中于子页跨度。
  const maxLevel = Object.values(state.pages).reduce((mx, p) => Math.max(mx, p.level), 0);
  for (let level = 1; level <= maxLevel; level++) {
    const idsAtLevel = order.filter((id) => state.pages[id]?.level === level);
    for (const id of idsAtLevel) {
      const p = state.pages[id];
      const childNodes = p.children.map((c) => byId.get(c)).filter((n): n is LayoutNode => !!n);
      const w = widthOf();
      const x =
        childNodes.length > 0
          ? (Math.min(...childNodes.map((c) => c.x)) + Math.max(...childNodes.map((c) => c.x))) / 2
          : cursorX + w / 2;
      const node: LayoutNode = {
        id,
        type: p.type,
        level,
        parentId: p.parentId,
        x,
        y: level * opt.levelGap,
        z: 0,
        width: w,
        height: opt.pageHeight,
        depth: opt.pageDepth,
        capacity,
        used: p.keys.length,
        fill: p.keys.length / capacity,
        index: 0,
        rank: 0,
      };
      nodes.push(node);
      byId.set(id, node);
    }
    // 同层消重叠（保持相对次序）。
    const levelNodes = nodes.filter((n) => n.level === level).sort((a, b) => a.x - b.x);
    for (let i = 1; i < levelNodes.length; i++) {
      const prev = levelNodes[i - 1];
      const cur = levelNodes[i];
      const minX = prev.x + prev.width / 2 + opt.siblingGap + cur.width / 2;
      if (cur.x < minX) cur.x = minX;
    }
  }

  // 4) 整体居中 + 记录序号。
  const xs = nodes.map((n) => n.x);
  const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const perLevelRank = new Map<number, number>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  nodes.sort((a, b) => (a.level === b.level ? a.x - b.x : a.level - b.level));
  nodes.forEach((n, i) => {
    n.x -= centerX;
    n.index = i;
    const rank = perLevelRank.get(n.level) ?? 0;
    n.rank = rank;
    perLevelRank.set(n.level, rank + 1);
    minX = Math.min(minX, n.x - n.width / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  });

  // 5) 边：父子指针 + 叶子链表。
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
    levels: maxLevel + 1,
    bounds: {
      minX: Number.isFinite(minX) ? minX : -1,
      maxX: Number.isFinite(maxX) ? maxX : 1,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 1,
    },
    totalSlots: nodes.length * capacity,
  };
}

/** 页内第 slot 个槽位相对于页中心的局部 x 偏移。 */
export function slotOffsetX(slot: number, capacity: number, opt: LayoutOptions = DEFAULT_LAYOUT): number {
  const inner = capacity * opt.slotWidth;
  return -inner / 2 + opt.slotWidth * (slot + 0.5);
}
