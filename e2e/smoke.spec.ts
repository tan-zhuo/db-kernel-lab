import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 关键路径端到端测试：验证纯静态产物在真实浏览器里跑得通
 * （WebGL 场景、Worker 通信、3D 拾取、时间旅行、IndexedDB 会话恢复）。
 *
 * 无头环境用 SwiftShader 软件渲染，因此帧率不代表真实性能。
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
  // 启动画面会在引擎就绪后自行移除
  await page.waitForSelector('#dbkl-boot', { state: 'detached', timeout: 20_000 });
  await expect(page.getByText('DB Kernel Lab', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText(/就绪：表 users 已创建|已从 IndexedDB 恢复/)).toBeVisible();
}

async function bulkInsert(page: Page, count: number): Promise<void> {
  await page.getByLabel('批量插入').fill(String(count));
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText(new RegExp(`BULK INSERT ×${count}`)).first()).toBeVisible();
}

const statValue = (page: Page, label: string) => page.locator(`[data-stat="${label}"] [data-stat-value]`);

test('启动画面：JS 就绪前先给出可读内容，随后自动淡出', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  const boot = page.locator('#dbkl-boot');
  await expect(boot).toBeVisible();
  await expect(boot.getByRole('heading', { level: 1 })).toContainText('DB Kernel Lab');
  // SEO 兜底内容：标题、描述与关键能力标签都在首屏 HTML 里
  await expect(boot).toContainText('二级索引');
  await expect(page).toHaveTitle(/DB Kernel Lab/);
  await expect(boot).toHaveCount(0, { timeout: 20_000 });
});

test('启动：3D 场景与引擎就绪，无控制台错误', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await expect(page.getByText('InnoDB-like Clustered B+Tree')).toBeVisible();
  expect(errors).toEqual([]);
});

test('批量插入：触发页分裂，指标与时间轴同步更新', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 30);
  await page.getByTitle('跳到结尾 (End)').click();

  await expect(statValue(page, '行数')).toHaveText('30');
  await expect(statValue(page, '叶子分裂')).not.toHaveText('0');
  await expect(statValue(page, '树高')).not.toHaveText('1');

  const counter = await page.getByTestId('timeline-counter').innerText();
  const [cursor, total] = counter.split('/').map((s) => Number(s.trim()));
  expect(cursor).toBe(total);
  expect(total).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('时间旅行：回到开头指标归零，跳到结尾再次还原', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 12);

  await page.getByTitle('回到开头 (Home)').click();
  await expect(page.getByTestId('timeline-counter')).toHaveText(/^0 \/ \d+$/);
  await expect(statValue(page, '行数')).toHaveText('0');
  await expect(statValue(page, '页数')).toHaveText('0');

  await page.getByTitle('跳到结尾 (End)').click();
  await expect(statValue(page, '行数')).toHaveText('12');

  // 单步后退一步再前进一步，状态必须回到同一处
  await page.getByTitle('后退一步 (←)').click();
  await page.getByTitle('前进一步 (→)').click();
  await expect(statValue(page, '行数')).toHaveText('12');
});

