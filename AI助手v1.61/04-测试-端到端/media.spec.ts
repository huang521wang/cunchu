import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('M3: 在"待发布"列新建 → 卡片出现在该列', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-ready').fill('周报视频');
  await page.getByTestId('new-ready').press('Enter');
  await expect(page.getByTestId('col-ready')).toContainText('周报视频');
  await expect(page.getByTestId('col-ready')).toContainText('待发布 (1)');
});

test('M3: 卡片在列间移动，移到已发布后可追加数据并显示最新一次', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-ready').fill('周报视频');
  await page.getByTestId('new-ready').press('Enter');

  // 推进到已发布
  const card = page.getByTestId('col-ready').locator('.kcard', { hasText: '周报视频' });
  await card.hover();
  await card.getByTestId('move-next').click();
  await expect(page.getByTestId('col-published')).toContainText('周报视频');

  // 退回也可以工作（先退到待发布再推回来）
  const pubCard = page.getByTestId('col-published').locator('.kcard', { hasText: '周报视频' });
  await pubCard.hover();
  await pubCard.getByTestId('move-prev').click();
  await expect(page.getByTestId('col-ready')).toContainText('周报视频');
  await page.getByTestId('col-ready').locator('.kcard', { hasText: '周报视频' }).hover();
  await page.getByTestId('col-ready').locator('.kcard', { hasText: '周报视频' }).getByTestId('move-next').click();
  await expect(page.getByTestId('col-published')).toContainText('周报视频');

  // 打开编辑面板，追加一条发布数据
  await page.getByTestId('col-published').locator('.kcard', { hasText: '周报视频' }).click();
  await expect(page.getByTestId('content-panel')).toBeVisible();
  await page.getByTestId('stat-reads').fill('12000');
  await page.getByTestId('stat-likes').fill('230');
  await page.getByTestId('stat-comments').fill('15');
  await page.getByTestId('stat-add').click();
  await expect(page.getByTestId('stat-list')).toContainText('阅 12000');
  await expect(page.getByTestId('stat-list')).toContainText('❤ 230');

  // 再追加一条 → 卡片显示的是最新一条
  await page.getByTestId('stat-reads').fill('15000');
  await page.getByTestId('stat-likes').fill('260');
  await page.getByTestId('stat-comments').fill('18');
  await page.getByTestId('stat-add').click();
  await expect(page.getByTestId('stat-list').locator('.list-row')).toHaveCount(2);

  await page.getByTestId('panel-close').click();
  await expect(page.getByTestId('col-published').locator('.kcard', { hasText: '周报视频' })).toContainText('❤ 260');

  // 刷新后应用照常工作、数据不丢（工具箱会记住上次打开的模块）
  await page.reload();
  await expect(page.getByTestId('page-assistant')).toBeVisible();
  await openModule(page, 'media');
  await expect(page.getByTestId('col-published')).toContainText('周报视频');
  await expect(page.getByTestId('col-published').locator('.kcard', { hasText: '周报视频' })).toContainText('❤ 260');
});

test('M3: 编辑面板可改标题、平台、计划日期；卡片与提示同步', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-writing').fill('小红书笔记');
  await page.getByTestId('new-writing').press('Enter');
  await page.getByTestId('col-writing').locator('.kcard', { hasText: '小红书笔记' }).click();

  await page.getByTestId('content-platform').fill('小红书');
  await page.getByTestId('content-planned').fill('2026-10-20');
  await page.getByTestId('content-save').click();

  const card = page.getByTestId('col-writing').locator('.kcard', { hasText: '小红书笔记' });
  await expect(card).toContainText('小红书');
  await expect(card).toContainText('10/20');

  // 推进到待发布后，"下一条该发什么"提示出现
  await card.hover();
  await card.getByTestId('move-next').click();
  await expect(page.getByTestId('media-next-hint')).toContainText('小红书笔记');

  // 平台已被记住：新建打开面板时可以选到
  await page.getByTestId('col-published').scrollIntoViewIfNeeded();
  await page.getByTestId('new-ready').fill('另一条');
  await page.getByTestId('new-ready').press('Enter');
  await page.getByTestId('col-ready').locator('.kcard', { hasText: '另一条' }).click();
  // 平台已被服务端记住：datalist 里出现"小红书"这个可选项
  await expect(page.getByTestId('content-panel').locator('datalist option[value="小红书"]')).toHaveCount(1);
});

test('M3: 灵感转内容后出现在看板"想法"列', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('media-tab-ideas').click();
  await page.getByTestId('idea-input').fill('视频选题：效率工具');
  await page.getByTestId('idea-input').press('Enter');
  await expect(page.getByTestId('idea-list')).toContainText('效率工具');

  await page.getByTestId('idea-list').locator('.list-row', { hasText: '效率工具' }).getByTestId('idea-to-content').click();

  // 灵感库清空，看板"想法"列出现卡片
  await expect(page.getByTestId('idea-list')).not.toContainText('效率工具');
  await page.getByTestId('media-tab-board').click();
  await expect(page.getByTestId('col-idea')).toContainText('效率工具');
  await expect(page.getByTestId('col-idea')).toContainText('想法 (1)');
});

test('M3: 删除内容卡需要确认；点取消不会删', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-idea').fill('要删掉的选题');
  await page.getByTestId('new-idea').press('Enter');

  const card = page.getByTestId('col-idea').locator('.kcard', { hasText: '要删掉的选题' });
  await card.hover();
  await card.getByTestId('card-del').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('col-idea')).toContainText('要删掉的选题');

  await card.hover();
  await card.getByTestId('card-del').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('col-idea')).not.toContainText('要删掉的选题');
});

test('M3: 侧栏"待发布"徽标与看板一致，摘要卡同步更新', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'media');
  await page.getByTestId('new-ready').fill('待发内容A');
  await page.getByTestId('new-ready').press('Enter');
  await page.getByTestId('new-ready').fill('待发内容B');
  await page.getByTestId('new-ready').press('Enter');

  await openModule(page, 'media');
  await expect(page.getByTestId('badge-media')).toHaveText('2');

  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-media')).toContainText('待发布 2');
});
