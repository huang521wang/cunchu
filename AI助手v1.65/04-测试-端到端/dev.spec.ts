import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

async function createProject(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await openModule(page, 'dev');
  await page.getByTestId('new-project').fill(name);
  await page.getByTestId('new-project').press('Enter');
  // 项目名显示在左侧列表里（详情里是输入框，读不到文本）
  await expect(page.getByTestId('project-list')).toContainText(name);
  await expect(page.getByTestId('project-name')).toHaveValue(name);
}

test('M4: 新建项目和任务；推进/退回状态，三列与徽标、摘要联动', async ({ page }) => {
  await createProject(page, '小程序改版');
  await page.getByTestId('new-task-todo').fill('登录页开发');
  await page.getByTestId('new-task-todo').press('Enter');
  await expect(page.getByTestId('task-col-todo')).toContainText('登录页开发');
  await expect(page.getByTestId('task-col-todo')).toContainText('待办 (1)');

  // 推进：待办 → 进行中
  const card = page.getByTestId('task-col-todo').locator('.kcard', { hasText: '登录页开发' });
  await card.hover();
  await card.getByTestId('move-next').click();
  await expect(page.getByTestId('task-col-doing')).toContainText('登录页开发');
  await expect(page.getByTestId('task-col-todo')).not.toContainText('登录页开发');

  // 侧栏徽标 = 进行中数量
  await openModule(page, 'dev');
  await expect(page.getByTestId('badge-dev')).toHaveText('1');

  // 推进：进行中 → 完成
  const doingCard = page.getByTestId('task-col-doing').locator('.kcard', { hasText: '登录页开发' });
  await doingCard.hover();
  await doingCard.getByTestId('move-next').click();
  await expect(page.getByTestId('task-col-done')).toContainText('登录页开发');

  // 退回：完成 → 进行中
  const doneCard = page.getByTestId('task-col-done').locator('.kcard', { hasText: '登录页开发' });
  await doneCard.hover();
  await doneCard.getByTestId('move-prev').click();
  await expect(page.getByTestId('task-col-doing')).toContainText('登录页开发');

  // 首页摘要卡同步
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-dev')).toContainText('进行中 1');
  await expect(page.getByTestId('summary-dev')).toContainText('登录页开发');
});

test('M4: 任务可编辑标题/优先级/备注，可删除', async ({ page }) => {
  await createProject(page, '工具箱');
  await page.getByTestId('new-task-todo').fill('写个脚本');
  await page.getByTestId('new-task-todo').press('Enter');

  await page.getByTestId('task-col-todo').locator('.kcard', { hasText: '写个脚本' }).click();
  await expect(page.getByTestId('task-modal')).toBeVisible();
  await page.getByTestId('edit-task-title').fill('写批量重命名脚本');
  await page.getByTestId('edit-task-priority').selectOption('high');
  await page.getByTestId('edit-task-note').fill('注意空格文件名');
  await page.getByTestId('edit-task-save').click();

  const card = page.getByTestId('task-col-todo').locator('.kcard', { hasText: '写批量重命名脚本' });
  await expect(card).toContainText('高');
  await expect(card).toContainText('注意空格文件名');

  // 删除
  await card.click();
  await page.getByTestId('edit-task-del').click();
  await expect(page.getByTestId('task-col-todo')).not.toContainText('写批量重命名脚本');
});

test('M4: 进展记录添加/编辑/删除，最新一条在最上面', async ({ page }) => {
  await createProject(page, '网站改版');
  await page.getByTestId('dev-tab-logs').click();

  await page.getByTestId('log-input').fill('搞定登录接口');
  await page.getByTestId('log-input').press('Enter');
  await expect(page.getByTestId('log-list')).toContainText('搞定登录接口');
  await page.getByTestId('log-input').fill('修了个缓存 bug');
  await page.getByTestId('log-input').press('Enter');
  await expect(page.getByTestId('log-list').locator('.list-row')).toHaveCount(2);

  // 倒序：最新一条在最上面
  await expect(page.getByTestId('log-list').locator('.list-row').first()).toContainText('修了个缓存 bug');

  // 编辑
  await page.getByTestId('log-list').locator('.list-row').first().locator('.row-main').click();
  const editor = page.getByTestId('log-list').locator('input');
  await editor.fill('修了缓存 bug（已上线）');
  await editor.press('Enter');
  await expect(page.getByTestId('log-list')).toContainText('修了缓存 bug（已上线）');

  // 删除
  const row = page.getByTestId('log-list').locator('.list-row', { hasText: '搞定登录接口' });
  await row.hover();
  await row.getByTestId('log-del').click();
  await expect(page.getByTestId('log-list')).not.toContainText('搞定登录接口');

  // 刷新后仍在
  await page.reload();
  await openModule(page, 'dev');
  await page.getByTestId('dev-tab-logs').click();
  await expect(page.getByTestId('log-list')).toContainText('修了缓存 bug（已上线）');
});

test('M4: 项目改"已完成"灰显但保留；删除项目连带清掉任务和记录', async ({ page, request }) => {
  await createProject(page, '老项目');
  await page.getByTestId('new-task-todo').fill('遗留任务');
  await page.getByTestId('new-task-todo').press('Enter');

  await page.getByTestId('project-status').selectOption('done');
  const row = page.getByTestId('project-list').locator('.project-row', { hasText: '老项目' });
  await expect(row).toHaveClass(/done/);
  await expect(page.getByTestId('project-list')).toContainText('老项目');

  // 删除项目（需确认）→ 项目和它的任务一起消失
  await page.getByTestId('project-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('project-list')).not.toContainText('老项目');

  const tasks = await (await request.get('/api/projectTasks')).json();
  expect(tasks).toHaveLength(0);
});
