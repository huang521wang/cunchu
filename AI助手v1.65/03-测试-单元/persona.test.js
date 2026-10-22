import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng,
  buildPersonaSystem,
  tickPersona,
  scheduleIdle,
  makeThought,
  makeDream,
  mergeTraits,
  computeWakeLine,
  impressionFromStats,
  wakeGreeting,
} from '../server/persona.js';

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function basePersona(over = {}) {
  return {
    name: '柳月虹',
    addressAs: '阿珑',
    freedom: 'free',
    traits: [],
    thoughts: [],
    dreams: [],
    lastActiveAt: iso(now - 10 * 60 * 1000),
    energy: 0.6,
    chatsSinceReflect: 0,
    state: 'online',
    nextAt: now - 1000, // 已到"该发呆"的时间，方便测试推进
    ...over,
  };
}

test('人设提示词：名字/称呼/性格大纲/底线都在', () => {
  const s = buildPersonaSystem(basePersona());
  assert.ok(s.includes('柳月虹'));
  assert.ok(s.includes('阿珑'));
  assert.ok(s.includes('不装真人'));
  assert.ok(s.includes('想改必须先问'));
  // 用户钦定的性格大纲必须逐条注入
  assert.ok(s.includes('俏皮可爱'));
  assert.ok(s.includes('话多'));
  assert.ok(s.includes('喜欢吃'));
  assert.ok(s.includes('爱睡觉'));
  assert.ok(s.includes('做梦'));
  assert.ok(s.includes('发呆'));
  assert.ok(s.includes('主动问用户'));
  assert.ok(s.includes('详细明了'));
  assert.ok(s.includes('小表情'));
  const withTraits = buildPersonaSystem(basePersona({ traits: [{ text: '喜欢用比喻', weight: 2 }] }));
  assert.ok(withTraits.includes('喜欢用比喻'));
});

test('状态机 v2：闲下来随机滑进小状态（发呆/话多/嘴馋/滑睡），小状态都带主动发言', () => {
  // 确定性链路：发呆→打盹→睡觉（手动置 daze 测转场）
  const rng = makeRng(42);
  const p = basePersona({ state: 'daze', nextAt: now - 1 });
  const r2 = tickPersona(p, {}, now, false, rng);
  assert.equal(r2.state, 'nap');
  const r3 = tickPersona(p, {}, p.nextAt + 1, false, rng);
  assert.equal(r3.state, 'sleep');
  assert.ok(p.wakeAt > p.sleepStartedAt);

  // online 到点必进小状态之一；40 个种子覆盖全部滑入分支，每个都带 announce
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const r = makeRng(seed);
    const pp = basePersona({ state: 'online', nextAt: now - 1 });
    const out = tickPersona(pp, {}, now, false, r);
    seen.add(out.state);
    assert.ok(['daze', 'chatty', 'hungry', 'sleep'].includes(out.state), `未预期的滑入状态 ${out.state}`);
    assert.ok(out.announce && out.announce.text.length > 4, `${out.state} 应带主动发言`);
  }
  assert.ok(seen.has('daze'), '40 个种子内应出现发呆');
  assert.ok(seen.has('chatty'), '40 个种子内应出现话多');
  assert.ok(seen.has('hungry'), '40 个种子内应出现嘴馋');

  // 话多/嘴馋到点回在线；未到点保持
  const pc = basePersona({ state: 'chatty', nextAt: now - 1 });
  assert.equal(tickPersona(pc, {}, now, false, makeRng(5)).state, 'online');
  const ph = basePersona({ state: 'hungry', nextAt: now + 9999 });
  assert.equal(tickPersona(ph, {}, now, false, makeRng(5)).state, 'hungry');
});

test('活跃时永远回到在线（睡中也立刻醒并带 greet）', () => {
  const rng = makeRng(7);
  const p = basePersona({ state: 'sleep', nextAt: 0, wakeAt: now + 60 * 60 * 1000, dreamAt: now + 60 * 60 * 1000 });
  const r = tickPersona(p, {}, now, true, rng);
  assert.equal(r.state, 'online');
  assert.equal(p.state, 'online', '状态要被真实复位（重启/切页面自愈）');
});

