import { Rng, columnWidth, type ColumnDef, type Key, type Row, type TableSchema } from '@dbkl/shared';
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralColumnar, StructuralSnapshot } from '../state';
import { COST, describePredicate, matchesPredicate, type PhysicalPlan, type PlanNode, type Predicate } from '../query/types';
import {
  DEFAULT_ENGINE_CONFIG,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { commandKind, commandLabel, makeRow } from './common';
import { DEFAULT_SCHEMA } from './btree-engine';

type Encoding = 'plain' | 'dictionary' | 'rle' | 'delta';

/** 一个列块：某个行组里某一列的全部值，连续存放并单独编码。 */
interface ColumnChunk {
  column: string;
  values: (Key | string | boolean | null)[];
  encoding: Encoding;
  rawBytes: number;
  encodedBytes: number;
  distinct: number;
  minValue: Key | null;
  maxValue: Key | null;
}

/** 行组：列存的最小 IO 与剪枝单位。 */
interface RowGroup {
  id: string;
  index: number;
  rows: number;
  sealed: boolean;
  chunks: Map<string, ColumnChunk>;
}

/**
 * Phase 3 续：列存引擎（ClickHouse / Parquet 风格）。
 *
 * 与前面所有引擎的根本区别：**数据按列而不是按行放**。
 * 一个行组里，每一列的值连续存成一个「列块」，于是：
 *
 *  1. **同一列的值挨在一起** ⇒ 能挑到极好的编码（基数低用字典、连续重复用 RLE），
 *     压缩比远高于行存 —— 行存里一行的各个字段类型混杂，压不动；
 *  2. **只读需要的列** ⇒ `SELECT score` 只碰 score 那些列块，其它列一个字节都不读。
 *     这是列存在分析型查询上碾压行存的唯一原因，也是本引擎最值得看的一帧；
 *  3. **区间统计（zone map）** ⇒ 每个列块记着 min/max，谓词落在区间外就整块跳过；
 *  4. **向量化执行** ⇒ 一次处理一批行，而不是一行一行地走算子。
 *
 * 代价同样明显（面板里都能看到）：
 *  - 点查一行要把它涉及的每一列都解一遍，比行存**更贵**；
 *  - 没有主键索引、没有二级索引，改一行等于重写整个行组，所以它只适合批量追加。
 */
export class ColumnarEngine implements StorageEngine {
  readonly name = 'Columnar (ClickHouse-like)';
  readonly capabilities: readonly EngineCapability[] = ['columnar', 'zone-map', 'vectorized'];

  config: EngineConfig;

  private rowGroups: RowGroup[] = [];
  /** 还没攒满的那一批行（写缓冲）。 */
  private pending: Row[] = [];
  private nextGroupId = 1;
  private schema: TableSchema | null = null;
  private rng: Rng;

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
  }

  get eventCount(): number {
    return this.seq;
  }

  emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
  }

  execute(command: Command): SimulationEvent[] {
    this.out = [];
    this.cmdId++;
    const label = commandLabel(command);
    this.emit({ type: 'COMMAND_BEGIN', kind: commandKind(command), label });

    let note: string | undefined;
    let ok = true;
    try {
      note = this.dispatch(command);
    } catch (err) {
      ok = false;
      note = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'NOTE', message: note, level: 'error' });
    }

    this.emit({ type: 'COMMAND_END', kind: commandKind(command), label, ok, note });
    return this.out;
  }

  private dispatch(command: Command): string | undefined {
    switch (command.kind) {
      case 'create_table':
        return this.createTable(command.schema);
      case 'insert': {
        const row = command.row ?? makeRow(this.schema ?? DEFAULT_SCHEMA, command.key);
        this.append(row);
        return `追加一行 key=${command.key}（进写缓冲，攒满 ${this.config.rowGroupSize} 行才切成列块落盘）`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'flush_all':
      case 'flush_memtable':
        return this.sealPending(true);
      case 'search':
        return this.pointLookup(command.key);
      case 'range_scan':
        return this.runScan({ kind: 'range', column: this.pk(), from: command.from, to: command.to }, '*');
      case 'full_scan':
        return this.runScan({ kind: 'all' }, '*');
      case 'query':
        return this.runScan(command.predicate, command.columns ?? '*');
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（行组大小变化只影响之后写入的行组）';
      }
      case 'update':
      case 'delete':
        throw new Error(
          '列存不支持原地更新 / 删除：改一行要重写整个行组。分析型系统通常靠「批量追加 + 后台合并」处理变更（见路线图）',
        );
      case 'create_index':
      case 'drop_index':
        throw new Error('列存没有二级索引：它靠区间统计（zone map）整块跳过，而不是靠索引定位单行');
      default:
        throw new Error(`列存引擎不支持命令 ${command.kind}`);
    }
  }

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    return `表 ${schema.name} 已创建（列存：${schema.columns.length} 列各自独立存放）`;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  private pk(): string {
    return (this.schema ?? DEFAULT_SCHEMA).primaryKey;
  }

  // ——— 写路径：攒够一批才切列 ————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.totalRows() + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      this.append(makeRow(this.schema!, key));
    }
    return `批量追加 ${count} 行（${pattern}）—— 列存只擅长这种成批写入`;
  }

  private append(row: Row): void {
    this.ensureTable();
    this.pending.push(structuredClone(row));
    if (this.pending.length >= this.config.rowGroupSize) this.sealPending(false);
  }

  /** 把写缓冲切成列块落盘。这是「行 → 列」转置真正发生的地方。 */
  private sealPending(manual: boolean): string {
    if (this.pending.length === 0) return manual ? '写缓冲是空的，无需落盘' : '';
    const schema = this.schema!;
    const id = `rg-${this.nextGroupId}`;
    const index = this.nextGroupId - 1;
    this.nextGroupId++;

    this.emit({ type: 'ROW_GROUP_OPEN', rowGroupId: id, index, capacity: this.config.rowGroupSize });
    const group: RowGroup = { id, index, rows: this.pending.length, sealed: false, chunks: new Map() };

    let rawTotal = 0;
    let encodedTotal = 0;
    for (const col of schema.columns) {
      const values = this.pending.map((r) => r[col.name] ?? null);
      const chunk = encodeChunk(col, values, this.config.columnEncoding);
      group.chunks.set(col.name, chunk);
      rawTotal += chunk.rawBytes;
      encodedTotal += chunk.encodedBytes;
      this.emit({
        type: 'COLUMN_CHUNK_WRITE',
        rowGroupId: id,
        column: col.name,
        rows: chunk.values.length,
        encoding: chunk.encoding,
        rawBytes: chunk.rawBytes,
        encodedBytes: chunk.encodedBytes,
        distinct: chunk.distinct,
        minValue: this.config.zoneMaps ? chunk.minValue : null,
        maxValue: this.config.zoneMaps ? chunk.maxValue : null,
      });
    }

    group.sealed = true;
    this.rowGroups.push(group);
    this.pending = [];
    this.emit({ type: 'ROW_GROUP_SEAL', rowGroupId: id, rows: group.rows, rawBytes: rawTotal, encodedBytes: encodedTotal });
    return manual ? `写缓冲落盘成行组 ${id}（${group.rows} 行，${rawTotal}→${encodedTotal} B）` : '';
  }

  // ——— 读路径：列裁剪 + 区间剪枝 + 向量化 ————————————

  /**
   * 扫描。三件事按顺序发生，缺一不可：
   *
   * 1. **列裁剪**：只读查询真正用到的列（谓词列 + 投影列）；
   * 2. **区间剪枝**：谓词列的 min/max 落在查询区间外 ⇒ 整个行组跳过，一个字节不读；
   * 3. **向量化**：剩下的行组按批解码、批量判谓词。
   */
  private runScan(predicate: Predicate, columns: string[] | '*'): string {
    this.ensureTable();
    this.sealPending(false); // 查询前先把写缓冲落盘，保证读到全部数据
    const schema = this.schema!;
    const allColumns = schema.columns.map((c) => c.name);
    const projected = columns === '*' ? allColumns : columns;
    const predicateColumn = predicate.kind === 'all' ? null : predicate.column;
    // 需要触碰的列 = 谓词列 ∪ 投影列。这就是「列裁剪」。
    const needed = [...new Set([...(predicateColumn ? [predicateColumn] : []), ...projected])].filter((c) =>
      allColumns.includes(c),
    );

    const plan = this.buildPlan(predicate, projected, needed);
    this.emit({ type: 'PLAN_READY', plan });
    const nodes = collectNodes(plan.root);
    for (const n of nodes) this.emit({ type: 'OPERATOR_OPEN', nodeId: n.id, op: n.op, detail: n.detail });
    const scanNode = nodes.find((n) => n.op === 'SeqScan')!;
    const filterNode = nodes.find((n) => n.op === 'Filter');
    const projectNode = nodes.find((n) => n.op === 'Project')!;
    const counts = new Map<string, number>();
    const bump = (nodeId: string, key: Key, emitted: boolean) => {
      if (emitted) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      this.emit({ type: 'OPERATOR_ROW', nodeId, key, emitted });
    };

    let matched = 0;
    let scanned = 0;
    let skipped = 0;
    let bytesRead = 0;
    // 行存做同样的查询要读的字节数：所有行组的**所有列**。
    const bytesIfRowStore = this.rowGroups.reduce(
      (n, g) => n + [...g.chunks.values()].reduce((m, c) => m + c.encodedBytes, 0),
      0,
    );

    for (const group of this.rowGroups) {
      // ① 区间剪枝
      if (this.config.zoneMaps && predicateColumn) {
        const chunk = group.chunks.get(predicateColumn);
        if (chunk && chunk.minValue !== null && chunk.maxValue !== null && !zoneOverlaps(predicate, chunk)) {
          this.emit({
            type: 'ZONE_MAP_SKIP',
            rowGroupId: group.id,
            column: predicateColumn,
            minValue: chunk.minValue,
            maxValue: chunk.maxValue,
            reason: `与 ${describePredicate(predicate)} 无交集`,
          });
          skipped++;
          continue;
        }
      }
      scanned++;

      // ② 列裁剪：只读需要的列块
      for (const column of needed) {
        const chunk = group.chunks.get(column);
        if (!chunk) continue;
        bytesRead += chunk.encodedBytes;
        this.emit({
          type: 'COLUMN_READ',
          rowGroupId: group.id,
          column,
          rows: chunk.values.length,
          bytes: chunk.encodedBytes,
        });
      }

      // ③ 向量化：按批判谓词
      const keyChunk = group.chunks.get(this.pk());
      const predChunk = predicateColumn ? group.chunks.get(predicateColumn) : undefined;
      const batch = Math.max(1, this.config.vectorBatchSize);
      for (let start = 0; start < group.rows; start += batch) {
        const end = Math.min(start + batch, group.rows);
        let batchMatched = 0;
        for (let i = start; i < end; i++) {
          const key = Number(keyChunk?.values[i] ?? i);
          const value = predChunk ? predChunk.values[i] : undefined;
          const pass = matchesPredicate(predicate, typeof value === 'number' ? value : undefined);
          bump(scanNode.id, key, true);
          if (filterNode) bump(filterNode.id, key, pass);
          if (pass) {
            bump(projectNode.id, key, true);
            batchMatched++;
            matched++;
          }
        }
        this.emit({ type: 'VECTOR_BATCH', rowGroupId: group.id, rows: end - start, matched: batchMatched });
      }
    }

    for (const n of [...nodes].reverse()) {
      this.emit({ type: 'OPERATOR_CLOSE', nodeId: n.id, actualRows: counts.get(n.id) ?? 0 });
    }
    this.emit({ type: 'SCAN_END', rows: matched, pagesTouched: scanned });

    const saved = bytesIfRowStore === 0 ? 0 : 1 - bytesRead / bytesIfRowStore;
    return `扫描返回 ${matched} 行：读了 ${needed.length}/${allColumns.length} 列、${scanned} 个行组（跳过 ${skipped} 个），${bytesRead} B —— 行存要读 ${bytesIfRowStore} B，省了 ${(saved * 100).toFixed(0)}%`;
  }

  /**
   * 点查一行。
   *
   * 列存做这件事**比行存贵**：没有主键索引，只能靠 zone map 缩小范围，
   * 然后把这一行涉及的每一列都解一遍。面板里对照 InnoDB 的一次树下降就明白了。
   */
  private pointLookup(key: Key): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const note = this.runScan({ kind: 'eq', column: this.pk(), value: key }, '*');
    return `点查 key=${key} —— 列存没有主键索引，只能靠区间统计缩小范围再逐列解码。${note}`;
  }

  private buildPlan(predicate: Predicate, projected: string[], needed: string[]): PhysicalPlan {
    const rows = this.totalRows();
    const allColumns = (this.schema ?? DEFAULT_SCHEMA).columns.length;
    const scan: PlanNode = {
      id: 'n0',
      op: 'SeqScan',
      detail: `列裁剪：只读 ${needed.length}/${allColumns} 列（${needed.join(', ')}）· ${this.rowGroups.length} 个行组`,
      estRows: rows,
      estCost: Math.max(1, this.rowGroups.length) * (needed.length / Math.max(1, allColumns)) * COST.pageIO,
      children: [],
    };
    let node: PlanNode = scan;
    if (predicate.kind !== 'all') {
      node = {
        id: 'n1',
        op: 'Filter',
        detail: `${describePredicate(predicate)}（向量化，每批 ${this.config.vectorBatchSize} 行${
          this.config.zoneMaps ? '；区间统计可整组跳过' : ''
        }）`,
        estRows: Math.max(1, Math.round(rows / 10)),
        estCost: scan.estCost + rows * COST.rowCpu,
        children: [scan],
      };
    }
    const root: PlanNode = {
      id: 'n2',
      op: 'Project',
      detail: projected.join(', '),
      estRows: node.estRows,
      estCost: node.estCost,
      children: [node],
    };
    return {
      root,
      predicate,
      chosen: `列式扫描 · 只读 ${needed.length}/${allColumns} 列${this.config.zoneMaps ? ' + 区间统计剪枝' : ''}`,
      candidates: [
        {
          label: `列式扫描（读 ${needed.length}/${allColumns} 列）`,
          strategy: 'seq-scan',
          estRows: node.estRows,
          estCost: node.estCost,
          needsLookup: false,
          chosen: true,
          reason: '列存没有索引可选，但可以少读很多列',
        },
      ],
      columns: projected,
    };
  }

  private totalRows(): number {
    return this.rowGroups.reduce((n, g) => n + g.rows, 0) + this.pending.length;
  }

  // ——— 结构投影 ————————————————————————————————————————

  snapshot(): StructuralSnapshot {
    return {
      indexes: {},
      recordCount: this.rowGroups.reduce((n, g) => n + g.rows, 0),
      pages: {},
      bufferFrames: new Array<null>(Math.max(1, this.config.bufferPoolFrames)).fill(null),
      bufferRecency: [],
      columnar: this.projectColumnar(),
    };
  }

  private projectColumnar(): StructuralColumnar {
    return {
      columns: (this.schema ?? DEFAULT_SCHEMA).columns.map((c) => c.name),
      rowGroups: this.rowGroups.map((g) => ({
        id: g.id,
        rows: g.rows,
        sealed: g.sealed,
        chunks: [...g.chunks.values()]
          .map((c) => ({
            column: c.column,
            rows: c.values.length,
            encoding: c.encoding as string,
            distinct: c.distinct,
            minValue: this.config.zoneMaps ? c.minValue : null,
            maxValue: this.config.zoneMaps ? c.maxValue : null,
          }))
          .sort((a, b) => a.column.localeCompare(b.column)),
      })),
    };
  }

  /** 仅供测试：按写入顺序还原出的全部行键。 */
  allKeys(): Key[] {
    const pk = this.pk();
    const out: Key[] = [];
    for (const g of this.rowGroups) {
      const chunk = g.chunks.get(pk);
      if (chunk) out.push(...chunk.values.map((v) => Number(v)));
    }
    out.push(...this.pending.map((r) => Number(r[pk])));
    return out;
  }

  /** 仅供测试：整体压缩比（原始字节 / 编码后字节）。 */
  compressionRatio(): number {
    let raw = 0;
    let encoded = 0;
    for (const g of this.rowGroups) {
      for (const c of g.chunks.values()) {
        raw += c.rawBytes;
        encoded += c.encodedBytes;
      }
    }
    return encoded === 0 ? Number.NaN : raw / encoded;
  }
}

