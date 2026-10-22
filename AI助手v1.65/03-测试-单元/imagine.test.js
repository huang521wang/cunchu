import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imagineViaZhipu, imagineViaPollinations, startServer } from '../server/server.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('零密钥通道：出图成功/非图片拒收/HTTP错报人话（全程假 fetch 不出网）', async () => {
  const pic = await imagineViaPollinations('橘猫', async () => ({
    ok: true,
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  }));
  assert.equal(pic.mime, 'image/png');
  assert.ok(pic.buf.length > 0);
  await assert.rejects(
    () => imagineViaPollinations('x', async () => ({ ok: true, arrayBuffer: async () => Buffer.from('rate limited').buffer })),
    /没给图|限流/,
  );
  await assert.rejects(() => imagineViaPollinations('x', async () => ({ ok: false, status: 503 })), /503/);
});

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
    // status 报出真实生效通道：无 Key 的 auto = pollinations 零密钥兜底（永远能画）
    let st = await (await fetch(`${B}/api/imagine/status`)).json();
    assert.equal(st.activeChannel, 'pollinations');
    // 通道切换四态：pollinations 显式档可通过校验并生效
    const cp = await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'pollinations' }) });
    assert.equal(cp.status, 200);
    st = await (await fetch(`${B}/api/imagine/status`)).json();
    assert.equal(st.activeChannel, 'pollinations', '显式锁定零密钥通道后不再碰智谱');
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'auto' }) });
    // 显式指定 zhipu 但没 Key → 400 教装 Key（不碰外网）
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'zhipu' }) });
    r = await fetch(`${B}/api/imagine`, { method: 'POST', headers: J, body: JSON.stringify({ prompt: '一只橘猫' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Key|密钥/);
    // 切回 auto 后 status 又回到兜底通道
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'auto' }) });
    st = await (await fetch(`${B}/api/imagine/status`)).json();
    assert.equal(st.activeChannel, 'pollinations');
    // 切 ollama 通道（机器上没装）→ 502 带指引
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'ollama' }) });
    r = await fetch(`${B}/api/imagine`, { method: 'POST', headers: J, body: JSON.stringify({ prompt: '一只橘猫' }) });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /Ollama/);
    // GET settings 掩码：存了密钥也不回传原文（用"格式真实、值是假"的 Key）
    await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineProvider: 'zhipu', imagineKey: 'a'.repeat(32) + '.' + 'b'.repeat(16) }) });
    const s = await (await fetch(`${B}/api/settings`)).json();
    assert.equal(s.imagineKey, undefined, '密钥绝不回传');
    assert.equal(s.imagineKeySet, true);
    // 防呆：脏 Key（中文/没点号）拒收并说人话——不再让假钥匙装进设置里
    const dirty = await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineKey: '测试中文' }) });
    assert.equal(dirty.status, 400);
    assert.match((await dirty.json()).error, /不像智谱 Key/);
    const nodot = await fetch(`${B}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ imagineKey: 'abcdefghij1234567890' }) });
    assert.equal(nodot.status, 400, '没点号的也拒');
  } finally {
    await new Promise((res) => server.close(res));
  }
});
