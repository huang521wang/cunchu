import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

// 假桌面捕获：Chromium 用假视频流 + 自动选整个屏幕
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'],
  },
});

test('屏幕助手：开关→记录→结束→整理清单→确认入账', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      }
      const body = JSON.parse(raw || '{}');
      const sys = ((body.messages || []).find((m) => m.role === 'system') || {}).content || '';
      if (sys.includes('整理助手')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: '任务|交实验报告 明天\n学习|第三章课后习题 10-20\n记忆|老师的邮箱是 math@school.edu.cn' } }],
          }),
        );
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await request.put('/api/settings', {
      data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub' } },
    });
    await page.goto('/');
    await page.getByTestId('page-assistant').waitFor();
    await openModule(page, 'screen');
    await expect(page.getByTestId('screen-tab')).toBeVisible();

    // 默认关
    await expect(page.getByTestId('screen-toggle')).not.toBeChecked();

    // 打开 → 开始记录（假屏幕流）
    await page.getByTestId('screen-toggle').check();
    await page.getByTestId('screen-start').click();
    await expect(page.getByTestId('screen-status')).toContainText('正在记录', { timeout: 15000 });

    // 结束 → 整理出清单
    await page.getByTestId('screen-end').click();
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('screen-item-0')).toBeVisible();
    const items = page.getByTestId(/^screen-item-\d+$/);
    await expect(items).toHaveCount(3);

    // 确认第一条（任务，带日期）
    await page.getByTestId('screen-item-ok-0').click();
    await expect(page.getByTestId('screen-toast')).toContainText('已记入任务');
    const tasks = await (await request.get('/api/tasks')).json();
    expect(tasks.some((t: any) => t.title === '交实验报告 明天')).toBeTruthy();

    // 跳过第二条，确认第三条（记忆 → 记忆树）
    await page.getByTestId('screen-item-skip-1').click();
    await page.getByTestId('screen-item-ok-2').click();
    const memories = await (await request.get('/api/memories')).json();
    expect(memories.some((m: any) => m.text === '老师的邮箱是 math@school.edu.cn')).toBeTruthy();

    // 关掉开关 = 清理状态
    await page.getByTestId('screen-toggle').uncheck();
    await expect(page.getByTestId('screen-off')).toBeVisible();
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
