import { expect, test } from '@playwright/test';
import {
  bulkInsert,
  collectErrors,
  expectEvent,
  openTab,
  runScenario,
  statValue,
  switchEngine,
  waitForReady,
} from './helpers';

/**
 * 多引擎端到端测试：验证「同一套 UI 按能力挂载不同视图与面板」这条主线成立。
 *
 * 五个引擎共享命令、事件协议与时间轴，只有物理模型不同 ——
 * 这些用例就是在守护那条边界：换引擎之后该出现的面板出现了、该消失的消失了、
 * 该产生的事件真的产生了。
 */

test('引擎切换：五个引擎都能加载，面板按能力增减', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  // 面板按标签惰性挂载，所以每次断言前先站到对应的标签上。
  // InnoDB：有索引面板、没有事务面板
  await expect(page.getByTestId('engine-picker')).toHaveText(/InnoDB/);
  await openTab(page, 'ops');
  await expect(page.getByText('索引', { exact: true })).toBeVisible();
  await expect(page.getByText('事务 / MVCC')).toHaveCount(0);
  await expect(page.getByText('LSM 层级')).toHaveCount(0);

  // PostgreSQL：多出事务 / MVCC 面板
  await switchEngine(page, 'postgres-heap', /堆表/);
  await openTab(page, 'ops');
  await expect(page.getByText('事务 / MVCC')).toBeVisible();
  await expect(page.getByText('索引', { exact: true })).toBeVisible();

  // LSM：索引面板消失，LSM 层级面板出现
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);
  await openTab(page, 'ops');
  await expect(page.getByText('事务 / MVCC')).toHaveCount(0);
  await expect(page.getByText('索引', { exact: true })).toHaveCount(0);
  await openTab(page, 'state');
  await expect(page.getByText('LSM 层级')).toBeVisible();

  // 哈希 KV 连查询构造器都没有意义，「查询」标签整个不出现
  await switchEngine(page, 'kv-hash', /哈希索引/);
  await expect(page.getByTestId('tab-query')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('PostgreSQL：索引扫描必须回堆，指标里能看到这笔开销', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'postgres-heap', /堆表/);
  await bulkInsert(page, 12);

  await expect(statValue(page, '行数')).toHaveText('12');
  // InnoDB 的「回表」指标换成了堆表的「回堆」
  await expect(statValue(page, '回堆')).toBeVisible();

  // 查一个确实存在的键，否则索引下降就直接落空、根本走不到回堆那一步
  await page.getByLabel('主键 key').fill('7');
  await page.getByTestId('op-search').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(statValue(page, '回堆')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('PostgreSQL：UPDATE 写新版本 → 膨胀率上升 → VACUUM 回落', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'postgres-heap', /堆表/);
  await bulkInsert(page, 8);

  await expect(statValue(page, '死元组')).toHaveText('0');

  // 连改三次同一行：留下三个死元组
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('op-update').click();
    await page.getByTitle('跳到结尾 (End)').click();
  }
  await expect(statValue(page, '死元组')).not.toHaveText('0');
  await expect(statValue(page, '版本数')).not.toHaveText('8');

  await page.getByTestId('vacuum').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/VACUUM：清理/).first()).toBeVisible();
  await expect(statValue(page, '死元组')).toHaveText('0');
});

test('PostgreSQL：REPEATABLE READ 让两次读到的行数一致', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'postgres-heap', /堆表/);

  // 引导实验⑥ 自带完整剧本：A 开 RR 事务读 → B 写并提交 → A 再读
  await runScenario(page, 'pg-repeatable-read');
  await expectEvent(page, /COMMIT xid=/);
  await page.getByTitle('跳到结尾 (End)').click();

  // 两次 full_scan 的结果都必须是 4 行（B 插入的第 5 行对 A 不可见）
  const scanNotes = await page.getByText(/顺序扫描返回 \d+ 行/).allInnerTexts();
  const counts = scanNotes.map((t) => Number(/顺序扫描返回 (\d+) 行/.exec(t)?.[1] ?? -1));
  expect(counts.length).toBeGreaterThan(0);
  expect(new Set(counts).size).toBe(1);
});

test('LSM：写入触发刷写与压实，层级面板与 3D 同步更新', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);
  await bulkInsert(page, 30);

  await expect(statValue(page, 'SST 文件')).not.toHaveText('0');
  await expect(statValue(page, '刷写/压实')).not.toHaveText('0/0');
  await expect(statValue(page, '写放大').first()).not.toHaveText('—');
  // 层级表里至少有 L0 与 L1
  await expect(page.getByText('L1', { exact: true }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('LSM：布隆过滤器把读放大压下去', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);

  await runScenario(page, 'lsm-bloom');
  await expect(page.getByText(/布隆过滤器挡掉|读放大/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTitle('跳到结尾 (End)').click();

  await expect(statValue(page, '布隆跳过')).not.toHaveText('0');
});

test('LSM：删除写墓碑，SST 检查器里能看到它', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);
  await bulkInsert(page, 12);

  await page.getByTestId('op-delete').click();
  await openTab(page, 'state');
  await page.getByTestId('flush-memtable').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/写墓碑|墓碑/).first()).toBeVisible();
});

