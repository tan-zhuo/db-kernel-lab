import type { PageId } from '@dbkl/shared';
import type { CowState } from '@dbkl/simulation-core';
import type { TreeLayout } from './layout';

/**
 * 写时复制 B+ 树的**附加层**布局。
 *
 * 树本身仍由 `layoutTree` 画（写时复制的树结构就是一棵普通 B+ 树），
 * 这里只补上它独有的三样东西 —— 而这三样正好就是它与 InnoDB 的全部差别：
 *
 *  1. **两个 meta 页**悬在树顶。亮着的那个就是「当前版本」，
 *     提交时亮的那个换一边 —— 一次翻转就是一次提交，没有 WAL；
 *  2. **空闲表**在右侧堆成一摞。它不是"删掉的数据"，
 *     而是"上一个版本腾出来的位置"，下一个写事务会直接拿来用；
 *  3. **只读快照**挂在左侧，每个读者一条线指回它钉住的那个旧根。
 *     被钉住的页在空闲表旁边单独堆一摞 —— 读者不放手，这摞就只涨不落。
 */

export interface CowLayoutOptions {
  metaWidth: number;
  metaHeight: number;
  metaDepth: number;
  metaGap: number;
  /** meta 页悬在树顶多高。 */
  metaLift: number;
  pageSize: number;
  pageGap: number;
  /** 空闲表 / 挂起堆每列放几个。 */
  stackRows: number;
  sideGap: number;
  readerWidth: number;
  readerHeight: number;
  readerGap: number;
}

export const DEFAULT_COW_LAYOUT: CowLayoutOptions = {
  metaWidth: 2.6,
  metaHeight: 1.1,
  metaDepth: 0.9,
  metaGap: 0.9,
  metaLift: 3.2,
  pageSize: 0.44,
  pageGap: 0.12,
  stackRows: 6,
  sideGap: 3.4,
  readerWidth: 2.4,
  readerHeight: 0.8,
  readerGap: 0.45,
};

export interface MetaBox {
  slot: 0 | 1;
  active: boolean;
  txnId: number;
  rootId: PageId | null;
  height: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height3d: number;
  depth: number;
}

export interface SmallPageBox {
  pageId: PageId;
  /** 'free' = 可以马上复用；'pinned' = 被读者钉着，回收不了。 */
  kind: 'free' | 'pinned';
  x: number;
  y: number;
  z: number;
  size: number;
}

export interface ReaderBox {
  id: string;
  txnId: number;
  rootId: PageId;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export interface CowLayout {
  metas: MetaBox[];
  /** 当前 meta → 当前根的连线（提交后指向新根的那一条）。 */
  rootLink: { from: [number, number, number]; to: [number, number, number] } | null;
  freePages: SmallPageBox[];
  pinnedPages: SmallPageBox[];
  readers: ReaderBox[];
  /** 每个读者 → 它钉住的旧根。旧根已经不在树上时为 null。 */
  readerLinks: { from: [number, number, number]; to: [number, number, number] }[];
  /** 本次写事务复制出来的页（用于高亮）。 */
  copiedPages: Set<PageId>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const EMPTY: CowLayout = {
  metas: [],
  rootLink: null,
  freePages: [],
  pinnedPages: [],
  readers: [],
  readerLinks: [],
  copiedPages: new Set(),
  bounds: { minX: -1, maxX: 1, minY: 0, maxY: 1 },
};

export function layoutCow(c: CowState, tree: TreeLayout, options: Partial<CowLayoutOptions> = {}): CowLayout {
  const opt = { ...DEFAULT_COW_LAYOUT, ...options };
  if (c.meta.length === 0) return EMPTY;

  const centerX = (tree.bounds.minX + tree.bounds.maxX) / 2;
  const topY = tree.bounds.maxY + opt.metaLift;

  // —— 两个 meta 页并排悬在树顶 ——
  const totalW = opt.metaWidth * 2 + opt.metaGap;
  const metas: MetaBox[] = c.meta.slice(0, 2).map((m, i) => ({
    slot: i as 0 | 1,
    active: c.metaSlot === i,
    txnId: m.txnId,
    rootId: m.rootId,
    height: m.height,
    x: centerX - totalW / 2 + i * (opt.metaWidth + opt.metaGap) + opt.metaWidth / 2,
    y: topY,
    z: 0,
    width: opt.metaWidth,
    height3d: opt.metaHeight,
    depth: opt.metaDepth,
  }));

  // —— 当前 meta 指向当前根 ——
  let rootLink: CowLayout['rootLink'] = null;
  const active = metas[c.metaSlot];
  const rootNode = c.rootId !== null ? tree.byId.get(c.rootId) : undefined;
  if (active && rootNode) {
    rootLink = {
      from: [active.x, active.y - opt.metaHeight / 2, active.z],
      to: [rootNode.x, rootNode.y + rootNode.height / 2, rootNode.z],
    };
  }

  // —— 右侧：空闲表 + 被钉住的挂起页 ——
  const stackX = tree.bounds.maxX + opt.sideGap;
  const step = opt.pageSize + opt.pageGap;
  const stack = (ids: PageId[], kind: 'free' | 'pinned', baseX: number, baseY: number): SmallPageBox[] =>
    ids.map((pageId, i) => ({
      pageId,
      kind,
      x: baseX + Math.floor(i / opt.stackRows) * step,
      y: baseY - (i % opt.stackRows) * step,
      z: 0,
      size: opt.pageSize,
    }));

  const freePages = stack(c.freelist, 'free', stackX, topY - 1.4);
  const pinnedIds = c.pending.flatMap((p) => p.pages);
  const pinnedBaseY = topY - 1.4 - (opt.stackRows + 1.6) * step;
  const pinnedPages = stack(pinnedIds, 'pinned', stackX, pinnedBaseY);

  // —— 左侧：只读快照 ——
  const readerX = tree.bounds.minX - opt.sideGap;
  const readers: ReaderBox[] = c.readers.map((r, i) => ({
    id: r.id,
    txnId: r.txnId,
    rootId: r.rootId,
    x: readerX,
    y: topY - i * (opt.readerHeight + opt.readerGap),
    z: 0,
    width: opt.readerWidth,
    height: opt.readerHeight,
  }));

  const readerLinks: CowLayout['readerLinks'] = [];
  for (const reader of readers) {
    const pinnedRoot = tree.byId.get(reader.rootId);
    if (!pinnedRoot) continue;
    readerLinks.push({
      from: [reader.x + reader.width / 2, reader.y, reader.z],
      to: [pinnedRoot.x - pinnedRoot.width / 2, pinnedRoot.y, pinnedRoot.z],
    });
  }

  const copiedPages = new Set(c.lastPath.map((p) => p.to));
  const stackRight = stackX + Math.max(
    Math.ceil(freePages.length / opt.stackRows),
    Math.ceil(pinnedPages.length / opt.stackRows),
    1,
  ) * step;

  return {
    metas,
    rootLink,
    freePages,
    pinnedPages,
    readers,
    readerLinks,
    copiedPages,
    bounds: {
      minX: Math.min(tree.bounds.minX, readerX - opt.readerWidth / 2) - 1,
      maxX: Math.max(tree.bounds.maxX, stackRight) + 1.6,
      minY: Math.min(tree.bounds.minY, pinnedBaseY - opt.stackRows * step) - 1,
      maxY: topY + opt.metaHeight + 1.6,
    },
  };
}
