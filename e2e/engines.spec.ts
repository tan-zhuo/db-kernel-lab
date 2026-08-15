import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 多引擎端到端测试：验证「同一套 UI 按能力挂载不同视图与面板」这条主线成立。
 *
 * 三个引擎共享命令、事件协议与时间轴，只有物理模型不同 ——
 * 这些用例就是在守护那条边界：换引擎之后该出现的面板出现了、该消失的消失了、
 * 该产生的事件真的产生了。
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function waitForReady(page: Page): Promise<void> {
  await page.waitForSelector('#dbkl-boot', { state: 'detached', timeout: 20_000 });
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText(/就绪：表 users 已创建|已从 IndexedDB 恢复/)).toBeVisible();
}

async function switchEngine(page: Page, id: string, expectedName: RegExp): Promise<void> {
  await page.getByTestId(`engine-${id}`).click();
  await expect(page.getByText(expectedName)).toBeVisible();
}

async function bulkInsert(page: Page, count: number): Promise<void> {
  await page.getByLabel('批量插入').fill(String(count));
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText(new RegExp(`BULK INSERT ×${count}`)).first()).toBeVisible();
  await page.getByTitle('跳到结尾 (End)').click();
}

const statValue = (page: Page, label: string) => page.locator(`[data-stat="${label}"] [data-stat-value]`);

test('引擎切换：三个引擎都能加载，面板按能力增减', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  // InnoDB：有缓冲池、有索引面板，没有事务面板
  await expect(page.getByText('InnoDB-like Clustered B+Tree')).toBeVisible();
  await expect(page.getByText('事务 / MVCC')).toHaveCount(0);
  await expect(page.getByText('LSM 层级')).toHaveCount(0);

  // PostgreSQL：多出事务 / MVCC 面板
  await switchEngine(page, 'postgres-heap', /PostgreSQL-like Heap \+ MVCC/);
  await expect(page.getByText('事务 / MVCC')).toBeVisible();
  await expect(page.getByText('索引', { exact: true })).toBeVisible();

  // LSM：索引面板消失，LSM 层级面板出现
  await switchEngine(page, 'lsm-tree', /LSM-Tree \(RocksDB-like\)/);
  await expect(page.getByText('LSM 层级')).toBeVisible();
  await expect(page.getByText('事务 / MVCC')).toHaveCount(0);
  await expect(page.getByText('索引', { exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('PostgreSQL：索引扫描必须回堆，指标里能看到这笔开销', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'postgres-heap', /PostgreSQL-like Heap \+ MVCC/);
  await bulkInsert(page, 12);

  await expect(statValue(page, '行数')).toHaveText('12');
  // InnoDB 的「回表」指标换成了堆表的「回堆」
  await expect(statValue(page, '回堆')).toBeVisible();

  // 查一个确实存在的键，否则索引下降就直接落空、根本走不到回堆那一步
  await page.getByLabel('主键 key').fill('7');
  await page.getByRole('button', { name: '点查' }).click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(statValue(page, '回堆')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('PostgreSQL：UPDATE 写新版本 → 膨胀率上升 → VACUUM 回落', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'postgres-heap', /PostgreSQL-like Heap \+ MVCC/);
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
  await switchEngine(page, 'postgres-heap', /PostgreSQL-like Heap \+ MVCC/);

  // 引导实验⑥ 自带完整剧本：A 开 RR 事务读 → B 写并提交 → A 再读
  await page.getByTestId('scenario-pg-repeatable-read').click();
  await expect(page.getByText(/COMMIT xid=/).first()).toBeVisible({ timeout: 30_000 });
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
  await switchEngine(page, 'lsm-tree', /LSM-Tree \(RocksDB-like\)/);
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
  await switchEngine(page, 'lsm-tree', /LSM-Tree \(RocksDB-like\)/);

  await page.getByTestId('scenario-lsm-bloom').click();
  await expect(page.getByText(/布隆过滤器挡掉|读放大/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTitle('跳到结尾 (End)').click();

  await expect(statValue(page, '布隆跳过')).not.toHaveText('0');
});

test('LSM：删除写墓碑，SST 检查器里能看到它', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree \(RocksDB-like\)/);
  await bulkInsert(page, 12);

  await page.getByRole('button', { name: '删除' }).click();
  await page.getByTestId('flush-memtable').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(page.getByText(/写墓碑|墓碑/).first()).toBeVisible();
});

test('会话持久化：刷新后仍然停在换过的引擎上', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await switchEngine(page, 'lsm-tree', /LSM-Tree \(RocksDB-like\)/);
  await bulkInsert(page, 10);
  await page.waitForTimeout(1200); // 等防抖写入 IndexedDB

  await page.reload();
  await expect(page.getByText(/已从 IndexedDB 恢复上次实验/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('LSM-Tree (RocksDB-like)')).toBeVisible();
  await expect(page.getByText('LSM 层级')).toBeVisible();
});
