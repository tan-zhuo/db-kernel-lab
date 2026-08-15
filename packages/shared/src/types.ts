/**
 * 跨层共享的基础类型。
 *
 * Phase 0 的取舍：主键与索引键统一为 number（整型）。
 * Phase 1 引入行格式后会替换为 `Key = number | string | Uint8Array` 并加入比较器抽象。
 */

/** 页号（等价于 InnoDB 的 space-relative page number，此处简化为自增整数）。 */
export type PageId = number;

/** 索引键。Phase 0 仅支持整型主键。 */
export type Key = number;

/** 事务号（对应 PostgreSQL 的 xid / InnoDB 的 trx_id），单调递增。 */
export type Txid = number;

/**
 * 元组标识符，对应 PostgreSQL 的 ctid = (块号, 行指针下标)。
 *
 * 这是「堆表 + 独立索引」模型的核心：索引项存的是 TID 而不是主键，
 * 因此**任何**索引扫描都必须再去堆里取一次行（与 InnoDB 的聚簇索引形成对照）。
 */
export interface Tid {
  pageId: PageId;
  slot: number;
}

/**
 * 行指针（PostgreSQL 的 ItemId / lp_flags）状态。
 *
 *  - `normal`：指向一个真实元组；
 *  - `redirect`：HOT 链的头被剪枝后留下的重定向指针（索引项不用改）；
 *  - `dead`：元组已被清理，但行指针还不能回收（索引项还指着它）；
 *  - `unused`：可以被新元组复用。
 */
export type LinePointerState = 'normal' | 'redirect' | 'dead' | 'unused';

/** TID 的可比较编码：用于在允许重复键的索引里给相等键定序。 */
export function packTid(tid: Tid): number {
  return tid.pageId * 4096 + tid.slot;
}

export function formatTid(tid: Tid | null): string {
  return tid === null ? '∅' : `(${tid.pageId},${tid.slot})`;
}

export function sameTid(a: Tid | null, b: Tid | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pageId === b.pageId && a.slot === b.slot;
}

/** 列值。 */
export type Value = string | number | boolean | null;

/** 一条逻辑行（未编码为物理行格式前的形态）。 */
export type Row = Record<string, Value>;

export type ColumnType = 'int' | 'bigint' | 'varchar' | 'bool' | 'timestamp';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** varchar 的最大长度；其它类型忽略。 */
  length?: number;
  nullable?: boolean;
}

export interface TableSchema {
  name: string;
  columns: ColumnDef[];
  /** 主键列名，必须存在于 columns 中，且 Phase 0 要求为整型。 */
  primaryKey: string;
}

/**
 * 页类型。
 *
 *  - `leaf` / `internal`：B+ 树的叶子页与内部页（InnoDB 与 PostgreSQL 的索引都用它）；
 *  - `heap`：PostgreSQL 风格的堆表数据页 —— 无序、由行指针数组 + 元组组成。
 */
export type PageType = 'leaf' | 'internal' | 'heap';

/** 事务隔离级别（Phase 2 实现前两级，可串行化留给 Phase 4 的锁）。 */
export type IsolationLevel = 'read-committed' | 'repeatable-read';

/** 缓冲池淘汰策略。 */
export type EvictionPolicy = 'LRU' | 'CLOCK';

/** 一个用户级命令的种类（用于事件分组与时间轴打点）。 */
export type CommandKind =
  | 'create_table'
  | 'create_index'
  | 'drop_index'
  | 'insert'
  | 'bulk_insert'
  | 'update'
  | 'delete'
  | 'search'
  | 'range_scan'
  | 'full_scan'
  | 'query'
  | 'flush'
  | 'configure'
  | 'reset'
  // Phase 2：PostgreSQL 堆表 + MVCC
  | 'begin_txn'
  | 'commit_txn'
  | 'abort_txn'
  | 'vacuum'
  | 'use_session'
  // Phase 3：LSM-Tree
  | 'flush_memtable'
  | 'compact';

/** 列的字节宽度估算，用于页填充率显示（简化模型，见 docs/architecture.md 的“简化点”）。 */
export function columnWidth(col: ColumnDef): number {
  switch (col.type) {
    case 'int':
      return 4;
    case 'bigint':
    case 'timestamp':
      return 8;
    case 'bool':
      return 1;
    case 'varchar':
      return (col.length ?? 32) + 1;
    default:
      return 8;
  }
}

/** 一条记录在页内占用的估算字节数（含 InnoDB 风格的记录头与槽位指针）。 */
export function estimateRecordBytes(schema: TableSchema | null): number {
  const RECORD_HEADER = 5;
  const SLOT_DIRECTORY_ENTRY = 2;
  if (!schema) return RECORD_HEADER + SLOT_DIRECTORY_ENTRY + 8;
  const payload = schema.columns.reduce((sum, c) => sum + columnWidth(c), 0);
  return RECORD_HEADER + SLOT_DIRECTORY_ENTRY + payload;
}

/** 内部页一个 (key, child) 条目的估算字节数。 */
export const INTERNAL_ENTRY_BYTES = 4 /* key */ + 4 /* child page no */ + 5 /* header */;

/** 页头固定开销（简化的 InnoDB FIL header + page header + trailer）。 */
export const PAGE_HEADER_BYTES = 38 + 56 + 8;
