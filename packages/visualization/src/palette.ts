/**
 * 统一视觉语言（文档 §7）。
 *
 * 所有颜色集中在此，3D 与 2D 面板共用，保证「绿=新增 / 红=删除淘汰 / 黄=查找路径 /
 * 橙=脏页 / 紫=锁等待」在**任何主题、任何视图**里含义一致 ——
 * 换主题只换明暗与色温，不换语义。
 *
 * `PALETTE` 是一个**活对象**：`applyTheme()` 就地覆盖它的字段，
 * 于是所有 `PALETTE.leaf` 这样的读取（包括每帧跑的 useFrame）下一帧就拿到新颜色，
 * 不需要把主题一路 props 传下去。代价是：**不要解构后长期持有**。
 */

export interface PaletteShape {
  // —— 场景底色与灯光 ——
  background: string;
  grid: string;
  gridSection: string;
  /** 半球光的天空色 / 地面色 + 补光色，决定整个场景的冷暖。 */
  skyLight: string;
  groundLight: string;
  fillLight: string;

  // —— 文字（Canvas 贴图用；必须跟着主题走，否则浅色主题下白字会消失）——
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnLeaf: string;
  textOnInternal: string;

  // —— B+ 树 ——
  leaf: string;
  leafDim: string;
  internal: string;
  internalDim: string;
  root: string;
  slotEmpty: string;
  slotFilled: string;
  slotFilledInternal: string;

  // —— 语义色（跨主题保持含义）——
  insert: string;
  update: string;
  remove: string;
  searchPath: string;
  hit: string;
  dirty: string;
  evict: string;
  split: string;
  merge: string;
  lock: string;
  /** 回表连线：二级索引 → 聚簇索引。 */
  lookup: string;
  resident: string;
  selected: string;

  edgeChild: string;
  edgeChildActive: string;
  edgeSibling: string;

  // —— PostgreSQL 堆表 / MVCC ——
  /** 堆页外框（无序数据页，与 B+ 树页明显区分）。 */
  heapPage: string;
  /** 活元组：当前快照能看见的版本。 */
  tupleLive: string;
  /** 死元组：已被打上 xmax，等 VACUUM 回收 —— 表膨胀的来源。 */
  tupleDead: string;
  /** 行指针重定向（HOT 链被剪枝后留下的指针）。 */
  tupleRedirect: string;
  /** 空闲行指针，可被新版本复用。 */
  tupleUnused: string;
  /** 可见性映射里被标成 all-visible 的页。 */
  allVisible: string;
  /** 版本链 t_ctid 连线。 */
  versionChain: string;
  /** HOT 链：新版本不写索引，用不同颜色区分。 */
  hotChain: string;
  /** 索引项 → 堆元组的一跳。 */
  heapFetch: string;

  // —— LSM-Tree ——
  memtable: string;
  memtableFrozen: string;
  /** MemTable 容器外壳（空的时候也要看得见）。 */
  memtableShell: string;
  /** 各层 SST 的底色，越往下越冷。 */
  sstLevel: readonly string[];
  /** 正在参与压实的文件 / 积压的压实任务。 */
  compacting: string;
  /** 墓碑占比的提示色。 */
  tombstone: string;
  /** 布隆过滤器成功挡掉一个文件。 */
  bloomSkip: string;

  // —— 列存 ——
  /** 列块底色按**编码方式**区分，一眼看出哪一列压得动。 */
  chunkPlain: string;
  chunkDictionary: string;
  chunkRle: string;
  chunkDelta: string;
  /** 被区间统计整块跳过的行组（一个字节都没读）。 */
  chunkSkipped: string;
  /** 本次查询真的读了的列块。 */
  chunkRead: string;

  // —— 哈希索引 KV ——
  kvBucketEmpty: string;
  kvBucketFilled: string;
  /** 正在写的活动文件 vs 已封口的只读文件。 */
  kvLogActive: string;
  kvLogSealed: string;
  /** 仍被索引指着的记录 vs 已成垃圾的记录。 */
  kvRecordLive: string;
  kvRecordDead: string;
  /** 哈希探测连线：桶 → 记录位置。 */
  kvProbe: string;

