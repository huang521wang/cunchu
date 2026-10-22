import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { looksLikeXxt, parseXxtNotice, parseDueDate, parseCourse, buildDraftPrompt, redact, noticeToLine } from '../server/xuexitong.js';
import { pollMailbox } from '../server/mailwatch.js';
import { startServer, buildXxtContext, pruneXxtHomeworks } from '../server/server.js';

const J = { 'Content-Type': 'application/json' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-xxt-'));
}

async function boot(dir) {
  process.env.MEMORY_DIR = path.join(dir, 'memory-files');
  const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/* ---------- 纯解析 ---------- */

test('解析：认出学习通邮件 / 拒绝无关邮件', () => {
  assert.equal(looksLikeXxt('学习通 <service@chaoxing.com>', '作业提醒', '你有一份新作业'), true);
  assert.equal(looksLikeXxt('某某公众号 <news@weixin.qq.com>', '双十一大促', '买买买'), false);
});

test('解析：作业/签到/考试/成绩 → 结构化（课程/标题/截止全对）', () => {
  const hw = parseXxtNotice({
    from: '学习通 <service@chaoxing.com>',
    subject: '【高等数学】作业提醒：第三章课后习题',
    text: '您在课程【高等数学】中有一份作业「第三章课后习题」需要提交，截止 2026年10月24日 23:59，请按时完成。',
  });
  assert.equal(hw.kind, 'homework');
  assert.equal(hw.course, '高等数学');
  assert.equal(hw.due, '2026-10-24');
  assert.ok(hw.title.includes('第三章课后习题'));

  const ci = parseXxtNotice({ subject: '签到通知', text: '【大学英语】老师发起了课堂签到，请尽快签到' });
  assert.equal(ci.kind, 'checkin');
  assert.equal(ci.course, '大学英语');

  // 边界（实机验收发现的坑）："跑步打卡"这类作业标题含"打卡"，不能被签到规则误伤
  const hw2 = parseXxtNotice({ subject: '【体育】作业提醒：跑步打卡', text: '课程【体育】作业跑步打卡，截止 10月28日 22:00' });
  assert.equal(hw2.kind, 'homework', '含"打卡"的作业必须判成作业而非签到');
  assert.equal(hw2.course, '体育');

  assert.equal(parseXxtNotice({ subject: '期中考试安排通知', text: '请大家注意考试时间' }).kind, 'exam');
  assert.equal(parseXxtNotice({ subject: '成绩发布', text: '你的课程成绩已发布' }).kind, 'grade');
  assert.equal(noticeToLine(ci), '学习通·签到：《大学英语》签到通知');
});

test('解析：日期格式五花八门都能提（年份按"今年或明年"稳定判定）', () => {
  const thisYear = new Date().getFullYear();
  const ymd = (s) => assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s), `格式应为 YYYY-MM-DD，得到 ${s}`);
  const d1 = parseDueDate('截止 10月25日 23:59前');
  ymd(d1);
  assert.ok(d1 === `${thisYear}-10-25` || d1 === `${thisYear + 1}-10-25`, '早于今天的日期顺延到明年');
  assert.equal(parseDueDate('2027.1.5 截止'), '2027-01-05');
  const d3 = parseDueDate('1月3日前提交');
  ymd(d3);
  assert.ok(d3 === `${thisYear}-01-03` || d3 === `${thisYear + 1}-01-03`);
  assert.equal(parseDueDate('没有日期'), '');
});

test('解析：课程提取三种写法', () => {
  assert.equal(parseCourse('【毛概】通知', ''), '毛概');
  assert.equal(parseCourse('《思想道德与法治》作业', ''), '思想道德与法治');
  assert.equal(parseCourse('通知', '课程名称： Python程序设计 发布了作业'), 'Python程序设计');
});

test('草稿提示词：大专生语料硬规则逐条在内', () => {
  const h = parseXxtNotice({ subject: '作业', text: '作业内容' });
  h.requirement = '手写的拍照片上传，不少于800字';
  const p = buildDraftPrompt({ name: '柳月虹', addressAs: '阿珑' }, h);
  assert.ok(p.includes('老师'));
  assert.ok(p.includes('首先/其次'));
  assert.ok(p.includes('大专学生'));
  assert.ok(p.includes('不编造'));
  assert.ok(p.includes('不少于800字'));
  // 人设壳已移除：草稿只交作业正文，不套"你是某某"扮演（阿珑：直接做别废话）
  assert.ok(!p.includes('你是「'), '不得再套人设壳');
  assert.ok(p.includes('禁止开场白') && p.includes('角色扮演'), '必须明令禁止话痨和扮演');
});

test('脱敏：授权码绝不进日志', () => {
  assert.equal(redact('登录失败 password=abcdef123456 断开', ['abcdef123456']), '登录失败 password=**** 断开');
});

