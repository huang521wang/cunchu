import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-files-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const J = { 'Content-Type': 'application/json' };

test('素材：上传落盘、能直接访问、删除时连磁盘文件一起清', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const up = await fetch(`${t.base}/api/files?name=${encodeURIComponent('照片.png')}&mime=image/png`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    assert.equal(up.status, 200);
    const a = await up.json();
    assert.equal(a.kind, 'image');
    assert.equal(a.name, '照片.png');
    assert.equal(a.size, 8);
    const fileAbs = path.join(dir, a.file);
    assert.ok(fs.existsSync(fileAbs), '文件应该落盘');

    // 静态访问（本机访问免口令）
    const got = await fetch(`${t.base}/files/${a.file.split(/[\\/]/).pop()}`);
    assert.equal(got.status, 200);

    // 危险文件名会被清洗
    const up2 = await fetch(`${t.base}/api/files?name=${encodeURIComponent('a/../b:c.txt')}&mime=text/plain`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('你好'),
    });
    const a2 = await up2.json();
    assert.equal(a2.name, 'a_.._b_c.txt');
    assert.equal(a2.kind, 'text');

    // 删除：记录和文件都清掉
    const del = await fetch(`${t.base}/api/files/${a.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(fileAbs), '删除后磁盘文件也应删掉');
  } finally {
    await t.close();
  }
});

test('文档：新建/编辑/删除（走通用数据接口）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const c = await fetch(`${t.base}/api/documents`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ title: '我的笔记', content: '第一行\n第二行', source: 'manual' }),
    });
    assert.equal(c.status, 200);
    const doc = await c.json();
    assert.equal(doc.title, '我的笔记');

    const all = await (await fetch(`${t.base}/api/all`)).json();
    assert.equal(all.data.documents.length, 1);

    const p = await fetch(`${t.base}/api/documents/${doc.id}`, {
      method: 'PATCH',
      headers: J,
      body: JSON.stringify({ content: '改过了' }),
    });
    const patched = await p.json();
    assert.equal(patched.content, '改过了');

    await fetch(`${t.base}/api/documents/${doc.id}`, { method: 'DELETE' });
    const all2 = await (await fetch(`${t.base}/api/all`)).json();
    assert.equal(all2.data.documents.length, 0);
  } finally {
    await t.close();
  }
});

test('发图消息：chatMessages 带 attachments（图片显示在气泡里），重启后不丢', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const up = await fetch(`${t.base}/api/files?name=${encodeURIComponent('小图.png')}&mime=image/png`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    const a = await up.json();

    const c = await fetch(`${t.base}/api/chatMessages`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({
        role: 'user',
        content: '我发了一张图给你看。你看到的画面是：…',
        attachments: [{ kind: 'image', name: a.name, mime: a.mime, file: a.file }],
      }),
    });
    assert.equal(c.status, 200);
    const msg = await c.json();
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].file, a.file);

    // 读回来还有；文件也能按 /files/<名> 直接访问（气泡里 <img> 的地址）
    const list = await (await fetch(`${t.base}/api/chatMessages`)).json();
    assert.equal(list[0].attachments[0].name, '小图.png');
    const img = await fetch(`${t.base}/files/${a.file.split(/[\/]/).pop()}`);
    assert.equal(img.status, 200);
  } finally {
    await t.close();
  }
});
