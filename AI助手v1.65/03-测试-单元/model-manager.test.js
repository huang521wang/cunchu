import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };
const here = path.dirname(fileURLToPath(import.meta.url));
// 假模型服务：按端口回 ANSWER-R1 / ANSWER-QWEN / ANSWER-CODER / ANSWER-VISION
const FAKE = path.join(here, '..', 'test-fixtures', 'fake-model-server.mjs').replace(/\\/g, '/');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-mgr-'));
}

/** 造一个"文件齐全"的假模型目录（配合 FAKE_MODEL_CMD，不会真的启动 llama-server） */
function fakeModelDir(dir) {
  const files = [
    'model/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
    'model/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf',
    'model/qwen2.5-coder-7b-instruct-q4_0.gguf',
    'vision/ggml-model-q4_k_m.gguf',
    'vision/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf',
  ];
  for (const f of files) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  }
  return dir;
}

// 模型端口整体挪到 9080-9083，绝不碰真机正在跑的 8080-8083
const MODELS = [
  { id: 'r1x', name: 'R1X', type: 'local', baseUrl: 'http://127.0.0.1:9080/v1', model: 'deepseek-r1-7b', apiKey: '', note: '' },
  { id: 'qwenx', name: 'QWENX', type: 'local', baseUrl: 'http://127.0.0.1:9081/v1', model: 'qwen2.5-7b-instruct', apiKey: '', note: '' },
  { id: 'coderx', name: 'CODERX', type: 'local', baseUrl: 'http://127.0.0.1:9082/v1', model: 'qwen2.5-coder-7b', apiKey: '', note: '' },
];

async function boot(extraEnv = {}) {
  const dir = tmpDir();
  const modelDir = fakeModelDir(path.join(dir, 'models'));
  const env = { MODEL_DIR: modelDir, MODEL_PORT_BASE: '9000', FAKE_MODEL_CMD: `node ${FAKE}`, ...extraEnv };
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    // 全部键都记录：原本不存在记 undefined，teardown 时删除——防止测试间环境泄漏
    prev[k] = k in process.env ? process.env[k] : undefined;
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  const base = `http://127.0.0.1:${port}`;
  return { dir, server, port, base, prev };
}

async function teardown(t) {
  for (const k of ['chat', 'qwen', 'coder', 'vision']) {
    try {
      await fetch(`${t.base}/api/local/stop`, { method: 'POST', headers: J, body: JSON.stringify({ kind: k }) });
    } catch {
      // 已退
    }
  }
  await new Promise((r) => t.server.close(r));
  for (const [k, v] of Object.entries(t.prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function putSettings(t, patch) {
  const r = await fetch(`${t.base}/api/settings`, {
    method: 'PUT',
    headers: J,
    body: JSON.stringify(patch),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const statusOf = async (t) => {
  const j = await (await fetch(`${t.base}/api/local/status`)).json();
  return Object.fromEntries(j.models.map((m) => [m.kind, m.online]));
};

test('模型管家：打开助手默认组合——启动千问 + 视觉，已在跑就不重复启动', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx' });
    const r1 = await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(r1.ok, true);
    assert.ok(r1.started.some((s) => s.includes('千问')), `默认应启动千问，实际 ${JSON.stringify(r1.started)}`);
    assert.ok(r1.started.some((s) => s.includes('视觉')), `默认应启动视觉，实际 ${JSON.stringify(r1.started)}`);
    const st = await statusOf(t);
    assert.equal(st.qwen, true);
    assert.equal(st.vision, true);
    assert.equal(st.chat, false);
    assert.equal(st.coder, false);

    // 再开一次：全部已在跑 → 不重复启动
    const r2 = await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.deepEqual(r2.started, []);
  } finally {
    await teardown(t);
  }
});

test('模型管家：开编程模型自动关掉冲突的千问（共享一个显卡位）', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx' });
    await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' });
    const r = await fetch(`${t.base}/api/local/ensure`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ kind: 'coder' }),
    }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.ok(r.started.some((s) => s.includes('编程')), '应启动编程模型');
    assert.ok(r.stopped.includes('qwen'), `应自动关掉千问，实际 stopped=${JSON.stringify(r.stopped)}`);
    const st = await statusOf(t);
    assert.equal(st.coder, true);
    assert.equal(st.qwen, false);
  } finally {
    await teardown(t);
  }
});

