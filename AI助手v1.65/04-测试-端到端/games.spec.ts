import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

async function addItem(
  page: import('@playwright/test').Page,
  name: string,
  category: 'game' | 'movie' | 'other' = 'game',
  status: 'wish' | 'playing' | 'done' | 'shelved' = 'wish',
) {
  await page.getByTestId('game-add').click();
  await page.getByTestId('game-name').fill(name);
  await page.getByTestId('game-category').selectOption(category);
  await page.getByTestId('game-status').selectOption(status);
  await page.getByTestId('game-save').click();
  await page.getByTestId('panel-close').click();
  await expect(page.getByTestId('game-card', { hasText: name })).toBeVisible();
}

test('M8: 添加"影视"条目，状态页签筛选正常', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'games');
  await addItem(page, '漫长的季节', 'movie', 'wish');

  const card = page.getByTestId('game-card', { hasText: '漫长的季节' });
  await expect(card).toContainText('影视');
  await expect(card).toContainText('想玩/想看');

  // 想玩筛选里有，在玩筛选里没有
  await page.getByTestId('games-filter-wish').click();
  await expect(card).toBeVisible();
  await page.getByTestId('games-filter-playing').click();
  await expect(page.getByTestId('game-card', { hasText: '漫长的季节' })).toHaveCount(0);

  // 改成"在玩/在看"后，在玩筛选里有，想玩筛选里没有
  await page.getByTestId('games-filter-all').click();
  await page.getByTestId('game-card', { hasText: '漫长的季节' }).click();
  await page.getByTestId('game-edit-status').selectOption('playing');
  await page.getByTestId('game-edit-save').click();
  await page.getByTestId('games-filter-playing').click();
  await expect(page.getByTestId('game-card', { hasText: '漫长的季节' })).toBeVisible();
  await page.getByTestId('games-filter-wish').click();
  await expect(page.getByTestId('game-card', { hasText: '漫长的季节' })).toHaveCount(0);
});

test('M8: 记 1.5 小时 —— 累计、本月合计、首页摘要同步；删记录后回退', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'games');
  await addItem(page, '塞尔达传说', 'game', 'playing');

  const card = page.getByTestId('game-card', { hasText: '塞尔达传说' });
  await card.getByTestId('log-time').click();
  await page.getByTestId('playlog-hours').fill('1.5');
  await page.getByTestId('playlog-note').fill('打了第一个神庙');
  await page.getByTestId('playlog-save').click();

  await expect(card).toContainText('累计 1.5h');
  await expect(page.getByTestId('games-month')).toContainText('本月娱乐 1.5h');

  // 首页摘要：在玩 1 + 最近游玩
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-games')).toContainText('在玩 1');
  await expect(page.getByTestId('summary-games')).toContainText('塞尔达传说');
  await expect(page.getByTestId('summary-games')).toContainText('1.5h');

  // 打开面板删除记录 → 累计与本月回退
  await openModule(page, 'games');
  await page.getByTestId('game-card', { hasText: '塞尔达传说' }).click();
  await expect(page.getByTestId('game-playlog-list')).toContainText('1.5h');
  const row = page.getByTestId('game-playlog-list').locator('.list-row');
  await row.hover();
  await row.getByTestId('playlog-del').click();
  await expect(page.getByTestId('game-playlog-list')).not.toContainText('1.5h');
  await page.getByTestId('panel-close').click();
  await expect(page.getByTestId('game-card', { hasText: '塞尔达传说' })).toContainText('累计 0h');
  await expect(page.getByTestId('games-month')).toContainText('本月娱乐 0h');
});

test('M8: 删除条目需要确认；取消不会删', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'games');
  await addItem(page, '要删的游戏');

  await page.getByTestId('game-card', { hasText: '要删的游戏' }).click();
  await page.getByTestId('game-entry-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await page.getByTestId('panel-close').click();
  await expect(page.getByTestId('game-card', { hasText: '要删的游戏' })).toBeVisible();

  await page.getByTestId('game-card', { hasText: '要删的游戏' }).click();
  await page.getByTestId('game-entry-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('game-card', { hasText: '要删的游戏' })).toHaveCount(0);
});
