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

/** 页类型。Phase 0 只有 B+ 树的内部页与叶子页。 */
export type PageType = 'leaf' | 'internal';

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
  | 'reset';

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
