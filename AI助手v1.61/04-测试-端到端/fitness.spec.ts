import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

const todayIdx = (new Date().getDay() + 6) % 7; // 0=周一 … 6=周日

test('M6: 编辑周计划 —— 今天那格高亮，格子与首页摘要同步', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'fitness');

  // 今天那格高亮
  await expect(page.getByTestId(`plan-cell-${todayIdx}`)).toHaveClass(/today/);

  // 把今天改成"背+二头"
  const cell = page.getByTestId(`plan-cell-${todayIdx}`);
  await cell.click();
  await cell.locator('input').fill('背+二头');
  await cell.locator('input').press('Enter');
  await expect(cell).toContainText('背+二头');

  // 再把另一格（不依赖今天恰好是周几）改成"腿"
  const other = page.getByTestId(`plan-cell-${(todayIdx + 1) % 7}`);
  await other.click();
  await other.locator('input').fill('腿');
  await other.locator('input').press('Enter');
  await expect(other).toContainText('腿');

  // 首页摘要：今天显示"背+二头"，本周 0/2（今天+另一格 两个计划）
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-fitness')).toContainText('今天：背+二头');
  await expect(page.getByTestId('summary-fitness')).toContainText('本周 0/2 次');
});

test('M6: 完成今日训练打卡 —— 格子打勾、生成记录、首页次数增加', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'fitness');
  const cell = page.getByTestId(`plan-cell-${todayIdx}`);
  await cell.click();
  await cell.locator('input').fill('背+二头');
  await cell.locator('input').press('Enter');

  await page.getByTestId('complete-workout').click();
  await expect(page.getByTestId('workout-modal')).toBeVisible();
  await page.getByTestId('workout-note').fill('卧推加了 2.5kg');
  await page.getByTestId('workout-save').click();

  await expect(page.getByTestId('plan-check-' + todayIdx)).toBeVisible();
  await expect(page.getByTestId('workout-list')).toContainText('背+二头');
  await expect(page.getByTestId('workout-list')).toContainText('卧推加了 2.5kg');
  await expect(page.getByTestId('fitness-stats')).toContainText('本周已练 1/1 次');

  // 首页摘要同步
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-fitness')).toContainText('本周 1/1 次');

  // 记录删掉后打勾消失
  await openModule(page, 'fitness');
  const row = page.getByTestId('workout-list').locator('.list-row');
  await row.hover();
  await row.getByTestId('workout-del').click();
  await expect(page.getByTestId('plan-check-' + todayIdx)).toHaveCount(0);
});

test('M6: 体重记录 —— 列表两条、折线图两个点、可删除', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'fitness');

  await page.getByTestId('weight-input').fill('72.5');
  await page.getByTestId('weight-add').click();
  await expect(page.getByTestId('weight-list')).toContainText('72.5 kg');

  await page.getByTestId('weight-input').fill('72.1');
  await page.getByTestId('weight-add').click();

  await expect(page.getByTestId('weight-list').locator('.list-row')).toHaveCount(2);
  await expect(page.getByTestId('weight-chart').locator('circle')).toHaveCount(2);

  // 切换"全部"仍然正常显示两个点
  await page.getByTestId('chart-all').click();
  await expect(page.getByTestId('weight-chart').locator('circle')).toHaveCount(2);

  // 连续记录天数
  await expect(page.getByTestId('streak')).toContainText('连续记录 1 天');

  // 删除一条
  const row = page.getByTestId('weight-list').locator('.list-row').first();
  await row.hover();
  await row.getByTestId('weight-del').click();
  await expect(page.getByTestId('weight-list').locator('.list-row')).toHaveCount(1);
  await expect(page.getByTestId('weight-chart').locator('circle')).toHaveCount(1);

  // 刷新后数据在
  await page.reload();
  await openModule(page, 'fitness');
  await expect(page.getByTestId('weight-list').locator('.list-row')).toHaveCount(1);
});