  // —— 写时复制 B+ 树 ——
  /** 当前生效的 meta 页 vs 另一个待写的槽。 */
  cowMetaActive: string;
  cowMetaIdle: string;
  /** 本次写事务刚复制出来的页（复制路径高亮）。 */
  cowCopied: string;
  /** 空闲表里等待复用的页。 */
  cowFree: string;
  /** 被只读快照钉住、暂时回收不了的旧页。 */
  cowPinned: string;
  /** 只读快照标记与它指向旧根的连线。 */
  cowReader: string;

  // —— Bε-树 / 分形树 ——
  /** 消息缓冲的空槽 vs 已占用。 */
  bufferEmpty: string;
  bufferFilled: string;
  /** 缓冲快满了（下一条就要触发下推）。 */
  bufferHot: string;
  /** 刚被下推的那批消息（父 → 子的连线）。 */
  bufferFlush: string;
  /** 读路径在缓冲里命中的那一格。 */
  bufferHit: string;
}

export type ThemeId = 'deep' | 'slate' | 'warm' | 'light';

/** ① 深空 —— 近黑背景，对比最强，适合暗房与录屏。 */
const DEEP: PaletteShape = {
  background: '#080b12',
  grid: '#141b2b',
  gridSection: '#1d2a44',
  skyLight: '#8ab4ff',
  groundLight: '#0a0f1a',
  fillLight: '#7c5cff',

  textPrimary: '#e6edf3',
  textSecondary: '#dbe6f5',
  textMuted: '#8b98ad',
  textOnLeaf: '#e9f1ff',
  textOnInternal: '#e8e2ff',

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
  lookup: '#f778ba',
  resident: '#39c5cf',
  selected: '#ffffff',

  edgeChild: '#2b3a55',
  edgeChildActive: '#e3b341',
  edgeSibling: '#1f3b34',

  heapPage: '#2d3f5e',
  tupleLive: '#2ea043',
  tupleDead: '#8b3a34',
  tupleRedirect: '#d29922',
  tupleUnused: '#1a2233',
  allVisible: '#00b8a3',
  versionChain: '#f778ba',
  hotChain: '#39d353',
  heapFetch: '#58a6ff',

  memtable: '#00b8a3',
  memtableFrozen: '#0f8f86',
  memtableShell: '#16283a',
  sstLevel: ['#2f81f7', '#7c5cff', '#a371f7', '#c77dff', '#6b7a91'],
  compacting: '#db6d28',
  tombstone: '#f85149',
  bloomSkip: '#39d353',

  chunkPlain: '#4a5568',
  chunkDictionary: '#7c5cff',
  chunkRle: '#00b8a3',
  chunkDelta: '#2f81f7',
  chunkSkipped: '#232a38',
  chunkRead: '#f0d264',

  kvBucketEmpty: '#1a2233',
  kvBucketFilled: '#2f81f7',
  kvLogActive: '#00b8a3',
  kvLogSealed: '#4a5568',
  kvRecordLive: '#2ea043',
  kvRecordDead: '#5c3a38',
  kvProbe: '#f0d264',

  cowMetaActive: '#00b8a3',
  cowMetaIdle: '#243044',
  cowCopied: '#f0883e',
  cowFree: '#3d4757',
  cowPinned: '#7c5cff',
  cowReader: '#58a6ff',

  bufferEmpty: '#1b2434',
  bufferFilled: '#f0883e',
  bufferHot: '#f85149',
  bufferFlush: '#f0d264',
  bufferHit: '#00b8a3',
};

/**
 * ② 石板 —— 蓝灰底，比深空亮一档。
 *
 * 纯黑背景配高亮度色块时边缘对比过强，久看会「割眼」；
 * 把底色抬起来、同时把结构色调亮一点，整体柔和不少。
 */
