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
  await expect(page.getByText('DB Kernel Lab')).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText(/就绪：表 users 已创建|已从 IndexedDB 恢复/)).toBeVisible();
}

async function bulkInsert(page: Page, count: number): Promise<void> {
  await page.getByLabel('批量插入').fill(String(count));
  await page.getByRole('button', { name: '执行' }).click();
  await expect(page.getByText(new RegExp(`BULK INSERT ×${count}`)).first()).toBeVisible();
}

const statValue = (page: Page, label: string) => page.locator(`[data-stat="${label}"] [data-stat-value]`);

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

  // 关掉缓冲池面板让树居中，再适应视图，然后沿中轴向下探针点击
  await page.getByTitle('显示/隐藏 Buffer Pool 视图 (B)').click();
  await page.getByTitle('跳到结尾 (End)').click();
  await page.getByTitle('适应视图 (G)').click();
  await page.waitForTimeout(1500);

  const canvas = (await page.locator('canvas').boundingBox())!;
  const inspectorTitle = page.locator('aside').last().locator('h2').first();
  let picked = false;
  for (let fy = 0.2; fy <= 0.72 && !picked; fy += 0.02) {
    await page.mouse.click(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * fy);
    picked = (await inspectorTitle.innerText()) !== '页检查器';
  }
  expect(picked, '应能在 3D 场景中点选到页').toBe(true);
  await expect(inspectorTitle).toHaveText(/^页 #\d+$/);
  await expect(page.getByText('slot', { exact: true })).toBeVisible();
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