/* ---------- 监听引擎（注入假邮件） ---------- */

test('引擎：开关关/配置缺/拉取抛错——全都不崩，返回如实', async () => {
  assert.equal((await pollMailbox({ enabled: false }, { fetchMail: async () => { throw new Error('不该被调'); }, onNotice: () => {} })).skipped, 'off');
  const r1 = await pollMailbox({ enabled: true, host: '', user: '', authCode: '' }, { fetchMail: async () => ({ mails: [] }), onNotice: () => {} });
  assert.equal(r1.ok, false);
  const r2 = await pollMailbox({ enabled: true, host: 'imap.qq.com', user: 'a@qq.com', authCode: 'x' }, { fetchMail: async () => { throw new Error('网络炸了'); }, onNotice: () => {} });
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('网络炸了'));
});

test('引擎：假邮箱一轮——学习通入库、无关跳过、水位线推进', async () => {
  const got = [];
  const mails = [
    { uid: 5, from: '学习通 <s@chaoxing.com>', subject: '作业提醒', text: '【体育】作业：跑步打卡' },
    { uid: 6, from: '垃圾邮件 <a@b.com>', subject: '发票', text: '电子发票' },
    { uid: 7, from: '学习通 <s@chaoxing.com>', subject: '签到', text: '【历史】签到开始' },
  ];
  const r = await pollMailbox(
    { enabled: true, host: 'x', user: 'u', authCode: 'a', lastUid: 5 },
    {
      fetchMail: async () => ({ mails, maxUid: 7 }),
      onNotice: (n) => got.push(n),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, '两封学习通入库，垃圾邮件被挡');
  assert.equal(r.lastUid, 7);
  assert.ok(got.every((n) => n.course === '体育' || n.course === '历史'));
});

/* ---------- 服务端全链路 ---------- */

test('全链路：模拟邮件→进通知+学习计划+草稿入队→QQ队列→确认/重做', async () => {
  const dir = tmpDir();
  // 桩模型：直接出"作业正文"（模拟大专生口吻的产物）
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
      const j = JSON.parse(raw || '{}');
      const hasNote = (j.messages || []).some((m) => m.role === 'user' && String(m.content).includes('方向'));
      return res.end(JSON.stringify({ choices: [{ message: { content: hasNote ? 'REDO-短一点的作业正文。' : '这作业我认真做了，写了八百来字，感觉挺有收获的。' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const t = await boot(dir);
  const get = (p) => fetch(`${t.base}${p}`).then((r) => r.json());
  const post = (p, body) => fetch(`${t.base}${p}`, { method: 'POST', headers: J, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ models: [{ id: 'm1', name: '模型', type: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub' }], activeModelId: 'm1', autoRoute: false, autoManage: false }),
    });

    // ① 模拟一封作业邮件走真实管道
    const sim = await post('/api/mailwatch/simulate', {
      from: '学习通 <service@chaoxing.com>',
      subject: '【高等数学】作业提醒：第三章习题',
      text: '课程【高等数学】作业「第三章课后习题」截止 10月30日 23:00 提交，要求：手写拍照上传，不少于800字',
    });
    assert.equal(sim.added, 1, '邮件应被认出并入库');

    // ② 学习计划自动多了一条作业
    const items = await get('/api/studyItems');
    assert.ok(
      items.some((x) => x.title.includes('第三章') && x.course === '高等数学' && x.kind === '作业' && /-10-30$/.test(x.due)),
      '作业应自动进学习计划（截止月日正确）',
    );

    // ③ QQ 推送队列有作业通知（新短句文案：《课程》题目…我直接做了）；等草稿异步完成
    let q = await get('/api/qq/pending');
    assert.ok(q.queue.some((x) => x.text.includes('我直接做了')));

    let mw = await get('/api/mailwatch');
    for (let i = 0; i < 30 && (mw.homeworks[0] || {}).status === 'new'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      mw = await get('/api/mailwatch');
    }
    assert.equal(mw.homeworks[0].status, 'drafted', '草稿应已生成');
    assert.ok(mw.homeworks[0].draft.includes('八百来字'));

    // ④ 授权码不外泄：GET 只给 authCodeSet
    await fetch(`${t.base}/api/mailwatch`, { method: 'PUT', headers: J, body: JSON.stringify({ authCode: 'SECRET-CODE-999', user: 'a@qq.com' }) });
    const after = await fetch(`${t.base}/api/mailwatch`).then((r) => r.text());
    assert.ok(!after.includes('SECRET-CODE-999'), '授权码绝不能从接口读出');
    assert.ok(JSON.parse(after).config.authCodeSet === true);

    // ⑤ 确认 → 队列拿到全文
    const hid = mw.homeworks[0].id;
    const cf = await post('/api/xxt/confirm', { id: hid.slice(0, 8) });
    assert.equal(cf.ok, true);
    q = await get('/api/qq/pending');
    assert.ok(q.queue.some((x) => x.text.includes('八百来字')), '确认后全文推 QQ');
    assert.ok((await get('/api/mailwatch')).homeworks[0].status === 'confirmed');

    // ⑥ 重做（带方向）→ 新草稿
    await post('/api/xxt/redo', { id: hid.slice(0, 8), note: '短一点' });
    let mw2 = await get('/api/mailwatch');
    for (let i = 0; i < 30 && mw2.homeworks[0].status === 'new'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      mw2 = await get('/api/mailwatch');
    }
    assert.equal(mw2.homeworks[0].status, 'drafted');
    assert.ok(mw2.homeworks[0].draft.includes('REDO'), '重做用了新方向');

    // ⑦ 销号：队列里旧消息全部清除（之后 redo 新产生的推送不受影响）
    const oldIds = new Set(q.queue.map((x) => x.id));
    assert.ok(oldIds.size >= 2, '通知+确认两条应都在队列');
    await post('/api/qq/notified', { ids: [...oldIds] });
    const q2 = (await get('/api/qq/pending')).queue;
    assert.ok(q2.every((x) => !oldIds.has(x.id)), '销号后旧消息不再出现');

    // ⑧ 非法值拒绝（PUT 开关必须布尔）
    const bad = await fetch(`${t.base}/api/mailwatch`, { method: 'PUT', headers: J, body: JSON.stringify({ enabled: 'yes' }) });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
    await new Promise((r) => stub.close(r));
  }
});

test('全链路：非学习通邮件零打扰', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const sim = await fetch(`${t.base}/api/mailwatch/simulate`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ from: '商家 <promo@shop.com>', subject: '双十一大促', text: '全场五折' }),
    }).then((r) => r.json());
    assert.equal(sim.added, 0, '垃圾邮件不该进学习通');
  } finally {
    await t.close();
  }
});

test('simulate：无发件人但有学习通签名也认（真实通知常带落款）', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    const sim = await fetch(`${t.base}/api/mailwatch/simulate`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ subject: '作业提醒', text: '请在10月30日前提交\n—— 来自学习通' }),
    }).then((r) => r.json());
    assert.equal(sim.added, 1);
  } finally {
    await t.close();
  }
});