const SLATE: PaletteShape = {
  ...DEEP,
  background: '#1a2130',
  grid: '#2a3446',
  gridSection: '#3a4760',
  skyLight: '#a8c4ff',
  groundLight: '#232c3d',
  fillLight: '#8f74ff',

  textPrimary: '#eef3fa',
  textSecondary: '#e2eaf6',
  textMuted: '#9aa8be',

  leaf: '#3b82f6',
  leafDim: '#1e4b8f',
  internal: '#8b6cff',
  internalDim: '#4a3a94',
  root: '#14b8a6',
  slotEmpty: '#2b3648',
  slotFilled: '#5b9cf8',
  slotFilledInternal: '#a892ff',

  edgeChild: '#3d4c66',
  edgeSibling: '#2c4a42',

  heapPage: '#3a4d6e',
  tupleUnused: '#2b3648',
  memtableShell: '#243449',
  sstLevel: ['#3b82f6', '#8b6cff', '#b088ff', '#d09bff', '#8593ab'],

  chunkPlain: '#5a677d',
  chunkDictionary: '#8b6cff',
  chunkRle: '#14b8a6',
  chunkDelta: '#3b82f6',
  chunkSkipped: '#2b3243',
  kvBucketEmpty: '#2b3648',
  kvBucketFilled: '#3b82f6',
  kvLogSealed: '#5a677d',
  kvLogActive: '#14b8a6',
  kvRecordDead: '#6b4442',

  cowMetaIdle: '#2b3648',
  cowFree: '#4a5769',
  bufferEmpty: '#2b3648',
};

/**
 * ③ 暖夜 —— 暖褐灰底、低蓝光，夜间久看更舒服。
 * 语义色同步往暖里挪一点，避免冷色压在暖底上发脏。
 */
const WARM: PaletteShape = {
  ...DEEP,
  background: '#1c1a17',
  grid: '#2e2924',
  gridSection: '#413a32',
  skyLight: '#ffd9a8',
  groundLight: '#241f1a',
  fillLight: '#c98cff',

  textPrimary: '#f5efe6',
  textSecondary: '#ece3d6',
  textMuted: '#a99c8b',
  textOnLeaf: '#fff4e6',
  textOnInternal: '#f3e8ff',

  leaf: '#3f83d8',
  leafDim: '#274c78',
  internal: '#a274e8',
  internalDim: '#4e3a72',
  root: '#1fae94',
  slotEmpty: '#2e2924',
  slotFilled: '#5d9ae8',
  slotFilledInternal: '#bb98f5',

  insert: '#4fa85c',
  update: '#e0a53c',
  remove: '#e8624f',
  searchPath: '#f0bc55',
  hit: '#f5d778',
  dirty: '#e07f3a',
  evict: '#e8624f',
  split: '#5cc76b',
  merge: '#f08a7d',
  lookup: '#f58bc0',
  resident: '#4bc6c0',

  edgeChild: '#4a423a',
  edgeChildActive: '#f0bc55',
  edgeSibling: '#3a4438',

  heapPage: '#3e372f',
  tupleLive: '#4fa85c',
  tupleDead: '#8f4438',
  tupleRedirect: '#e0a53c',
  tupleUnused: '#2e2924',
  allVisible: '#1fae94',
  versionChain: '#f58bc0',
  hotChain: '#5cc76b',
  heapFetch: '#6bb0f5',

  memtable: '#1fae94',
  memtableFrozen: '#178a78',
  memtableShell: '#2b2b28',
  sstLevel: ['#3f83d8', '#a274e8', '#c08ef0', '#dba6f5', '#a99c8b'],
  compacting: '#e07f3a',
  tombstone: '#e8624f',
  bloomSkip: '#5cc76b',

  chunkPlain: '#5c5348',
  chunkDictionary: '#a274e8',
  chunkRle: '#1fae94',
  chunkDelta: '#3f83d8',
  chunkSkipped: '#2b2721',
  chunkRead: '#f5d778',
  kvBucketEmpty: '#2e2924',
  kvBucketFilled: '#3f83d8',
  kvLogActive: '#1fae94',
  kvLogSealed: '#5c5348',
  kvRecordLive: '#4fa85c',
  kvRecordDead: '#6b4038',
  kvProbe: '#f5d778',
};

