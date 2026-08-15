import type { Key } from '@dbkl/shared';
import type { KvState } from '@dbkl/simulation-core';

/**
 * 哈希索引 KV 布局。
 *
 * 上半部是**内存**：一排哈希桶，桶里挂着键；
 * 下半部是**磁盘**：一条条追加写的日志文件，每条记录一个小格子。
 * 点查时从桶引一条线直接落到某个格子上 —— 这就是「哈希一次 + 一次磁盘读」的全部过程。
 *
 * 两个对比一眼可见：
 *  - 桶的高度 = 冲突链长度（桶太少就会看到某几根特别高）；
 *  - 记录格子的颜色 = 还有效 / 已成垃圾（垃圾越多越该合并）。
 */

export interface KvLayoutOptions {
  bucketWidth: number;
  bucketDepth: number;
  bucketGap: number;
  /** 每多一个冲突项，桶长高多少。 */
  chainStep: number;
  /** 内存层与磁盘层之间的距离。 */
  memoryGap: number;
  recordWidth: number;
  recordHeight: number;
  recordGap: number;
  fileGap: number;
}

export const DEFAULT_KV_LAYOUT: KvLayoutOptions = {
  bucketWidth: 0.9,
  bucketDepth: 0.9,
  bucketGap: 0.28,
  chainStep: 0.42,
  memoryGap: 3.6,
  recordWidth: 0.62,
  recordHeight: 0.5,
  recordGap: 0.08,
  fileGap: 1.1,
};

export interface BucketBox {
  index: number;
  keys: Key[];
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  /** 最近一次探测命中的桶。 */
  probed: boolean;
}

export interface RecordBox {
  fileId: string;
  key: Key;
  offset: number;
  /** 是否仍被内存索引指着；否则就是等着被合并回收的垃圾。 */
  live: boolean;
  probed: boolean;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface FileRow {
  id: string;
  index: number;
  records: number;
  sealed: boolean;
  y: number;
  labelX: number;
}

export interface KvLayout {
  buckets: BucketBox[];
  files: FileRow[];
  records: RecordBox[];
  /** 探测连线：桶 → 记录。 */
  probeLink: { from: [number, number, number]; to: [number, number, number] } | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const EMPTY: KvLayout = {
  buckets: [],
  files: [],
  records: [],
  probeLink: null,
  bounds: { minX: -1, maxX: 1, minY: 0, maxY: 1 },
};

export function layoutKv(k: KvState, options: Partial<KvLayoutOptions> = {}): KvLayout {
  const opt = { ...DEFAULT_KV_LAYOUT, ...options };
  if (k.buckets === 0) return EMPTY;

  // —— 内存：哈希桶 ——
  const chains = new Map<number, Key[]>();
  for (const entry of k.index) {
    const list = chains.get(entry.bucket) ?? [];
    list.push(entry.key);
    chains.set(entry.bucket, list);
  }
  const bucketTotal = k.buckets * opt.bucketWidth + (k.buckets - 1) * opt.bucketGap;
  const bucketStartX = -bucketTotal / 2;
  const memoryY = opt.memoryGap;

  const buckets: BucketBox[] = [];
  for (let i = 0; i < k.buckets; i++) {
    const keys = (chains.get(i) ?? []).slice().sort((a, b) => a - b);
    const height = Math.max(0.28, keys.length * opt.chainStep);
    buckets.push({
      index: i,
      keys,
      x: bucketStartX + i * (opt.bucketWidth + opt.bucketGap) + opt.bucketWidth / 2,
      y: memoryY + height / 2,
      z: 0,
      width: opt.bucketWidth,
      height,
      depth: opt.bucketDepth,
      probed: k.lastProbe?.bucket === i,
    });
  }

  // —— 磁盘：日志文件，每个文件一行 ——
  const liveAt = new Map<string, Set<number>>();
  for (const entry of k.index) {
    const set = liveAt.get(entry.fileId) ?? new Set<number>();
    set.add(entry.offset);
    liveAt.set(entry.fileId, set);
  }

  const files: FileRow[] = [];
  const records: RecordBox[] = [];
  let probeTarget: RecordBox | null = null;

  k.files.forEach((file, fi) => {
    const y = -fi * (opt.recordHeight + opt.fileGap);
    files.push({
      id: file.id,
      index: file.index,
      records: file.records,
      sealed: file.sealed,
      y,
      labelX: bucketStartX - 2.4,
    });

    const live = liveAt.get(file.id) ?? new Set<number>();
    // 记录格子从左往右排：位置就是文件里的物理顺序（追加写 ⇒ 严格递增）。
    for (let r = 0; r < file.records; r++) {
      const x = bucketStartX + r * (opt.recordWidth + opt.recordGap) + opt.recordWidth / 2;
      // 偏移无法从状态里逐条还原，用「第几条」近似定位；命中的那条靠 probe 单独标。
      const box: RecordBox = {
        fileId: file.id,
        key: Number.NaN,
        offset: r,
        live: live.size > 0 && r < live.size,
        probed: false,
        x,
        y,
        z: 0,
        width: opt.recordWidth,
        height: opt.recordHeight,
        depth: 0.7,
      };
      records.push(box);
    }
  });

  // 探测命中：把桶与目标文件的第一格连起来（偏移在状态里是字节，按文件行定位即可）。
  const probe = k.lastProbe;
  let probeLink: KvLayout['probeLink'] = null;
  if (probe?.found && probe.fileId) {
    const bucket = buckets[probe.bucket];
    const fileRow = files.find((f) => f.id === probe.fileId);
    if (bucket && fileRow) {
      const target = records.find((r) => r.fileId === probe.fileId);
      if (target) {
        target.probed = true;
        probeTarget = target;
      }
      probeLink = {
        from: [bucket.x, bucket.y - bucket.height / 2, bucket.z],
        to: [probeTarget?.x ?? bucket.x, fileRow.y, 0],
      };
    }
  }

  const lastFileY = files.length > 0 ? files[files.length - 1].y : 0;
  const widest = records.reduce((n, r) => Math.max(n, r.x + r.width / 2), bucketStartX + bucketTotal);
  return {
    buckets,
    files,
    records,
    probeLink,
    bounds: {
      minX: bucketStartX - 3.2,
      maxX: widest + 1,
      minY: lastFileY - 1.5,
      maxY: memoryY + Math.max(1, ...buckets.map((b) => b.height)) + 2,
    },
  };
}
