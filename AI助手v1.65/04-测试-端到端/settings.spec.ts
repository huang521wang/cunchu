import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test('M10: 导出备份 → 清空（需输入口令）→ 恢复，数据完整回来且恢复前自动备份', async ({ page, request }) => {
  // 造数据
  await request.post('/api/tasks', {
    data: { title: '备份前任务', date: todayStr(), priority: 'high', done: false, doneAt: null },
  });
  await request.post('/api/memos', { data: { text: '备份前备忘' } });

  await page.goto('/');
  await openModule(page, 'settings');
  await expect(page.getByTestId('overview-tasks')).toContainText('1');

  // 导出
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-btn').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^工作台备份-\d{4}-\d{2}-\d{2}\.json$/);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();

  // 清空：不输入口令按钮不可用
  await page.getByTestId('wipe-btn').click();
  await expect(page.getByTestId('wipe-confirm')).toBeDisabled();
  await page.getByTestId('wipe-input').fill('清空');
  await page.getByTestId('wipe-confirm').click();

  // 数据都空了
  await expect(page.getByTestId('overview-tasks')).toContainText('0');
  await openModule(page, 'overview');
  await expect(page.getByTestId('home-todo-list')).not.toContainText('备份前任务');

  // 恢复
  await openModule(page, 'settings');
  await page.getByTestId('import-file').setInputFiles(filePath!);
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await expect(page.getByTestId('import-preview')).toContainText('任务 1');
  await expect(page.getByTestId('import-preview')).toContainText('备忘 1');
  await page.getByTestId('import-confirm').click();

  // 数据回来了
  await expect(page.getByTestId('overview-tasks')).toContainText('1');
  await openModule(page, 'overview');
  await expect(page.getByTestId('home-todo-list')).toContainText('备份前任务');
  await expect(page.getByTestId('memo-list')).toContainText('备份前备忘');

  // 清空前 + 恢复前都自动生成了备份（加上当日自动备份，至少 2 份 before-*）
  const meta = await (await request.get('/api/meta')).json();
  expect(meta.backupCount).toBeGreaterThanOrEqual(2);
});

test('M10: 无效备份文件被拒绝并提示', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'settings');
  await page.getByTestId('import-file').setInputFiles({
    name: 'fake.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
  });
  await expect(page.getByTestId('import-error')).toContainText('不是工作台的备份文件');
  await expect(page.getByTestId('import-preview')).toHaveCount(0);
});

test('M10: 深浅色切换立即生效并持久化', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'settings');

  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await openModule(page, 'settings');
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('M10: 数据位置与文件信息可见', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'settings');
  await expect(page.getByTestId('data-location')).toContainText('.e2e-data');
  await expect(page.getByTestId('data-location')).toContainText('KB');
  await expect(page.getByTestId('data-location')).toContainText('备份');
});

test('提醒简报：设置页能看到"今天要干什么"的预览（给 QQ 机器人/邮箱用）', async ({ page, request }) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ds = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const tmr = new Date();
  tmr.setDate(tmr.getDate() + 1);

  await request.post('/api/tasks', {
    data: {
      title: '交方案',
      date: ds(new Date()),
      time: '',
      estimate: '',
      note: '',
      priority: 'none',
      done: false,
      doneAt: null,
    },
  });
  await request.post('/api/studyItems', {
    data: {
      title: '第三章课后习题',
      course: '高等数学',
      kind: '作业',
      due: ds(tmr),
      done: false,
      doneAt: null,
    },
  });

  await page.goto('/');
  await openModule(page, 'settings');
  const preview = page.getByTestId('briefing-preview');
  await expect(preview).toContainText('工作台日报');
  await expect(preview).toContainText('今日任务');
  await expect(preview).toContainText('交方案');
  await expect(preview).toContainText('明天截止：第三章课后习题（高等数学）');
});

test('我的模型：设置页能看到聊天/视觉/语音三件套状态', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'settings');
  await expect(page.getByTestId('local-models')).toBeVisible();
  await expect(page.getByTestId('local-chat')).toContainText('DeepSeek-R1-7B');
  await expect(page.getByTestId('local-vision')).toContainText('视觉');
  await expect(page.getByTestId('local-vision').locator('.model-note')).toContainText('看');
  await expect(page.getByTestId('local-whisper')).toContainText('语音');
  // 傻瓜式开关：每行都有大开关和状态徽标（只看不点——不能碰真机模型）
  await expect(page.getByTestId('local-switch-chat')).toBeVisible();
  await expect(page.getByTestId('local-switch-vision')).toBeVisible();
  await expect(page.getByTestId('local-status-chat')).toBeVisible();
  await expect(page.getByTestId('local-status-vision')).toBeVisible();
});
