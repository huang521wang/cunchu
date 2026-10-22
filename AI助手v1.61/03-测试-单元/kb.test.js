import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, detectAssistantAction } from '../server/server.js';

/* ---------- 口令识别：用户亲口"记进知识库" → kb 动作（服务端与 QQ 桥共用） ---------- */
test('识别知识库指令：亲口吩咐=直接入库通道', () => {
  assert.equal(detectAssistantAction('记进知识库：我讨厌开会拖延', '2026-10-21')?.kind, 'kb');
  assert.equal(detectAssistantAction('知识：云助手地域必须选杭州', '2026-10-21')?.kind, 'kb');
  assert.equal(detectAssistantAction('存进知识库：模型端口表', '2026-10-21')?.kind, 'kb');
  assert.equal(detectAssistantAction('记进知识库：直接入库', '2026-10-21').text, '直接入库');
  // 普通"记住"仍走记忆树，不抢
  assert.equal(detectAssistantAction('记住我不吃香菜', '2026-10-21')?.kind, 'memory');
});

/* ---------- 直写端点：/api/kb/add 用户授权通道（与 MCP 申请通道相对） ---------- */
test('知识库直写：/api/kb/add 直接入库并重建索引', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbadd-'));
  process.env.KB_ROOT = dir;
  try {
    fs.mkdirSync(path.join(dir, '01-用户画像'), { recursive: true });
    fs.mkdirSync(path.join(dir, '02-习惯与规矩'), { recursive: true });
    const { server, port } = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kbadddb-')), port: 0, openBrowser: false });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/kb/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '我不喜欢开会拖延，安排事情要直接定时间。' }),
      });
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.category, '01-用户画像', '含"我不喜欢"应归 01（若该分类不存在则兜底 03）');
    } finally {
      await new Promise((res) => server.close(res));
    }
  } finally {
    delete process.env.KB_ROOT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 审批流（真起服务，KB_ROOT 指临时目录，绝不碰真库） ---------- */
test('知识库审批：申请→批准入库重建索引；驳回进已驳回堆', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  process.env.KB_ROOT = dir;
  try {
    // 预置一个分类（模拟正式库结构）+ 一条待审申请
    fs.mkdirSync(path.join(dir, '01-用户画像'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_待审区'), { recursive: true });
    const mkPending = (id) => {
      const rec = { at: new Date().toISOString(), from: 'mcp', category: '01-用户画像', id, title: `测试条目${id}`, tags: ['测试'], body: '## 一句话\n内容' };
      fs.writeFileSync(path.join(dir, '_待审区', `p-${id}.json`), JSON.stringify(rec));
      return `p-${id}.json`;
    };
    const { server, port } = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kbdb-')), port: 0, openBrowser: false });
    const B = `http://127.0.0.1:${port}`;
    const J = { 'Content-Type': 'application/json' };
    try {
      // 列表能看到
      const f1 = mkPending('alpha');
      let list = await (await fetch(`${B}/api/kb/pending`)).json();
      assert.equal(list.items.length, 1);

      // 批准 → 正式库出现 .md，索引含它，申请消失
      const r = await fetch(`${B}/api/kb/approve`, { method: 'POST', headers: J, body: JSON.stringify({ file: f1 }) });
      assert.equal(r.status, 200);
      assert.ok(fs.existsSync(path.join(dir, '01-用户画像', 'alpha.md')));
      const md = fs.readFileSync(path.join(dir, '01-用户画像', 'alpha.md'), 'utf8');
      assert.ok(md.startsWith('---') && md.includes('权限: 只读'), '入库必须带标准 front-matter 与只读声明');
      assert.ok(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8').includes('alpha'));
      list = await (await fetch(`${B}/api/kb/pending`)).json();
      assert.equal(list.items.length, 0);

      // 分类不存在的申请 → 拒绝且不动库
      const bad = path.join(dir, '_待审区', 'p-bad.json');
      fs.writeFileSync(bad, JSON.stringify({ category: '99-瞎写', id: 'x', title: 't', body: 'b' }));
      const r2 = await fetch(`${B}/api/kb/approve`, { method: 'POST', headers: J, body: JSON.stringify({ file: 'p-bad.json' }) });
      assert.equal(r2.status, 400);
      assert.ok(!fs.existsSync(path.join(dir, '99-瞎写')));

      // 驳回 → 移进已驳回
      const f3 = mkPending('gamma');
      const r3 = await fetch(`${B}/api/kb/reject`, { method: 'POST', headers: J, body: JSON.stringify({ file: f3 }) });
      assert.ok(r3.ok);
      assert.ok(fs.readdirSync(path.join(dir, '_待审区', '已驳回')).some((x) => x.includes('gamma')));

      // 路径穿越防呆：approve 带 ../ 想偷读系统文件 → 失败不崩
      const r4 = await fetch(`${B}/api/kb/approve`, { method: 'POST', headers: J, body: JSON.stringify({ file: '../../../../Windows/win.ini' }) });
      assert.equal(r4.status, 400);
    } finally {
      await new Promise((res) => server.close(res));
    }
  } finally {
    delete process.env.KB_ROOT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- MCP 服务器：握手、工具、只读保证、申请落区 ---------- */
function mcpSession(root, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['D:/知识库/mcp/server.mjs'], { env: { ...process.env, KB_ROOT: root, KB_WB: 'http://127.0.0.1:9' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line));
      }
    });
    child.stderr.on('data', () => {});
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    (async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      await new Promise((r) => setTimeout(r, 250));
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      for (const c of calls) {
        send({ jsonrpc: '2.0', id: 10 + c.n, method: 'tools/call', params: { name: c.tool, arguments: c.args } });
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.end();
      child.kill();
      resolve(out);
    })().catch(reject);
  });
}

test('MCP：握手、五工具、正式库只读（无任何删改工具）、申请进待审区', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbmcp-'));
  try {
    fs.mkdirSync(path.join(dir, '01-用户画像'), { recursive: true });
    fs.writeFileSync(path.join(dir, '01-用户画像', 'who.md'), '---\nid: 01-用户画像/who\n分类: 01-用户画像\n标题: 用户速览\n标签: 测试\n更新: 2026-10-21\n权限: 只读\n---\n\n## 一句话\n速览正文\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# 说明书');
    const msgs = await mcpSession(dir, [
      { n: 0, tool: 'kb_read', args: { id: '01-用户画像/who' } },
      { n: 1, tool: 'kb_search', args: { query: '速览' } },
      { n: 2, tool: 'kb_pending_add', args: { category: '01-用户画像', id: 'newbie', title: '新知识', body: '## 一句话\nx', reason: '测试' } },
      { n: 3, tool: 'kb_pending_add', args: { category: '99-不存在', id: 'evil', title: '瞎分类', body: 'x' } },
    ]);
    const init = msgs.find((m) => m.id === 1);
    assert.equal(init.result.serverInfo.name, 'alon-knowledge-base');
    const tools = msgs.find((m) => m.id === 2).result.tools.map((t) => t.name);
    assert.deepEqual(tools.sort(), ['kb_list', 'kb_overview', 'kb_pending_add', 'kb_read', 'kb_search']);
    assert.ok(!tools.some((t) => /delete|remove|update|edit|write_/i.test(t)), '协议层就没有删改工具——只读是设计');
    const read = msgs.find((m) => m.id === 10);
    assert.ok(read.result.content[0].text.includes('速览正文'));
    const search = msgs.find((m) => m.id === 11);
    assert.ok(search.result.content[0].text.includes('who'));
    const pend = msgs.find((m) => m.id === 12);
    assert.ok(pend.result.content[0].text.includes('已提交申请'));
    assert.equal(fs.readdirSync(path.join(dir, '_待审区')).filter((f) => f.endsWith('.json')).length, 1, '合法申请落待审区');
    const evil = msgs.find((m) => m.id === 13);
    assert.ok(evil.result.content[0].text.includes('拒绝'));
    // 正式库一字未动
    assert.ok(fs.readFileSync(path.join(dir, '01-用户画像', 'who.md'), 'utf8').includes('速览正文'));
    assert.ok(!fs.existsSync(path.join(dir, '01-用户画像', 'newbie.md')), '申请绝不直接进正式库');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
