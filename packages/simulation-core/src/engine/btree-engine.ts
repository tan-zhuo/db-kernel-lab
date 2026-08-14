import {
  Rng,
  assert,
  clamp,
  lowerBound,
  upperBound,
  type Key,
  type PageId,
  type PageType,
  type Row,
  type TableSchema,
} from '@dbkl/shared';
import type { EntryBatch, SimulationEvent, SimulationEventBody } from '../events';
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

/** 引擎内部的页对象（与 LabState.PageState 形状一致，但由算法直接维护）。 */
interface Node {
  id: PageId;
  /** 所属索引；同一个引擎里可以并存多棵 B+ 树。 */
  indexId: string;
  type: PageType;
  level: number;
  parentId: PageId | null;
  keys: Key[];
  rows: (Row | null)[];
  children: PageId[];
  prev: PageId | null;
  next: PageId | null;
  dirty: boolean;
}

/** 一棵索引树的运行时状态（含供优化器使用的统计信息）。 */
interface IndexRuntime {
  id: string;
  name: string;
  column: string;
  clustered: boolean;
  unique: boolean;
  rootId: PageId;
  firstLeafId: PageId;
  height: number;
  entries: number;
  distinct: number;
  minKey: Key | null;
  maxKey: Key | null;
}

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

const CITIES = ['Beijing', 'Shanghai', 'Hangzhou', 'Shenzhen', 'Chengdu', 'Xian'];
const NAMES = ['ada', 'brin', 'codd', 'dean', 'edgar', 'fay', 'gray', 'hoare', 'ingres', 'jim'];

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
export class BTreeEngine implements StorageEngine {
  readonly name = 'InnoDB-like Clustered B+Tree';
  readonly capabilities: readonly EngineCapability[] = [
    'btree',
    'clustered-index',
    'secondary-index',
    'buffer-pool',
  ];

  config: EngineConfig;

