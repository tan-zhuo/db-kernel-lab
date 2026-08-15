import { Rng, type Key, type Row, type TableSchema } from '@dbkl/shared';
import type { SimulationEvent, SimulationEventBody } from '../events';
import { EVENT_DURATION } from '../events';
import type { StructuralKv, StructuralSnapshot } from '../state';
import {
  DEFAULT_ENGINE_CONFIG,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type StorageEngine,
} from './types';
import { commandKind, commandLabel, makeRow } from './common';
import { DEFAULT_SCHEMA } from './btree-engine';

/** 磁盘上的一条记录。写入永远是追加，从不原地修改。 */
interface LogRecord {
  key: Key;
  row: Row | null;
  tombstone: boolean;
  bytes: number;
  offset: number;
}

interface LogFile {
  id: string;
  index: number;
  records: LogRecord[];
  bytes: number;
  sealed: boolean;
}

/** 内存索引项：key → 记录在哪个文件的哪个偏移。 */
interface IndexEntry {
  key: Key;
  bucket: number;
  fileId: string;
  offset: number;
}

/** 一条记录的估算字节数。 */
const RECORD_BYTES = 40;
const TOMBSTONE_BYTES = 10;
/** 一个内存索引项的估算开销（key + 文件号 + 偏移 + 哈希表指针）。 */
const INDEX_ENTRY_BYTES = 24;

/**
 * Phase 3 续：哈希索引 KV 引擎（Bitcask 风格）。
 *
 * 它和 LSM 同属 KV，但走的是**完全相反**的路子：
 *
 * | | LSM（有序） | 本引擎（哈希） |
 * |---|---|---|
 * | 索引 | 分层 SST，磁盘上有序 | **全部键常驻内存哈希表** |
 * | 点查 | 自上而下逐层探测，读放大 > 1 | 哈希一次 + **一次磁盘读**，与数据量无关 |
 * | 范围扫描 | 天然支持（有序） | **根本做不到** —— 哈希不保序 |
 * | 规模上限 | 磁盘有多大放多大 | **被内存卡死**：键数 × 索引项大小 必须装得下 |
 * | 空间回收 | 分层压实 | 合并：把还有效的记录搬进新文件 |
 *
 * 这张表就是选型的全部内容：需要范围扫描就别用哈希；键数超过内存也别用哈希；
 * 但如果是「几千万个键、只做点查、要求延迟稳定」，它的一次磁盘读是 LSM 比不了的。
 */
export class KvHashEngine implements StorageEngine {
  readonly name = 'KV Hash Index (Bitcask-like)';
  readonly capabilities: readonly EngineCapability[] = ['kv', 'hash-index', 'wal'];

  config: EngineConfig;

  private files: LogFile[] = [];
  /** 内存哈希表：桶 → 冲突链。 */
  private buckets: IndexEntry[][] = [];
  private nextFileIndex = 1;
  private schema: TableSchema | null = null;
  private rng: Rng;

  private out: SimulationEvent[] = [];
  private seq = 0;
  private clock = 0;
  private cmdId = 0;

