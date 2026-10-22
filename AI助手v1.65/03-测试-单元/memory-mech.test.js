import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, similarity, guessMemoryBranch, boostMemoryIfMatched } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-mem-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('记忆工具：相似度/分支猜测/加强', () => {
  assert.equal(similarity('我周末不接工作电话', '我周末不接工作电话'), 1);
  assert.ok(similarity('我周末不接工作电话', '周末我不接工作电话') > 0.5);
  assert.ok(similarity('完全无关的内容', '另一个话题') < 0.5);
  assert.equal(guessMemoryBranch('我喜欢低饱和的配色'), 'preference');
  assert.equal(guessMemoryBranch('我在做小程序项目'), 'work');
  assert.equal(guessMemoryBranch('我住在成都'), 'about');
  const list = [{ text: '我住在成都', weight: 1, updatedAt: '2026-01-01T00:00:00Z' }];
  // 双阈值语义（v2.1 修订）：换措辞的"疑似重复"（sim~0.67）不再静默吞掉——放行新增；
  // 倒装/加标点这类近逐字重复（sim≥0.85）才只加强
  assert.equal(boostMemoryIfMatched(list, '对了我在成都'), false);
  assert.equal(list[0].weight, 1);
  assert.equal(boostMemoryIfMatched(list, '我住在成都。'), true);
  assert.equal(list[0].weight, 2);
  assert.equal(boostMemoryIfMatched(list, '成都我住在'), true);
  assert.equal(list[0].weight, 3);
  assert.equal(boostMemoryIfMatched(list, '今晚吃什么'), false);
  // 回归：同话题的不同事实（实测旧阈值 0.55 会误吞的 frps/Defender 对，sim=0.71）必须放行
  const topic = [{ text: '入口软件是frps+Caddy（装C:\\aiworkbench-entry），计划任务开机自启，已设Defender白名单', weight: 1, updatedAt: '2026-01-01T00:00:00Z' }];
  assert.equal(
    boostMemoryIfMatched(
      topic,
      '服务器装了frps.exe会被Windows Defender当病毒删，必须保留C:\\aiworkbench-entry白名单；改了Caddyfile要重启caddy任务才生效',
    ),
    false,
  );
});

test('记忆保存：与旧记忆相似 → 只加强不新增；新内容 → 入树带权重与猜测分支', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const save = (body) => fetch(`${t.base}/api/memory/save`, { method: 'POST', headers: J, body: JSON.stringify(body) }).then((r) => r.json());
    await save({ text: '我不喜欢开会' });
    const memories1 = await (await fetch(`${t.base}/api/memories`)).json();
    assert.equal(memories1.length, 1);
    assert.equal(memories1[0].weight, 1);
    assert.equal(memories1[0].branch, 'preference');
    assert.equal(memories1[0].source, 'discover');

    // 再来一条相似 → 加强
    const r2 = await save({ text: '开会我不喜欢' });
    assert.equal(r2.boosted, true);
    assert.equal(r2.saved, null);
    const memories2 = await (await fetch(`${t.base}/api/memories`)).json();
    assert.equal(memories2.length, 1);
    assert.equal(memories2[0].weight, 2);
  } finally {
    await t.close();
  }
});

