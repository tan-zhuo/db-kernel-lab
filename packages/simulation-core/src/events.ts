import type { CommandKind, Key, PageId, PageType, Row, TableSchema } from '@dbkl/shared';
import type { EngineConfig } from './engine/types';
import type { PhysicalPlan } from './query/types';

/**
 * 事件协议 —— 整个平台的唯一真相来源。
 *
 * 规则（不可违反）：
 *  1. 引擎的任何状态变化都必须产生事件；
 *  2. 可视化层只能消费事件（经 reducer 归约成 LabState），禁止自己推断状态；
 *  3. 事件必须是纯数据（可 structuredClone / JSON 序列化），不能携带函数或类实例；
 *  4. `applyEvent(reducer)` 对事件流的重放结果必须与引擎自身快照逐字段相等（见 replay.test.ts）。
 *
 * 详细语义见 docs/event-protocol.md。
 */

export interface EventMeta {
  /** 全局单调递增序号，等于它在历史事件数组中的下标。 */
  seq: number;
  /** 逻辑时间戳（仿真时钟，单位：逻辑毫秒），用于动画节奏，不是墙钟时间。 */
  t: number;
  /** 所属命令 id，用于时间轴按命令分组与区间循环。 */
  cmd: number;
}

/** 页内被移动的一批条目（分裂 / 合并 / 再分配时用于让 reducer 一步完成结构变更）。 */
export interface EntryBatch {
  keys: Key[];
  /** 叶子页：与 keys 对齐的行数据。 */
  rows?: (Row | null)[];
  /** 内部页：被搬走的子页指针。 */
  children?: PageId[];
}