test('做梦 v2：睡够 dreamAt 出梦、做梦自由不限场数、醒来有问候', () => {
  const rng = makeRng(1234);
  const p = basePersona({
    state: 'sleep',
    sleepStartedAt: now - 30 * 60 * 1000,
    dreamAt: now - 1,
    dreamCount: 0,
    wakeAt: now + 60 * 60 * 1000,
  });
  const r = tickPersona(p, {}, now, false, rng);
  assert.equal(r.state, 'sleep');
  assert.ok(r.dream, '该做梦了');
  assert.ok(['温馨', '奇怪', '搞笑', '怀旧', '馋嘴', '天马行空'].includes(r.dream.type), '六种梦型池');
  assert.equal(p.dreams.length, 1);
  assert.ok(r.dream.text.startsWith('梦见'));

  // 做梦自由：已经做了 5 场的觉，到点照样继续做（不再限 3 场）
  let p2 = basePersona({ state: 'sleep', dreamAt: now - 1, dreamCount: 5, wakeAt: now + 60 * 60 * 1000 });
  const r2 = tickPersona(p2, {}, now, false, makeRng(99));
  assert.ok(r2.dream, '做梦不设上限');
  assert.equal(p2.dreams.length, 1);

  // 到点自然醒 → 醒来消息带最近梦、announce 同步
  const p3 = basePersona({ state: 'sleep', dreamAt: null, wakeAt: now - 1 });
  p3.dreams = [{ at: iso(now - 1000), text: '梦见云朵排队', type: '奇怪' }];
  const r3 = tickPersona(p3, {}, now, false, rng);
  assert.equal(r3.state, 'online');
  assert.ok(r3.greet.includes('云朵排队'));
  assert.ok(r3.announce && r3.announce.kind === 'wake', '醒来应主动告诉用户');
});

test('发呆念头：0~3 个、按来源出、2% 哼歌（种子下可复现）', () => {
  const rng = makeRng(99);
  const data = {
    tasks: [
      { title: '写周报', date: iso(now).slice(0, 10), done: false },
      { title: '回邮件', date: iso(now).slice(0, 10), done: false },
      { title: '整理笔记', date: iso(now).slice(0, 10), done: false },
    ],
    studyItems: [],
    memos: [],
    memories: [{ text: '我周末不接工作电话', branch: 'preference' }],
    workoutLogs: [],
    mealDays: [],
  };
  const p = basePersona({ state: 'daze', thoughtAt: now - 1, thoughtCount: 0, nextAt: now + 60 * 60 * 1000 });
  const r = tickPersona(p, data, now, false, rng);
  assert.equal(r.state, 'daze');
  if (r.thought) {
    assert.ok(['data', 'memory', 'model'].includes(r.thought.source));
    assert.equal(p.thoughts.length, 1);
    assert.equal(p.thoughts[0].text, r.thought.text);
  }
  assert.ok(p.thoughtAt > now && p.thoughtAt <= now + 150 * 1000, '下一个念头间隔 40~150 秒');
});

test('性格合并：相似加权、冲突新条、上限 8 条', () => {
  const t = [{ text: '喜欢用比喻', weight: 2, source: 'reflect', updatedAt: iso(now - 5) }];
  const merged = mergeTraits(t, ['喜欢用比喻～', '说话句尾爱带语气词'], 'reflect', iso(now));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].weight, 3, '相似的那条应加权');
  const many = mergeTraits(
    Array.from({ length: 8 }, (_, i) => ({ text: `特点${i}`, weight: 1, source: 'reflect', updatedAt: iso(now - i) })),
    ['新特点'],
    'reflect',
    iso(now),
  );
  assert.equal(many.length, 8, '上限 8 条');
});

test('醒来话术：40 分钟内不说话；做过梦就带梦；隔 8 小时问候', () => {
  const p1 = basePersona({ lastActiveAt: iso(now - 10 * 60 * 1000) });
  assert.equal(computeWakeLine(p1, now), null);
  const p2 = basePersona({ lastActiveAt: iso(now - 60 * 60 * 1000), dreams: [{ at: iso(now - 30 * 60 * 1000), text: '梦见小火车' }] });
  assert.ok(computeWakeLine(p2, now).includes('梦见小火车'));
  const p3 = basePersona({ lastActiveAt: iso(now - 10 * 60 * 60 * 1000), dreams: [] });
  assert.ok(computeWakeLine(p3, now).includes('好久不见'));
});

test('图片印象句：包含像素统计与诚实要求', () => {
  const s = impressionFromStats({ w: 800, h: 600, hue: '粉', warmth: '暖', brightness: '高', vivid: '鲜艳' });
  assert.ok(s.includes('800×600'));
  assert.ok(s.includes('粉'));
  assert.ok(s.includes('暖洋洋'));
  assert.ok(s.includes('还没有真正的眼睛'));
});

test('scheduleIdle：困的时候更早发呆（种子对比）', () => {
  const r1 = makeRng(5);
  const a = scheduleIdle({ energy: 0.9 }, now, r1) - now;
  const r2 = makeRng(5);
  const b = scheduleIdle({ energy: 0.1 }, now, r2) - now;
  assert.ok(b < a, '低能量应该更快进入发呆');
});
