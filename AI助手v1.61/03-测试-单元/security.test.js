import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, lanAddresses } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = path.join(__dirname, '..', 'test-fixtures', 'fake-whisper.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-sec-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function until(fn, timeoutMs = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('安全：静态目录不可被 ../ 穿越（/files、/recordings）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    // 先在数据目录里放一个"库文件"作为穿越目标
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ secretMarker: 'DO-NOT-LEAK' }));
    for (const u of [
      '/files/..%2fdb.json',
      '/files/%2e%2e%2fdb.json',
      '/files/..%5cdb.json',
      '/recordings/..%2fdb.json',
      '/files/subdir/..%2f..%2fdb.json',
    ]) {
      const r = await fetch(`${t.base}${u}`);
      const body = await r.text();
      // 核心：数据目录里的文件绝不能出去
      assert.ok(!body.includes('DO-NOT-LEAK'), `${u} 泄漏了数据目录里的文件！`);
      // 如果返回 200，只允许是前端页面（SPA 兜底），不能是别的文件
      if (r.status === 200) {
        assert.ok(body.includes('<div id="root">'), `${u} 返回了 200 但不是前端页面，可疑`);
      }
    }
  } finally {
    await t.close();
  }
});

test('安全：被篡改的备份不能借"删除"越界删文件', async () => {
  const dir = tmpDir();
  // 数据目录外的"重要文件"
  const outsideName = `longapp-outside-${Date.now()}.txt`;
  const outside = path.resolve(dir, '..', outsideName);
  fs.writeFileSync(outside, '不可以被删掉的内容');
  const t = await boot(dir);
  try {
    // 导入一份"恶意备份"：files 记录里把 file 指到数据目录外
    const imp = await fetch(`${t.base}/api/import`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({
        data: {
          files: [
            {
              id: 'evil-1',
              seq: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              name: 'evil.txt',
              mime: 'text/plain',
              size: 1,
              kind: 'other',
              file: `../${outsideName}`,
            },
          ],
        },
      }),
    });
    assert.equal(imp.status, 200);

    // 删掉这条记录：记录应被删，但目录外的文件必须完好
    const del = await fetch(`${t.base}/api/files/evil-1`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.ok(fs.existsSync(outside), '目录外的文件被越界删除了！');

    // 同样的篡改放在录音记录上，也一样
    await fetch(`${t.base}/api/import`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({
        data: {
          lessonNotes: [
            {
              id: 'evil-2',
              seq: 2,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              title: 'evil',
              date: '2026-01-01',
              duration: 0,
              audioFile: `../${outsideName}`,
              status: 'recorded',
              transcript: '',
              summary: '',
            },
          ],
        },
      }),
    });
    await fetch(`${t.base}/api/lessonNotes/evil-2`, { method: 'DELETE' });
    assert.ok(fs.existsSync(outside), '录音记录的越界删除没被拦住！');
  } finally {
    await t.close();
    fs.unlinkSync(outside);
  }
});

test('安全：伪造的音频路径不会被拿去转写/写文件', async () => {
  const dir = tmpDir();
  const fakeModel = path.join(dir, 'fake-model.bin');
  fs.writeFileSync(fakeModel, 'x');
  process.env.WHISPER_BIN = FAKE_WHISPER;
  process.env.WHISPER_MODEL = fakeModel;
  const outsideName = `longapp-outside2-${Date.now()}.txt`;
  const outside = path.resolve(dir, '..', outsideName);
  const t = await boot(dir);
  try {
    await fetch(`${t.base}/api/import`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({
        data: {
          lessonNotes: [
            {
              id: 'evil-3',
              seq: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              title: 'evil',
              date: '2026-01-01',
              duration: 0,
              audioFile: `../${outsideName}`,
              status: 'recorded',
              transcript: '',
              summary: '',
            },
          ],
        },
      }),
    });
    const r = await fetch(`${t.base}/api/recordings/evil-3/transcribe`, { method: 'POST' });
    assert.equal(r.status, 200);
    const failed = await until(async () => {
      const all = await (await fetch(`${t.base}/api/all`)).json();
      const n = all.data.lessonNotes.find((x) => x.id === 'evil-3');
      return n && n.status === 'failed' ? n : null;
    });
    assert.ok(failed.error.includes('不合法'));
    assert.ok(!fs.existsSync(outside), '在数据目录外写了东西！');
  } finally {
    await t.close();
    delete process.env.WHISPER_BIN;
    delete process.env.WHISPER_MODEL;
  }
});