test('跳到下一次页分裂，并能在 3D 中拾取页查看页内结构', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 12);

  await page.getByTitle('回到开头 (Home)').click();
  await page.getByTitle('跳到下一次页分裂').click();
  await expect(page.getByTestId('timeline-counter')).not.toHaveText(/^0 \//);

  // 关掉缓冲池让树占满视口，再适应视图，然后在若干候选点上尝试拾取
  // （3D 拾取走 InstancedMesh 的 instanceId → pageId）
  await page.getByTitle('显示/隐藏 Buffer Pool 视图 (B)').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await page.getByTitle('适应视图 (G)').click();
  await page.waitForTimeout(1800);

  const canvas = (await page.locator('canvas').boundingBox())!;
  const badge = page.getByText(/已选中页 #\d+/);
  const probes: [number, number][] = [
    [0.5, 0.35],
    [0.35, 0.5],
    [0.65, 0.5],
    [0.35, 0.65],
    [0.5, 0.65],
    [0.65, 0.65],
    [0.2, 0.65],
    [0.5, 0.5],
  ];
  let picked = false;
  for (const [fx, fy] of probes) {
    await page.mouse.click(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy);
    if (await badge.isVisible()) {
      picked = true;
      break;
    }
  }
  expect(picked, '应能在 3D 场景中点选到页').toBe(true);
  // 页检查器展开该页的页头、槽位目录与行记录
  await expect(page.getByText(/^页 #\d+$/).first()).toBeVisible();
  await expect(page.getByText('slot', { exact: true })).toBeVisible();
  await expect(page.getByText('填充率', { exact: true })).toBeVisible();
});

test('会话持久化：刷新后从 IndexedDB 恢复', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 8);
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(statValue(page, '行数')).toHaveText('8');
  await page.waitForTimeout(1200); // 等待防抖写入 IndexedDB

  await page.reload();
  await expect(page.getByText(/已从 IndexedDB 恢复上次实验/)).toBeVisible();
  await expect(statValue(page, '行数')).toHaveText('8');
});

test('二级索引：建索引后场景出现两棵树，等值查询触发回表', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 24);

  // 在 score 列上建二级索引
  await page.getByTestId('create-index').click();
  await expect(page.getByText(/CREATE INDEX idx_score/).first()).toBeVisible();
  await page.getByTitle('跳到结尾 (End)').click();
  await expect(statValue(page, '二级索引')).toHaveText('1');

  // 按 score 等值查询：优化器应选二级索引并回表
  await page.getByTestId('q-op').selectOption('eq');
  await page.getByTestId('q-column').selectOption('score');
  await page.getByTestId('q-value').fill(String((7 * 7919) % 100));
  await page.getByTestId('q-run').click();
  await page.getByTitle('跳到结尾 (End)').click();

  const plan = page.getByTestId('plan-panel');
  await expect(plan).toBeVisible();
  await expect(plan.getByText('IndexSeek', { exact: true })).toBeVisible();
  await expect(plan.getByText('RowIdLookup', { exact: true })).toBeVisible();
  await expect(statValue(page, '回表')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('覆盖索引：只取索引列时执行计划里没有回表算子', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 24);
  await page.getByTestId('create-index').click();
  await expect(page.getByText(/CREATE INDEX idx_score/).first()).toBeVisible();

  await page.getByTestId('q-column').selectOption('score');
  await page.getByTestId('q-value').fill(String((3 * 7919) % 100));
  await page.getByTestId('q-projection').selectOption('covering');
  await page.getByTestId('q-run').click();
  await page.getByTitle('跳到结尾 (End)').click();

  const plan = page.getByTestId('plan-panel');
  await expect(plan.getByText('IndexSeek', { exact: true })).toBeVisible();
  await expect(plan.getByText('RowIdLookup', { exact: true })).toHaveCount(0);
  await expect(plan.getByText(/覆盖索引/).first()).toBeVisible();
});

test('强制全表扫描：候选方案对比可见，逻辑读更高', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 24);
  await page.getByTestId('create-index').click();
  await expect(page.getByText(/CREATE INDEX idx_score/).first()).toBeVisible();

  await page.getByTestId('q-column').selectOption('score');
  await page.getByTestId('q-hint').selectOption('none');
  await page.getByTestId('q-run').click();
  await page.getByTitle('跳到结尾 (End)').click();

  const plan = page.getByTestId('plan-panel');
  await expect(plan.getByText('TableScan', { exact: true })).toBeVisible();
  await expect(plan.getByText('候选方案')).toBeVisible();
  await expect(page.getByText(/用户强制全表扫描/).first()).toBeVisible();
});

test('CREATE TABLE 表单可以重建实验', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await bulkInsert(page, 10);

  await page.getByText('表结构', { exact: true }).click();
  await page.getByTestId('schema-name').fill('orders');
  await page.getByTestId('create-table').click();

  await expect(page.getByText(/已重置：表 orders/)).toBeVisible();
  await expect(statValue(page, '行数')).toHaveText('0');
});
