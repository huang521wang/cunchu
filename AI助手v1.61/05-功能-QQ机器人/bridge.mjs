/**
 * 工作台 × QQ 官方机器人 连接程序
 *
 * 走腾讯官方的 QQ 机器人开放平台（bot.q.qq.com）：
 *   - 出站 WebSocket 连官方网关，收 @机器人 的消息（或单聊消息）
 *   - 通过官方 REST 接口回复
 * 机器人只回答"你自己问它"的内容（今日简报、任务、作业），
 * 读不到你的私人聊天——官方也不给这个能力。
 *
 * 配置：同目录 config.json（从 config.example.json 复制填写），
 * 或者用环境变量 QQ_BOT_APPID / QQ_BOT_TOKEN。
 * 校验配置：node bridge.mjs --check
 *
 * 说明：协议按官方文档实现（网关 op 1/2/10/11 + 消息事件），
 * 第一次真机连接需要拿真实 AppID/Token 一起联调。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 配置 ---------------- */

export function loadConfig(dir = __dirname) {
  let fileCfg = {};
  const file = path.join(dir, 'config.json');
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`config.json 不是合法的 JSON：${file}`);
    }
  }
  const cfg = {
    appId: process.env.QQ_BOT_APPID || fileCfg.appId || '',
    secret: process.env.QQ_BOT_SECRET || fileCfg.secret || '',
    token: process.env.QQ_BOT_TOKEN || fileCfg.token || '',
    sandbox: fileCfg.sandbox === true,
    workbench: fileCfg.workbench || 'http://127.0.0.1:8787',
    intents: typeof fileCfg.intents === 'number' ? fileCfg.intents : undefined,
  };
  const problems = validateConfig(cfg);
  return { cfg, problems };
}

export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.appId || !/^\d{5,12}$/.test(String(cfg.appId))) {
    problems.push('appId 缺失或格式不对（应该是申请机器人时拿到的数字 AppID）');
  }
  if (!cfg.secret && !cfg.token) {
    problems.push('secret（AppSecret，推荐）和 token 至少要填一个（在机器人后台「开发设置」里）');
  } else if (cfg.secret && String(cfg.secret).length < 10) {
    problems.push('secret 太短，检查一下是否复制完整');
  } else if (!cfg.secret && String(cfg.token).length < 10) {
    problems.push('token 太短，检查一下是否复制完整');
  }
  return problems;
}

/* ---------------- 机器人问答逻辑（纯函数，方便测试） ---------------- */

export const HELP_TEXT = [
  '你好呀，我是工作台的小助手 🌸',
  '· 快捷命令：今天 / 明天 / 作业 / 任务（秒回）',
  '· 其他任何话都可以直接聊——用工作台里选中的模型回答（本机模型约 10~30 秒）',
  '· 想让我记东西，比如「加任务：明天交方案」，我会先问你一句再记',
].join('\n');

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDay = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ds(d);
};

function kindLabel(s) {
  return `${s.title}${s.course ? `（${s.course}）` : ''}${s.due ? ` · 截止 ${s.due.slice(5).replace('-', '/')}` : ''}`;
}

