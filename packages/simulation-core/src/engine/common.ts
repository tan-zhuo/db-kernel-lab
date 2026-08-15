import type { CommandKind, Key, Row, TableSchema } from '@dbkl/shared';
import type { Command } from './types';

/**
 * 引擎之间共享的小工具：命令 → 种类 / 标签，以及演示行的生成。
 *
 * 三个引擎（InnoDB / PostgreSQL 堆表 / LSM）吃同一套 `Command`，
 * 因此这些映射必须只有一份，否则时间轴上同一条命令在不同引擎里会显示成两种样子。
 */

const CITIES = ['Beijing', 'Shanghai', 'Hangzhou', 'Shenzhen', 'Chengdu', 'Xian'];
const NAMES = ['ada', 'brin', 'codd', 'dean', 'edgar', 'fay', 'gray', 'hoare', 'ingres', 'jim'];

/**
 * 由主键确定性地生成一行演示数据。
 *
 * 必须是纯函数：会话恢复靠「重放命令日志」，同一个 key 两次生成的行必须逐字段相同。
 */
export function makeRow(schema: TableSchema, key: Key): Row {
  const row: Row = {};
  for (const col of schema.columns) {
    if (col.name === schema.primaryKey) {
      row[col.name] = key;
      continue;
    }
    switch (col.type) {
      case 'varchar':
        row[col.name] = col.name === 'city' ? CITIES[key % CITIES.length] : `${NAMES[key % NAMES.length]}-${key}`;
        break;
      case 'bool':
        row[col.name] = key % 2 === 0;
        break;
      case 'timestamp':
        row[col.name] = 1700000000 + key * 3600;
        break;
      default:
        row[col.name] = (key * 7919) % 100;
    }
  }
  return row;
}

/** 同一个 key 的「第 n 次更新」版本：用于观察 MVCC 版本链与 LSM 的多版本覆盖。 */
export function bumpRow(schema: TableSchema, key: Key, generation: number): Row {
  const row = makeRow(schema, key);
  for (const col of schema.columns) {
    if (col.name === schema.primaryKey) continue;
    if (col.type === 'int' || col.type === 'bigint') {
      row[col.name] = (Number(row[col.name]) + generation * 13) % 100;
      break;
    }
  }
  return row;
}

export function commandKind(c: Command): CommandKind {
  switch (c.kind) {
    case 'bulk_insert':
      return 'bulk_insert';
    case 'flush_all':
      return 'flush';
    case 'full_scan':
      return 'full_scan';
    case 'range_scan':
      return 'range_scan';
    default:
      return c.kind;
  }
}

export function commandLabel(c: Command): string {
  switch (c.kind) {
    case 'create_table':
      return `CREATE TABLE ${c.schema.name}`;
    case 'create_index':
      return `CREATE INDEX ${c.name} ON (${c.column})`;
    case 'drop_index':
      return `DROP INDEX ${c.name}`;
    case 'insert':
      return `INSERT key=${c.key}`;
    case 'bulk_insert':
      return `BULK INSERT ×${c.count} (${c.pattern})`;
    case 'update':
      return `UPDATE key=${c.key}`;
    case 'delete':
      return `DELETE key=${c.key}`;
    case 'search':
      return `SELECT … WHERE pk=${c.key}`;
    case 'range_scan':
      return `SELECT … WHERE pk BETWEEN ${c.from} AND ${c.to}`;
    case 'full_scan':
      return 'SELECT … (full index scan)';
    case 'query': {
      const cols = !c.columns || c.columns === '*' ? '*' : c.columns.join(', ');
      const where =
        c.predicate.kind === 'all'
          ? ''
          : c.predicate.kind === 'eq'
            ? ` WHERE ${c.predicate.column} = ${c.predicate.value}`
            : ` WHERE ${c.predicate.column} BETWEEN ${c.predicate.from} AND ${c.predicate.to}`;
      return `SELECT ${cols}${where}`;
    }
    case 'flush_all':
      return 'FLUSH DIRTY PAGES';
    case 'configure':
      return `SET ${Object.keys(c.patch).join(', ')}`;
    case 'begin_txn':
      return `BEGIN${c.isolation ? ` ISOLATION LEVEL ${c.isolation === 'repeatable-read' ? 'REPEATABLE READ' : 'READ COMMITTED'}` : ''}`;
    case 'commit_txn':
      return 'COMMIT';
    case 'abort_txn':
      return 'ROLLBACK';
    case 'vacuum':
      return c.full ? 'VACUUM FULL' : 'VACUUM';
    case 'use_session':
      return `\\c 会话 ${c.session}`;
    case 'flush_memtable':
      return 'FLUSH MEMTABLE → L0';
    case 'compact':
      return c.level === undefined ? 'COMPACT (自动选层)' : `COMPACT L${c.level} → L${c.level + 1}`;
    case 'run_background':
      return `推进后台任务${c.jobs ? ` ×${c.jobs}` : ''}`;
    case 'crash':
      return '💥 CRASH + RECOVER FROM WAL';
    default: {
      const never: never = c;
      void never;
      return 'UNKNOWN';
    }
  }
}
