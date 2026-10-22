import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, isReasoningTask, isCodeTask } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-route-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** 桩模型：/v1/models + /v1/chat/completions（JSON 或 SSE），回答固定标记 */
function stubModel(tag, sse = false) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      if (sse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: {"choices":[{"delta":{"content":"${tag}"}}]}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: tag } }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }),
    );
  });
}

test('任务识别：数学→推理；代码→代码模型；日常→闲聊', () => {
  assert.equal(isReasoningTask('帮我解方程 3x+5=20'), true);
  assert.equal(isCodeTask('这段代码有个 bug 帮我看看'), true);
  assert.equal(isCodeTask('帮我写个 python 爬虫'), true);
  assert.equal(isCodeTask('今天天气怎么样'), false);
  assert.equal(isReasoningTask('深度思考一下人生意义'), true);
  assert.equal(isReasoningTask('今天天气怎么样'), false);
  assert.equal(isReasoningTask('帮我记一下明天交方案'), false);
});

test('自动调度：日常→千问；数学/逻辑→R1；手动模式→当前激活；离线自动降级', async () => {
  const dir = tmpDir();
  const r1 = await stubModel('R1-STUB');
  const qwen = await stubModel('QWEN-STUB');
  const t = await boot(dir);
  const setModels = (autoRoute) =>
    fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'r1m', name: '本机 · DeepSeek-R1-7B', type: 'local', baseUrl: `http://127.0.0.1:${r1.port}/v1`, model: 'r1' },
          { id: 'qwenm', name: '本机 · 千问 7B', type: 'local', baseUrl: `http://127.0.0.1:${qwen.port}/v1`, model: 'qwen' },
        ],
        activeModelId: 'r1m',
        autoRoute,
      }),
    });
  const chatOnce = async (text) => {
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  try {
    await setModels(true);

    // 日常 → 千问
    const a = await chatOnce('今天天气怎么样');
    assert.equal(a.body.model, 'qwen', '日常应路由到千问');
    assert.ok(a.body.content.includes('QWEN-STUB'));
    assert.equal(a.body.auto, true);

    // 数学 → R1
    const b = await chatOnce('帮我解方程 3x+5=20');
    assert.equal(b.body.model, 'r1', '数学应路由到 R1');
    assert.ok(b.body.content.includes('R1-STUB'));

    // 手动模式 → 用当前激活（R1）
    await setModels(false);
    const c = await chatOnce('今天天气怎么样');
    assert.equal(c.body.model, 'r1');
    assert.equal(c.body.auto, false);

    // 自动模式 + 千问离线 → 降级到 R1
    await setModels(true);
    await qwen.close();
    const d = await chatOnce('今天天气怎么样');
    assert.equal(d.body.model, 'r1', '千问离线应降级到 R1');
    assert.ok(d.body.content.includes('R1-STUB'));
  } finally {
    await t.close();
    await r1.close();
    try {
      await qwen.close();
    } catch {
      // 已关
    }
  }
});

test('SSE 对话带元信息：前端能知道"这次由谁回答"', async () => {
  const dir = tmpDir();
  const qwen = await stubModel('SSE-QWEN', true);
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'qwenm', name: '本机 · 千问 7B', type: 'local', baseUrl: `http://127.0.0.1:${qwen.port}/v1`, model: 'qwen' },
        ],
        activeModelId: 'qwenm',
        autoRoute: true,
      }),
    });
    const r = await fetch(`${t.base}/api/chat`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    const text = await r.text();
    const firstData = text.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(firstData.includes('"meta"'), '第一条应是元信息');
    assert.ok(firstData.includes('千问'), '元信息里应有模型名');
    assert.ok(text.includes('SSE-QWEN'));
  } finally {
    await t.close();
    await qwen.close();
  }
});

