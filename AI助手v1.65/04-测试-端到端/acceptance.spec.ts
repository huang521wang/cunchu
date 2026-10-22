import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('验收 A: 改动后 1 秒内出现"已保存"提示', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('home-task-input').fill('触发一次保存');
  await page.getByTestId('home-task-input').press('Enter');
  await expect(page.getByTestId('saved-indicator')).toContainText('已保存', { timeout: 1000 });
});

test('验收 A/L: 全程只访问本机地址（无外部请求）；深色模式下所有功能页全部正常、无报错', async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith('http://127.0.0.1:8790') && !u.startsWith('data:')) external.push(u);
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  await openModule(page, 'settings');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // v3 纯助手布局：默认聊天页一直在；其余功能全部从工具箱打开
  await expect(page.getByTestId('page-assistant')).toBeVisible();
  for (const [key, testid] of [
    ['overview', 'page-home'],
    ['today', 'page-today'],
    ['media', 'page-media'],
    ['dev', 'page-dev'],
    ['consulting', 'page-consulting'],
    ['fitness', 'page-fitness'],
    ['diet', 'page-diet'],
    ['games', 'page-games'],
    ['design', 'page-design'],
    ['settings', 'page-settings'],
  ] as [string, string][]) {
    await openModule(page, key);
    await expect(page.getByTestId(testid)).toBeVisible();
  }

  expect(external, `出现了外部请求：${external.join(', ')}`).toEqual([]);
  expect(errors, `页面报错：${errors.join(' | ')}`).toEqual([]);
});

test('验收 L: 少女风配色契约（v3 温润系：藕粉 / 雾薄荷 / 雾蓝 / 暖米白 / 粉白）', async ({ page }) => {
  await page.goto('/');
  const vals = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const get = (k: string) => cs.getPropertyValue(k).trim();
    return {
      pink: get('--pink'),
      mint: get('--mint'),
      blue: get('--blue'),
      cream: get('--cream'),
      pinkWhite: get('--pink-white'),
    };
  });
  expect(vals.pink).toBe('#f5b6cc');
  expect(vals.mint).toBe('#a8dccf');
  expect(vals.blue).toBe('#b7d5ec');
  expect(vals.cream).toBe('#fdf8f1');
  expect(vals.pinkWhite).toBe('#fdf6f9');
});

test('验收 L: 空数据时每个页面都有引导语', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await expect(page.getByTestId('home-todo-list')).toContainText('今天还没有任务');
  await expect(page.getByTestId('memo-list')).toContainText('备忘录空空的');
  await openModule(page, 'today');
  await expect(page.getByTestId('today-empty')).toBeVisible();
  await openModule(page, 'dev');
  await expect(page.getByTestId('dev-empty')).toBeVisible();
  await openModule(page, 'consulting');
  await expect(page.getByTestId('consulting-empty')).toBeVisible();
  await openModule(page, 'fitness');
  await expect(page.getByTestId('workout-list')).toContainText('还没有训练记录');
  await expect(page.getByTestId('weight-list')).toContainText('还没有体重记录');
  await openModule(page, 'diet');
  await expect(page.getByTestId('diet-history')).toContainText('还没有记录');
  await openModule(page, 'games');
  await expect(page.getByTestId('page-games')).toContainText('点右上角添加');
  await openModule(page, 'media');
  await expect(page.getByTestId('col-idea')).toContainText('空空的');
  // 助手页现在是真的聊天界面（连着或没连模型都有明确提示）
  await expect(page.getByTestId('page-assistant')).toContainText('本地 AI 对话');
});

test('验收 L: 勾选完成的小花瓣是纯装饰，不影响任何操作', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('home-task-input').fill('花瓣测试');
  await page.getByTestId('home-task-input').press('Enter');
  await page.getByTestId('home-todo-list').locator('.checkbox').click();
  // 完成照常生效
  await expect(page.getByTestId('home-progress')).toContainText('1/1');
  // 花瓣自动清理，不会一直留在页面上
  await expect(page.locator('.petal')).toHaveCount(0, { timeout: 3000 });
});
