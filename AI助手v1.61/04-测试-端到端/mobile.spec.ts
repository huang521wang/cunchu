import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('手机端：助手页与工具箱各模块正常显示，页面没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('page-assistant')).toBeVisible();

  // 窄屏：工具箱是全屏抽屉，逐个打开都不能横向溢出
  for (const [key, testid] of [
    ['overview', 'page-home'],
    ['today', 'page-today'],
    ['study', 'page-study'],
    ['fitness', 'page-fitness'],
    ['settings', 'page-settings'],
  ] as [string, string][]) {
    await openModule(page, key);
    await expect(page.getByTestId(testid)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `模块 ${key} 横向溢出了 ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test('手机端：首次打开要输访问口令，输对了才能进', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // 模拟"来自局域网、还没带口令"：带对口令才放行
  await page.route('**/api/all', async (route) => {
    const pin = route.request().headers()['x-workbench-pin'];
    if (pin === '123456') return route.fallback();
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: '需要访问口令', needPin: true }),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('pin-gate')).toBeVisible();

  // 先输错的 → 提示口令不对
  await page.getByTestId('pin-input').fill('000000');
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('pin-error')).toBeVisible();

  // 输对的 → 进入 AI 助手
  await page.getByTestId('pin-input').fill('123456');
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('page-assistant')).toBeVisible();
  await expect(page.getByTestId('assistant-topbar')).toBeVisible();
});
