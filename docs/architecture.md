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
│ 引擎插件     BTreeEngine：聚簇索引 + 二级索引（多棵 B+ 树）+ BufferPool │
│              运行在 Web Worker 中；未来的 Postgres / LSM / 列存同层    │
└──────────────────────────────────────────────────────────────┘
```

没有任何一层需要后端。`pnpm build` 的产物是纯静态文件。

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
| 页容量 | 由 `order` 决定槽位数；`pageSize` 只用于字节估算展示 | 由页字节数与行长共同决定 |
| 行格式 | 逻辑对象 `{列: 值}` | COMPACT/DYNAMIC 行格式、变长字段列表、NULL 位图、溢出页 |
| 页头 | 常量估算（102 B） | FIL header/trailer、页目录、槽位组（每组 4–8 条） |
| 分裂点 | `fillFactor` 参数；可选最右页右倾优化 | 中点分裂 + 顺序插入优化 + `MERGE_THRESHOLD` |
| 合并 | 低于半满立刻借位/合并 | 低于 `MERGE_THRESHOLD`（默认 50%）时才尝试，且是延迟的 |
| pin / latch | 无。任何驻留页都可能被淘汰 | pin 计数 + 页 latch，正在访问的页不会被淘汰 |
| 缓冲池 | 朴素 LRU / CLOCK | LRU 分 young/old 子链、预读、自适应哈希索引、Change Buffer |
| 刷盘 | 淘汰脏页时同步刷 | 后台刷盘线程、检查点、双写缓冲 |
| 并发 | 单线程、无事务 | MVCC、Undo 日志、行锁/间隙锁、死锁检测 |
| 日志 | 无 Redo/WAL | Redo/Undo/WAL、LSN、崩溃恢复 |
| 二级索引 | 单列数值索引；重复键之间的顺序由插入顺序决定 | 复合键 `(列…, 主键)`，重复键按主键排序 |
| 索引键类型 | 仅数值列 | 任意可比较类型（字符串、日期、复合列…） |
| UNIQUE 约束 | 不支持（二级索引一律非唯一） | 支持唯一索引与冲突检测 |
| 统计信息 | 引擎内实时维护，查询前整体刷新 | 采样直方图、持久化、后台自动 ANALYZE |
| 优化器 | 单表、单列谓词、三种候选方案 | 多表连接、连接顺序、多列统计、直方图、索引下推 |
| 算子 | Project / Filter / TableScan / IndexSeek / IndexRangeScan / RowIdLookup | 完整算子集合（Join、Sort、Aggregate、Window…） |

这些条目会随 Phase 推进逐条消除，**新增功能时请同步更新本表**。

## 7. 加新引擎（Phase 2+ 的扩展路径）

1. 在 `packages/simulation-core/src/engine/<name>/` 实现 `StorageEngine` 接口；
2. 需要的新事件加进 `SimulationEventBody` 联合类型 —— TypeScript 会强制你在
   `EVENT_CATEGORY`、`EVENT_DURATION`、`describeEvent`、`applyEvent` 四处补齐分支；
3. 在 `applyEvent` 里写归约逻辑，并为它补一条「引擎快照 == 重放结果」的测试；
4. `registerEngine({...})` 注册到 `EngineRegistry`；
5. 可视化层按 `capabilities` 决定挂哪些视图（B+ 树视图、LSM 视图、列存视图……）。

用户自定义引擎可以走动态 `import()`（Blob URL 或白名单模块），协议与内置引擎完全一致。
