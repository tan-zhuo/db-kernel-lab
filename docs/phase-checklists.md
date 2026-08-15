# Phase 验收清单

状态标记：✅ 已完成 · 🟡 部分完成 · ⏳ 未开始

## Phase 0 —— 基础框架与最小可运行切片

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 0.1 | Vite + React + TS + R3F 纯客户端脚手架 | ✅ | `apps/web`，`pnpm build` 产出纯静态文件 |
| 0.2 | 基础 3D 场景、相机控制、UI 壳子 | ✅ | `components/scene/SceneRoot.tsx`、`App.tsx` |
| 0.3 | 时间轴组件与 HistoryManager 原型 | ✅ | `components/timeline/Timeline.tsx`、`simulation-core/src/history.ts` |
| 0.4 | Web Worker 通信骨架 | ✅ | `workers/simulation.worker.ts` + `lib/worker-client.ts`（分块回传） |
| 0.5 | 手动触发的 B+ 树插入 + 分裂 3D 动画 + 单步回放 | ✅ | 引导实验 ①；e2e `跳到下一次页分裂…` |

## Phase 1 —— InnoDB 核心存储与基础执行

对应文档附录 A 的验收 Checklist：

| # | 验收项 | 状态 | 说明 |
|---|---|---|---|
| 1.1 | 可创建指定列的表并选择主键 | ✅ | 「表结构」面板可增删列、改类型、选主键，提交即重建实验（e2e `CREATE TABLE 表单可以重建实验`） |
| 1.2 | 连续插入触发页分裂，3D 动画流畅且可回放 | ✅ | `btree.test.ts` 覆盖 order 3/4/5/8；动画走位置插值 |
| 1.3 | 二级索引 + 回表路径可视化 | ✅ | 多棵 B+ 树并排渲染，二级索引叶子项为 (列值, 主键)；回表在 3D 中画成跨树粉色弧线 + 滑动光点，事件为 `LOOKUP_BACK`/`LOOKUP_DONE` |
| 1.4 | Buffer Pool 命中 / 淘汰可视化 | ✅ | 3D 货架视图 + 命中率、淘汰、刷盘指标；LRU 与 CLOCK 双策略 |
| 1.5 | 时间轴支持单步、快进、回退到任意历史点 | ✅ | 0.1×–8× 速度、打点、区间循环、跳到下一次分裂/淘汰 |
| 1.6 | 所有关键状态变化都有对应 SimulationEvent | ✅ | 62 种事件；`replay.test.ts` / `secondary-index.test.ts` 断言重放 == 引擎快照 |
| 1.7 | 重操作在 Web Worker 中执行，主线程流畅 | ✅ | 单帧归约上限 400 事件；> 3000 事件的批次不自动播放 |
| 1.8 | 刷新页面后可从 IndexedDB 恢复实验会话 | ✅ | 持久化命令日志 + 确定性重放；e2e `会话持久化` |
| 1.9 | 核心插入与分裂逻辑有测试覆盖 | ✅ | 109 项单元测试（含随机负载下的多索引结构不变式校验；其中 41 项属于 Phase 2/3 的新引擎） |
| 1.10 | 可静态部署，无需后端 | ✅ | `base: './'`，无网络请求（字体走 Canvas 贴图而非 CDN） |
| 1.11 | 简单执行计划（Index Scan / Seq Scan）与数据流动画 | ✅ | 代价优化器输出物理计划（Project / Filter / TableScan / IndexSeek / IndexRangeScan / RowIdLookup），计划面板显示估算 vs 实际行数与候选方案代价；算子随时间轴逐行「吐行」 |
| 1.12 | DDL：CREATE TABLE + 创建索引过程 | ✅ | `CREATE INDEX` 会当场顺序扫描聚簇索引并逐条灌入新树（可回放的在线建索引过程）；`DROP INDEX` 逐页回收 |
| 1.13 | 覆盖索引 / 优化器选择对比 | ✅ | 投影列可切换「SELECT *」与「仅索引列 + 主键」，前者回表后者不回表；索引提示可强制全表扫描做对比实验 |

