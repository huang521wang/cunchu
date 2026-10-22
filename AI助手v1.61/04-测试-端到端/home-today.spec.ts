import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

async function addHomeTask(page: import('@playwright/test').Page, title: string) {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('home-task-input').fill(title);
  await page.getByTestId('home-task-input').press('Enter');
  await expect(page.getByTestId('home-todo-list')).toContainText(title);
}

test('M2: 首页添加任务，今日计划里能看到（同一份数据）', async ({ page }) => {
  await addHomeTask(page, '买咖啡豆');
  await page.getByTestId('goto-today').click();
  await expect(page.getByTestId('today-task-list')).toContainText('买咖啡豆');
});

test('M2: 今日计划里勾选任务，首页同步显示已完成与进度', async ({ page }) => {
  await addHomeTask(page, '写周报');
  await page.getByTestId('goto-today').click();
  const row = page.getByTestId('today-task-list').locator('.list-row', { hasText: '写周报' });
  await row.locator('.checkbox').click();
  await expect(page.getByTestId('today-progress')).toContainText('已完成 1/1');

  await openModule(page, 'overview');
  await expect(page.getByTestId('home-progress')).toContainText('1/1');
  await expect(page.getByTestId('home-done-group')).toContainText('写周报');
  await expect(page.getByTestId('home-done-group').locator('.done-text')).toHaveText('写周报');
});

test('M2: 优先级排序 —— 高优先级排在前面', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await openModule(page, 'today');
  await page.getByTestId('task-input').fill('普通任务');
  await page.getByTestId('task-add').click();
  await page.getByTestId('task-input').fill('重要任务');
  await page.getByTestId('task-priority').selectOption('high');
  await page.getByTestId('task-add').click();
  await page.getByTestId('task-input').fill('中等任务');
  await page.getByTestId('task-priority').selectOption('mid');
  await page.getByTestId('task-add').click();

  const titles = page.getByTestId('today-task-list').locator('.row-main');
  await expect(titles.nth(0)).toHaveText('重要任务');
  await expect(titles.nth(1)).toHaveText('中等任务');
  await expect(titles.nth(2)).toHaveText('普通任务');
});

test('M2: 勾选后进入已完成折叠组，取消勾选能还原', async ({ page }) => {
  await addHomeTask(page, '背单词');
  await page.getByTestId('goto-today').click();
  const row = page.getByTestId('today-task-list').locator('.list-row', { hasText: '背单词' });
  await row.locator('.checkbox').click();

  // 任务离开待办列表，进入已完成组（折叠状态点开可见）
  await expect(page.getByTestId('today-task-list').locator('.list-row')).toHaveCount(0);
  await page.getByTestId('done-toggle').click();
  const doneRow = page.getByTestId('today-done-group').locator('.list-row', { hasText: '背单词' });
  await expect(doneRow).toBeVisible();

  // 取消勾选 → 回到待办
  await doneRow.locator('.checkbox').click();
  await expect(page.getByTestId('today-task-list')).toContainText('背单词');
});

test('M2: 切到明天添加任务，切回今天看不到', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await openModule(page, 'today');
  await page.getByTestId('next-day').click();
  await page.getByTestId('task-input').fill('明天的安排');
  await page.getByTestId('task-add').click();
  await expect(page.getByTestId('today-task-list')).toContainText('明天的安排');

  await page.getByTestId('back-today').click();
  await expect(page.getByTestId('today-task-list')).not.toContainText('明天的安排');
  await expect(page.getByTestId('today-empty')).toBeVisible();
});

test('M2: 顺延 —— 未完成任务移到明天，已完成留在今天', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await openModule(page, 'today');
  await page.getByTestId('task-input').fill('搬家计划');
  await page.getByTestId('task-add').click();
  await expect(page.getByTestId('today-task-list')).toContainText('搬家计划');
  await page.getByTestId('task-input').fill('洗衣服');
  await page.getByTestId('task-add').click();
  await expect(page.getByTestId('today-task-list')).toContainText('洗衣服');

  const doneRow = page.getByTestId('today-task-list').locator('.list-row', { hasText: '洗衣服' });
  await doneRow.locator('.checkbox').click();

  await page.getByTestId('postpone-btn').click();
  await expect(page.getByTestId('today-task-list')).not.toContainText('搬家计划');

  // 已完成组默认折叠：展开后确认"洗衣服"还在今天、状态是已完成
  await page.getByTestId('done-toggle').click();
  const doneRowAfter = page.getByTestId('today-done-group').locator('.list-row', { hasText: '洗衣服' });
  await expect(doneRowAfter.locator('.done-text')).toBeVisible();
  await expect(page.getByTestId('today-done-group')).not.toContainText('搬家计划');

  // 明天能看到顺延过来的任务
  await page.getByTestId('next-day').click();
  await expect(page.getByTestId('today-task-list')).toContainText('搬家计划');
  await expect(page.getByTestId('today-task-list')).not.toContainText('洗衣服');
});

test('M2: 快速备忘 —— 添加、编辑、刷新后仍在、删除生效', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('memo-input').fill('买牛奶');
  await page.getByTestId('memo-input').press('Enter');
  await page.getByTestId('memo-input').fill('楼下取快递');
  await page.getByTestId('memo-input').press('Enter');
  await expect(page.getByTestId('memo-list')).toContainText('买牛奶');
  await expect(page.getByTestId('memo-list')).toContainText('楼下取快递');

  // 刷新后仍在
  await page.reload();
  await expect(page.getByTestId('memo-list')).toContainText('买牛奶');

  // 点击文字就地编辑
  const memoRow = page.getByTestId('memo-list').locator('.list-row', { hasText: '买牛奶' });
  await memoRow.locator('.row-main').click();
  // 进入编辑态后，行内出现唯一一个输入框
  const editor = page.getByTestId('memo-list').locator('input');
  await editor.fill('买牛奶和面包');
  await editor.press('Enter');
  await expect(page.getByTestId('memo-list')).toContainText('买牛奶和面包');

  // 删除
  const target = page.getByTestId('memo-list').locator('.list-row', { hasText: '楼下取快递' });
  await target.hover();
  await target.locator('.icon-btn').click();
  await expect(page.getByTestId('memo-list')).not.toContainText('楼下取快递');
  await page.reload();
  await expect(page.getByTestId('memo-list')).not.toContainText('楼下取快递');
});

test('M2: 摘要卡数字与数据一致，点击可跳转', async ({ page, request }) => {
  // 通过接口造一条"待发布"的自媒体内容（自媒体模块还没做，但摘要卡应该立刻反映）
  const res = await request.post('/api/contentItems', {
    data: {
      title: '新视频',
      platform: '小红书',
      status: 'ready',
      plannedDate: '2026-10-20',
      draft: '',
      note: '',
      link: '',
    },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-media')).toContainText('待发布 1');
  await expect(page.getByTestId('summary-media')).toContainText('新视频');

  // 无数据的模块显示"暂无"
  await expect(page.getByTestId('summary-dev')).toContainText('暂无');
  await expect(page.getByTestId('summary-fitness')).toContainText('本周 0/0 次');

  // 点击摘要卡跳转
  await page.getByTestId('summary-media').click();
  await expect(page.getByTestId('page-media')).toBeVisible();
});

test('M2: 浏览器刷新后任务不丢（验收 A 的界面路径）', async ({ page }) => {
  await addHomeTask(page, '刷新也要在');
  await page.reload();
  await expect(page.getByTestId('home-todo-list')).toContainText('刷新也要在');
});
