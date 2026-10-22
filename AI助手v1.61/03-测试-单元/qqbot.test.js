import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandAnswer,
  clip,
  validateConfig,
  parseEvent,
  replyPath,
  parseConfirm,
  remember,
  historyOf,
  INTENTS,
  HELP_TEXT,
} from '../tools/qqbot/bridge.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDay = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ds(d);
};

test('机器人问答：今天/日报 返回简报', () => {
  const data = { briefing: '🌸 工作台日报 · 测试' };
  assert.equal(commandAnswer('今天', data), '🌸 工作台日报 · 测试');
  assert.equal(commandAnswer('日报', data), '🌸 工作台日报 · 测试');
  assert.equal(commandAnswer('<@!12345678> 今天', data), '🌸 工作台日报 · 测试'); // @标记会被去掉
  assert.equal(commandAnswer('<@!12345678> 今天呀', data), '🌸 工作台日报 · 测试'); // 宽容匹配：带语气词也认
});

test('机器人问答：明天 → 只列明天截止的作业', () => {
  const tmr = addDay(1);
  const data = {
    briefing: '',
    studyItems: [
      { title: '实验报告', course: '物理', due: tmr, done: false },
      { title: '后天的事', due: addDay(2), done: false },
      { title: '已完成的', due: tmr, done: true },
    ],
  };
  const r = commandAnswer('明天', data);
  assert.ok(r.includes('实验报告（物理）'));
  assert.ok(!r.includes('后天的事'));
  assert.ok(!r.includes('已完成的'));
  assert.equal(commandAnswer('明天', { briefing: '', studyItems: [] }), '明天没有截止的作业，轻松一点 🌸');
});

test('机器人问答：作业 → 按截止时间升序列未完成项', () => {
  const data = {
    briefing: '',
    studyItems: [
      { title: '乙作业', due: addDay(3), done: false },
      { title: '甲作业', course: '高数', due: addDay(1), done: false },
      { title: '无日期的', due: '', done: false },
      { title: '做完的', due: addDay(1), done: true },
    ],
  };
  const r = commandAnswer('作业', data);
  const iA = r.indexOf('甲作业');
  const iB = r.indexOf('乙作业');
  const iN = r.indexOf('无日期的');
  assert.ok(iA > 0 && iB > iA && iN > iB, '顺序应为：有日期的在前（按截止升序）、无日期的在后');
  assert.ok(!r.includes('做完的'));
  assert.equal(commandAnswer('学习', { briefing: '', studyItems: [] }), '学习任务都清完啦 🎉');
});

test('机器人问答：任务 → 只列今天未完成', () => {
  const today = ds(new Date());
  const data = {
    briefing: '',
    tasks: [
      { title: '今天要交的方案', date: today, done: false },
      { title: '明天的事', date: addDay(1), done: false },
      { title: '今天做完的', date: today, done: true },
    ],
  };
  const r = commandAnswer('任务', data);
  assert.ok(r.includes('今天要交的方案'));
  assert.ok(!r.includes('明天的事'));
  assert.ok(!r.includes('今天做完的'));
  assert.equal(commandAnswer('待办', { briefing: '', tasks: [] }), '今天没有待办任务，享受一天吧 🌸');
});

test('机器人问答：不是命令的话交给 AI 聊天；「帮助」给说明', () => {
  assert.equal(commandAnswer('你好呀', { briefing: 'x' }), null); // → 送去聊天
  assert.equal(commandAnswer('帮我写个周报', {}), null);
  assert.equal(commandAnswer('', {}), HELP_TEXT);
  assert.equal(commandAnswer('帮助', {}), HELP_TEXT);
  assert.ok(HELP_TEXT.includes('聊天') || HELP_TEXT.includes('直接聊'));
});

test('确认/取消的识别（只在"有动作待确认"时使用）', () => {
  assert.equal(parseConfirm('1'), 'yes');
  assert.equal(parseConfirm('确认'), 'yes');
  assert.equal(parseConfirm('好的'), 'yes');
  assert.equal(parseConfirm('2'), 'no');
  assert.equal(parseConfirm('取消'), 'no');
  assert.equal(parseConfirm('算了'), 'no');
  assert.equal(parseConfirm('那明天呢'), null);
  assert.equal(parseConfirm(''), null);
});

test('最近几轮上下文：最多保留 3 问 3 答', () => {
  const hist = new Map();
  const key = 'c2c:someone';
  for (let i = 1; i <= 5; i++) {
    remember(hist, key, 'user', `问${i}`);
    remember(hist, key, 'assistant', `答${i}`);
  }
  const list = historyOf(hist, key);
  assert.equal(list.length, 6);
  assert.equal(list[0].content, '问3');
  assert.equal(list[5].content, '答5');
  assert.deepEqual(historyOf(hist, 'never'), []);
});

