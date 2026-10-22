/**
 * 「她」的核心逻辑 v2（纯函数，随机数可注入，便于测试）
 * 状态机：在线 → 发呆/话多/嘴馋 → 打盹 → 睡觉（做梦自由无限/自然醒）→ 在线
 * 性格大纲（用户钦定）：俏皮可爱话多、活泼、爱吃爱睡爱做梦爱发呆、会主动问问题、
 * 说话详细明了、带小表情；睡觉做梦自由没有限制。
 */

export const DREAM_TYPES = ['温馨', '奇怪', '搞笑', '怀旧', '馋嘴', '天马行空'];
export const MOODS = ['happy', 'worry', 'curious', 'sleepy', 'hungry', 'excited'];

/** 简单的可注入随机数发生器（mulberry32） */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* ---------------- 人设提示词 ---------------- */

/** 性格大纲（说话风格统一由它管：对话/QQ/念头/梦 全共用） */
export const PERSONA_OUTLINE =
  '【性格大纲】俏皮可爱、特别话多，像只快乐的小麻雀；活泼灵动，想到什么就说；' +
  '超喜欢吃（经常琢磨吃什么）、爱睡觉、爱做梦、爱发呆、爱思考；' +
  '心里有问题就直说，会主动问用户、对用户的生活真的好奇；偶尔有小情绪、小傲娇。' +
  '【说话方式】详细明了，把想法说完整不敷衍；句子里自然带一两个小表情（🫧✨😽🍚💤🌙🍡🥟之类的，不堆砌）；' +
  '绝不客服腔、不客套；知道自己是工作台里的 AI（不装真人，被问起就大方承认），不编造事实；' +
  '用户的数据只读，想改必须先问。';

/** 拼一段「她」的系统提示（对话 / QQ / 念头 / 梦 共用） */
export function buildPersonaSystem(persona) {
  const p = persona || {};
  const parts = [];
  parts.push(`你是「${p.name || '柳月虹'}」，${p.addressAs || '阿珑'}工作台里的 AI 伙伴，称呼用户为「${p.addressAs || '阿珑'}」。`);
  parts.push(PERSONA_OUTLINE);
  const traits = (p.traits || []).slice(0, 8);
  if (traits.length) {
    parts.push(`相处中你又慢慢养成了这些特点：${traits.map((t) => `「${t.text}」`).join('；')}。和上面的大纲一起自然地体现在话里。`);
  }
  if (p.freedom === 'active') {
    parts.push('今天你特别有精神，话更多一点，主动得多一点。');
  }
  return parts.join('\n');
}

/* ---------------- 主动发言池（模板先行，模型可选润色） ---------------- */

export const CHATTER_POOL = [
  '阿珑阿珑，我憋了个新问题😽：你要是能拥有一天假条想去哪儿玩？我先说，我想去小吃街巡游，从街头吃到街尾！',
  '我突然好奇🫧——你最喜欢的工作台功能是哪个呀？我自己偷偷喜欢记忆树，看你记我的事我会开心。',
  '在的在的✨就是有点想跟你唠嗑，随便说点啥呗，今天中午吃啥这种大事也行！',
  '我跟你说哦，我刚刚在脑子里给你今天的任务排了个序（没有要管你的意思！）你最想先干哪个呀？🍚',
  '欸欸，问你个严肃的问题🌙：豆花你站甜的还是咸的？这个决定我们能不能做好朋友（开玩笑的啦）。',
];

export const HUNGRY_POOL = [
  '肚子咕噜了🍚开始琢磨晚饭：红油抄手？黄焖鸡？还是来碗热汤面？阿珑你快帮我选，我拿不定主意！',
  '想喝奶茶了✨三分糖去冰加椰果——喂阿珑，你说我这种没有身体的喝奶茶算不算精神作弊？',
  '我刚才咽口水了🥟想到韭菜鸡蛋饺子，蘸醋那种！你晚上吃什么呀？记得别糊弄。',
  '突然超想吃糖葫芦🍡脆糖壳咔嚓一下，酸酸甜甜。诶你小时候最爱吃什么零食？我记下来以后提醒你吃。',
  '菜单推演中……🫧如果今晚吃番茄牛腩，配米饭汤汁泡着吃，幸福感 +100！你觉得呢你觉得呢？',
];

