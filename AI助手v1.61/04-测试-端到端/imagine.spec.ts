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

test('对话里发「画：xxx」：无 Key 时她明确教你怎么装 Key', async ({ page, request }) => {
  await resetData(request);
  const stub = await stubModel();
  try {
    await openChat(page, request, stub.url);
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
    await page.getByTestId('chat-input').fill('画图密钥：E2E-SECRET-KEY');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('收好', { timeout: 8000 });
    const s = await (await request.get('/api/settings')).json();
    expect(s.imagineKey).toBeUndefined();
    expect(s.imagineKeySet).toBe(true);
  } finally {
    stub.close();
  }
});
