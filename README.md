# DB Kernel Lab · 数据库内核可视化学习科研平台

> 在**纯浏览器**环境中实时观察、单步控制、对比实验数据库存储与执行内核的完整过程。
> 无后端、无网络请求，`pnpm build` 产物可直接扔到 GitHub Pages / Vercel / Cloudflare Pages。

当前实现：**Phase 0 全部 + Phase 1 验收清单全部达成**——
可配置阶数的聚簇 B+ 树（插入 / 点查 / 范围扫描 / 删除 / 借位 / 合并）、**二级索引与回表**、
**代价优化器与物理执行计划**、页结构与槽位目录、Buffer Pool（LRU / CLOCK）、
事件溯源的时间旅行、Web Worker 仿真、IndexedDB 会话恢复、3D 场景与视频剪辑器式时间轴。

---

## 快速开始

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # 产出 apps/web/dist（纯静态）
pnpm preview      # 本地预览构建产物

pnpm test         # 单元测试（Vitest，68 项）
pnpm test:e2e     # 端到端 / 关键路径测试（Playwright，10 项）
pnpm typecheck    # 全仓库类型检查
```

> 无头环境跑 e2e 时若系统已装 Chromium，可用 `DBKL_CHROMIUM=/path/to/chrome pnpm test:e2e`
> 复用它，避免 Playwright 再下载一份浏览器。

## 五分钟上手

1. 左侧「引导实验」里点 **① 页分裂与树的生长** —— 自动搭好 order=4 的树并插入 12 行，然后自动回放。
2. 用底部时间轴 **单步**（← →）观察：`定位 → 插入记录 → 页满 → 分裂 → 上浮分隔键 → 根页升高`。
3. 点 **下一次分裂** 直接跳到下一处结构变更；按 **M** 打点，Shift+拖动轨道设置循环区间反复观看。
4. 在 3D 场景里点任意页 → 右侧「页检查器」展开页头、槽位目录与行记录；按 **F** 飞入。
5. 再跑 **⑧ 二级索引与回表**：场景里会并排出现第二棵树，查询时一条粉色弧线从二级索引飞回聚簇索引 ——
   那就是回表。右侧「执行计划」面板同时给出算子树、估算 vs 实际行数与候选方案代价。
6. 换成 **⑨ 覆盖索引** 对比：查询列全在索引里时 `RowIdLookup` 消失、逻辑读骤降。
7. 换个参数（阶数 / 填充因子 / Buffer Pool 帧数 / 淘汰策略）→「应用并重置」→ 跑同一组操作，对比指标。

## 快捷键

| 键 | 作用 | 键 | 作用 |
|---|---|---|---|
| `空格` | 播放 / 暂停 | `← →` | 单步后退 / 前进 |
| `Shift+← →` | 上 / 下一条命令 | `Alt+← →` | 一次 10 步 |
| `Home` / `End` | 回到开头 / 跳到结尾 | `1–7` | 0.1× ~ 8× 速度 |
| `F` | 飞入选中页 | `G` | 适应视图 |
| `M` | 打点 | `B` / `L` | 缓冲池 / 文字标签 |
| `Esc` | 取消选中 | | |

## 仓库结构

```
db-kernel-lab/
├── apps/web/                       # Vite + React 19 + R3F 应用（纯客户端）
│   └── src/
│       ├── components/scene/       # 3D：B+ 树、连线、页标签、缓冲池、相机
│       ├── components/panels/      # 操作、查询、索引、表结构、参数、执行计划、页检查器、指标、事件日志、引导实验
│       ├── components/timeline/    # 时间轴
│       ├── state/store.ts          # zustand：游标、播放、命令日志
│       ├── workers/                # 仿真 Worker 入口
│       └── lib/                    # Worker 客户端、IndexedDB、Canvas 文字贴图
├── packages/
│   ├── shared/                     # 基础类型、确定性 RNG、工具函数
│   ├── simulation-core/            # ★ 事件协议 + B+ 树引擎（多索引）+ Buffer Pool + 优化器 + reducer + 历史管理
│   └── visualization/              # 布局算法、配色、高亮衰减（纯 TS，无 React 依赖）
├── e2e/                            # Playwright 关键路径测试
└── docs/                           # 架构 / 事件协议 / Phase 验收清单
```

## 设计要点

* **多棵 B+ 树共存**：聚簇索引 + 若干二级索引，二级索引叶子项是 `(索引列, 主键)`，
  因此非覆盖查询必须回表；每次 DML 都要维护所有索引，写放大在指标里直接可见。
* **优化器是可解释的**：统计信息 → 候选方案代价 → 物理计划全部作为事件落盘，
  面板里能同时看到「估算行数 vs 实际行数」和「为什么没走索引」。
* **事件驱动一切**：引擎只产生 `SimulationEvent`，UI 只消费事件归约出的 `LabState`。
  测试 `replay.test.ts` 断言「重放事件流 == 引擎内部状态」，从实现层面禁止 UI 猜状态。
* **时间旅行是一等公民**：完整事件流 + 稀疏检查点，跳到任意时刻 = 最近检查点克隆 + 少量重放；
  检查点数量有上限，超出后间隔翻倍抽稀，长实验不会撑爆内存。
* **确定性仿真**：种子化 RNG + 纯函数 reducer ⇒ 同一命令日志两次执行产生逐字节相同的事件流。
  因此 IndexedDB 只存**命令日志**（比事件流小两个数量级），刷新后重放即可完美恢复。
* **主线程不做重活**：引擎跑在 Web Worker 里，事件按 chunk 回传，主线程只渲染。
* **3D 性能**：页盒子与槽位各用一个 `InstancedMesh`（两个 draw call），连线合并进单个
  `lineSegments`，文字用 Canvas 贴图 + LRU 缓存（不依赖任何 CDN 字体，完全离线可用）。

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/event-protocol.md](docs/event-protocol.md)。

## 与真实数据库的差异

仿真的目标是**语义正确**而非字节级兼容。所有已知简化点都集中记录在
[docs/architecture.md#简化点与真实系统的差异](docs/architecture.md#简化点与真实系统的差异)，
包括：页容量由 order 而非字节决定、无 pin 计数、无 MVCC/Undo/Redo、单线程无并发控制等。

## 路线图

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 脚手架 / 3D 场景 / 时间轴 / Worker / B+ 树插入分裂回放 | ✅ 已完成 |
| 1 | B+ 树 CRUD、页结构、Buffer Pool、二级索引与回表、执行计划、IndexedDB 恢复 | ✅ 验收项全部达成；⏳ 剩 3D 页内微观视图与算子间粒子动画 |
| 2 | PostgreSQL 堆表对比、MVCC 版本链、ALTER TABLE | ⏳ 计划中 |
| 3 | LSM-Tree（MemTable/SST/Compaction）、列存 | ⏳ 计划中 |
| 4 | Redo/WAL、崩溃恢复、锁与死锁、隔离级别 | ⏳ 计划中 |
| 5 | Region / Raft / 分布式事务 | ⏳ 计划中 |
| 6 | 插件系统、对比报告、录制导出 | ⏳ 计划中 |

逐项验收清单见 [docs/phase-checklists.md](docs/phase-checklists.md)。

## 部署与 SEO

* `apps/web/index.html` 内置完整 SEO 头（description / keywords / OpenGraph / Twitter Card /
  canonical / JSON-LD `SoftwareApplication`），`apps/web/public/` 下有 `robots.txt` 与 `sitemap.xml`。
* 首屏是一个**静态启动画面**：在 JS 与 WebGL 就绪前就渲染出标题、简介与能力标签，
  既是加载态（会显示「重放命令 x/y」进度），也是 SPA 的爬虫兜底正文，React 挂载后淡出移除。
* `.github/workflows/deploy.yml` 会在 push 到 `main` 时跑 typecheck + 单测 + 构建并发布到
  GitHub Pages（首次需在仓库 Settings → Pages → Source 选 “GitHub Actions”）。
* 换域名时记得同步 `index.html` 的 `canonical` / `og:url`、`robots.txt` 与 `sitemap.xml` 里的三处 URL。

## 许可

尚未指定（内部实验项目）。