/** 快捷命令（秒回）；不是命令就返回 null（交给 AI 聊天） */
export function commandAnswer(text, data) {
  const t = String(text || '')
    .replace(/<@!?\d+>/g, '') // 去掉 @机器人 的标记
    .trim();

  if (!t) return HELP_TEXT;

  const withDue = (arr) =>
    arr
      .filter((s) => !s.done)
      .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
  const tomorrow = addDay(1);

  if (/^(今天|日报|今日|简报)/.test(t)) {
    return data.briefing || '（今天的简报还没生成出来）';
  }
  if (/^(明天|明日)/.test(t)) {
    const items = withDue(data.studyItems || []).filter((s) => s.due === tomorrow);
    if (!items.length) return '明天没有截止的作业，轻松一点 🌸';
    return ['📚 明天截止：', ...items.map((s) => `· ${s.title}${s.course ? `（${s.course}）` : ''}`)].join('\n');
  }
  if (/^(作业|学习)/.test(t)) {
    const items = withDue(data.studyItems || []);
    if (!items.length) return '学习任务都清完啦 🎉';
    return [`📚 还有 ${items.length} 条学习任务：`, ...items.slice(0, 15).map((s) => `· ${kindLabel(s)}`)].join('\n');
  }
  if (/^(任务|待办)/.test(t)) {
    const t0 = ds(new Date());
    const items = (data.tasks || []).filter((x) => x.date === t0 && !x.done);
    if (!items.length) return '今天没有待办任务，享受一天吧 🌸';
    return [`📋 今天的任务（${items.length} 条）：`, ...items.slice(0, 15).map((x) => `· ${x.title}`)].join('\n');
  }
  if (/^(帮助|help|你能干嘛|会什么)/i.test(t)) return HELP_TEXT;
  return null;
}

/** 是不是"确认/取消"（在有待确认动作时才会被用到） */
export function parseConfirm(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(1|1\.|1！|确认|确定|好|好的|好呀|是|嗯|y|yes|ok)$/.test(t)) return 'yes';
  if (/^(2|2\.|取消|不|不用|不要|否|算了|n|no)$/.test(t)) return 'no';
  return null;
}

/* ---- 最近几轮上下文（只存在内存里，重启就忘） ---- */
const HISTORY_MAX = 6; // 3 问 3 答

export function remember(hist, key, role, content) {
  const list = hist.get(key) || [];
  list.push({ role, content: String(content || '').slice(0, 2000) });
  while (list.length > HISTORY_MAX) list.shift();
  hist.set(key, list);
}

export function historyOf(hist, key) {
  return [...(hist.get(key) || [])];
}

const MAX_LEN = 900;
export function clip(text) {
  return text.length <= MAX_LEN ? text : `${text.slice(0, MAX_LEN - 20)}\n…（太长啦，去工作台看完整版）`;
}

/* ---------------- 官方网关客户端 ---------------- */

export const INTENTS = {
  GROUP_AT_MESSAGE_CREATE: 1 << 25, // 群里 @机器人
  C2C_MESSAGE_CREATE: 1 << 26, // 单聊
  PUBLIC_GUILD_MESSAGES: 1 << 30, // 频道里 @机器人
  DIRECT_MESSAGE: 1 << 12, // 频道私信
};

export function apiBase(cfg) {
  return cfg.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
}

/** 鉴权头：新版 AppID+Secret 换 access_token（QQBot xxx）；旧版直接用 Token（Bot appid.token） */
let cachedToken = { value: '', exp: 0 };
export async function authValue(cfg) {
  if (cfg.secret) {
    if (cachedToken.value && Date.now() < cachedToken.exp) return `QQBot ${cachedToken.value}`;
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: String(cfg.appId), clientSecret: cfg.secret }),
    });
    if (!res.ok) throw new Error(`取 access_token 失败 HTTP ${res.status}：${(await res.text()).slice(0, 150)}`);
    const j = await res.json();
    if (!j.access_token) throw new Error(`取 access_token 失败：${JSON.stringify(j).slice(0, 150)}`);
    cachedToken = {
      value: j.access_token,
      exp: Date.now() + (Number(j.expires_in || 7200) - 60) * 1000,
    };
    return `QQBot ${cachedToken.value}`;
  }
  return `Bot ${cfg.appId}.${cfg.token}`;
}

/** 从网关事件里取出（会话类型、会话 id、消息文本、消息 id） */
export function parseEvent(type, d) {
  const atts = Array.isArray(d.attachments) ? d.attachments : [];
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    return { kind: 'group', target: d.group_openid, text: d.content, msgId: d.id, attachments: atts };
  }
  if (type === 'C2C_MESSAGE_CREATE') {
    return { kind: 'c2c', target: d.author?.user_openid, text: d.content, msgId: d.id, attachments: atts };
  }
  if (type === 'AT_MESSAGE_CREATE') {
    return { kind: 'channel', target: d.channel_id, text: d.content, msgId: d.id, attachments: atts };
  }
  if (type === 'DIRECT_MESSAGE_CREATE') {
    return { kind: 'dms', target: d.guild_id, text: d.content, msgId: d.id, attachments: atts };
  }
  return null;
}

