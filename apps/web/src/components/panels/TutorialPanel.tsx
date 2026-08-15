import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_SCHEMA,
  COLUMNAR_ENGINE_ID,
  INNODB_BTREE_ENGINE_ID,
  KV_HASH_ENGINE_ID,
  LSM_ENGINE_ID,
  POSTGRES_HEAP_ENGINE_ID,
  PRIMARY_INDEX_ID,
  bumpRow,
  listEngines,
  type Command,
  type EngineConfig,
} from '@dbkl/simulation-core';
import { useSimStore } from '@/state/store';
import { Panel } from '@/components/ui/Panel';

interface Scenario {
  id: string;
  engineId: string;
  title: string;
  goal: string;
  config: Partial<EngineConfig>;
  commands: Command[];
}

/** 演示用的行：改一个**没被索引**的列（HOT 可用）。 */
const renameRow = (key: number, n: number) => ({ ...bumpRow(DEFAULT_SCHEMA, key, 0), name: `v${n}` });
/** 演示用的行：改**被索引**的列（一定不是 HOT）。 */
const rescoreRow = (key: number, score: number) => ({ ...bumpRow(DEFAULT_SCHEMA, key, 0), score });

/**
 * 引导式实验（文档 §12「教程模式」）。
 *
 * 每个实验 = 一个引擎 + 一组固定参数 + 一串命令，跑完后用时间轴单步观察即可。
 * 点任何一个实验都会自动切到它所属的引擎 —— 跨引擎对比同一件事（比如「更新一行」）
 * 正是这个实验室的核心用法。
 */
