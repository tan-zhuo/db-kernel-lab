# 架构

## 1. 分层

```
┌──────────────────────────────────────────────────────────────┐
│ UI 层        操作面板 / 参数面板 / 页检查器 / 指标 / 事件日志 / 时间轴 │
├──────────────────────────────────────────────────────────────┤
│ 可视化层     React Three Fiber 场景 + 2D 覆盖层 + 布局与高亮算法       │
│              apps/web/src/components/scene + packages/visualization │
├──────────────────────────────────────────────────────────────┤
│ 状态层       zustand store：游标 / 播放 / 命令日志 / 选中态            │
│              HistoryManager：事件流 + 稀疏检查点 + 命令区间索引        │
├──────────────────────────────────────────────────────────────┤
│ 仿真内核     SimulationEvent 协议 + applyEvent reducer               │
│              packages/simulation-core                                │
├──────────────────────────────────────────────────────────────┤
│ 查询处理     Predicate → 代价优化器 → PhysicalPlan → 算子执行           │
│              packages/simulation-core/src/query                       │
├──────────────────────────────────────────────────────────────┤
│ 引擎插件     BTreeEngine（InnoDB）· PostgresHeapEngine（堆表+MVCC）    │
│              LsmEngine（LSM-Tree）；共用 BPlusTree 与 BufferPool      │
│              全部运行在同一个 Web Worker 中，由引擎注册表按 id 装配     │
└──────────────────────────────────────────────────────────────┘
```

没有任何一层需要后端。`pnpm build` 的产物是纯静态文件。

**只有最底层知道自己是哪种数据库。** 上面所有层（可视化、状态、UI）都只认识
`SimulationEvent` 与 `EngineCapability`，因此换引擎不需要改任何视图代码 ——
面板与 3D 视图按能力挂载（见 §3.7）。

## 2. 一次操作的完整数据流

```
用户点击「插入 key=42」
   │
   ├─ store.run(command)  ── postMessage ──▶  Worker
   │                                            │ BTreeEngine.execute(command)
   │                                            │   → 就地修改引擎内部页表
   │                                            │   → 产生 SimulationEvent[]
   │   ◀────────── postMessage(events, chunked) ─┘
   │
   ├─ HistoryManager.push(events)
   │     ├─ applyEvent 推进 head 状态
   │     ├─ 每 N 个事件存一个检查点（会抽稀）
   │     └─ 维护命令区间索引（时间轴上的色块）
   │
   ├─ 游标回退到该命令起点 → 开始播放
   │
   └─ rAF 驱动：tick(dt) → 按逻辑时间推进游标
         ├─ applyEvent 归约进 LabState（原地修改 + version++）
         ├─ HighlightTracker.ingest(events)  ← 决定谁该发光、发多久
         └─ R3F useFrame：布局插值 → 写 InstancedMesh 矩阵与颜色
```

关键约束：**引擎的状态变化只能通过事件对外表达**。可视化层拿不到引擎对象，
只能拿到事件归约出的 `LabState`。这条铁律由 `packages/simulation-core/test/replay.test.ts`
守护：把整条事件流重放一遍，结构投影必须与引擎内部快照 `toEqual`。

## 3. 时间旅行

`HistoryManager` 保存：

* `events: SimulationEvent[]` —— 完整事件流，下标即 `seq`；
* `checkpoints: {index, state}[]` —— 稀疏全量快照（`structuredClone`）；
* `spans: CommandSpan[]` —— 每条命令的 `[startSeq, endSeq]` 与逻辑时间区间。

跳转 `stateAt(i)`：找到 `index ≤ i` 的最近检查点 → 克隆 → 重放不超过 `interval` 个事件。
向前单步走**增量归约**（不克隆），因此顺序播放是 O(1)/事件。

检查点上限 `maxCheckpoints`（默认 24）：超出后隔一个丢一个、间隔翻倍。
这让 10 万级事件的实验保持常数级内存开销，代价是长历史下跳转要多重放一些事件。

**逻辑时钟**：每类事件有固定「逻辑时长」（`EVENT_DURATION`，如页分裂 700ms、缓冲池命中 40ms），
播放按逻辑时间推进，因此关键事件天然停留更久。它与墙钟无关，1× 速度下 1 逻辑秒 ≈ 1 真实秒。

## 3.4 三种引擎的分工

