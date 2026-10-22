import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('AI 模型：设置页管理列表 + 助手页小下拉切换', async ({ page, request }) => {
  // 第二个模型用一个真实桩服务（在线），方便看状态点
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-2' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"第二个模型的回答"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await page.goto('/');
    await openModule(page, 'settings');
    await expect(page.getByTestId('models-card')).toBeVisible();

    // 默认模型在列表里，且是"当前"
    await expect(page.getByTestId('model-row-local-r1-7b')).toBeVisible();
    await expect(page.getByTestId('model-active-local-r1-7b')).toContainText('当前');

    // 添加第二个模型
    await page.getByTestId('model-add').click();
    await page.getByTestId('model-form-name').fill('本机 · 测试小模型');
    await page.getByTestId('model-form-url').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId('model-form-model').fill('stub-2');
    await page.getByTestId('model-form-save').click();
    await expect(page.getByTestId('models-card')).toContainText('本机 · 测试小模型');

    const settings = await (await request.get('/api/settings')).json();
    expect(settings.models.length).toBe(2);
    const newId = settings.models.find((m: any) => m.model === 'stub-2').id;

    // 新模型的状态点是"在线"（绿）
    await expect(page.getByTestId(`model-dot-${newId}`)).toHaveClass(/on/, { timeout: 12000 });

    // 设为当前
    await page.getByTestId(`model-use-${newId}`).click();
    await expect(page.getByTestId(`model-active-${newId}`)).toContainText('当前');

    // 助手页：小标签显示当前模型（友好名）
    await page.getByTestId('page-assistant').waitFor();
    await expect(page.getByTestId('model-online')).toContainText('本机 · 测试小模型');

    // 再加一条"必然没人监听"的模型（不依赖本机是否真开着模型）
    const deadId = 'dead-model';
    await request.put('/api/settings', {
      data: {
        models: [
          ...settings.models,
          { id: deadId, name: '本机 · 没人听', type: 'local', baseUrl: 'http://127.0.0.1:59986/v1', model: 'none' },
        ],
      },
    });

    // 打开切换菜单：默认单模型模式，点"没人听"直接切换 → 标签变"模型未启动"，菜单收起
    await page.getByTestId('model-online').click();
    await expect(page.getByTestId('model-menu')).toBeVisible();
    await expect(page.getByTestId('model-check-local-r1-7b')).toBeVisible();
    await expect(page.getByTestId(`model-check-${newId}`)).toBeVisible();
    await expect(page.getByTestId(`model-check-${deadId}`)).toBeVisible();
    await page.getByTestId(`model-check-${deadId}`).click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已切换到这个模型');
    await expect(page.getByTestId('model-offline')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('model-menu')).toHaveCount(0);
    const s2 = await (await request.get('/api/settings')).json();
    expect(s2.activeModelId).toBe(deadId);
    expect(s2.autoRoute).toBe(false);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('外接模型：服务商预设 + 测试连接 + 拉取模型名', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await page.goto('/');
    await openModule(page, 'settings');
    await page.getByTestId('model-add').click();
    await expect(page.getByTestId('model-modal')).toBeVisible();

    // 选"DeepSeek 官方 API"预设：地址和类型自动填好（离线安全，不真的请求它）
    await page.getByTestId('model-form-preset').selectOption('deepseek');
    await expect(page.getByTestId('model-form-url')).toHaveValue('https://api.deepseek.com/v1');
    await expect(page.getByTestId('model-form-model')).toHaveValue('deepseek-chat');
    await expect(page.getByTestId('model-form-key')).toBeVisible();

    // 换成测试桩地址，测一次"连接"：成功 + 拉到模型名可选
    await page.getByTestId('model-form-name').fill('外接 · 测试');
    await page.getByTestId('model-form-url').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId('model-form-test').click();
    await expect(page.getByTestId('model-form-test-result')).toContainText('连接成功', { timeout: 10000 });
    await page.getByTestId('model-form-models').selectOption('deepseek-reasoner');
    await expect(page.getByTestId('model-form-model')).toHaveValue('deepseek-reasoner');

    // 保存后进入列表
    await page.getByTestId('model-form-save').click();
    await expect(page.getByTestId('models-card')).toContainText('外接 · 测试');
    const s = await (await request.get('/api/settings')).json();
    const added = s.models.find((m: any) => m.name === '外接 · 测试');
    expect(added.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    expect(added.model).toBe('deepseek-reasoner');

    // 连不上的情况给出人话提示
    await page.getByTestId(`model-edit-${added.id}`).click();
    await page.getByTestId('model-form-url').fill('http://127.0.0.1:59986/v1');
    await page.getByTestId('model-form-test').click();
    await expect(page.getByTestId('model-form-test-result')).toContainText('连不上', { timeout: 15000 });
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
