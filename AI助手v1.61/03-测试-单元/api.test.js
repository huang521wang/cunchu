import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startServer } from '../server/server.js';
import { COLLECTIONS } from '../server/store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-api-'));
}

async function boot(dir = tmpDir()) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, store, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  const base = `http://127.0.0.1:${port}`;
  return {
    dir,
    store,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getJSON(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function sendJSON(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /api/all 返回全部集合与默认设置', async () => {
  const t = await boot();
  try {
    const { status, body } = await getJSON(`${t.base}/api/all`);
    assert.equal(status, 200);
    for (const c of COLLECTIONS) assert.ok(Array.isArray(body.data[c]), `缺少集合 ${c}`);
    assert.equal(body.settings.theme, 'light');
    assert.deepEqual(body.settings.platforms.slice(0, 2), ['小红书', '抖音']);
  } finally {
    await t.close();
  }
});

test('集合接口完整增删改查', async () => {
  const t = await boot();
  try {
    const created = await sendJSON(`${t.base}/api/tasks`, 'POST', {
      title: '写周报',
      date: '2026-10-11',
      priority: 'high',
      done: false,
      doneAt: null,
    });
    assert.equal(created.status, 200);
    assert.ok(created.body.id, '返回的记录应带 id');
    assert.ok(created.body.createdAt, '返回的记录应带 createdAt');
    const id = created.body.id;

    const list1 = await getJSON(`${t.base}/api/tasks`);
    assert.equal(list1.body.length, 1);
    assert.equal(list1.body[0].title, '写周报');

    const patched = await sendJSON(`${t.base}/api/tasks/${id}`, 'PATCH', { done: true });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.done, true);
    assert.equal(patched.body.title, '写周报', '未修改的字段应保留');

    const list2 = await getJSON(`${t.base}/api/tasks`);
    assert.equal(list2.body[0].done, true);

    const removed = await sendJSON(`${t.base}/api/tasks/${id}`, 'DELETE', {});
    assert.equal(removed.status, 200);
    const list3 = await getJSON(`${t.base}/api/tasks`);
    assert.equal(list3.body.length, 0);
  } finally {
    await t.close();
  }
});

test('创建时服务端强制生成 id 和时间戳（客户端伪造会被忽略）', async () => {
  const t = await boot();
  try {
    const created = await sendJSON(`${t.base}/api/memos`, 'POST', {
      text: '买牛奶',
      id: 'fake-id',
      createdAt: '2000-01-01',
    });
    assert.notEqual(created.body.id, 'fake-id');
    assert.notEqual(created.body.createdAt, '2000-01-01');
  } finally {
    await t.close();
  }
});

test('同一毫秒内连续创建的记录也有稳定先后（seq 递增）', async () => {
  const t = await boot();
  try {
    const a = await sendJSON(`${t.base}/api/memos`, 'POST', { text: '第一条' });
    const b = await sendJSON(`${t.base}/api/memos`, 'POST', { text: '第二条' });
    assert.equal(typeof a.body.seq, 'number');
    assert.equal(typeof b.body.seq, 'number');
    assert.ok(b.body.seq > a.body.seq, '后创建的 seq 必须更大');
    // 客户端伪造 seq 无效
    const c = await sendJSON(`${t.base}/api/memos`, 'POST', { text: '第三条', seq: 999999 });
    assert.notEqual(c.body.seq, 999999);
  } finally {
    await t.close();
  }
});

test('未知集合返回 404，非法请求体返回 400', async () => {
  const t = await boot();
  try {
    const badCollection = await getJSON(`${t.base}/api/notARealCollection`);
    assert.equal(badCollection.status, 404);

    const badBody = await sendJSON(`${t.base}/api/tasks`, 'POST', [1, 2, 3]);
    assert.equal(badBody.status, 400);

    const missingItem = await sendJSON(`${t.base}/api/tasks/no-such-id`, 'PATCH', { title: 'x' });
    assert.equal(missingItem.status, 404);
  } finally {
    await t.close();
  }
});

