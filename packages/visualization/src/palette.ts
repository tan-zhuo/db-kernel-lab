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
  resident: '#39c5cf',
  selected: '#ffffff',

  edgeChild: '#2b3a55',
  edgeChildActive: '#e3b341',
  edgeSibling: '#1f3b34',
} as const;

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
};
