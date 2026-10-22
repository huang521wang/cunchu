import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imagineViaZhipu, startServer } from '../server/server.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeFetch(handlers) {
  return async (url, opts) => {
    const h = handlers.find((x) => x.test(String(url)));
    if (!h) throw new Error('unexpected fetch ' + url);
    return h.res(opts);
  };
}

test('智谱画图：生图拿到 url 再下载，返回 png 字节', async () => {
  const calls = [];
  const f = fakeFetch([
    {
      test: (u) => u.includes('/images/generations'),
      res: (opts) => {
        calls.push(opts.headers.Authorization);
        return { ok: true, json: async () => ({ data: [{ url: 'https://cdn.bigmodel.cn/img.png' }] }) };
      },
    },
    {
      test: (u) => u.includes('/img.png'),
      res: () => ({ ok: true, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) }),
    },
  ]);
  const buf = await imagineViaZhipu('一只橘猫戴帽子', 'KEY-abc', f);
  assert.ok(Buffer.isBuffer(buf) && buf.length === 7);
  assert.equal(calls[0], 'Bearer KEY-abc', '密钥要进 Authorization 头');
});

test('智谱画图：没给密钥直接抛错，不发请求', async () => {
  await assert.rejects(() => imagineViaZhipu('x', '', fakeFetch([])), /API Key/);
});

test('智谱画图：401/429 带人话提示', async () => {
  const f401 = fakeFetch([{ test: () => true, res: () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) }]);
  await assert.rejects(() => imagineViaZhipu('x', 'k', f401), /密钥不对|401/);
  const f429 = fakeFetch([{ test: () => true, res: () => ({ ok: false, status: 429, text: async () => '' }) }]);
  await assert.rejects(() => imagineViaZhipu('x', 'k', f429), /免费额度|429/);
});

test('智谱画图：返回里没有图片地址（审核拦）要如实说', async () => {
  const f = fakeFetch([{ test: () => true, res: () => ({ ok: true, json: async () => ({ data: [] }) }) }]);
  await assert.rejects(() => imagineViaZhipu('x', 'k', f), /没有图片地址|审核/);
});

test('智谱画图：图生成了但下载链接挂了要提示重试', async () => {
  const f = fakeFetch([
    { test: (u) => u.includes('/generations'), res: () => ({ ok: true, json: async () => ({ data: [{ url: 'https://x/img.png' }] }) }) },
    { test: (u) => u.includes('/img.png'), res: () => ({ ok: false, status: 500, text: async () => '' }) },
  ]);
  await assert.rejects(() => imagineViaZhipu('x', 'k', f), /下载失败/);
});

test('画图端点护栏：空描述/缺密钥/Ollama未就绪/GET掩码，全程不碰网络', async () => {
  const { server, port } = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-')), port: 0, openBrowser: false, env: { NO_AUTOSTART: '1' } });
  const B = `http://127.0.0.1:${port}`;
  const J = { 'Content-Type': 'application/json' };
  try {
    // 空描述 → 400
    let r = await fetch(`${B}/api/imagine`, { method: 'POST', headers: J, body: JSON.stringify({ prompt: '  ' }) });
    assert.equal(r.status, 400);
    // 云端通道但没密钥 → 400（明确指向设置）
    r = await fetch(`${B}/api/imagine`, { method: 'POST', headers: J, body: JSON.stringify({ prompt: '一只橘猫' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /智谱 API Key|还没填/);
    // 切 ollama 通道（机器上没装）→ 502 带指引
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'ollama' }) });
    r = await fetch(`${B}/api/imagine`, { method: 'POST', headers: J, body: JSON.stringify({ prompt: '一只橘猫' }) });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /Ollama/);
    // GET settings 掩码：存了密钥也不回传原文
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'zhipu', imagineKey: 'SECRET-KEY-123' }) });
    const s = await (await fetch(`${B}/api/settings`)).json();
    assert.equal(s.imagineKey, undefined, '密钥绝不回传');
    assert.equal(s.imagineKeySet, true);
  } finally {
    await new Promise((res) => server.close(res));
  }
});
