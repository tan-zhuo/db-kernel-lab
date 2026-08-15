# 事件协议

事件是本平台唯一的真相来源。定义位于 `packages/simulation-core/src/events.ts`，
归约逻辑位于 `packages/simulation-core/src/state.ts`。

## 0. 四条铁律

1. 引擎的**任何**状态变化都必须产生事件；
2. 可视化层只能消费 `applyEvent` 归约出的 `LabState`，不得直接访问引擎；
3. 事件必须是纯数据（`structuredClone` / `JSON` 安全），不得携带函数或类实例；
4. `projectStructure(replay(events)) === engine.snapshot()` 必须恒成立（有测试守护）。

## 1. 公共字段

```ts
interface EventMeta {
  seq: number;  // 全局序号，等于它在历史数组中的下标
  t: number;    // 逻辑时间戳（仿真时钟，毫秒），严格递增
  cmd: number;  // 所属命令 id，用于时间轴分组与区间循环
}
type SimulationEvent = EventMeta & SimulationEventBody;
```

`t` 由 `EVENT_DURATION[type]` 累加而来，不是墙钟时间；它决定播放时每个事件停留多久。

## 2. 事件目录

### 命令边界

| 事件 | 语义 |
|---|---|
| `COMMAND_BEGIN` | 一条用户命令开始。归约时清空路径高亮、上次查询结果与扫描输出 |
| `COMMAND_END` | 命令结束，带 `ok` 与人类可读的 `note` |
| `NOTE` | 说明 / 警告 / 错误文本，不改变结构 |

### 元数据

| 事件 | 语义 |
|---|---|
| `CONFIG_SET` | 引擎参数快照；帧数变化时会重置缓冲池视图 |
| `TABLE_CREATE` | 建表，携带完整 schema |
| `INDEX_CREATE` | 新建一棵索引树（`clustered: true` 即聚簇索引），随后必定跟一个 `PAGE_ALLOC` + `ROOT_CHANGE` |
| `INDEX_DROP` | 删除索引；它的页会先被逐个 `PAGE_FREE` |
| `INDEX_STATS` | 统计信息刷新（模拟 ANALYZE）。查询前为每个候选索引发一条，是优化器**看到的**数据，可能落后于实际 |

### 页生命周期

| 事件 | 语义 |
|---|---|
| `PAGE_ALLOC` | 新页，`indexId` 标明它属于哪棵索引树。`init` 可携带初始 keys/children（新建根页时用来带上左子指针） |
| `PAGE_FREE` | 回收页；归约时同步把它从缓冲池摘除 |
| `PARENT_SET` | 子页改挂父页（分裂/合并/借位时的重挂接） |
| `ROOT_CHANGE` | 某棵索引（`indexId`）的根页切换 + 新树高 |
| `LEAF_LINK` | 叶子双向链表指针更新 |

### 索引遍历

| 事件 | 语义 |
|---|---|
| `DESCEND` | 在内部页选中第 `slot` 个子指针下降。**看到根页的 DESCEND 即重置路径高亮** |
| `PAGE_READ` | 一次逻辑读（发生在缓冲池事件之后），计入 `logicalReads` |

### 记录与分隔键

| 事件 | 语义 |
|---|---|
| `RECORD_INSERT` / `RECORD_UPDATE` / `RECORD_DELETE` | 叶子页槽位级变更 |
| `SEPARATOR_INSERT` | 内部页第 `slot` 个分隔键 + 其**右**子指针（`children[slot+1]`）插入 |
| `SEPARATOR_DELETE` | 与上相反 |
| `SEPARATOR_UPDATE` | 借位后父页分隔键就地更新 |

### 结构调整

| 事件 | 语义 |
|---|---|
| `PAGE_SPLIT` | 携带 `moved`（被搬到新页的 keys/rows/children）与 `promotedKey`。叶子分裂时 `promotedKey` = 右页首键且**仍留在右页**；内部分裂时它被移除、上浮到父页 |
| `PAGE_MERGE` | `victimPageId` 并入 `pageId`；内部页合并时 `separatorKey` 下沉到合并结果中间 |
| `REDISTRIBUTE` | 兄弟页借位。`direction` 指明搬运方向，`newSeparatorKey` 覆盖父页 `parentSlot` 处的分隔键 |

