import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = path.join(__dirname, '..', 'test-fixtures', 'fake-whisper.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-rec-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const J = { 'Content-Type': 'application/json' };

async function until(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('录音：上传落盘 → 转写 → 总结 → 删除连文件一起清（全用假引擎和桩模型）', async () => {
  const dir = tmpDir();
  // 假 whisper：引擎指到 .mjs（用 node 跑），模型只要文件存在即可
  const fakeModel = path.join(dir, 'fake-model.bin');
  fs.writeFileSync(fakeModel, 'x');
  process.env.WHISPER_BIN = FAKE_WHISPER;
  process.env.WHISPER_MODEL = fakeModel;

  const t = await boot(dir);
  // 桩模型（总结用）
  const stub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'STUB 总结：第三章讲了矩阵的秩。' } }] }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  try {
    // 语音组件状态
    const ws = await (await fetch(`${t.base}/api/whisper/status`)).json();
    assert.equal(ws.available, true);
    assert.equal(ws.engine, 'cpu');

    // 上传（模拟手机/电脑传来的音频字节）
    const up = await fetch(`${t.base}/api/recordings?duration=3&title=测试录音`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from([1, 2, 3, 4, 5]),
    });
    assert.equal(up.status, 200);
    const note = await up.json();
    assert.equal(note.status, 'recorded');
    assert.equal(note.title, '测试录音');
    const fileAbs = path.join(dir, note.audioFile);
    assert.ok(fs.existsSync(fileAbs), '音频文件应该落盘');

    // 转写（后台异步）
    const tr = await fetch(`${t.base}/api/recordings/${note.id}/transcribe`, { method: 'POST' });
    assert.equal(tr.status, 200);
    const done = await until(async () => {
      const all = await (await fetch(`${t.base}/api/all`)).json();
      const n = all.data.lessonNotes.find((x) => x.id === note.id);
      return n && n.status === 'transcribed' ? n : null;
    });
    assert.ok(done.transcript.includes('矩阵的秩'), '转写内容应该来自假引擎');
    assert.ok(fs.existsSync(`${fileAbs.replace(/\.[^.]+$/, '')}.txt`), 'whisper 的 txt 应生成');

    // 总结（用桩模型）
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: `http://127.0.0.1:${stubPort}/v1`, model: 'stub' } }),
    });
    const sm = await fetch(`${t.base}/api/recordings/${note.id}/summarize`, { method: 'POST' });
    assert.equal(sm.status, 200);
    const summed = await until(async () => {
      const all = await (await fetch(`${t.base}/api/all`)).json();
      const n = all.data.lessonNotes.find((x) => x.id === note.id);
      return n && n.status === 'done' ? n : null;
    });
    assert.ok(summed.summary.includes('STUB 总结'));

    // 总结失败路径：模型指向死端口
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: 'http://127.0.0.1:9/v1', model: 'dead' } }),
    });
    const sm2 = await fetch(`${t.base}/api/recordings/${note.id}/summarize`, { method: 'POST' });
    assert.equal(sm2.status, 200);
    const failed = await until(async () => {
      const all = await (await fetch(`${t.base}/api/all`)).json();
      const n = all.data.lessonNotes.find((x) => x.id === note.id);
      return n && n.status === 'failed' ? n : null;
    });
    assert.ok(failed.error.includes('总结失败'));

    // 删除：记录和音频文件都清掉
    const del = await fetch(`${t.base}/api/lessonNotes/${note.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(fileAbs), '删除后音频文件也应删掉');

    // 没转写文字不能总结
    const up2 = await fetch(`${t.base}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from([9]),
    });
    const note2 = await up2.json();
    const sm3 = await fetch(`${t.base}/api/recordings/${note2.id}/summarize`, { method: 'POST' });
    assert.equal(sm3.status, 409);
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
    delete process.env.WHISPER_BIN;
    delete process.env.WHISPER_MODEL;
  }
});

test('语音组件没装好时：转写返回清楚的提示', async () => {
  const dir = tmpDir();
  process.env.WHISPER_DIR = path.join(dir, '没有组件');
  process.env.WHISPER_BIN = path.join(dir, '不存在.exe');
  process.env.WHISPER_MODEL = path.join(dir, '不存在.bin');
  const t = await boot(dir);
  try {
    const up = await fetch(`${t.base}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from([1]),
    });
    const note = await up.json();
    const tr = await fetch(`${t.base}/api/recordings/${note.id}/transcribe`, { method: 'POST' });
    assert.equal(tr.status, 409);
    const body = await tr.json();
    assert.ok(body.error.includes('没装好'));
  } finally {
    await t.close();
    delete process.env.WHISPER_BIN;
    delete process.env.WHISPER_MODEL;
    delete process.env.WHISPER_DIR;
  }
});
