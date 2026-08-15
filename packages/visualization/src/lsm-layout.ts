import type { Key } from '@dbkl/shared';
import type { LsmState, SstState } from '@dbkl/simulation-core';

/**
 * LSM 层级布局。
 *
 * 关键设计：**横轴就是键空间**。
 * 每个 SST 的左右边界 = 它的 [minKey, maxKey] 映射到同一条横轴上，
 * 于是「leveled 压实保证层内不重叠」和「L0 文件互相重叠」变成肉眼可见的几何事实，
 * 而不是一句要背下来的结论。
 *
 * 纵轴从上到下是 MemTable → L0 → L1 → …，正好是读取时的探测顺序。
 */

export interface LsmLayoutOptions {
  /** 键空间映射到的总宽度。 */
  width: number;
  /** 每层的垂直间距。 */
  levelGap: number;
  /** 砖块高度与厚度。 */
  brickHeight: number;
  brickDepth: number;
  /** 同层砖块之间的最小可见宽度（键区间很窄的文件也要看得见）。 */
  minBrickWidth: number;
  /** MemTable 与 L0 之间的额外间距。 */
  memtableGap: number;
}

export const DEFAULT_LSM_LAYOUT: LsmLayoutOptions = {
  width: 26,
  levelGap: 2.6,
  brickHeight: 0.85,
  brickDepth: 1.1,
  minBrickWidth: 0.55,
  memtableGap: 1.8,
};

export interface SstBrick {
  id: string;
  level: number;
  /** L0 内部会堆叠，用这个下标决定 z 方向的错开。 */
  slotInLevel: number;
  minKey: Key;
  maxKey: Key;
  entries: number;
  tombstones: number;
  bytes: number;
  compacting: boolean;
  createdAtSeq: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface MemtableBox {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  entries: number;
  limit: number;
  tombstones: number;
  /** 已冻结、等待刷盘的 MemTable 数量。 */
  frozen: number;
}

export interface LsmLayout {
  memtable: MemtableBox;
  bricks: SstBrick[];
  byId: Map<string, SstBrick>;
  /** 每层的标题信息，用于场景里的文字标签。 */
  levels: { level: number; y: number; files: number; entries: number; capacity: number }[];
  keyRange: { min: Key; max: Key };
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export function layoutLsm(
  l: LsmState,
  options: Partial<LsmLayoutOptions> & { levelCapacity?: (level: number) => number } = {},
): LsmLayout {
  const opt = { ...DEFAULT_LSM_LAYOUT, ...options };
  const capacityOf = options.levelCapacity ?? (() => 0);

  // 全局键区间：所有 SST 与 MemTable 的并集，保证横轴对齐。
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sst of Object.values(l.ssts)) {
    min = Math.min(min, sst.minKey);
    max = Math.max(max, sst.maxKey);
  }
  for (const e of l.memtable.entries) {
    min = Math.min(min, e.key);
    max = Math.max(max, e.key);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max === min) max = min + 1;

  const span = max - min;
  const toX = (key: Key) => (-opt.width / 2) + ((key - min) / span) * opt.width;

  const topY = 0;
  const memtable: MemtableBox = {
    x: 0,
    y: topY,
    z: 0,
    width: opt.width,
    height: opt.brickHeight * 1.25,
    depth: opt.brickDepth,
    entries: l.memtable.entries.length,
    limit: l.memtable.limit,
    tombstones: l.memtable.entries.filter((e) => e.tombstone).length,
    frozen: l.immutable.length,
  };

  const bricks: SstBrick[] = [];
  const byId = new Map<string, SstBrick>();
  const levels: LsmLayout['levels'] = [];
  let minY = topY;

  l.levels.forEach((ids, level) => {
    const y = topY - opt.memtableGap - level * opt.levelGap - opt.brickHeight;
    minY = Math.min(minY, y);
    const ssts = ids.map((id) => l.ssts[id]).filter((s): s is SstState => !!s);
    levels.push({
      level,
      y,
      files: ssts.length,
      entries: ssts.reduce((n, s) => n + s.entries.length, 0),
      capacity: capacityOf(level),
    });

    ssts.forEach((sst, i) => {
      const left = toX(sst.minKey);
      const right = toX(sst.maxKey);
      const width = Math.max(opt.minBrickWidth, right - left);
      const brick: SstBrick = {
        id: sst.id,
        level,
        slotInLevel: i,
        minKey: sst.minKey,
        maxKey: sst.maxKey,
        entries: sst.entries.length,
        tombstones: sst.entries.filter((e) => e.tombstone).length,
        bytes: sst.bytes,
        compacting: sst.compacting,
        createdAtSeq: sst.createdAtSeq,
        x: left + width / 2,
        y,
        // L0 的文件区间会重叠，靠 z 轴错开才看得清「叠了几层」。
        z: level === 0 ? -i * (opt.brickDepth * 0.55) : 0,
        width,
        height: opt.brickHeight,
        depth: opt.brickDepth,
      };
      bricks.push(brick);
      byId.set(sst.id, brick);
    });
  });

  return {
    memtable,
    bricks,
    byId,
    levels,
    keyRange: { min, max },
    bounds: {
      minX: -opt.width / 2,
      maxX: opt.width / 2,
      minY: minY - opt.brickHeight,
      maxY: topY + memtable.height,
    },
  };
}