const SCENARIOS: Scenario[] = [
  // ══ MySQL · InnoDB ═══════════════════════════════════════
  {
    id: 'split',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '① 页分裂与树的生长',
    goal: '阶数 4 的树里顺序插入 12 行：看叶子页装满 3 条后如何一分为二、中间键如何上浮成为根页的分隔键。',
    config: { order: 4, bufferPoolFrames: 8, fillFactor: 0.5 },
    commands: [{ kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'fill-factor',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '② 填充因子的影响',
    goal: '把分裂点推到 0.9：右倾分裂让左页几乎装满、右页很空，页数更少但后续插入更容易再次分裂。',
    config: { order: 6, fillFactor: 0.9, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 30, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'sequential-opt',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '③ 顺序插入右倾优化',
    goal: 'InnoDB 对自增主键的优化：最右叶子页分裂时几乎不搬数据，观察每次分裂只有 1 条记录被搬到新页。',
    config: { order: 6, sequentialInsertOptimization: true, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'random-vs-seq',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '④ 随机主键的代价',
    goal: '随机主键插入 60 行：分裂遍布整棵树、页填充率参差不齐，与顺序插入形成对照。',
    config: { order: 5, bufferPoolFrames: 8 },
    commands: [{ kind: 'bulk_insert', count: 60, pattern: 'random', max: 400 }],
  },
  {
    id: 'buffer-thrash',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑤ 缓冲池抖动',
    goal: '只给 3 个帧再做全索引扫描：命中率暴跌、淘汰不断发生，脏页在淘汰前被强制刷盘。',
    config: { order: 4, bufferPoolFrames: 3, evictionPolicy: 'LRU' },
    commands: [
      { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 },
      { kind: 'full_scan' },
    ],
  },
  {
    id: 'merge',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑥ 删除、借位与页合并',
    goal: '先插 24 行再删掉一半：观察叶子页低于半满时先向兄弟页借记录，借不到就合并并回收页，树高回落。',
    config: { order: 4, bufferPoolFrames: 8 },
    commands: [
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: 'delete', key: i * 2 + 1 }) as Command),
    ],
  },
  {
    id: 'point-vs-range',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑦ 点查 vs 范围扫描',
    goal: '同一棵树上先点查再范围扫描：点查沿路径下降 O(logN) 次读页，范围扫描定位一次后沿叶子链表顺序前进。',
    config: { order: 5, bufferPoolFrames: 6 },
    commands: [
      { kind: 'bulk_insert', count: 50, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 37 },
      { kind: 'range_scan', from: 20, to: 34 },
    ],
  },
  {
    id: 'secondary-index',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑧ 二级索引与回表',
    goal: '在 score 列上建二级索引，然后按 score 等值查询：先在二级索引树里定位，再沿粉色弧线回聚簇索引取整行。',
    config: { order: 5, bufferPoolFrames: 10 },
    commands: [
      { kind: 'bulk_insert', count: 60, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'query', predicate: { kind: 'eq', column: 'score', value: (7 * 7919) % 100 } },
    ],
  },
  {
    id: 'covering-index',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑨ 覆盖索引省掉回表',
    goal: '同一条件，只取 (score, id) 两列：查询列全在索引里，执行计划中 RowIdLookup 消失，逻辑读大幅下降。',
    config: { order: 5, bufferPoolFrames: 10 },
    commands: [
      { kind: 'bulk_insert', count: 60, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'query', predicate: { kind: 'eq', column: 'score', value: (7 * 7919) % 100 }, columns: ['score', 'id'] },
    ],
  },
  {
    id: 'optimizer',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑩ 优化器为什么放弃索引',
    goal: '窄范围走索引、宽范围回落到全表扫描：对比两次执行计划里的估算行数与代价，理解回表的随机 IO 成本。',
    config: { order: 5, bufferPoolFrames: 12 },
    commands: [
      { kind: 'bulk_insert', count: 120, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'query', predicate: { kind: 'range', column: 'score', from: 40, to: 42 } },
      { kind: 'query', predicate: { kind: 'range', column: 'score', from: 0, to: 99 } },
    ],
  },
  {
    id: 'write-amplification',
    engineId: INNODB_BTREE_ENGINE_ID,
    title: '⑪ 索引带来的写放大',
    goal: '先看没有二级索引时插入 20 行的事件数，再建两个索引后插入同样 20 行：同一条 INSERT 要维护三棵树。',
    config: { order: 5, bufferPoolFrames: 12 },
    commands: [
      { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'bulk_insert', count: 20, pattern: 'sequential', start: 100 },
    ],
  },

  // ══ PostgreSQL · 堆表 + MVCC ═════════════════════════════
  {
    id: 'pg-heap-fetch',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '① 索引不是表：主键点查要多跳一次',
    goal: '插 12 行再点查：索引树下降只拿到一个 TID，还得沿蓝色弧线飞到下方的堆页取整行。把它和 InnoDB 的 ① 并排看。',
    config: { order: 4, heapTuplesPerPage: 4, bufferPoolFrames: 12 },
    commands: [
      { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 7 },
    ],
  },
  {
    id: 'pg-version-chain',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '② UPDATE 写的是新版本，不是覆盖',
    goal: '同一行连改 4 次：堆里留下 4 个版本，粉色 t_ctid 链把它们串起来，旧版本全被打上 xmax 变成死元组。',
    config: { order: 4, heapTuplesPerPage: 6, hotUpdate: true },
    commands: [
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'update', key: 2, row: renameRow(2, i + 1) }) as Command),
    ],
  },
  {
    id: 'pg-hot',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '③ HOT 更新：不碰索引的那种更新',
    goal: '先改不被索引的列（HOT，绿色链，索引项一条没加），再改被索引的 score 列（非 HOT，所有索引都要写新项）。',
    config: { order: 4, heapTuplesPerPage: 8, hotUpdate: true },
    commands: [
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 },
      { kind: 'create_index', name: 'idx_score', column: 'score' },
      { kind: 'update', key: 2, row: renameRow(2, 1) },
      { kind: 'update', key: 2, row: renameRow(2, 2) },
      { kind: 'update', key: 2, row: rescoreRow(2, 77) },
    ],
  },
  {
    id: 'pg-bloat-vacuum',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '④ 表膨胀与 VACUUM',
    goal: '删掉一半的行：膨胀率冲到 50%，但索引项一条没少。跑 VACUUM 之后死元组被清空、索引项同步删除、行指针可复用。',
    config: { order: 4, heapTuplesPerPage: 4 },
    commands: [
      { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'delete', key: i + 1 }) as Command),
      { kind: 'vacuum' },
    ],
  },
  {
    id: 'pg-read-committed',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '⑤ 不可重复读（READ COMMITTED）',
    goal: '会话 A 开着事务读一次 → 切到 B 插入并提交 → 切回 A 再读一次：两次行数不一样。快照是每条语句重新取的。',
    config: { order: 4, heapTuplesPerPage: 4 },
    commands: [
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn', isolation: 'read-committed' },
      { kind: 'full_scan' },
      { kind: 'use_session', session: 'B' },
      { kind: 'insert', key: 99 },
      { kind: 'use_session', session: 'A' },
      { kind: 'full_scan' },
      { kind: 'commit_txn' },
    ],
  },
  {
    id: 'pg-repeatable-read',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '⑥ REPEATABLE READ 挡住了它',
    goal: '同样的剧本换成 REPEATABLE READ：快照在 BEGIN 时就钉死了，A 两次读到的行数完全一样 —— 新行对它根本不存在。',
    config: { order: 4, heapTuplesPerPage: 4 },
    commands: [
      { kind: 'bulk_insert', count: 4, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn', isolation: 'repeatable-read' },
      { kind: 'full_scan' },
      { kind: 'use_session', session: 'B' },
      { kind: 'insert', key: 99 },
      { kind: 'use_session', session: 'A' },
      { kind: 'full_scan' },
      { kind: 'commit_txn' },
    ],
  },
  {
    id: 'pg-index-only',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '⑦ Index Only Scan 与可见性映射',
    goal: '同一条覆盖查询跑两次：VACUUM 之前必须回堆判可见性，VACUUM 之后页被标成 all-visible，回堆彻底消失。',
    config: { order: 4, heapTuplesPerPage: 4 },
    commands: [
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      { kind: 'query', predicate: { kind: 'range', column: 'id', from: 1, to: 4 }, columns: ['id'], hint: PRIMARY_INDEX_ID },
      { kind: 'vacuum' },
      { kind: 'query', predicate: { kind: 'range', column: 'id', from: 1, to: 4 }, columns: ['id'], hint: PRIMARY_INDEX_ID },
    ],
  },
  {
    id: 'pg-rollback',
    engineId: POSTGRES_HEAP_ENGINE_ID,
    title: '⑧ 回滚：写过的行还在，只是谁也看不见',
    goal: '事务里插 3 行然后 ROLLBACK：堆里那 3 个元组**依然躺着**，只是 xmin 属于一个已回滚的事务，从此对所有人不可见。',
    config: { order: 4, heapTuplesPerPage: 4 },
    commands: [
      { kind: 'bulk_insert', count: 3, pattern: 'sequential', start: 1 },
      { kind: 'begin_txn' },
      { kind: 'insert', key: 90 },
      { kind: 'insert', key: 91 },
      { kind: 'insert', key: 92 },
      { kind: 'abort_txn' },
      { kind: 'full_scan' },
    ],
  },

  // ══ LSM-Tree ═════════════════════════════════════════════
  {
    id: 'lsm-flush',
    engineId: LSM_ENGINE_ID,
    title: '① 写入只追加：MemTable → 冻结 → L0',
    goal: '连写 12 条：MemTable 水位涨到上限就整块冻结、刷成一个 L0 文件，然后从零开始。全程没有任何原地修改。',
    config: { memtableLimit: 4, l0CompactionTrigger: 99, levelFanout: 3 },
    commands: [{ kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'lsm-compaction',
    engineId: LSM_ENGINE_ID,
    title: '② L0 堆满就压实',
    goal: '把 L0 触发值调到 3：第三个文件一落地就触发压实，三块砖被归并成 L1 上互不重叠的新砖。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3 },
    commands: [{ kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'lsm-multi-version',
    engineId: LSM_ENGINE_ID,
    title: '③ 同一个键的多个版本共存',
    goal: '反复更新同 4 个键：每一层都留着它们的旧值，空间放大一路上涨；手动压实一次，旧版本被归并掉，数字立刻回落。',
    config: { memtableLimit: 4, l0CompactionTrigger: 99, levelFanout: 3 },
    commands: [
      ...Array.from(
        { length: 16 },
        (_, i) => ({ kind: 'update', key: (i % 4) + 1, row: renameRow((i % 4) + 1, i) }) as Command,
      ),
      { kind: 'flush_memtable' },
      { kind: 'compact', level: 0 },
    ],
  },
  {
    id: 'lsm-tombstone',
    engineId: LSM_ENGINE_ID,
    title: '④ 删除写的是墓碑',
    goal: '删 4 个键：砖块里出现红色墓碑标记。它们必须一直往下传，直到压实到最底层才敢真正丢掉 —— 否则下层的旧值会「复活」。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3 },
    commands: [
      { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'delete', key: i + 1 }) as Command),
      { kind: 'flush_memtable' },
      { kind: 'search', key: 2 },
    ],
  },
  {
    id: 'lsm-bloom',
    engineId: LSM_ENGINE_ID,
    title: '⑤ 布隆过滤器省掉的那些 IO',
    goal: '只写偶数键，再查一个落在区间内部的奇数键：布隆过滤器一个个判定「一定不存在」，整片文件被跳过，读放大接近 0。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 16 },
    commands: [
      ...Array.from({ length: 24 }, (_, i) => ({ kind: 'insert', key: (i + 1) * 2 }) as Command),
      { kind: 'search', key: 5 },
    ],
  },
  {
    id: 'lsm-no-bloom',
    engineId: LSM_ENGINE_ID,
    title: '⑥ 关掉布隆过滤器再查一次',
    goal: '同样的剧本，把布隆位数调成 0：每一层都得真的打开文件读一遍才知道没有 —— 这就是 LSM 的读放大。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 0 },
    commands: [
      ...Array.from({ length: 24 }, (_, i) => ({ kind: 'insert', key: (i + 1) * 2 }) as Command),
      { kind: 'search', key: 5 },
    ],
  },
  {
    id: 'lsm-tiered',
    engineId: LSM_ENGINE_ID,
    title: '⑦ leveled vs tiered',
    goal: '换成 tiered 压实：同层文件区间开始互相重叠，点查要在一层里试好几个文件。和 ② 的整齐排列对照着看。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3, compactionStyle: 'tiered', bloomBitsPerKey: 0 },
    commands: [
      { kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 21 },
    ],
  },
  {
    id: 'lsm-background',
    engineId: LSM_ENGINE_ID,
    title: '⑨ 刷写与压实根本不在写路径上',
    goal:
      '把后台任务上限调成 0：写 8 条会冻结两次，但**一个 SST 都不会生成** —— ' +
      '写路径只排了两个任务就返回了。这就是 LSM 写入快的全部秘密。看完点「推进后台」把活干掉。',
    config: { memtableLimit: 4, maxBackgroundJobs: 0, maxImmutableMemtables: 99, l0StopTrigger: 99 },
    commands: [{ kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'lsm-write-stall',
    engineId: LSM_ENGINE_ID,
    title: '⑩ 写入跑赢压实 → 写停顿',
    goal:
      '后台一点 CPU 都不给、冻结队列只允许 2 个：连写 40 条，积压一路涨到上限，' +
      '写路径被迫停下来自己刷盘 —— 事件日志里成片的 ⚠ 写停顿就是 LSM 最著名的运维事故现场。',
    config: { memtableLimit: 2, maxBackgroundJobs: 0, maxImmutableMemtables: 2, l0StopTrigger: 6 },
    commands: [{ kind: 'bulk_insert', count: 40, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'lsm-wal-lifecycle',
    engineId: LSM_ENGINE_ID,
    title: '⑪ WAL 为什么不会无限涨',
    goal:
      '每条写入先落 WAL 再改内存；MemTable 冻结时日志段封口，那份数据落成 SST 之后段就被回收。' +
      '所以 WAL 里永远只剩「还没落盘的那一小段」—— 面板上的「WAL 待恢复」就是这个数。',
    config: { memtableLimit: 4, maxBackgroundJobs: 4 },
    commands: [{ kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'lsm-crash-recovery',
    engineId: LSM_ENGINE_ID,
    title: '⑫ 崩溃：内存全丢，WAL 全救回来',
    goal:
      '先写 10 条但一条都不刷盘（全在 MemTable 与冻结队列里），然后触发崩溃：' +
      '内存结构瞬间清空，接着逐段重放 WAL 把 10 个键一条不少地装回来，并立刻落成 SST。' +
      '这是 WAL 唯一能证明自己有用的地方。',
    config: { memtableLimit: 4, maxBackgroundJobs: 0, maxImmutableMemtables: 99, l0StopTrigger: 99 },
    commands: [
      { kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 },
      { kind: 'crash' },
      { kind: 'full_scan' },
    ],
  },
  {
    id: 'lsm-range',
    engineId: LSM_ENGINE_ID,
    title: '⑧ 区间扫描用不上布隆过滤器',
    goal: '扫一段区间：布隆过滤器只能回答「有没有这个键」，回答不了「有没有这段区间」，所以每个重叠文件都得读。',
    config: { memtableLimit: 4, l0CompactionTrigger: 3, levelFanout: 3, bloomBitsPerKey: 16 },
    commands: [
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'range_scan', from: 5, to: 15 },
    ],
  },

  // ══ 列存 ═══════════════════════════════════════════════════
  {
    id: 'col-transpose',
    engineId: COLUMNAR_ENGINE_ID,
    title: '① 行 → 列的转置',
    goal:
      '写 12 行、每 6 行一组：落盘时同一列的值被拧到一起成为「列块」。' +
      '场景里横轴是列、纵深是行组，砖块越高说明这一列压得越狠。',
    config: { rowGroupSize: 6, vectorBatchSize: 3, zoneMaps: true },
    commands: [{ kind: 'bulk_insert', count: 18, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'col-encoding',
    engineId: COLUMNAR_ENGINE_ID,
    title: '② 每列各挑各的编码',
    goal:
      '看事件日志里每个列块选了什么：自增的 id 走 delta，只有 6 个取值的 city 走字典/RLE，' +
      '散乱的 score 压不动只能 plain。**同列同质**正是列存压缩比高的全部原因。',
    config: { rowGroupSize: 12, columnEncoding: 'auto' },
    commands: [{ kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'col-projection',
    engineId: COLUMNAR_ENGINE_ID,
    title: '③ 只读用到的那几列',
    goal:
      '同一份数据查两次：先 SELECT *（整片亮起来），再只取 id 一列（只有一条竖列亮）。' +
      '面板底部的「列存读 / 行存要读」直接给出省了百分之多少 —— 这就是列存的全部卖点。',
    config: { rowGroupSize: 12, zoneMaps: true },
    commands: [
      { kind: 'bulk_insert', count: 36, pattern: 'sequential', start: 1 },
      { kind: 'query', predicate: { kind: 'all' }, columns: '*' },
      { kind: 'query', predicate: { kind: 'all' }, columns: ['id'] },
    ],
  },
  {
    id: 'col-zonemap',
    engineId: COLUMNAR_ENGINE_ID,
    title: '④ 区间统计整块跳过',
    goal:
      '查 id ∈ [1,3]：每个列块都记着 min/max，只有第一个行组可能有匹配行，' +
      '其余整片塌下去变灰 —— 一个字节都没读。到参数面板关掉「区间统计剪枝」再跑一次对比。',
    config: { rowGroupSize: 4, zoneMaps: true },
    commands: [
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'range_scan', from: 1, to: 3 },
    ],
  },
  {
    id: 'col-point-cost',
    engineId: COLUMNAR_ENGINE_ID,
    title: '⑤ 列存的短板：点查一行',
    goal:
      '点查一个键：列存没有主键索引，只能靠区间统计缩小范围再逐列解码。' +
      '把它和 InnoDB 的 ① 并排看 —— 那边一次树下降就拿到整行，这边要把每一列都翻一遍。',
    config: { rowGroupSize: 4, zoneMaps: true },
    commands: [
      { kind: 'bulk_insert', count: 24, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 17 },
    ],
  },

  // ══ 哈希索引 KV ════════════════════════════════════════════
  {
    id: 'kv-append',
    engineId: KV_HASH_ENGINE_ID,
    title: '① 追加写 + 内存索引',
    goal:
      '写 10 条：每条都是「追加到活动文件末尾 + 改内存索引指向」。' +
      '上排是哈希桶（高度=冲突链），下面是日志文件。文件写满就封口，之后只读不写。',
    config: { kvLogFileRecords: 4, kvHashBuckets: 12 },
    commands: [{ kind: 'bulk_insert', count: 10, pattern: 'sequential', start: 1 }],
  },
  {
    id: 'kv-point-get',
    engineId: KV_HASH_ENGINE_ID,
    title: '② 点查：哈希一次 + 一次磁盘读',
    goal:
      '查一个存在的键与一个不存在的键：命中时黄线从桶直落到记录，全程就这一跳；' +
      '不存在时**连磁盘都不碰**。这个延迟与数据量完全无关 —— 哈希 KV 唯一但极强的卖点。',
    config: { kvLogFileRecords: 4, kvHashBuckets: 12 },
    commands: [
      { kind: 'bulk_insert', count: 16, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 7 },
      { kind: 'search', key: 999 },
    ],
  },
  {
    id: 'kv-no-range',
    engineId: KV_HASH_ENGINE_ID,
    title: '③ 范围扫描：做不到',
    goal:
      '试着扫 [1,5]：直接报错。哈希把键打散了，相邻的键落在完全不同的桶与文件里。' +
      '**这就是两类 KV 的分水岭** —— 要范围扫描就只能用有序结构（B+ 树或 LSM）。',
    config: { kvLogFileRecords: 4, kvHashBuckets: 12 },
    commands: [
      { kind: 'bulk_insert', count: 12, pattern: 'sequential', start: 1 },
      { kind: 'range_scan', from: 1, to: 5 },
    ],
  },
  {
    id: 'kv-garbage',
    engineId: KV_HASH_ENGINE_ID,
    title: '④ 覆盖写产生的垃圾与合并',
    goal:
      '把同 8 个键反复覆盖 4 轮：旧记录还躺在文件里变成暗红色垃圾，垃圾占比冲高后自动触发合并 ——' +
      '把还有效的记录搬进新文件、旧文件整体丢弃，索引同步改指向。',
    config: { kvLogFileRecords: 4, kvHashBuckets: 12, kvMergeThreshold: 0.4 },
    commands: [
      { kind: 'bulk_insert', count: 8, pattern: 'sequential', start: 1 },
      ...Array.from({ length: 32 }, (_, i) => ({ kind: 'insert', key: (i % 8) + 1 }) as Command),
    ],
  },
  {
    id: 'kv-collision',
    engineId: KV_HASH_ENGINE_ID,
    title: '⑤ 桶配少了会怎样',
    goal:
      '只给 3 个桶再写 30 个键：某几根桶明显长高，点查要在链上多走几步。' +
      '注意它**仍然与数据量无关** —— 变长的是链，不是查找复杂度的量级。',
    config: { kvHashBuckets: 3, kvLogFileRecords: 8 },
    commands: [
      { kind: 'bulk_insert', count: 30, pattern: 'sequential', start: 1 },
      { kind: 'search', key: 21 },
    ],
  },
];

export function TutorialPanel() {
  const busy = useSimStore((s) => s.busy);
  const switchEngine = useSimStore((s) => s.switchEngine);
  const run = useSimStore((s) => s.run);
  const engineId = useSimStore((s) => s.engineId);
  const [running, setRunning] = useState<string | null>(null);
  const [onlyCurrent, setOnlyCurrent] = useState(true);

  const engines = listEngines();
  const visible = onlyCurrent ? SCENARIOS.filter((s) => s.engineId === engineId) : SCENARIOS;

  const start = async (scenario: Scenario) => {
    setRunning(scenario.id);
    const store = useSimStore.getState();
    // 先安静地把整个场景跑完，再回到起点整体播放一遍。
    store.setAutoPlay(false);
    try {
      await switchEngine(scenario.engineId, { ...DEFAULT_ENGINE_CONFIG, ...scenario.config });
      const start = useSimStore.getState().history.length;
      for (const command of scenario.commands) {
        await run(command);
      }
      store.setAutoPlay(true);
      useSimStore.getState().goTo(start);
      useSimStore.getState().setSpeed(2);
      useSimStore.getState().play();
    } finally {
      store.setAutoPlay(true);
      setRunning(null);
    }
  };

  return (
    <Panel
      title="引导实验"
      subtitle="一键搭好场景，再用时间轴单步观察"
      right={
        <button className="dbkl-btn" onClick={() => setOnlyCurrent(!onlyCurrent)}>
          {onlyCurrent ? '显示全部引擎' : '只看当前引擎'}
        </button>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {engines.map((engine) => {
          const items = visible.filter((s) => s.engineId === engine.id);
          if (items.length === 0) return null;
          return (
            <li key={engine.id}>
              {!onlyCurrent && (
                <div className="mb-1 mt-1 text-[10px] uppercase tracking-[0.14em] text-mute-400">{engine.label}</div>
              )}
              <ul className="flex flex-col gap-1.5">
                {items.map((s) => (
                  <li key={s.id} className="rounded-md border border-ink-700 bg-ink-850/60 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[12px] font-medium text-mute-200">{s.title}</h3>
                      <button
                        className="dbkl-btn shrink-0"
                        data-testid={`scenario-${s.id}`}
                        disabled={busy || running !== null}
                        onClick={() => void start(s)}
                      >
                        <GraduationCap size={13} />
                        {running === s.id ? '进行中' : '开始'}
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-mute-400">{s.goal}</p>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