test('回复太长会截断', () => {
  const long = 'a'.repeat(2000);
  const c = clip(long);
  assert.ok(c.length <= 900);
  assert.ok(c.includes('太长啦'));
  assert.equal(clip('短内容'), '短内容');
});

test('配置校验：缺 AppID 和密钥都报出来；填好就没问题', () => {
  const p1 = validateConfig({ appId: '', secret: '', token: '' });
  assert.equal(p1.length, 2);
  assert.ok(p1[0].includes('appId'));
  assert.ok(p1[1].includes('secret'));
  assert.equal(validateConfig({ appId: '102345678', secret: 'abc1234567890' }).length, 0);
  assert.equal(validateConfig({ appId: '102345678', token: 'abc1234567890' }).length, 0);
  assert.equal(validateConfig({ appId: 'abc', secret: 'abc1234567890' }).length, 1);
});

test('事件解析与回复路径：群/单聊/频道/频道私信', () => {
  const g = parseEvent('GROUP_AT_MESSAGE_CREATE', { group_openid: 'G1', content: '<@!1> 今天', id: 'M1' });
  assert.deepEqual(g, { kind: 'group', target: 'G1', text: '<@!1> 今天', msgId: 'M1', attachments: [] });
  assert.equal(replyPath(g), '/v2/groups/G1/messages');

  // 图片附件原样带出（QQ 收图通道用）
  const gi = parseEvent('GROUP_AT_MESSAGE_CREATE', { group_openid: 'G2', content: '', id: 'M9', attachments: [{ url: 'http://x/1.png', content_type: 'image/png' }] });
  assert.deepEqual(gi.attachments, [{ url: 'http://x/1.png', content_type: 'image/png' }]);

  const c = parseEvent('C2C_MESSAGE_CREATE', { author: { user_openid: 'U1' }, content: '今天', id: 'M2' });
  assert.equal(c.kind, 'c2c');
  assert.equal(replyPath(c), '/v2/users/U1/messages');

  const ch = parseEvent('AT_MESSAGE_CREATE', { channel_id: 'C1', content: 'hi', id: 'M3' });
  assert.equal(ch.kind, 'channel');
  assert.equal(replyPath(ch), '/channels/C1/messages');

  const dm = parseEvent('DIRECT_MESSAGE_CREATE', { guild_id: 'D1', content: 'hi', id: 'M4' });
  assert.equal(dm.kind, 'dms');
  assert.equal(replyPath(dm), '/dms/D1/messages');

  assert.equal(parseEvent('SOMETHING_ELSE', {}), null);
  assert.equal(parseEvent('C2C_MESSAGE_CREATE', { author: {}, content: 'x' }).target, undefined);
});

test('意图位与官方定义一致', () => {
  assert.equal(INTENTS.GROUP_AT_MESSAGE_CREATE, 1 << 25);
  assert.equal(INTENTS.C2C_MESSAGE_CREATE, 1 << 26);
  assert.equal(INTENTS.PUBLIC_GUILD_MESSAGES, 1 << 30);
  assert.equal(INTENTS.DIRECT_MESSAGE, 1 << 12);
});

test('多账号推送状态：记住每个聊过的 QQ 号（去重、保最近 6 个、频道不可推）', async () => {
  const { rememberTarget, pushPathOf } = await import('../tools/qqbot/bridge.mjs');
  const st = { targets: [] };
  for (let i = 0; i < 5; i++) rememberTarget(st, { kind: 'c2c', target: 'userA', msgId: 'MID' + i }, i + 1);
  assert.equal(st.targets.length, 1, '同一账号反复来只留最新一条');
  assert.equal(st.targets[0].msgId, 'MID4', '锚点要刷新到最后一条消息');
  assert.equal(st.targets[0].seq, 0, '换 msgId 后序号必须重置（旧 seq 沿用会被 400 拒——上次的 bug）');
  // 同一 msgId 再来：seq 保留并取 max
  rememberTarget(st, { kind: 'c2c', target: 'userA', msgId: 'MID4' }, 3);
  assert.equal(st.targets[0].seq, 3, '同 msgId 续用时序号跟随全局值')
  for (let i = 0; i < 8; i++) rememberTarget(st, { kind: 'c2c', target: 'u' + i, msgId: 'X' + i }, 0);
  assert.equal(st.targets.length, 6, '最多记 6 个账号');
  assert.equal(st.targets[st.targets.length - 1].target, 'u7', '最新的排最后');
  assert.ok(pushPathOf({ kind: 'c2c' }).includes('/users/'));
  assert.ok(pushPathOf({ kind: 'group' }).includes('/groups/'));
  assert.equal(pushPathOf({ kind: 'dms' }), null, '频道类不支持被动推送，返回 null 跳过');
});