| | InnoDB（`btree-engine.ts`） | PostgreSQL（`heap-engine.ts`） | LSM（`lsm-engine.ts`） |
|---|---|---|---|
| 表的物理形态 | 主键 B+ 树，叶子页就是数据 | 无序堆文件：行指针 + 元组 | MemTable + 分层 SST 文件 |
| 主键查询 | 一次树下降拿到整行 | 树下降拿到 TID，**再回堆一跳** | 自上而下逐层探测 |
| 更新 | 就地改叶子记录 | 写**新版本** + 旧版本打 xmax | 再追加一条新记录 |
| 删除 | 页内删除，可能触发合并 | 打 xmax，成为死元组 | 写一条**墓碑** |
| 旧版本住哪 | Undo 日志（表外，本仿真未建模） | 就在表里 → 膨胀 → VACUUM | 下层文件里 → 空间放大 → 压实 |
| 二级索引项 | (列, 主键) | (列, TID) | 无（只有主键序） |
| 空间回收 | 页内立即回收 | VACUUM | 压实 |
| 主要代价 | 回表的随机 IO | 回堆一跳 + 表膨胀 | 读放大 / 写放大 / 空间放大 |
| 能力声明 | `btree` `clustered-index` `secondary-index` `buffer-pool` | `btree` `secondary-index` `heap` `mvcc` `vacuum` `transactions` `buffer-pool` | `lsm` `compaction` `bloom-filter` `wal` |

**共享的部件**：`BPlusTree`（可复用的 B+ 树，宿主只需提供
`tieBreak(row)` 决定重复键之间怎么定序 —— InnoDB 用主键、PostgreSQL 用 TID）、
`BufferPool`、事件协议、时间轴、`Command` 命令集。

同一条命令（比如 `UPDATE key=2`）在三个引擎里会产生完全不同的事件流，
但走的是同一条 UI 通路 —— 这就是「并排对比」的物理基础。

## 3.5 多索引与回表

引擎里可以并存多棵 B+ 树，每棵由一个 `IndexRuntime` 描述（根页、首叶、树高、条目数与统计信息），
每个页都带 `indexId`。三条关键规则：

* **二级索引叶子项是 `(索引列, 主键)`**，不含其它列 —— 这正是「非覆盖查询必须回表」的物理原因；
* **二级索引允许重复键**。为此下降时用 `lowerBound`（相等键可能横跨页边界，落到最左候选页后
  再沿叶子链表向右扫），而唯一键的聚簇索引用 `upperBound`；
* **分裂时父页的分隔键插在「左子指针之后」**，而不是按键比较定位。重复键场景下按键比较会把新页
  排到所有相等分隔键之后，导致父页子指针顺序与叶子链表顺序不一致，进而错误合并不相邻的页
  （这个 bug 已被 `secondary-index.test.ts` 的重复键用例固定住）。

每次 DML 都会维护所有索引：一条 INSERT 在 N 棵树上各走一次「下降 + 写入 + 可能分裂」，
指标面板里的逻辑读与事件数会立刻反映这份写放大。

## 3.6 查询处理

```
Predicate ─┬─▶ collectStats()  ── INDEX_STATS 事件（优化器看到的统计信息）
           │
           ├─▶ buildPlan()     ── PLAN_READY 事件（算子树 + 候选方案代价）
           │
           └─▶ executePlan()   ── OPERATOR_OPEN/ROW/CLOSE + 扫描/回表事件
```

代价模型（`query/types.ts` 的 `COST`）刻意保持简单，但保留了真实优化器的三个特征：

1. 行数是**估算**的（等值用 `1/distinct`，范围按 min/max 线性插值），所以估算与实际经常不一致；
2. 回表按随机 IO 计价（`randomIO = 1.4`）并乘以聚簇索引树高，所以选择率一高，索引就不划算；
3. 覆盖索引（查询列 ⊆ 索引列 + 主键）直接省掉 `RowIdLookup` 节点，代价断崖式下降。

计划面板同时显示所有候选方案的估算代价，「优化器为什么没走索引」因此是可解释的。

堆表世界有**另一套**优化器（`query/heap-planner.ts`），因为那里没有聚簇索引：

* 「全表扫描」= Seq Scan，代价按**堆页数**算，并且**把死元组算进去** ——
  所以膨胀的表扫得更慢，VACUUM 之后同一条查询会变快；
* 任何索引扫描都要为每一行付一次回堆（随机 IO），主键查询也不例外；
* 只有当查询列全在索引里、**且**目标页在可见性映射里是 all-visible 时，
  才能退化成 Index Only Scan 省掉那一跳 —— 刚写完还没 VACUUM 的表享受不到。

LSM 没有优化器：它只有一条路（归并扫描 + 过滤），面板里照样给出计划，
方便和另外两个引擎并排看「有没有选择」这件事本身。

## 3.7 MVCC 与可见性（PostgreSQL 引擎）

每个元组带 `(xmin, xmax)`：谁插入的、谁删除的。读之前先取一份**快照**
`{xmin, xmax, active[]}`，然后逐条判断：