/**
 * ④ 日光 —— 真正的浅色主题：白纸底、深色文字。
 *
 * 注意这**不是简单反色**：为暗背景挑的那些亮色压在白底上会糊成一片，
 * 所有结构色都重新加深加饱和过。
 */
const LIGHT: PaletteShape = {
  background: '#eef1f6',
  grid: '#c9d2e0',
  gridSection: '#aab6c9',
  skyLight: '#ffffff',
  groundLight: '#dfe5ee',
  fillLight: '#b9a8ff',

  textPrimary: '#111823',
  textSecondary: '#222d3d',
  textMuted: '#5a6577',
  textOnLeaf: '#ffffff',
  textOnInternal: '#ffffff',

  leaf: '#1d4ed8',
  leafDim: '#93b4f0',
  internal: '#6d28d9',
  internalDim: '#c4b0f0',
  root: '#0f766e',
  slotEmpty: '#cbd3e0',
  slotFilled: '#2563eb',
  slotFilledInternal: '#7c3aed',

  insert: '#15803d',
  update: '#b45309',
  remove: '#b91c1c',
  searchPath: '#b45309',
  hit: '#a16207',
  dirty: '#c2410c',
  evict: '#b91c1c',
  split: '#15803d',
  merge: '#c2410c',
  lock: '#7c3aed',
  lookup: '#be185d',
  resident: '#0e7490',
  selected: '#0b1220',

  edgeChild: '#98a6ba',
  edgeChildActive: '#b45309',
  edgeSibling: '#7fae9e',

  heapPage: '#9fb0c9',
  tupleLive: '#15803d',
  tupleDead: '#c26a63',
  tupleRedirect: '#b45309',
  tupleUnused: '#cbd3e0',
  allVisible: '#0f766e',
  versionChain: '#be185d',
  hotChain: '#15803d',
  heapFetch: '#1d4ed8',

  memtable: '#0f766e',
  memtableFrozen: '#115e59',
  memtableShell: '#d6dde8',
  sstLevel: ['#1d4ed8', '#6d28d9', '#8b5cf6', '#a78bfa', '#64748b'],
  compacting: '#c2410c',
  tombstone: '#b91c1c',
  bloomSkip: '#15803d',

  chunkPlain: '#94a3b8',
  chunkDictionary: '#6d28d9',
  chunkRle: '#0f766e',
  chunkDelta: '#1d4ed8',
  chunkSkipped: '#dbe1ea',
  chunkRead: '#b45309',
  kvBucketEmpty: '#cbd3e0',
  kvBucketFilled: '#1d4ed8',
  kvLogActive: '#0f766e',
  kvLogSealed: '#94a3b8',
  kvRecordLive: '#15803d',
  kvRecordDead: '#c26a63',
  kvProbe: '#b45309',

  cowMetaActive: '#0f766e',
  cowMetaIdle: '#c3cbd8',
  cowCopied: '#c2410c',
  cowFree: '#9aa7b9',
  cowPinned: '#6d28d9',
  cowReader: '#1d4ed8',

  bufferEmpty: '#d3dae4',
  bufferFilled: '#c2410c',
  bufferHot: '#b91c1c',
  bufferFlush: '#b45309',
  bufferHit: '#0f766e',
};

export const THEMES: Record<ThemeId, PaletteShape> = {
  deep: DEEP,
  slate: SLATE,
  warm: WARM,
  light: LIGHT,
};

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  hint: string;
  /** 主题选择器上的小色卡：背景 + 两个代表色。 */
  swatch: [string, string, string];
  dark: boolean;
}

