import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

// 1x1 红色像素的合法 PNG
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('她：柳月虹住在助手页顶部，有名字、状态和心事本', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  const card = page.getByTestId('persona-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('柳月虹');
  await expect(page.getByTestId('persona-status')).toBeVisible();

  // 心事本：打开看到（空状态或列表）
  await page.getByTestId('persona-thoughts').click();
  await expect(page.getByTestId('persona-thoughts-modal')).toBeVisible();
  await page.getByTestId('persona-thoughts-modal').getByRole('button', { name: '关闭' }).click();
  await expect(page.getByTestId('persona-thoughts-modal')).toHaveCount(0);
});

test('发图给柳月虹：消息里带上像素印象，她照常回答', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"我还没有真正的眼睛，不过这张小小的红色，让我想起糖纸～"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await request.put('/api/settings', {
      data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-r1' } },
    });
    await page.goto('/');
    await page.getByTestId('page-assistant').waitFor();
    await expect(page.getByTestId('model-online')).toBeVisible();

    await page.getByTestId('chat-image-input').setInputFiles({
      name: '小图.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    await expect(page.getByTestId('chat-image-preview')).toContainText('小图.png');

    await page.getByTestId('chat-send').click();
    const q = page.getByTestId('chat-question').first();
    await expect(q).toContainText('主色调');
    await expect(q).toContainText('1×1');
    await expect(q).toContainText('还没有真正的眼睛');

    // 图片本身显示在气泡里（缩略图 + 文件名），点开能看原图
    await expect(q.locator('img.chat-img')).toBeVisible();
    await expect(q.locator('img.chat-img')).toHaveAttribute('src', /\/files\/.+\.png$/);
    await expect(q.locator('.chat-img-name')).toContainText('小图.png');

    await expect(page.getByTestId('chat-answer').first()).toContainText('糖纸');

    // 图片也进了素材柜
    const files = await (await request.get('/api/files')).json();
    expect(files.some((f: any) => f.name === '小图.png' && f.kind === 'image')).toBeTruthy();
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('设置页「她」卡片：改名/补充性格/清空梦记/重新开始', async ({ page, request }) => {
  await page.goto('/');
  await openModule(page, 'settings');
  await expect(page.getByTestId('persona-settings')).toBeVisible();
  await expect(page.getByTestId('persona-settings')).toContainText('柳月虹');

  // 改名（blur 保存）
  await page.getByTestId('persona-name-input').fill('月虹');
  await page.getByTestId('persona-name-input').blur();
  await expect
    .poll(async () => (await (await request.get('/api/persona')).json()).persona.name)
    .toBe('月虹');

  // 手动补充一条性格
  await page.getByTestId('persona-trait-input').fill('说话喜欢带小小的比喻');
  await page.getByTestId('persona-trait-add').click();
  await expect(page.getByTestId('persona-trait-0')).toContainText('比喻');
  let p = (await (await request.get('/api/persona')).json()).persona;
  expect(p.traits[0].source).toBe('manual');

  // 放一场梦进去再清空
  await request.put('/api/persona', {
    data: { dreams: [{ at: new Date().toISOString(), text: '梦见云朵排队', type: '奇怪' }] },
  });
  await page.reload();
  await openModule(page, 'settings');
  await expect(page.getByTestId('persona-settings')).toContainText('梦见云朵排队');
  await page.getByTestId('persona-dreams-clear').click();
  p = (await (await request.get('/api/persona')).json()).persona;
  expect(p.dreams.length).toBe(0);

  // 重新开始：性格清空
  await page.getByTestId('persona-reset').click();
  p = (await (await request.get('/api/persona')).json()).persona;
  expect(p.traits.length).toBe(0);
});