export type SimulationEventBody =
  // —— 命令边界 ——————————————————————————————————————————————
  | { type: 'COMMAND_BEGIN'; kind: CommandKind; label: string }
  | { type: 'COMMAND_END'; kind: CommandKind; label: string; ok: boolean; note?: string }
  | { type: 'NOTE'; message: string; level: 'info' | 'warn' | 'error' }

  // —— 元数据 ————————————————————————————————————————————————
  | { type: 'CONFIG_SET'; config: EngineConfig }
  | { type: 'TABLE_CREATE'; schema: TableSchema }
  | {
      type: 'INDEX_CREATE';
      indexId: string;
      name: string;
      column: string;
      clustered: boolean;
      unique: boolean;
    }
  | { type: 'INDEX_DROP'; indexId: string }
  /** 索引统计信息刷新（模拟 ANALYZE TABLE），供代价估算使用。 */
  | { type: 'INDEX_STATS'; indexId: string; entries: number; distinct: number; minKey: Key | null; maxKey: Key | null }

  // —— 页生命周期 ————————————————————————————————————————————
  | {
      type: 'PAGE_ALLOC';
      pageId: PageId;
      /** 页归属的索引（'PRIMARY' 为聚簇索引）。 */
      indexId: string;
      pageType: PageType;
      level: number;
      parentId: PageId | null;
      /** 新页的初始内容（新建根页时用于携带第一个子指针）。 */
      init?: { keys?: Key[]; children?: PageId[] };
    }
  | { type: 'PAGE_FREE'; pageId: PageId }
  | { type: 'PARENT_SET'; pageId: PageId; parentId: PageId | null }
  | { type: 'ROOT_CHANGE'; indexId: string; oldRootId: PageId | null; newRootId: PageId; height: number }
  | { type: 'LEAF_LINK'; pageId: PageId; prev: PageId | null; next: PageId | null }

  // —— 索引遍历 ————————————————————————————————————————————
  | { type: 'DESCEND'; pageId: PageId; childId: PageId; key: Key; slot: number; level: number }
  | { type: 'PAGE_READ'; pageId: PageId; purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain' }

  // —— 记录级变更（叶子页）————————————————————————————————
  | { type: 'RECORD_INSERT'; pageId: PageId; slot: number; key: Key; row: Row }
  | { type: 'RECORD_UPDATE'; pageId: PageId; slot: number; key: Key; row: Row; oldRow: Row | null }
  | { type: 'RECORD_DELETE'; pageId: PageId; slot: number; key: Key; row: Row | null }

  // —— 分隔键变更（内部页）————————————————————————————————
  | { type: 'SEPARATOR_INSERT'; pageId: PageId; slot: number; key: Key; childId: PageId }
  | { type: 'SEPARATOR_DELETE'; pageId: PageId; slot: number; key: Key; childId: PageId }
  | { type: 'SEPARATOR_UPDATE'; pageId: PageId; slot: number; key: Key; oldKey: Key }

  // —— 结构调整 ————————————————————————————————————————————
  | {
      type: 'PAGE_SPLIT';
      pageId: PageId;
      newPageId: PageId;
      /** 上浮到父页的键。叶子分裂时 = 右页首键（键仍保留在右页）；内部分裂时该键被移除。 */
      promotedKey: Key;
      pageType: PageType;
      /** 从左页搬到右页的条目，reducer 用它一次性完成搬迁。 */
      moved: EntryBatch;
      /** 触发分裂的键，用于动画标注。 */
      triggerKey: Key | null;
      fillFactor: number;
    }
  | {
      type: 'PAGE_MERGE';
      /** 保留页（左）。 */
      pageId: PageId;
      /** 被回收页（右）。 */
      victimPageId: PageId;
      pageType: PageType;
      /** 父页中被下沉/删除的分隔键。 */
      separatorKey: Key;
      moved: EntryBatch;
    }
  | {
      type: 'REDISTRIBUTE';
      fromPageId: PageId;
      toPageId: PageId;
      pageType: PageType;
      direction: 'left-to-right' | 'right-to-left';
      moved: EntryBatch;
      parentId: PageId;
      parentSlot: number;
      newSeparatorKey: Key;
      oldSeparatorKey: Key;
    }

  // —— 缓冲池 ————————————————————————————————————————————
  | { type: 'BUFFER_HIT'; pageId: PageId; frame: number }
  | { type: 'BUFFER_MISS'; pageId: PageId; frame: number }
  | { type: 'BUFFER_EVICT'; pageId: PageId; frame: number; reason: 'LRU' | 'CLOCK'; wasDirty: boolean }
  | { type: 'PAGE_MARK_DIRTY'; pageId: PageId }
  | { type: 'PAGE_FLUSH'; pageId: PageId; reason: 'evict' | 'checkpoint' | 'manual' }

  // —— 查询过程 ————————————————————————————————————————————
  | { type: 'SEARCH_BEGIN'; key: Key; mode: 'point' | 'range' | 'full' }
  | { type: 'SEARCH_RESULT'; key: Key; found: boolean; pageId: PageId | null; slot: number }
  | { type: 'SCAN_STEP'; pageId: PageId; slot: number; key: Key; row: Row | null; emitted: boolean }
  | { type: 'SCAN_END'; rows: number; pagesTouched: number }

  // —— 二级索引回表 ——————————————————————————————————————
  | {
      type: 'LOOKUP_BACK';
      /** 发起回表的二级索引。 */
      indexId: string;
      /** 二级索引叶子页与槽位。 */
      fromPageId: PageId;
      fromSlot: number;
      /** 二级索引键与它指向的主键。 */
      indexKey: Key;
      primaryKey: Key;
    }
  | { type: 'LOOKUP_DONE'; fromPageId: PageId; toPageId: PageId | null; slot: number; primaryKey: Key; found: boolean }

  // —— 执行计划 ————————————————————————————————————————
  | { type: 'PLAN_READY'; plan: PhysicalPlan }
  | { type: 'OPERATOR_OPEN'; nodeId: string; op: string; detail: string }
  | { type: 'OPERATOR_ROW'; nodeId: string; key: Key; emitted: boolean }
  | { type: 'OPERATOR_CLOSE'; nodeId: string; actualRows: number };

export type SimulationEvent = EventMeta & SimulationEventBody;
export type SimulationEventType = SimulationEventBody['type'];

/** 事件类型 → 展示分类，供时间轴染色与日志过滤。 */
export const EVENT_CATEGORY: Record<SimulationEventType, EventCategory> = {
  COMMAND_BEGIN: 'command',
  COMMAND_END: 'command',
  NOTE: 'command',
  CONFIG_SET: 'meta',
  TABLE_CREATE: 'meta',
  INDEX_CREATE: 'meta',
  INDEX_DROP: 'meta',
  INDEX_STATS: 'meta',
  PAGE_ALLOC: 'structure',
  PAGE_FREE: 'structure',
  PARENT_SET: 'structure',
  ROOT_CHANGE: 'structure',
  LEAF_LINK: 'structure',
  DESCEND: 'access',
  PAGE_READ: 'access',
  RECORD_INSERT: 'record',
  RECORD_UPDATE: 'record',
  RECORD_DELETE: 'record',
  SEPARATOR_INSERT: 'record',
  SEPARATOR_DELETE: 'record',
  SEPARATOR_UPDATE: 'record',
  PAGE_SPLIT: 'structure',
  PAGE_MERGE: 'structure',
  REDISTRIBUTE: 'structure',
  BUFFER_HIT: 'buffer',
  BUFFER_MISS: 'buffer',
  BUFFER_EVICT: 'buffer',
  PAGE_MARK_DIRTY: 'buffer',
  PAGE_FLUSH: 'buffer',
  SEARCH_BEGIN: 'access',
  SEARCH_RESULT: 'access',
  SCAN_STEP: 'access',
  SCAN_END: 'access',
  LOOKUP_BACK: 'access',
  LOOKUP_DONE: 'access',
  PLAN_READY: 'plan',
  OPERATOR_OPEN: 'plan',
  OPERATOR_ROW: 'plan',
  OPERATOR_CLOSE: 'plan',
};

export type EventCategory = 'command' | 'meta' | 'structure' | 'record' | 'buffer' | 'access' | 'plan';

/**
 * 每类事件占用的「逻辑时长」（毫秒）。
 *
 * 它不是墙钟时间，而是仿真时钟：时间轴按逻辑时间铺开，
 * 让页分裂这种关键事件在播放时自然停留更久，而缓冲池命中一闪而过。
 */
export const EVENT_DURATION: Record<SimulationEventType, number> = {
  COMMAND_BEGIN: 40,
  COMMAND_END: 40,
  NOTE: 60,
  CONFIG_SET: 40,
  TABLE_CREATE: 200,
  INDEX_CREATE: 300,
  INDEX_DROP: 200,
  INDEX_STATS: 40,
  PAGE_ALLOC: 220,
  PAGE_FREE: 220,
  PARENT_SET: 30,
  ROOT_CHANGE: 400,
  LEAF_LINK: 60,
  DESCEND: 160,
  PAGE_READ: 40,
  RECORD_INSERT: 180,
  RECORD_UPDATE: 180,
  RECORD_DELETE: 180,
  SEPARATOR_INSERT: 200,
  SEPARATOR_DELETE: 200,
  SEPARATOR_UPDATE: 120,
  PAGE_SPLIT: 700,
  PAGE_MERGE: 700,
  REDISTRIBUTE: 500,
  BUFFER_HIT: 40,
  BUFFER_MISS: 90,
  BUFFER_EVICT: 260,
  PAGE_MARK_DIRTY: 40,
  PAGE_FLUSH: 160,
  SEARCH_BEGIN: 80,
  SEARCH_RESULT: 260,
  SCAN_STEP: 90,
  SCAN_END: 120,
  LOOKUP_BACK: 260,
  LOOKUP_DONE: 160,
  PLAN_READY: 400,
  OPERATOR_OPEN: 120,
  OPERATOR_ROW: 70,
  OPERATOR_CLOSE: 120,
};

/** 时间轴上值得停留的「关键帧」——单步/自动播放会在这些事件上放慢。 */
export const KEYFRAME_EVENTS: ReadonlySet<SimulationEventType> = new Set<SimulationEventType>([
  'PAGE_SPLIT',
  'PAGE_MERGE',
  'REDISTRIBUTE',
  'ROOT_CHANGE',
  'BUFFER_EVICT',
  'SEARCH_RESULT',
  'PLAN_READY',
  'LOOKUP_BACK',
  'INDEX_CREATE',
  'COMMAND_END',
]);

/** 人类可读的一行事件描述，供事件日志与时间轴 tooltip 使用。 */
export function describeEvent(e: SimulationEvent): string {
  switch (e.type) {
    case 'COMMAND_BEGIN':
      return `▶ ${e.label}`;
    case 'COMMAND_END':
      return `■ ${e.label}${e.note ? ` — ${e.note}` : ''}`;
    case 'NOTE':
      return e.message;
    case 'CONFIG_SET':
      return `配置：order=${e.config.order}，buffer=${e.config.bufferPoolFrames} 帧，fill=${e.config.fillFactor}`;
    case 'TABLE_CREATE':
      return `CREATE TABLE ${e.schema.name} (PK: ${e.schema.primaryKey})`;
    case 'INDEX_CREATE':
      return `创建${e.clustered ? '聚簇' : '二级'}索引 ${e.name}(${e.column})`;
    case 'INDEX_DROP':
      return `删除索引 ${e.indexId}`;
    case 'INDEX_STATS':
      return `统计信息 ${e.indexId}：${e.entries} 条 / ${e.distinct} 个不同键 / [${e.minKey ?? '∅'}, ${e.maxKey ?? '∅'}]`;
    case 'PAGE_ALLOC':
      return `分配 ${e.pageType === 'leaf' ? '叶子' : '内部'}页 #${e.pageId}（${e.indexId} level ${e.level}）`;
    case 'PAGE_FREE':
      return `回收页 #${e.pageId}`;
    case 'PARENT_SET':
      return `页 #${e.pageId} 的父页 → ${e.parentId === null ? 'ROOT' : `#${e.parentId}`}`;
    case 'ROOT_CHANGE':
      return `${e.indexId} 根页 ${e.oldRootId === null ? '创建' : `#${e.oldRootId} →`} #${e.newRootId}，树高 ${e.height}`;
    case 'LEAF_LINK':
      return `叶子链表 #${e.pageId}: prev=${e.prev ?? '∅'}, next=${e.next ?? '∅'}`;
    case 'DESCEND':
      return `在 #${e.pageId} 定位 key=${e.key} → slot ${e.slot} → 子页 #${e.childId}`;
    case 'PAGE_READ':
      return `读取页 #${e.pageId}（${e.purpose}）`;
    case 'RECORD_INSERT':
      return `页 #${e.pageId} slot ${e.slot} 插入记录 key=${e.key}`;
    case 'RECORD_UPDATE':
      return `页 #${e.pageId} slot ${e.slot} 更新记录 key=${e.key}`;
    case 'RECORD_DELETE':
      return `页 #${e.pageId} slot ${e.slot} 删除记录 key=${e.key}`;
    case 'SEPARATOR_INSERT':
      return `内部页 #${e.pageId} 插入分隔键 ${e.key} → 子页 #${e.childId}`;
    case 'SEPARATOR_DELETE':
      return `内部页 #${e.pageId} 移除分隔键 ${e.key}（子页 #${e.childId}）`;
    case 'SEPARATOR_UPDATE':
      return `内部页 #${e.pageId} slot ${e.slot} 分隔键 ${e.oldKey} → ${e.key}`;
    case 'PAGE_SPLIT':
      return `页分裂：#${e.pageId} → #${e.newPageId}，上浮键 ${e.promotedKey}，搬移 ${e.moved.keys.length} 条`;
    case 'PAGE_MERGE':
      return `页合并：#${e.victimPageId} 并入 #${e.pageId}，下沉键 ${e.separatorKey}`;
    case 'REDISTRIBUTE':
      return `兄弟页借位：#${e.fromPageId} → #${e.toPageId}，新分隔键 ${e.newSeparatorKey}`;
    case 'BUFFER_HIT':
      return `Buffer 命中 页 #${e.pageId}（frame ${e.frame}）`;
    case 'BUFFER_MISS':
      return `Buffer 未命中 页 #${e.pageId} → 装入 frame ${e.frame}`;
    case 'BUFFER_EVICT':
      return `${e.reason} 淘汰 页 #${e.pageId}（frame ${e.frame}）${e.wasDirty ? '，脏页需刷盘' : ''}`;
    case 'PAGE_MARK_DIRTY':
      return `页 #${e.pageId} 变脏`;
    case 'PAGE_FLUSH':
      return `刷盘 页 #${e.pageId}（${e.reason}）`;
    case 'SEARCH_BEGIN':
      return `查找开始 key=${e.key}（${e.mode}）`;
    case 'SEARCH_RESULT':
      return e.found ? `命中 key=${e.key} @ 页 #${e.pageId} slot ${e.slot}` : `未找到 key=${e.key}`;
    case 'SCAN_STEP':
      return `扫描 页 #${e.pageId} slot ${e.slot} key=${e.key}${e.emitted ? ' ✓' : ''}`;
    case 'SCAN_END':
      return `扫描结束：${e.rows} 行，触达 ${e.pagesTouched} 页`;
    case 'LOOKUP_BACK':
      return `回表：${e.indexId} 键 ${e.indexKey} → 主键 ${e.primaryKey}`;
    case 'LOOKUP_DONE':
      return e.found ? `回表命中 主键 ${e.primaryKey} @ 页 #${e.toPageId} slot ${e.slot}` : `回表未命中 主键 ${e.primaryKey}`;
    case 'PLAN_READY':
      return `执行计划：${e.plan.chosen}`;
    case 'OPERATOR_OPEN':
      return `算子 ${e.nodeId} ${e.op} 开始（${e.detail}）`;
    case 'OPERATOR_ROW':
      return `算子 ${e.nodeId} 产出 key=${e.key}${e.emitted ? '' : '（被过滤）'}`;
    case 'OPERATOR_CLOSE':
      return `算子 ${e.nodeId} 结束，实际 ${e.actualRows} 行`;
    default: {
      const never: never = e;
      return JSON.stringify(never);
    }
  }
}