**超出原 Phase 1 范围、已提前完成的部分**

* 删除路径的完整再平衡：兄弟页借位（`REDISTRIBUTE`）、页合并（`PAGE_MERGE`）、根页退化；
* 参数实验：填充因子、顺序插入右倾优化、淘汰策略、缓冲池帧数、随机种子；
* 11 个引导式实验场景（教程模式，原属 Phase 6），含二级索引/回表/覆盖索引/优化器选择/写放大；
* 统计信息（模拟 ANALYZE）与「统计过期」提示；
* 事件流 / 状态 JSON 导出与场景截图（原属 Phase 6）；
* Playwright 关键路径 e2e。

## Phase 1 剩余工作（下一步）

1. **页内微观视图**：目前页内部结构在右侧「页检查器」里以表格呈现（页头开销、槽位目录、行记录、
   字节占用、叶子链表指针）。还差 3D 版本：点击叶子页后相机切入页内部，用网格展示槽位目录
   与行记录的字节布局。
2. **算子间的数据流粒子**：计划面板已有逐算子的实际行数，但 3D 场景里还没有「记录粒子」
   在算子之间流动的动画。
3. **复合索引与字符串键**：需要把 `Key = number` 抽象成通用比较器（同时解决 varchar 索引）。
   三个引擎都受影响（PostgreSQL 的索引、LSM 的键序），所以这项要一次性做完。

## Phase 2 —— PostgreSQL 堆表 + MVCC

引擎：`packages/simulation-core/src/engine/heap-engine.ts`（`postgres-heap`）

| # | 验收项 | 状态 | 说明 |
|---|---|---|---|
| 2.1 | 堆表与索引分离：索引项存 TID 而非主键 | ✅ | 索引叶子项是 `(列值, ctid)`；3D 里索引树在上、堆文件在下 |
| 2.2 | 任何索引扫描都要回堆一跳 | ✅ | `HEAP_FETCH` 事件 + 蓝色弧线；指标面板的「回堆」计数（对照 InnoDB 的「回表」） |
| 2.3 | 顺序扫描完全不碰索引 | ✅ | Seq Scan 按块号读堆页；测试断言这条路径上一个 `DESCEND` 都没有 |
| 2.4 | MVCC 版本链：xmin / xmax / t_ctid | ✅ | `HEAP_SET_XMAX` 串起版本链，3D 里画成粉色连线；堆页检查器逐列摊开元组头 |
| 2.5 | 可见性判定可解释 | ✅ | 每次判定一条 `VISIBILITY_CHECK`，带中文理由；事务面板列出最近 12 条 |
| 2.6 | 显式事务与多会话 | ✅ | `begin/commit/abort_txn` + `use_session`；多个事务可同时进行 |
| 2.7 | 隔离级别差异可复现 | ✅ | READ COMMITTED 每语句取快照 / REPEATABLE READ 事务级快照；单测断言两次读到 `[3,4]` vs `[3,3]` |
| 2.8 | HOT 更新 | ✅ | 同页有空位且未改索引列 ⇒ 新版本不写任何索引项；关掉开关即可对比写放大 |
| 2.9 | 死元组与表膨胀 | ✅ | 膨胀率指标 + 3D 里死元组变暗红；删一半 ⇒ 50% |
| 2.10 | VACUUM：清死元组 + 删索引项 + 回收行指针 | ✅ | `HEAP_PRUNE` / `VACUUM_END`；HOT 链头被剪枝时改成 `redirect` 而非删除 |
| 2.11 | 可见性映射与 Index Only Scan | ✅ | VACUUM 置 all-visible 位，覆盖查询才能省掉回堆；任何写入立即清位 |
| 2.12 | 堆表专属优化器 | ✅ | `query/heap-planner.ts`：Seq Scan 代价含死元组、Index Scan 每行一跳、Index Only Scan 按 all-visible 比例折价 |
| 2.13 | 「引擎快照 == 事件重放」一致性测试 | ✅ | `heap-mvcc.test.ts`：混合负载 300 步 + 三组参数 + 确定性重放 |
| 2.14 | ALTER TABLE 过程 | ⏳ | 未做。建表/建索引已覆盖，加列/改类型的重写过程留待后续 |

