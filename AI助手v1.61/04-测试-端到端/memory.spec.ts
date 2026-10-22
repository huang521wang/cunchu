import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

async function openMemoryTab(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  await openModule(page, 'memory');
  await expect(page.getByTestId('memory-tree')).toBeVisible();
}

test('记忆树：添加/编辑/置顶/搜索/删除，刷新后还在', async ({ page }) => {
  await openMemoryTab(page);
  await expect(page.getByTestId('tree-stat')).toContainText('记住了 0 件事');

  // 默认在「关于我」枝上添加
  await page.getByTestId('memory-input').fill('叫阿珑，住在成都');
  await page.getByTestId('memory-input').press('Enter');
  await expect(page.getByTestId('memory-list')).toContainText('叫阿珑，住在成都');
  await expect(page.getByTestId('tree-stat')).toContainText('记住了 1 件事');
  await expect(page.getByTestId('branch-label-about')).toContainText('关于我 · 1');

  // 切到「工作」枝再添加
  await page.getByTestId('branch-chip-work').click();
  await expect(page.getByTestId('branch-title')).toContainText('工作');
  await page.getByTestId('memory-input').fill('在做小程序项目');
  await page.getByTestId('memory-input').press('Enter');
  await expect(page.getByTestId('branch-count')).toContainText('1 条');
  await expect(page.getByTestId('branch-label-work')).toContainText('工作 · 1');

  // 回到「关于我」编辑 + 置顶
  await page.getByTestId('branch-chip-about').click();
  const card = page.getByTestId('memory-list').locator('.memory-card', { hasText: '叫阿珑' });
  await card.locator('.text').click();
  // 编辑态下卡片里是输入框（文字不再是文本内容），直接按列表范围找
  const editor = page.getByTestId('memory-list').locator('input');
  await editor.fill('叫阿珑，住在成都南边');
  await editor.press('Enter');
  await expect(page.getByTestId('memory-list')).toContainText('住在成都南边');

  await card.locator('[data-testid^="memory-pin-"]').click();
  await expect(page.getByTestId('memory-list').locator('.memory-card', { hasText: '叫阿珑' })).toHaveClass(/pinned/);

  // 再加一条，搜索只显示匹配的
  await page.getByTestId('memory-input').fill('早上习惯写代码');
  await page.getByTestId('memory-input').press('Enter');
  await expect(page.getByTestId('memory-list').locator('.memory-card')).toHaveCount(2);
  await page.getByTestId('memory-search').fill('代码');
  await expect(page.getByTestId('memory-list').locator('.memory-card')).toHaveCount(1);
  await page.getByTestId('memory-search').fill('');

  // 删除第二条
  const second = page.getByTestId('memory-list').locator('.memory-card', { hasText: '写代码' });
  await second.hover();
  await second.locator('[data-testid^="memory-del-"]').click();
  await expect(page.getByTestId('memory-list').locator('.memory-card')).toHaveCount(1);

  // 刷新后还在，置顶状态也保留
  await openMemoryTab(page);
  await expect(page.getByTestId('tree-stat')).toContainText('记住了 2 件事');
  await expect(page.getByTestId('memory-list')).toContainText('住在成都南边');
  await expect(page.getByTestId('memory-list').locator('.memory-card.pinned')).toHaveCount(1);
});

