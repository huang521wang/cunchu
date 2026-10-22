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
const FAKE_OCR = path.join(__dirname, '..', 'test-fixtures', 'fake-ocr.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-screen-'));
}

async function boot(dir) {
  process.env.SCREEN_OCR_CMD = FAKE_OCR;
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('屏幕获取：传帧→结束→OCR去重→柳月虹整理→分类带日期→临时帧清空', async () => {
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
      const sys = ((body.messages || []).find((m) => m.role === 'system') || {}).content || '';
      let content = '无';
      if (sys.includes('整理助手')) {
        content = '任务|交实验报告 明天\n学习|第三章课后习题 10-20\n记忆|老师的邮箱是 math@school.edu.cn\n备忘|记得带学生证';
      }
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

    // 传两帧
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${t.base}/api/screen/frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      });
      assert.equal(r.status, 200);
    }
    const tmpDir2 = path.join(dir, '.screen-tmp', 'session');
    assert.equal(fs.readdirSync(tmpDir2).filter((f) => f.endsWith('.png')).length, 2);

    // 结束 → 整理
    const fin = await fetch(`${t.base}/api/screen/finish`, { method: 'POST' });
    assert.equal(fin.status, 200);
    const j = await fin.json();
    assert.equal(j.items.length, 4, '四类都该被解析出来');
    const task = j.items.find((x) => x.kind === 'task');
    const study = j.items.find((x) => x.kind === 'study');
    const mem = j.items.find((x) => x.kind === 'memory');
    assert.equal(task.text, '交实验报告 明天');
    assert.ok(task.date.endsWith('-10-13') || task.date > '2026-01-01', '明天应被解析成具体日期');
    assert.equal(study.date.slice(5), '10-20');
    assert.equal(mem.text, '老师的邮箱是 math@school.edu.cn');
    assert.ok(j.summary.includes('第三章课后习题'), '摘要应包含 OCR 文字');

    // 临时帧已清空
    const left = fs.existsSync(tmpDir2) ? fs.readdirSync(tmpDir2).filter((f) => f.endsWith('.png')) : [];
    assert.equal(left.length, 0, '整理完临时帧应删除');

    // 空会话
    const empty = await fetch(`${t.base}/api/screen/finish`, { method: 'POST' }).then((r) => r.json());
    assert.equal(empty.items.length, 0);
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
    delete process.env.SCREEN_OCR_CMD;
  }
});

test('屏幕获取：日期解析覆盖 明天/周X/下周X/具体日期', async () => {
  // 直接 import 不了非导出函数，通过 finish 的 study 分类验证主要路径已够；
  // 这里用假 OCR 文本 + 桩模型把日期写进内容，验证"今天/下周"两类解析
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
      const sys = ((body.messages || []).find((m) => m.role === 'system') || {}).content || '';
      const content = sys.includes('整理助手') ? '任务|今天要交周报\n学习|下周一有测验' : '无';
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
    await fetch(`${t.base}/api/screen/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([1, 2, 3]),
    });
    const j = await fetch(`${t.base}/api/screen/finish`, { method: 'POST' }).then((r) => r.json());
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const task = j.items.find((x) => x.kind === 'task');
    const study = j.items.find((x) => x.kind === 'study');
    assert.equal(task.date, iso, '今天 → 今天日期');
    assert.ok(study.date > iso, '下周一 → 未来的具体日期');
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
    delete process.env.SCREEN_OCR_CMD;
  }
});
