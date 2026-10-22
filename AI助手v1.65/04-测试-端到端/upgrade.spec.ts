import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const tomorrow = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return dateStr(d);
})();

const todayIdx = (new Date().getDay() + 6) % 7; // 0=周一 … 6=周日

test('升级: 一键计划（首页）—— 名称/日期/时间/预计时间/备注都能填', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('home-plan-btn').click();
  await expect(page.getByTestId('plan-modal')).toBeVisible();
  await page.getByTestId('plan-title').fill('预约体检');
  await page.getByTestId('plan-date').fill(tomorrow);
  await page.getByTestId('plan-time').fill('14:30');
  await page.getByTestId('plan-estimate').fill('1 小时');
  await page.getByTestId('plan-note').fill('记得空腹');
  await page.getByTestId('plan-priority').selectOption('high');
  await page.getByTestId('plan-save').click();

  // 安排在明天：今天的待办里看不到
  await expect(page.getByTestId('home-todo-list')).not.toContainText('预约体检');

  // 切到明天查看：时间/预计时间/备注/优先级都在
  await page.getByTestId('goto-today').click();
  await page.getByTestId('next-day').click();
  const row = page.getByTestId('today-task-list').locator('.task-item', { hasText: '预约体检' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('⏰ 14:30');
  await expect(row).toContainText('预计 1 小时');
  await expect(row).toContainText('记得空腹');
  await expect(row).toContainText('高');
});

test('升级: 一键计划（今日计划页）+ 待办更醒目 + 详情编辑', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'today');
  await page.getByTestId('open-plan').click();
  await page.getByTestId('plan-title').fill('写周报');
  await page.getByTestId('plan-save').click();

  const row = page.getByTestId('today-task-list').locator('.task-item', { hasText: '写周报' });
  await expect(row).toBeVisible();
  // 待做任务用醒目的卡片样式 + 待完成计数
  await expect(row).toHaveClass(/task-item/);
  await expect(page.getByTestId('today-remaining')).toContainText('待完成 1 件');

  // ✎ 编辑详情：补上时间和预计时间
  await row.hover();
  await row.locator('[data-testid^="task-edit-"]').click();
  await expect(page.getByTestId('plan-modal')).toBeVisible();
  await expect(page.getByTestId('plan-title')).toHaveValue('写周报');
  await page.getByTestId('plan-time').fill('09:00');
  await page.getByTestId('plan-estimate').fill('30 分钟');
  await page.getByTestId('plan-save').click();
  await expect(row).toContainText('⏰ 09:00');
  await expect(row).toContainText('预计 30 分钟');

  // 完成后回到低调的已完成组
  await row.locator('.checkbox').click();
  await expect(page.getByTestId('today-remaining')).toHaveCount(0);
});

test('升级: 备忘一键计划成任务（备忘被转换，不再重复出现）', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  await page.getByTestId('memo-input').fill('记得预约体检');
  await page.getByTestId('memo-input').press('Enter');
  const memoRow = page.getByTestId('memo-list').locator('.list-row', { hasText: '记得预约体检' });
  await expect(memoRow).toBeVisible();

  await memoRow.getByTestId('memo-plan').click();
  await expect(page.getByTestId('plan-title')).toHaveValue('记得预约体检');
  await page.getByTestId('plan-save').click();

  await expect(page.getByTestId('home-toast')).toContainText('已计划成任务');
  await expect(page.getByTestId('memo-list')).not.toContainText('记得预约体检');
  await expect(page.getByTestId('home-todo-list')).toContainText('记得预约体检');
});

test('升级: 拖拽卡片换阶段（自媒体看板），刷新后保持', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-ready').fill('拖拽测试内容');
  await page.getByTestId('new-ready').press('Enter');

  const card = page.getByTestId('col-ready').locator('.kcard', { hasText: '拖拽测试内容' });
  await card.dragTo(page.getByTestId('col-published'));
  await expect(page.getByTestId('col-published')).toContainText('拖拽测试内容');
  await expect(page.getByTestId('col-ready')).not.toContainText('拖拽测试内容');

  await page.reload();
  await openModule(page, 'media');
  await expect(page.getByTestId('col-published')).toContainText('拖拽测试内容');
});

test('升级: 拖拽任务换阶段（开发工作看板）', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'dev');
  await page.getByTestId('new-project').fill('拖拽项目');
  await page.getByTestId('new-project').press('Enter');
  await page.getByTestId('new-task-todo').fill('拖拽任务');
  await page.getByTestId('new-task-todo').press('Enter');

  const card = page.getByTestId('task-col-todo').locator('.kcard', { hasText: '拖拽任务' });
  await card.dragTo(page.getByTestId('task-col-done'));
  await expect(page.getByTestId('task-col-done')).toContainText('拖拽任务');
  await expect(page.getByTestId('task-col-todo')).not.toContainText('拖拽任务');
});

