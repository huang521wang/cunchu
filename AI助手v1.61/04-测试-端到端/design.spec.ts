import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('设计稿页：展示四张概念稿卡片和总览入口', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'design');
  await expect(page.getByTestId('page-design')).toBeVisible();
  for (const key of ['wechat', 'qq', 'cxx', 'fs']) {
    await expect(page.getByTestId(`draft-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId('open-concept-index')).toBeVisible();
  await expect(page.getByTestId('draft-wechat')).toContainText('微信 · 概念重设计');
});

test('设计稿页：点卡片新开标签页，概念稿能打开并且可以交互', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'design');

  const [draft] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('draft-wechat').click(),
  ]);
  await draft.waitForLoadState();
  await expect(draft).toHaveTitle(/微信 · 概念重设计/);
  await expect(draft.locator('.head .tag')).toContainText('非官方');

  // 概念稿的本地交互在 http（本地小服务）下同样可用
  // 页面里有两台手机，交互都限定在第一台上操作
  const draftA = draft.locator('.phone').nth(0);

  // 扩展功能：通讯录 / 朋友圈
  await draftA.locator('.tab:visible', { hasText: '通讯录' }).click();
  await expect(draftA.locator('[data-clist] .conv').first()).toBeVisible();
  await draftA.locator('.tab:visible', { hasText: '发现' }).click();
  await expect(draftA.locator('[data-mfeed] .moment').first()).toBeVisible();
  await draftA.locator('.tab:visible', { hasText: '微信' }).click();
  await expect(draftA.locator('.conv:visible').first()).toBeVisible();

  await draftA.locator('.conv:visible', { hasText: '小栀' }).click();
  await expect(draftA.locator('[data-view="chat"] .name')).toHaveText('小栀');
  await draftA.locator('[data-input]').fill('本地测试');
  await draftA.locator('[data-input]').press('Enter');
  await expect.poll(() => draftA.locator('[data-msgs] .msg').count()).toBeGreaterThan(3);

  // 清掉这次演示的本地存储，回到初始状态
  await draft.evaluate(() => localStorage.clear());
  await draft.close();
});

test('设计稿页：微信桌面版（三栏布局）可用', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'design');
  const [desk] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('draft-wxdesk').click(),
  ]);
  await desk.waitForLoadState();
  await expect(desk).toHaveTitle(/微信 · 概念重设计（桌面版）/);
  await expect(desk.locator('.win .rail')).toBeVisible();
  await desk.locator('.conv-row', { hasText: '小栀' }).click();
  await expect(desk.locator('[data-chat-name]')).toHaveText('小栀');
  await desk.locator('[data-input]').fill('桌面版测试');
  await desk.locator('[data-input]').press('Enter');
  await expect.poll(() => desk.locator('[data-msgs] .msg').count()).toBeGreaterThan(3);
  await desk.evaluate(() => localStorage.clear());
  await desk.close();
});

test('设计稿页：学习通桌面版（粉蓝三栏布局）可用', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'design');
  const [desk] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('draft-cxxdesk').click(),
  ]);
  await desk.waitForLoadState();
  await expect(desk).toHaveTitle(/学习通 · 概念重设计（桌面版）/);
  await expect(desk.locator('.win .rail')).toBeVisible();

  // 勾任务 → 目标联动
  const goal = desk.locator('[data-goal-num]');
  await expect(goal).toHaveText('40 / 60 分钟');
  await desk.getByTestId('dtask-video').click();
  await expect(goal).toHaveText('70 / 60 分钟');

  // 课程 → 勾章节 → 进度联动
  await desk.locator('[data-rail="courses"]').click();
  await expect(desk.getByTestId('dcourse-pct')).toHaveText('40%');
  await desk.getByTestId('dchapter-dv-2').click();
  await expect(desk.getByTestId('dcourse-pct')).toHaveText('60%');

  await desk.evaluate(() => localStorage.clear());
  await desk.close();
});

test('设计稿页：总览入口打开总览页', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'design');
  const [indexPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('open-concept-index').click(),
  ]);
  await indexPage.waitForLoadState();
  await expect(indexPage).toHaveTitle('设计概念稿 · 总览');
  await expect(indexPage.locator('.app-card').first()).toBeVisible();
});