## Phase 3 —— LSM-Tree

引擎：`packages/simulation-core/src/engine/lsm-engine.ts`（`lsm-tree`）

| # | 验收项 | 状态 | 说明 |
|---|---|---|---|
| 3.1 | MemTable → 冻结 → 刷成 L0 | ✅ | `MEMTABLE_PUT` / `MEMTABLE_FREEZE` / `SST_CREATE(source=flush)`；3D 里 MemTable 是顶部的水位条 |
| 3.2 | 写前先落 WAL | ✅ | `WAL_APPEND`，面板显示记录数与字节数 |
| 3.3 | 更新 = 追加新版本，旧版本仍在下层 | ✅ | 单测断言 MemTable 与 L0 文件里同时存在同一个键 |
| 3.4 | 删除 = 墓碑，压到最底层才回收 | ✅ | `tombstone` 标记；3D 里墓碑占比越高砖块越红 |
| 3.5 | 分层压实（leveled / tiered） | ✅ | L0 按文件数触发、其余层按容量触发；两种策略下逻辑数据必须完全一致（单测守护） |
| 3.6 | 层内不重叠是可见的几何事实 | ✅ | **横轴 = 键空间**：L0 砖块重叠且沿 z 轴堆叠，L1+ 整齐排开；单测断言 L1+ 区间严格递增 |
| 3.7 | 布隆过滤器（真实实现，会有假阳性） | ✅ | 位数组 + 双哈希；`BLOOM_PROBE` 区分「跳过」「可能有」「假阳性」 |
| 3.8 | 读放大 / 写放大 / 空间放大 | ✅ | 三个数字随参数实时变化；单测断言压实降低空间放大、leveled 读放大 ≤ tiered |
| 3.9 | 与参考实现逐键比对 | ✅ | 400 步随机读写删后，可见数据与普通 `Map` 完全一致 |
| 3.10 | 「引擎快照 == 事件重放」一致性测试 | ✅ | `lsm.test.ts`：300 步混合负载 + 三组参数 + 确定性重放 |
| 3.11 | 列存（列块 + 压缩 + 向量化） | ⏳ | 未开始，仍属 Phase 3 范围 |
| 3.12 | 块缓存 / SST 内部块结构 | ⏳ | 未做：LSM 引擎目前不接 Buffer Pool，SST 也不细分数据块/索引块 |

## 跨引擎能力矩阵

| 能力 | InnoDB | PostgreSQL 堆表 | LSM |
|---|---|---|---|
| `btree` | ✅ | ✅ | — |
| `clustered-index` | ✅ | — | — |
| `secondary-index` | ✅ | ✅ | — |
| `heap` | — | ✅ | — |
| `mvcc` / `transactions` / `vacuum` | — | ✅ | — |
| `buffer-pool` | ✅ | ✅ | — |
| `lsm` / `compaction` / `bloom-filter` / `wal` | — | — | ✅ |

UI 只按这张表挂载面板与 3D 视图，从不按引擎 id 分支。

## Phase 4+ 规划要点

* **Phase 4**：Redo/WAL 日志流与崩溃恢复重放、**行锁与死锁检测**
  （目前写冲突直接报错而非阻塞，这是 Phase 2 明确留下的缺口）、可串行化隔离级别。
* **Phase 5**：Region / Raft 日志复制 / Leader 选举 / 分布式事务。
* **Phase 6**：引擎插件动态加载、双实验并排 diff、动画录制导出、WASM 热点加速。

还差的两件（属于 Phase 2/3 范围，已在上面标 ⏳）：ALTER TABLE 的重写过程、列存与 LSM 块缓存。

每个 Phase 的准入条件不变：**新引擎必须实现 `StorageEngine` 接口、只通过事件对外表达状态、
并附带「引擎快照 == 事件重放」的一致性测试**。Phase 2 与 Phase 3 都是按这条路径加进来的，
可视化层一行「if 引擎名」都没有 —— 全部走 `capabilities`。
