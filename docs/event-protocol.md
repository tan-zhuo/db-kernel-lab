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

## 3. 顺序约定（reducer 依赖）

* `PAGE_ALLOC` 必须先于任何引用该页的事件；
* 分裂序列：`PAGE_ALLOC(new)` → `PAGE_SPLIT` → `LEAF_LINK`… → `SEPARATOR_INSERT`/`ROOT_CHANGE` → `PARENT_SET`；
* 合并序列：`PAGE_MERGE` → `LEAF_LINK`/`PARENT_SET` → `SEPARATOR_DELETE` → `PAGE_FREE`；
* 缓冲池序列：`PAGE_FLUSH?` → `BUFFER_EVICT` → `BUFFER_MISS` → `PAGE_READ`；
* 查询序列：`INDEX_STATS*` → `PLAN_READY` → `OPERATOR_OPEN*` → （扫描/回表事件与 `OPERATOR_ROW` 交织）→ `OPERATOR_CLOSE*`；
* 回表序列：`LOOKUP_BACK` → 聚簇索引的 `PAGE_READ`/`DESCEND` → `LOOKUP_DONE`。

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
  "version": 1,
  "engine": "InnoDB-like Clustered B+Tree",
  "config": { "order": 4, "pageSize": 16384, "bufferPoolFrames": 8, "...": "..." },
  "commands": [ /* 命令日志，可用于确定性重放 */ ],
  "events":   [ /* 完整事件流 */ ]
}
```

该文件足以在任何一台机器上还原整场实验（未来的「导入轨迹回放」功能直接吃这个格式）。