test('模型管家：设置页"启动"按钮也自动关冲突（换模型不用先手动关）', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx' });
    const a = await fetch(`${t.base}/api/local/start`, { method: 'POST', headers: J, body: JSON.stringify({ kind: 'qwen' }) }).then((x) => x.json());
    assert.equal(a.ok, true);
    const b = await fetch(`${t.base}/api/local/start`, { method: 'POST', headers: J, body: JSON.stringify({ kind: 'coder' }) }).then((x) => x.json());
    assert.equal(b.ok, true);
    assert.ok(b.stopped.includes('qwen'), `启动编程模型应自动关千问，实际 ${JSON.stringify(b.stopped)}`);
    const st = await statusOf(t);
    assert.equal(st.coder, true);
    assert.equal(st.qwen, false);
  } finally {
    await teardown(t);
  }
});

test('自动调度 × 模型管家：代码→自动切 Coder，数学→自动切 R1，日常→自动切回千问', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx', autoRoute: true, autoManage: true });
    const ask = async (q) => {
      const r = await fetch(`${t.base}/api/chat-once`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ messages: [{ role: 'user', content: q }], maxTokens: 50 }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const code = await ask('帮我写一个 python 函数判断质数');
    assert.equal(code.status, 200);
    assert.equal(code.body.content, 'ANSWER-CODER', '代码题应由编程模型回答');
    assert.equal(code.body.switched, 'coder');

    const math = await ask('解方程 3x+5=20');
    assert.equal(math.status, 200);
    assert.equal(math.body.content, 'ANSWER-R1', '数学题应自动切 R1');
    assert.equal(math.body.switched, 'chat');

    const daily = await ask('今天天气怎么样，随便聊聊');
    assert.equal(daily.status, 200);
    assert.equal(daily.body.content, 'ANSWER-QWEN', '日常应自动切回千问');
    assert.equal(daily.body.switched, 'qwen');

    const st = await statusOf(t);
    assert.equal(st.qwen, true, '最后千问应在跑');
    assert.equal(st.coder, false, '编程模型应已被自动关掉');
    assert.equal(st.chat, false, 'R1 应已被自动关掉');
  } finally {
    await teardown(t);
  }
});

test('模型管家守卫：开关关掉 / 测试环境 NO_AUTOSTART 都不自动启停', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx' });
    const off = await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(off.ok, true); // 默认开
    await putSettings(t, { autoManage: false });
    const g1 = await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(g1.ok, false);
    assert.equal(g1.reason, 'off');
    const bad = await putSettings(t, { autoManage: 'yes' });
    assert.equal(bad.status, 400, '非布尔值要拒绝');
  } finally {
    await teardown(t);
  }

  const t2 = await boot({ NO_AUTOSTART: '1' });
  try {
    const g2 = await fetch(`${t2.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(g2.ok, false);
    assert.equal(g2.reason, 'env');
    const st = await statusOf(t2);
    assert.equal(st.qwen, false, 'NO_AUTOSTART 下绝不能启动模型');
  } finally {
    await teardown(t2);
  }
});

test('模型管家：文件不全时不硬来，也不误杀正在跑的模型', async () => {
  const dir = tmpDir();
  const prev = {};
  const env = { MODEL_DIR: path.join(dir, 'no-models'), MODEL_PORT_BASE: '9000', FAKE_MODEL_CMD: `node ${FAKE}` };
  for (const [k, v] of Object.entries(env)) {
    if (k in process.env) prev[k] = process.env[k];
    process.env[k] = v;
  }
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/api/local/start`, { method: 'POST', headers: J, body: JSON.stringify({ kind: 'qwen' }) });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.ok(String(body.error).includes('文件还不全'));
    const st = await statusOf({ base });
    assert.equal(st.qwen, false, '文件不全时绝不能把模型拉起来');
  } finally {
    await new Promise((r2) => server.close(r2));
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('切换模型：按模型 id 启动（ensure modelId）+ 手动模式发消息自动拉起激活模型', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx', autoRoute: false, autoManage: true });
    // ① 按模型 id 启动编程模型（会自动关掉正在跑的其它聊天模型）
    const e1 = await fetch(`${t.base}/api/local/ensure`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ modelId: 'coderx' }),
    }).then((x) => x.json());
    assert.equal(e1.ok, true);
    if (!e1.already) {
      assert.ok(e1.started.some((s) => s.includes('编程')), '新启动时返回的列表应含编程模型');
    }
    let st = await statusOf(t);
    assert.equal(st.coder, true);

    // ② 手动模式：激活模型没在跑时，发消息自动把它拉起来（自愈）
    await putSettings(t, { activeModelId: 'r1x', autoRoute: false });
    const r = await fetch(`${t.base}/api/chat-once`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], maxTokens: 50 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.content, 'ANSWER-R1', '手动模式应自动拉起激活模型并回答');
    st = await statusOf(t);
    assert.equal(st.chat, true, 'R1 应被自动启动');
    assert.equal(st.coder, false, '冲突的编程模型应被自动关掉');

    // ③ 不存在的模型 id → 404
    const e2 = await fetch(`${t.base}/api/local/ensure`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ modelId: 'ghost' }),
    });
    assert.equal(e2.status, 404);
  } finally {
    await teardown(t);
  }
});