test('设置接口：合法合并、非法值拒绝、持久化', async () => {
  const t = await boot();
  try {
    const ok = await sendJSON(`${t.base}/api/settings`, 'PUT', { theme: 'dark' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.theme, 'dark');
    assert.equal(ok.body.platforms.length, 5, '未提交的设置应保留');

    const badTheme = await sendJSON(`${t.base}/api/settings`, 'PUT', { theme: 'neon' });
    assert.equal(badTheme.status, 400);

    const badPlan = await sendJSON(`${t.base}/api/settings`, 'PUT', { weeklyPlan: ['只有一天'] });
    assert.equal(badPlan.status, 400);

    const plan = await sendJSON(`${t.base}/api/settings`, 'PUT', {
      weeklyPlan: ['胸+三头', '休息', '背+二头', '休息', '腿', '休息', '休息'],
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.weeklyPlan[0], '胸+三头');

    // 游戏周计划：和健身周计划一样的校验
    const badGamePlan = await sendJSON(`${t.base}/api/settings`, 'PUT', { gamePlan: ['只有一天'] });
    assert.equal(badGamePlan.status, 400);
    const gamePlan = await sendJSON(`${t.base}/api/settings`, 'PUT', {
      gamePlan: ['塞尔达', '休息', '休息', '星露谷', '休息', '休息', '休息'],
    });
    assert.equal(gamePlan.status, 200);
    assert.equal(gamePlan.body.gamePlan[0], '塞尔达');
    assert.equal(gamePlan.body.weeklyPlan[0], '胸+三头', '改游戏计划不应影响健身周计划');

    // 默认设置里就带着游戏周计划
    const all = await getJSON(`${t.base}/api/all`);
    assert.equal(all.body.settings.gamePlan.length, 7);
  } finally {
    await t.close();
  }
});

test('服务重启后数据仍在（验收 A 核心）', async () => {
  const dir = tmpDir();
  const t1 = await boot(dir);
  const created = await sendJSON(`${t1.base}/api/memos`, 'POST', { text: '重启也要在' });
  assert.equal(created.status, 200);
  await t1.close();

  const t2 = await boot(dir);
  try {
    const { body } = await getJSON(`${t2.base}/api/all`);
    assert.equal(body.data.memos.length, 1);
    assert.equal(body.data.memos[0].text, '重启也要在');
  } finally {
    await t2.close();
  }
});

test('模型状态：未启动时显示离线；配置校验生效', async () => {
  const t = await boot();
  try {
    // 指向一个必然没人监听的端口，保证确定性
    const cfg = await sendJSON(`${t.base}/api/settings`, 'PUT', {
      modelApi: { baseUrl: 'http://127.0.0.1:59987/v1', model: 'test-model' },
    });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.modelApi.baseUrl, 'http://127.0.0.1:59987/v1');

    const bad = await sendJSON(`${t.base}/api/settings`, 'PUT', { modelApi: 'not-an-object' });
    assert.equal(bad.status, 400);

    const status = await getJSON(`${t.base}/api/model/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.online, false);

    const chat = await sendJSON(`${t.base}/api/chat`, 'POST', { messages: [{ role: 'user', content: '你好' }] });
    assert.equal(chat.status, 502);
    assert.ok(String(chat.body.error).includes('启动模型'), '应提示启动本地模型');
  } finally {
    await t.close();
  }
});

test('AI 对话：把上游模型服务的流式输出原样转发', async () => {
  // 起一个假的"模型服务"，只回 SSE
  const http = await import('node:http');
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"呀"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 60);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  const t = await boot();
  try {
    await sendJSON(`${t.base}/api/settings`, 'PUT', {
      modelApi: { baseUrl: `http://127.0.0.1:${stubPort}/v1`, model: 'stub-model' },
    });

    const status = await getJSON(`${t.base}/api/model/status`);
    assert.equal(status.body.online, true);
    assert.equal(status.body.model, 'stub-model');

    const res = await fetch(`${t.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"content":"你好"'), '应包含第一段内容');
    assert.ok(text.includes('"content":"呀"'), '应包含第二段内容');
    assert.ok(text.includes('[DONE]'), '应包含结束标记');
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});

test('记忆树：对话自动带上记忆（钉住优先），开关可关闭', async () => {
  const http = await import('node:http');
  let captured = null;
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        captured = JSON.parse(data);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"好的"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  const t = await boot();
  try {
    await sendJSON(`${t.base}/api/settings`, 'PUT', {
      modelApi: { baseUrl: `http://127.0.0.1:${stubPort}/v1`, model: 'stub' },
    });
    // 存两条记忆：一条普通、一条钉住
    await sendJSON(`${t.base}/api/memories`, 'POST', {
      branch: 'about',
      text: '叫阿珑',
      pinned: false,
      source: 'manual',
    });
    await sendJSON(`${t.base}/api/memories`, 'POST', {
      branch: 'preference',
      text: '周末不接工作电话',
      pinned: true,
      source: 'chat',
    });

    // 默认开启：应注入"她的人设"（第一条）+ 记忆（单独一条 system），钉住的排前面
    await sendJSON(`${t.base}/api/chat`, 'POST', { messages: [{ role: 'user', content: '你好' }] });
    assert.ok(captured, '桩服务应收到请求');
    const sysAll = captured.messages.filter((m) => m.role === 'system');
    assert.ok(sysAll[0].content.includes('柳月虹'), '第一条系统提示应是她的人设');
    const sys = sysAll.find((m) => m.content.includes('【关于我】'));
    assert.ok(sys, '应有一条带记忆的 system 提示');
    assert.ok(sys.content.includes('【关于我】叫阿珑'), '应包含关于我分支');
    assert.ok(sys.content.includes('【偏好】周末不接工作电话'), '应包含偏好分支');
    assert.ok(
      sys.content.indexOf('周末不接工作电话') < sys.content.indexOf('叫阿珑'),
      '钉住的记忆应排在前面',
    );

    // 关闭开关：不再注入记忆；但人设还在
    const off = await sendJSON(`${t.base}/api/settings`, 'PUT', { memoryEnabled: false });
    assert.equal(off.status, 200);
    captured = null;
    await sendJSON(`${t.base}/api/chat`, 'POST', { messages: [{ role: 'user', content: '你好' }] });
    const sysOff = captured.messages.filter((m) => m.role === 'system');
    assert.equal(sysOff.length, 1, '关闭记忆后应只剩人设这一条 system');
    assert.ok(sysOff[0].content.includes('柳月虹'));
    assert.ok(!JSON.stringify(captured.messages).includes('叫阿珑'), '关闭后不应带上记忆');

    // 非法开关值 → 400
    const bad = await sendJSON(`${t.base}/api/settings`, 'PUT', { memoryEnabled: 'yes' });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});

