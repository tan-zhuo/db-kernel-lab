import type { PageId, Tid } from '@dbkl/shared';
import { heapPages, type HeapTupleState, type LabState } from '@dbkl/simulation-core';
import type { TreeLayout } from './layout';

/**
 * 堆文件布局（PostgreSQL 引擎）。
 *
 * 摆位刻意照抄教科书里的那张图：**索引树在上，堆文件在下**。
 * 于是「索引项 → TID → 堆元组」这一跳在 3D 里就是一条从上往下的弧线，
 * 一眼就能看出 PostgreSQL 比 InnoDB 聚簇索引多付了什么。
 *
 * 堆页按块号从左到右、超出宽度就换行 —— 顺序扫描的路径正好是这个阅读顺序。
 */

export interface HeapLayoutOptions {
  /** 单个元组槽的宽度与高度。 */
  slotWidth: number;
  slotHeight: number;
  /** 页内边距。 */
  pad: number;
  /** 页之间的间距。 */
  gapX: number;
  gapY: number;
  /** 一行最多放几个堆页。 */
  columns: number;
  /** 堆文件顶部相对于索引叶子层（y=0）的偏移，负数表示在下方。 */
  offsetY: number;
}

export const DEFAULT_HEAP_LAYOUT: HeapLayoutOptions = {
  slotWidth: 1.15,
  slotHeight: 0.52,
  pad: 0.22,
  gapX: 1.0,
  gapY: 1.2,
  columns: 6,
  offsetY: -4.6,
};

export interface HeapTupleBox {
  pageId: PageId;
  slot: number;
  tuple: HeapTupleState;
  /** 相对世界坐标的中心点。 */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** 该版本当前的语义状态，决定配色。 */
  state: 'live' | 'dead' | 'redirect' | 'unused' | 'aborted';
}

export interface HeapPageBox {
  pageId: PageId;
  blockNo: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  slots: number;
  used: number;
  allVisible: boolean;
  dirty: boolean;
  resident: boolean;
}

/** 版本链的一段：从旧版本指向新版本（t_ctid）。 */
export interface VersionEdge {
  from: Tid;
  to: Tid;
  hot: boolean;
}

export interface HeapLayout {
  pages: HeapPageBox[];
  byPage: Map<PageId, HeapPageBox>;
  tuples: HeapTupleBox[];
  tupleAt: Map<string, HeapTupleBox>;
  versionEdges: VersionEdge[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const EMPTY_BOUNDS = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

export function layoutHeap(
  state: LabState,
  treeLayout: TreeLayout,
  options: Partial<HeapLayoutOptions> = {},
): HeapLayout {
  const opt = { ...DEFAULT_HEAP_LAYOUT, ...options };
  const pages = heapPages(state);
  if (pages.length === 0) {
    return { pages: [], byPage: new Map(), tuples: [], tupleAt: new Map(), versionEdges: [], bounds: EMPTY_BOUNDS };
  }

  // 页宽由「行指针容量」决定：一眼看出这一页还剩几个空槽。
  const maxSlots = Math.max(1, ...pages.map((p) => p.heap?.slots ?? 1));
  const pageWidth = maxSlots * opt.slotWidth + opt.pad * 2;
  const pageHeight = opt.slotHeight + opt.pad * 2;

  const columns = Math.max(1, Math.min(opt.columns, pages.length));
  const rows = Math.ceil(pages.length / columns);
  const totalWidth = columns * pageWidth + (columns - 1) * opt.gapX;
  // 与索引树共用横向中心，弧线才不会横跨整个场景。
  const centerX = (treeLayout.bounds.minX + treeLayout.bounds.maxX) / 2;
  const startX = centerX - totalWidth / 2;
  const topY = opt.offsetY;

  const boxes: HeapPageBox[] = [];
  const byPage = new Map<PageId, HeapPageBox>();
  const tuples: HeapTupleBox[] = [];
  const tupleAt = new Map<string, HeapTupleBox>();
  const versionEdges: VersionEdge[] = [];

  pages.forEach((page, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = startX + col * (pageWidth + opt.gapX) + pageWidth / 2;
    const y = topY - row * (pageHeight + opt.gapY);
    const heap = page.heap!;
    const used = heap.tuples.filter((t) => t.lp !== 'unused').length;

    const box: HeapPageBox = {
      pageId: page.id,
      blockNo: heap.blockNo,
      x,
      y,
      z: 0,
      width: pageWidth,
      height: pageHeight,
      slots: heap.slots,
      used,
      allVisible: heap.allVisible,
      dirty: page.dirty,
      resident: page.resident,
    };
    boxes.push(box);
    byPage.set(page.id, box);

    heap.tuples.forEach((tuple, slot) => {
      const tx = x - pageWidth / 2 + opt.pad + opt.slotWidth * (slot + 0.5);
      const tupleBox: HeapTupleBox = {
        pageId: page.id,
        slot,
        tuple,
        x: tx,
        y,
        z: 0.12,
        width: opt.slotWidth * 0.86,
        height: opt.slotHeight * 0.82,
        state: tupleState(tuple),
      };
      tuples.push(tupleBox);
      tupleAt.set(tidKey(page.id, slot), tupleBox);
      if (tuple.next) versionEdges.push({ from: { pageId: page.id, slot }, to: tuple.next, hot: tuple.hot });
    });
  });

  return {
    pages: boxes,
    byPage,
    tuples,
    tupleAt,
    versionEdges,
    bounds: {
      minX: startX,
      maxX: startX + totalWidth,
      minY: topY - (rows - 1) * (pageHeight + opt.gapY) - pageHeight / 2,
      maxY: topY + pageHeight / 2,
    },
  };
}

/**
 * 元组版本的语义状态。
 *
 * 注意「dead」在这里指**已被打上 xmax**，而不是「可以被回收」——
 * 后者还要看有没有更老的事务还能看见它，那是 VACUUM 的判断。
 */
function tupleState(t: HeapTupleState): HeapTupleBox['state'] {
  if (t.lp === 'unused') return 'unused';
  if (t.lp === 'redirect') return 'redirect';
  if (t.lp === 'dead') return 'dead';
  if (t.xmax !== null) return 'dead';
  return 'live';
}

export function tidKey(pageId: PageId, slot: number): string {
  return `${pageId}:${slot}`;
}