test('学习通通道：没连接就不注入（一个字符都不给模型）', () => {
  assert.equal(buildXxtContext({ xxt: {} }), '');
  assert.equal(buildXxtContext({ xxt: { cookie: 'x', status: 'off' } }), '');
  assert.equal(buildXxtContext({}), '');
});

test('学习通通道：连接后带状态、待办近况和已交计数', () => {
  const ctx = buildXxtContext({
    xxt: { cookie: 'x', status: 'synced', lastSyncAt: Date.now() },
    xxtHomeworks: [
      { course: '人工智能通识课', title: 'AI文案作业', due: '2026-10-28', status: 'drafted' },
      { course: '摄影测量基础', title: '水准测量', status: 'submit_failed' },
      { course: '无人机驾驶', title: '航线设计', status: 'submitted' },
      { course: '森林调查', title: '地形图', status: 'new' },
    ],
    xxtNotices: [{ kind: 'exam', title: '期中测验', at: Date.now() }],
  });
  assert.match(ctx, /学习通近况/);
  assert.match(ctx, /AI文案作业/);
  assert.match(ctx, /草稿已备好/);
  assert.match(ctx, /上次提交没成/);
  assert.match(ctx, /期中测验/);
  assert.match(ctx, /已交进学习通：1 份/);
  assert.ok(!ctx.includes('- 《无人机驾驶》航线设计｜'), '已交的不再列进待办');
});

test('学习通通道：登录过期要如实告诉模型（免得它拿旧数据装在线）', () => {
  const ctx = buildXxtContext({ xxt: { cookie: 'x', status: 'need_login' }, xxtHomeworks: [] });
  assert.match(ctx, /登录态过期/);
});

test('作业列表修剪：没交的一条不丢；交完/失败满 30 天才清（旧版一刀切 20 条丢单）', () => {
  const old = Date.now() - 40 * 24 * 3600000;
  const kept = pruneXxtHomeworks([
    { id: '1', status: 'drafted', createdAt: old, updatedAt: old },
    { id: '2', status: 'submitted', createdAt: old, updatedAt: old },
    { id: '3', status: 'submitted', createdAt: Date.now(), updatedAt: Date.now() },
    { id: '4', status: 'confirmed', createdAt: old, updatedAt: old },
    { id: '5', status: 'failed', createdAt: old, updatedAt: old },
  ]).map((x) => x.id);
  assert.deepEqual(kept, ['1', '3', '4'], '未了结（含已确认待交）永远保留，老死条目才清');
});