```
插入者已回滚            → 不可见
插入者 ≥ 快照 xmax      → 不可见（它在快照之后才开始）
插入者在 active 列表里  → 不可见（快照时它还没提交）
插入者未提交            → 不可见
─────────────────────────────────
xmax 为空               → 可见
xmax 已回滚 / 不在快照内 → 可见
否则                    → 不可见（已被删除）
```

判定过程整条落成 `VISIBILITY_CHECK` 事件，面板里能逐行看到「为什么这一版看不见」。

**隔离级别**靠快照的取用时机区分，而不是靠额外机制：
READ COMMITTED 每条语句取一次（`scope: 'statement'`），
REPEATABLE READ 在 BEGIN 时取一次并钉住整个事务（`scope: 'transaction'`）。

仿真是单线程的，但 `use_session` 命令允许**多个事务同时处于进行中**，
所以不可重复读是真的能跑出来的（见引导实验 ⑤/⑥），而不是讲个故事。

## 3.8 LSM 的三种放大

| 放大 | 定义 | 变大的原因 | 面板位置 |
|---|---|---|---|
| 写放大 | 落盘条目数 / 用户写入条目数 | 压实越勤，同一条数据被重写越多次 | LSM 面板 |
| 读放大 | 一次点查真正读过的 SST 数 | 层数越多、L0 文件越多；布隆过滤器能压低它 | LSM 面板 / 事件日志 |
| 空间放大 | 磁盘条目数 / 逻辑键数 | 压实越懒，旧版本与墓碑留得越久 | LSM 面板 |

三者互相拉扯，这就是 LSM 调参的全部难点。改 `MemTable 上限` /
`L0 触发值` / `层容量倍数` / `布隆位数` / `压实策略`，三个数字会一起动。

布隆过滤器是**真的实现**（位数组 + 双哈希），因此假阳性会自然发生：
事件日志里能看到「布隆说可能有 → 读了文件 → 其实没有」这条完整链路。
把 `bloomBitsPerKey` 调小就能看到假阳性变多、读放大上升。

## 4. 确定性与会话恢复

引擎里所有随机性都来自种子化的 `Rng`（mulberry32），reducer 是纯函数，
事件里不含时间戳以外的环境量 —— 所以：

> 同一 `EngineConfig` + 同一命令序列 ⇒ 逐字节相同的事件流。

因此 IndexedDB 只持久化 `{config, commands, markers}`。刷新页面后，Worker 重放命令日志，
事件流被完全重建，游标恢复到末尾。这比存事件流小两个数量级，也顺带保证了引擎与 UI 的一致性。

## 5. 并发与性能

| 位置 | 手段 |
|---|---|
| 引擎计算 | 全部在 Web Worker；`EVENT_CHUNK_SIZE=4000` 分块回传，边收边画 |
| 事件归约 | 单帧最多归约 `MAX_EVENTS_PER_FRAME=400` 个事件，避免长任务 |
| 超大批次 | 单条命令产生 > 3000 事件时不自动播放，直接跳到结尾（仍可回看） |
| 页/槽渲染 | 两个 `InstancedMesh`（页体、槽位），逐实例矩阵与颜色，页数上千仍是 2 个 draw call |
| 连线 | 单个 `lineSegments` + 动态 `BufferAttribute`，边数不影响 draw call |
| 文字 | Canvas 贴图 + LRU（上限 400 张），页数 > 140 时只画选中页的标签 |
| 布局 | 每次状态推进重算一次，O(n log n)；纯函数、无副作用，便于单测 |

## 6. 简化点：与真实系统的差异

Phase 0/1 的目标是**语义正确**，不是字节级兼容。已知差异：

