import {
  Rng,
  assert,
  type Key,
  type PageId,
  type Row,
  type TableSchema,
} from '@dbkl/shared';
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralSnapshot } from '../state';
import { buildPlan } from '../query/planner';
import {
  matchesPredicate,
  type IndexStats,
  type PhysicalPlan,
  type PlanNode,
  type Predicate,
} from '../query/types';
import {
  DEFAULT_ENGINE_CONFIG,
  PRIMARY_INDEX_ID,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { BufferPool } from './buffer-pool';
import { BPlusTree, type AccessPurpose, type TreeHost, type TreeNode } from './bplus-tree';
import { commandKind, commandLabel, makeRow } from './common';

export const DEFAULT_SCHEMA: TableSchema = {
  name: 'users',
  columns: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'varchar', length: 32 },
    { name: 'city', type: 'varchar', length: 16 },
    { name: 'score', type: 'int' },
  ],
  primaryKey: 'id',
};

/**
 * Phase 1 引擎：聚簇 B+ 树 + 二级索引 + Buffer Pool + 简易代价优化器。
 *
 * 语义参照 InnoDB：
 *  - 聚簇索引叶子页承载完整行，叶子页之间双向链表相连；
 *  - 二级索引叶子项是 (索引列, 主键)，因此非覆盖查询必须回表；
 *  - 二级索引允许重复键，重复键之间按主键排序（等价于 InnoDB 的 (col, pk) 复合键）；
 *  - 每次 DML 都要维护所有索引 —— 索引越多写放大越明显。
 *
 * 与真实 InnoDB 的差异见 docs/architecture.md「简化点」。
 */
export class BTreeEngine implements StorageEngine, TreeHost {
  readonly name = 'InnoDB-like Clustered B+Tree';
  readonly capabilities: readonly EngineCapability[] = [
    'btree',
    'clustered-index',
    'secondary-index',
    'buffer-pool',
  ];

  config: EngineConfig;

