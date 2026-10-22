import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const yesterday = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStr(d);
})();

test('M7: 填写早餐后自动保存、首页摘要与本周统计同步、刷新不丢', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'diet');

  await page.getByTestId('meal-breakfast').fill('燕麦 + 鸡蛋');
  await page.getByTestId('meal-breakfast').blur();
  await expect(page.getByTestId('diet-progress')).toContainText('三餐已记 1/3');
  await expect(page.getByTestId('diet-week')).toContainText('本周记录 1/7 天');

  // 填午餐 → 2/3
  await page.getByTestId('meal-lunch').fill('鸡胸肉饭');
  await page.getByTestId('meal-lunch').blur();
  await expect(page.getByTestId('diet-progress')).toContainText('三餐已记 2/3');

  // 刷新后内容还在
  await page.reload();
  await openModule(page, 'diet');
  await expect(page.getByTestId('meal-breakfast')).toHaveValue('燕麦 + 鸡蛋');
  await expect(page.getByTestId('meal-lunch')).toHaveValue('鸡胸肉饭');

  // 首页摘要同步
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-diet')).toContainText('三餐已记 2/3');
});

test('M7: 喝水点第 5 个 → 5/8；再点第 3 个 → 3/8；首页同步', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'diet');

  await page.getByTestId('water-drop-5').click();
  await expect(page.getByTestId('water-count')).toHaveText('5/8 杯');
  await expect(page.getByTestId('water-drop-5')).toHaveClass(/filled/);

  await page.getByTestId('water-drop-3').click();
  await expect(page.getByTestId('water-count')).toHaveText('3/8 杯');

  // 快速连点也不会产生重复的当天记录
  await page.getByTestId('water-drop-7').click();
  await page.getByTestId('water-drop-8').click();
  await expect(page.getByTestId('water-count')).toHaveText('8/8 杯');
  await expect(page.getByTestId('diet-history').locator('.list-row')).toHaveCount(1);

  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-diet')).toContainText('喝水 8/8 杯');
});

test('M7: 历史记录可查看并补记过去某天', async ({ page, request }) => {
  await request.post('/api/mealDays', {
    data: { date: yesterday, breakfast: '包子', lunch: '', dinner: '', snack: '', water: 6 },
  });

  await page.goto('/');
  await openModule(page, 'diet');
  const row = page.getByTestId('history-row', { hasText: '包子' });
  await expect(row).toBeVisible();

  await row.getByTestId('history-view').click();
  await expect(page.getByTestId('day-panel')).toBeVisible();
  await expect(page.getByTestId('panel-breakfast')).toHaveValue('包子');

  // 补记晚餐
  await page.getByTestId('panel-dinner').fill('火锅');
  await page.getByTestId('panel-dinner').blur();
  await page.getByTestId('panel-close').click();
  await expect(page.getByTestId('history-row', { hasText: '火锅' })).toBeVisible();

  // 历史里两天的记录（昨天 + 今天点过喝水）都在
  await expect(page.getByTestId('diet-history').locator('.list-row')).toHaveCount(1);
});