test('记忆树：对话里说"记住"→ 确认卡 → 入树（用桩模型）', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好的，我会记住的"}}]}\n\n');
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

    await page.getByTestId('chat-input').fill('记住：我周末不接工作电话');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').first()).toContainText('好的');

    // 确认卡出现，且已把"记住："前缀去掉
    await expect(page.getByTestId('memory-confirm')).toBeVisible();
    await expect(page.getByTestId('memory-confirm-text')).toHaveText('我周末不接工作电话');

    await page.getByTestId('memory-branch').selectOption('preference');
    await page.getByTestId('memory-save').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已记入记忆树');

    // 去看看 → 跳到记忆树，偏好枝上能看到
    await page.getByTestId('assistant-toast').getByRole('button', { name: '去看看' }).click();
    await expect(page.getByTestId('memory-tree')).toBeVisible();
    await page.getByTestId('branch-chip-preference').click();
    await expect(page.getByTestId('memory-list')).toContainText('我周末不接工作电话');

    // 数据也真的进了 memories 集合
    const memories = await (await request.get('/api/memories')).json();
    expect(memories.some((m: any) => m.branch === 'preference' && m.text === '我周末不接工作电话')).toBeTruthy();
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('对话里让它记录：加任务 / 记体重 / 备忘 → 确认执行后真的入账', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好的"}}]}\n\n');
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

    // ① 加任务 → 确认 → 真的进今日计划
    await page.getByTestId('chat-input').fill('加任务：明天交方案');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('action-confirm')).toBeVisible();
    await expect(page.getByTestId('action-confirm-text')).toContainText('明天交方案');
    await page.getByTestId('action-confirm-ok').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已记入今日计划');
    const tasks = await (await request.get('/api/tasks')).json();
    expect(tasks.some((t: any) => t.title === '明天交方案')).toBeTruthy();

    // ② 记体重 → 入健身
    await page.getByTestId('chat-input').fill('记体重：55.5');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('action-confirm-text')).toContainText('55.5');
    await page.getByTestId('action-confirm-ok').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已记入健身计划');
    const weights = await (await request.get('/api/weightLogs')).json();
    expect(weights.some((w: any) => w.weight === 55.5)).toBeTruthy();

    // ③ 备忘 → 入快速备忘
    await page.getByTestId('chat-input').fill('备忘：买牛奶');
    await page.getByTestId('chat-input').press('Enter');
    await page.getByTestId('action-confirm-ok').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已记入快速备忘');
    const memos = await (await request.get('/api/memos')).json();
    expect(memos.some((m: any) => m.text === '买牛奶')).toBeTruthy();

    // ④ 点"取消"则什么都不写
    await page.getByTestId('chat-input').fill('加任务：这条不要');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('action-confirm')).toBeVisible();
    await page.getByTestId('action-cancel').click();
    const tasks2 = await (await request.get('/api/tasks')).json();
    expect(tasks2.some((t: any) => t.title === '这条不要')).toBe(false);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('记忆树：🍃 按钮把回答收藏进树；设置里可关闭记忆', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"建议用番茄钟试试"}}]}\n\n');
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
    await page.getByTestId('chat-input').fill('怎么提高专注力');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').first()).toContainText('番茄钟');

    await page.getByTestId('leaf-1').click();
    await expect(page.getByTestId('memory-confirm-text')).toHaveText('建议用番茄钟试试');
    await page.getByTestId('memory-save').click();
    const memories = await (await request.get('/api/memories')).json();
    expect(memories.some((m: any) => m.source === 'chat' && m.text.includes('番茄钟'))).toBeTruthy();

    // 设置页开关存在且可关
    await openModule(page, 'settings');
    await expect(page.getByTestId('memory-toggle')).toBeChecked();
    await page.getByTestId('memory-toggle').uncheck();
    const settings = await (await request.get('/api/settings')).json();
    expect(settings.memoryEnabled).toBe(false);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('对话记录：刷新（相当于关机重开）后还在，可一键清空', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"你好呀，我在的"}}]}\n\n');
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
    await page.getByTestId('chat-input').fill('你好呀');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').first()).toContainText('我在的');

    // 一问一答都落进了本机数据文件
    await expect
      .poll(async () => (await (await request.get('/api/chatMessages')).json()).length)
      .toBeGreaterThanOrEqual(2);
    const saved = await (await request.get('/api/chatMessages')).json();
    expect(saved.some((m: any) => m.role === 'user' && m.content === '你好呀')).toBeTruthy();
    expect(saved.some((m: any) => m.role === 'assistant' && m.content.includes('我在的'))).toBeTruthy();

    // 刷新（相当于关掉窗口重新打开）后，对话还在
    await page.reload();
    await page.getByTestId('page-assistant').waitFor();
    await expect(page.getByTestId('chat-question')).toHaveCount(1);
    await expect(page.getByTestId('chat-answer')).toHaveCount(1);
    await expect(page.getByTestId('chat-question').first()).toContainText('你好呀');
    await expect(page.getByTestId('chat-answer').first()).toContainText('我在的');

    // 去别的页面转一圈再回来，也还在
    await openModule(page, 'overview');
    await page.getByTestId('page-assistant').waitFor();
    await expect(page.getByTestId('chat-question')).toHaveCount(1);

    // 清空全部对话（两步确认）→ 屏幕清空，数据文件里也没了
    await page.getByTestId('clear-chat').click();
    await page.getByTestId('clear-chat-ok').click();
    await expect(page.getByTestId('chat-question')).toHaveCount(0);
    await expect(page.getByTestId('assistant-toast')).toContainText('已清空全部对话');
    await expect
      .poll(async () => (await (await request.get('/api/chatMessages')).json()).length)
      .toBe(0);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('对话记录按天分组：可以只清掉某一天，其它天的还在', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好的呀"}}]}\n\n');
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
    await page.getByTestId('chat-input').fill('今天的消息');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').first()).toContainText('好的呀');
    await expect.poll(async () => (await (await request.get('/api/chatMessages')).json()).length).toBe(2);

    // 造两条"昨天"的对话（走真实导入接口，和恢复备份是同一条路）
    const exported = await (await request.get('/api/export')).json();
    const y = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    exported.data.chatMessages.push(
      { id: 'y-user', seq: 9001, role: 'user', content: '昨天的消息', createdAt: y, updatedAt: y },
      { id: 'y-ai', seq: 9002, role: 'assistant', content: '昨天的回复', createdAt: y, updatedAt: y },
    );
    expect((await request.post('/api/import', { data: exported })).ok()).toBeTruthy();

    await page.reload();
    await page.getByTestId('page-assistant').waitFor();
    // 两段：昨天在前、今天在后，各自带条数
    await expect(page.getByTestId('chat-day-label-0')).toContainText('昨天');
    await expect(page.getByTestId('chat-day-label-0')).toContainText('2 条');
    await expect(page.getByTestId('chat-day-label-1')).toContainText('今天');
    await expect(page.getByTestId('chat-day-label-1')).toContainText('2 条');
    await expect(page.getByTestId('chat-question')).toHaveCount(2);

    // 只清掉"昨天"这一段（两步确认）
    await page.getByTestId('day-clear-0').click();
    await page.getByTestId('day-clear-cancel-0').click(); // 先点取消：什么都不该消失
    await expect(page.getByTestId('chat-day-label-0')).toContainText('昨天');
    await page.getByTestId('day-clear-0').click();
    await page.getByTestId('day-clear-ok-0').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已清除昨天的 2 条对话');
    await expect(page.getByTestId('chat-day-1')).toHaveCount(0);
    await expect(page.getByTestId('chat-day-label-0')).toContainText('今天');
    await expect(page.getByTestId('chat-question')).toHaveCount(1);
    await expect(page.getByTestId('chat-question').first()).toContainText('今天的消息');

    const left = await (await request.get('/api/chatMessages')).json();
    expect(left.length).toBe(2);
    expect(left.every((m: any) => !String(m.content).includes('昨天的'))).toBeTruthy();

    // 再把"今天"也清掉 → 全部为空，回到空状态
    await page.getByTestId('day-clear-0').click();
    await page.getByTestId('day-clear-ok-0').click();
    await expect(page.getByTestId('chat-question')).toHaveCount(0);
    await expect(page.getByTestId('chat-list')).toContainText('聊点什么吧');
    await expect
      .poll(async () => (await (await request.get('/api/chatMessages')).json()).length)
      .toBe(0);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('记忆机制：聊完她静默自动记住 → 轻提示可撤销 → 重复只加强', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        const sys = ((body.messages || []).find((m) => m.role === 'system') || {}).content || '';
        if (sys.includes('记忆整理助手')) {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ choices: [{ message: { content: '我下周三要答辩' } }] }));
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"好的呀"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await request.put('/api/settings', {
      data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-r1' } },
    });
    await page.goto('/');
    await page.getByTestId('page-assistant').waitFor();
    await page.getByTestId('chat-input').fill('我下周三要答辩');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-answer').first()).toContainText('好的呀');

    // 静默自动记住：弹轻提示（不再弹确认卡）
    await expect(page.getByTestId('assistant-toast')).toContainText('已记住', { timeout: 20000 });
    await expect(page.getByTestId('mem-propose')).toHaveCount(0, { timeout: 15000 });
    const memories = await (await request.get('/api/memories')).json();
    const m = memories.find((x: any) => x.text === '我下周三要答辩');
    expect(m).toBeTruthy();
    expect(m.weight).toBe(1);
    expect(m.source).toBe('discover');
    expect(m.file).toBeTruthy();

    // 撤销：点轻提示上的「撤销」→ 记忆和文件一起删掉
    await page.getByTestId('assistant-toast').getByRole('button', { name: '撤销' }).click();
    await expect(page.getByTestId('assistant-toast')).toHaveCount(0, { timeout: 8000 }); // 撤销处理完成
    const afterUndo = await (await request.get('/api/memories')).json();
    expect(afterUndo.length).toBe(0);

    // 再记一条，然后相似内容 → 只加强不新增
    const saved1 = await (await request.post('/api/memory/save', { data: { text: '我下周三要答辩' } })).json();
    expect(saved1.saved).toBeTruthy();
    const saved2 = await (await request.post('/api/memory/save', { data: { text: '下周三我答辩' } })).json();
    expect(saved2.boosted).toBe(true);
    const memories2 = await (await request.get('/api/memories')).json();
    expect(memories2.length).toBe(1);
    expect(memories2[0].weight).toBe(2);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