test('设计概念稿通过 /concept 路径托管（含中文文件名）', async () => {
  const t = await boot();
  try {
    const index = await fetch(`${t.base}/concept/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('设计概念稿'), '总览页应能打开');

    const draft = await fetch(`${t.base}/concept/微信-概念稿.html`);
    assert.equal(draft.status, 200);
    const draftHtml = await draft.text();
    assert.ok(draftHtml.includes('非官方'), '概念稿页面应能打开');

    const css = await fetch(`${t.base}/concept/style.css`);
    assert.equal(css.status, 200);
  } finally {
    await t.close();
  }
});

test('meta 返回数据文件信息', async () => {
  const t = await boot();
  try {
    const { status, body } = await getJSON(`${t.base}/api/meta`);
    assert.equal(status, 200);
    assert.ok(body.dataDir.includes(t.dir.replace(/\\/g, path.sep).split(path.sep).slice(-1)[0]));
    assert.ok(body.size > 0);
    assert.ok(body.updatedAt);
    assert.equal(typeof body.backupCount, 'number');
  } finally {
    await t.close();
  }
});

test('导出→导入 往返一致，且导入前自动备份当前数据', async () => {
  const t = await boot();
  try {
    await sendJSON(`${t.base}/api/tasks`, 'POST', { title: '原任务', date: '2026-10-11' });
    const exported = await getJSON(`${t.base}/api/export`);
    assert.equal(exported.status, 200);
    assert.ok(exported.body.exportedAt);
    assert.equal(exported.body.data.tasks.length, 1);

    // 把备份改成另一份数据再导入
    const backup = JSON.parse(JSON.stringify(exported.body));
    backup.data.tasks = [{ id: 'a', title: '恢复出来的任务', date: '2026-10-12' }];

    const imported = await sendJSON(`${t.base}/api/import`, 'POST', backup);
    assert.equal(imported.status, 200);
    assert.equal(imported.body.counts.tasks, 1);

    const { body } = await getJSON(`${t.base}/api/all`);
    assert.equal(body.data.tasks.length, 1);
    assert.equal(body.data.tasks[0].title, '恢复出来的任务');

    const backups = fs.readdirSync(path.join(t.dir, 'backups')).filter((f) => f.startsWith('before-import-'));
    assert.equal(backups.length, 1, '导入前应自动备份当前数据');

    const bad = await sendJSON(`${t.base}/api/import`, 'POST', { hello: 'world' });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});

test('清空数据需要口令，且清空前自动备份', async () => {
  const t = await boot();
  try {
    await sendJSON(`${t.base}/api/tasks`, 'POST', { title: '将被清空', date: '2026-10-11' });

    const wrong = await sendJSON(`${t.base}/api/wipe`, 'POST', { confirm: '删除' });
    assert.equal(wrong.status, 400);

    const ok = await sendJSON(`${t.base}/api/wipe`, 'POST', { confirm: '清空' });
    assert.equal(ok.status, 200);

    const { body } = await getJSON(`${t.base}/api/all`);
    assert.equal(body.data.tasks.length, 0);

    const backups = fs.readdirSync(path.join(t.dir, 'backups')).filter((f) => f.startsWith('before-wipe-'));
    assert.equal(backups.length, 1, '清空前应自动备份');
  } finally {
    await t.close();
  }
});

test('端口被占用时自动换到下一个端口', async () => {
  const dir = tmpDir();
  // 严格标准：占住 busy 后，服务必须正好顺延到 busy+1。
  // 并行跑其它测试文件时 busy+1 可能被随机占用，这种碰撞重试即可（不放松断言）。
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, resolve));
    const busy = blocker.address().port;
    let server = null;
    try {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
            const started = await startServer({ dataDir: dir, port: busy, openBrowser: false });
      server = started.server;
      try {
        assert.equal(started.port, busy + 1, `被占端口应顺延一位：${busy} → ${busy + 1}`);
        const h = await fetch(`http://127.0.0.1:${started.port}/api/health`);
        assert.equal(h.status, 200);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e; // 碰撞偶发，重试
      }
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => blocker.close(resolve));
    }
  }
  if (lastErr) throw lastErr;
});
