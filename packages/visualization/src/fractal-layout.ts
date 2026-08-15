import type { Key, PageId } from '@dbkl/shared';
import type { FractalState } from '@dbkl/simulation-core';
import type { TreeLayout } from './layout';

/**
 * Bε-树的**附加层**布局：给每个内部节点顶上加一条「消息缓冲」。
 *
 * 树本身还是由 `layoutTree` 画的普通 B+ 树 —— 差别全在这条条子上：
 *
 *  - 每个内部节点上方一排小格子 = 它的消息缓冲。格子亮起来的数量就是水位，
 *    快满时变红（下一条就要触发下推）；
 *  - 一条黄色的弧从父节点指向刚被推下去的那个孩子 —— **这就是写放大真正发生的地方**；
 *  - 读的时候被翻过的缓冲会高亮：树高 h 的树，一次点查要翻 h 块。
 *
 * 于是「写只碰根、读要沿路翻」这件事不用讲，看一眼就懂。
 */

export interface FractalLayoutOptions {
  /** 单个消息格子的宽高。 */
  cellWidth: number;
  cellHeight: number;
  cellGap: number;
  /** 缓冲条离节点顶面多高。 */
  lift: number;
  /** 一行最多放几个格子，超过就换行往上堆。 */
  perRow: number;
}

export const DEFAULT_FRACTAL_LAYOUT: FractalLayoutOptions = {
  cellWidth: 0.24,
  cellHeight: 0.2,
  cellGap: 0.06,
  lift: 0.75,
  perRow: 8,
};

export interface BufferCell {
  nodeId: PageId;
  index: number;
  /** 空槽为 null。 */
  key: Key | null;
  op: 'insert' | 'delete' | 'upsert' | null;
  filled: boolean;
  /** 缓冲水位 ≥ 容量时整条变红。 */
  hot: boolean;
  /** 本次读路径翻过这块缓冲。 */
  probed: boolean;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export interface FlushArc {
  from: [number, number, number];
  to: [number, number, number];
  count: number;
  toLeaf: boolean;
}

export interface FractalLayout {
  cells: BufferCell[];
  flush: FlushArc | null;
  /** 每个内部节点的水位（面板与标签用）。 */
  levels: { nodeId: PageId; size: number; capacity: number; probed: boolean }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const EMPTY: FractalLayout = {
  cells: [],
  flush: null,
  levels: [],
  bounds: { minX: -1, maxX: 1, minY: 0, maxY: 1 },
};

export function layoutFractal(
  f: FractalState,
  tree: TreeLayout,
  options: Partial<FractalLayoutOptions> = {},
): FractalLayout {
  const opt = { ...DEFAULT_FRACTAL_LAYOUT, ...options };
  if (tree.nodes.length === 0) return EMPTY;

  const probed = new Set((f.lastProbe?.levels ?? []).map((l) => l.nodeId));
  const cells: BufferCell[] = [];
  const levels: FractalLayout['levels'] = [];
  let maxY = tree.bounds.maxY;

  for (const node of tree.nodes) {
    // 叶子没有缓冲 —— 这正是 Bε-树的结构定义。
    if (node.type !== 'internal') continue;
    const messages = f.buffers[node.id] ?? [];
    const capacity = Math.max(1, f.capacity);
    const slots = Math.max(capacity, messages.length);
    const hot = messages.length >= capacity;
    levels.push({ nodeId: node.id, size: messages.length, capacity: f.capacity, probed: probed.has(node.id) });

    const rowWidth = Math.min(slots, opt.perRow) * (opt.cellWidth + opt.cellGap) - opt.cellGap;
    const startX = node.x - rowWidth / 2;
    const baseY = node.y + node.height / 2 + opt.lift;

    for (let i = 0; i < slots; i++) {
      const row = Math.floor(i / opt.perRow);
      const col = i % opt.perRow;
      const msg = messages[i];
      const y = baseY + row * (opt.cellHeight + opt.cellGap);
      maxY = Math.max(maxY, y + opt.cellHeight);
      cells.push({
        nodeId: node.id,
        index: i,
        key: msg?.key ?? null,
        op: msg?.op ?? null,
        filled: msg !== undefined,
        hot: hot && msg !== undefined,
        probed: probed.has(node.id),
        x: startX + col * (opt.cellWidth + opt.cellGap) + opt.cellWidth / 2,
        y,
        z: node.z,
        width: opt.cellWidth,
        height: opt.cellHeight,
      });
    }
  }

  // —— 最近一次下推：父缓冲 → 子节点 ——
  let flush: FlushArc | null = null;
  if (f.lastFlush) {
    const from = tree.byId.get(f.lastFlush.from);
    const to = tree.byId.get(f.lastFlush.to);
    if (from && to) {
      flush = {
        from: [from.x, from.y + from.height / 2 + opt.lift, from.z],
        to: [to.x, to.y + to.height / 2, to.z],
        count: f.lastFlush.count,
        toLeaf: f.lastFlush.toLeaf,
      };
    }
  }

  return {
    cells,
    flush,
    levels,
    bounds: { minX: tree.bounds.minX, maxX: tree.bounds.maxX, minY: tree.bounds.minY, maxY: maxY + 1.2 },
  };
}
