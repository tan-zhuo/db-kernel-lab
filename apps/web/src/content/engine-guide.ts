import {
  COLUMNAR_ENGINE_ID,
  INNODB_BTREE_ENGINE_ID,
  KV_HASH_ENGINE_ID,
  LSM_ENGINE_ID,
  POSTGRES_HEAP_ENGINE_ID,
} from '@dbkl/simulation-core';

/**
 * 原理讲解的内容源。
 *
 * 写作原则：
 *  1. **先讲物理模型，再讲行为**。行为都是物理模型的推论，反过来讲就只能靠背；
 *  2. **每个机制都配一个可以立刻跑的实验**（`experiment`），理论落到 3D 场景上才算讲完；
 *  3. **短板与长处一起写**。只讲优点的介绍没有选型价值；
 *  4. **明确标注仿真的简化点**，别让读者把教学模型当成真实实现。
 *
 * 正文支持两个内联标记：`**加粗**` 与 `` `等宽` ``（见 GuideOverlay 的渲染器）。
 */

export type GuideBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'diagram'; text: string; caption?: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'callout'; tone: 'key' | 'warn' | 'tip'; title: string; text: string };

export interface GuideSection {
  id: string;
  title: string;
  blocks: GuideBlock[];
  /** 讲完这个机制，可以立刻跑的实验。 */
  experiment?: { scenarioId: string; label: string };
}

export interface EngineGuide {
  /** 对应的引擎 id；`compare` 页没有引擎。 */
  engineId: string | null;
  key: string;
  nav: string;
  title: string;
  tagline: string;
  sections: GuideSection[];
}

// ══════════════════════════════════════════════════════════════
// MySQL · InnoDB
// ══════════════════════════════════════════════════════════════

