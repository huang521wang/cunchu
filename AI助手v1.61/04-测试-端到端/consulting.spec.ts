import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

async function createClient(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await openModule(page, 'consulting');
  await page.getByTestId('new-client').fill(name);
  await page.getByTestId('new-client').press('Enter');
  await expect(page.getByTestId('client-list')).toContainText(name);
  await expect(page.getByTestId('client-name')).toHaveValue(name);
}

test('M5: 计时器开始/停止自动生成记录，浏览器标题显示计时中', async ({ page }) => {
  await createClient(page, 'A 公司');
  await page.getByTestId('tab-time').click();

  await expect(page.getByTestId('timer-display')).toHaveText('00:00:00');
  await page.getByTestId('timer-toggle').click();
  // 计时中：显示在走的时间，浏览器标签标题带 ⏱
  await expect(page.getByTestId('timer-display')).not.toHaveText('00:00:00');
  await expect(page).toHaveTitle(/⏱/);

  await page.waitForTimeout(2200);
  await page.getByTestId('timer-toggle').click();

  // 停止后：自动生成一条"计时"来源的记录；标题恢复
  await expect(page.getByTestId('time-list')).toContainText('计时');
  await expect(page).toHaveTitle('AI 助手');
  await expect(page.getByTestId('timer-display')).toHaveText('00:00:00');
});

test('M5: 手动记工时、本周/本月合计；删除后合计回退；首页摘要同步', async ({ page }) => {
  await createClient(page, 'B 公司');
  await page.getByTestId('tab-time').click();

  await page.getByTestId('time-manual-hours').fill('1.5');
  await page.getByTestId('time-manual-note').fill('需求沟通');
  await page.getByTestId('time-manual-add').click();
  await expect(page.getByTestId('time-list')).toContainText('1.5h');
  await expect(page.getByTestId('time-list')).toContainText('需求沟通');

  await page.getByTestId('time-manual-hours').fill('2');
  await page.getByTestId('time-manual-add').click();
  await expect(page.getByTestId('time-list').locator('.list-row')).toHaveCount(2);

  await expect(page.getByTestId('time-totals')).toContainText('本月 3.5h');
  await expect(page.getByTestId('month-total')).toContainText('本月总工时 3.5h');
  // 左栏客户行显示本月工时
  await expect(page.getByTestId('client-row').first()).toContainText('3.5h');

  // 首页摘要同步
  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-consulting')).toContainText('本月 3.5h');

  // 删除一条 → 合计回退（回到咨询页后需重新切到"工时"页签）
  await openModule(page, 'consulting');
  await page.getByTestId('tab-time').click();
  const row = page.getByTestId('time-list').locator('.list-row', { hasText: '2h' });
  await row.hover();
  await row.getByTestId('time-del').click();
  await expect(page.getByTestId('time-totals')).toContainText('本月 1.5h');
});

test('M5: 跟进事项 —— 逾期标红、勾选完成、编辑与删除', async ({ page }) => {
  await createClient(page, 'C 公司');

  await page.getByTestId('followup-input').fill('交初版方案');
  await page.getByTestId('followup-date').fill('2020-01-01');
  await page.getByTestId('followup-input').press('Enter');

  const row = page.getByTestId('followup-list').locator('.list-row', { hasText: '交初版方案' });
  await expect(row).toBeVisible();
  // 逾期标红：日期 chip 带 text-danger
  await expect(row.locator('.chip.text-danger')).toContainText('已逾期');

  // 勾选完成后不再标红
  await row.locator('.checkbox').click();
  await expect(row.locator('.done-text')).toBeVisible();
  await expect(row.locator('.chip.text-danger')).toHaveCount(0);

  // 编辑
  await row.locator('.row-main').click();
  const editor = page.getByTestId('followup-list').locator('input');
  await editor.fill('交第二版方案');
  await editor.press('Enter');
  await expect(page.getByTestId('followup-list')).toContainText('交第二版方案');

  // 删除
  const row2 = page.getByTestId('followup-list').locator('.list-row', { hasText: '交第二版方案' });
  await row2.hover();
  await row2.getByTestId('followup-del').click();
  await expect(page.getByTestId('followup-list')).not.toContainText('交第二版方案');
});

test('M5: 沟通记录增删；首页摘要显示最近待跟进', async ({ page }) => {
  await createClient(page, 'D 公司');
  await page.getByTestId('tab-commlogs').click();
  await page.getByTestId('commlog-input').fill('聊了官网需求');
  await page.getByTestId('commlog-input').press('Enter');
  await expect(page.getByTestId('commlog-list')).toContainText('聊了官网需求');

  await page.getByTestId('tab-followups').click();
  await page.getByTestId('followup-input').fill('下周约复盘会');
  await page.getByTestId('followup-input').press('Enter');

  await openModule(page, 'overview');
  await expect(page.getByTestId('summary-consulting')).toContainText('下周约复盘会');

  // 删除沟通记录
  await openModule(page, 'consulting');
  await page.getByTestId('tab-commlogs').click();
  const row = page.getByTestId('commlog-list').locator('.list-row', { hasText: '聊了官网需求' });
  await row.hover();
  await row.getByTestId('commlog-del').click();
  await expect(page.getByTestId('commlog-list')).not.toContainText('聊了官网需求');
});

test('M5: 删除客户需要确认，并连带清掉其记录', async ({ page, request }) => {
  await createClient(page, 'E 公司');
  await page.getByTestId('followup-input').fill('跟进事项');
  await page.getByTestId('followup-input').press('Enter');
  await page.getByTestId('tab-time').click();
  await page.getByTestId('time-manual-hours').fill('1');
  await page.getByTestId('time-manual-add').click();

  await page.getByTestId('client-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('client-list')).not.toContainText('E 公司');
  await expect(page.getByTestId('consulting-empty')).toBeVisible();

  expect(await (await request.get('/api/followUps')).json()).toHaveLength(0);
  expect(await (await request.get('/api/timeEntries')).json()).toHaveLength(0);
});