| 主题 | 本仿真 | 真实 InnoDB / PostgreSQL |
|---|---|---|
| 页容量 | 由 `order`（索引）/ `heapTuplesPerPage`（堆）决定槽位数；`pageSize` 只用于字节估算展示 | 由页字节数与行长共同决定 |
| 行格式 | 逻辑对象 `{列: 值}` | COMPACT/DYNAMIC 行格式、变长字段列表、NULL 位图、溢出页 |
| 页头 | 常量估算（102 B） | FIL header/trailer、页目录、槽位组（每组 4–8 条） |
| 分裂点 | `fillFactor` 参数；可选最右页右倾优化 | 中点分裂 + 顺序插入优化 + `MERGE_THRESHOLD` |
| 合并 | 低于半满立刻借位/合并 | 低于 `MERGE_THRESHOLD`（默认 50%）时才尝试，且是延迟的 |
| pin / latch | 无。任何驻留页都可能被淘汰 | pin 计数 + 页 latch，正在访问的页不会被淘汰 |
| 缓冲池 | 朴素 LRU / CLOCK | LRU 分 young/old 子链、预读、自适应哈希索引、Change Buffer |
| 刷盘 | 淘汰脏页时同步刷 | 后台刷盘线程、检查点、双写缓冲 |
| 并发 | 单线程；`use_session` 可让多个事务同时进行，但**没有行锁与等待**：写冲突直接报错而不是阻塞 | 行锁/间隙锁、锁等待、死锁检测 |
| 日志 | InnoDB / PG 引擎无 Redo；LSM 引擎有 WAL 事件但不做崩溃恢复重放 | Redo/Undo/WAL、LSN、崩溃恢复 |
| MVCC 版本存放 | PostgreSQL 引擎：版本就在堆里（真实语义）；InnoDB 引擎：**不建模** Undo 版本链 | InnoDB 走 Undo 日志，PG 走堆内多版本 |
| 事务号 | 单调递增，不建模 freeze / 回卷 | 32 位回卷 + freeze + autovacuum 防回卷 |
| VACUUM | 手动触发；lazy 清死元组 + 剪 HOT 链，full 额外回收空页 | autovacuum 后台进程、FSM/VM 精细维护、并行 vacuum |
| 可见性映射 | 每页一个 all-visible 位，VACUUM 置位、任何写入清位 | 每页两位（all-visible / all-frozen），配合 freeze |
| LSM 块缓存 | 无（LSM 引擎不接 Buffer Pool） | Block Cache + 行缓存 + 索引/过滤器块缓存 |
| LSM 文件切分 | 按条目数切，不建模 SST 内部的块 / 索引块 / footer | 数据块 + 索引块 + 过滤器块 + 元数据 |
| LSM 迭代器 | 区间扫描直接物化归并视图 | 多路归并迭代器 + 前缀/区间过滤器 |
| 二级索引 | 单列数值索引；重复键之间的顺序由插入顺序决定 | 复合键 `(列…, 主键)`，重复键按主键排序 |
| 索引键类型 | 仅数值列 | 任意可比较类型（字符串、日期、复合列…） |
| UNIQUE 约束 | 不支持（二级索引一律非唯一） | 支持唯一索引与冲突检测 |
| 统计信息 | 引擎内实时维护，查询前整体刷新 | 采样直方图、持久化、后台自动 ANALYZE |
| 优化器 | 单表、单列谓词、三种候选方案 | 多表连接、连接顺序、多列统计、直方图、索引下推 |
| 算子 | Project / Filter / TableScan / IndexSeek / IndexRangeScan / RowIdLookup | 完整算子集合（Join、Sort、Aggregate、Window…） |

这些条目会随 Phase 推进逐条消除，**新增功能时请同步更新本表**。

## 7. 加新引擎（Phase 4+ 的扩展路径）

已经按这条路径加进来的：`PostgresHeapEngine`（Phase 2）与 `LsmEngine`（Phase 3）。

1. 在 `packages/simulation-core/src/engine/` 下实现 `StorageEngine` 接口
   （需要 B 树就复用 `BPlusTree`，实现 `TreeHost` 即可）；
2. 需要的新事件加进 `SimulationEventBody` 联合类型 —— TypeScript 会强制你在
   `EVENT_CATEGORY`、`EVENT_DURATION`、`describeEvent`、`applyEvent` 四处补齐分支；
3. 在 `applyEvent` 里写归约逻辑，并为它补一条「引擎快照 == 重放结果」的测试；
4. `registerEngine({...})` 注册到 `EngineRegistry`；
5. 可视化层按 `capabilities` 决定挂哪些视图与面板，**不要按引擎 id 分支**：

   | 能力 | 挂上的东西 |
   |---|---|
   | `btree` | `BTreeView`（B+ 树森林）、索引提示与投影旋钮、阶数/填充因子参数 |
   | `heap` | `HeapView`（堆文件 + 版本链 + 索引→堆弧线）、堆页检查器、堆页容量参数 |
   | `lsm` | `LsmView`（MemTable + 分层 SST）、LSM 面板、SST 检查器、压实参数 |
   | `buffer-pool` | `BufferPoolView`、命中率/淘汰/脏页指标、缓冲池参数 |
   | `transactions` | 事务面板（会话切换、BEGIN/COMMIT/ROLLBACK、快照显示） |
   | `mvcc` | 可见性判定列表、膨胀率、HOT 统计 |
   | `vacuum` | VACUUM 按钮与上次清理结果 |
   | `secondary-index` | 索引管理面板 |

   UI 侧统一用 `useCapability(...)` 查询，第三方引擎声明同样的能力即可复用全部视图。

用户自定义引擎可以走动态 `import()`（Blob URL 或白名单模块），协议与内置引擎完全一致。
