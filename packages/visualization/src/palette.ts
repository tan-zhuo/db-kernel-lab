/**
 * 统一视觉语言（文档 §7）。
 * 所有颜色集中在此，3D 与 2D 面板共用，保证「绿=新增 / 红=删除淘汰 / 黄=查找路径 /
 * 橙=脏页 / 紫=锁等待」在任何视图中含义一致。
 */
export const PALETTE = {
  background: '#080b12',
  grid: '#141b2b',

  leaf: '#1f6feb',
  leafDim: '#123a72',
  internal: '#7c5cff',
  internalDim: '#3d2d80',
  root: '#00b8a3',

  slotEmpty: '#1a2233',
  slotFilled: '#2f81f7',
  slotFilledInternal: '#9b7cff',

  insert: '#2ea043',
  update: '#d29922',
  remove: '#f85149',
  searchPath: '#e3b341',
  hit: '#f0d264',
  dirty: '#db6d28',
  evict: '#f85149',
  split: '#39d353',
  merge: '#ff7b72',
  lock: '#a371f7',
  /** 回表连线：二级索引 → 聚簇索引。 */
  lookup: '#f778ba',
  resident: '#39c5cf',
  selected: '#ffffff',

  edgeChild: '#2b3a55',
  edgeChildActive: '#e3b341',
  edgeSibling: '#1f3b34',

  // —— PostgreSQL 堆表 / MVCC ——
  /** 堆页外框（无序数据页，与 B+ 树页明显区分）。 */
  heapPage: '#2d3f5e',
  /** 活元组：当前快照能看见的版本。 */
  tupleLive: '#2ea043',
  /** 死元组：已被打上 xmax，等 VACUUM 回收 —— 表膨胀的来源。 */
  tupleDead: '#8b3a34',
  /** 行指针重定向（HOT 链被剪枝后留下的指针）。 */
  tupleRedirect: '#d29922',
  /** 空闲行指针，可被新版本复用。 */
  tupleUnused: '#1a2233',
  /** 可见性映射里被标成 all-visible 的页，Index Only Scan 可跳过它。 */
  allVisible: '#00b8a3',
  /** 版本链 t_ctid 连线。 */
  versionChain: '#f778ba',
  /** HOT 链：新版本不写索引，用不同颜色区分。 */
  hotChain: '#39d353',
  /** 索引项 → 堆元组的一跳。 */
  heapFetch: '#58a6ff',

  // —— LSM-Tree ——
  memtable: '#00b8a3',
  memtableFrozen: '#0f8f86',
  /** 各层 SST 的底色，越往下越冷。 */
  sstLevel: ['#2f81f7', '#7c5cff', '#a371f7', '#c77dff', '#6b7a91'],
  /** 正在参与压实的文件。 */
  compacting: '#db6d28',
  /** 墓碑占比的提示色。 */
  tombstone: '#f85149',
  /** 布隆过滤器成功挡掉一个文件。 */
  bloomSkip: '#39d353',
} as const;

/** 第 n 层 SST 的颜色（超出预设长度则复用最后一个）。 */
export function levelColor(level: number): string {
  const palette = PALETTE.sstLevel;
  return palette[Math.min(level, palette.length - 1)];
}

export type PaletteKey = keyof typeof PALETTE;

/** 高亮语义 → 颜色。可视化组件按最近事件为页/槽位打上这些标记。 */
export const HIGHLIGHT_COLOR = {
  insert: PALETTE.insert,
  update: PALETTE.update,
  delete: PALETTE.remove,
  path: PALETTE.searchPath,
  hit: PALETTE.hit,
  split: PALETTE.split,
  merge: PALETTE.merge,
  evict: PALETTE.evict,
  dirty: PALETTE.dirty,
  alloc: PALETTE.split,
  scan: PALETTE.resident,
  lookup: PALETTE.lookup,
  /** MVCC：写了一个新版本 / 给旧版本打 xmax。 */
  version: PALETTE.versionChain,
  /** VACUUM 清理。 */
  vacuum: PALETTE.allVisible,
  /** 索引 → 堆的一跳。 */
  fetch: PALETTE.heapFetch,
  /** LSM 压实。 */
  compact: PALETTE.compacting,
} as const;

export type HighlightKind = keyof typeof HIGHLIGHT_COLOR;

/** 高亮衰减时长（毫秒，真实墙钟时间）。 */
export const HIGHLIGHT_DECAY_MS: Record<HighlightKind, number> = {
  insert: 900,
  update: 900,
  delete: 900,
  path: 1400,
  hit: 1600,
  split: 2000,
  merge: 2000,
  evict: 1400,
  dirty: 600,
  alloc: 1600,
  scan: 700,
  lookup: 2200,
  version: 1800,
  vacuum: 2000,
  fetch: 1800,
  compact: 2400,
};