test('并发启动同一个模型：只拉起一个进程（去重，不重复占内存）', async () => {
  const dir = tmpDir();
  const logFile = path.join(dir, 'spawn-count.log');
  const LOGGED_FAKE = path.join(here, '..', 'test-fixtures', 'fake-model-server-logged.mjs').replace(/\\/g, '/');
  const t = await boot({ FAKE_MODEL_CMD: `node ${LOGGED_FAKE}`, FAKE_MODEL_LOG: logFile });
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx', autoRoute: false, autoManage: true });
    // 同时发两个启动请求（模拟连点两下开关）
    const [a, b] = await Promise.all([
      fetch(`${t.base}/api/local/start`, { method: 'POST', headers: J, body: JSON.stringify({ kind: 'qwen' }) }).then((x) => x.json()),
      fetch(`${t.base}/api/local/start`, { method: 'POST', headers: J, body: JSON.stringify({ kind: 'qwen' }) }).then((x) => x.json()),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const st = await statusOf(t);
    assert.equal(st.qwen, true, '千问必须在线');
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\n/).filter(Boolean) : [];
    assert.equal(lines.length, 1, `只应拉起一个进程，实际 ${lines.length} 个（日志：${JSON.stringify(lines)}）`);
  } finally {
    await teardown(t);
  }
});

test('一键全部关闭：stop-all 把所有在跑的模型都停掉', async () => {
  const t = await boot();
  try {
    await putSettings(t, { models: MODELS, activeModelId: 'qwenx', autoRoute: false });
    await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }); // 默认组合：千问+视觉
    const st0 = await statusOf(t);
    assert.equal(st0.qwen, true);
    assert.equal(st0.vision, true);

    const r = await fetch(`${t.base}/api/local/stop-all`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.ok(r.stopped.includes('qwen'), '应停掉千问');
    assert.ok(r.stopped.includes('vision'), '应停掉视觉');

    const st1 = await statusOf(t);
    assert.equal(st1.qwen, false);
    assert.equal(st1.vision, false);
    assert.equal(st1.chat, false);
    assert.equal(st1.coder, false);
  } finally {
    await teardown(t);
  }
});

test('模型管家：激活的是云端模型时，打开助手不拉本地聊天模型（省显存）', async () => {
  const t = await boot();
  try {
    await putSettings(t, {
      models: [
        { id: 'r1x', name: 'R1X', type: 'local', baseUrl: 'http://127.0.0.1:9080/v1', model: 'deepseek-r1-7b', apiKey: '', note: '' },
        { id: 'qwenx', name: 'QWENX', type: 'local', baseUrl: 'http://127.0.0.1:9081/v1', model: 'qwen2.5-7b-instruct', apiKey: '', note: '' },
        { id: 'cloudy', name: '帅给的', type: 'cloud', baseUrl: 'http://192.0.2.77:9/v1', model: 'qwen3.5', apiKey: '', note: '' },
      ],
      activeModelId: 'cloudy',
      autoRoute: false,
      autoManage: true,
    });
    const r = await fetch(`${t.base}/api/local/ensure`, { method: 'POST', headers: J, body: '{}' }).then((x) => x.json());
    assert.equal(r.ok, true);
    const st = await statusOf(t);
    assert.equal(st.qwen, false, '本地千问不该被拉起');
    assert.equal(st.chat, false, '本地 R1 不该被拉起');
    assert.equal(st.coder, false, '本地编程模型不该被拉起');
    assert.ok(!r.started.some((s) => s.includes('聊天')), 'started 里不该有聊天模型');
    // 视觉照常（CPU，与云端聊天不冲突）
    assert.ok(r.started.some((s) => s.includes('视觉')), '视觉仍应就位');
  } finally {
    await teardown(t);
  }
});
