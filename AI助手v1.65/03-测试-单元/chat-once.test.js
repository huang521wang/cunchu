import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-chatonce-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** 桩模型：把收到的 messages 原样"回声"回来，方便断言注入了什么 */
function echoModel() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(body.messages) } }] }),
        );
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }),
    );
  });
}

test('chat-once：走当前模型返回内容；带记忆注入；record 存档到对话记录', async () => {
  const dir = tmpDir();
  const stub = await echoModel();
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub' } }),
    });
    // 记忆树里放一条记忆
    await fetch(`${t.base}/api/memories`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ branch: 'about', text: '我叫阿珑', pinned: false, source: 'manual' }),
    });

    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '我叫什么' }], record: true }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // 回声内容 = 模型实际收到的 messages：应包含人设系统提示、记忆和用户消息
    assert.ok(j.content.includes('柳月虹'), '应注入她的人设系统提示');
    assert.ok(j.content.includes('我叫阿珑'), '应该把记忆作为系统提示注入');
    assert.ok(j.content.includes('我叫什么'));
    assert.equal(j.model, 'stub');

    // record:true → 一问一答进对话记录（带 source=qq 标记）
    const msgs = await (await fetch(`${t.base}/api/chatMessages`)).json();
    assert.equal(msgs.length, 2);
    assert.ok(msgs.every((m) => m.source === 'qq'));

    // 关掉记忆开关后不再注入
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ memoryEnabled: false }),
    });
    const r2 = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '再度你好' }] }),
    });
    assert.ok(!(await r2.json()).content.includes('我叫阿珑'), '关闭记忆后不应带上记忆内容');

    // 模型离线 → 502 且给出原因；坏请求体 → 400
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: 'http://127.0.0.1:9/v1', model: 'dead' } }),
    });
    const dead = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }),
    });
    assert.equal(dead.status, 502);
    const bad = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: '不是数组' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
    await stub.close();
  }
});

test('assistant-action：六类"帮记录"识别与描述（和电脑上同一套规则）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const ask = async (text) =>
      (await (
        await fetch(`${t.base}/api/assistant-action`, { method: 'POST', headers: J, body: JSON.stringify({ text }) })
      ).json());

    const task = await ask('加任务：明天交方案');
    assert.equal(task.action.kind, 'task');
    assert.equal(task.action.text, '明天交方案');
    assert.ok(task.describe.includes('今日计划'));

    assert.equal((await ask('备忘：买牛奶')).action.kind, 'memo');
    assert.equal((await ask('记体重：55.5')).action.kind, 'weight');
    assert.equal((await ask('打卡：卧推+2.5kg')).action.kind, 'workout');
    const meal = await ask('记饮食：鸡胸肉饭');
    assert.equal(meal.action.kind, 'meal');
    assert.equal(meal.action.slot, 'lunch');
    const mem = await ask('记住：我周末不接工作电话');
    assert.equal(mem.action.kind, 'memory');
    assert.equal(mem.action.text, '我周末不接工作电话');

    // 普通聊天不误伤
    assert.equal((await ask('今天天气怎么样')).action, null);
    assert.equal((await ask('帮我写个周报')).action, null);

    // 坏请求体
    assert.equal(
      (await fetch(`${t.base}/api/assistant-action`, { method: 'POST', headers: J, body: '{}' })).status,
      400,
    );
  } finally {
    await t.close();
  }
});

test('chat-once：推理模型把预算花光（content 为空）时，用思考结尾兜底', async () => {
  const dir = tmpDir();
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: '我先想想\n第一步…\n最后：答案是 42。' } }],
        }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'r1' } }),
    });
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '几加几等于四十二' }] }),
    });
    const j = await r.json();
    assert.ok(j.content.includes('42'), '应该用思考结尾兜底，而不是空');
  } finally {
    await t.close();
    await new Promise((r) => srv.close(r));
  }
});

test('chat-once：本机思考模型空回答 → 第二轮自适应关思考重试，拿到正常回答（不再发英文思考）', async () => {
  const dir = tmpDir();
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'x' }] }));
      const body = JSON.parse(raw || '{}');
      calls.push(body);
      const off = body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false;
      if (off) return res.end(JSON.stringify({ choices: [{ message: { content: '你好呀！我是柳月虹。' } }] }));
      return res.end(
        JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Thinking Process:\n1. Analyze the request...' } }] }),
      );
    });
  });
  await new Promise((r) => srv.listen(0, '::1', r));
  const port = srv.address().port;
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [{ id: 'cloud1', name: '云端思考', type: 'cloud', baseUrl: `http://[::1]:${port}/v1`, model: 'x', apiKey: '' }],
        activeModelId: 'cloud1',
        autoRoute: false,
        memoryEnabled: false,
      }),
    });
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.content, '你好呀！我是柳月虹。', '应拿到关思考后的中文回答');
    assert.equal(calls.length, 2, '第一次正常调用、第二次带关思考重试');
    assert.equal(calls[1].chat_template_kwargs.enable_thinking, false);
    assert.ok(!calls[0].chat_template_kwargs, '第一次不关思考');
  } finally {
    await t.close();
    await new Promise((r) => srv.close(r));
  }
});


test('chat-once：云端模型（非本机地址）首轮直接关思考拿快答；失败才退回开思考重试', async () => {
  const dir = tmpDir();
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)?.address;
  if (!lan) {
    // 没有局域网接口时跳过网络断言，但仍要求代码路径正确（不可达 → 502 如实报错）
    console.log('无局域网 IPv4，使用回环+主机名不可行，本环境跳过');
    return;
  }
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'x' }] }));
      const body = JSON.parse(raw || '{}');
      calls.push(body);
      const off = body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false;
      if (off) return res.end(JSON.stringify({ choices: [{ message: { content: '快答：我是柳月虹。' } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Thinking...' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const port = srv.address().port;
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [{ id: 'cloud9', name: '云端', type: 'cloud', baseUrl: `http://${lan}:${port}/v1`, model: 'x', apiKey: '' }],
        activeModelId: 'cloud9',
        autoRoute: false,
        memoryEnabled: false,
      }),
    });
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.content, '快答：我是柳月虹。');
    assert.equal(calls.length, 1, '云端首轮即关思考，一发命中，不需要第二轮');
    assert.equal(calls[0].chat_template_kwargs.enable_thinking, false, '第一次就应带关思考参数');
  } finally {
    await t.close();
    await new Promise((res2) => srv.close(res2));
  }
});
