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
| 1.1 | 可创建指定列的表并选择主键 | 🟡 | 引擎支持任意 schema（`create_table` 命令）；UI 目前固定使用内置 `users` 表，建表表单待补 |
| 1.2 | 连续插入触发页分裂，3D 动画流畅且可回放 | ✅ | `btree.test.ts` 覆盖 order 3/4/5/8；动画走位置插值 |
| 1.3 | 二级索引 + 回表路径可视化 | ⏳ | 仅聚簇索引；二级索引是 Phase 1 剩余的主要工作 |
| 1.4 | Buffer Pool 命中 / 淘汰可视化 | ✅ | 3D 货架视图 + 命中率、淘汰、刷盘指标；LRU 与 CLOCK 双策略 |
| 1.5 | 时间轴支持单步、快进、回退到任意历史点 | ✅ | 0.1×–8× 速度、打点、区间循环、跳到下一次分裂/淘汰 |
| 1.6 | 所有关键状态变化都有对应 SimulationEvent | ✅ | 30 种事件；`replay.test.ts` 断言重放 == 引擎快照 |
| 1.7 | 重操作在 Web Worker 中执行，主线程流畅 | ✅ | 单帧归约上限 400 事件；> 3000 事件的批次不自动播放 |
| 1.8 | 刷新页面后可从 IndexedDB 恢复实验会话 | ✅ | 持久化命令日志 + 确定性重放；e2e `会话持久化` |
| 1.9 | 核心插入与分裂逻辑有测试覆盖 | ✅ | 52 项单元测试（含随机负载与结构不变式校验） |
| 1.10 | 可静态部署，无需后端 | ✅ | `base: './'`，无网络请求（字体走 Canvas 贴图而非 CDN） |
| 1.11 | 简单执行计划（Index Scan / Seq Scan）与数据流动画 | ⏳ | 已有范围扫描/全扫描的事件与逐行动画，尚无算子树视图 |
| 1.12 | DDL：CREATE TABLE + 创建索引过程 | 🟡 | 建表有事件；创建索引待二级索引落地后补 |

**超出原 Phase 1 范围、已提前完成的部分**

* 删除路径的完整再平衡：兄弟页借位（`REDISTRIBUTE`）、页合并（`PAGE_MERGE`）、根页退化；
* 参数实验：填充因子、顺序插入右倾优化、淘汰策略、缓冲池帧数、随机种子；
* 7 个引导式实验场景（教程模式，原属 Phase 6）；
* 事件流 / 状态 JSON 导出与场景截图（原属 Phase 6）；
* Playwright 关键路径 e2e。

## Phase 1 剩余工作（下一步）

1. **二级索引**：`CREATE INDEX` 命令 + 独立 B+ 树 + `(索引键, 主键)` 叶子项；
   点查时先走二级索引再回表，用两棵树之间的连线表现回表跳转。
2. **执行计划视图**：`PhysicalPlan` 类型 + 算子树（Seq Scan / Index Scan / Index Lookup / Filter），
   算子之间用「记录粒子」表现数据流，实际行数 vs 估算行数对比。
3. **建表 UI**：列定义表单 + 主键选择，替换内置固定 schema。
4. **页内微观视图**：点击叶子页后切换相机，用 3D 网格展示槽位目录与行记录字节布局。

## Phase 2+ 规划要点

* **Phase 2**：PostgreSQL 堆表 + 索引分离、MVCC 版本链与可见性判断、ALTER TABLE 过程。
* **Phase 3**：LSM（MemTable → Immutable → SST → Compaction）、列存（列块 + 压缩 + 向量化）。
* **Phase 4**：Redo/WAL 日志流、崩溃恢复重放、锁与死锁检测、隔离级别对比实验。
* **Phase 5**：Region / Raft 日志复制 / Leader 选举 / 分布式事务。
* **Phase 6**：引擎插件动态加载、双实验并排 diff、动画录制导出、WASM 热点加速。

每个 Phase 的准入条件不变：**新引擎必须实现 `StorageEngine` 接口、只通过事件对外表达状态、
并附带「引擎快照 == 事件重放」的一致性测试**。