/**
 * 给一个列块挑编码并算出编码后大小。
 *
 * 规则刻意做成「一眼能推」的样子，方便对照事件日志理解为什么选了这种编码：
 *  - **RLE**：连续重复的段落很少（游程数 ≤ 一半行数）⇒ 只存 (值, 重复次数)；
 *  - **字典**：不同值很少（基数 ≤ 一半行数）⇒ 存字典 + 每行一个小下标；
 *  - **delta**：整型且严格递增（自增主键就是这样）⇒ 只存首值与差值；
 *  - **plain**：以上都不划算，原样存。
 *
 * 这正是列存压缩比高的原因：**同一列的值同质**，所以总能找到一种便宜的表达；
 * 行存里一行的各个字段类型混杂，压不动。
 */
function encodeChunk(col: ColumnDef, values: (Key | string | boolean | null)[], mode: EngineConfig['columnEncoding']): ColumnChunk {
  const width = columnWidth(col);
  const rows = values.length;
  const rawBytes = width * rows;
  const distinct = new Set(values.map((v) => String(v))).size;

  const runs = countRuns(values);
  const numeric = values.every((v) => typeof v === 'number');
  const ascending = numeric && values.every((v, i) => i === 0 || (v as number) > (values[i - 1] as number));

  let encoding: Encoding = 'plain';
  if (mode === 'plain') encoding = 'plain';
  else if (mode === 'rle') encoding = 'rle';
  else if (mode === 'dictionary') encoding = 'dictionary';
  else if (runs <= rows / 2) encoding = 'rle';
  else if (ascending) encoding = 'delta';
  else if (distinct <= rows / 2) encoding = 'dictionary';

  let encodedBytes: number;
  switch (encoding) {
    case 'rle':
      // 每个游程存 (值, 次数)
      encodedBytes = runs * (width + 2);
      break;
    case 'dictionary': {
      // 字典项 + 每行一个下标（下标宽度按基数取 1/2 字节）
      const codeWidth = distinct <= 256 ? 1 : 2;
      encodedBytes = distinct * width + rows * codeWidth;
      break;
    }
    case 'delta':
      // 首值全宽 + 其余存差值（这里按 1 字节估算，自增主键差值都很小）
      encodedBytes = width + Math.max(0, rows - 1);
      break;
    default:
      encodedBytes = rawBytes;
  }
  // 编码不可能比原样更大：真实实现同样会在这种情况下回落 plain。
  if (encodedBytes >= rawBytes) {
    encoding = 'plain';
    encodedBytes = rawBytes;
  }

  const numbers = values.filter((v): v is number => typeof v === 'number');
  return {
    column: col.name,
    values: values.slice(),
    encoding,
    rawBytes,
    encodedBytes,
    distinct,
    minValue: numbers.length > 0 ? Math.min(...numbers) : null,
    maxValue: numbers.length > 0 ? Math.max(...numbers) : null,
  };
}

/** 连续相同值的段落数（游程数）。 */
function countRuns(values: (Key | string | boolean | null)[]): number {
  if (values.length === 0) return 0;
  let runs = 1;
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) runs++;
  return runs;
}

/** 谓词区间与列块的 [min, max] 是否有交集。没有交集就能整块跳过。 */
function zoneOverlaps(predicate: Predicate, chunk: ColumnChunk): boolean {
  if (predicate.kind === 'all') return true;
  if (chunk.minValue === null || chunk.maxValue === null) return true;
  if (predicate.kind === 'eq') return predicate.value >= chunk.minValue && predicate.value <= chunk.maxValue;
  return predicate.to >= chunk.minValue && predicate.from <= chunk.maxValue;
}

function collectNodes(root: PlanNode): PlanNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}