const INNODB: EngineGuide = {
  engineId: INNODB_BTREE_ENGINE_ID,
  key: 'innodb',
  nav: 'MySQL · InnoDB',
  title: 'InnoDB：主键索引就是表本身',
  tagline: '聚簇 B+ 树。理解它只需要记住一件事：叶子页里装的不是指针，是整行数据。',
  sections: [
    {
      id: 'model',
      title: '物理模型',
      blocks: [
        {
          kind: 'prose',
          text: 'InnoDB 把整张表组织成**一棵按主键排序的 B+ 树**，这棵树就是表 —— 没有独立于索引之外的「数据区」。内部页只放 `(分隔键, 子页号)`，叶子页放**完整的行**，叶子页之间还用双向链表串起来。',
        },
        {
          kind: 'diagram',
          text: `                  ┌─────────────────┐
     内部页 →      │  25   │   50    │      只有分隔键与子页指针
                  └──┬────┴────┬────┘
             ┌───────┘         └───────┐
     叶子页 → ┌──────────┐        ┌──────────┐
             │ 1  ..  24│ ←────→ │ 25 .. 49 │   叶子里是整行
             │ 整行数据  │  链表   │ 整行数据  │   相邻叶子用链表相连
             └──────────┘        └──────────┘`,
          caption: '聚簇索引：树 = 表',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '这一个设计决定了后面所有行为',
          text: '主键点查走到叶子就拿到整行，一次树下降搞定；范围扫描定位一次后沿叶子链表顺着走，几乎是顺序 IO；但反过来，任何**非主键**的访问路径都得先绕回主键，这就是回表。',
        },
      ],
    },
    {
      id: 'split',
      title: '写入：页分裂与树的生长',
      blocks: [
        {
          kind: 'prose',
          text: '插入先从根页按分隔键一路下降到目标叶子页，在页内有序位置写入。页写满了就**分裂**：把记录切成两半，右半搬到新页，把右页的首键作为分隔键**上浮**到父页。父页也满就继续往上分裂；一路分裂到根页，树就长高一层。',
        },
        {
          kind: 'prose',
          text: '分裂点由 `fillFactor` 决定。均分（0.5）让两页各半满，但顺序插入时右页会立刻再满；所以 InnoDB 对「最右页 + 递增主键」有专门优化：几乎不搬数据，新页从空开始接着写。参数面板里的「顺序插入右倾优化」就是它。',
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '为什么推荐自增主键',
          text: '递增主键只往最右页追加，分裂集中在一处、页填充率高；随机主键（比如 UUID）会让分裂散布在整棵树上，页填得七零八落，写放大与空间浪费都明显。跑一次实验 ④ 就能看到两者的差别。',
        },
      ],
      experiment: { scenarioId: 'split', label: '看页分裂与树高增长' },
    },
    {
      id: 'delete',
      title: '删除：借位与页合并',
      blocks: [
        {
          kind: 'prose',
          text: '删除后如果叶子页低于半满，先尝试向**兄弟页借**一条记录（借位，同时更新父页分隔键）；借不到（兄弟也只是刚好半满）就**合并**两页并回收其中一页，父页少一个分隔键。父页因此变得太空就继续往上合并，一路合到根页只剩一个子页时，树高回落一层。',
        },
        {
          kind: 'callout',
          tone: 'warn',
          title: '仿真的简化点',
          text: '真实 InnoDB 用 `MERGE_THRESHOLD`（默认 50%）且是延迟合并的，不会像这里一样一低于半满就立刻动手。本仿真选择立刻合并，是为了让结构变化在时间轴上看得见。',
        },
      ],
      experiment: { scenarioId: 'merge', label: '看借位与页合并' },
    },
    {
      id: 'secondary',
      title: '二级索引与回表',
      blocks: [
        {
          kind: 'prose',
          text: '二级索引是**另一棵 B+ 树**，叶子项只有 `(索引列, 主键)`，不含其它列。所以按二级索引查询时：先在二级索引树里定位拿到主键，再**回到聚簇索引**走一次完整下降取整行 —— 这就是回表。',
        },
        {
          kind: 'diagram',
          text: `  二级索引 idx_score              聚簇索引 PRIMARY
  ┌──────────────┐               ┌──────────────┐
  │ (score, id)  │  ── 回表 ──▶   │  整行数据     │
  └──────────────┘   拿 id 再     └──────────────┘
                     下降一次`,
        },
        {
          kind: 'prose',
          text: '如果查询要的列**全都在**二级索引里（索引列 + 主键），就不用回表了 —— 这叫**覆盖索引**，执行计划里的 `RowIdLookup` 会直接消失。这也是「查询只 select 需要的列」这条建议的物理依据。',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '回表是随机 IO，所以索引不总是更快',
          text: '每次回表都要走一遍聚簇索引的树高。命中行数一多，随机 IO 的总代价就会超过顺序扫全表 —— 优化器因此会主动放弃索引。计划面板里能看到两个方案的估算代价并排摆着。',
        },
      ],
      experiment: { scenarioId: 'secondary-index', label: '看回表的那条粉色弧线' },
    },
    {
      id: 'buffer',
      title: 'Buffer Pool',
      blocks: [
        {
          kind: 'prose',
          text: '所有页访问都先过 Buffer Pool：命中就直接用，未命中要装入一个帧；帧满了就按策略（LRU / CLOCK）淘汰一个，被淘汰的页如果是脏页就先刷盘。命中率是这里最关键的指标。',
        },
        {
          kind: 'callout',
          tone: 'warn',
          title: '仿真的简化点',
          text: '没有 pin 计数，所以正在被访问的页也可能被淘汰；LRU 也没有分 young/old 子链，因此看不到真实 InnoDB 防「全表扫描冲垮缓冲池」的那套机制。',
        },
      ],
      experiment: { scenarioId: 'buffer-thrash', label: '看缓冲池抖动' },
    },
    {
      id: 'cost',
      title: '代价与适用',
      blocks: [
        {
          kind: 'table',
          headers: ['操作', '代价', '为什么'],
          rows: [
            ['主键点查', '★ 最优', '一次树下降直接拿到整行'],
            ['主键范围扫描', '★ 最优', '定位一次后沿叶子链表顺序走'],
            ['二级索引点查', '中等', '两次下降（索引 + 回表）'],
            ['二级索引宽范围', '差', '回表次数 × 树高的随机 IO，不如全表扫'],
            ['按主键顺序插入', '★ 好', '只动最右页'],
            ['随机主键插入', '差', '分裂散布全树，页填充率低'],
          ],
        },
        {
          kind: 'prose',
          text: '**适合**：OLTP 点查与短事务、主键访问占多数、需要范围扫描。这也是绝大多数业务系统的形态。',
        },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// PostgreSQL · 堆表 + MVCC
// ══════════════════════════════════════════════════════════════

const POSTGRES: EngineGuide = {
  engineId: POSTGRES_HEAP_ENGINE_ID,
  key: 'postgres',
  nav: 'PostgreSQL · 堆表 + MVCC',
  title: 'PostgreSQL：表是一堆无序的页，索引只是指路牌',
  tagline: '和 InnoDB 相反：这里没有聚簇索引，索引存的是 TID，所以取行永远要多跳一次。',
  sections: [
    {
      id: 'model',
      title: '物理模型',
      blocks: [
        {
          kind: 'prose',
          text: '表是一个**堆文件**：一串编号的页，页里是「行指针数组 + 元组」，**没有任何顺序保证**。索引是完全独立的 B 树，叶子项存的是 `(索引列, TID)`，TID 就是 `(块号, 行指针下标)`。',
        },
        {
          kind: 'diagram',
          text: `   索引（B 树，独立结构）
   ┌────────────────┐
   │ (id, ctid)     │
   └───────┬────────┘
           │ TID = (块号, 槽号)
           ▼
   堆文件（无序）
   ┌──────────────┐  ┌──────────────┐
   │ blk 0        │  │ blk 1        │
   │ lp0 lp1 lp2  │  │ lp0 lp1 ...  │   行指针数组
   │ 元组 元组 元组 │  │ 元组 ...      │   元组本体
   └──────────────┘  └──────────────┘`,
          caption: '索引与表彻底分离',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '主键查询也要回堆',
          text: 'InnoDB 走到索引叶子就拿到整行了；PostgreSQL 走到叶子只拿到一个 TID，**还得再去堆里读一次**。这一跳是所有索引扫描都逃不掉的，主键也不例外。',
        },
      ],
      experiment: { scenarioId: 'pg-heap-fetch', label: '看索引 → 堆的那一跳' },
    },
    {
      id: 'mvcc',
      title: 'MVCC：每一行都有多个版本',
      blocks: [
        {
          kind: 'prose',
          text: '每个元组头上带两个事务号：`xmin`（谁插入的）和 `xmax`（谁删除的）。**UPDATE 不是原地修改**，而是写一个新版本、给旧版本打上 xmax，并用 `t_ctid` 把旧版本指向新版本 —— 一串版本就是版本链。DELETE 更简单：只打 xmax，元组本体原地不动。',
        },
        {
          kind: 'diagram',
          text: `  UPDATE key=2 三次之后，堆里是这样：

  版本1              版本2              版本3
  xmin=100          xmin=101          xmin=102
  xmax=101 ──t_ctid─▶ xmax=102 ─t_ctid─▶ xmax=∅     ← 只有它是"活"的
  （死元组）          （死元组）          （活元组）`,
        },
        {
          kind: 'prose',
          text: '读的时候先取一份**快照** `{xmin, xmax, 活跃事务列表}`，然后对每个版本判断可见性：插入它的事务提交了吗？在我的快照之前吗？删除它的事务对我可见吗？判定过程在事务面板里逐条列出来，包括中文理由。',
        },
      ],
      experiment: { scenarioId: 'pg-version-chain', label: '看版本链长出来' },
    },
    {
      id: 'isolation',
      title: '隔离级别：区别只在快照什么时候取',
      blocks: [
        {
          kind: 'prose',
          text: '两个隔离级别的差别**不是**两套机制，而是同一套机制里快照的取用时机不同：',
        },
        {
          kind: 'list',
          items: [
            '`READ COMMITTED`：**每条语句**取一次新快照 ⇒ 同一个事务里两次查询可能看到不同结果（不可重复读）。',
            '`REPEATABLE READ`：**事务开始时**取一次并钉死 ⇒ 整个事务看到同一份世界，别人提交了也与我无关。',
          ],
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '这在实验室里是真跑出来的',
          text: '仿真虽然单线程，但支持多个会话同时开着事务。会话 A 开事务读一次 → 切到 B 写入并提交 → 切回 A 再读一次，两个隔离级别下的行数就是不一样的。事件日志里 `SNAPSHOT_TAKE` 的出现次数直接暴露了机制差别。',
        },
      ],
      experiment: { scenarioId: 'pg-read-committed', label: '看不可重复读发生' },
    },
    {
      id: 'hot',
      title: 'HOT 更新：不碰索引的那种更新',
      blocks: [
        {
          kind: 'prose',
          text: '「更新要写新版本」有个昂贵的副作用：新版本换了位置，于是**所有索引**都得插一条指向新 TID 的项 —— 哪怕那一列压根没改。',
        },
        {
          kind: 'prose',
          text: 'HOT（Heap-Only Tuple）就是为此而生：如果**没有改动任何被索引的列**，而且新版本能放进**同一个页**，那就不写任何索引项。索引继续指向旧版本，读的时候沿 `t_ctid` 往后走一步找到新版本。',
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '实践含义',
          text: '给一张表加索引，代价不只是索引本身的空间 —— 它还可能把大量 HOT 更新变成非 HOT 更新。「只给真正需要的列建索引」这条建议的物理依据就在这。',
        },
      ],
      experiment: { scenarioId: 'pg-hot', label: '对比 HOT 与非 HOT 更新' },
    },
    {
      id: 'vacuum',
      title: '表膨胀与 VACUUM',
      blocks: [
        {
          kind: 'prose',
          text: '死元组不会自己消失：它占着页里的位置，指向它的索引项也还在。删掉一半的行，表**一个字节都不会变小**，扫描反而更慢（要跳过更多死元组）。这就是表膨胀。',
        },
        {
          kind: 'prose',
          text: 'VACUUM 负责收拾：找出「谁都看不见了」的死元组（xmax 已提交且早于所有活跃事务），删掉指向它们的索引项，回收行指针。有个特殊情况 —— 如果死的是 HOT 链的**链头**（索引正指着它），不能直接删，要把行指针改成 `redirect` 指向链上还活着的版本，索引项才不用改。',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '可见性映射与 Index Only Scan',
          text: 'VACUUM 还会把「所有元组对所有事务都可见」的页标成 all-visible。**只有这样的页**才能被 Index Only Scan 跳过回堆 —— 所以刚写完还没 VACUUM 的表，覆盖查询照样要回堆。任何写入都会立刻清掉这个标记。',
        },
      ],
      experiment: { scenarioId: 'pg-bloat-vacuum', label: '看膨胀率涨上去再被清掉' },
    },
    {
      id: 'cost',
      title: '代价与适用',
      blocks: [
        {
          kind: 'table',
          headers: ['对比项', 'InnoDB', 'PostgreSQL 堆表'],
          rows: [
            ['主键点查', '一次下降', '一次下降 + **回堆一跳**'],
            ['更新', '就地改', '写新版本，旧版本留在表里'],
            ['旧版本放哪', 'Undo 日志（表外）', '**就在表里** → 膨胀'],
            ['空间回收', '页内立即回收', '靠 VACUUM'],
            ['长事务的代价', 'Undo 变长', '**死元组无法回收**，膨胀失控'],
            ['加列 / 改结构', '常要重建表', '很多情况只改元数据'],
          ],
        },
        {
          kind: 'prose',
          text: '**适合**：OLTP + 复杂查询、需要丰富索引类型与扩展。**要盯的**：长事务会拖住 VACUUM 的回收下限，是 PostgreSQL 生产事故最常见的根因。',
        },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// LSM-Tree
// ══════════════════════════════════════════════════════════════

const LSM: EngineGuide = {
  engineId: LSM_ENGINE_ID,
  key: 'lsm',
  nav: 'LSM-Tree · RocksDB',
  title: 'LSM-Tree：用「从不原地修改」换写入速度',
  tagline: '所有写都是顺序追加。代价是同一个键会散落在多层里，读要自上而下找，还要靠压实收拾残局。',
  sections: [
    {
      id: 'model',
      title: '物理模型',
      blocks: [
        {
          kind: 'prose',
          text: '内存里有一个有序的 **MemTable**，磁盘上是**分层**的 SST 文件。写入先落 WAL 再进 MemTable；MemTable 满了就整块冻结、刷成 L0 的一个 SST 文件。L0 文件互相重叠，往下每层由压实维护成互不重叠。',
        },
        {
          kind: 'diagram',
          text: `  内存   WAL ──▶ MemTable (有序)
                     │ 满了就冻结
                     ▼
  磁盘   L0  [a..z] [c..q] [b..k]      ← 区间重叠，点查要全看
         L1  [a..f] [g..m] [n..z]      ← 互不重叠，每层最多读一个
         L2  [a..c][d..f][g..i]...     ← 容量是上一层的 N 倍`,
          caption: '越往下越大、越旧',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '更新与删除也是追加',
          text: '更新 = 再写一条同键的新记录；删除 = 写一条**墓碑**。旧值还躺在下层文件里，只是被上层盖住了。读的时候自上而下找，第一个命中的就是最新版本。',
        },
      ],
      experiment: { scenarioId: 'lsm-flush', label: '看 MemTable 冻结并刷成 L0' },
    },
    {
      id: 'background',
      title: '关键：刷写与压实都不在写路径上',
      blocks: [
        {
          kind: 'prose',
          text: '这是 LSM 写入快的**全部秘密**，也是最容易被忽略的一点。写路径只做两件事：把数据塞进 MemTable，满了就冻结并**排一个后台任务**，然后立刻返回。真正的刷盘与压实由后台线程做。',
        },
        {
          kind: 'diagram',
          text: `  put() ─▶ WAL ─▶ MemTable ─▶ 满? ─▶ 冻结 + 排队 ─▶ 返回 ✓
                                          │
  后台线程 ────────────────────────────────┴─▶ 刷盘 / 压实`,
        },
        {
          kind: 'callout',
          tone: 'warn',
          title: '还不上债就写停顿',
          text: '积压深度就是**压实债务**。冻结队列满了、或者 L0 文件堆到停写阈值，写路径就必须停下来自己干活 —— 这就是 LSM 最著名的运维事故现场：写入延迟突然出现尖刺。',
        },
      ],
      experiment: { scenarioId: 'lsm-write-stall', label: '把写停顿逼出来' },
    },
    {
      id: 'compaction',
      title: '压实：把债还掉',
      blocks: [
        {
          kind: 'prose',
          text: '压实把若干文件归并成新文件，顺手丢掉被覆盖的旧版本。两种主流策略：',
        },
        {
          kind: 'list',
          items: [
            '**leveled**：每层维护成互不重叠，所以点查每层最多读一个文件（读放大低）；代价是每次压实都要重写下一层的重叠文件（写放大高）。',
            '**tiered**：把同层文件整体归并推到下一层，不动下一层已有文件（写放大低）；代价是同层区间会重叠，点查要试好几个（读放大高）。',
          ],
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '墓碑只能在最底层丢',
          text: '如果在中间层就把墓碑扔了，下层的旧值会「复活」。所以墓碑必须一路往下传，直到再没有更旧的版本能被它盖住为止。',
        },
      ],
      experiment: { scenarioId: 'lsm-compaction', label: '看 L0 堆满触发压实' },
    },
    {
      id: 'bloom',
      title: '布隆过滤器：省掉不必要的文件读',
      blocks: [
        {
          kind: 'prose',
          text: '点查最怕「查一个不存在的键」：每层都得打开文件确认一遍。布隆过滤器是每个 SST 附带的位数组，能回答「这个键**一定不在**这里」——一旦是否定答案就整个文件跳过，连打开都不用。',
        },
        {
          kind: 'callout',
          tone: 'warn',
          title: '它只会假阳性，不会假阴性',
          text: '说「没有」一定准；说「可能有」则可能是**假阳性** —— 读了文件才发现真没有。位数越多假阳性越低、内存越多。本仿真的布隆过滤器是真实现，所以事件日志里能看到假阳性自然发生。',
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '范围扫描用不上它',
          text: '布隆过滤器只能回答「有没有这个键」，回答不了「有没有这段区间」。所以区间扫描每个重叠文件都得读 —— 这也是 LSM 范围查询比点查贵得多的原因。',
        },
      ],
      experiment: { scenarioId: 'lsm-bloom', label: '看布隆过滤器挡掉整片文件' },
    },
    {
      id: 'wal',
      title: 'WAL：为什么它不会无限涨',
      blocks: [
        {
          kind: 'prose',
          text: 'MemTable 在内存里，进程一崩就没了。WAL 的作用就是兜住这部分：**先写日志再改内存**，崩溃后重放日志把 MemTable 重建出来。',
        },
        {
          kind: 'prose',
          text: '关键在于它的生命周期：每个日志段绑定一个 MemTable，那份数据一旦落成 SST，这个段就被**整段回收**。于是有条不变式 —— **WAL 里保留的记录量 = 崩溃后需要重放的量**，它随刷盘上下浮动，不会单调增长。',
        },
      ],
      experiment: { scenarioId: 'lsm-crash-recovery', label: '模拟崩溃并从 WAL 还原' },
    },
    {
      id: 'cost',
      title: '三种放大：调参的全部矛盾',
      blocks: [
        {
          kind: 'table',
          headers: ['放大', '定义', '什么让它变大', '怎么压'],
          rows: [
            ['写放大', '落盘条目 / 用户写入条目', '压实越勤，同一条数据被重写越多次', '压实懒一点、用 tiered'],
            ['读放大', '一次点查真正读过的文件数', '层数多、L0 文件多', '布隆过滤器、leveled、勤压实'],
            ['空间放大', '磁盘条目 / 逻辑键数', '压实越懒，旧版本与墓碑留越久', '勤压实'],
          ],
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '它们互相拉扯',
          text: '压得勤：读放大与空间放大低，写放大高；压得懒：反过来。没有免费的午餐 —— 调参就是在这个三角里选一个位置。面板里三个数字会随参数实时联动。',
        },
        {
          kind: 'prose',
          text: '**适合**：写多读少、可以接受读放大、需要范围扫描（比如时序、日志、消息队列的元数据）。**不适合**：读延迟要求极其稳定的场景（压实会带来抖动）。',
        },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// 列存
// ══════════════════════════════════════════════════════════════

const COLUMNAR: EngineGuide = {
  engineId: COLUMNAR_ENGINE_ID,
  key: 'columnar',
  nav: '列存 · ClickHouse',
  title: '列存：把「一行的各列挨着放」改成「一列的各行挨着放」',
  tagline: '仅此一个改动，带来了极高的压缩比和「只读需要的列」——也带走了点查与更新的能力。',
  sections: [
    {
      id: 'model',
      title: '物理模型',
      blocks: [
        {
          kind: 'prose',
          text: '数据按**行组**切分（比如每 8192 行一组），每个行组内部再**按列**拆成一个个「列块」。同一列的值在物理上连续存放，各自独立编码压缩。',
        },
        {
          kind: 'diagram',
          text: `  行存：  [id1 name1 city1 score1][id2 name2 city2 score2]...
          └── 一行的各列挨着 ⇒ 读一列 = 把整行都拖进来

  列存：  行组 1 ┌ id:    [1 2 3 4 5 6 7 8]    ← delta 编码
                ├ name:  [a b c d e f g h]
                ├ city:  [京 沪 京 沪 京 沪...]  ← 字典/RLE 压得极狠
                └ score: [83 12 47 ...]
          行组 2 ┌ ...`,
          caption: '同一列的值连续存放',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '压缩比高不是因为算法好，是因为数据同质',
          text: '一行里 int、字符串、时间戳混在一起，压不动；一列里全是同类型、往往还高度重复的值，随便挑个编码都能压掉大半。',
        },
      ],
      experiment: { scenarioId: 'col-transpose', label: '看行→列的转置发生' },
    },
    {
      id: 'encoding',
      title: '每列各挑各的编码',
      blocks: [
        {
          kind: 'table',
          headers: ['编码', '适用', '怎么存', '典型场景'],
          rows: [
            ['delta', '严格递增', '首值 + 相邻差值', '自增主键、时间戳'],
            ['dictionary', '不同值很少', '字典 + 每行一个小下标', '城市、状态、枚举'],
            ['rle', '连续重复', '(值, 重复次数)', '排序过的低基数列'],
            ['plain', '以上都不划算', '原样存', '高基数随机值'],
          ],
        },
        {
          kind: 'prose',
          text: '选择是**按列自动**做的：看基数、看游程数、看是否递增。事件日志里每个列块都会写明它选了什么、压缩比多少 —— 对着看一遍就明白为什么有的列压得动、有的压不动。',
        },
      ],
      experiment: { scenarioId: 'col-encoding', label: '看每列选了什么编码' },
    },
    {
      id: 'pruning',
      title: '两级剪枝：少读列 + 少读行组',
      blocks: [
        {
          kind: 'prose',
          text: '**列裁剪**：查询只需要触碰「谓词列 ∪ 投影列」。`SELECT id FROM t` 在一张 50 列的表上只读 1/50 的数据 —— 行存做不到这件事，因为一行的各列物理上黏在一起。',
        },
        {
          kind: 'prose',
          text: '**区间统计剪枝**（zone map / min-max 索引）：每个列块记着自己的 min/max。谓词区间与它没有交集，整个行组直接跳过，**一个字节都不用读**。这在数据按某列大致有序时（比如按时间追加）效果极好。',
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '这就是「别写 SELECT *」在列存里的分量',
          text: '在行存里 `SELECT *` 只是多传了点数据；在列存里它意味着**读的字节数翻了列数那么多倍**。面板底部的 IO 账单会直接给出省了百分之多少。',
        },
      ],
      experiment: { scenarioId: 'col-projection', label: '对比 SELECT * 与只取一列' },
    },
    {
      id: 'vectorized',
      title: '向量化执行',
      blocks: [
        {
          kind: 'prose',
          text: '传统执行器一行一行地过算子（火山模型），每行都要走一遍虚函数调用。向量化改成**一次处理一批**（几千行），把循环压进紧凑的数组操作里，CPU 缓存与分支预测都友好得多。列存天然适合向量化 —— 数据本来就是按列成批躺着的。',
        },
      ],
    },
    {
      id: 'cost',
      title: '代价与适用',
      blocks: [
        {
          kind: 'callout',
          tone: 'warn',
          title: '短板同样明显，别只记住优点',
          text: '① 点查一行**更贵**：没有主键索引，只能靠剪枝缩小范围再把每一列都解一遍；② **改一行等于重写整个行组**，所以列存基本不支持原地 UPDATE/DELETE，变更走「批量追加 + 后台合并」；③ 高基数列压不动，压缩比的美好数字往往来自那几个枚举列。',
        },
        {
          kind: 'table',
          headers: ['操作', '行存（InnoDB）', '列存'],
          rows: [
            ['取一整行', '★ 一次下降', '差：每列各解一次'],
            ['扫一列做聚合', '差：整行都要读', '★ 只读那一列'],
            ['宽表少列查询', '差', '★★ 差距随列数放大'],
            ['更新一行', '★ 就地改', '**不支持**'],
            ['压缩比', '低（行内异质）', '★ 高（列内同质）'],
          ],
        },
        {
          kind: 'prose',
          text: '**适合**：分析型负载 —— 宽表、大扫描、少数列、聚合。**不适合**：点查、频繁单行更新的在线业务。真实系统常见的做法是行存与列存并存，各管一段。',
        },
      ],
      experiment: { scenarioId: 'col-point-cost', label: '看列存点查有多别扭' },
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// 哈希索引 KV
// ══════════════════════════════════════════════════════════════

const KV: EngineGuide = {
  engineId: KV_HASH_ENGINE_ID,
  key: 'kv',
  nav: 'KV · 哈希索引',
  title: '哈希索引 KV：彻底放弃顺序，换一次寻址',
  tagline: 'Bitcask 风格。点查恒定一次磁盘读，代价是范围扫描根本做不了、键数被内存卡死。',
  sections: [
    {
      id: 'model',
      title: '物理模型',
      blocks: [
        {
          kind: 'prose',
          text: '磁盘上只有**追加写的日志文件**：写满一个就封口，之后只读不写，新写入进下一个。内存里是一张哈希表，`key → (文件, 偏移)`。**所有键都在内存里**。',
        },
        {
          kind: 'diagram',
          text: `  内存   哈希表（全部键常驻）
         桶0 ─ k7 ─ k23        每个桶挂一条冲突链
         桶1 ─ k4
         桶2 ─ k11 ─ k9 ─ k31
                 │ (文件, 偏移)
                 ▼
  磁盘   log-1 [封口] ████░█████    █ 有效  ░ 被覆盖的垃圾
         log-2 [封口] ██░░██████
         log-3 [活动] ████▏         ← 只有它可写`,
        },
        {
          kind: 'prose',
          text: '写一条记录只有两步：**追加**到活动文件末尾，**改内存索引**指向新位置。旧记录还躺在文件里，但从此没人能找到它，成了垃圾。',
        },
      ],
      experiment: { scenarioId: 'kv-append', label: '看追加写 + 改索引' },
    },
    {
      id: 'read',
      title: '读路径：为什么是「恒定一次」',
      blocks: [
        {
          kind: 'prose',
          text: '点查全程只有两步：桶内走一小段冲突链（纯内存），按偏移读一次磁盘。**与数据量完全无关** —— 一千条和一亿条，步数一样。键不存在时更省，连磁盘都不用碰。',
        },
        {
          kind: 'callout',
          tone: 'key',
          title: '和 LSM 对照着看',
          text: 'LSM 点查要自上而下逐层探测，读放大随层数增长，还得靠布隆过滤器缓解。哈希 KV 没有这个问题 —— 它把「顺序」这个东西整个扔掉了，换来的就是这份确定性。',
        },
      ],
      experiment: { scenarioId: 'kv-point-get', label: '看一次寻址的全过程' },
    },
    {
      id: 'no-range',
      title: '代价一：范围扫描根本做不到',
      blocks: [
        {
          kind: 'prose',
          text: '哈希把键**打散**了：相邻的键落在完全不同的桶里，对应的记录也散在不同文件的不同偏移上。要扫 `[100, 200]`，唯一办法是把所有键都遍历一遍再筛 —— 那已经不叫范围扫描了。',
        },
        {
          kind: 'callout',
          tone: 'warn',
          title: '这是选型的第一个硬门槛',
          text: '业务里只要有一处需要「按时间倒序取最近 N 条」「按前缀扫一批」，哈希索引就出局了，必须换成有序结构（B+ 树或 LSM）。本引擎对范围扫描会直接报错，而不是偷偷退化成全表扫。',
        },
      ],
      experiment: { scenarioId: 'kv-no-range', label: '看它明确拒绝范围扫描' },
    },
    {
      id: 'memory',
      title: '代价二：内存索引就是规模上限',
      blocks: [
        {
          kind: 'prose',
          text: '所有键必须常驻内存。索引占用 ≈ 键数 × 每项开销（键本身 + 文件号 + 偏移 + 哈希表指针）。**键数一超过内存能装下的量，这个方案就直接崩了** —— 不是变慢，是不可用。',
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '注意区分「键数」和「数据量」',
          text: '反复更新同一批键，磁盘一直涨，但内存索引**一点不涨**（键数没变）。所以它很适合「键有限、值大、更新频繁」的场景；反过来「几十亿个小键」就是它的死穴。面板里两个数字是分开列的。',
        },
      ],
    },
    {
      id: 'merge',
      title: '空间回收：合并',
      blocks: [
        {
          kind: 'prose',
          text: '覆盖写和删除都会留下垃圾。合并把所有**封口文件**里仍然有效的记录搬进一个新文件，其余整体丢弃，索引同步改指向。活动文件不参与（它还在写）。',
        },
        {
          kind: 'prose',
          text: '判断一条记录是否有效很简单：**内存索引正好指着它**就有效，否则就是垃圾。这也是这类日志式存储的通用套路 —— LSM 的压实做的其实是同一件事。',
        },
      ],
      experiment: { scenarioId: 'kv-garbage', label: '看垃圾堆积再被合并回收' },
    },
    {
      id: 'cost',
      title: '代价与适用',
      blocks: [
        {
          kind: 'table',
          headers: ['', 'LSM（有序 KV）', '哈希索引 KV'],
          rows: [
            ['索引在哪', '磁盘上分层有序', '**全部常驻内存**'],
            ['点查', '逐层探测，读放大 > 1', '★ 恒定一次寻址'],
            ['范围扫描', '★ 天然支持', '**做不到**'],
            ['规模上限', '磁盘有多大放多大', '被内存卡死'],
            ['写入', '顺序追加', '顺序追加'],
            ['空间回收', '分层压实', '合并'],
          ],
        },
        {
          kind: 'prose',
          text: '**适合**：键数可控、只做点查、要求延迟稳定 —— 比如会话存储、对象元数据、缓存持久化。**出局条件**：需要范围扫描，或者键多到内存放不下。',
        },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// 怎么选
// ══════════════════════════════════════════════════════════════

const COMPARE: EngineGuide = {
  engineId: null,
  key: 'compare',
  nav: '怎么选：五者对比',
  title: '五种存储引擎怎么选',
  tagline: '所有差别都能追溯到一个问题：数据在磁盘上是怎么摆的。',
  sections: [
    {
      id: 'one-question',
      title: '先问一个问题：数据怎么摆？',
      blocks: [
        {
          kind: 'prose',
          text: '把五个引擎的所有行为差异往回追，最终都落到「磁盘上的物理布局」这一件事上。记住布局，行为就是推论；只背行为，就永远要查表。',
        },
        {
          kind: 'table',
          headers: ['引擎', '磁盘上怎么摆', '一句话推论'],
          rows: [
            ['InnoDB', '按主键排序的 B+ 树，叶子=整行', '主键访问最优，其它路径都要绕回主键'],
            ['PostgreSQL', '无序堆 + 独立索引（存 TID）', '任何索引扫描都多一跳，更新留下死元组'],
            ['LSM', '内存有序表 + 磁盘分层有序文件', '写只追加所以快，读要逐层找'],
            ['列存', '按列连续存放，按行组切分', '压得狠、只读需要的列，但改不了单行'],
            ['哈希 KV', '追加写日志 + 内存哈希表', '一次寻址，但顺序彻底没有了'],
          ],
        },
      ],
    },
    {
      id: 'decision',
      title: '决策路径',
      blocks: [
        {
          kind: 'diagram',
          text: `  需要范围扫描 / 排序？
    ├─ 否 ─▶ 键数装得下内存？ ─ 是 ─▶ 哈希 KV
    │                          └ 否 ─▶ LSM
    └─ 是 ─▶ 主要是分析型大扫描？
              ├─ 是 ─▶ 列存
              └─ 否 ─▶ 写远多于读？
                        ├─ 是 ─▶ LSM
                        └─ 否 ─▶ B+ 树（InnoDB / PostgreSQL）`,
        },
        {
          kind: 'prose',
          text: '最后一步 InnoDB 还是 PostgreSQL，看的不是存储而是别的：是否需要复杂查询与扩展、能否管住长事务、团队更熟哪套运维。',
        },
      ],
    },
    {
      id: 'same-command',
      title: '同一条命令，五种命运',
      blocks: [
        {
          kind: 'prose',
          text: '这是本实验室最值得做的一件事：把同一条 `UPDATE key=2` 在五个引擎里各跑一遍，看事件流差别。',
        },
        {
          kind: 'table',
          headers: ['引擎', 'UPDATE key=2 实际发生了什么'],
          rows: [
            ['InnoDB', '下降到叶子页，**就地改**那条记录；若改了索引列，还要维护对应的二级索引树'],
            ['PostgreSQL', '写一个**新版本**，给旧版本打 xmax 并用 t_ctid 串起来；非 HOT 时**所有索引**都要插新项'],
            ['LSM', '往 MemTable **再追加一条**同键记录，旧值原封不动留在下层文件里'],
            ['列存', '**直接拒绝** —— 改一行要重写整个行组'],
            ['哈希 KV', '**追加一条**新记录到活动文件，改内存索引指向；旧记录立刻变成垃圾'],
          ],
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: '动手比读表管用',
          text: '在「操作」面板点几次「更新」，然后切引擎重复一遍，对着事件日志与 3D 场景看。五种引擎的性格差异，一轮就记住了。',
        },
      ],
    },
    {
      id: 'shared',
      title: '它们共享的东西比你以为的多',
      blocks: [
        {
          kind: 'list',
          items: [
            '**先写日志再改数据**：LSM 的 WAL、InnoDB 的 redo、PostgreSQL 的 WAL，都是同一个道理。',
            '**追加写 + 后台回收**：LSM 的压实、哈希 KV 的合并、PostgreSQL 的 VACUUM，本质都是「把还有效的挑出来、其余整体丢弃」。',
            '**用统计信息剪枝**：列存的 zone map、B 树优化器的直方图、LSM 的布隆过滤器，都是「先用便宜的元数据排除掉大部分，再去读贵的数据」。',
            '**三种放大到处都是**：写放大（一条数据被重写几次）、读放大（一次读碰了几处）、空间放大（占了几倍空间）—— 换个名字，五个引擎里都能找到。',
          ],
        },
      ],
    },
    {
      id: 'limits',
      title: '这个仿真没做的事',
      blocks: [
        {
          kind: 'prose',
          text: '目标是**语义正确**而非字节级兼容。以下都没有建模，别把教学模型当成真实实现：',
        },
        {
          kind: 'list',
          items: [
            '页内的字节布局、行格式、溢出页、TOAST；',
            '行锁与锁等待 —— 写冲突这里直接报错而不是阻塞；死锁检测同样没有；',
            '崩溃恢复（LSM 的 `crash` 是唯一的例外）、fsync 与组提交、校验和；',
            '真正的并发：仿真是单线程的，「后台线程」被建模成「每条命令间隙推进 N 个任务」；',
            '通用压缩算法（LZ4/ZSTD）、块缓存、SST 内部的块结构；',
            '多表连接、子查询、复合索引与字符串键。',
          ],
        },
        {
          kind: 'prose',
          text: '完整清单见仓库里的 `docs/architecture.md` 与 `docs/phase-checklists.md`，新增功能时会同步更新。',
        },
      ],
    },
  ],
};

export const ENGINE_GUIDES: EngineGuide[] = [INNODB, POSTGRES, LSM, COLUMNAR, KV, COMPARE];

export function guideForEngine(engineId: string): EngineGuide | undefined {
  return ENGINE_GUIDES.find((g) => g.engineId === engineId);
}