export const THEME_LIST: ThemeMeta[] = [
  {
    id: 'slate',
    label: '石板',
    hint: '蓝灰底，比深空亮一档，久看不割眼',
    swatch: [SLATE.background, SLATE.leaf, SLATE.root],
    dark: true,
  },
  {
    id: 'deep',
    label: '深空',
    hint: '近黑背景，对比最强，适合暗房与录屏',
    swatch: [DEEP.background, DEEP.leaf, DEEP.root],
    dark: true,
  },
  {
    id: 'warm',
    label: '暖夜',
    hint: '暖褐灰底、低蓝光，夜间阅读更舒服',
    swatch: [WARM.background, WARM.leaf, WARM.root],
    dark: true,
  },
  {
    id: 'light',
    label: '日光',
    hint: '白纸底深色字，适合白天、投影与截图',
    swatch: [LIGHT.background, LIGHT.leaf, LIGHT.root],
    dark: false,
  },
];

/** 默认主题。选石板而不是纯黑：长时间盯屏更舒服。 */
export const DEFAULT_THEME: ThemeId = 'slate';

/** 当前生效的调色板。**活对象**，不要解构后长期持有。 */
export const PALETTE: PaletteShape = { ...THEMES[DEFAULT_THEME] };

let currentTheme: ThemeId = DEFAULT_THEME;

export function currentThemeId(): ThemeId {
  return currentTheme;
}

export function isValidTheme(id: string | null | undefined): id is ThemeId {
  return typeof id === 'string' && id in THEMES;
}

/**
 * 切换主题：就地覆盖 `PALETTE`，下一帧渲染即生效。
 *
 * 调用方还需要清一次文字贴图缓存（贴图把颜色烘进了像素），并让 React 重画一次。
 */
export function applyTheme(id: ThemeId): PaletteShape {
  currentTheme = id;
  Object.assign(PALETTE, THEMES[id]);
  return PALETTE;
}

export type PaletteKey = keyof PaletteShape;

/**
 * 高亮语义 → 颜色。
 *
 * 这里必须是 **getter**：`PALETTE` 会被就地覆盖，
 * 若在模块加载时把值拷成常量，换主题后高亮就还是旧颜色。
 */
export const HIGHLIGHT_COLOR = {
  get insert() {
    return PALETTE.insert;
  },
  get update() {
    return PALETTE.update;
  },
  get delete() {
    return PALETTE.remove;
  },
  get path() {
    return PALETTE.searchPath;
  },
  get hit() {
    return PALETTE.hit;
  },
  get split() {
    return PALETTE.split;
  },
  get merge() {
    return PALETTE.merge;
  },
  get evict() {
    return PALETTE.evict;
  },
  get dirty() {
    return PALETTE.dirty;
  },
  get alloc() {
    return PALETTE.split;
  },
  get scan() {
    return PALETTE.resident;
  },
  get lookup() {
    return PALETTE.lookup;
  },
  /** MVCC：写了一个新版本 / 给旧版本打 xmax。 */
  get version() {
    return PALETTE.versionChain;
  },
  /** VACUUM 清理。 */
  get vacuum() {
    return PALETTE.allVisible;
  },
  /** 索引 → 堆的一跳。 */
  get fetch() {
    return PALETTE.heapFetch;
  },
  /** LSM 压实。 */
  get compact() {
    return PALETTE.compacting;
  },
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

/** 列块编码 → 颜色。同样必须是函数（PALETTE 会被就地覆盖）。 */
export function encodingColor(encoding: string): string {
  switch (encoding) {
    case 'dictionary':
      return PALETTE.chunkDictionary;
    case 'rle':
      return PALETTE.chunkRle;
    case 'delta':
      return PALETTE.chunkDelta;
    default:
      return PALETTE.chunkPlain;
  }
}

/** 第 n 层 SST 的颜色（超出预设长度则复用最后一个）。 */
export function levelColor(level: number): string {
  const palette = PALETTE.sstLevel;
  return palette[Math.min(level, palette.length - 1)];
}
