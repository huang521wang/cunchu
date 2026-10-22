import { test, expect } from '@playwright/test';
import { resetData } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('可安装成软件：manifest / 图标 / service worker 都就位', async ({ page, request }) => {
  // manifest 可访问且内容正确
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.name).toBe('AI 助手');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

  // 所有图标都能取到、且是 PNG
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type'], icon.src).toContain('image/png');
  }

  // 页面头部挂好了 manifest / 图标 / 主题色
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icons/icon-192.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ff9ec4');
  // iPhone"添加到主屏幕"后全屏打开需要这几个（苹果不看 manifest，看这几个 meta）
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', '工作台');

  // service worker 注册成功（本机 localhost 下应该能注册）
  await expect
    .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), {
      timeout: 15000,
    })
    .toBeGreaterThan(0);

  // sw.js 本身可访问
  expect((await request.get('/sw.js')).status()).toBe(200);

  // 应用照常能用（不是只有壳）：v3 默认打开就是助手聊天页
  await expect(page.getByTestId('page-assistant')).toBeVisible();
  await expect(page.getByTestId('assistant-topbar')).toBeVisible();
});