> 这三个事件都是**批量**语义：一个事件就完成整段搬迁，reducer 无需模拟中间态。
> 动画层可以按 `moved.keys` 的下标做逐条飞行动画。

### 缓冲池

| 事件 | 语义 |
|---|---|
| `BUFFER_HIT` / `BUFFER_MISS` | 命中 / 未命中并装入 `frame` |
| `BUFFER_EVICT` | 淘汰，含策略与是否脏页 |
| `PAGE_MARK_DIRTY` / `PAGE_FLUSH` | 变脏 / 刷盘（淘汰前的刷盘先于 `BUFFER_EVICT` 发出） |

### 查询过程

| 事件 | 语义 |
|---|---|
| `SEARCH_BEGIN` / `SEARCH_RESULT` | 点查 / 扫描起止，结果含命中页与槽位 |
| `SCAN_STEP` | 扫描到一条记录；`emitted=false` 表示被范围条件过滤掉 |
| `SCAN_END` | 返回行数与触达页数 |

### 回表

| 事件 | 语义 |
|---|---|
| `LOOKUP_BACK` | 二级索引叶子项 (`indexKey`, `primaryKey`) 发起回表，携带来源页与槽位。**先于**聚簇索引的 `DESCEND` 序列 |
| `LOOKUP_DONE` | 回表结束，`toPageId`/`slot` 是聚簇索引里命中的位置。reducer 用这两条事件拼出 3D 中的跨树连线 |

### 执行计划

| 事件 | 语义 |
|---|---|
| `PLAN_READY` | 优化器产出的物理计划（算子树 + 候选方案与代价）。整棵计划作为纯数据放在事件里，所以时间旅行回到这一刻就能重现当时的计划 |
| `OPERATOR_OPEN` | 算子开始执行 |
| `OPERATOR_ROW` | 算子产出一行；`emitted=false` 表示这行被该算子过滤掉了 |
| `OPERATOR_CLOSE` | 算子结束，带实际行数（与计划里的 `estRows` 对比即「估算 vs 实际」） |

算子名分两套：InnoDB 世界是 `TableScan / IndexSeek / IndexRangeScan / RowIdLookup`，
堆表世界是 `SeqScan / IndexScan / IndexOnlyScan / HeapFetch`（PostgreSQL 的叫法）。

### 事务与 MVCC（PostgreSQL 堆表引擎）

| 事件 | 语义 |
|---|---|
| `TXN_BEGIN` | 事务开始。`implicit=true` 表示这是「一条语句自成一个事务」的自动提交 |
| `TXN_COMMIT` / `TXN_ABORT` | 提交 / 回滚，带该事务写过多少个版本 |
| `SNAPSHOT_TAKE` | 取快照 `[xmin, xmax)` + 活跃事务列表。`scope='statement'` 是 READ COMMITTED 每条语句取一次；`scope='transaction'` 是 REPEATABLE READ 只在开始时取一次 —— **这条事件是隔离级别差异的唯一物理证据** |

### 堆表

