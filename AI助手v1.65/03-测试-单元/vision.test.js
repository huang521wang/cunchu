import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_FFMPEG = path.join(__dirname, '..', 'test-fixtures', 'fake-ffmpeg.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-vision-'));
}

async function boot(dir, visionPort) {
  process.env.VISION_URL = `http://127.0.0.1:${visionPort}/v1`;
  process.env.VISION_FFMPEG = FAKE_FFMPEG;
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('视觉：状态探测 / 图片描述 / 视频抽帧描述（桩视觉服务 + 假 ffmpeg）', async () => {
  const dir = tmpDir();
  // 桩视觉服务：数一下收到几张图，返回对应描述
  const visionStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'vision' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        const content = (body.messages || [])[0]?.content || [];
        const imgCount = content.filter((c) => c.type === 'image_url').length;
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: imgCount > 1 ? 'STUB 视频：一个人在演示软件操作' : 'STUB 视觉：一只橘猫在窗台晒太阳' } }],
          }),
        );
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => visionStub.listen(0, '127.0.0.1', r));
  const t = await boot(dir, visionStub.address().port);
  try {
    // 状态
    const st = await (await fetch(`${t.base}/api/vision/status`)).json();
    assert.equal(st.online, true);
    assert.equal(st.ffmpeg, true);

    // 图片
    const d = await fetch(`${t.base}/api/vision/describe`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ image: 'aGVsbG8=', mime: 'image/png' }),
    }).then((r) => r.json());
    assert.ok(d.description.includes('橘猫'));

    // 视频
    const v = await fetch(`${t.base}/api/vision/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
    }).then((r) => r.json());
    assert.ok(v.description.includes('演示软件'));
    assert.equal(v.frames, 2);
    // 临时帧清空
    const tmpV = path.join(dir, '.vision-tmp');
    const left = fs.existsSync(tmpV) ? fs.readdirSync(tmpV) : [];
    assert.equal(left.length, 0, '视频临时文件应清理');
  } finally {
    await t.close();
    await new Promise((r) => visionStub.close(r));
    delete process.env.VISION_URL;
    delete process.env.VISION_FFMPEG;
  }
});

test('视觉：服务不在线时给友好提示', async () => {
  const dir = tmpDir();
  process.env.VISION_URL = 'http://127.0.0.1:59999/v1';
  process.env.OLLAMA_URL = 'http://127.0.0.1:59998/v1';
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/vision/status`)).json();
    assert.equal(st.online, false);
    const r = await fetch(`http://127.0.0.1:${port}/api/vision/describe`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ image: 'abc' }),
    });
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.ok(j.error.includes('视觉模型没响应'));
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.VISION_URL;
    delete process.env.OLLAMA_URL;
  }
});

test('视觉：llama 版离线时自动用 Ollama 兜底', async () => {
  const dir = tmpDir();
  const ollamaStub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        assert.equal(body.model, 'qwen2.5vl:3b', '应使用 Ollama 的模型名');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'OLLAMA 视角：一只橘猫' } }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => ollamaStub.listen(0, '127.0.0.1', r));
  process.env.VISION_URL = 'http://127.0.0.1:59997/v1'; // llama 版死掉
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaStub.address().port}/v1`;
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/vision/status`)).json();
    assert.equal(st.online, true);
    assert.equal(st.engine, 'ollama');
    const d = await fetch(`http://127.0.0.1:${port}/api/vision/describe`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ image: 'aGk=', mime: 'image/png' }),
    }).then((r) => r.json());
    assert.ok(d.description.includes('OLLAMA'));
    assert.equal(d.engine, 'ollama');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => ollamaStub.close(r));
    delete process.env.VISION_URL;
    delete process.env.OLLAMA_URL;
  }
});
