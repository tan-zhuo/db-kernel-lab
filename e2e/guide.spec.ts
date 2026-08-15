import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 原理讲解页的端到端守护。
 *
 * 这一页的价值在于「理论 → 一键跑起来」这条链路：正文里的实验按钮必须真的
 * 切引擎、跑命令、并把讲解关掉让你看画面。断链了这页就退化成一篇静态文章。
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

test('讲解页可以打开、切页、关闭', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  await page.getByTestId('open-guide').click();
  const guide = page.getByTestId('guide-overlay');
  await expect(guide).toBeVisible();
  // 默认落在当前引擎（InnoDB）那一页
  await expect(guide.getByRole('heading', { level: 1 })).toContainText('InnoDB');

  for (const [key, expected] of [
    ['postgres', 'PostgreSQL'],
    ['lsm', 'LSM-Tree'],
    ['columnar', '列存'],
    ['kv', '哈希索引'],
    ['compare', '怎么选'],
  ] as const) {
    await page.getByTestId(`guide-nav-${key}`).click();
    await expect(guide.getByRole('heading', { level: 1 })).toContainText(expected);
  }

  await page.getByTestId('guide-close').click();
  await expect(guide).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Esc 也能关掉', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await page.getByTestId('open-guide').click();
  await expect(page.getByTestId('guide-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
});

test('正文里的「跑这个实验」会切引擎并真的跑起来', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForReady(page);

  await page.getByTestId('open-guide').click();
  await page.getByTestId('guide-nav-columnar').click();
  // 列存那页的「区间统计剪枝」一节挂着 col-projection 实验
  await page.getByTestId('guide-run-col-projection').click();

  // 讲解自动关闭，引擎切到列存，实验跑完
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
  await expect(page.getByText('Columnar (ClickHouse-like)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/省了 \d+%/).first()).toBeVisible({ timeout: 40_000 });
  expect(errors).toEqual([]);
});

test('每个引擎页的实验按钮都指向真实存在的实验', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await page.getByTestId('open-guide').click();

  for (const key of ['innodb', 'postgres', 'lsm', 'columnar', 'kv']) {
    await page.getByTestId(`guide-nav-${key}`).click();
    const buttons = page.locator('[data-testid^="guide-run-"]');
    // 每个引擎页至少挂一个可跑的实验；按钮存在即说明 scenarioId 解析到了
    expect(await buttons.count(), `${key} 页应有实验按钮`).toBeGreaterThan(0);
  }
});

test('从讲解页可以直接切到对应引擎', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await page.getByTestId('open-guide').click();
  await page.getByTestId('guide-nav-kv').click();
  await page.getByRole('button', { name: '切到这个引擎' }).click();
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
  await expect(page.getByText('KV Hash Index (Bitcask-like)')).toBeVisible({ timeout: 20_000 });
});