| 事件 | 语义 |
|---|---|
| `PAGE_ALLOC` (`pageType='heap'`) | 新的堆页，携带 `blockNo` 与行指针容量 `slots` |
| `HEAP_INSERT` | 在第 `slot` 个行指针写入一个新版本（`xmin` = 写它的事务），带该页剩余空槽数 |
| `HEAP_SET_XMAX` | 给旧版本打上 `xmax`；`nextTid` 即 t_ctid，指向新版本。`hot=true` 表示新版本没有独立索引项 |
| `LINE_POINTER` | 行指针状态变化：`normal` / `redirect`（HOT 链头被剪枝）/ `dead` / `unused`。**非 normal 的指针不再指向元组内容**，reducer 会把 row 与 next 清空 |
| `HEAP_FETCH` | 索引项 → 堆元组的一跳，带沿 HOT 链走了几步。PostgreSQL 里**任何**索引扫描都会有它 |
| `VISIBILITY_CHECK` | 一次可见性判定，带 `xmin` / `xmax` / 结论 / 中文理由 |
| `HEAP_PRUNE` | VACUUM 清理一个堆页：移除的槽位、改成 redirect 的槽位、剩余空槽 |
| `VISIBILITY_MAP` | 可见性映射位。VACUUM 置位为 all-visible，任何写入清位 —— Index Only Scan 能否省掉回堆全看它 |
| `VACUUM_BEGIN` / `VACUUM_END` | VACUUM 起止，带清理的死元组数、索引项数、回收页数 |
| `BLOAT_STAT` | 权威的活/死元组与堆页统计。堆表没有聚簇索引，`LabState.recordCount` 由它给出，因此**每条命令结束前都会发一条** |

### LSM-Tree

| 事件 | 语义 |
|---|---|
| `WAL_APPEND` | 写入先落 WAL，带所属段 id。**必定排在同一次写入的 `MEMTABLE_PUT` 之前** |
| `WAL_SEAL` | MemTable 冻结时把当前段封口并绑定它，新写入转入 `nextSegmentId` |
| `WAL_TRUNCATE` | 段被回收。`reason='flushed'` 是「那份数据已落成 SST」，`reason='recovered'` 是恢复后丢弃旧日志。**这是 WAL 不会无限增长的唯一原因** |
| `CRASH` | 模拟崩溃：内存里的 MemTable / 冻结队列 / 后台任务全丢，SST 与 WAL 幸存 |
| `WAL_REPLAY` | 重放一个日志段（带 lsn 区间） |
| `RECOVER_END` | 恢复完成，带重放条数、还原键数、以及立刻落成的那个 SST |
| `MEMTABLE_PUT` | 写进 MemTable。`tombstone=true` 是删除，`overwrite=true` 是覆盖同键 |
| `MEMTABLE_FREEZE` | MemTable 满了，整块冻结成不可变表。**携带全部条目**——后台积压时它可能排很久才落盘，这段时间里这些数据依然读得到，只带条数会让它们从可视化里消失 |
| `BG_JOB_SCHEDULED` | 后台任务入队（刷写 / 压实），带入队后的积压深度 = 压实债务 |
| `BG_JOB_RUN` | 后台任务执行，带排队等了多少个事件；`forced=true` 表示是被写停顿逼着在写路径上同步跑的 |
| `WRITE_STALL` | 写停顿：`immutable-full`（冻结队列满）或 `l0-stop`（L0 文件过多） |
| `SST_CREATE` | 生成一个 SST 文件，携带**全部条目**（键 + 行 + 是否墓碑）、层号、键区间、来源（`flush` / `compaction`） |
| `SST_DROP` | 文件被压实吃掉或过期 |
| `COMPACTION_BEGIN` / `COMPACTION_END` | 压实起止：输入/输出文件、进出条目数、丢弃了多少旧版本与墓碑 |
| `BLOOM_PROBE` | 布隆过滤器探测。`maybe=false` ⇒ 整个文件跳过；`falsePositive=true` 是真实发生的假阳性 |
| `SST_PROBE` | 真的打开一个文件读了一次（读放大 +1） |
| `LSM_GET_RESULT` | 点查结果：命中在哪一层哪个文件、读了几个 SST、被布隆挡掉几个 |

> LSM 的扫描结果不属于任何一个页（记录横跨 MemTable 与多个 SST），
> 因此 `SCAN_STEP` 用哨兵页号 `0`（`LSM_VIRTUAL_PAGE`），reducer 只把它记进 `scanOutput`，不点亮任何页。

## 3. 顺序约定（reducer 依赖）

