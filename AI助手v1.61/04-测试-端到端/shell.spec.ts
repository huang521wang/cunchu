import { test, expect } from '@playwright/test';
import { resetData } from './helpers';

const TOOLS = ['overview', 'today', 'study', 'fitness', 'diet', 'games', 'media', 'dev', 'consulting', 'design', 'materials', 'memory', 'screen', 'settings'];

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('M1: 应用能加载，顶栏与工具箱 14 个入口都在（v3 纯助手布局）', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('assistant-topbar')).toBeVisible();
  await expect(page.getByTestId('topbar-logo')).toContainText('AI 助手');
  await expect(page.getByTestId('toolbox-open')).toBeVisible();
  await expect(page.getByTestId('open-settings')).toBeVisible();
  await page.getByTestId('toolbox-open').click();
  for (const key of TOOLS) {
    await expect(page.getByTestId(`toolbox-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId('page-assistant')).toBeVisible();
});

test('M1: 工具箱能逐个打开全部模块（每个模块的真实首屏都在），收起后回到聊天', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('toolbox-open').click();
  const cases: [string, string][] = [
    ['overview', 'page-home'],
    ['today', 'page-today'],
    ['study', 'page-study'],
    ['fitness', 'page-fitness'],
    ['diet', 'page-diet'],
    ['games', 'page-games'],
    ['media', 'page-media'],
    ['dev', 'page-dev'],
    ['consulting', 'page-consulting'],
    ['design', 'page-design'],
    ['materials', 'asset-box'],
    ['memory', 'memory-tree'],
    ['screen', 'screen-tab'],
    ['settings', 'page-settings'],
  ];
  for (const [key, testid] of cases) {
    await page.getByTestId(`toolbox-${key}`).click();
    await expect(page.getByTestId(testid), `${key} 打不开`).toBeVisible();
  }
  await page.getByTestId('toolbox-close').click();
  await expect(page.getByTestId('assistant-toolbox')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

test('M1: 刷新页面后应用仍然正常（数据接口可用）', async ({ page, request }) => {
  await page.goto('/');
  const res = await request.get('/api/all');
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('assistant-topbar')).toBeVisible();
  await expect(page.getByTestId('page-assistant')).toBeVisible();
});
