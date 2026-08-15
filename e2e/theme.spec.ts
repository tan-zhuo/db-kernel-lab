import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 主题系统的端到端守护。
 *
 * 主题要同时改三处：CSS 变量（面板）、3D 调色板（场景）、文字贴图缓存。
 * 少改任何一处都会出现「一半变了一半没变」的割裂，这些用例就是在盯这件事。
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
}

/** 面板底色 —— CSS 变量那一路是否生效。 */
const panelBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('aside')!).backgroundColor);

/** 3D 场景底色 —— 调色板那一路是否生效（取画布左下角一个像素）。 */
async function canvasCorner(page: Page): Promise<string> {
  const box = (await page.locator('canvas').boundingBox())!;
  const shot = await page.screenshot({
    clip: { x: box.x + 6, y: box.y + box.height - 12, width: 2, height: 2 },
  });
  // PNG 里直接比字节即可：我们只关心「换主题后它变了没有」
  return shot.toString('base64');
}

async function pickTheme(page: Page, id: string): Promise<void> {
  await page.getByTestId('theme-picker').click();
  await expect(page.getByTestId('theme-menu')).toBeVisible();
  await page.getByTestId(`theme-${id}`).click();
  await expect(page.getByTestId('theme-menu')).toHaveCount(0);
  await page.waitForTimeout(600);
}

test('切换主题：面板与 3D 场景同时跟着变', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  const beforePanel = await panelBg(page);
  const beforeCanvas = await canvasCorner(page);

  await pickTheme(page, 'light');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  const afterPanel = await panelBg(page);
  const afterCanvas = await canvasCorner(page);
  expect(afterPanel, '面板底色应随主题改变').not.toBe(beforePanel);
  expect(afterCanvas, '3D 场景底色应随主题改变').not.toBe(beforeCanvas);
  // 日光主题的面板必须是浅色（否则就是只改了一半）
  const [r, g, b] = /rgb\((\d+), (\d+), (\d+)\)/.exec(afterPanel)!.slice(1).map(Number);
  expect((r + g + b) / 3, '日光主题面板应为浅色').toBeGreaterThan(180);

  expect(errors).toEqual([]);
});

test('四个主题都能切换，且不会白屏或报错', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  for (const id of ['deep', 'warm', 'light', 'slate']) {
    await pickTheme(page, id);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(id);
    // 场景仍在，UI 仍可读
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByText('DB Kernel Lab', { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('主题选择记在本机，刷新后仍然生效且首帧不闪', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await pickTheme(page, 'warm');

  await page.reload();
  // 关键：data-theme 在 React 挂载之前就应由内联脚本设好，所以启动画面阶段就是对的
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('warm');
  await waitForReady(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('warm');
});

test('换主题不影响实验数据与时间轴', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await page.getByLabel('批量插入').fill('12');
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText(/BULK INSERT ×12/).first()).toBeVisible();
  await page.getByTitle('跳到结尾 (End)').click();

  const counterBefore = await page.getByTestId('timeline-counter').innerText();
  const rowsBefore = await page.locator('[data-stat="行数"] [data-stat-value]').innerText();

  await pickTheme(page, 'light');

  await expect(page.getByTestId('timeline-counter')).toHaveText(counterBefore);
  await expect(page.locator('[data-stat="行数"] [data-stat-value]')).toHaveText(rowsBefore);
});
