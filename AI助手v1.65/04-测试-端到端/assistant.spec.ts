import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('M9: 模型未启动时给出引导，输入禁用；重新检测可用', async ({ page, request }) => {
  // 指向一个必然没人监听的端口，保证这条测试不依赖本机是否真开着模型
  await request.put('/api/settings', {
    data: { modelApi: { baseUrl: 'http://127.0.0.1:59986/v1', model: 'x' } },
  });
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  await expect(page.getByTestId('model-offline')).toBeVisible();
  await expect(page.getByTestId('chat-offline')).toContainText('启动模型');
  // 离线时不出现输入框，只给引导
  await expect(page.getByTestId('chat-input')).toHaveCount(0);

  await page.getByTestId('retry-status').click();
  await expect(page.getByTestId('model-offline')).toBeVisible();
});

test('M9: 连上模型服务后可以对话（用桩服务模拟流式回复）', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"让我想想…"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"呀，我是本地模型"}}]}\n\n');
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
    await expect(page.getByTestId('model-online')).toContainText('DeepSeek-R1-7B');

    await page.getByTestId('chat-input').fill('你好');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-question').first()).toContainText('你好');
    const answer = page.getByTestId('chat-answer').first();
    await expect(answer).toContainText('你好呀，我是本地模型');
    await expect(answer.locator('details.think')).toContainText('让我想想…');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('M9: 8 个快捷操作都能一步记入对应模块', async ({ page, request }) => {
  // 预置：客户（记工时要用）+ 游戏条目（记时长要用）
  await request.post('/api/clients', { data: { name: '测试客户', note: '' } });
  await request.post('/api/gameItems', {
    data: { name: '测试游戏', category: 'game', status: 'playing', progressNote: '' },
  });

  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  const toast = page.getByTestId('assistant-toast');

  // 1. 加任务（带优先级），并用"去看看"跳转验证
  await page.getByTestId('quick-task').click();
  await page.getByTestId('q-task-title').fill('快捷加的任务');
  await page.getByTestId('q-task-priority').selectOption('high');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入今日计划');
  await toast.getByRole('button', { name: '去看看' }).click();
  await expect(page.getByTestId('page-today')).toBeVisible();
  await expect(page.getByTestId('today-task-list')).toContainText('快捷加的任务');

  // 2. 记备忘
  await page.getByTestId('page-assistant').waitFor();
  await page.getByTestId('quick-memo').click();
  await page.getByTestId('q-memo-text').fill('快捷记的备忘');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入快速备忘');

  // 3. 健身打卡
  await page.getByTestId('quick-workout').click();
  await page.getByTestId('q-workout-note').fill('快捷打卡');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入健身计划');

  // 4. 记体重
  await page.getByTestId('quick-weight').click();
  await page.getByTestId('q-weight').fill('70.5');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入健身计划');

  // 5. 记工时
  await page.getByTestId('quick-hours').click();
  await page.getByTestId('q-hours-client').selectOption({ label: '测试客户' });
  await page.getByTestId('q-hours-hours').fill('2');
  await page.getByTestId('q-hours-note').fill('快捷记的工时');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入咨询工作');

  // 6. 加自媒体想法
  await page.getByTestId('quick-idea').click();
  await page.getByTestId('q-idea-text').fill('快捷记的灵感');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入自媒体灵感库');

  // 7. 记饮食（午餐）
  await page.getByTestId('quick-meal').click();
  await page.getByTestId('q-meal-slot').selectOption('lunch');
  await page.getByTestId('q-meal-text').fill('快捷记的午餐');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入饮食计划');

  // 8. 记游戏时长
  await page.getByTestId('quick-playtime').click();
  await page.getByTestId('q-playtime-item').selectOption({ label: '测试游戏' });
  await page.getByTestId('q-playtime-hours').fill('1.5');
  await page.getByTestId('q-save').click();
  await expect(toast).toContainText('已记入游戏娱乐');

  // 所有数据都真的写进了对应模块
  const tasks = await (await request.get('/api/tasks')).json();
  expect(tasks.some((x: any) => x.title === '快捷加的任务' && x.priority === 'high')).toBeTruthy();
  const memos = await (await request.get('/api/memos')).json();
  expect(memos.some((x: any) => x.text === '快捷记的备忘')).toBeTruthy();
  const workouts = await (await request.get('/api/workoutLogs')).json();
  expect(workouts.some((x: any) => x.note === '快捷打卡')).toBeTruthy();
  const weights = await (await request.get('/api/weightLogs')).json();
  expect(weights.some((x: any) => x.weight === 70.5)).toBeTruthy();
  const entries = await (await request.get('/api/timeEntries')).json();
  expect(entries.some((x: any) => x.hours === 2 && x.note === '快捷记的工时')).toBeTruthy();
  const ideas = await (await request.get('/api/ideas')).json();
  expect(ideas.some((x: any) => x.text === '快捷记的灵感')).toBeTruthy();
  const meals = await (await request.get('/api/mealDays')).json();
  expect(meals.some((x: any) => (x.lunch || '').includes('快捷记的午餐'))).toBeTruthy();
  const playlogs = await (await request.get('/api/playLogs')).json();
  expect(playlogs.some((x: any) => x.hours === 1.5)).toBeTruthy();
});