/** QQ 收到图片：下载 → 工作台 OCR → 学习通作业流水线；返回给用户的回话（无图返回 null） */
export async function handleImageAttachment(cfg, e, auth) {
  const img = (e.attachments || []).find(
    (a) => String(a.content_type || '').startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)/i.test(String(a.url || '')),
  );
  if (!img || !img.url) return null;
  try {
    const dl = await fetch(img.url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30000) });
    if (!dl.ok) return '图片下载失败了（QQ 侧接口限制），再发一次试试；或把截图发给电脑上的工作台';
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return '这张图太大了（>8MB），截个作业列表页就好';
    const ocr = await wbJSON(cfg, '/api/vision/ocr', 'POST', {
      image: buf.toString('base64'),
      mime: img.content_type || 'image/png',
    });
    const text = String((ocr && ocr.text) || '');
    if (text.trim().length < 6) return '图里没看到文字信息～下次截「作业/考试列表」那一页，我就能认出题目和截止时间了';
    const ing = await wbJSON(cfg, '/api/xxt/ingest-text', 'POST', { text });
    if (ing.added) {
      const label = { homework: '作业', exam: '考试', checkin: '签到', grade: '成绩', other: '通知' }[ing.kind] || '通知';
      if (ing.kind === 'homework') {
        return `收到！认出【${label}】：「${ing.title}」${ing.due ? '，截止 ' + ing.due : ''}。已写进学习计划，草稿做好我在 QQ 喊你（随时回「作业」看进度）`;
      }
      return `认出【${label}】：「${ing.title}」${ing.due ? '，相关时间 ' + ing.due : ''}，记下啦 ✓`;
    }
    return '这条刚记过了（24 小时内同样的内容不重复记）✓';
  } catch (err) {
    console.error('[机器人] 图片处理失败：', (err && err.message) || err);
    return '这张图处理出了点小问题，再发一次试试，或发给电脑上的工作台';
  }
}

export function replyPath(e, msgSeq) {
  if (e.kind === 'group') return `/v2/groups/${e.target}/messages`;
  if (e.kind === 'c2c') return `/v2/users/${e.target}/messages`;
  if (e.kind === 'channel') return `/channels/${e.target}/messages`;
  return `/dms/${e.target}/messages`;
}

/** 工作台本机数据 + 简报 + 设置（供回答和记录用） */
export async function loadWorkbench(cfg) {
  const base = cfg.workbench.replace(/\/$/, '');
  const [all, briefing] = await Promise.all([
    fetch(`${base}/api/all`).then((r) => r.json()),
    fetch(`${base}/api/briefing`).then((r) => r.json()),
  ]);
  return { ...all.data, settings: all.settings, briefing: briefing.text };
}