test('安全：局域网访问录音/素材文件同样要口令', async (t) => {
  const dir = tmpDir();
  const srv = await boot(dir);
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'lan-access.json'), 'utf8')).pin;
  try {
    // 先本机传一个文件
    const up = await fetch(`${srv.base}/api/files?name=pic.txt&mime=text/plain`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('hello'),
    });
    const asset = await up.json();
    const fileUrl = `/files/${asset.file.split(/[\\/]/).pop()}`;

    // 本机访问：直接可读
    assert.equal((await fetch(`${srv.base}${fileUrl}`)).status, 200);

    const ip = lanAddresses()[0];
    if (!ip) {
      t.diagnostic('没有局域网地址，跳过');
      return;
    }
    const port = new URL(srv.base).port;
    // 局域网访问：无口令 401
    const noPin = await fetch(`http://${ip}:${port}${fileUrl}`);
    assert.equal(noPin.status, 401);
    const body = await noPin.text();
    assert.ok(!body.includes('hello'), '文件内容泄漏了！');
    // 带口令可读
    assert.equal((await fetch(`http://${ip}:${port}${fileUrl}?k=${pin}`)).status, 200);
  } finally {
    await srv.close();
  }
});

test('安全：方法与边界（未知集合、错误方法、坏请求体）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    // 有副作用的路由都是 POST，GET 摸不到
    assert.equal((await fetch(`${t.base}/api/wipe`)).status, 404);
    assert.equal((await fetch(`${t.base}/api/reveal-data-folder`)).status, 404);
    assert.equal((await fetch(`${t.base}/api/health`, { method: 'POST' })).status, 404);

    // 未知集合 / 不存在的记录
    assert.equal((await fetch(`${t.base}/api/notACollection`)).status, 404);
    assert.equal(
      (await fetch(`${t.base}/api/tasks/nope`, { method: 'DELETE' })).status,
      404,
    );

    // 坏请求体：chat 与 import
    const badChat = await fetch(`${t.base}/api/chat`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: '不是数组' }),
    });
    assert.equal(badChat.status, 400);
    const badImport = await fetch(`${t.base}/api/import`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ data: 'garbage' }),
    });
    assert.equal(badImport.status, 400);

    // 清空数据需要口令字符串
    const badWipe = await fetch(`${t.base}/api/wipe`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ confirm: '清' }),
    });
    assert.equal(badWipe.status, 400);

    // 响应带 nosniff
    const h = await fetch(`${t.base}/api/health`);
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await t.close();
  }
});

test('安全：经隧道/反代的请求不能冒充"本机"免口令；按真实来源分别锁定', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'lan-access.json'), 'utf8')).pin;
  try {
    // 本机发出的、带代理头的请求（模拟隧道把外部流量送进本机）：必须口令
    const spoof = await fetch(`${t.base}/api/all`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(spoof.status, 401);
    const body = await spoof.json();
    assert.equal(body.needPin, true);

    // X-Forwarded-For 一样处理
    assert.equal(
      (await fetch(`${t.base}/api/all`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status,
      401,
    );

    // 带对口令才放行
    assert.equal(
      (
        await fetch(`${t.base}/api/all`, {
          headers: { 'cf-connecting-ip': '203.0.113.9', 'x-workbench-pin': pin },
        })
      ).status,
      200,
    );

    // 本机、无代理头：维持免口令
    assert.equal((await fetch(`${t.base}/api/all`)).status, 200);

    // 隧道流量按"真实来源"分别锁定：来源 A 连错 5 次 → A 被锁，来源 B 不受影响
    for (let i = 0; i < 5; i++) {
      await fetch(`${t.base}/api/all`, {
        headers: { 'cf-connecting-ip': '198.51.100.7', 'x-workbench-pin': '000000' },
      });
    }
    const locked = await fetch(`${t.base}/api/all`, {
      headers: { 'cf-connecting-ip': '198.51.100.7', 'x-workbench-pin': pin },
    });
    assert.equal(locked.status, 429);
    const other = await fetch(`${t.base}/api/all`, {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-workbench-pin': pin },
    });
    assert.equal(other.status, 200);
  } finally {
    await t.close();
  }
});

test('安全：陌生 Origin 的跨站请求被拒（防恶意网页偷偷写数据）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    // 模拟恶意网页：带陌生 Origin 的表单式 POST 到上传接口（本机来源本会免口令）
    const evil = await fetch(`${t.base}/api/files?name=evil.txt&mime=text/plain`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example.com' },
      body: '垃圾数据',
    });
    assert.equal(evil.status, 403);
    const all = await (await fetch(`${t.base}/api/all`)).json();
    assert.equal(all.data.files.length, 0, '恶意请求不应创建任何文件');

    // 录音接口同样拒绝
    const evilRec = await fetch(`${t.base}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', Origin: 'https://evil.example.com' },
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(evilRec.status, 403);

    // 同源 Origin（我们的应用）放行
    const port = new URL(t.base).port;
    const same = await fetch(`${t.base}/api/files?name=ok.txt&mime=text/plain`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${port}` },
      body: '正常',
    });
    assert.equal(same.status, 200);

    // 无 Origin（非浏览器，如 QQ 桥/curl）放行
    const noOrigin = await fetch(`${t.base}/api/assistant-action`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ text: '备忘：测试' }),
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    await t.close();
  }
});

test('安全：Referrer-Policy 防口令经 Referer 泄漏', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const r = await fetch(`${t.base}/api/health`);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await t.close();
  }
});