  constructor(config: EngineConfig = DEFAULT_ENGINE_CONFIG) {
    this.config = { ...config };
    this.rng = new Rng(this.config.seed);
    this.buckets = Array.from({ length: Math.max(1, this.config.kvHashBuckets) }, () => []);
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
        const overwrite = this.put(command.key, row, false);
        return `写入 key=${command.key}（追加到活动文件末尾${overwrite ? '，旧记录立刻变成垃圾' : ''}）`;
      }
      case 'update': {
        this.put(command.key, command.row, false);
        return `更新 key=${command.key}（依然是追加一条新记录 + 改内存索引指向）`;
      }
      case 'delete': {
        const existed = this.put(command.key, null, true);
        return existed
          ? `删除 key=${command.key}（写墓碑 + 从内存索引摘除）`
          : `key=${command.key} 不存在（哈希一次就知道，连磁盘都不用碰）`;
      }
      case 'bulk_insert':
        return this.bulkInsert(command);
      case 'search':
        return this.get(command.key);
      case 'compact':
      case 'flush_all':
        return this.merge(true);
      case 'configure': {
        this.config = { ...this.config, ...command.patch };
        this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
        return '配置已更新（桶数变化需重置才会重建哈希表）';
      }
      case 'range_scan':
      case 'full_scan':
        throw new Error(
          '哈希索引不支持范围扫描：哈希把键打散了，相邻的键落在完全不同的桶与文件里。' +
            '要范围扫描就得用有序结构（B+ 树或 LSM）—— 这正是两类 KV 的分水岭',
        );
      case 'query':
        throw new Error('哈希索引 KV 只有「按键点查」一种访问路径，没有优化器可选，也没法按非键列过滤');
      case 'create_index':
      case 'drop_index':
        throw new Error('哈希索引 KV 没有二级索引：它只认主键');
      default:
        throw new Error(`KV 引擎不支持命令 ${command.kind}`);
    }
  }

  private createTable(schema: TableSchema): string {
    this.schema = structuredClone(schema);
    this.emit({ type: 'CONFIG_SET', config: { ...this.config } });
    this.emit({ type: 'TABLE_CREATE', schema: this.schema });
    this.openFile();
    return `表 ${schema.name} 已创建（KV：${this.config.kvHashBuckets} 个哈希桶 + 追加写日志文件）`;
  }

  private ensureTable(): void {
    if (this.schema === null) {
      this.createTable(DEFAULT_SCHEMA);
      this.emit({ type: 'NOTE', message: '未显式建表，已使用默认 schema', level: 'warn' });
    }
  }

  // ——— 哈希 ————————————————————————————————————————————

  /** 确定性哈希：同一个键在任何一次运行里都落到同一个桶。 */
  private bucketOf(key: Key): number {
    let h = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return Math.abs(h) % this.buckets.length;
  }

  private indexBytes(): number {
    return this.keyCount() * INDEX_ENTRY_BYTES;
  }

  private keyCount(): number {
    return this.buckets.reduce((n, b) => n + b.length, 0);
  }

  // ——— 写路径：追加 + 改内存索引 ————————————————————

  private openFile(): LogFile {
    const index = this.nextFileIndex++;
    const file: LogFile = { id: `log-${index}`, index, records: [], bytes: 0, sealed: false };
    this.files.push(file);
    this.emit({ type: 'LOG_FILE_OPEN', fileId: file.id, index });
    return file;
  }

  /** 当前活动文件（永远是最后一个，且只有它可写 —— 这是 Bitcask 的核心约束）。 */
  private activeFile(): LogFile {
    const last = this.files[this.files.length - 1];
    if (last && !last.sealed) return last;
    return this.openFile();
  }

  private bulkInsert(cmd: Extract<Command, { kind: 'bulk_insert' }>): string {
    this.ensureTable();
    const { count, pattern } = cmd;
    const start = cmd.start ?? this.keyCount() + 1;
    const max = cmd.max ?? Math.max(count * 10, 1000);
    for (let i = 0; i < count; i++) {
      let key: Key;
      if (pattern === 'sequential') key = start + i;
      else if (pattern === 'reverse') key = start + count - 1 - i;
      else key = this.rng.int(1, max);
      this.put(key, makeRow(this.schema!, key), false);
    }
    return `批量写入 ${count} 条（${pattern}）—— 全部顺序追加；内存索引现有 ${this.keyCount()} 个键 / ${this.indexBytes()} B`;
  }

  /**
   * 写一条记录。返回是否覆盖了旧值。
   *
   * 两步，缺一不可：
   *  1. **追加**到活动文件末尾（磁盘上永远只有顺序写）；
   *  2. **改内存索引**指向新位置 —— 旧记录还躺在文件里，但从此没人能找到它，成了垃圾。
   */
  private put(key: Key, row: Row | null, tombstone: boolean): boolean {
    this.ensureTable();
    const file = this.activeFile();
    const bytes = tombstone ? TOMBSTONE_BYTES : RECORD_BYTES;
    const offset = file.bytes;
    file.records.push({ key, row: row ? structuredClone(row) : null, tombstone, bytes, offset });
    file.bytes += bytes;
    this.emit({ type: 'LOG_APPEND', fileId: file.id, offset, key, bytes, tombstone });

    const bucket = this.bucketOf(key);
    const chain = this.buckets[bucket];
    const at = chain.findIndex((e) => e.key === key);
    const overwrite = at >= 0;

    if (tombstone) {
      if (at >= 0) chain.splice(at, 1);
    } else if (at >= 0) {
      chain[at] = { key, bucket, fileId: file.id, offset };
    } else {
      chain.push({ key, bucket, fileId: file.id, offset });
    }

    this.emit({
      type: 'HASH_INDEX_SET',
      key,
      bucket,
      fileId: file.id,
      offset,
      overwrite,
      removed: tombstone,
      keys: this.keyCount(),
      indexBytes: this.indexBytes(),
    });

    // 活动文件写满就封口，之后只读不写。
    if (file.records.length >= this.config.kvLogFileRecords) {
      file.sealed = true;
      this.emit({ type: 'LOG_FILE_SEAL', fileId: file.id, records: file.records.length, bytes: file.bytes });
      this.maybeMerge();
    }
    return overwrite;
  }

  // ——— 读路径：哈希一次 + 一次磁盘读 ————————————————

  /**
   * 点查。
   *
   * 全程只有两步：桶内走一小段冲突链（内存）、按偏移读一次磁盘。
   * **与数据量完全无关** —— 这是哈希索引唯一但极强的卖点。
   * 键不存在时连磁盘都不用碰。
   */
  private get(key: Key): string {
    this.ensureTable();
    this.emit({ type: 'SEARCH_BEGIN', key, mode: 'point' });
    const bucket = this.bucketOf(key);
    const chain = this.buckets[bucket];
    let steps = 0;
    let hit: IndexEntry | undefined;
    for (const entry of chain) {
      steps++;
      if (entry.key === key) {
        hit = entry;
        break;
      }
    }

    this.emit({
      type: 'HASH_PROBE',
      key,
      bucket,
      chainSteps: steps,
      found: hit !== undefined,
      fileId: hit?.fileId ?? null,
      offset: hit?.offset ?? -1,
    });
    this.emit({
      type: 'SEARCH_RESULT',
      key,
      found: hit !== undefined,
      pageId: null,
      slot: hit?.offset ?? -1,
    });

    if (!hit) return `未找到 key=${key}（桶 ${bucket} 链上走了 ${steps} 步，全程没碰磁盘）`;
    return `命中 key=${key} @ ${hit.fileId}@${hit.offset} —— 哈希 ${steps} 步 + 一次磁盘读，与数据量无关`;
  }

  // ——— 合并：回收被覆盖的旧记录 ————————————————————

  private deadRatio(): { dead: number; total: number; ratio: number } {
    let total = 0;
    let live = 0;
    for (const file of this.files) {
      total += file.records.length;
      for (const record of file.records) {
        if (this.isLive(file.id, record)) live++;
      }
    }
    const dead = total - live;
    return { dead, total, ratio: total === 0 ? 0 : dead / total };
  }

  /** 一条记录还有效 ⇔ 内存索引正好指着它。 */
  private isLive(fileId: string, record: LogRecord): boolean {
    if (record.tombstone) return false;
    const chain = this.buckets[this.bucketOf(record.key)];
    const entry = chain.find((e) => e.key === record.key);
    return entry !== undefined && entry.fileId === fileId && entry.offset === record.offset;
  }

  private maybeMerge(): void {
    const { ratio } = this.deadRatio();
    if (ratio >= this.config.kvMergeThreshold) this.merge(false);
  }

  /**
   * 合并：把所有**封口文件**里仍然有效的记录搬进一个新文件，其余全部丢弃。
   *
   * 活动文件不参与（它还在写）。搬完之后内存索引要重新指向新位置 ——
   * 这是「日志式存储」共同的收尾动作，LSM 的压实做的也是同一件事。
   */
  private merge(manual: boolean): string {
    this.ensureTable();
    const sealed = this.files.filter((f) => f.sealed);
    if (sealed.length < 2) {
      return manual ? '封口文件不足 2 个，暂时没有合并的必要' : '';
    }
    const { dead, ratio } = this.deadRatio();
    this.emit({
      type: 'MERGE_BEGIN',
      inputs: sealed.map((f) => f.id),
      reason: manual ? '用户手动触发' : `失效占比 ${(ratio * 100).toFixed(0)}% ≥ 阈值 ${(this.config.kvMergeThreshold * 100).toFixed(0)}%`,
      deadRatio: ratio,
    });

    const survivors: LogRecord[] = [];
    let reclaimed = 0;
    let deadCount = 0;
    for (const file of sealed) {
      for (const record of file.records) {
        if (this.isLive(file.id, record)) survivors.push(record);
        else {
          reclaimed += record.bytes;
          deadCount++;
        }
      }
    }

    // 输出一个新的封口文件承接所有幸存记录。
    const merged = this.openFile();
    for (const record of survivors) {
      const offset = merged.bytes;
      merged.records.push({ ...record, offset });
      merged.bytes += record.bytes;
      this.emit({ type: 'LOG_APPEND', fileId: merged.id, offset, key: record.key, bytes: record.bytes, tombstone: false });
      // 索引重新指向新位置
      const bucket = this.bucketOf(record.key);
      const chain = this.buckets[bucket];
      const at = chain.findIndex((e) => e.key === record.key);
      if (at >= 0) chain[at] = { key: record.key, bucket, fileId: merged.id, offset };
      this.emit({
        type: 'HASH_INDEX_SET',
        key: record.key,
        bucket,
        fileId: merged.id,
        offset,
        overwrite: true,
        removed: false,
        keys: this.keyCount(),
        indexBytes: this.indexBytes(),
      });
    }
    merged.sealed = true;
    this.emit({ type: 'LOG_FILE_SEAL', fileId: merged.id, records: merged.records.length, bytes: merged.bytes });

    // 旧文件整体丢弃。
    const inputIds = sealed.map((f) => f.id);
    this.files = this.files.filter((f) => !inputIds.includes(f.id));

    this.emit({
      type: 'MERGE_END',
      inputs: inputIds,
      outputs: [merged.id],
      liveRecords: survivors.length,
      deadRecords: deadCount,
      reclaimedBytes: reclaimed,
    });
    return `合并 ${inputIds.length} 个文件：保留 ${survivors.length} 条、丢弃 ${deadCount} 条，回收 ${reclaimed} B（原失效 ${dead} 条）`;
  }

  // ——— 结构投影 ————————————————————————————————————————

  snapshot(): StructuralSnapshot {
    return {
      indexes: {},
      recordCount: this.keyCount(),
      pages: {},
      bufferFrames: new Array<null>(Math.max(1, this.config.bufferPoolFrames)).fill(null),
      bufferRecency: [],
      kv: this.projectKv(),
    };
  }

  private projectKv(): StructuralKv {
    return {
      files: this.files.map((f) => ({ id: f.id, records: f.records.length, sealed: f.sealed })),
      index: this.buckets
        .flat()
        .slice()
        .sort((a, b) => a.key - b.key)
        .map((e) => ({ key: e.key, fileId: e.fileId, offset: e.offset })),
    };
  }

  /** 仅供测试：当前所有存在的键。 */
  liveKeys(): Key[] {
    return this.buckets
      .flat()
      .map((e) => e.key)
      .sort((a, b) => a - b);
  }

  /** 仅供测试：按索引取值（模拟一次磁盘读）。 */
  peek(key: Key): Row | null | undefined {
    const entry = this.buckets[this.bucketOf(key)].find((e) => e.key === key);
    if (!entry) return undefined;
    const file = this.files.find((f) => f.id === entry.fileId);
    const record = file?.records.find((r) => r.offset === entry.offset);
    return record?.row ?? undefined;
  }

  /** 仅供测试：内存索引占用的估算字节数。 */
  indexMemoryBytes(): number {
    return this.indexBytes();
  }

  /** 仅供测试：磁盘上失效记录的占比。 */
  garbageRatio(): number {
    return this.deadRatio().ratio;
  }

  /** 仅供测试：最长冲突链长度。 */
  longestChain(): number {
    return this.buckets.reduce((n, b) => Math.max(n, b.length), 0);
  }
}
