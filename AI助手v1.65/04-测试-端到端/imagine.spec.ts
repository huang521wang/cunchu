import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData } from './helpers';

/** 起一个假聊天模型只为让 status.online=true（画图走的是智谱端点，不经这个模型） */
function stubModel(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"stub"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, close: () => srv.close() }));
  });
}

async function openChat(page: any, request: any, modelUrl: string) {
  await request.put('/api/settings', { data: { modelApi: { baseUrl: modelUrl, model: 'stub' } } });
  await page.goto('/');
  await expect(page.getByTestId('model-online')).toBeVisible({ timeout: 8000 });
}

test('显式 zhipu 通道无 Key：她明确教你怎么装（auto 默认则免 Key 直接画）', async ({ page, request }) => {
  await resetData(request);
  const stub = await stubModel();
  try {
    await openChat(page, request, stub.url);
    await request.put('/api/settings', { data: { imagineProvider: 'zhipu' } });
    await page.getByTestId('chat-input').fill('画：一只戴帽子的橘猫，水彩风');
    await page.getByTestId('chat-send').click();
    const answers = page.getByTestId('chat-answer');
    await expect(answers.last()).toContainText('Key', { timeout: 8000 });
  } finally {
    stub.close();
  }
});

test('对话里发「画图密钥：xxx」：存 Key 且不回显，回复确认', async ({ page, request }) => {
  await resetData(request);
  const stub = await stubModel();
  try {
    await openChat(page, request, stub.url);
    await page.getByTestId('chat-input').fill('画图密钥：' + 'a'.repeat(32) + '.' + 'b'.repeat(16));
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('收好', { timeout: 8000 });
    const s = await (await request.get('/api/settings')).json();
    expect(s.imagineKey).toBeUndefined();
    expect(s.imagineKeySet).toBe(true);
  } finally {
    stub.close();
  }
});

test('画图引擎：输入框旁不再有药丸按钮，改用对话命令切换并持久', async ({ page, request }) => {
  await resetData(request);
  const stub = await stubModel();
  try {
    await openChat(page, request, stub.url);
    await expect(page.getByTestId('draw-engine-switch')).toHaveCount(0); // 阿珑拍板：药丸按钮撤掉
    await expect(page.getByTestId('draw-engine-auto')).toHaveCount(0);
    await expect(page.getByTestId('draw-engine-zhipu')).toHaveCount(0);
    await expect(page.getByTestId('draw-engine-pollinations')).toHaveCount(0);
    await page.getByTestId('chat-input').fill('画图通道：智谱');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').last()).toContainText('通道设置好了', { timeout: 8000 });
    const s = await (await request.get('/api/settings')).json();
    expect(s.imagineProvider).toBe('zhipu');
    await page.reload();
    const s2 = await (await request.get('/api/settings')).json();
    expect(s2.imagineProvider).toBe('zhipu'); // 刷新后仍是智谱
  } finally {
    stub.close();
  }
});

test('模型菜单底部「画图引擎」段：三档可见，点⭐智谱锁档并持久', async ({ page, request }) => {
  await resetData(request);
  const stub = await stubModel();
  try {
    await openChat(page, request, stub.url);
    // 顶栏「AI 助手」旁的模型芯片 ▾ = 一键切换处，画图引擎段就在它菜单底部
    await page.getByTestId('model-online').click();
    await expect(page.getByTestId('model-menu')).toBeVisible();
    await expect(page.getByTestId('draw-engine-section')).toBeVisible();
    await expect(page.getByTestId('draw-engine-auto')).toBeVisible();
    await expect(page.getByTestId('draw-engine-zhipu')).toBeVisible();
    await expect(page.getByTestId('draw-engine-pollinations')).toBeVisible();
    await page.getByTestId('draw-engine-zhipu').click();
    const s = await (await request.get('/api/settings')).json();
    expect(s.imagineProvider).toBe('zhipu');
    // 重开菜单：使用中 ✓ 落在智谱行（持久+高亮）
    await page.reload();
    await page.getByTestId('model-online').click();
    await expect(page.getByTestId('draw-engine-zhipu')).toContainText('使用中', { timeout: 8000 });
  } finally {
    stub.close();
  }
});
