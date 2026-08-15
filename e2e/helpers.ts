import { expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * 端到端用例共用的导航动作。
 *
 * 界面改成「顶栏下拉选引擎 + 两条标签页侧栏」之后，很多控件不再一直挂在 DOM 上 ——
 * 得先切到它所在的标签。把这几步收进这里，用例本身才继续读得像在描述行为，
 * 而不是在描述点击顺序。
 */

/** 左栏标签：做什么。 */
export type LeftTab = 'ops' | 'query' | 'config' | 'tutorial';
/** 右栏标签：发生了什么。 */
export type RightTab = 'state' | 'inspect' | 'log';

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

export async function waitForReady(page: Page): Promise<void> {
  // 启动画面会在引擎就绪后自行移除
  await page.waitForSelector('#dbkl-boot', { state: 'detached', timeout: 20_000 });
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText(/就绪：表 users 已创建|已从 IndexedDB 恢复/)).toBeVisible();
}

/** 切到某个标签页；标签内容是惰性渲染的，所以这一步是访问面板的前提。 */
export async function openTab(page: Page, tab: LeftTab | RightTab): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click();
}

/** 顶栏的引擎下拉：先展开再选。`expectLabel` 对着按钮上的引擎名断言。 */
export async function switchEngine(page: Page, id: string, expectLabel: RegExp): Promise<void> {
  await page.getByTestId('engine-picker').click();
  await page.getByTestId(`engine-${id}`).click();
  // 引擎在 Worker 里重建，期间下拉是禁用的 —— 它重新可点就说明切换真的完成了
  await expect(page.getByTestId('engine-picker')).toHaveText(expectLabel, { timeout: 20_000 });
  await expect(page.getByTestId('engine-picker')).toBeEnabled({ timeout: 20_000 });
}

export async function bulkInsert(page: Page, count: number, toEnd = true): Promise<void> {
  await openTab(page, 'ops');
  await page.getByLabel('批量插入').fill(String(count));
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText(new RegExp(`BULK INSERT ×${count}`)).first()).toBeVisible();
  if (toEnd) await page.getByTitle('跳到结尾 (End)').click();
}

/** 引导实验按钮在左栏「实验」标签里。 */
export async function runScenario(page: Page, id: string): Promise<void> {
  await openTab(page, 'tutorial');
  await page.getByTestId(`scenario-${id}`).click();
}

/**
 * 事件文案（`describeEvent` 的输出）只在右栏「事件日志」标签里渲染，
 * 断言前得先切过去 —— 标签内容是惰性挂载的，没选中就不在 DOM 里。
 */
export async function expectEvent(page: Page, pattern: RegExp, timeout = 30_000): Promise<void> {
  await openTab(page, 'log');
  await expect(page.getByText(pattern).first()).toBeVisible({ timeout });
}

export const statValue = (page: Page, label: string) =>
  page.locator(`[data-stat="${label}"] [data-stat-value]`);