* `PAGE_ALLOC` 必须先于任何引用该页的事件；
* 分裂序列：`PAGE_ALLOC(new)` → `PAGE_SPLIT` → `LEAF_LINK`… → `SEPARATOR_INSERT`/`ROOT_CHANGE` → `PARENT_SET`；
* 合并序列：`PAGE_MERGE` → `LEAF_LINK`/`PARENT_SET` → `SEPARATOR_DELETE` → `PAGE_FREE`；
* 缓冲池序列：`PAGE_FLUSH?` → `BUFFER_EVICT` → `BUFFER_MISS` → `PAGE_READ`；
* 查询序列：`INDEX_STATS*` → `PLAN_READY` → `OPERATOR_OPEN*` → （扫描/回表事件与 `OPERATOR_ROW` 交织）→ `OPERATOR_CLOSE*`；
* 回表序列：`LOOKUP_BACK` → 聚簇索引的 `PAGE_READ`/`DESCEND` → `LOOKUP_DONE`；
* 事务序列：`TXN_BEGIN` → (`SNAPSHOT_TAKE`)* → …DML/查询事件… → `TXN_COMMIT` / `TXN_ABORT`；
* 更新序列（堆表）：`HEAP_INSERT`(新版本) → `HEAP_SET_XMAX`(旧版本) → 非 HOT 时才有索引的 `RECORD_INSERT`；
* 回堆序列：索引的 `DESCEND`/`SCAN_STEP` → `PAGE_READ`(堆页) → `VISIBILITY_CHECK`* → `HEAP_FETCH`；
* VACUUM 序列：`VACUUM_BEGIN` → (`LINE_POINTER` | `HEAP_PRUNE` | `RECORD_DELETE`)* → `VISIBILITY_MAP`* → `VACUUM_END`；
* LSM 写序列：`WAL_APPEND` → `MEMTABLE_PUT` →（满了才有）`MEMTABLE_FREEZE` → `WAL_SEAL` → `BG_JOB_SCHEDULED`；
  真正的刷盘发生在后来的 `BG_JOB_RUN` → `SST_CREATE` → `WAL_TRUNCATE`；
* LSM 停顿序列：`WRITE_STALL` → `BG_JOB_RUN(forced=true)` → `SST_CREATE` / `COMPACTION_*`；
* LSM 崩溃序列：`CRASH` → `WAL_REPLAY`* → `MEMTABLE_PUT`* → `MEMTABLE_FREEZE` → `SST_CREATE` → `WAL_TRUNCATE(recovered)`* → `RECOVER_END`；
* LSM 压实序列：`COMPACTION_BEGIN` → `SST_DROP`* → `SST_CREATE`* → `COMPACTION_END`；
* LSM 读序列：`SEARCH_BEGIN` → (`BLOOM_PROBE`? → `SST_PROBE`?)* → `LSM_GET_RESULT` → `SEARCH_RESULT`。

## 4. 新增事件的步骤

在 `SimulationEventBody` 里加一个成员后，TypeScript 会在四处报错，逐个补齐即可：

1. `EVENT_CATEGORY` —— 决定日志颜色与过滤分组；
2. `EVENT_DURATION` —— 决定播放时它占多长逻辑时间；
3. `describeEvent` —— 事件日志里的中文一行描述；
4. `applyEvent` —— 归约逻辑（不写就编译不过，这是刻意的）。

可选：`packages/visualization/src/highlights.ts` 的 `highlightsForEvent` 决定它点亮谁。

最后补一条测试：混合负载跑完后 `projectStructure(replay(events))` 必须等于 `engine.snapshot()`。

## 5. 导出格式

顶栏「导出 · 事件」产出：

```jsonc
{
  "version": 2,
  "engineId": "postgres-heap",
  "engine": "PostgreSQL-like Heap + MVCC",
  "config": { "order": 4, "pageSize": 16384, "bufferPoolFrames": 8, "...": "..." },
  "commands": [ /* 命令日志，可用于确定性重放 */ ],
  "events":   [ /* 完整事件流 */ ]
}
```

该文件足以在任何一台机器上还原整场实验（未来的「导入轨迹回放」功能直接吃这个格式）。
