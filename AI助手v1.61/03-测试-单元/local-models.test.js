import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-local-'));
}

test('本地模型管理：状态包含三件套；文件不全时启动返回 409；非法 kind 返回 400', async () => {
  const dir = tmpDir();
  process.env.MODEL_DIR = path.join(dir, 'no-models');
  process.env.WHISPER_DIR = path.join(dir, 'no-whisper');
  process.env.MODEL_PORT_BASE = '9000'; // 端口偏移到 9080-9083：测试绝不碰真机正在跑的模型
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/local/status`)).json();
    const kinds = st.models.map((m) => m.kind);
    assert.ok(
      kinds.includes('chat') && kinds.includes('vision') && kinds.includes('whisper') && kinds.includes('qwen') && kinds.includes('coder') && kinds.includes('qwen4'),
      '聊天/视觉/语音/千问/编程/Qwen3.5 六件套都在',
    );

    const notes = Object.fromEntries(st.models.map((m) => [m.kind, m.note || '']));
    for (const k of ['chat', 'vision', 'qwen', 'coder', 'whisper']) {
      assert.ok(notes[k], k + ' 应有作用备注');
    }
    assert.ok(notes.vision.includes('看'), '视觉备注应说明看图作用');
    assert.ok(notes.coder.includes('编程'), '编程模型备注应说明写代码作用');

    const chat = st.models.find((m) => m.kind === 'chat');
    const vision = st.models.find((m) => m.kind === 'vision');
    assert.equal(chat.files, false, 'MODEL_DIR 指向空目录时聊天模型文件不全');
    assert.equal(vision.files, false);

    // 文件不全 → 409（不会硬拉起）
    const r = await fetch(`http://127.0.0.1:${port}/api/local/start`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ kind: 'coder' }), // 9082 在测试环境没人听，且文件缺失 → 稳定 409
    });
    assert.equal(r.status, 409);

    // 非法 kind → 400
    const bad = await fetch(`http://127.0.0.1:${port}/api/local/start`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ kind: 'nope' }),
    });
    assert.equal(bad.status, 400);

    // 停止不存在的 → 也安全返回（端口已偏移，绝不会误杀真机模型）
    const stop = await fetch(`http://127.0.0.1:${port}/api/local/stop`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ kind: 'vision' }),
    }).then((x) => x.json());
    assert.equal(stop.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.MODEL_DIR;
    delete process.env.WHISPER_DIR;
    delete process.env.MODEL_PORT_BASE;
  }
});