  private nodes = new Map<PageId, Node>();
  private indexes = new Map<string, IndexRuntime>();
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
        const row = command.row ?? this.makeRow(command.key);
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
      default: {
        const never: never = command;
        throw new Error(`unknown command ${JSON.stringify(never)}`);
      }
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
        this.treeInsert(ix, value, this.secondaryEntry(column, value, leaf.keys[i]), 'duplicates');
        built++;
      }
      cursor = leaf.next;
      if (cursor !== null) this.access(cursor, 'scan');
    }
    this.emitStats(ix);
    return `索引 ${name}(${column}) 创建完成，灌入 ${built} 条索引项`;
  }

  private dropIndex(name: string): string {
    assert(name !== PRIMARY_INDEX_ID, '聚簇索引不可删除');
    const ix = this.indexes.get(name);
    assert(ix !== undefined, `索引 ${name} 不存在`);
    const pages = [...this.nodes.values()].filter((n) => n.indexId === name);
    for (const page of pages) {
      this.nodes.delete(page.id);
      this.buffer.forget(page.id);
      this.emit({ type: 'PAGE_FREE', pageId: page.id });
    }
    this.indexes.delete(name);
    this.emit({ type: 'INDEX_DROP', indexId: name });
    return `索引 ${name} 已删除，回收 ${pages.length} 个页`;
  }

  private newIndexTree(id: string, name: string, column: string, clustered: boolean, unique: boolean): IndexRuntime {
    this.emit({ type: 'INDEX_CREATE', indexId: id, name, column, clustered, unique });
    const root = this.allocPage(id, 'leaf', 0, null);
    const ix: IndexRuntime = {
      id,
      name,
      column,
      clustered,
      unique,
      rootId: root.id,
      firstLeafId: root.id,
      height: 1,
      entries: 0,
      distinct: 0,
      minKey: null,
      maxKey: null,
    };
    this.indexes.set(id, ix);
    this.emit({ type: 'ROOT_CHANGE', indexId: id, oldRootId: null, newRootId: root.id, height: 1 });
    this.emit({ type: 'LEAF_LINK', pageId: root.id, prev: null, next: null });
    return ix;
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
      const res = this.insertRecord(key, this.makeRow(key));
      if (res === 'inserted') inserted++;
    }
    return `批量插入 ${count} 次，新增 ${inserted} 行（${pattern}）`;
  }

  private insertRecord(key: Key, row: Row): 'inserted' | 'updated' {
    this.ensureTable();
    const clustered = this.index(PRIMARY_INDEX_ID);
    const { result, oldRow } = this.treeInsert(clustered, key, row, 'unique');

    // 维护所有二级索引：这正是「索引越多写越慢」的来源。
    for (const ix of this.secondaryIndexes()) {
      const newValue = Number(row[ix.column] ?? 0);
      if (result === 'updated') {
        const oldValue = Number(oldRow?.[ix.column] ?? 0);
        if (oldValue === newValue) continue;
        this.treeDelete(ix, oldValue, key);
      }
      this.treeInsert(ix, newValue, this.secondaryEntry(ix.column, newValue, key), 'duplicates');
    }
    return result;
  }

  private deleteRecord(key: Key): string {
    this.ensureTable();
    const removed = this.treeDelete(this.index(PRIMARY_INDEX_ID), key);
    if (removed === undefined) {
      this.emit({ type: 'SEARCH_RESULT', key, found: false, pageId: null, slot: -1 });
      return `key=${key} 不存在`;
    }
    // 行没了，指向它的二级索引项也必须删掉。
    for (const ix of this.secondaryIndexes()) {
      this.treeDelete(ix, Number(removed?.[ix.column] ?? 0), key);
    }
    return `删除 key=${key}`;
  }

  // ——— 单棵树的插入 / 删除 ————————————————————————————

  /**
   * 往一棵索引树里插入。
   * `duplicates` 模式用于二级索引：允许重复键，重复键之间按主键升序排列。
   */
  private treeInsert(
    ix: IndexRuntime,
    key: Key,
    row: Row,
    mode: 'unique' | 'duplicates',
  ): { result: 'inserted' | 'updated'; oldRow: Row | null } {
    const leafId = this.descend(ix, key, 'insert');
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    const hadEqual = leaf.keys[idx] === key;

    if (mode === 'unique') {
      if (hadEqual) {
        const oldRow = leaf.rows[idx] ?? null;
        this.emit({ type: 'RECORD_UPDATE', pageId: leaf.id, slot: idx, key, row, oldRow });
        leaf.rows[idx] = row;
        this.markDirty(leaf);
        return { result: 'updated', oldRow };
      }
    }

    this.emit({ type: 'RECORD_INSERT', pageId: leaf.id, slot: idx, key, row });
    leaf.keys.splice(idx, 0, key);
    leaf.rows.splice(idx, 0, row);
    this.markDirty(leaf);

    ix.entries++;
    if (!hadEqual) ix.distinct++;
    ix.minKey = ix.minKey === null ? key : Math.min(ix.minKey, key);
    ix.maxKey = ix.maxKey === null ? key : Math.max(ix.maxKey, key);

    if (leaf.keys.length > this.capacity()) this.splitLeaf(ix, leaf, key);
    return { result: 'inserted', oldRow: null };
  }

  /** 从一棵索引树里删除，返回被删除的行；未找到返回 undefined。 */
  private treeDelete(ix: IndexRuntime, key: Key, primaryKey?: Key): Row | null | undefined {
    const startLeafId = this.descend(ix, key, 'delete');
    const hit = this.locate(startLeafId, key, ix.unique ? undefined : primaryKey);
    if (!hit) return undefined;
    const leaf = this.node(hit.pageId);
    const idx = hit.slot;

    const removed = leaf.rows[idx] ?? null;
    this.emit({ type: 'RECORD_DELETE', pageId: leaf.id, slot: idx, key, row: removed });
    leaf.keys.splice(idx, 1);
    leaf.rows.splice(idx, 1);
    this.markDirty(leaf);

    ix.entries--;
    const stillHasKey =
      leaf.keys[idx] === key || (idx > 0 && leaf.keys[idx - 1] === key) || this.leafNeighborHasKey(leaf, key);
    if (!stillHasKey) ix.distinct = Math.max(0, ix.distinct - 1);

    // 分隔键是下界，删掉页内首键后父页分隔键仍然合法，与 InnoDB 一致：不重写父页。
    this.rebalance(ix, leaf);
    return removed;
  }

  /**
   * 从 `startLeafId` 开始，在相等键区间内定位一条记录。
   * 传入 `primaryKey` 时会沿叶子链表继续向右找，直到找到主键匹配的那一条。
   */
  private locate(startLeafId: PageId, key: Key, primaryKey?: Key): { pageId: PageId; slot: number } | null {
    let cursor: PageId | null = startLeafId;
    let idx = lowerBound(this.node(startLeafId).keys, key);
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (; idx < leaf.keys.length; idx++) {
        if (leaf.keys[idx] !== key) return null;
        if (primaryKey === undefined || this.pkOf(leaf.rows[idx]) === primaryKey) {
          return { pageId: leaf.id, slot: idx };
        }
      }
      cursor = leaf.next;
      idx = 0;
      if (cursor !== null) this.access(cursor, 'delete');
    }
    return null;
  }

  private leafNeighborHasKey(leaf: Node, key: Key): boolean {
    for (const sibling of [leaf.prev, leaf.next]) {
      if (sibling === null) continue;
      const n = this.nodes.get(sibling);
      if (n && n.keys.includes(key)) return true;
    }
    return false;
  }

  // ——— 查询 ————————————————————————————————————————————

  private pointSearch(key: Key): boolean {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const hit = this.findEntry(this.index(PRIMARY_INDEX_ID), key, 'search');
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
      leafId = this.descend(ix, from, 'scan');
    }

    let rows = 0;
    const touched = new Set<PageId>();
    this.walkLeaves(leafId, (leaf, slot, key, row) => {
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
      this.walkLeaves(ix.firstLeafId, (leaf, slot, key, row) => {
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
      const from = plan.predicate.kind === 'eq' ? plan.predicate.value : plan.predicate.kind === 'range' ? plan.predicate.from : Number.NEGATIVE_INFINITY;
      const to = plan.predicate.kind === 'eq' ? plan.predicate.value : plan.predicate.kind === 'range' ? plan.predicate.to : Number.POSITIVE_INFINITY;
      const startLeaf = this.descend(ix, from, 'search');

      const pending: { pageId: PageId; slot: number; key: Key; pk: Key }[] = [];
      this.walkLeaves(startLeaf, (leaf, slot, key, row) => {
        if (key > to) return 'stop';
        if (key < from) return 'continue';
        this.emit({ type: 'SCAN_STEP', pageId: leaf.id, slot, key, row, emitted: true });
        bump(seek.id, key, true);
        pending.push({ pageId: leaf.id, slot, key, pk: ix.clustered ? key : this.pkOf(row) });
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
          const hit = this.findEntry(this.index(PRIMARY_INDEX_ID), entry.pk, 'search');
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
    const leafCounts = new Map<string, number>();
    for (const n of this.nodes.values()) {
      if (n.type !== 'leaf') continue;
      leafCounts.set(n.indexId, (leafCounts.get(n.indexId) ?? 0) + 1);
    }
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
      leafPages: leafCounts.get(ix.id) ?? 1,
      entries: ix.entries,
      distinct: Math.max(1, ix.distinct),
      minKey: ix.minKey,
      maxKey: ix.maxKey,
    }));
  }

  private emitStats(ix: IndexRuntime): void {
    this.emit({
      type: 'INDEX_STATS',
      indexId: ix.id,
      entries: ix.entries,
      distinct: ix.distinct,
      minKey: ix.minKey,
      maxKey: ix.maxKey,
    });
  }

  // ——— 树遍历 ————————————————————————————————————————

  /** 找到 key 在某棵树里的第一条匹配项（不产生 SEARCH_RESULT）。 */
  private findEntry(
    ix: IndexRuntime,
    key: Key,
    purpose: 'search' | 'insert' | 'delete' | 'scan' = 'search',
  ): { pageId: PageId; slot: number } | null {
    const leafId = this.descend(ix, key, purpose);
    const leaf = this.node(leafId);
    const idx = lowerBound(leaf.keys, key);
    return leaf.keys[idx] === key ? { pageId: leaf.id, slot: idx } : null;
  }

  /**
   * 从某棵索引的根页下降到叶子页。
   *
   * 唯一键树（聚簇索引）用 upperBound：分隔键 == 查找键时该键一定在右子树。
   * 允许重复键的二级索引必须用 lowerBound 落到**最左**的候选页，
   * 因为一串相等的键可能横跨页边界，随后再沿叶子链表向右扫描。
   */
  private descend(ix: IndexRuntime, key: Key, purpose: 'search' | 'insert' | 'delete' | 'scan'): PageId {
    let current = ix.rootId;
    this.access(current, purpose);
    for (;;) {
      const node = this.node(current);
      if (node.type === 'leaf') return current;
      const childIndex = ix.unique ? upperBound(node.keys, key) : lowerBound(node.keys, key);
      const childId = node.children[childIndex];
      assert(childId !== undefined, `internal page #${node.id} missing child at ${childIndex}`);
      this.emit({ type: 'DESCEND', pageId: node.id, childId, key, slot: childIndex, level: node.level });
      this.access(childId, purpose);
      current = childId;
    }
  }

  /** 从某个叶子页起沿链表遍历，回调返回 'stop' 即终止。 */
  private walkLeaves(
    startLeafId: PageId,
    visit: (leaf: Node, slot: number, key: Key, row: Row | null) => 'continue' | 'stop',
  ): void {
    let cursor: PageId | null = startLeafId;
    while (cursor !== null) {
      const leaf = this.node(cursor);
      for (let i = 0; i < leaf.keys.length; i++) {
        if (visit(leaf, i, leaf.keys[i], leaf.rows[i] ?? null) === 'stop') return;
      }
      cursor = leaf.next;
      if (cursor !== null) this.access(cursor, 'scan');
    }
  }

  // ——— 分裂 ————————————————————————————————————————————

  private splitLeaf(ix: IndexRuntime, leaf: Node, triggerKey: Key): void {
    const n = leaf.keys.length;
    let splitAt = clamp(Math.round(n * this.config.fillFactor), 1, n - 1);
    if (this.config.sequentialInsertOptimization && leaf.next === null && triggerKey === leaf.keys[n - 1]) {
      // InnoDB 对「最右页 + 递增主键」的优化：几乎不搬数据，新页从空开始。
      splitAt = n - 1;
    }

    const movedKeys = leaf.keys.slice(splitAt);
    const movedRows = leaf.rows.slice(splitAt);
    const right = this.allocPage(ix.id, 'leaf', 0, leaf.parentId);
    const promotedKey = movedKeys[0];

    this.emit({
      type: 'PAGE_SPLIT',
      pageId: leaf.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'leaf',
      moved: { keys: movedKeys.slice(), rows: movedRows.slice() },
      triggerKey,
      fillFactor: this.config.fillFactor,
    });
    leaf.keys.length = splitAt;
    leaf.rows.length = splitAt;
    right.keys = movedKeys;
    right.rows = movedRows;

    const oldNext = leaf.next;
    right.prev = leaf.id;
    right.next = oldNext;
    leaf.next = right.id;
    this.emit({ type: 'LEAF_LINK', pageId: right.id, prev: right.prev, next: right.next });
    this.emit({ type: 'LEAF_LINK', pageId: leaf.id, prev: leaf.prev, next: leaf.next });
    if (oldNext !== null) {
      const nextNode = this.node(oldNext);
      nextNode.prev = right.id;
      this.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
    }

    this.markDirty(leaf);
    this.markDirty(right);
    this.insertIntoParent(ix, leaf, promotedKey, right);
  }

  private splitInternal(ix: IndexRuntime, node: Node): void {
    const n = node.keys.length;
    // 内部页始终均分：floor(n/2) 保证两侧都不低于 ceil(order/2)-1 个分隔键。
    // （fillFactor 只作用于叶子页——真实系统的填充因子同样只影响数据页。）
    const splitAt = clamp(Math.floor(n / 2), 1, n - 1);
    const promotedKey = node.keys[splitAt];
    const movedKeys = node.keys.slice(splitAt + 1);
    const movedChildren = node.children.slice(splitAt + 1);

    const right = this.allocPage(ix.id, 'internal', node.level, node.parentId);
    this.emit({
      type: 'PAGE_SPLIT',
      pageId: node.id,
      newPageId: right.id,
      promotedKey,
      pageType: 'internal',
      moved: { keys: movedKeys.slice(), children: movedChildren.slice() },
      triggerKey: null,
      fillFactor: this.config.fillFactor,
    });
    node.keys.length = splitAt;
    node.children.length = splitAt + 1;
    right.keys = movedKeys;
    right.children = movedChildren;
    for (const childId of right.children) this.reparent(childId, right.id);

    this.markDirty(node);
    this.markDirty(right);
    this.insertIntoParent(ix, node, promotedKey, right);
  }

  private insertIntoParent(ix: IndexRuntime, left: Node, key: Key, right: Node): void {
    if (left.parentId === null) {
      const newRoot = this.allocPage(ix.id, 'internal', left.level + 1, null, { children: [left.id] });
      this.emit({
        type: 'ROOT_CHANGE',
        indexId: ix.id,
        oldRootId: ix.rootId,
        newRootId: newRoot.id,
        height: ix.height + 1,
      });
      ix.rootId = newRoot.id;
      ix.height += 1;
      this.reparent(left.id, newRoot.id);
      this.emit({ type: 'SEPARATOR_INSERT', pageId: newRoot.id, slot: 0, key, childId: right.id });
      newRoot.keys.push(key);
      newRoot.children.push(right.id);
      this.reparent(right.id, newRoot.id);
      this.markDirty(newRoot);
      return;
    }

    const parent = this.node(left.parentId);
    this.access(parent.id, 'maintain');
    // 分隔键必须紧跟在 left 这个子指针后面，而不是按键比较去找位置：
    // 二级索引允许重复键，upperBound 会把新子页排到所有相等分隔键之后，
    // 导致父页的子指针顺序与叶子链表顺序不一致（进而把不相邻的页错误合并）。
    const slot = parent.children.indexOf(left.id);
    assert(slot >= 0, `page #${left.id} not found in parent #${parent.id}`);
    this.emit({ type: 'SEPARATOR_INSERT', pageId: parent.id, slot, key, childId: right.id });
    parent.keys.splice(slot, 0, key);
    parent.children.splice(slot + 1, 0, right.id);
    this.reparent(right.id, parent.id);
    this.markDirty(parent);

    if (parent.keys.length > this.capacity()) {
      this.splitInternal(ix, parent);
    }
  }

  // ——— 删除后的再平衡 ————————————————————————————————

  private rebalance(ix: IndexRuntime, node: Node): void {
    if (node.parentId === null) {
      this.shrinkRootIfNeeded(ix, node);
      return;
    }
    const min = node.type === 'leaf' ? this.minLeafKeys() : this.minInternalKeys();
    if (node.keys.length >= min) return;

    const parent = this.node(node.parentId);
    this.access(parent.id, 'maintain');
    const idx = parent.children.indexOf(node.id);
    assert(idx >= 0, `page #${node.id} not found in parent #${parent.id}`);

    const leftId = idx > 0 ? parent.children[idx - 1] : null;
    const rightId = idx < parent.children.length - 1 ? parent.children[idx + 1] : null;

    if (leftId !== null) {
      const left = this.node(leftId);
      if (left.keys.length > min) {
        this.access(left.id, 'maintain');
        this.borrow(left, node, parent, idx - 1, 'left-to-right');
        return;
      }
    }
    if (rightId !== null) {
      const right = this.node(rightId);
      if (right.keys.length > min) {
        this.access(right.id, 'maintain');
        this.borrow(right, node, parent, idx, 'right-to-left');
        return;
      }
    }

    if (leftId !== null) {
      this.access(leftId, 'maintain');
      this.merge(ix, this.node(leftId), node, parent, idx - 1);
    } else if (rightId !== null) {
      this.access(rightId, 'maintain');
      this.merge(ix, node, this.node(rightId), parent, idx);
    }

    if (parent.parentId === null) this.shrinkRootIfNeeded(ix, parent);
    else if (parent.keys.length < this.minInternalKeys()) this.rebalance(ix, parent);
  }

  /** 从 `from` 借一个条目给 `to`，并更新父页分隔键。 */
  private borrow(
    from: Node,
    to: Node,
    parent: Node,
    parentSlot: number,
    direction: 'left-to-right' | 'right-to-left',
  ): void {
    const oldSeparatorKey = parent.keys[parentSlot];
    let moved: EntryBatch;
    let newSeparatorKey: Key;

    if (to.type === 'leaf') {
      if (direction === 'left-to-right') {
        const key = from.keys[from.keys.length - 1];
        const row = from.rows[from.rows.length - 1] ?? null;
        moved = { keys: [key], rows: [row] };
        newSeparatorKey = key;
      } else {
        const key = from.keys[0];
        const row = from.rows[0] ?? null;
        moved = { keys: [key], rows: [row] };
        newSeparatorKey = from.keys[1];
      }
    } else {
      if (direction === 'left-to-right') {
        moved = { keys: [from.keys[from.keys.length - 1]], children: [from.children[from.children.length - 1]] };
        newSeparatorKey = from.keys[from.keys.length - 1];
      } else {
        moved = { keys: [from.keys[0]], children: [from.children[0]] };
        newSeparatorKey = from.keys[0];
      }
    }

    this.emit({
      type: 'REDISTRIBUTE',
      fromPageId: from.id,
      toPageId: to.id,
      pageType: to.type,
      direction,
      moved: structuredClone(moved),
      parentId: parent.id,
      parentSlot,
      newSeparatorKey,
      oldSeparatorKey,
    });

    if (to.type === 'leaf') {
      if (direction === 'left-to-right') {
        const key = from.keys.pop() as Key;
        const row = from.rows.pop() ?? null;
        to.keys.unshift(key);
        to.rows.unshift(row);
      } else {
        const key = from.keys.shift() as Key;
        const row = from.rows.shift() ?? null;
        to.keys.push(key);
        to.rows.push(row);
      }
    } else {
      if (direction === 'left-to-right') {
        const child = from.children.pop() as PageId;
        from.keys.pop();
        to.children.unshift(child);
        to.keys.unshift(oldSeparatorKey);
        this.reparent(child, to.id);
      } else {
        const child = from.children.shift() as PageId;
        from.keys.shift();
        to.children.push(child);
        to.keys.push(oldSeparatorKey);
        this.reparent(child, to.id);
      }
    }
    parent.keys[parentSlot] = newSeparatorKey;
    this.markDirty(from);
    this.markDirty(to);
    this.markDirty(parent);
  }

  /** 把 `victim`（右）并入 `keep`（左），并从父页移除分隔键。 */
  private merge(ix: IndexRuntime, keep: Node, victim: Node, parent: Node, separatorSlot: number): void {
    const separatorKey = parent.keys[separatorSlot];
    const moved: EntryBatch =
      keep.type === 'leaf'
        ? { keys: victim.keys.slice(), rows: victim.rows.slice() }
        : { keys: victim.keys.slice(), children: victim.children.slice() };

    this.emit({
      type: 'PAGE_MERGE',
      pageId: keep.id,
      victimPageId: victim.id,
      pageType: keep.type,
      separatorKey,
      moved: structuredClone(moved),
    });

    if (keep.type === 'leaf') {
      keep.keys.push(...victim.keys);
      keep.rows.push(...victim.rows);
      const oldNext = victim.next;
      keep.next = oldNext;
      this.emit({ type: 'LEAF_LINK', pageId: keep.id, prev: keep.prev, next: keep.next });
      if (oldNext !== null) {
        const nextNode = this.node(oldNext);
        nextNode.prev = keep.id;
        this.emit({ type: 'LEAF_LINK', pageId: nextNode.id, prev: nextNode.prev, next: nextNode.next });
      }
    } else {
      keep.keys.push(separatorKey, ...victim.keys);
      keep.children.push(...victim.children);
      for (const childId of victim.children) this.reparent(childId, keep.id);
    }

    this.emit({
      type: 'SEPARATOR_DELETE',
      pageId: parent.id,
      slot: separatorSlot,
      key: separatorKey,
      childId: victim.id,
    });
    parent.keys.splice(separatorSlot, 1);
    parent.children.splice(separatorSlot + 1, 1);

    this.freePage(ix, victim);
    this.markDirty(keep);
    this.markDirty(parent);
  }

  private shrinkRootIfNeeded(ix: IndexRuntime, root: Node): void {
    if (root.type !== 'internal') return;
    if (root.children.length > 1) return;
    const onlyChild = this.node(root.children[0]);
    this.emit({
      type: 'ROOT_CHANGE',
      indexId: ix.id,
      oldRootId: root.id,
      newRootId: onlyChild.id,
      height: ix.height - 1,
    });
    ix.rootId = onlyChild.id;
    ix.height -= 1;
    onlyChild.parentId = null;
    this.emit({ type: 'PARENT_SET', pageId: onlyChild.id, parentId: null });
    this.freePage(ix, root);
  }

  // ——— 页管理 ————————————————————————————————————————

  private allocPage(
    indexId: string,
    type: PageType,
    level: number,
    parentId: PageId | null,
    init?: { keys?: Key[]; children?: PageId[] },
  ): Node {
    const id = this.nextPageId++;
    const node: Node = {
      id,
      indexId,
      type,
      level,
      parentId,
      keys: init?.keys?.slice() ?? [],
      rows: [],
      children: init?.children?.slice() ?? [],
      prev: null,
      next: null,
      dirty: false,
    };
    this.nodes.set(id, node);
    this.emit({
      type: 'PAGE_ALLOC',
      pageId: id,
      indexId,
      pageType: type,
      level,
      parentId,
      init: init ? structuredClone(init) : undefined,
    });
    this.access(id, 'maintain');
    return node;
  }

  private freePage(ix: IndexRuntime, node: Node): void {
    this.nodes.delete(node.id);
    this.buffer.forget(node.id);
    if (ix.firstLeafId === node.id && node.next !== null) ix.firstLeafId = node.next;
    this.emit({ type: 'PAGE_FREE', pageId: node.id });
  }

  private reparent(childId: PageId, parentId: PageId | null): void {
    const child = this.node(childId);
    if (child.parentId === parentId) return;
    child.parentId = parentId;
    this.emit({ type: 'PARENT_SET', pageId: childId, parentId });
  }

  private markDirty(node: Node): void {
    if (node.dirty) return;
    node.dirty = true;
    this.emit({ type: 'PAGE_MARK_DIRTY', pageId: node.id });
  }

  private access(pageId: PageId, purpose: 'search' | 'insert' | 'delete' | 'scan' | 'maintain'): void {
    this.buffer.access(pageId);
    this.emit({ type: 'PAGE_READ', pageId, purpose });
  }

  private node(id: PageId): Node {
    const n = this.nodes.get(id);
    assert(n !== undefined, `page #${id} does not exist`);
    return n;
  }

  private index(id: string): IndexRuntime {
    const ix = this.indexes.get(id);
    assert(ix !== undefined, `索引 ${id} 不存在`);
    return ix;
  }

  private secondaryIndexes(): IndexRuntime[] {
    return [...this.indexes.values()].filter((ix) => !ix.clustered);
  }

  /** 二级索引叶子项：(索引列, 主键) —— 与 InnoDB 一致，不含其它列。 */
  private secondaryEntry(column: string, value: Key, primaryKey: Key): Row {
    return { [column]: value, [this.schema!.primaryKey]: primaryKey };
  }

  private pkOf(row: Row | null | undefined): Key {
    if (!row || !this.schema) return Number.NEGATIVE_INFINITY;
    const v = row[this.schema.primaryKey];
    return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
  }

  private capacity(): number {
    return Math.max(1, this.config.order - 1);
  }

  private minLeafKeys(): number {
    return Math.ceil((this.config.order - 1) / 2);
  }

  private minInternalKeys(): number {
    return Math.ceil(this.config.order / 2) - 1;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  private makeRow(key: Key): Row {
    const schema = this.schema ?? DEFAULT_SCHEMA;
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

  private emit(body: SimulationEventBody): void {
    this.clock += EVENT_DURATION[body.type];
    this.out.push({ ...body, seq: this.seq++, t: this.clock, cmd: this.cmdId } as SimulationEvent);
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
    for (const [id, ix] of this.indexes) {
      indexes[id] = {
        id,
        name: ix.name,
        column: ix.column,
        clustered: ix.clustered,
        unique: ix.unique,
        rootId: ix.rootId,
        firstLeafId: ix.firstLeafId,
        height: ix.height,
        entries: ix.entries,
      };
    }
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
    const ix = this.indexes.get(indexId);
    if (!ix) return [];
    const out: Key[] = [];
    let cur: PageId | null = ix.firstLeafId;
    const seen = new Set<PageId>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const n = this.node(cur);
      out.push(...n.keys);
      cur = n.next;
    }
    return out;
  }
}

function collectNodes(root: PlanNode): PlanNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function commandKind(c: Command): import('@dbkl/shared').CommandKind {
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

function commandLabel(c: Command): string {
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
    default:
      return 'UNKNOWN';
  }
}
