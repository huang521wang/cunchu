import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-persona-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('她：默认人设是柳月虹；能改名/称呼/自由程度/性格档案；重置清空', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const g = await (await fetch(`${t.base}/api/persona`)).json();
    assert.equal(g.persona.name, '柳月虹');
    assert.equal(g.persona.addressAs, '阿珑');
    assert.equal(g.persona.freedom, 'free');
    assert.deepEqual(g.persona.traits, []);

    // 改名 + 加一条性格 + 改自由程度
    const put = await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        name: '月虹',
        addressAs: '主人',
        freedom: 'active',
        traits: [{ text: '说话喜欢带小小的比喻', weight: 1, source: 'manual' }],
      }),
    });
    assert.equal(put.status, 200);
    const g2 = await (await fetch(`${t.base}/api/persona`)).json();
    assert.equal(g2.persona.name, '月虹');
    assert.equal(g2.persona.addressAs, '主人');
    assert.equal(g2.persona.freedom, 'active');
    assert.equal(g2.persona.traits.length, 1);
    assert.equal(g2.persona.traits[0].source, 'manual');

    // 非法 freedom 被拒（保持原值）
    const bad = await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ freedom: 'crazy' }),
    });
    assert.equal(bad.status, 200);
    const g3 = await (await fetch(`${t.base}/api/persona`)).json();
    assert.equal(g3.persona.freedom, 'active');

    // 重置
    await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ reset: true }),
    });
    const g4 = await (await fetch(`${t.base}/api/persona`)).json();
    assert.deepEqual(g4.persona.traits, []);
    assert.equal(g4.persona.name, '月虹', '重置只清档案，不改名字');
  } finally {
    await t.close();
  }
});

test('她：tick 在活跃时保持在线；聊天会刷新 lastActiveAt', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const r = await fetch(`${t.base}/api/persona/tick`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ activeAt: new Date().toISOString(), seed: 123 }),
    });
    const out = await r.json();
    assert.equal(out.state, 'online');

    // 聊天后 lastActiveAt 更新（wakeLine 应为空）
    await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }),
    });
    const g = await (await fetch(`${t.base}/api/persona`)).json();
    const gap = Date.now() - new Date(g.persona.lastActiveAt).getTime();
    assert.ok(gap < 10 * 1000, '聊天应该刷新 lastActiveAt');
    assert.equal(g.wakeLine, null);
  } finally {
    await t.close();
  }
});

test('她：wake 会把睡觉中的她叫醒', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        state: 'sleep',
        dreams: [{ at: new Date().toISOString(), text: '梦见云朵排队', type: '奇怪' }],
      }),
    });
    const r = await fetch(`${t.base}/api/persona/wake`, { method: 'POST' });
    const out = await r.json();
    assert.ok(out.greet, '应该有一句醒来的问候');
    assert.ok(out.greet.includes('云朵排队'));
    const g = await (await fetch(`${t.base}/api/persona`)).json();
    assert.equal(g.persona.state, 'online');
  } finally {
    await t.close();
  }
});

test('她：自由念头/模型梦境/每日小记——模型生成真的接通（sync 模式）', async () => {
  const dir = tmpDir();
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      }
      const body = JSON.parse(raw || '{}');
      const userMsg = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
      let content = 'STUB-念头：今天的风闻起来像橘子汽水';
      if (userMsg.includes('做梦')) content = '梦见阳台上的花开了，花瓣排着队往外走';
      if (userMsg.includes('小记')) content = '这些天你一直在忙方案，我记下来了。明天记得交实验报告。';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, model: 'stub' } }),
    });
    // 统一把 lastActiveAt 设到很久以前：这些测试要的是'她一个人待着'的场景
    const putP = (body) => fetch(`${t.base}/api/persona`, { method: 'PUT', headers: J, body: JSON.stringify({ lastActiveAt: '2026-01-01T00:00:00Z', ...body }) });
    const tick = (body = {}) =>
      fetch(`${t.base}/api/persona/tick`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ activeAt: '2026-01-01T00:00:00Z', seed: 5, sync: true, ...body }),
      }).then((r) => r.json());

    // ① 自由念头：模型生成，缓存到 pendingModelThought
    await putP({ freedom: 'active', modelOkUntil: 0, state: 'online', nextAt: Date.now() + 3600000 });
    await tick();
    const p1 = (await (await fetch(`${t.base}/api/persona`)).json()).persona;
    assert.equal(p1.pendingModelThought, 'STUB-念头：今天的风闻起来像橘子汽水');

    // ② 模型梦境：nap→sleep 转换时预生成；dreamAt 到期后梦用模型文本
    await putP({ state: 'nap', nextAt: Date.now() - 1, dreamBusy: false });
    await tick();
    const p2 = (await (await fetch(`${t.base}/api/persona`)).json()).persona;
    assert.ok(p2.pendingDream.includes('阳台上的花'), '入睡后应预生成模型梦境');
    await putP({ state: 'sleep', dreamAt: Date.now() - 1, dreamCount: 0, wakeAt: Date.now() + 3600000 });
    const d = await tick();
    assert.ok(d.dream && d.dream.text.includes('阳台上的花'), '梦应该用模型写的内容');

    // ③ 每日小记：有聊天记录时生成文档 + 心事
    await fetch(`${t.base}/api/chatMessages`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ role: 'user', content: '今天方案改了三版' }),
    });
    await putP({ state: 'online', lastDigestAt: 0, nextAt: Date.now() + 3600000 });
    await tick();
    const docs = await (await fetch(`${t.base}/api/documents`)).json();
    assert.equal(docs.length, 1);
    assert.ok(docs[0].title.includes('小记'));
    assert.ok(docs[0].content.includes('实验报告'));
    const p3 = (await (await fetch(`${t.base}/api/persona`)).json()).persona;
    assert.ok(p3.lastDigestAt > 0);
    assert.ok(p3.thoughts.some((x) => x.source === 'model' && x.text.includes('写进文档')));
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});

test('她主动说的话同步进 QQ 推送队列（电脑和 QQ 都能收到）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const nowMs = Date.now();
    // 她在睡觉，wakeAt 已过：下一次 tick 醒来 → announce wake → 落聊天流 + 进 QQ 队列
    await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        state: 'sleep',
        lastActiveAt: '2026-01-01T00:00:00Z',
        wakeAt: nowMs - 1000,
        dreamAt: null,
        freedom: 'active',
      }),
    });
    await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ dreams: [], clearDreams: true }).valueOf(),
    }).catch(() => {});
    await fetch(`${t.base}/api/persona`, { method: 'PUT', headers: J, body: JSON.stringify({ clearDreams: true }) });
    await fetch(`${t.base}/api/persona`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ state: 'sleep', lastActiveAt: '2026-01-01T00:00:00Z', wakeAt: Date.now() - 1000, dreamAt: null }),
    });
    const out = await fetch(`${t.base}/api/persona/tick`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ sync: true, activeAt: '2026-01-01T00:00:00Z' }),
    }).then((r) => r.json());
    assert.equal(out.woke, true, '应该醒了');
    assert.equal(out.announceSaved, true, '醒来的话该落进聊天流');
    const q = await (await fetch(`${t.base}/api/qq/pending`)).json();
    assert.ok(q.queue.some((x) => x.tag === 'persona'), '醒来的话也该进 QQ 推送队列');
    const msgs = await (await fetch(`${t.base}/api/chatMessages`)).json();
    assert.ok(msgs.some((m) => m.source === 'persona' && m.personaKind === 'wake'));
  } finally {
    await t.close();
  }
});