test('自动调度：代码问题优先给 Coder；Coder 离线则退回 R1', async () => {
  const dir = tmpDir();
  const r1 = await stubModel('R1-CODE');
  const coder = await stubModel('CODER-ANSWER');
  const t = await boot(dir);
  const setModels = (withCoder) =>
    fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'r1m', name: '本机 · DeepSeek-R1-7B', type: 'local', baseUrl: `http://127.0.0.1:${r1.port}/v1`, model: 'r1' },
          { id: 'coderm', name: '本机 · Coder 7B', type: 'local', baseUrl: `http://127.0.0.1:${coder.port}/v1`, model: 'coder' },
        ],
        activeModelId: 'r1m',
        autoRoute: true,
      }),
    });
  const chatOnce = async (text) => {
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    return r.json();
  };
  try {
    await setModels(true);
    const a = await chatOnce('帮我写个 python 爬虫抓取网页标题');
    assert.equal(a.model, 'coder', '代码问题应路由到 Coder');
    assert.equal(a.wanted, 'code');
    assert.ok(a.content.includes('CODER-ANSWER'));

    // Coder 离线 → 退回 R1（推理模型也能写代码）
    await coder.close();
    const b = await chatOnce('这段代码有 bug 帮我看看');
    assert.equal(b.model, 'r1');
    assert.ok(b.content.includes('R1-CODE'));
  } finally {
    await t.close();
    await r1.close();
    try {
      await coder.close();
    } catch {
      // 已关
    }
  }
});

test('多选模型池：只在勾选的模型里调度，没勾的绝不参与也不被自动启动', async () => {
  const dir = tmpDir();
  const r1 = await stubModel('R1-STUB');
  const qwen = await stubModel('QWEN-STUB');
  const coder = await stubModel('CODER-STUB');
  const t = await boot(dir);
  const put = (selectedModels, extra = {}) =>
    fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'r1m', name: 'R1', type: 'local', baseUrl: `http://127.0.0.1:${r1.port}/v1`, model: 'r1' },
          { id: 'qwenm', name: 'QWEN', type: 'local', baseUrl: `http://127.0.0.1:${qwen.port}/v1`, model: 'qwen' },
          { id: 'coderm', name: 'CODER', type: 'local', baseUrl: `http://127.0.0.1:${coder.port}/v1`, model: 'coder' },
        ],
        activeModelId: 'qwenm',
        autoRoute: true,
        selectedModels,
        ...extra,
      }),
    });
  const ask = async (text) => {
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    return r.json();
  };
  try {
    // 池 = [r1, qwen]（不勾编程）→ 代码题不能交给 coder，按规则退回推理模型 r1
    await put(['r1m', 'qwenm']);
    const code = await ask('帮我写一个 python 函数');
    assert.equal(code.content, 'R1-STUB', '没勾编程模型时代码题应退回推理模型，绝不找 Coder');

    // 池 = [qwen]（只勾一个）→ 什么题都只用 qwen
    await put(['qwenm']);
    const math = await ask('解方程 3x+5=20');
    assert.equal(math.content, 'QWEN-STUB', '池里只有千问时数学题也交给千问');
    const daily = await ask('今天天气怎么样');
    assert.equal(daily.content, 'QWEN-STUB');

    // 池 = []（空 = 全部可用）→ 代码题回到 Coder
    await put([]);
    const code2 = await ask('帮我写一个 python 函数');
    assert.equal(code2.content, 'CODER-STUB', '空池等于全选，代码题应交给 Coder');

    // 校验：非数组拒绝；不存在的 id 被丢弃
    const bad = await put('not-an-array');
    assert.equal(bad.status, 400);
    await put(['r1m', 'ghost-id']);
    const s = await (await fetch(`${t.base}/api/settings`)).json();
    assert.deepEqual(s.selectedModels, ['r1m'], '不存在的模型 id 应被丢弃');
  } finally {
    await t.close();
    await r1.close();
    await qwen.close();
    await coder.close();
  }
});