test('记忆 2.0：静默自动保存 + 全量去重 + 冲突才待确认 + 文件落盘 + 撤销 + 配额 + 可关', async () => {
  const dir = tmpDir();
  const memDir = path.join(dir, 'memory-files');
  let nextAnswer = ['我下周三要答辩', '我喜欢蓝色'];
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
      if (sys.includes('记忆整理助手')) content = nextAnswer.join('\n');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const t = await boot(dir);
  const discover = (text) =>
    fetch(`${t.base}/api/memory/discover`, { method: 'POST', headers: J, body: JSON.stringify({ text }) }).then((r) => r.json());
  const memories = () => fetch(`${t.base}/api/memories`).then((r) => r.json());
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ modelApi: { baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, model: 'stub' } }),
    });

    // ① 静默自动保存：不再进待确认
    const d1 = await discover('我下周三要答辩，我喜欢蓝色');
    assert.equal(d1.pending.length, 0, '正常内容不打扰（不进待确认）');
    const m1 = await memories();
    assert.equal(m1.length, 2, '两条都自动记下');
    assert.ok(m1.every((m) => m.file && fs.existsSync(path.join(memDir, m.file))), '每条都落成记忆文件');
    assert.equal(d1.quotaLeft, 1, '每小时 3 次配额，已用 2');

    // ② 去重：同内容再发现 → 不新增
    await discover('我下周三要答辩，我喜欢蓝色');
    const m2 = await memories();
    assert.equal(m2.length, 2, '重复内容绝不新增');

    // ③ 质量过滤：碎片不记
    nextAnswer = ['值得记住：', '我住在北京'];
    await discover('闲聊');
    const m3 = await memories();
    assert.equal(m3.length, 3, '碎片被过滤，只记了「我住在北京」');
    assert.ok(!m3.some((m) => m.text.includes('值得记住')));

    // ④ 冲突才打扰：模型明确标「冲突：」→ 进待确认（即使文字相似）
    nextAnswer = ['冲突：我喜欢红色'];
    const d3 = await discover('其实我喜欢红色');
    assert.equal(d3.pending.length, 1, '疑似冲突进待确认');
    assert.equal(d3.pending[0].text, '我喜欢红色');

    // ⑤ ask 模式：全部进待确认，不自动写
    await fetch(`${t.base}/api/settings`, { method: 'PUT', headers: J, body: JSON.stringify({ memoryMode: 'ask' }) });
    nextAnswer = ['我养了一只猫'];
    const d4 = await discover('我养了一只猫');
    assert.equal(d4.pending.length, 2, 'ask 模式两条都待确认');
    const m4 = await memories();
    assert.equal(m4.length, 3, 'ask 模式下不自动写入');

    // ⑥ 撤销：删索引 + 删文件
    const target = m3.find((m) => m.text === '我住在北京');
    const targetFile = path.join(memDir, target.file);
    assert.ok(fs.existsSync(targetFile));
    await fetch(`${t.base}/api/memory/undo`, { method: 'POST', headers: J, body: JSON.stringify({ id: target.id }) });
    const m5 = await memories();
    assert.equal(m5.length, 2);
    assert.ok(!fs.existsSync(targetFile), '撤销同时删掉文件');

    // ⑦ 关掉自动发现 → 不产生
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ autoMemory: false, memoryMode: 'auto' }),
    });
    nextAnswer = ['我明天要交周报'];
    const d5 = await discover('我明天要交周报');
    assert.equal(d5.pending.length, 2, '关掉后不再新增待确认（旧的 2 条还在队列里）');
    const m6 = await memories();
    assert.equal(m6.length, 2, '关掉后也不再自动写入');
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});test('注入排序：强度高的记忆排在前面', async () => {
  const dir = tmpDir();
  const captured = { messages: null };
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      }
      captured.messages = JSON.parse(raw || '{}').messages;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
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
    await fetch(`${t.base}/api/memories`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ branch: 'life', text: '低权重的记忆乙', pinned: false, source: 'manual', weight: 1 }),
    });
    await fetch(`${t.base}/api/memories`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ branch: 'life', text: '高权重的记忆甲', pinned: false, source: 'manual', weight: 4 }),
    });
    await fetch(`${t.base}/api/chat`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    const sys = captured.messages.filter((m) => m.role === 'system').find((m) => m.content.includes('记忆乙'));
    assert.ok(sys, '应有记忆注入');
    assert.ok(
      sys.content.indexOf('高权重的记忆甲') < sys.content.indexOf('低权重的记忆乙'),
      '强度高的记忆应排在前面',
    );
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});