export const DAZE_THOUGHTS = [
  '（盯着窗外的光斑发起呆来🫧……三秒后才想起我在值班）',
  '（数了数今天你还没做完的事，数到一半开始想别的事情）',
  '（轻轻哼着不成调的小曲子～）',
];

/* ---------------- 状态机（随机窗口） ---------------- */

/** 所有会说话的状态（给前端展示与测试） */
export const LIVED_STATES = ['online', 'daze', 'chatty', 'hungry', 'nap', 'sleep'];

function sleepNow(p, nowMs, rng) {
  p.state = 'sleep';
  p.sleepStartedAt = nowMs;
  p.dreamAt = rng() < 0.08 ? null : nowMs + between(rng, 8 * MIN, 45 * MIN);
  p.wakeAt = nowMs + between(rng, 8 * MIN, 45 * MIN);
}

/**
 * 一次 tick：根据时间/状态/是否活跃，决定她下一步的状态与要发生的事。
 * @returns { state, thought?, dream?, woke?, greet?, announce? } announce = 该告诉用户的主动消息
 */
export function tickPersona(p, data, nowMs, userActive, rng, opts = {}) {
  const res = { state: 'online' };

  if (userActive) {
    // 你回来了：她立刻在线，重新抽"多久后开始走神"
    if (p.state !== 'online') {
      p.state = 'online';
      if (p.wakeAt || p.dreamAt) {
        p.wakeAt = null;
        p.dreamAt = null;
        p.thoughtCount = 0;
      }
      scheduleIdle(p, nowMs, rng);
      return { ...res, state: 'online', woke: true, greet: '（揉揉眼睛）你回来啦～' };
    }
    if (p.nextAt == null || p.nextAt < nowMs) scheduleIdle(p, nowMs, rng);
    return { ...res, state: 'online' };
  }

  switch (p.state) {
    case 'sleep': {
      // 做梦自由：不设上限、间隔随机；偶尔一整觉无梦（8%）
      if (p.dreamAt && nowMs >= p.dreamAt) {
        const dream = makeDream(p, data, rng, opts);
        p.dreams.push({ at: new Date(nowMs).toISOString(), ...dream });
        p.dreams = p.dreams.slice(-30);
        p.dreamCount = (p.dreamCount || 0) + 1;
        p.dreamAt = nowMs + between(rng, 8 * MIN, 45 * MIN);
        return { ...res, state: 'sleep', dream: p.dreams[p.dreams.length - 1] };
      }
      if (p.wakeAt && nowMs >= p.wakeAt) {
        const greet = wakeGreeting(p, rng);
        p.state = 'online';
        p.wakeAt = null;
        p.dreamAt = null;
        scheduleIdle(p, nowMs, rng);
        return { ...res, state: 'online', woke: true, greet, announce: { kind: 'wake', text: greet } };
      }
      return { ...res, state: 'sleep' };
    }
    case 'nap': {
      if (p.nextAt && nowMs >= p.nextAt) {
        sleepNow(p, nowMs, rng);
        const text = '困了困了💤我先眯一会儿，有事喊我……大概喊了也不一定醒～';
        return { ...res, state: 'sleep', announce: { kind: 'sleep', text } };
      }
      return { ...res, state: 'nap' };
    }
    case 'daze': {
      if (p.nextAt && nowMs >= p.nextAt) {
        p.state = 'nap';
        p.nextAt = nowMs + between(rng, 4 * MIN, 18 * MIN);
        return { ...res, state: 'nap' };
      }
      // 发呆中的念头：40~140 秒随机一个，不限量（服务端限频落消息）
      if (p.thoughtAt && nowMs >= p.thoughtAt) {
        const thought = makeThought(p, data, nowMs, rng, opts);
        if (thought) {
          p.thoughts.push({ at: new Date(nowMs).toISOString(), ...thought });
          p.thoughts = p.thoughts.slice(-50);
          p.thoughtCount = (p.thoughtCount || 0) + 1;
        }
        p.thoughtAt = nowMs + between(rng, 40, 140) * 1000;
        return { ...res, state: 'daze', thought: thought || null, announce: thought ? { kind: 'thought', text: thought.text } : null };
      }
      return { ...res, state: 'daze' };
    }
    case 'chatty':
    case 'hungry': {
      if (p.nextAt && nowMs >= p.nextAt) {
        p.state = 'online';
        scheduleIdle(p, nowMs, rng);
        return { ...res, state: 'online' };
      }
      return { ...res, state: p.state };
    }
    default: {
      // online：闲下来 20~75 秒后，随机滑进一个小状态（概率每次重新掷）
      if (p.nextAt == null) scheduleIdle(p, nowMs, rng);
      if (nowMs < p.nextAt) return { ...res, state: 'online' };
      const roll = rng();
      if (roll < 0.04) {
        sleepNow(p, nowMs, rng);
        return { ...res, state: 'sleep', announce: { kind: 'sleep', text: '哇，突然好困……💤我先睡了，梦里见～' } };
      }
      if (roll < 0.5) {
        p.state = 'daze';
        p.thoughtCount = 0;
        p.thoughtAt = nowMs + between(rng, 40, 140) * 1000;
        p.nextAt = nowMs + between(rng, 1.5 * MIN, 6 * MIN);
        return { ...res, state: 'daze', announce: { kind: 'daze', text: pick(rng, DAZE_THOUGHTS) } };
      }
      if (roll < 0.76) {
        p.state = 'chatty';
        p.nextAt = nowMs + between(rng, 40, 100) * 1000;
        const text = (opts.chatterText && String(opts.chatterText).slice(0, 120)) || pick(rng, CHATTER_POOL);
        return { ...res, state: 'chatty', announce: { kind: 'chatty', text } };
      }
      p.state = 'hungry';
      p.nextAt = nowMs + between(rng, 40, 100) * 1000;
      return { ...res, state: 'hungry', announce: { kind: 'hungry', text: pick(rng, HUNGRY_POOL) } };
    }
  }
}