test('升级: AI 助手"加任务"也带时间/预计时间/备注', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  await page.getByTestId('quick-task').click();
  await page.getByTestId('q-task-title').fill('助手计划的任务');
  await page.getByTestId('q-task-time').fill('15:00');
  await page.getByTestId('q-task-estimate').fill('2 小时');
  await page.getByTestId('q-task-note').fill('带资料');
  await page.getByTestId('q-save').click();
  await expect(page.getByTestId('assistant-toast')).toContainText('已记入今日计划');

  const tasks = await (await request.get('/api/tasks')).json();
  const task = tasks.find((x: any) => x.title === '助手计划的任务');
  expect(task.time).toBe('15:00');
  expect(task.estimate).toBe('2 小时');
  expect(task.note).toBe('带资料');
});

test('升级: 游戏页和健身页同款（周计划/打卡/记录/趋势），游戏库与筛选保留', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'games');

  // 周计划：今天那格高亮，可编辑
  const cell = page.getByTestId(`plan-cell-${todayIdx}`);
  await expect(cell).toHaveClass(/today/);
  await cell.click();
  await cell.locator('input').fill('塞尔达');
  await cell.locator('input').press('Enter');
  await expect(cell).toContainText('塞尔达');

  // 游戏库：添加条目（原有功能）
  await page.getByTestId('game-add').click();
  await page.getByTestId('game-name').fill('塞尔达传说');
  await page.getByTestId('game-status').selectOption('playing');
  await page.getByTestId('game-save').click();
  await page.getByTestId('panel-close').click();

  // 完成今日娱乐：打卡生成记录
  await page.getByTestId('complete-play').click();
  await expect(page.getByTestId('checkin-modal')).toBeVisible();
  await page.getByTestId('checkin-item').selectOption({ label: '塞尔达传说' });
  await page.getByTestId('checkin-hours').fill('1.5');
  await page.getByTestId('checkin-note').fill('打了神庙');
  await page.getByTestId('checkin-save').click();

  await expect(page.getByTestId(`plan-check-${todayIdx}`)).toBeVisible();
  await expect(page.getByTestId('play-records')).toContainText('塞尔达传说');
  await expect(page.getByTestId('play-records')).toContainText('1.5h');
  await expect(page.getByTestId('games-month')).toContainText('本月娱乐 1.5h');
  await expect(page.getByTestId('games-week')).toContainText('本周 1 次');
  await expect(page.getByTestId('games-chart').locator('circle')).toHaveCount(1);

  // 游戏库筛选照常工作
  await page.getByTestId('games-filter-playing').click();
  await expect(page.getByTestId('game-card', { hasText: '塞尔达传说' })).toBeVisible();
  await page.getByTestId('games-filter-wish').click();
  await expect(page.getByTestId('game-card', { hasText: '塞尔达传说' })).toHaveCount(0);

  // 删除记录：打卡与趋势同步回退
  await page.getByTestId('games-filter-all').click();
  const rec = page.getByTestId('play-records').locator('.list-row', { hasText: '塞尔达传说' });
  await rec.hover();
  await rec.getByTestId('record-del').click();
  await expect(page.getByTestId(`plan-check-${todayIdx}`)).toHaveCount(0);
  await expect(page.getByTestId('games-month')).toContainText('本月娱乐 0h');
});

test('升级: 各模块摘要都保留', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'overview');
  for (const k of ['media', 'dev', 'consulting', 'fitness', 'diet', 'games']) {
    await expect(page.getByTestId(`summary-${k}`)).toBeVisible();
  }
  await openModule(page, 'media');
  await expect(page.getByTestId('media-stats')).toContainText('本月已发');
  await openModule(page, 'consulting');
  await expect(page.getByTestId('month-total')).toContainText('本月总工时');
  await openModule(page, 'fitness');
  await expect(page.getByTestId('fitness-stats')).toContainText('本周已练');
  await expect(page.getByTestId('streak')).toContainText('连续记录');
  await openModule(page, 'diet');
  await expect(page.getByTestId('diet-progress')).toContainText('三餐已记');
  await expect(page.getByTestId('diet-week')).toContainText('本周记录');
  await openModule(page, 'games');
  await expect(page.getByTestId('games-playing')).toContainText('在玩');
  await expect(page.getByTestId('games-month')).toContainText('本月娱乐');
});