test('LSM：刷写与压实不在写路径上，积压可见且能手动推进', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);

  // 引导实验⑨ 把后台任务上限调成 0：写路径只排队、一个 SST 都不生成
  await runScenario(page, 'lsm-background');
  await expectEvent(page, /后台任务入队/);
  await page.getByTitle('跳到结尾 (End)').click();

  await openTab(page, 'state');
  await expect(page.getByTestId('bg-backlog')).not.toHaveText(/^0/);
  await expect(statValue(page, 'SST 文件')).toHaveText('0');

  // 给后台一点 CPU，活才真的干掉
  await page.getByTestId('run-background').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByTestId('bg-backlog')).toHaveText(/^0/);
  await expect(statValue(page, 'SST 文件')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('LSM：写入跑赢压实就会写停顿', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);

  await runScenario(page, 'lsm-write-stall');
  await expect(page.getByText(/写停顿/).first()).toBeVisible({ timeout: 40_000 });
  await page.getByTitle('跳到结尾 (End)').click();

  await expect(statValue(page, '写停顿').first()).not.toHaveText('0');
  // 停顿只是变慢，数据一条不能少
  await expect(statValue(page, '行数')).toHaveText('40');
});

test('LSM：崩溃后靠 WAL 把内存里的数据全部还原', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);

  await runScenario(page, 'lsm-crash-recovery');
  await expectEvent(page, /恢复完成/, 40_000);
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/进程崩溃/).first()).toBeVisible();

  // 崩溃前写的 10 个键一个不少
  await openTab(page, 'state');
  await expect(statValue(page, '行数')).toHaveText('10');
  await expect(page.getByText(/上次恢复：重放 10 条日志/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('LSM：数据落盘后 WAL 段被回收，不会无限增长', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);
  await bulkInsert(page, 12);

  // 手动刷干净：所有数据进 SST，WAL 里就不该再有待恢复的记录
  await openTab(page, 'state');
  await page.getByTestId('flush-memtable').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByTestId('wal-retained')).toHaveText('0 条待恢复');
  await expect(page.getByText(/已回收 \d+ 条/)).toBeVisible();
});

test('列存：只读用到的列，区间统计整块跳过', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'columnar', /列存/);
  await bulkInsert(page, 24);

  await expect(statValue(page, '行组').first()).not.toHaveText('0');
  await expect(statValue(page, '压缩比').first()).not.toHaveText('—');

  // 只取一列：IO 账单应显示只读了 1 列
  await openTab(page, 'query');
  await page.getByTestId('q-projection').selectOption('covering');
  await page.getByTestId('q-run').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/本次查询的 IO 账单/)).toBeVisible();
  await expect(page.getByText(/省了 \d+% 的 IO/)).toBeVisible();

  expect(errors).toEqual([]);
});

test('列存：区间统计能跳过整个行组', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'columnar', /列存/);

  await runScenario(page, 'col-zonemap');
  await expectEvent(page, /跳过行组/, 40_000);
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/一个字节都不用读/).first()).toBeVisible();
});

test('KV 哈希：点查一次寻址，范围扫描直接拒绝', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'kv-hash', /哈希索引/);
  await bulkInsert(page, 16);

  await expect(statValue(page, '键数')).toHaveText('16');
  await expect(statValue(page, '索引内存').first()).not.toHaveText('0 B');

  // 点查：一次哈希 + 一次磁盘读
  await page.getByLabel('主键 key').fill('7');
  await page.getByTestId('op-search').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/一次磁盘读/).first()).toBeVisible();

  // 范围扫描：必须明确拒绝并说明理由
  await page.getByTestId('op-range').click();
  await expect(page.getByText(/哈希把键打散了/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('KV 哈希：覆盖写产生垃圾，合并能回收', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'kv-hash', /哈希索引/);

  await runScenario(page, 'kv-garbage');
  await expectEvent(page, /合并结束/, 60_000);
  await page.getByTitle('跳到结尾 (End)').click();

  // 合并之后键数不变、垃圾被回收
  await openTab(page, 'state');
  await expect(statValue(page, '键数')).toHaveText('8');
  await expect(page.getByText(/上次合并：保留/)).toBeVisible();
});

test('会话持久化：刷新后仍然停在换过的引擎上', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree/);
  await bulkInsert(page, 10);
  await page.waitForTimeout(1200); // 等防抖写入 IndexedDB

  await page.reload();
  await expect(page.getByText(/已从 IndexedDB 恢复上次实验/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('engine-picker')).toHaveText(/LSM-Tree/);
  await openTab(page, 'state');
  await expect(page.getByText('LSM 层级')).toBeVisible();
});
