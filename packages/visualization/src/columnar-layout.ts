import type { Key } from '@dbkl/shared';
import type { ColumnarState, RowGroupState } from '@dbkl/simulation-core';

/**
 * 列存布局 —— 一张**矩阵**。
 *
 * 横轴 = 表的列，纵轴 = 行组。每个格子就是一个「列块」。
 * 于是列存最核心的那句话变成了一眼可见的几何事实：
 *
 *  - 查询只读用到的列 ⇒ 矩阵上只有**几条竖列**亮起来，其余整片是暗的；
 *  - 区间统计整块跳过 ⇒ 对应的**整行**变灰；
 *  - 砖块高度 ∝ 压缩比 ⇒ 哪一列压得动一眼就看出来。
 */

export interface ColumnarLayoutOptions {
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  /** 压缩比映射到**厚度**（朝向观察者）的系数：压得越狠越厚。 */
  baseDepth: number;
  maxDepth: number;
}

export const DEFAULT_COLUMNAR_LAYOUT: ColumnarLayoutOptions = {
  cellWidth: 2.4,
  cellHeight: 1.1,
  gapX: 0.4,
  gapY: 0.35,
  baseDepth: 0.5,
  maxDepth: 3.2,
};

export interface ChunkBox {
  rowGroupId: string;
  column: string;
  encoding: string;
  rows: number;
  rawBytes: number;
  encodedBytes: number;
  /** 压缩比 = 原始 / 编码后。 */
  ratio: number;
  distinct: number;
  minValue: Key | null;
  maxValue: Key | null;
  /** 本次查询是否读了它 / 它所在的行组是否被整块跳过。 */
  read: boolean;
  skipped: boolean;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface RowGroupRow {
  id: string;
  index: number;
  rows: number;
  sealed: boolean;
  skipped: boolean;
  y: number;
  labelX: number;
}

export interface ColumnHeader {
  column: string;
  x: number;
  read: boolean;
}

export interface ColumnarLayout {
  chunks: ChunkBox[];
  rowGroups: RowGroupRow[];
  columns: ColumnHeader[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const EMPTY: ColumnarLayout = {
  chunks: [],
  rowGroups: [],
  columns: [],
  bounds: { minX: -1, maxX: 1, minY: 0, maxY: 1 },
};

export function layoutColumnar(c: ColumnarState, options: Partial<ColumnarLayoutOptions> = {}): ColumnarLayout {
  const opt = { ...DEFAULT_COLUMNAR_LAYOUT, ...options };
  if (c.rowGroups.length === 0 || c.columns.length === 0) return EMPTY;

  const columns = c.columns;
  const totalWidth = columns.length * opt.cellWidth + (columns.length - 1) * opt.gapX;
  const startX = -totalWidth / 2;
  const readColumns = new Set(c.lastScan?.columnsRead ?? []);

  const headers: ColumnHeader[] = columns.map((column, i) => ({
    column,
    x: startX + i * (opt.cellWidth + opt.gapX) + opt.cellWidth / 2,
    read: readColumns.has(column),
  }));

  const chunks: ChunkBox[] = [];
  const rowGroups: RowGroupRow[] = [];
  // 行组从上往下排，形成一张**正对镜头**的矩阵（比往纵深里堆好读得多）。
  c.rowGroups.forEach((group: RowGroupState, gi) => {
    const y = -gi * (opt.cellHeight + opt.gapY);
    rowGroups.push({
      id: group.id,
      index: group.index,
      rows: group.rows,
      sealed: group.sealed,
      skipped: group.skipped,
      y,
      labelX: startX - 2.4,
    });

    headers.forEach((header) => {
      const chunk = group.chunks[header.column];
      if (!chunk) return;
      const ratio = chunk.encodedBytes === 0 ? 1 : chunk.rawBytes / chunk.encodedBytes;
      // 压得越狠砖越**厚**（朝观察者凸出来）—— 厚度直接就是「省了多少」。
      const depth = Math.min(opt.maxDepth, opt.baseDepth * Math.max(1, ratio));
      chunks.push({
        rowGroupId: group.id,
        column: header.column,
        encoding: chunk.encoding,
        rows: chunk.rows,
        rawBytes: chunk.rawBytes,
        encodedBytes: chunk.encodedBytes,
        ratio,
        distinct: chunk.distinct,
        minValue: chunk.minValue,
        maxValue: chunk.maxValue,
        read: group.readColumns.includes(header.column),
        skipped: group.skipped,
        x: header.x,
        y,
        z: depth / 2,
        width: opt.cellWidth,
        height: opt.cellHeight,
        depth,
      });
    });
  });

  const minY = rowGroups.length > 0 ? rowGroups[rowGroups.length - 1].y : 0;
  return {
    chunks,
    rowGroups,
    columns: headers,
    bounds: {
      minX: startX - 3.2,
      maxX: startX + totalWidth + 1,
      minY: minY - opt.cellHeight,
      maxY: opt.cellHeight * 2.4,
    },
  };
}
