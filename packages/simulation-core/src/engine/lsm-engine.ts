import { Rng, assert, type Key, type Row, type TableSchema } from '@dbkl/shared';
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralLsm, StructuralSnapshot } from '../state';
import { COST, matchesPredicate, type PhysicalPlan, type PlanNode, type Predicate } from '../query/types';
import { describePredicate } from '../query/types';
import {
  DEFAULT_ENGINE_CONFIG,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { commandKind, commandLabel, makeRow } from './common';
import { DEFAULT_SCHEMA } from './btree-engine';

/** 一条 LSM 记录。删除不是「移除」，而是写一条墓碑。 */
interface Entry {
  key: Key;
  row: Row | null;
  tombstone: boolean;
}

interface Sst {
  id: string;
  level: number;
  entries: Entry[];
  minKey: Key;
  maxKey: Key;
  bytes: number;
  source: 'flush' | 'compaction';
  bloom: Bloom;
}

/**
 * 布隆过滤器（真的实现，不是假装）。
 *
 * 之所以要真做：假阳性必须**自然发生**，学生才能在事件日志里看到
 * 「布隆说可能有 → 读了文件 → 其实没有」这条完整链路。
 * 位数由 `bloomBitsPerKey` 决定，调小它就能亲眼看到假阳性变多、读放大变高。
 */
class Bloom {
  private bits: Uint8Array;
  private readonly m: number;
  private readonly k: number;

  constructor(expected: number, bitsPerKey: number) {
    this.m = Math.max(8, Math.ceil(Math.max(1, expected) * Math.max(1, bitsPerKey)));
    this.k = Math.min(8, Math.max(1, Math.round(bitsPerKey * 0.6931)));
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }

  add(key: Key): void {
    for (let i = 0; i < this.k; i++) {
      const b = this.position(key, i);
      this.bits[b >> 3] |= 1 << (b & 7);
    }
  }

  mayContain(key: Key): boolean {
    for (let i = 0; i < this.k; i++) {
      const b = this.position(key, i);
      if ((this.bits[b >> 3] & (1 << (b & 7))) === 0) return false;
    }
    return true;
  }

  private position(key: Key, i: number): number {
    const h1 = mix32(key);
    const h2 = mix32(key ^ 0x9e3779b9) | 1;
    return Math.abs((h1 + i * h2) % this.m);
  }
}

function mix32(x: number): number {
  let h = Math.imul(x ^ 0x27d4eb2d, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** 一条记录的估算字节数，用于「文件大小」展示。 */
const ENTRY_BYTES = 48;

/**
 * Phase 3 引擎：LSM-Tree（RocksDB / LevelDB 风格）。
 *
 * 与前两个引擎的根本区别：**它从不原地修改任何东西**。
 *
 *  - 写：只追加进内存里的 MemTable（先写 WAL）。满了就冻结、刷成 L0 的一个 SST 文件；
 *  - 更新：再写一条同键的新记录，旧的还躺在下层文件里；
 *  - 删除：写一条**墓碑**，真正的删除发生在压实到最底层的时候；
 *  - 读：自上而下逐层探测，第一个命中的就是最新版本 —— 这就是读放大；
 *  - 压实：把重叠的文件归并成新文件、丢掉旧版本与墓碑 —— 这就是写放大与空间放大的来源。
 *
 * 三种放大互相拉扯（leveled 读放大低、写放大高；tiered 相反），
 * 面板里三个数字会随参数实时变化，这正是 LSM 调参的全部难点。
 */
export class LsmEngine implements StorageEngine {
  readonly name = 'LSM-Tree (RocksDB-like)';
  readonly capabilities: readonly EngineCapability[] = ['lsm', 'compaction', 'bloom-filter', 'wal'];

  config: EngineConfig;

  private memtable: Entry[] = [];
  private immutable: { id: string; entries: Entry[] }[] = [];
  private levels: Sst[][] = [];
  private ssts = new Map<string, Sst>();
  private nextSstId = 1;
  private nextMemtableId = 1;
  private lsn = 0;
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
      case 'insert': {
        const row = command.row ?? makeRow(this.schema ?? DEFAULT_SCHEMA, command.key);
        this.put(command.key, row, false);
        return `写入 key=${command.key}（追加进 MemTable，不做任何原地修改）`;
      }
      case 'update': {
        this.put(command.key, command.row, false);
        return `更新 key=${command.key}（其实是再写一条新版本，旧版本仍在下层文件里）`;
      }
      case 'delete': {
        this.put(command.key, null, true);
        return `删除 key=${command.key}（写墓碑；真正的回收发生在压实到最底层时）`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'search':
        return this.get(command.key);
      case 'range_scan':
        return this.scan(command.from, command.to);
      case 'full_scan':
        return this.scan(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      case 'query':
        return this.runQuery(command.predicate, command.columns ?? '*');
      case 'flush_memtable':
      case 'flush_all':
        return this.forceFlush();
      case 'compact':
        return this.forceCompact(command.kind === 'compact' ? command.level : undefined);
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（MemTable 上限与压实参数下次写入即生效）';
      }
      case 'create_index':
      case 'drop_index':
        throw new Error('LSM 引擎没有二级索引：它只有一棵按主键排序的多层结构（二级索引属于上层，见路线图）');
      default:
        throw new Error(`LSM 引擎不支持命令 ${command.kind}`);
    }
  }

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    return `表 ${schema.name} 已创建（LSM：没有预先分配的页，写入即产生 MemTable）`;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  // ——— 写路径 ————————————————————————————————————————————

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      this.put(key, makeRow(this.schema!, key), false);
    }
    return `批量写入 ${count} 条（${pattern}）—— 全部顺序追加，没有任何随机写`;
  }

  /**
   * 写入一条记录：先 WAL，再进 MemTable，满了就冻结 + 刷盘 + 视情况压实。
   * 注意「更新」与「删除」走的是同一条路径 —— LSM 只有追加。
   */
  private put(key: Key, row: Row | null, tombstone: boolean): void {
    this.ensureTable();
    this.lsn++;
    this.emit({
      type: 'WAL_APPEND',
      lsn: this.lsn,
      op: tombstone ? 'delete' : 'put',
      key,
      bytes: tombstone ? 12 : ENTRY_BYTES,
    });

    const at = this.memtable.findIndex((e) => e.key === key);
    const entry: Entry = { key, row: row ? structuredClone(row) : null, tombstone };
    if (at >= 0) this.memtable[at] = entry;
    else insertSorted(this.memtable, entry);

    this.emit({
      type: 'MEMTABLE_PUT',
      key,
      row: entry.row ? structuredClone(entry.row) : null,
      tombstone,
      entries: this.memtable.length,
      limit: this.config.memtableLimit,
      overwrite: at >= 0,
    });

    if (this.memtable.length >= this.config.memtableLimit) {
      this.freezeAndFlush();
      this.maybeCompact();
    }
  }

  private freezeAndFlush(): void {
    if (this.memtable.length === 0) return;
    const tableId = `mem-${this.nextMemtableId++}`;
    const entries = this.memtable;
    this.emit({ type: 'MEMTABLE_FREEZE', tableId, entries: entries.length });
    this.immutable.push({ id: tableId, entries });
    this.memtable = [];
    this.flushOldestImmutable();
  }

  private flushOldestImmutable(): void {
    const frozen = this.immutable.shift();
    if (!frozen) return;
    this.createSst(frozen.entries, 0, 'flush');
  }

  private createSst(entries: Entry[], level: number, source: 'flush' | 'compaction'): Sst {
    const id = `sst-${this.nextSstId++}`;
    const bloom = new Bloom(entries.length, this.config.bloomBitsPerKey);
    for (const e of entries) bloom.add(e.key);
    const sst: Sst = {
      id,
      level,
      entries: entries.map((e) => ({ key: e.key, row: e.row, tombstone: e.tombstone })),
      minKey: entries[0].key,
      maxKey: entries[entries.length - 1].key,
      bytes: entries.length * ENTRY_BYTES,
      source,
      bloom,
    };
    this.ssts.set(id, sst);
    while (this.levels.length <= level) this.levels.push([]);
    if (level === 0) this.levels[0].unshift(sst);
    else {
      const target = this.levels[level];
      const at = target.findIndex((s) => s.minKey > sst.minKey);
      if (at < 0) target.push(sst);
      else target.splice(at, 0, sst);
    }
    this.emit({
      type: 'SST_CREATE',
      sstId: id,
      level,
      entries: sst.entries.map((e) => ({ key: e.key, row: e.row ? structuredClone(e.row) : null, tombstone: e.tombstone })),
      minKey: sst.minKey,
      maxKey: sst.maxKey,
      bytes: sst.bytes,
      source,
    });
    return sst;
  }

  private dropSst(sst: Sst, reason: 'compacted' | 'obsolete'): void {
    this.ssts.delete(sst.id);
    const level = this.levels[sst.level];
    if (level) {
      const at = level.indexOf(sst);
      if (at >= 0) level.splice(at, 1);
    }
    this.emit({ type: 'SST_DROP', sstId: sst.id, level: sst.level, reason });
  }

  private forceFlush(): string {
    this.ensureTable();
    if (this.memtable.length === 0 && this.immutable.length === 0) return 'MemTable 是空的，无需刷写';
    const n = this.memtable.length;
    this.freezeAndFlush();
    this.maybeCompact();
    return `手动刷写 ${n} 条记录到 L0`;
  }

  // ——— 压实 ————————————————————————————————————————————

  /** 每层的条目容量：L0 按文件数触发，其它层按容量放大倍数。 */
  private levelCapacity(level: number): number {
    return this.config.memtableLimit * Math.pow(this.config.levelFanout, level);
  }

  private maybeCompact(): void {
    // 可能连锁：L0 压到 L1 之后 L1 又满了，如此向下传导。
    for (let guard = 0; guard < 32; guard++) {
      const level = this.pickCompactionLevel();
      if (level === null) return;
      this.compactLevel(level);
    }
  }

  private pickCompactionLevel(): number | null {
    if ((this.levels[0]?.length ?? 0) >= this.config.l0CompactionTrigger) return 0;
    for (let level = 1; level < this.levels.length; level++) {
      const files = this.levels[level];
      if (files.length === 0) continue;
      if (this.config.compactionStyle === 'tiered') {
        if (files.length >= this.config.levelFanout) return level;
      } else {
        const entries = files.reduce((n, s) => n + s.entries.length, 0);
        if (entries > this.levelCapacity(level)) return level;
      }
    }
    return null;
  }

  /**
   * 把一层压到下一层。
   *
   *  - leveled：从本层挑一个文件，连同下一层与它**键区间重叠**的所有文件一起归并；
   *  - tiered：把本层所有文件整体归并成一个文件推到下一层（写放大低、下一层会重叠）。
   *
   * L0 永远整层参与，因为 L0 的文件区间本来就互相重叠。
   */
  private compactLevel(level: number): void {
    const targetLevel = level + 1;
    while (this.levels.length <= targetLevel) this.levels.push([]);

    const wholeLevel = level === 0 || this.config.compactionStyle === 'tiered';
    const picked = wholeLevel ? [...this.levels[level]] : [this.levels[level][0]];
    const minKey = Math.min(...picked.map((s) => s.minKey));
    const maxKey = Math.max(...picked.map((s) => s.maxKey));
    const overlapping =
      this.config.compactionStyle === 'tiered'
        ? []
        : this.levels[targetLevel].filter((s) => s.maxKey >= minKey && s.minKey <= maxKey);
    const inputs = [...picked, ...overlapping];

    const reason = wholeLevel
      ? level === 0
        ? `L0 文件数 ${this.levels[0].length} ≥ 触发值 ${this.config.l0CompactionTrigger}`
        : `tiered：L${level} 累积到 ${this.levels[level].length} 个文件`
      : `L${level} 条目数超过容量 ${this.levelCapacity(level)}`;

    this.emit({
      type: 'COMPACTION_BEGIN',
      level,
      targetLevel,
      inputs: inputs.map((s) => s.id),
      reason,
    });

    // 归并：新的覆盖旧的。picked 比 overlapping 新；L0 内部 unshift 过，所以下标越小越新。
    const ordered = [...picked, ...overlapping];
    const merged = new Map<Key, Entry>();
    let entriesIn = 0;
    for (const sst of ordered) {
      for (const e of sst.entries) {
        entriesIn++;
        if (!merged.has(e.key)) merged.set(e.key, e);
      }
    }

    // 只有压到**最底层**时才能真正丢掉墓碑：再往下没有更旧的版本能被它盖住了。
    const isBottom = targetLevel >= this.levels.length - 1 && this.levels[targetLevel].length === overlapping.length;
    const survivors = [...merged.values()]
      .filter((e) => !(e.tombstone && isBottom))
      .sort((a, b) => a.key - b.key);
    const dropped = entriesIn - survivors.length;

    for (const sst of inputs) this.dropSst(sst, 'compacted');
    const outputs: string[] = [];
    if (survivors.length > 0) {
      // leveled 会把结果切成多个文件；这里按目标层的「每文件条目数」切分，方便观察分裂。
      const perFile = Math.max(1, Math.ceil(this.levelCapacity(targetLevel) / Math.max(1, this.config.levelFanout)));
      for (let i = 0; i < survivors.length; i += perFile) {
        outputs.push(this.createSst(survivors.slice(i, i + perFile), targetLevel, 'compaction').id);
      }
    }

    this.emit({
      type: 'COMPACTION_END',
      level,
      targetLevel,
      inputs: inputs.map((s) => s.id),
      outputs,
      entriesIn,
      entriesOut: survivors.length,
      dropped,
    });
  }

  private forceCompact(level?: number): string {
    this.ensureTable();
    if (level === undefined) {
      const pick = this.pickCompactionLevel();
      if (pick === null) return '当前没有需要压实的层（各层都在容量之内）';
      this.compactLevel(pick);
      this.maybeCompact();
      return `压实 L${pick} → L${pick + 1} 完成`;
    }
    assert(this.levels[level]?.length > 0, `L${level} 没有文件可压实`);
    this.compactLevel(level);
    return `压实 L${level} → L${level + 1} 完成`;
  }

  // ——— 读路径 ————————————————————————————————————————————

  /**
   * 点查：自上而下找第一个命中。
   *
   * 顺序就是「新 → 旧」：MemTable → 冻结的 MemTable → L0（新文件在前）→ L1 → L2…
   * 每读一个文件之前先问布隆过滤器，它说「一定没有」就整个文件跳过。
   */
  private get(key: Key): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    let probes = 0;
    let bloomSkips = 0;

    const hitInMem = this.memtable.find((e) => e.key === key);
    if (hitInMem) {
      this.emitGet(key, hitInMem, 'memtable', null, probes, bloomSkips);
      return this.describeGet(key, hitInMem, 'MemTable', probes, bloomSkips);
    }
    for (let i = this.immutable.length - 1; i >= 0; i--) {
      const hit = this.immutable[i].entries.find((e) => e.key === key);
      if (hit) {
        this.emitGet(key, hit, 'immutable', null, probes, bloomSkips);
        return this.describeGet(key, hit, `冻结的 ${this.immutable[i].id}`, probes, bloomSkips);
      }
    }

    for (let level = 0; level < this.levels.length; level++) {
      // L0 文件区间重叠，必须每个都看；其它层区间不重叠，最多一个候选。
      const candidates =
        level === 0 ? this.levels[0] : this.levels[level].filter((s) => key >= s.minKey && key <= s.maxKey);
      for (const sst of candidates) {
        if (this.config.bloomBitsPerKey > 0) {
          const maybe = sst.bloom.mayContain(key);
          const actually = sst.entries.some((e) => e.key === key);
          this.emit({
            type: 'BLOOM_PROBE',
            sstId: sst.id,
            level,
            key,
            maybe,
            falsePositive: maybe && !actually,
          });
          if (!maybe) {
            bloomSkips++;
            continue;
          }
        }
        probes++;
        const hit = sst.entries.find((e) => e.key === key);
        this.emit({ type: 'SST_PROBE', sstId: sst.id, level, key, found: !!hit, tombstone: hit?.tombstone ?? false });
        if (hit) {
          this.emitGet(key, hit, 'sst', sst.id, probes, bloomSkips);
          return this.describeGet(key, hit, `${sst.id} (L${level})`, probes, bloomSkips);
        }
      }
    }

    this.emit({
      type: 'LSM_GET_RESULT',
      key,
      found: false,
      row: null,
      source: 'miss',
      sstId: null,
      probes,
      bloomSkips,
    });
    this.emit({ type: 'SEARCH_RESULT', key, found: false, pageId: null, slot: -1 });
    return `未找到 key=${key}（读了 ${probes} 个 SST，布隆过滤器挡掉 ${bloomSkips} 个）`;
  }

  private emitGet(
    key: Key,
    entry: Entry,
    source: 'memtable' | 'immutable' | 'sst',
    sstId: string | null,
    probes: number,
    bloomSkips: number,
  ): void {
    this.emit({
      type: 'LSM_GET_RESULT',
      key,
      found: !entry.tombstone,
      row: entry.tombstone ? null : entry.row ? structuredClone(entry.row) : null,
      source,
      sstId,
      probes,
      bloomSkips,
    });
    this.emit({ type: 'SEARCH_RESULT', key, found: !entry.tombstone, pageId: null, slot: -1 });
  }

  private describeGet(key: Key, entry: Entry, where: string, probes: number, bloomSkips: number): string {
    const base = entry.tombstone ? `key=${key} 已删除（在 ${where} 命中墓碑）` : `命中 key=${key} @ ${where}`;
    return `${base}；读放大 ${probes} 个 SST，布隆跳过 ${bloomSkips} 个`;
  }

  /**
   * 范围扫描：把所有层归并成一个有序视图，同键取最新版本、丢掉墓碑。
   * 真实实现是多路归并迭代器，这里为了可视化直接物化。
   */
  private mergedView(): Entry[] {
    const seen = new Map<Key, Entry>();
    const consider = (e: Entry) => {
      if (!seen.has(e.key)) seen.set(e.key, e);
    };
    for (const e of this.memtable) consider(e);
    for (let i = this.immutable.length - 1; i >= 0; i--) for (const e of this.immutable[i].entries) consider(e);
    for (const level of this.levels) for (const sst of level) for (const e of sst.entries) consider(e);
    return [...seen.values()].filter((e) => !e.tombstone).sort((a, b) => a.key - b.key);
  }

  private scan(from: Key, to: Key): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key: Number.isFinite(from) ? from : 0, mode: Number.isFinite(from) ? 'range' : 'full' });
    // 区间扫描没法用布隆过滤器：每个可能重叠的文件都得读。
    let touched = 0;
    for (let level = 0; level < this.levels.length; level++) {
      for (const sst of this.levels[level]) {
        if (sst.maxKey < from || sst.minKey > to) continue;
        touched++;
        this.emit({ type: 'SST_PROBE', sstId: sst.id, level, key: Number.isFinite(from) ? from : sst.minKey, found: true, tombstone: false });
      }
    }
    const rows = this.mergedView().filter((e) => e.key >= from && e.key <= to);
    for (const e of rows) {
      this.emit({ type: 'SCAN_STEP', pageId: LSM_VIRTUAL_PAGE, slot: 0, key: e.key, row: e.row, emitted: true });
    }
    this.emit({ type: 'SCAN_END', rows: rows.length, pagesTouched: touched });
    return `扫描返回 ${rows.length} 行，归并了 ${touched} 个 SST（区间扫描用不上布隆过滤器）`;
  }

  /**
   * LSM 没有优化器也没有二级索引：任何非主键条件都只能全量归并后过滤。
   * 这里仍然产出一份计划，方便和另外两个引擎的计划面板并排对比。
   */
  private runQuery(predicate: Predicate, columns: string[] | '*'): string {
    this.ensureTable();
    const merged = this.mergedView();
    const files = [...this.ssts.values()].length;
    const plan = this.buildLsmPlan(predicate, columns, merged.length, files);
    this.emit({ type: 'PLAN_READY', plan });

    const nodes = collectNodes(plan.root);
    for (const n of nodes) this.emit({ type: 'OPERATOR_OPEN', nodeId: n.id, op: n.op, detail: n.detail });
    const scan = nodes.find((n) => n.op === 'SeqScan')!;
    const filter = nodes.find((n) => n.op === 'Filter');
    const project = nodes.find((n) => n.op === 'Project')!;
    const counts = new Map<string, number>();
    const bump = (nodeId: string, key: Key, emitted: boolean) => {
      if (emitted) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      this.emit({ type: 'OPERATOR_ROW', nodeId, key, emitted });
    };

    let output = 0;
    for (const e of merged) {
      this.emit({ type: 'SCAN_STEP', pageId: LSM_VIRTUAL_PAGE, slot: 0, key: e.key, row: e.row, emitted: true });
      bump(scan.id, e.key, true);
      const value = predicate.kind === 'all' ? undefined : (e.row?.[predicate.column] as number | undefined);
      const pass = matchesPredicate(predicate, typeof value === 'number' ? value : undefined);
      if (filter) bump(filter.id, e.key, pass);
      if (pass) {
        bump(project.id, e.key, true);
        output++;
      }
    }
    for (const n of [...nodes].reverse()) {
      this.emit({ type: 'OPERATOR_CLOSE', nodeId: n.id, actualRows: counts.get(n.id) ?? 0 });
    }
    this.emit({ type: 'SCAN_END', rows: output, pagesTouched: files });
    return `${plan.chosen}；估算 ${plan.root.estRows} 行 / 实际 ${output} 行`;
  }

  private buildLsmPlan(predicate: Predicate, columns: string[] | '*', liveRows: number, files: number): PhysicalPlan {
    const scan: PlanNode = {
      id: 'n0',
      op: 'SeqScan',
      detail: `归并扫描：MemTable + ${files} 个 SST（LSM 没有二级索引）`,
      estRows: liveRows,
      estCost: Math.max(1, files) * COST.pageIO + liveRows * COST.rowCpu,
      children: [],
    };
    let node: PlanNode = scan;
    if (predicate.kind !== 'all') {
      node = {
        id: 'n1',
        op: 'Filter',
        detail: describePredicate(predicate),
        estRows: Math.max(1, Math.round(liveRows / 10)),
        estCost: scan.estCost + liveRows * COST.rowCpu,
        children: [scan],
      };
    }
    const root: PlanNode = {
      id: 'n2',
      op: 'Project',
      detail: columns === '*' ? '*' : columns.join(', '),
      estRows: node.estRows,
      estCost: node.estCost,
      children: [node],
    };
    return {
      root,
      predicate,
      chosen: `全量归并扫描 · LSM 只有主键有序性，其它条件一律扫全表`,
      candidates: [
        {
          label: '归并扫描（唯一方案）',
          strategy: 'seq-scan',
          estRows: node.estRows,
          estCost: node.estCost,
          needsLookup: false,
          chosen: true,
          reason: 'LSM 存储层没有可选路径',
        },
      ],
      columns,
    };
  }

  // ——— 结构投影 ————————————————————————————————————————

  snapshot(): StructuralSnapshot {
    return {
      indexes: {},
      // LSM 没有聚簇索引，`recordCount` 这个「聚簇索引行数」概念不适用；
      // 逻辑行数由可视化层用 `lsmLiveKeys()` 从层级结构现算（见 MetricsPanel）。
      recordCount: 0,
      pages: {},
      // 本引擎不走 Buffer Pool（LSM 的对应物是块缓存，见路线图），
      // 这两个字段保持与 reducer 初始状态一致，好让一致性测试有意义。
      bufferFrames: new Array<null>(Math.max(1, this.config.bufferPoolFrames)).fill(null),
      bufferRecency: [],
      lsm: this.projectLsm(),
    };
  }

  private projectLsm(): StructuralLsm {
    return {
      memtable: this.memtable.map((e) => ({ key: e.key, tombstone: e.tombstone })),
      immutable: this.immutable.map((t) => ({ id: t.id, entries: t.entries.length })),
      levels: this.levels.map((level) =>
        level.map((s) => ({
          id: s.id,
          level: s.level,
          minKey: s.minKey,
          maxKey: s.maxKey,
          keys: s.entries.map((e) => e.key),
          tombstones: s.entries.filter((e) => e.tombstone).map((e) => e.key),
        })),
      ),
    };
  }

  /** 仅供测试：当前逻辑上存在的全部键。 */
  liveKeys(): Key[] {
    return this.mergedView().map((e) => e.key);
  }

  /** 仅供测试：某个键当前的值（走与 get 相同的层级顺序，但不产生事件）。 */
  peek(key: Key): Row | null | undefined {
    const inMem = this.memtable.find((e) => e.key === key);
    if (inMem) return inMem.tombstone ? undefined : inMem.row;
    for (let i = this.immutable.length - 1; i >= 0; i--) {
      const hit = this.immutable[i].entries.find((e) => e.key === key);
      if (hit) return hit.tombstone ? undefined : hit.row;
    }
    for (const level of this.levels) {
      for (const sst of level) {
        const hit = sst.entries.find((e) => e.key === key);
        if (hit) return hit.tombstone ? undefined : hit.row;
      }
    }
    return undefined;
  }
}

/**
 * LSM 的扫描结果不属于任何一个「页」（记录横跨 MemTable 与多个 SST），
 * 因此 SCAN_STEP 用这个哨兵页号，reducer 只会把它记进 scanOutput，不会去点亮任何页。
 */
export const LSM_VIRTUAL_PAGE = 0;

function insertSorted(entries: Entry[], entry: Entry): void {
  const at = entries.findIndex((x) => x.key > entry.key);
  if (at < 0) entries.push(entry);
  else entries.splice(at, 0, entry);
}

function collectNodes(root: PlanNode): PlanNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}
