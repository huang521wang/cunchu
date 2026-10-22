import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, isLocalAddress, ensureLanPin, lanAddresses } from '../server/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-lan-'));
}

function lanIPv4() {
  return lanAddresses()[0] || null;
}

test('isLocalAddress：本机地址识别', () => {
  assert.equal(isLocalAddress('127.0.0.1'), true);
  assert.equal(isLocalAddress('::1'), true);
  assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLocalAddress('192.168.1.5'), false);
  assert.equal(isLocalAddress(undefined), false);
});

test('ensureLanPin：生成 6 位数字口令并落盘；再读还是同一个', () => {
  const dir = tmpDir();
  const a = ensureLanPin(dir);
  assert.match(a.pin, /^\d{6}$/);
  const j = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  assert.equal(j.pin, a.pin);
  const b = ensureLanPin(dir);
  assert.equal(b.pin, a.pin);
});

test('局域网访问需要口令；本机访问不需要；健康检查放行', async (t) => {
  const dir = tmpDir();
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'lan-access.json'), 'utf8')).pin;
  try {
    // 本机访问：不带口令也能拿到数据
    const local = await fetch(`http://127.0.0.1:${port}/api/all`);
    assert.equal(local.status, 200);

    // 健康检查：任何来源都放行
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);

    const ip = lanIPv4();
    if (!ip) {
      t.diagnostic('这台机器没有局域网地址，跳过局域网部分');
      return;
    }

    // 模拟手机：从局域网地址访问 → 需要口令
    const noPin = await fetch(`http://${ip}:${port}/api/all`);
    assert.equal(noPin.status, 401);
    const body = await noPin.json();
    assert.equal(body.needPin, true);

    const wrong = await fetch(`http://${ip}:${port}/api/all`, { headers: { 'x-workbench-pin': '000000' } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`http://${ip}:${port}/api/all`, { headers: { 'x-workbench-pin': pin } });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.ok(data.data && Array.isArray(data.data.tasks));

    // 也支持 ?k= 口令（给最省事的场景留的口子）
    const viaQuery = await fetch(`http://${ip}:${port}/api/all?k=${pin}`);
    assert.equal(viaQuery.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('局域网口令：同一来源连错 5 次会被暂时锁定（防暴力猜），本机不受影响', async (t) => {
  const dir = tmpDir();
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'lan-access.json'), 'utf8')).pin;
  try {
    const ip = lanIPv4();
    if (!ip) {
      t.diagnostic('这台机器没有局域网地址，跳过');
      return;
    }
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://${ip}:${port}/api/all`, { headers: { 'x-workbench-pin': '000000' } });
      assert.equal(r.status, 401);
    }
    // 第 6 次：即使这次口令是对的，也被锁定
    const locked = await fetch(`http://${ip}:${port}/api/all`, { headers: { 'x-workbench-pin': pin } });
    assert.equal(locked.status, 429);
    const body = await locked.json();
    assert.ok(body.error.includes('5 分钟'));

    // 本机访问不受锁定影响
    const local = await fetch(`http://127.0.0.1:${port}/api/all`);
    assert.equal(local.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
