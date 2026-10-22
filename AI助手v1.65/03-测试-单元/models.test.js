import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-models-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** 桩模型服务：/v1/models + SSE 回复；requireKey 时校验 Bearer */
function stubModel(content, requireKey = '') {
  const srv = http.createServer((req, res) => {
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'missing key' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function chatText(base) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(res.status, 200);
  return await res.text();
}

test('模型列表：默认自带一条本机模型，当前已激活', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const s = await (await fetch(`${t.base}/api/settings`)).json();
    assert.ok(Array.isArray(s.models));
    assert.equal(s.models.length, 1);
    assert.equal(s.models[0].type, 'local');
    assert.equal(s.activeModelId, s.models[0].id);
    // 兼容镜像：modelApi 指向当前激活的模型
    assert.equal(s.modelApi.baseUrl, s.models[0].baseUrl);
    assert.equal(s.modelApi.model, s.models[0].model);
  } finally {
    await t.close();
  }
});

test('老配置（只有 modelApi）自动迁移成模型列表第一条', async () => {
  const dir = tmpDir();
  // 手写一份"旧版"的 db.json
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'db.json'),
    JSON.stringify({
      version: 1,
      seq: 3,
      settings: { theme: 'light', modelApi: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'my-old-model' } },
      data: {},
    }),
  );
  const t = await boot(dir);
  try {
    const s = await (await fetch(`${t.base}/api/settings`)).json();
    assert.equal(s.models.length, 1);
    assert.equal(s.models[0].baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(s.models[0].model, 'my-old-model');
    assert.equal(s.activeModelId, s.models[0].id);
  } finally {
    await t.close();
  }
});

test('模型列表：增删改校验 + 切换当前 + 重启后保持', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  const list = [
    { id: 'a', name: '本机 · A', type: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'model-a' },
    { id: 'b', name: '本机 · B', type: 'local', baseUrl: 'http://127.0.0.1:8081/v1', model: 'model-b' },
  ];
  try {
    // 非法地址被拒
    const bad = await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ models: [{ id: 'x', baseUrl: '不是网址', model: 'm' }] }),
    });
    assert.equal(bad.status, 400);

    // 正常保存两条并切换当前
    const ok = await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ models: list, activeModelId: 'b' }),
    });
    assert.equal(ok.status, 200);
    const s1 = await ok.json();
    assert.equal(s1.models.length, 2);
    assert.equal(s1.activeModelId, 'b');
    assert.equal(s1.modelApi.model, 'model-b'); // 镜像跟着当前激活走

    // 切到不存在的 id 被拒
    const badActive = await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ activeModelId: 'nope' }),
    });
    assert.equal(badActive.status, 400);
  } finally {
    await t.close();
  }

  // 重启后保持
  const t2 = await boot(dir);
  try {
    const s2 = await (await fetch(`${t2.base}/api/settings`)).json();
    assert.equal(s2.models.length, 2);
    assert.equal(s2.activeModelId, 'b');
  } finally {
    await t2.close();
  }
});

test('模型状态接口：分别探测每个模型的在线情况', async () => {
  const dir = tmpDir();
  const stub = await stubModel('hi');
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'live', name: '在线的', type: 'local', baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub' },
          { id: 'dead', name: '没启动的', type: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'dead' },
        ],
        activeModelId: 'live',
      }),
    });
    const rows = await (await fetch(`${t.base}/api/models/status`)).json();
    assert.equal(rows.length, 2);
    const live = rows.find((x) => x.id === 'live');
    const dead = rows.find((x) => x.id === 'dead');
    assert.equal(live.online, true);
    assert.equal(live.active, true);
    assert.equal(dead.online, false);
    assert.equal(dead.active, false);
  } finally {
    await t.close();
    await stub.close();
  }
});

test('切换模型后对话真的走新模型；云端模型的密钥会带上', async () => {
  const dir = tmpDir();
  const a = await stubModel('A模型回答');
  const b = await stubModel('B模型回答');
  const keyed = await stubModel('带钥匙的回答', 'secret-key-123');
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'a', name: 'A', type: 'local', baseUrl: `http://127.0.0.1:${a.port}/v1`, model: 'model-a' },
          { id: 'b', name: 'B', type: 'local', baseUrl: `http://127.0.0.1:${b.port}/v1`, model: 'model-b' },
          {
            id: 'k',
            name: '带钥匙的',
            type: 'cloud',
            baseUrl: `http://127.0.0.1:${keyed.port}/v1`,
            model: 'keyed',
            apiKey: 'secret-key-123',
          },
        ],
        activeModelId: 'a',
        autoRoute: false,
      }),
    });

    assert.ok((await chatText(t.base)).includes('A模型回答'));

    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ activeModelId: 'b', autoRoute: false }),
    });
    assert.ok((await chatText(t.base)).includes('B模型回答'));

    // 带密钥的模型：请求头里要有 Authorization，才能通过
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ activeModelId: 'k', autoRoute: false }),
    });
    assert.ok((await chatText(t.base)).includes('带钥匙的回答'));

    // 密钥没配的情况：会拿到 502（对方 401），并且提示里带状态码
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'a', name: 'A', type: 'local', baseUrl: `http://127.0.0.1:${a.port}/v1`, model: 'model-a' },
          { id: 'k2', name: '没钥匙的', type: 'cloud', baseUrl: `http://127.0.0.1:${keyed.port}/v1`, model: 'keyed' },
        ],
        activeModelId: 'k2',
        autoRoute: false,
      }),
    });
    const res = await fetch(`${t.base}/api/chat`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 502);
  } finally {
    await t.close();
    await a.close();
    await b.close();
    await keyed.close();
  }
});