  readonly nodes = new Map<PageId, TreeNode>();
  private indexes = new Map<string, BPlusTree>();
  private nextPageId = 1;
  private schema: TableSchema | null = null;
  private buffer: BufferPool;
  private rng: Rng;

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.buffer = new BufferPool(this.config, {
      emit: (body) => this.emit(body),
      isDirty: (id) => this.nodes.get(id)?.dirty ?? false,
      onFlushed: (id) => {
        const n = this.nodes.get(id);
        if (n) n.dirty = false;
      },
      exists: (id) => this.nodes.has(id),
    });
  }

  get eventCount(): number {
    return this.seq;
  }

  // ——— TreeHost 实现 ————————————————————————————————

  allocPageId(): PageId {
    return this.nextPageId++;
  }

  access(pageId: PageId, purpose: AccessPurpose): void {
    this.buffer.access(pageId);
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  forgetPage(pageId: PageId): void {
    this.buffer.forget(pageId);
  }

  /** 重复键之间按主键排序 —— 等价于 InnoDB 的 (列, 主键) 复合键。 */
  tieBreak(row: Row | null | undefined): number {
    if (!row || !this.schema) return Number.NEGATIVE_INFINITY;
    const v = row[this.schema.primaryKey];
    return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
  }

  emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
  }

  // ——— 命令入口 ————————————————————————————————————————

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
      case 'create_index':
        return this.createIndex(command.name, command.column);
      case 'drop_index':
        return this.dropIndex(command.name);
      case 'insert': {
        const row = command.row ?? makeRow(this.schema ?? DEFAULT_SCHEMA, command.key);
        const res = this.insertRecord(command.key, row);
        return res === 'updated' ? `key=${command.key} 已存在，执行更新` : `插入 key=${command.key}`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'update': {
        const res = this.insertRecord(command.key, command.row);
        return res === 'updated' ? `更新 key=${command.key}` : `key=${command.key} 不存在，已按插入处理`;
      }
      case 'delete':
        return this.deleteRecord(command.key);
      case 'search': {
        const found = this.pointSearch(command.key);
        return found ? `命中 key=${command.key}` : `未找到 key=${command.key}`;
      }
      case 'range_scan':
        return this.rangeScan(command.from, command.to);
      case 'full_scan':
        return this.rangeScan(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 'full');
      case 'query':
        return this.runQuery(command.predicate, command.columns ?? '*', command.hint ?? 'auto');
      case 'flush_all': {
        const n = this.buffer.flushAll('manual');
        return `刷盘 ${n} 个脏页`;
      }
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.buffer.reconfigure(this.config);
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（阶数变化不会重排已有页，请重置以重建）';
      }
      default:
        throw new Error(`InnoDB 引擎不支持命令 ${command.kind}（它属于其它引擎的能力）`);
    }
  }

  // ——— DDL ——————————————————————————————————————————————

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    this.newIndexTree(PRIMARY_INDEX_ID, 'PRIMARY', schema.primaryKey, true, true);
    return `表 ${schema.name} 已创建（聚簇索引 PRIMARY(${schema.primaryKey})）`;
  }

  private createIndex(name: string, column: string): string {
    this.ensureTable();
    assert(!this.indexes.has(name), `索引 ${name} 已存在`);
    assert(
      this.schema!.columns.some((c) => c.name === column),
      `列 ${column} 不存在于表 ${this.schema!.name}`,
    );
    assert(column !== this.schema!.primaryKey, '主键已由聚簇索引覆盖，无需再建二级索引');
    const columnType = this.schema!.columns.find((c) => c.name === column)!.type;
    assert(
      columnType !== 'varchar',
      `Phase 1 的索引键只支持数值列，${column} 是 varchar（字符串键需要通用比较器，见 Phase 2 计划）`,
    );

    const ix = this.newIndexTree(name, name, column, false, false);
    // 在线建索引：顺序扫描聚簇索引叶子，把 (列值, 主键) 灌进新树。
    const clustered = this.index(PRIMARY_INDEX_ID);
    let cursor: PageId | null = clustered.firstLeafId;
    let built = 0;
    if (clustered.entries > 0) this.access(cursor!, 'scan');
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (let i = 0; i < leaf.keys.length; i++) {
        const row = leaf.rows[i];
        if (!row) continue;
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot: i, key: leaf.keys[i], row, emitted: true });
        const value = Number(row[column] ?? 0);
        ix.insert(value, this.secondaryEntry(column, value, leaf.keys[i]), 'duplicates');
        built++;
      }
      cursor = leaf.next;
      if (cursor !== null) this.access(cursor, 'scan');
    }
    ix.emitStats();
    return `索引 ${name}(${column}) 创建完成，灌入 ${built} 条索引项`;
  }

  private dropIndex(name: string): string {
    assert(name !== PRIMARY_INDEX_ID, '聚簇索引不可删除');
    const ix = this.indexes.get(name);
    assert(ix !== undefined, `索引 ${name} 不存在`);
    const freed = ix.dropAllPages();
    this.indexes.delete(name);
    this.emit({ type: 'INDEX_DROP', indexId: name });
    return `索引 ${name} 已删除，回收 ${freed} 个页`;
  }

  private newIndexTree(id: string, name: string, column: string, clustered: boolean, unique: boolean): BPlusTree {
    const tree = new BPlusTree(this, { id, name, column, clustered, unique });
    this.indexes.set(id, tree);
    return tree;
  }

  // ——— DML ——————————————————————————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.index(PRIMARY_INDEX_ID).entries + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    let inserted = 0;
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      const res = this.insertRecord(key, makeRow(this.schema ?? DEFAULT_SCHEMA, key));
      if (res === 'inserted') inserted++;
    }
    return `批量插入 ${count} 次，新增 ${inserted} 行（${pattern}）`;
  }

  private insertRecord(key: Key, row: Row): 'inserted' | 'updated' {
    this.ensureTable();
    const clustered = this.index(PRIMARY_INDEX_ID);
    const { result, oldRow } = clustered.insert(key, row, 'unique');

    // 维护所有二级索引：这正是「索引越多写越慢」的来源。
    for (const ix of this.secondaryIndexes()) {
      const newValue = Number(row[ix.column] ?? 0);
      if (result === 'updated') {
        const oldValue = Number(oldRow?.[ix.column] ?? 0);
        if (oldValue === newValue) continue;
        ix.remove(oldValue, key);
      }
      ix.insert(newValue, this.secondaryEntry(ix.column, newValue, key), 'duplicates');
    }
    return result;
  }

  private deleteRecord(key: Key): string {
    this.ensureTable();
    const removed = this.index(PRIMARY_INDEX_ID).remove(key);
    if (removed === undefined) {
      this.emit({ type: 'SEARCH_RESULT', key, found: false, pageId: null, slot: -1 });
      return `key=${key} 不存在`;
    }
    // 行没了，指向它的二级索引项也必须删掉。
    for (const ix of this.secondaryIndexes()) {
      ix.remove(Number(removed?.[ix.column] ?? 0), key);
    }
    return `删除 key=${key}`;
  }

  // ——— 查询 ————————————————————————————————————————————

  private pointSearch(key: Key): boolean {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const hit = this.index(PRIMARY_INDEX_ID).findEntry(key, 'search');
    this.emit({
      type: 'SEARCH_RESULT',
      key,
      found: hit !== null,
      pageId: hit?.pageId ?? null,
      slot: hit?.slot ?? -1,
    });
    return hit !== null;
  }

  private rangeScan(from: Key, to: Key, mode: 'range' | 'full' = 'range'): string {
    this.ensureTable();
    const ix = this.index(PRIMARY_INDEX_ID);
    this.emit({ type: 'SEARCH_BEGIN', key: Number.isFinite(from) ? from : 0, mode });
    let leafId: PageId;
    if (mode === 'full') {
      leafId = ix.firstLeafId;
      this.access(leafId, 'scan');
    } else {
      leafId = ix.descend(from, 'scan');
    }

    let rows = 0;
    const touched = new Set<PageId>();
    ix.walkLeaves(leafId, (leaf, slot, key, row) => {
      touched.add(leaf.id);
      if (key > to) return 'stop';
      const emitted = key >= from;
      this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot, key, row, emitted });
      if (emitted) rows++;
      return 'continue';
    });
    this.emit({ type: 'SCAN_END', rows, pagesTouched: touched.size });
    return `扫描返回 ${rows} 行，触达 ${touched.size} 个叶子页`;
  }

  /**
   * 走完整的「优化器 → 物理计划 → 算子执行」流程。
   * 这是 Phase 1 里唯一会产生 PLAN_* / OPERATOR_* 事件的入口。
   */
  private runQuery(predicate: Predicate, columns: string[] | '*', hint: string): string {
    this.ensureTable();
    const stats = this.collectStats(predicate);
    for (const s of stats) {
      this.emit({
        type: 'INDEX_STATS',
        indexId: s.indexId,
        entries: s.entries,
        distinct: s.distinct,
        minKey: s.minKey,
        maxKey: s.maxKey,
      });
    }

    const plan = buildPlan({
      table: this.schema!.name,
      primaryKey: this.schema!.primaryKey,
      predicate,
      columns,
      stats,
      hint,
    });
    this.emit({ type: 'PLAN_READY', plan });

    const rows = this.executePlan(plan);
    const estimated = plan.root.estRows;
    return `${plan.chosen}；估算 ${estimated} 行 / 实际 ${rows} 行`;
  }

  private executePlan(plan: PhysicalPlan): number {
    const nodes = collectNodes(plan.root);
    for (const n of nodes) this.emit({ type: 'OPERATOR_OPEN', nodeId: n.id, op: n.op, detail: n.detail });

    const counts = new Map<string, number>();
    const bump = (nodeId: string, key: Key, emitted: boolean) => {
      if (emitted) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      this.emit({ type: 'OPERATOR_ROW', nodeId, key, emitted });
    };

    const scan = nodes.find((n) => n.op === 'TableScan');
    const seek = nodes.find((n) => n.op === 'IndexSeek' || n.op === 'IndexRangeScan');
    const lookup = nodes.find((n) => n.op === 'RowIdLookup');
    const filter = nodes.find((n) => n.op === 'Filter');
    const project = nodes.find((n) => n.op === 'Project')!;

    let output = 0;

    if (scan) {
      const ix = this.index(PRIMARY_INDEX_ID);
      this.access(ix.firstLeafId, 'scan');
      ix.walkLeaves(ix.firstLeafId, (leaf, slot, key, row) => {
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot, key, row, emitted: true });
        bump(scan.id, key, true);
        const value = this.columnValue(row, plan.predicate);
        const pass = matchesPredicate(plan.predicate, value);
        if (filter) bump(filter.id, key, pass);
        if (pass) {
          bump(project.id, key, true);
          output++;
        }
        return 'continue';
      });
    } else if (seek) {
      const ix = this.index(seek.indexId ?? PRIMARY_INDEX_ID);
      const from =
        plan.predicate.kind === 'eq'
          ? plan.predicate.value
          : plan.predicate.kind === 'range'
            ? plan.predicate.from
            : Number.NEGATIVE_INFINITY;
      const to =
        plan.predicate.kind === 'eq'
          ? plan.predicate.value
          : plan.predicate.kind === 'range'
            ? plan.predicate.to
            : Number.POSITIVE_INFINITY;
      const startLeaf = ix.descend(from, 'search');

      const pending: { pageId: PageId; slot: number; key: Key; pk: Key }[] = [];
      ix.walkLeaves(startLeaf, (leaf, slot, key, row) => {
        if (key > to) return 'stop';
        if (key < from) return 'continue';
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot, key, row, emitted: true });
        bump(seek.id, key, true);
        pending.push({ pageId: leaf.id, slot, key, pk: ix.clustered ? key : this.tieBreak(row) });
        return 'continue';
      });

      for (const entry of pending) {
        if (lookup) {
          // 回表：拿二级索引叶子项里的主键，回聚簇索引再走一次完整下降。
          this.emit({
            type: 'LOOKUP_BACK',
            indexId: ix.id,
            fromPageId: entry.pageId,
            fromSlot: entry.slot,
            indexKey: entry.key,
            primaryKey: entry.pk,
          });
          const hit = this.index(PRIMARY_INDEX_ID).findEntry(entry.pk, 'search');
          this.emit({
            type: 'LOOKUP_DONE',
            fromPageId: entry.pageId,
            toPageId: hit?.pageId ?? null,
            slot: hit?.slot ?? -1,
            primaryKey: entry.pk,
            found: hit !== null,
          });
          bump(lookup.id, entry.pk, hit !== null);
          if (hit === null) continue;
        }
        bump(project.id, entry.pk, true);
        output++;
      }
    }

    for (const n of [...nodes].reverse()) {
      this.emit({ type: 'OPERATOR_CLOSE', nodeId: n.id, actualRows: counts.get(n.id) ?? 0 });
    }
    return output;
  }

  private columnValue(row: Row | null, predicate: Predicate): Key | undefined {
    if (predicate.kind === 'all' || !row) return undefined;
    const v = row[predicate.column];
    return typeof v === 'number' ? v : undefined;
  }

  private collectStats(predicate: Predicate): IndexStats[] {
    const relevant = [...this.indexes.values()].filter(
      (ix) => ix.clustered || predicate.kind === 'all' || ix.column === predicate.column,
    );
    return relevant.map((ix) => ({
      indexId: ix.id,
      name: ix.name,
      column: ix.column,
      clustered: ix.clustered,
      unique: ix.unique,
      height: ix.height,
      leafPages: Math.max(1, ix.leafPageCount()),
      entries: ix.entries,
      distinct: Math.max(1, ix.distinct),
      minKey: ix.minKey,
      maxKey: ix.maxKey,
    }));
  }

  // ——— 辅助 ————————————————————————————————————————————

  private node(id: PageId): TreeNode {
    const n = this.nodes.get(id);
    assert(n !== undefined, `page #${id} does not exist`);
    return n;
  }

  private index(id: string): BPlusTree {
    const ix = this.indexes.get(id);
    assert(ix !== undefined, `索引 ${id} 不存在`);
    return ix;
  }

  private secondaryIndexes(): BPlusTree[] {
    return [...this.indexes.values()].filter((ix) => !ix.clustered);
  }

  /** 二级索引叶子项：(索引列, 主键) —— 与 InnoDB 一致，不含其它列。 */
  private secondaryEntry(column: string, value: Key, primaryKey: Key): Row {
    return { [column]: value, [this.schema!.primaryKey]: primaryKey };
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  // ——— 测试/调试用的结构投影 ————————————————————————

  snapshot(): StructuralSnapshot {
    const pages: StructuralSnapshot['pages'] = {};
    for (const [id, n] of this.nodes) {
      pages[id] = {
        id,
        indexId: n.indexId,
        type: n.type,
        level: n.level,
        parentId: n.parentId,
        keys: n.keys.slice(),
        rows: structuredClone(n.rows),
        children: n.children.slice(),
        prev: n.prev,
        next: n.next,
        dirty: n.dirty,
        resident: this.buffer.residentPages().includes(id),
      };
    }
    const indexes: StructuralSnapshot['indexes'] = {};
    for (const [id, ix] of this.indexes) indexes[id] = ix.toStructuralIndex();
    return {
      indexes,
      recordCount: this.indexes.get(PRIMARY_INDEX_ID)?.entries ?? 0,
      pages,
      bufferFrames: this.buffer.snapshotFrames(),
      bufferRecency: this.buffer.snapshotRecency(),
    };
  }

  /** 仅供测试：按叶子链表顺序返回某棵索引的全部键。 */
  scanKeys(indexId: string = PRIMARY_INDEX_ID): Key[] {
    return this.indexes.get(indexId)?.allKeys() ?? [];
  }
}

function collectNodes(root: PlanNode): PlanNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}