test('文档与素材：上传图片/文本文件、文本发给 AI 读、回答存为文档', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好的，我看完了"}}]}\n\n');
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

    // ① 上传一张图片（1x1 PNG）和一个文本文件
    await openModule(page, 'materials');
    await expect(page.getByTestId('asset-box')).toBeVisible();
    await page.getByTestId('asset-upload').setInputFiles({
      name: '截图.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await page.getByTestId('asset-upload').setInputFiles({
      name: '笔记.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('笔记内容：重点在第三章。'),
    });
    await expect(page.getByTestId('asset-list').locator('.asset-row')).toHaveCount(2);
    const files = await (await request.get('/api/files')).json();
    expect(files.length).toBe(2);
    const img = files.find((f: any) => f.kind === 'image');
    const txt = files.find((f: any) => f.kind === 'text');
    expect(img.name).toBe('截图.png');
    await expect(page.getByTestId(`asset-thumb-${img.id}`)).toBeVisible(); // 图片有缩略图

    // ② 文本文件「发给 AI 读」→ 自动切回对话并发消息、拿到回复
    await page.getByTestId(`asset-read-${txt.id}`).click();
    await expect(page.getByTestId('chat-question').last()).toContainText('重点在第三章');
    await expect(page.getByTestId('chat-answer').last()).toContainText('好的，我看完了');

    // ③ 把 AI 的回答存为文档
    await page.getByTestId('make-doc-1').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已存为文档');
    await page.getByTestId('assistant-toast').getByRole('button', { name: '去看看' }).click();
    await expect(page.getByTestId('doc-list')).toContainText('好的，我看完了');

    // ④ 手写新建 + 展开查看 + 删除
    await page.getByTestId('doc-new').click();
    await page.getByTestId('doc-title-input').fill('我的笔记');
    await page.getByTestId('doc-body-input').fill('第一行\n第二行');
    await page.getByTestId('doc-save').click();
    await expect(page.getByTestId('doc-list')).toContainText('我的笔记');
    const docs = await (await request.get('/api/documents')).json();
    expect(docs.length).toBe(2);
    const manual = docs.find((d: any) => d.title === '我的笔记');
    expect(manual.source).toBe('manual');
    await page.getByTestId(`doc-open-${manual.id}`).click();
    await expect(page.getByTestId(`doc-content-${manual.id}`)).toContainText('第二行');

    // ⑤ 删除素材和文档
    await page.getByTestId(`asset-del-${img.id}`).click();
    await expect(page.getByTestId('asset-list').locator('.asset-row')).toHaveCount(1);
    await page.getByTestId(`doc-del-${manual.id}`).click();
    await expect(page.getByTestId('doc-list').locator('.doc-row')).toHaveCount(1);
    const left = await (await request.get('/api/files')).json();
    expect(left.length).toBe(1);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('多选模型：开启多选模式勾两个聊天模型 → 提示共用显卡位；可重新选择或确定继续', async ({ page, request }) => {
  // 两个聊天模型（8080/8081 端口 => slot=chat，共用一个显卡位）；默认单模型模式
  await request.put('/api/settings', {
    data: {
      models: [
        { id: 'local-r1-7b', name: 'DeepSeek-R1-7B', type: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'r1', note: '深度思考 · 数学/逻辑/推理题' },
        { id: 'qwen-7b', name: '千问 7B', type: 'local', baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen', note: '日常聊天 · 快' },
      ],
      selectedModels: [],
      autoRoute: false,
    },
  });
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  // 芯片可能在线也可能离线（取决于真机是否恰好跑着 8080 的模型）——用任意状态打开菜单
  await page.locator('[data-testid="model-online"], [data-testid="model-offline"], [data-testid="model-warming"]').first().click();
  await expect(page.getByTestId('model-menu')).toBeVisible();
  await expect(page.getByTestId('model-check-local-r1-7b')).toBeVisible();
  // 作用备注显示在菜单里
  await expect(page.getByTestId('model-check-local-r1-7b').locator('.model-note')).toContainText('数学');
  await expect(page.getByTestId('model-check-qwen-7b').locator('.model-note')).toContainText('日常聊天');
  await expect(page.getByTestId('model-check-qwen-7b')).toBeVisible();
  // 打开「多选模式」开关 → 变成勾选列表（默认全勾）+ 确定按钮
  await page.getByTestId('model-multi-toggle').click();
  await expect(page.getByTestId('model-confirm')).toBeVisible();
  // 两个聊天模型都勾着 → 确定 → 弹"共用显卡位"提示
  await page.getByTestId('model-confirm').click();
  await expect(page.getByTestId('model-conflict')).toBeVisible();
  await expect(page.getByTestId('model-conflict')).toContainText('显卡');
  // 重新选择 → 提示消失，还能改
  await page.getByTestId('model-reselect').click();
  await expect(page.getByTestId('model-conflict')).toHaveCount(0);
  // 再确定并"确定继续" → 保存两个模型的多选池
  await page.getByTestId('model-confirm').click();
  await page.getByTestId('model-confirm-ok').click();
  await expect(page.getByTestId('model-menu')).toHaveCount(0);
  const s = await (await request.get('/api/settings')).json();
  expect(s.autoRoute).toBe(true);
  expect(s.selectedModels.sort()).toEqual(['local-r1-7b', 'qwen-7b']);
});