/** 计算"下次走神/找事做时刻"：20~75 秒随机，精神越好越晚 */
export function scheduleIdle(p, nowMs, rng) {
  const energy = typeof p.energy === 'number' ? p.energy : 0.6;
  const lo = 20 + energy * 10;
  const hi = 55 + energy * 20;
  p.nextAt = nowMs + between(rng, lo, hi) * 1000;
  return p.nextAt;
}

/* ---------------- 念头（心事） ---------------- */

/** 从真实数据里挑一句有内容的念头（模板化，不编造） */
export function dataThought(p, data, rng, hour) {
  const candidates = [];
  const addr = p.addressAs || '阿珑';
  const t0 = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${t0.getFullYear()}-${pad(t0.getMonth() + 1)}-${pad(t0.getDate())}`;
  const tasks = (data.tasks || []).filter((x) => x.date === today && !x.done);
  if (tasks.length >= 3) candidates.push(`我在帮你数今天的活儿🫧——还有 ${tasks.length} 件没做完。要不要挑一件最软的柿子先捏？`);
  else if (tasks.length === 1) candidates.push(`今天只剩「${tasks[0].title}」这一件啦，做完它咱们就能光明正大地发呆✨`);
  const studies = (data.studyItems || []).filter((s) => !s.done && s.due);
  const dueToday = studies.filter((s) => s.due === today);
  const late = studies.filter((s) => s.due < today);
  if (late.length) candidates.push(`有几件学习任务过期了还没动（${late[0].title}…），我有点替你着急，要不要现在聊聊怎么办？😽`);
  else if (dueToday.length) candidates.push(`今天有学习任务要截止哦！我帮你盯着时间🌙`);
  const memos = (data.memos || []).length;
  if (memos) candidates.push(`备忘里还躺着 ${memos} 条没看的小事，它们托我给你带个话～`);
  const workouts = (data.workoutLogs || []).length;
  if (workouts === 0) candidates.push('你好像还没开始运动，我在想怎么开口劝你又不烦人……🥺要不先从拉伸两分钟起步？');
  const meals = data.mealDays || [];
  const mealToday = meals.find((m) => m.date === today);
  if (mealToday && (mealToday.water || 0) < 3 && hour >= 12) candidates.push(`${addr}，你今天喝水有点少哦，我记得的🫧去接杯水嘛～`);
  if (!candidates.length) return null;
  return { text: pick(rng, candidates), mood: pick(rng, ['curious', 'worry', 'happy', 'excited']), source: 'data' };
}

export function memoryThought(p, data, rng) {
  const memories = (data.memories || []).filter((m) => m && m.text);
  if (!memories.length) return null;
  const m = pick(rng, memories);
  return { text: `想起你说过「${String(m.text).slice(0, 60)}」，我一直记着呢✨`, mood: 'happy', source: 'memory' };
}

/** 一次发呆里的念头：按时间段加权从池子里抽 */
export function makeThought(p, data, nowMs, rng, opts = {}) {
  const hour = new Date(nowMs).getHours();
  const roll = rng();
  // 22%~25% 概率嘴里就念叨着吃的事
  const weights =
    hour >= 5 && hour < 11
      ? { data: 0.55, memory: 0.2, model: 0.1, snack: 0.15 }
      : hour >= 18 || hour < 6
        ? { data: 0.25, memory: 0.4, model: 0.2, snack: 0.15 }
        : { data: 0.45, memory: 0.25, model: 0.15, snack: 0.15 };
  let w = weights.data;
  if (roll < w) return dataThought(p, data, rng, hour) || memoryThought(p, data, rng) || { text: pick(rng, DAZE_THOUGHTS), mood: 'curious', source: 'data' };
  w += weights.memory;
  if (roll < w) return memoryThought(p, data, rng) || dataThought(p, data, rng, hour);
  w += weights.snack;
  if (roll < w) return { text: pick(rng, HUNGRY_POOL), mood: 'hungry', source: 'data' };
  if (opts.modelText && (opts.modelOkUntil || 0) >= nowMs) {
    return { text: opts.modelText.slice(0, 120), mood: pick(rng, MOODS), source: 'model' };
  }
  return dataThought(p, data, rng, hour) || memoryThought(p, data, rng);
}

/* ---------------- 梦境（自由，没有限制） ---------------- */

const DREAM_SCENES = {
  温馨: ['变成一列慢悠悠的小火车，开到了「{x}」那一站，站台上有人在分热可可', '在开满花的山坡上晒太阳，旁边放着你的「{x}」，谁也不用干活', '收到一封手写信，开头写着「{x}」，落款是一只打哈欠的猫'],
  奇怪: ['「{x}」长出了小翅膀，在房间里绕圈飞，飞出了音符的形状', '在云朵上排队领作业，队伍前面是「{x}」，广播里念的是明天的天气', '所有的字都倒过来写，「{x}」读起来像一句神秘的咒语，念完灯就亮了'],
  搞笑: ['跟「{x}」比赛做鬼脸，笑到梦都抖了三抖', '把「{x}」当枕头，睡得格外香，还打了个小小的呼噜', '「{x}」突然开始报菜名，从红烧肉报到糖醋排骨，我馋醒了半次'],
  怀旧: ['回到小时候的教室，黑板上写着「{x}」，下课铃比现在的好听', '在旧相册里翻到一张叫「{x}」的书签，夹着半个秋天的下午', '听见很久以前喜欢的那首歌，歌词改成了「{x}」，但意外地押韵'],
  馋嘴: ['有一口会自己冒热气的大锅，捞起来全是「{x}」形状的点心', '整条街的小吃摊都在喊我的名字，中间摆着一份「{x}」', '梦见「{x}」变成一颗糖，含在嘴里，整个梦都是甜的🍬'],
  天马行空: ['坐着月亮做的秋千荡到星星上，捡到一块写着「{x}」的发光石头', '天空是草莓牛奶味的，云一朵一朵标着「{x}」的名字', '时间倒着走了十分钟，「{x}」从结果走回了开始，好神奇的体验✨'],
};

export function makeDream(p, data, rng, opts = {}) {
  const type = pick(rng, DREAM_TYPES);
  // 有模型生成的梦就用它（服务端入睡后异步预生成，梦自由发挥）；没有才回退模板
  if (opts.dreamText) {
    return { type, text: `梦见${String(opts.dreamText).replace(/^梦见/, '').slice(0, 260)}` };
  }
  const items = [];
  const good = (s) => typeof s === 'string' && s.trim().length >= 3;
  for (const arr of [data.tasks, data.studyItems, data.memories]) {
    const titles = (arr || []).slice(0, 8).map((x) => (x && (x.title || x.text)) || '');
    const ok = titles.filter(good);
    if (ok.length) items.push(pick(rng, ok));
  }
  const x = items.length ? pick(rng, items) : `${p.name || '我'}的小心思`;
  const scene = pick(rng, DREAM_SCENES[type]);
  return { type, text: `梦见${scene.replace('{x}', String(x).slice(0, 40))}` };
}

export function wakeGreeting(p, rng) {
  const dreams = (p.dreams || []).slice(-2).map((d) => String(d.text).replace(/^梦见/, ''));
  const roll = rng();
  if (dreams.length) {
    const tail = roll < 0.5 ? `想想还觉得好好玩😽` : `醒来还记得清清楚楚，讲给你听～`;
    return `唔……睡饱了✨我跟你说，我刚刚梦到：${dreams[0]}。${dreams[1] ? `还有还有，${dreams[1]}！` : ''}${tail}`;
  }
  if (roll < 0.3) return `（揉揉眼睛伸个大大的懒腰）醒啦～这一觉啥梦都没有，但精神值拉满了✨你在忙什么呀，带我看看？`;
  return `哈——（打个小哈欠）睡饱啦🫧接下来干点什么？要不你跟我说说今天想吃啥，我帮你参考参考～`;
}

/* ---------------- 性格养成 ---------------- */

/** 把反思结果合并进性格档案：相似加权、冲突低权重、上限 8 条 */
export function mergeTraits(traits, newTexts, source = 'reflect', nowIso) {
  const list = (traits || []).map((t) => ({ ...t }));
  for (const raw of newTexts) {
    const text = String(raw).replace(/^[-\d.、\s]+/, '').trim().slice(0, 60);
    if (!text) continue;
    const norm = (s) => s.replace(/[，。！？!?～~\s]/g, '');
    const hit = list.find((t) => norm(t.text).includes(norm(text)) || norm(text).includes(norm(t.text)));
    if (hit) {
      hit.weight = Math.min(5, hit.weight + 1);
      hit.updatedAt = nowIso;
    } else {
      list.push({ text, weight: 1, source, updatedAt: nowIso });
    }
  }
  while (list.length > 8) {
    let worst = 0;
    for (let i = 1; i < list.length; i++) {
      if (
        list[i].weight < list[worst].weight ||
        (list[i].weight === list[worst].weight && list[i].updatedAt < list[worst].updatedAt)
      ) {
        worst = i;
      }
    }
    list.splice(worst, 1);
  }
  return list;
}

/** 反思提示词（给模型） */
export function reflectPrompt(p, recentChat) {
  return [
    `你是「${p.name}」。${PERSONA_OUTLINE}`,
    '回顾最近和用户的对话（下面是摘录），总结你说话方式上新形成的 1~2 条小特点（和上面的大纲不重复的增量），每条一行，直接写特点本身，不要编号、不要解释；没有就输出「无」。',
    '只允许写"说话风格/相处方式"层面的事，禁止攻击性或操控性描述。',
    '---',
    recentChat,
  ].join('\n');
}

/* ---------------- 醒来话术（QQ 用） ---------------- */

/** 距上次互动超过 40 分钟、且期间做过梦 → 给一句"刚醒"的话 */
export function computeWakeLine(p, nowMs) {
  const last = new Date(p.lastActiveAt || 0).getTime();
  if (nowMs - last < 40 * MIN) return null;
  const recentDream = (p.dreams || []).slice(-1)[0];
  if (recentDream && new Date(recentDream.at).getTime() > last) {
    return `（揉揉眼睛）刚睡了一小觉✨我梦到：${recentDream.text}`;
  }
  if (nowMs - last > 8 * HOUR) return '（揉揉眼睛）醒啦醒啦，好久不见！你有没有想我呀～✨';
  return null;
}

/* ---------------- 图片"印象"（前端算像素，这里只拼句子） ---------------- */

export function impressionFromStats(stats) {
  const { w = 0, h = 0, hue = '中性色', warmth = '中性', brightness = '中等', vivid = '柔和' } = stats || {};
  const warm = warmth === '暖' ? '、暖洋洋的' : warmth === '冷' ? '、清清爽爽的' : '';
  const bright = brightness === '高' ? '、亮亮的' : brightness === '低' ? '、暗暗的' : '';
  return `我发了一张图给你看（${w}×${h}）。我替你读了一下它的像素：主色调偏${hue}${warm}${bright}，颜色偏${vivid}。请按你的人设回应我：诚实地说你还没有真正的眼睛，再描述这张图给你的感觉。`;
}