test('外接模型：测试连接接口（成功/密钥错/连不上/地址不合法）', async () => {
  const dir = tmpDir();
  const okStub = await stubModel('hi'); // /v1/models 返回 stub-model
  const keyStub = await stubModel('hi', 'the-key');
  const t = await boot(dir);
  try {
    // 成功：还能拉到可用模型名
    const ok = await (
      await fetch(`${t.base}/api/models/test`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${okStub.port}/v1` }),
      })
    ).json();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models, ['stub-model']);

    // 密钥错（对方 401）
    const bad = await (
      await fetch(`${t.base}/api/models/test`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${keyStub.port}/v1`, apiKey: 'wrong' }),
      })
    ).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.ok(bad.error.includes('密钥'));

    // 密钥对：成功
    const good = await (
      await fetch(`${t.base}/api/models/test`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${keyStub.port}/v1`, apiKey: 'the-key' }),
      })
    ).json();
    assert.equal(good.ok, true);

    // 连不上
    const dead = await (
      await fetch(`${t.base}/api/models/test`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }),
      })
    ).json();
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 0);

    // 地址不合法
    const badUrl = await fetch(`${t.base}/api/models/test`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ baseUrl: '不是网址' }),
    });
    assert.equal(badUrl.status, 400);
  } finally {
    await t.close();
    await okStub.close();
    await keyStub.close();
  }
});

test('模型状态接口：聊天模型（8080-8082 端口）带 slot=chat 标记，其它为 other', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'chat1', name: '聊天A', type: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'a' },
          { id: 'chat2', name: '聊天B', type: 'local', baseUrl: 'http://127.0.0.1:8082/v1', model: 'b' },
          { id: 'cloud1', name: '云端C', type: 'cloud', baseUrl: 'http://127.0.0.1:9999/v1', model: 'c' },
        ],
      }),
    });
    const list = await (await fetch(`${t.base}/api/models/status`)).json();
    const byId = Object.fromEntries(list.map((m) => [m.id, m.slot]));
    assert.equal(byId.chat1, 'chat', '8080 是聊天模型（共显卡位）');
    assert.equal(byId.chat2, 'chat', '8082 是聊天模型（共显卡位）');
    assert.equal(byId.cloud1, 'other', '云端模型不受显卡位约束');
  } finally {
    await t.close();
  }
});

test('手动模式：激活模型连不上时自动试其它本地模型（认证错误不兜底、如实报错）', async () => {
  const dir = tmpDir();
  const a = await stubModel('A模型回答');
  const keyed = await stubModel('带钥匙的回答', 'secret-key-123');
  const t = await boot(dir);
  try {
    // 激活的模型离线 → 自动用另一个在线本地模型
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'dead', name: 'D', type: 'local', baseUrl: 'http://127.0.0.1:59987/v1', model: 'dead' },
          { id: 'a', name: 'A', type: 'local', baseUrl: `http://127.0.0.1:${a.port}/v1`, model: 'model-a' },
        ],
        activeModelId: 'dead',
        autoRoute: false,
      }),
    });
    assert.ok((await chatText(t.base)).includes('A模型回答'), '激活模型离线时自动用其它本地模型');

    // 认证失败（401）→ 不兜底，如实报 502
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        models: [
          { id: 'k2', name: '没钥匙的', type: 'cloud', baseUrl: `http://127.0.0.1:${keyed.port}/v1`, model: 'keyed' },
          { id: 'a', name: 'A', type: 'local', baseUrl: `http://127.0.0.1:${a.port}/v1`, model: 'model-a' },
        ],
        activeModelId: 'k2',
        autoRoute: false,
      }),
    });
    const res = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 502, '密钥不对必须如实报错，不能悄悄换模型');
    const body = await res.json();
    assert.ok(String(body.error).includes('密钥'), '报错里要说明是密钥问题');
  } finally {
    await t.close();
    await a.close();
    await keyed.close();
  }
});