async function wbJSON(cfg, path, method, body) {
  const r = await fetch(`${cfg.workbench.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

/** 学习通 QQ 命令：作业 / 确认 <编号> / 重做 <编号> <方向> */
async function xxtCommand(cfg, clean) {
  try {
    if (/^(作业|作业列表|我的作业)$/.test(clean)) {
      const j = await wbJSON(cfg, '/api/mailwatch', 'GET');
      const hs = j.homeworks || [];
      if (!hs.length) return '还没有学习通作业。老师一发作业，我就在这儿留言你👌';
      const label = { new: '制作中…', drafted: '草稿好了✅', confirmed: '已确认', failed: '没做成' };
      return (
        '📕 学习通作业：\n' +
        hs
          .slice(0, 8)
          .map((h) => `${h.id.slice(0, 8)}｜${h.title}（${label[h.status] || h.status}${h.due ? '，截止 ' + h.due : ''}）`)
          .join('\n') +
        '\n回「确认 编号」拿全文 ·「重做 编号 方向」重新做'
      );
    }
    let m = clean.match(/^确认\s*([0-9a-f-]{4,36})/i);
    if (m) {
      const j = await wbJSON(cfg, '/api/xxt/confirm', 'POST', { id: m[1] });
      return `✅「这版的全文」：\n${String(j.draft).slice(0, 1500)}\n（复制进学习通交之前，自己再顺一遍哈）`;
    }
    m = clean.match(/^重做\s*([0-9a-f-]{4,36})\s*([\s\S]*)/i);
    if (m) {
      await wbJSON(cfg, '/api/xxt/redo', 'POST', { id: m[1], note: (m[2] || '').trim() });
      return '🔁 收到，按这个方向重做，好了我留言你（想提前看就回「作业」）';
    }
  } catch {
    // 命令处理不了当普通消息继续
  }
  return null;
}

/* ---- 多账号推送：记住所有聊过的 QQ 号（比如两个号），排队消息轮流送达 ---- */
const MINUTE_MS = 60 * 1000;

export function loadPushState() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge-state.json'), 'utf8'));
    if (!Array.isArray(j.targets)) {
      const t = [];
      if (j.lastKind && j.lastTarget) t.push({ kind: j.lastKind, target: j.lastTarget, msgId: '', seq: 0, at: j.at || 0 });
      return { targets: t };
    }
    return j;
  } catch {
    return { targets: [] };
  }
}

function savePushState(st) {
  try {
    fs.writeFileSync(path.join(__dirname, 'bridge-state.json'), JSON.stringify(st));
  } catch {
    /* 写不上就算了 */
  }
}

export function pushPathOf(t) {
  if (t.kind === 'group') return `/v2/groups/${t.target}/messages`;
  if (t.kind === 'c2c') return `/v2/users/${t.target}/messages`;
  return null; // 频道类不支持被动消息推送
}

/** 记录/刷新某账号的对话锚点（msgId 是官方被动回复锚，约 60 分钟窗口） */
export function rememberTarget(st, e, msgSeq) {
  const key = `${e.kind}:${e.target}`;
  const old = (st.targets || []).find((t) => `${t.kind}:${t.target}` === key);
  const list = (st.targets || []).filter((t) => `${t.kind}:${t.target}` !== key);
  const newMsgId = e.msgId || (old && old.msgId) || '';
  list.push({
    kind: e.kind,
    target: e.target,
    msgId: newMsgId,
    // QQ 规则：同一 msg_id 的 msg_seq 从 1 递增；换了新 msgId 必须重新从 0 起算，
    // 沿用旧 seq 会被官方 400 拒收——这就是"突然不回消息"的根因
    seq: old && old.msgId === newMsgId ? Math.max(old.seq || 0, msgSeq || 0) : 0,
    at: Date.now(),
  });
  st.targets = list.slice(-6);
}

/** 账号短标（openid 尾 6 位，日志里区分是哪个 QQ 号，不落全量敏感 ID） */
function who(t) {
  return String(t || '?').slice(-6);
}

async function sendToTarget(cfg, t, content) {
  const p = pushPathOf(t);
  if (!p || !t.msgId) return false;
  if (Date.now() - (t.at || 0) > 55 * MINUTE_MS) return false; // 被动消息窗口已过
  t.seq = (t.seq || 0) + 1;
  try {
    const res = await fetch(apiBase(cfg) + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: await authValue(cfg) },
      body: JSON.stringify({ content, msg_type: 0, msg_id: t.msgId, msg_seq: t.seq }),
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => '');
    log(`✗ 推送被拒（${who(t.target)}）HTTP ${res.status}：${body.slice(0, 150)}`);
    t.seq -= 1;
    return false;
  } catch (err) {
    log(`✗ 推送异常（${who(t.target)}）：${err.message}`);
    t.seq -= 1;
    return false;
  }
}

/** 超过 90 分钟的排队消息已错过被动回复窗口，直接作废销号（防积压轰炸） */
async function pruneStale(cfg, queue) {
  const list = Array.isArray(queue) ? queue : [];
  const alive = [];
  const staleIds = [];
  for (const x of list) {
    if (Date.now() - (x.at || 0) > 90 * 60 * 1000) staleIds.push(x.id);
    else alive.push(x);
  }
  if (staleIds.length) {
    log(`丢弃 ${staleIds.length} 条过期推送（超 90 分钟窗口）`);
    try {
      await wbJSON(cfg, '/api/qq/notified', 'POST', { ids: staleIds });
    } catch {
      /* 下轮再清 */
    }
  }
  return alive;
}

/** 送达工作台队列：每条发给"所有最近聊过的 QQ 号"（两个号都收到），任一成功即销号 */
async function deliverPushQueue(cfg, e, msgSeq) {
  const st = loadPushState();
  rememberTarget(st, e, msgSeq);
  savePushState(st);
  const q = await wbJSON(cfg, '/api/qq/pending', 'GET');
  const items = (await pruneStale(cfg, q.queue)).slice(0, 2);
  const done = [];
  for (const it of items) {
    let okAny = false;
    for (const t of st.targets.slice().reverse()) {
      if (await sendToTarget(cfg, t, clip(it.text))) okAny = true;
    }
    if (okAny) done.push(it.id);
  }
  savePushState(st); // seq 已推进，落盘
  if (done.length) {
    try {
      await wbJSON(cfg, '/api/qq/notified', 'POST', { ids: done });
    } catch {
      /* 销号失败下次重发，顶多重复一条 */
    }
  }
  return st;
}

/** 让工作台的 AI 回答（走"设置里当前选中的模型"+记忆树；顺便把这段聊天存进工作台记录） */
export async function chatOnce(cfg, messages, record = true) {
  const r = await fetch(`${cfg.workbench.replace(/\/$/, '')}/api/chat-once`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, record }),
    signal: AbortSignal.timeout(200000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.content || '';
}

/** 让工作台识别"要记录什么" */
export async function fetchAction(cfg, text) {
  const r = await fetch(`${cfg.workbench.replace(/\/$/, '')}/api/assistant-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return j.action ? { ...j.action, describe: j.describe } : null;
}

/** 执行一条已确认的记录动作 */
export async function executeAction(cfg, action, data) {
  const today = ds(new Date());
  const SLOT = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
  if (action.kind === 'task') {
    await wbJSON(cfg, '/api/tasks', 'POST', {
      title: action.text,
      date: action.date || today,
      time: '',
      estimate: '',
      note: '',
      priority: 'none',
      done: false,
      doneAt: null,
    });
    return `✓ 已记入今日计划：「${action.text}」（日期回工作台可改）`;
  }
  if (action.kind === 'memo') {
    await wbJSON(cfg, '/api/memos', 'POST', { text: action.text });
    return `✓ 已记入快速备忘：「${action.text}」`;
  }
  if (action.kind === 'weight') {
    await wbJSON(cfg, '/api/weightLogs', 'POST', { date: today, weight: Math.round(Number(action.value) * 10) / 10 });
    return `✓ 已记录体重 ${action.value} kg`;
  }
  if (action.kind === 'workout') {
    const plan = (data && data.settings && data.settings.weeklyPlan) || [];
    const idx = (new Date().getDay() + 6) % 7;
    const p = plan[idx];
    await wbJSON(cfg, '/api/workoutLogs', 'POST', {
      date: today,
      content: p && p !== '休息' ? p : '训练',
      note: action.note || '',
    });
    return '✓ 已记一次健身打卡 💪';
  }
  if (action.kind === 'meal') {
    const meal = (data && data.mealDays ? data.mealDays : []).find((m) => m.date === today);
    const prev = meal ? String(meal[action.slot] || '').trim() : '';
    const merged = prev ? `${prev}\n${action.text}` : action.text;
    if (meal) await wbJSON(cfg, `/api/mealDays/${meal.id}`, 'PATCH', { [action.slot]: merged });
    else
      await wbJSON(cfg, '/api/mealDays', 'POST', {
        date: today,
        breakfast: '',
        lunch: '',
        dinner: '',
        snack: '',
        water: 0,
        [action.slot]: merged,
      });
    return `✓ 已记入饮食（${SLOT[action.slot] || ''}）：「${action.text}」`;
  }
  if (action.kind === 'kb') {
    const j = await wbJSON(cfg, '/api/kb/add', 'POST', { text: action.text });
    return j.ok ? `✓ 你亲口的吩咐，直接写进知识库了（${j.category}，共 ${j.total} 条）` : `没写进去：${j.error || '知识库没就绪'}`;
  }
  if (action.kind === 'memory') {
    await wbJSON(cfg, '/api/memories', 'POST', { branch: 'about', text: action.text, pinned: false, source: 'qq' });
    return `✓ 已记进记忆树：「${action.text}」`;
  }
  return '这条我还不会记，去工作台里加吧';
}

async function sendReply(cfg, e, content, msgSeq) {
  const res = await fetch(apiBase(cfg) + replyPath(e, msgSeq), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: await authValue(cfg) },
    body: JSON.stringify({ content, msg_type: 0, msg_id: e.msgId, msg_seq: msgSeq }),
  });
  if (!res.ok) {
    log(`✗ 回复被拒（${who(e.target)}）HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    return false;
  }
  log(`已回复（${who(e.target)}｜${content.split('\n')[0].slice(0, 40)}…）`);
  return true;
}

// 日志直接落文件（管道 stdout 有缓冲，崩溃时啥都看不到——之前"无日志"就是这么丢的）
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`;
  console.log(msg);
  try {
    fs.appendFileSync(path.join(__dirname, 'bridge.log'), line);
  } catch {
    /* 磁盘问题不拦运行 */
  }
}

/** 等确认的记录动作（按会话存，重连不丢） */
const pendingActions = new Map();
/** 最近几轮聊天上下文（按会话存，重连不丢；重启程序会忘） */
const chatHist = new Map();

export async function run() {
  const { cfg, problems } = loadConfig();
  if (problems.length) {
    console.error('配置还不完整：');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('把 config.example.json 复制成 config.json 填好 AppID 和 Token，再启动。');
    process.exit(1);
  }

  // 先确认工作台在跑（防呆：暂时连不上就抛错等重试，不退出——工作台重启后桥接自愈）
  try {
    await loadWorkbench(cfg);
    log(`工作台连接正常：${cfg.workbench}`);
  } catch {
    throw new Error(`连不上工作台（${cfg.workbench}）——先把「启动工作台.bat」打开`);
  }

  const intents =
    cfg.intents ??
    (INTENTS.GROUP_AT_MESSAGE_CREATE | INTENTS.C2C_MESSAGE_CREATE | INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE);

  const auth = await authValue(cfg);
  const gwRes = await fetch(`${apiBase(cfg)}/gateway`, { headers: { Authorization: auth } });
  if (!gwRes.ok) {
    const detail = (await gwRes.text()).slice(0, 200);
    throw new Error(`拿不到网关地址 HTTP ${gwRes.status}：${detail}（检查 AppID/Secret、机器人是否已上线）`);
  }
  const { url } = await gwRes.json();
  log(`连上官方网关：${url.slice(0, 60)}…（按 Ctrl+C 退出）`);

  let seq = null;
  let hbTimer = null;
  // 看门狗：90 秒没收到任何包（心跳 ACK 都没有）= 连接假死，主动断开触发重连
  let lastAlive = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastAlive > 90000) {
      log('连接 90 秒没有响应（假死）——主动断开重连…');
      try {
        ws.close();
      } catch {
        // 已断
      }
    }
  }, 15000);
  const ws = new WebSocket(url);
  let msgSeq = 0;

  // 每分钟主动投递：只要某 QQ 号还在被动窗口内（约 60 分钟），拟人化消息直接送过去，不用等你回话
  const pushTimer = setInterval(() => {
    (async () => {
      try {
        const st = loadPushState();
        const fresh = st.targets.filter((t) => Date.now() - (t.at || 0) <= 55 * MINUTE_MS && pushPathOf(t) && t.msgId);
        if (!fresh.length) return;
        const q = await wbJSON(cfg, '/api/qq/pending', 'GET');
        const items = (await pruneStale(cfg, q.queue)).slice(0, 2);
        if (!items.length) return;
        const done = [];
        for (const it of items) {
          let okAny = false;
          for (const t of st.targets.slice().reverse()) {
            if (await sendToTarget(cfg, t, clip(it.text))) okAny = true;
          }
          if (okAny) done.push(it.id);
        }
        savePushState(st);
        if (done.length) await wbJSON(cfg, '/api/qq/notified', 'POST', { ids: done });
      } catch {
        /* 静默，下轮再来 */
      }
    })();
  }, 60000);
  pushTimer.unref?.();

  ws.addEventListener('open', () => log('WebSocket 已连接，等待消息'));
  ws.addEventListener('message', async (ev) => {
    lastAlive = Date.now();
    let pkt;
    try {
      pkt = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (pkt.s != null) seq = pkt.s;

    if (pkt.op === 10) {
      // HELLO：开始心跳
      const iv = pkt.d?.heartbeat_interval || 30000;
      hbTimer = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), iv);
      ws.send(
        JSON.stringify({
          op: 2,
          d: { token: auth, intents, shard: [0, 1], properties: {} },
        }),
      );
      return;
    }
    if (pkt.op === 0 && pkt.t === 'READY') {
      backoff = 10000; // 成功连上：重试间隔回到最快
      log('机器人已就绪 ✓ 在 QQ 里 @我 试试「今天」');
      return;
    }
    if (pkt.op === 0 && pkt.t) {
      const e = parseEvent(pkt.t, pkt.d || {});
      if (!e || !e.target) {
        // 防呆：过去这里静默丢弃，"二号收不到"这类平台格式差异根本查不到；
        // 现在把不认识的推送原样记一条（截断防刷屏），事件类型和字段可见即可破案
        log(`未识别事件：${pkt.t}｜${JSON.stringify(pkt.d || {}).slice(0, 220)}`);
        return;
      }
      const clean = String(e.text || '')
        .replace(/<@!?\d+>/g, '')
        .trim();
      log(`收到消息（${e.kind}·${who(e.target)}）：${clean.slice(0, 40) || '(空)'}`);
      const key = `${e.kind}:${e.target}`;
      msgSeq = 0; // 官方规则：每条新消息的回复序号从 1 重新数（沿用累计值会被 400 拒收）
      // 把工作台攒的主动消息（拟人化/作业）送达所有最近聊过的 QQ 号（两个号都收到）
      try {
        const stAfter = await deliverPushQueue(cfg, e, msgSeq);
        const mine = (stAfter.targets || []).find((t) => `${t.kind}:${t.target}` === key);
        if (mine) msgSeq = Math.max(msgSeq, mine.seq || 0); // 回复接着这个 seq 往上走，避免撞号
      } catch {
        /* 投递失败不影响正常聊天 */
      }
      try {
        const data = await loadWorkbench(cfg);
        // 她（柳月虹）：如果刚才睡着过、做过梦，先带一句"刚醒"
        let wakeLine = null;
        try {
          const pr = await fetch(`${cfg.workbench.replace(/\/$/, '')}/api/persona`).then((r) => r.json());
          wakeLine = pr && pr.wakeLine ? pr.wakeLine : null;
        } catch {
          wakeLine = null;
        }

        // 1) 正在等"确认 / 取消"？
        const pending = pendingActions.get(key);
        if (pending) {
          const c = parseConfirm(clean);
          if (c === 'yes') {
            pendingActions.delete(key);
            msgSeq += 1;
            await sendReply(cfg, e, await executeAction(cfg, pending, data), msgSeq);
            return;
          }
          if (c === 'no') {
            pendingActions.delete(key);
            msgSeq += 1;
            await sendReply(cfg, e, '好的，不记了 ✓', msgSeq);
            return;
          }
          pendingActions.delete(key); // 既不是确认也不是取消：当新消息继续处理
        }

        // 2) 快捷命令（秒回）
        const cmd = commandAnswer(clean, data);
        if (cmd) {
          msgSeq += 1;
          await sendReply(cfg, e, clip(wakeLine ? `${wakeLine}\n\n${cmd}` : cmd), msgSeq);
          return;
        }

        // 2b) 学习通命令：作业 / 确认 xxx / 重做 xxx 方向
        const xcmd = await xxtCommand(cfg, clean);
        if (xcmd) {
          msgSeq += 1;
          await sendReply(cfg, e, clip(xcmd), msgSeq);
          return;
        }

        // 3) 要不要帮你记录？先问一句，回「1」才真记
        const act = await fetchAction(cfg, clean);
        if (act) {
          pendingActions.set(key, act);
          msgSeq += 1;
          await sendReply(cfg, e, `要${act.describe || '记这条'}吗？\n回复「1」确认，「2」取消`, msgSeq);
          return;
        }

        // 4) 普通聊天：交给工作台的 AI（用你设置里选的模型，带记忆）
        msgSeq += 1;
        await sendReply(cfg, e, '🤔 收到，我让工作台里的模型想想…（本机模型要 10~60 秒，别急）', msgSeq);
        const messages = [...historyOf(chatHist, key), { role: 'user', content: clean }];
        const answer = await chatOnce(cfg, messages, true);
        remember(chatHist, key, 'user', clean);
        remember(chatHist, key, 'assistant', answer);
        msgSeq += 1;
        await sendReply(
          cfg,
          e,
          clip((wakeLine ? `${wakeLine}\n\n` : '') + (answer || '（模型这次没说话，再问一次试试）')),
          msgSeq,
        );
      } catch (err) {
        const m = String((err && err.message) || err);
        console.error('[机器人] 处理消息出错：', m);
        try {
          msgSeq += 1;
          await sendReply(
            cfg,
            e,
            m.includes('连不上模型') || m.includes('fetch failed')
              ? '😥 连不上工作台的模型——先看看电脑上「启动模型.bat」开着没'
              : `😥 没成功：${m.slice(0, 120)}`,
            msgSeq,
          );
        } catch {
          // 连错误回复都发不出去就算了
        }
      }
    }
  });
  ws.addEventListener('close', () => {
    if (hbTimer) clearInterval(hbTimer);
    clearInterval(watchdog);
    clearInterval(pushTimer);
    log('连接断开了（可能是网络波动或 Token 失效）。稍后自动重连…');
    setTimeout(runWithRetry, 5000);
  });
  ws.addEventListener('error', () => {});
}

/** 防呆：run 失败（工作台没开/网关抖动）不退出，指数退避重试直到连上（10s→20s→40s→最多 60s） */
let backoff = 10000;

async function runWithRetry() {
  for (;;) {
    try {
      await run();
      return;
    } catch (e) {
      log(`暂时连不上：${e?.message || e}（${Math.round(backoff / 1000)} 秒后自动重试，不用管我）`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    const { cfg, problems } = loadConfig();
    if (problems.length) {
      console.log('配置检查不通过：');
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      const shown = cfg.secret ? `secret=***${String(cfg.secret).slice(-4)}` : `token=***${String(cfg.token).slice(-4)}`;
      console.log(`配置没问题 ✓ AppID=${cfg.appId} ${shown}`);
    }
    try {
      await loadWorkbench(cfg);
      console.log(`工作台连接正常 ✓ ${cfg.workbench}`);
    } catch {
      console.log('工作台连不上（先把「启动工作台.bat」打开）');
    }
    process.exit(problems.length ? 1 : 0);
  } else {
    runWithRetry().catch((e) => {
      console.error('启动失败：', e?.message || e);
      process.exit(1);
    });
  }
}
