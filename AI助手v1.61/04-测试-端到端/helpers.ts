import { APIRequestContext, Page, expect } from '@playwright/test';

/** 每个测试开始前，把服务端数据清空，保证测试之间互不影响 */
export async function resetData(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/wipe', { data: { confirm: '清空' } });
  expect(res.ok()).toBeTruthy();
}

/** 打开右侧工具箱并切到指定模块（v3：没有左侧导航，功能都在工具箱） */
export async function openModule(page: Page, key: string): Promise<void> {
  const tab = page.getByTestId(`toolbox-${key}`);
  if (!(await tab.isVisible().catch(() => false))) {
    await page.getByTestId('toolbox-open').click();
    await expect(tab).toBeVisible({ timeout: 5000 });
  }
  await tab.click();
}
