import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, COLLECTIONS, THEMES, normalizeModelEntry } from './store.js';
import {
  buildDraftPrompt,
  looksLikeXxt,
  noticeFromPlainText,
  noticeToLine,
  parseXxtNotice,
  redact,
} from './xuexitong.js';
import { pollMailbox, makeImapFetcher } from './mailwatch.js';
import { syncXxt } from './xxtsync.js';
import { openTaskPage, readTask, submitTask } from './xxttask.js';
import {
  buildPersonaSystem,
  PERSONA_OUTLINE,
  tickPersona,
  scheduleIdle,
  makeRng,
  wakeGreeting,
  computeWakeLine,
  mergeTraits,
  reflectPrompt,
} from './persona.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(APP_ROOT, '..');
const WEB_DIST = path.join(APP_ROOT, 'web', 'dist');
const CONCEPT_DIR = path.join(PROJECT_ROOT, '设计概念稿');
export const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');

const now = () => new Date().toISOString();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCollection = (name) => COLLECTIONS.includes(name);

/* ---- 全局异常兜底（防呆）：单机进程没有守护，Node v24 起未捕获的 Promise 拒绝/异常直接崩整个工作台，
   而 vbs 是隐藏窗口启动的——console 全看不见，崩了也没人知道。这类漏网异常一律记进 data/server-crash.log 后保进程活着。 ---- */
function crashLog(kind, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  const line = `[${now()}] ${kind}: ${detail}\n`;
  try {
    fs.appendFileSync(path.join(DEFAULT_DATA_DIR, 'server-crash.log'), line);
  } catch {
    /* 日志盘问题不拦保命 */
  }
  console.error(line.trim());
}
process.on('unhandledRejection', (reason) => crashLog('unhandledRejection', reason));
process.on('uncaughtException', (err) => crashLog('uncaughtException', err));

const MEMORY_BRANCHES = { about: '关于我', work: '工作', life: '生活', preference: '偏好', idea: '灵感' };

/* ---- 局域网访问口令：本机访问免口令；同一 WiFi 下的设备需要口令 ---- */

/** 判断是不是"本机"（自己电脑上打开的浏览器） */
export function isLocalAddress(ip) {
  if (!ip) return false;
  const s = String(ip);
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

/** 读取或生成手机访问口令（存在数据目录里，改这个文件就能换口令） */
export function ensureLanPin(dataDir) {
  const file = path.join(dataDir, 'lan-access.json');
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.pin === 'string' && j.pin.length >= 4) return { pin: j.pin, file };
    }
  } catch {
    // 文件坏了就当没有，重新生成
  }
  const pin = String(crypto.randomInt(100000, 999999));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pin, note: '手机（同一 WiFi）访问工作台的口令；想换口令就改这里，改完重启工作台' }, null, 2),
  );
  return { pin, file };
}

/** 本机在局域网里的地址（给启动提示用） */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** 把记录里记的"相对路径"解析成绝对路径，且必须落在数据目录里（防恶意备份做路径穿越） */
function safeDataPath(dataDir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/* ---- AI 模型列表：当前激活哪个 / 逐个探测在线 ---- */

/** 当前用哪个模型：优先 activeModelId，回退列表第一条；都没有就回退旧字段 */
export function resolveActiveModel(settings) {
  const models = Array.isArray(settings.models) ? settings.models : [];
  const active = models.find((m) => m.id === settings.activeModelId) || models[0] || null;
  if (active) {
    return {
      id: active.id,
      name: active.name || active.model,
      type: active.type || 'local',
      baseUrl: active.baseUrl,
      model: active.model,
      apiKey: active.apiKey || '',
    };
  }
  const api = settings.modelApi || {};
  return {
    id: 'legacy',
    name: '本机模型',
    type: 'local',
    baseUrl: api.baseUrl || 'http://127.0.0.1:8080/v1',
    model: api.model || 'deepseek-r1-7b',
    apiKey: '',
  };
}

/** 是不是"要动脑"的任务：数学/逻辑/代码类 → 优先推理模型（R1） */
export function isReasoningTask(text) {
  const t = String(text || '');
  if (t.length > 300) return false;
  return /深度思考|深思|数学|方程|积分|微积分|导数|概率|证明|推导|求解|算一下|计算结果|算法|复杂度|逻辑题|推理题|脑筋急转弯/.test(t);
}

/** 是不是"编程任务"：优先给专门的代码模型（Coder） */
export function isCodeTask(text) {
  const t = String(text || '');
  if (t.length > 500) return false;
  return /写代码|代码|编程|写个?函数|函数|bug|debug|报错|异常|接口|python|java|sql|html|css|正则|前端|后端|数据库/.test(t);
}

/** 模型协同：自动调度。
 *  - 编程任务 → 优先 Coder 代码模型；推理型任务 → 优先 R1；日常 → 优先 千问/指令模型
 *  - 目标离线 → 自动降级到其它在线模型；都不在线 → 用当前激活（保持原报错行为）
 *  - 在线状态有 8 秒缓存，避免每次聊天都探测 */
const autoRouteCache = { at: 0, map: new Map() };
export async function resolveBestModel(store, lastUserText, preferReasoning = null) {
  const s = store.db.settings;
  if (s.autoRoute === false) {
    const manual = resolveActiveModel(s);
    // 手动模式：激活模型连不上时，依次试其它本地模型（不会卡在"没启动"）
    const others = (Array.isArray(s.models) ? s.models : [])
      .filter((m) => m.id !== manual.id && (m.type === 'local' || !m.type) && m.kind !== 'image')
      .map((m) => ({
        id: m.id,
        name: m.name || m.model,
        type: m.type || 'local',
        baseUrl: m.baseUrl,
        model: m.model,
        apiKey: m.apiKey || '',
      }));
    return { pick: manual, candidates: [manual, ...others], auto: false, anyOnline: false };
  }
  const codeTask = preferReasoning === null && isCodeTask(lastUserText);
  const wantReasoning = preferReasoning !== null ? preferReasoning : !codeTask && isReasoningTask(lastUserText);
  const all = (Array.isArray(s.models) ? s.models : []).filter((m) => m.kind !== 'image'); // 画图专用模型不参与聊天调度
  // 多选模型池：只在用户勾选的模型里调度（空 = 全部可用）
  const poolIds = Array.isArray(s.selectedModels) && s.selectedModels.length ? s.selectedModels : null;
  const list = poolIds ? all.filter((m) => poolIds.includes(m.id)) : all;
  if (!list.length) {
    const active = resolveActiveModel(s);
    return { pick: active, candidates: [active], auto: false, anyOnline: false };
  }

  let map = autoRouteCache.map;
  if (Date.now() - autoRouteCache.at > 8000) {
    map = new Map();
    await Promise.all(
      list.map(async (m) => {
        map.set(m.id, await probeModel(m, 1200));
      }),
    );
    autoRouteCache.at = Date.now();
    autoRouteCache.map = map;
  } else {
    // 缓存里没有的新模型（刚加的），单独探测补上
    const missing = list.filter((m) => !map.has(m.id));
    if (missing.length) {
      await Promise.all(
        missing.map(async (m) => {
          map.set(m.id, await probeModel(m, 1200));
        }),
      );
    }
  }
  const online = list.filter((m) => map.get(m.id));

  const isCodeModel = (m) => /coder|code/i.test(`${m.id} ${m.model}`);
  const isReasoningModel = (m) => /r1|reasoner|deepseek-r1|thinking/i.test(`${m.id} ${m.model}`);
  const isInstructModel = (m) => /qwen|instruct|chat|glm|kimi|moonshot/i.test(`${m.id} ${m.model}`);

  const toPick = (found) => {
    if (!found) return resolveActiveModel(s);
    return {
      id: found.id,
      name: found.name || found.model,
      type: found.type || 'local',
      baseUrl: found.baseUrl,
      model: found.model,
      apiKey: found.apiKey || '',
    };
  };
  // 候选列表（按优先级）：选中的挂了，调用方可以依次试下一个
  let ordered;
  if (codeTask) {
    ordered = [
      ...online.filter(isCodeModel),
      ...online.filter((m) => !isCodeModel(m) && isReasoningModel(m)),
      ...online.filter((m) => !isCodeModel(m) && !isReasoningModel(m)),
      ...list.filter((m) => !online.includes(m)),
    ];
  } else {
    const pred = wantReasoning ? isReasoningModel : isInstructModel;
    ordered = [
      ...online.filter(pred),
      ...online.filter((m) => !pred(m)),
      ...list.filter((m) => !online.includes(m)),
    ];
  }
  return {
    pick: toPick(ordered[0]),
    candidates: ordered.map(toPick),
    auto: true,
    wanted: codeTask ? 'code' : wantReasoning ? 'reasoning' : 'fast',
    anyOnline: online.length > 0,
  };
}

function modelHeaders(m) {
  return m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {};
}

/**
 * 带图消息的视觉注释：让"只会看字"的聊天模型也能看懂图——
 * 本机视觉模型把图转成描述文字，注入该条 content；描述缓存回 attachments[].desc，
 * 同一张图下次进历史不再重复跑视觉。依赖全注入，可单测。
 * deps: { visionFn(b64,mime)→文字, readFile(rel)→Buffer, cacheBack(rel,desc), wakeVision() }
 */
export async function annotateVisionMessages(messages, deps = {}) {
  const { visionFn, readFile, cacheBack, wakeVision, lookupCache } = deps;
  if (!Array.isArray(messages)) return 0;
  let noted = 0;
  for (const m of messages) {
    if (!m || m.role !== 'user' || !Array.isArray(m.attachments) || !m.attachments.length) continue;
    const notes = [];
    for (const a of m.attachments) {
      if (!a || a.kind !== 'image' || !a.file) continue;
      noted++;
      let desc = String(a.desc || '').trim();
      // 预识别缓存优先：挑图那刻后台已经看过，发送时直接命中，不排队等模型
      if (!desc && lookupCache) {
        const hit = lookupCache(a.file);
        if (hit && String(hit).trim()) desc = String(hit).trim().slice(0, 1200);
      }
      if (!desc && visionFn && readFile) {
        try {
          if (wakeVision) await wakeVision();
          const b64 = readFile(a.file).toString('base64');
          desc = String((await visionFn(b64, a.mime || 'image/png')) || '').trim().slice(0, 1200);
          if (desc && cacheBack) cacheBack(a.file, desc);
        } catch {
          desc = '';
        }
      }
      notes.push(
        desc
          ? `【关于这张附图，本机视觉模型看到的是：${desc}】`
          : '【用户附了一张图，但视觉模型没能看清/没启动成功。如实告诉阿珑去设置里开视觉模型再问一次，别瞎编图里内容】',
      );
    }
    if (notes.length) m.content = `${m.content || ''}\n\n${notes.join('\n')}`.trim();
  }
  return noted;
}

/**
 * 画图通道核心：可注入 fetchImpl 供单测（真实默认走全局 fetch）。
 * 智谱 CogView-3-Flash（免费）：POST 生图 → data[0].url → 下载 → png Buffer。
 */
export async function imagineViaZhipu(prompt, key, fetchImpl = fetch) {
  if (!key) throw new Error('还没填智谱 API Key（在助手里发「画图密钥：xxx」装 Key）');
  const r = await fetchImpl('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const hint =
      r.status === 401 || r.status === 403 ? '（密钥不对或没权限）' : r.status === 429 ? '（今天免费额度用完了，明天再来）' : '';
    throw new Error(`智谱服务返回 ${r.status}${hint}：${t.slice(0, 140)}`);
  }
  const j = await r.json().catch(() => null);
  const url = j && j.data && j.data[0] && j.data[0].url;
  if (!url) throw new Error('智谱返回里没有图片地址（可能被内容审核拦了，换个描述试试）');
  const img = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!img.ok) throw new Error('图生成了但下载失败，再试一次');
  return Buffer.from(await img.arrayBuffer());
}

/** 零密钥免注册出图（Pollinations 公共服务）：auto 通道的兜底，装了智谱 Key 则优先走智谱 */
export async function imagineViaPollinations(prompt, fetchImpl = fetch) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).slice(0, 700))}?width=1024&height=1024&nologo=true`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`出图服务返回 ${r.status}，过一会儿再试`);
  const buf = Buffer.from(await r.arrayBuffer());
  const isPng = buf.slice(1, 4).toString() === 'PNG';
  const isJpg = buf.slice(0, 3).toString('hex') === 'ffd8ff';
  if (!isPng && !isJpg) throw new Error('出图服务刚才没给图（可能限流），歇几秒再说一次「画：」试试');
  return { buf, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' };
}

/** 合并多条 system 消息为开头一条（新模型如 Qwen3.5 只允许一条 system） */
function mergeSystemMessages(messages) {
  const systems = [];
  const rest = [];
  for (const m of messages) {
    if (m && m.role === 'system') systems.push(String(m.content || ''));
    else rest.push(m);
  }
  if (!systems.length) return messages;
  return [{ role: 'system', content: systems.join('\n\n') }, ...rest];
}

async function probeModel(m, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${String(m.baseUrl || '').replace(/\/+$/, '')}/models`, {
      headers: modelHeaders(m),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

/* ---- 课堂/会议录音：本地转写（whisper.cpp）+ 本地总结（你本机的模型） ---- */

const AUDIO_EXTS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-m4a': 'm4a',
  'application/octet-stream': 'webm',
};

/** 找 whisper 引擎和模型（都装好返回路径；可用环境变量覆盖，测试也用这个） */
export function whisperPaths() {
  const base = process.env.WHISPER_DIR || 'D:\\DeepSeek-R1-7B\\whisper';
  const bins = [
    process.env.WHISPER_BIN,
    path.join(base, 'cuda', 'whisper-cli.exe'),
    path.join(base, 'cuda', 'main.exe'),
    path.join(base, 'cpu', 'whisper-cli.exe'),
    path.join(base, 'cpu', 'main.exe'),
  ].filter(Boolean);
  const bin = bins.find((p) => fs.existsSync(p)) || null;
  const models = [process.env.WHISPER_MODEL, path.join(base, 'ggml-medium.bin'), path.join(base, 'ggml-small.bin')].filter(
    Boolean,
  );
  const model = models.find((p) => fs.existsSync(p)) || null;
  return { bin, model };
}

function whisperCommand(bin, args) {
  // 测试时可以把 WHISPER_BIN 指到一个 .mjs 假引擎，用 node 跑
  if (bin.endsWith('.js') || bin.endsWith('.mjs')) return { cmd: process.execPath, argv: [bin, ...args] };
  return { cmd: bin, argv: args };
}

/** 后台转写一段录音（fire-and-forget，状态写回记录） */
function startTranscribe(store, note) {
  const { bin, model } = whisperPaths();
  const audioAbs = safeDataPath(store.dataDir, note.audioFile);
  if (!audioAbs) {
    note.status = 'failed';
    note.error = '这条记录的音频路径不合法（记录可能被篡改过）';
    note.updatedAt = now();
    store.save();
    return;
  }
  const outPrefix = audioAbs.replace(/\.[^.]+$/, '');
  const args = [
    '-m', model,
    '-f', audioAbs,
    '--language', 'zh',
    '--output-txt',
    '--output-file', outPrefix,
    '--no-prints',
  ];
  const { cmd, argv } = whisperCommand(bin, args);
  let errBuf = '';
  const child = spawn(cmd, argv, { windowsHide: true });
  child.stderr.on('data', (d) => {
    errBuf = (errBuf + d.toString()).slice(-600);
  });
  child.on('error', (e) => {
    note.status = 'failed';
    note.error = `转写程序启动失败：${e.message}`;
    note.updatedAt = now();
    store.save();
  });
  child.on('close', (code) => {
    const txtFile = `${outPrefix}.txt`;
    let text = '';
    try {
      text = fs.readFileSync(txtFile, 'utf8');
    } catch {
      // 没生成就按失败处理
    }
    text = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean)
      .join('\n');
    if (code === 0 && text) {
      note.transcript = text;
      note.status = 'transcribed';
      note.error = '';
    } else {
      note.status = 'failed';
      note.error = text ? '转写没成功，但拿到了部分文本' : `转写失败（退出码 ${code}）${errBuf ? '：' + errBuf.slice(-200) : ''}`;
      if (text) note.transcript = text;
    }
    note.updatedAt = now();
    store.save();
  });
}

function chunkText(text, size = 1200, maxChunks = 12) {
  const out = [];
  let rest = text;
  while (rest.length && out.length < maxChunks) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  return out;
}

async function modelChat(baseUrl, model, messages, maxTokens = 900, apiKey = '') {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3, stream: false }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型请求失败 HTTP ${res.status}${res.status === 402 ? '（这个模型的余额不足）' : ''}${text ? '：' + text.slice(0, 100) : ''}`);
  }
  const j = await res.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return (msg && String(msg.content || '').trim()) || '';
}

/** 后台总结（分段要点 → 合并成完整总结，状态写回记录） */
async function runSummarize(store, note) {
  try {
    const { pick: api } = await resolveBestModel(store, '整理', false);
    const baseUrl = api.baseUrl || 'http://127.0.0.1:8080/v1';
    const model = api.model || 'deepseek-r1-7b';
    const chunks = chunkText(note.transcript || '');
    if (!chunks.length) throw new Error('没有转写文字，先转写再总结');
    const parts = [];
    for (const ch of chunks) {
      const r = await modelChat(baseUrl, model, [
        {
          role: 'system',
          content: `你是${store.db.settings.persona.name}，${store.db.settings.persona.addressAs}工作台里的 AI 伙伴。把用户给的课堂/会议录音转写整理成简洁的中文要点，保留关键概念、数字、人名，以及任何提到的作业、截止时间、待办事项。不要客套话，直接给要点列表。`,
        },
        { role: 'user', content: ch },
      ], 900, api.apiKey);
      parts.push(r);
    }
    const merged = await modelChat(
      baseUrl,
      model,
      [
        {
          role: 'system',
          content:
            `你是${store.db.settings.persona.name}，${store.db.settings.persona.addressAs}工作台里的 AI 伙伴。把用户给的分段要点合并成一份完整总结，用三个小节输出：「📌 本节要点」「🔑 重点概念」「✅ 提到的事项（作业/截止/待办）」，没有的写"无"。不要客套话。`,
        },
        { role: 'user', content: parts.join('\n---\n') },
      ],
      1200,
      api.apiKey,
    );
    note.summary = merged;
    note.status = 'done';
    note.error = '';
  } catch (e) {
    note.status = 'failed';
    note.error = `总结失败：${e.message}（模型要在运行中）`;
  }
  note.updatedAt = now();
  store.save();
}

/* ---- 助手"帮记录"意图识别（服务端版，供 QQ 机器人等非浏览器场景使用）
   注意：这里的规则要和前端 Assistant.tsx 的 detectAction 保持一致 ---- */

export function detectAssistantAction(text, day) {
  const t = String(text || '').trim();
  let m;
  if (
    (m = t.match(/^(?:请)?(?:帮我)?(?:加|添加|新增|新建|记)(?:一[条个])?(?:个)?任务[：:，,\s]*(.+)$/)) ||
    (m = t.match(/^(?:待办|任务)[：:，,\s]*(.+)$/))
  ) {
    return { kind: 'task', text: m[1].trim(), date: day };
  }
  if (
    (m = t.match(/^(?:请)?(?:帮我)?(?:记|加|添加)(?:一[条个])?备忘[：:，,\s]*(.+)$/)) ||
    (m = t.match(/^备忘[：:，,\s]*(.+)$/))
  ) {
    return { kind: 'memo', text: m[1].trim() };
  }
  if ((m = t.match(/^(?:请)?(?:帮我)?记(?:一下)?体重[：:，,\s]*([\d.]+)/))) {
    return { kind: 'weight', value: m[1] };
  }
  if ((m = t.match(/^(?:请)?(?:帮我)?(?:健身)?打卡[：:，,\s]*(.*)$/)) || /^(?:今天)?练完了/.test(t)) {
    const note = m && m[1] ? m[1].trim() : (t.match(/练完了[，,：:\s]*(.*)$/) || [])[1] || '';
    return { kind: 'workout', note };
  }
  if ((m = t.match(/^(?:请)?(?:帮我)?记(?:录)?饮食[：:，,\s]*(.+)$/))) {
    return { kind: 'meal', slot: 'lunch', text: m[1].trim() };
  }
  if ((m = t.match(/^(?:请)?(?:帮我)?(?:记|存|加)(?:入|进|到)?知识(?:库)?[：:，,\s]*(.+)$/)) || (m = t.match(/^知识[：:]\s*(.+)$/))) {
    return { kind: 'kb', text: m[1].trim() };
  }
  if (/记住|记一下|帮我记着|记着点/.test(t)) {
    const cleaned = t.replace(/^.*?(记住|记一下|帮我记着|记着点)[：:，,、\s]*/, '').trim();
    return { kind: 'memory', text: cleaned || t };
  }
  return null;
}

/** 描述一条动作（给 QQ 回复用） */
export function describeAction(action) {
  if (!action) return '';
  const SLOT = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
  if (action.kind === 'task') return `把「${action.text}」加进今日计划`;
  if (action.kind === 'memo') return `记一条备忘：「${action.text}」`;
  if (action.kind === 'weight') return `记录体重 ${action.value} kg`;
  if (action.kind === 'workout') return `记一次健身打卡${action.note ? `（备注：${action.note}）` : ''}`;
  if (action.kind === 'meal') return `记一顿${SLOT[action.slot] || '饭'}：「${action.text}」`;
  if (action.kind === 'kb') return `直接写进知识库：「${action.text}」`;
  if (action.kind === 'memory') return `记进记忆树：「${action.text}」`;
  return '';
}

/* ---- 她（柳月虹）：人设接口 + 聊天活动记录 + 性格反思 ---- */

/** 记录一次聊天活动：她回到在线、能量+、反思计数+1 */
function noteChatActivity(store, count = 1) {
  const p = store.db.settings.persona;
  if (!p) return;
  p.lastActiveAt = now();
  p.state = 'online';
  p.energy = Math.min(1, (typeof p.energy === 'number' ? p.energy : 0.5) + 0.05);
  p.chatsSinceReflect = (p.chatsSinceReflect || 0) + count;
}

/** 和当前模型快速要一段短文（念头/反思用），20 秒超时；失败返回 null */
async function quickModelText(store, messages, maxTokens = 100, timeoutMs = 20000) {
  const { pick: api } = await resolveBestModel(store, '生成', false);
  const base = (api.baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...modelHeaders(api) },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: api.model, messages, stream: false, temperature: 0.7, max_tokens: maxTokens }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const text = (msg && String(msg.content || '').trim()) || '';
    // content 为空 = 模型把预算全花在思考上了：直接放弃，让调用方走模板兜底
    return text || null;
  } catch {
    return null;
  }
}

/** 每 6~8 轮对话反思一次性格（后台跑，不阻塞对话） */
async function runReflect(store) {
  const p = store.db.settings.persona;
  if (!p) return;
  if (Date.now() - (p.lastReflectAt || 0) < 30 * 60 * 1000) return;
  const recent = (store.db.data.chatMessages || [])
    .slice(-12)
    .map((m) => `${m.role === 'user' ? `${p.addressAs || '阿珑'}` : p.name || '柳月虹'}：${String(m.content || '').slice(0, 200)}`)
    .join('\n');
  if (!recent.trim()) return;
  const answer = await quickModelText(store, [{ role: 'user', content: reflectPrompt(p, recent) }], 200);
  if (!answer) return;
  const lines = answer
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '无' && l !== '没有' && !/^#/.test(l))
    .slice(0, 2);
  if (!lines.length) return;
  p.traits = mergeTraits(p.traits, lines, 'reflect', now());
  p.chatsSinceReflect = 0;
  p.lastReflectAt = Date.now();
  store.save();
}

/** 聊天后检查是否该反思（7 轮起） */
function maybeReflect(store) {
  const p = store.db.settings.persona;
  if (!p || (p.chatsSinceReflect || 0) < 7) return;
  runReflect(store).catch(() => {});
}

/* ---- 每日简报：本机生成一段"今天要干什么"的文字（给 QQ 机器人 / 邮箱推送用） ---- */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysLocal(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekdayCN(dateStr) {
  return WEEKDAY_CN[new Date(`${dateStr}T00:00:00`).getDay()];
}

function buildBriefing(data, date) {
  const tasks = (data.tasks || []).filter((t) => t.date === date && !t.done);
  const studies = (data.studyItems || []).filter((s) => !s.done);
  const tmr = addDaysLocal(date, 1);
  const late = studies.filter((s) => s.due && s.due < date);
  const dueToday = studies.filter((s) => s.due === date);
  const dueTomorrow = studies.filter((s) => s.due === tmr);
  const withCourse = (s) => `${s.title}${s.course ? `（${s.course}）` : ''}`;

  const lines = [`🌸 工作台日报 · ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${weekdayCN(date)}`, ''];
  if (tasks.length) {
    lines.push(`📋 今日任务（待办 ${tasks.length} 条）`);
    for (const t of tasks.slice(0, 12)) lines.push(`· ${t.title}`);
    if (tasks.length > 12) lines.push(`· …还有 ${tasks.length - 12} 条`);
    lines.push('');
  }
  if (late.length || dueToday.length || dueTomorrow.length) {
    lines.push('📚 学习任务');
    for (const s of late) lines.push(`· 已过期：${withCourse(s)}`);
    for (const s of dueToday) lines.push(`· 今天截止：${withCourse(s)}`);
    for (const s of dueTomorrow) lines.push(`· 明天截止：${withCourse(s)}`);
    lines.push('');
  }
  if (!tasks.length && !late.length && !dueToday.length && !dueTomorrow.length) {
    lines.push('今天没有待办，享受一天吧 🌸');
  }

  return {
    date,
    weekday: weekdayCN(date),
    tasks: tasks.map((t) => t.title),
    studyLate: late.map(withCourse),
    studyDueToday: dueToday.map(withCourse),
    studyDueTomorrow: dueTomorrow.map(withCourse),
    memoCount: (data.memos || []).length,
    text: lines.join('\n').trim(),
  };
}

/** 两条文字的相似度（0~1）：互相包含或字符重合率，用于去重与印证 */
export function similarity(a, b) {
  const x = String(a || '').replace(/\s+/g, '');
  const y = String(b || '').replace(/\s+/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length) >= 0.45 ? 0.9 : 0.6;
  }
  const set = new Set(x);
  let hit = 0;
  for (const ch of y) if (set.has(ch)) hit++;
  return hit / Math.max(x.length, y.length);
}

/** 按内容猜记忆该放哪根枝 */
export function guessMemoryBranch(text) {
  const t = String(text || '');
  if (/喜欢|不喜欢|讨厌|最爱|偏好|爱(吃|看|听|喝)/.test(t)) return 'preference';
  if (/工作|项目|公司|客户|同事|老板|加班|上班/.test(t)) return 'work';
  if (/住在|年龄|生日|我是|我叫|家乡|在(读|上学|考研|考公)|学校|专业/.test(t)) return 'about';
  if (/点子|想法|灵感|想做|打算(做|写|学)/.test(t)) return 'idea';
  return 'life';
}

/** 记忆加强：新内容与旧记忆"几乎同句"（≥0.85）才算重复并只加强；
 * 0.55~0.85 的相似多为"同一话题的不同事实"（实测：误吞对 0.71 > 真重复对 0.67，
 * 单一 0.55 阈值会把新信息吞掉），放行新增——宁可轻微冗余，绝不丢信息。 */
export function boostMemoryIfMatched(memories, text) {
  let hit = false;
  for (const m of memories) {
    if (similarity(m.text, text) >= 0.85) {
      m.weight = Math.min(5, (Number(m.weight) || 1) + 1);
      m.updatedAt = now();
      hit = true;
    }
  }
  return hit;
}

/** 把记忆树的内容拼成一段给模型的系统提示；置顶→强度→最近更新，总字数控制在约 1200 以内 */
function buildMemorySystem(memories) {
  const list = memories
    .filter((m) => m && String(m.text || '').trim())
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        Number(b.weight || 1) - Number(a.weight || 1) ||
        String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')),
    );
  const groups = new Map();
  let budget = 1200;
  for (const m of list) {
    const text = String(m.text).trim();
    if (text.length > budget) break;
    budget -= text.length;
    const label = MEMORY_BRANCHES[m.branch] || '其他';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(text);
  }
  if (groups.size === 0) return null;
  const parts = [...groups.entries()].map(([label, texts]) => `【${label}】${texts.join('；')}`);
  return `你是阿珑的私人助手。以下是你记得的关于 TA 的事：${parts.join(' ')}。回答时自然地用上这些记忆，不要逐条罗列出来。`;
}

/** 学习通通道：把同步到的课业近况拼成一段系统提示，注入聊天——AI 从此"看得见"学习通。
 *  没连接就返回空串（不注入，省 token 也避免模型瞎编作业）。纯函数，可测。 */
export function buildXxtContext(settings) {
  const x = settings && settings.xxt;
  if (!x || !x.cookie || x.status === 'off') return '';
  const nowMs = Date.now();
  const hw = settings.xxtHomeworks || [];
  const pending = hw.filter((h) => h && h.status !== 'submitted').slice(-8).reverse();
  const submitted = hw.filter((h) => h && h.status === 'submitted').length;
  const lines = ['【学习通近况（工作台自动同步，学生本人视角只读拉取）】'];
  const lastSync = x.lastSyncAt ? new Date(x.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '从未';
  lines.push(`连接：${x.status === 'need_login' ? '登录态过期（等他重新连接）' : '在线'}；上次同步：${lastSync}`);
  for (const h of pending) {
    const st = { new: '新到还没做草稿', drafted: '草稿已备好（他去核对后确认提交）', confirmed: '已确认待提交', submit_failed: '上次提交没成（草稿还在）', read_failed: '读题失败', failed: '草稿生成失败' }[h.status] || h.status;
    lines.push(`- 《${h.course || '课'}》${h.title}${h.due ? '｜截止 ' + h.due : ''}｜${st}`);
  }
  if (submitted) lines.push(`已交进学习通：${submitted} 份`);
  const notices = (settings.xxtNotices || []).filter((n) => n && ['exam', 'checkin'].includes(n.kind) && nowMs - (n.at || 0) < 7 * 24 * 3600000).slice(-4);
  for (const n of notices) lines.push(`- ${n.kind === 'exam' ? '考试' : '签到'}：${n.title}`);
  if (lines.length <= 2) lines.push('（近 7 天没有待办作业/考试）');
  lines.push('回答时可以把这些当成已知近况自然带一句，别逐条背诵；他没问就别主动刷屏提。');
  return lines.join('\n').slice(0, 1500);
}

/** 作业列表修剪：交过/失败的旧条目超 30 天可清，未了的永远保留（旧版一刀切 20 条会把没交的作业挤丢） */
export function pruneXxtHomeworks(list) {
  const fresh = (list || []).filter(
    (h) => h && (!(h.status === 'submitted' || h.status === 'failed') || Date.now() - (h.updatedAt || h.createdAt || 0) <= 30 * 24 * 3600000),
  );
  return fresh.length > 60 ? fresh.slice(-60) : fresh;
}

export function createApp(store) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // gzip 压缩：页面/JSON 传输体积小一半以上（外网更明显）；跳过 SSE 流式对话和音视频
  app.use(
    compression({
      filter: (req, res) => {
        const ct = String(res.getHeader('Content-Type') || '');
        if (ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  /* ---- 局域网访问口令：本机访问免口令；同一 WiFi 下的手机/别的设备需要口令 ---- */

  let pinCache = store?.dataDir ? ensureLanPin(store.dataDir) : { pin: '', file: '' };
  app.locals.lanPin = pinCache.pin;
  app.locals.lanPinFile = pinCache.file;

  // 防暴力猜口令：同一个来源连错 5 次，锁 5 分钟
  const lanFails = new Map();
  const MAX_FAILS = 5;
  const LOCK_MS = 5 * 60 * 1000;

  // 模型状态查询的 10 秒缓存
  let modelsStatusCache = { at: 0, data: null };

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/recordings') && !req.path.startsWith('/files')) {
      return next();
    }
    if (req.path === '/api/health') return next();
    // 跨站防护：浏览器里的其它网站（带陌生 Origin）不能借"本机免口令"调用接口——
    // 否则打开一个恶意网页就能偷偷往你电脑里传文件/写记录
    const origin = req.get('origin');
    if (origin) {
      const o = origin.replace(/^https?:\/\//i, '');
      const host = req.get('host') || '';
      const ok =
        o === host ||
        o.startsWith('localhost') ||
        o.startsWith('127.0.0.1') ||
        o.endsWith('.trycloudflare.com');
      if (!ok) return res.status(403).json({ error: '跨站请求被拒绝' });
    }
    // 走隧道/反代的请求：真正的来源在代理头里，绝不能当"本机访问"放行
    const forwarded = `${req.get('cf-connecting-ip') || ''}`.trim() || `${req.get('x-forwarded-for') || ''}`.split(',')[0].trim();
    const ownerKey = forwarded || String((req.socket && req.socket.remoteAddress) || '?');
    if (!forwarded && isLocalAddress(req.socket && req.socket.remoteAddress)) return next();
    if (!pinCache.pin) return next();
    const rec = lanFails.get(ownerKey);
    if (rec && rec.lockedUntil > Date.now()) {
      return res.status(429).json({ error: '口令错误次数太多，等 5 分钟再试', needPin: true });
    }
    const given = req.get('x-workbench-pin') || req.query.k || '';
    if (String(given) === pinCache.pin) {
      lanFails.delete(ownerKey);
      return next();
    }
    const r2 = rec || { count: 0, lockedUntil: 0 };
    r2.count += 1;
    if (r2.count >= MAX_FAILS) {
      r2.lockedUntil = Date.now() + LOCK_MS;
      r2.count = 0;
    }
    lanFails.set(ownerKey, r2);
    if (lanFails.size > 500) {
      // 简单清理，防止 Map 无限长大
      const nowMs = Date.now();
      for (const [k, v] of lanFails) {
        if (v.lockedUntil < nowMs && v.count === 0) lanFails.delete(k);
      }
    }
    res.status(401).json({ error: '需要访问口令（在电脑上「启动工作台」窗口里能看到）', needPin: true });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'AI 助手' });
  });

  app.get('/api/all', (req, res) => {
    res.json({ data: store.db.data, settings: store.db.settings });
  });

  app.get('/api/settings', (req, res) => {
    // 掩码：画图密钥等敏感值绝不回传前端，只给"是否已设置"
    const { imagineKey, ...rest } = store.db.settings;
    res.json({ ...rest, imagineKeySet: !!(imagineKey && String(imagineKey).trim()) });
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body;
    if (!isObject(body)) return res.status(400).json({ error: '设置内容必须是对象' });
    const next = { ...store.db.settings };
    if ('theme' in body) {
      if (!THEMES.includes(body.theme)) return res.status(400).json({ error: '主题值不合法' });
      next.theme = body.theme;
    }
    if ('imagineProvider' in body) {
      if (!['auto', 'zhipu', 'pollinations', 'ollama'].includes(body.imagineProvider)) {
        return res.status(400).json({ error: '画图通道只能是 auto / zhipu / pollinations / ollama' });
      }
      next.imagineProvider = body.imagineProvider;
    }
    if ('imagineKey' in body) {
      if (typeof body.imagineKey !== 'string') return res.status(400).json({ error: '画图密钥必须是字符串' });
      const k = body.imagineKey.trim().slice(0, 120);
      // 防呆：智谱 Key 是「32位.16位」的 ASCII 串——中文/太短/缺点号一律拒收（不收脏 Key，免得画图谜之失败）
      if (k && (!/^[!-~]{16,120}$/.test(k) || !k.includes('.'))) {
        return res.status(400).json({ error: '这不像智谱 Key：应为 30~60 位英文数字串、中间带一个点（bigmodel.cn → 头像 → API Keys 整串复制）' });
      }
      next.imagineKey = k;
    }
    if ('platforms' in body) {
      if (!Array.isArray(body.platforms) || body.platforms.some((p) => typeof p !== 'string')) {
        return res.status(400).json({ error: '平台列表不合法' });
      }
      next.platforms = body.platforms;
    }
    if ('weeklyPlan' in body) {
      const w = body.weeklyPlan;
      if (!Array.isArray(w) || w.length !== 7 || w.some((x) => typeof x !== 'string')) {
        return res.status(400).json({ error: '周计划必须是 7 条内容' });
      }
      next.weeklyPlan = w;
    }
    if ('gamePlan' in body) {
      const g = body.gamePlan;
      if (!Array.isArray(g) || g.length !== 7 || g.some((x) => typeof x !== 'string')) {
        return res.status(400).json({ error: '游戏周计划必须是 7 条内容' });
      }
      next.gamePlan = g;
    }
    if ('waterGoal' in body) {
      if (typeof body.waterGoal !== 'number' || !(body.waterGoal > 0)) {
        return res.status(400).json({ error: '喝水目标不合法' });
      }
      next.waterGoal = body.waterGoal;
    }
    if ('models' in body) {
      if (!Array.isArray(body.models)) return res.status(400).json({ error: '模型列表必须是数组' });
      // 显式传列表时严格校验：每条都要合法（不做"迁移兜底"）
      const seen = new Set();
      const normalized = body.models.map((m) => normalizeModelEntry(m, seen)).filter(Boolean);
      if (!normalized.length || normalized.length !== body.models.length) {
        return res.status(400).json({ error: '模型列表里有不合法的条目（地址要 http/https 开头，模型名不能为空）' });
      }
      next.models = normalized;
      if (!next.models.some((m) => m.id === next.activeModelId)) {
        next.activeModelId = next.models[0].id;
      }
    }
    if ('activeModelId' in body) {
      const list = next.models || store.db.settings.models || [];
      if (!list.some((m) => m.id === body.activeModelId)) {
        return res.status(400).json({ error: '这个模型不在列表里' });
      }
      if (list.some((m) => m.id === body.activeModelId && m.kind === 'image')) {
        return res.status(400).json({ error: '「生成图片」是画图专用模型，不能设为聊天当前模型——画图引擎在助手页的模型菜单里切换' });
      }
      next.activeModelId = body.activeModelId;
    }
    if ('modelApi' in body) {
      const m = body.modelApi;
      if (!isObject(m) || typeof m.baseUrl !== 'string' || typeof m.model !== 'string') {
        return res.status(400).json({ error: '模型服务配置不合法' });
      }
      next.modelApi = { baseUrl: m.baseUrl.trim(), model: m.model.trim() };
      // 老写法改的是"当前激活模型"的地址/名字，同步进模型列表
      const list = [...(next.models || [])];
      const idx = list.findIndex((x) => x.id === next.activeModelId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], baseUrl: next.modelApi.baseUrl, model: next.modelApi.model };
        next.models = list;
      }
    }
    if ('memoryEnabled' in body) {
      if (typeof body.memoryEnabled !== 'boolean') {
        return res.status(400).json({ error: '记忆开关的值不合法' });
      }
      next.memoryEnabled = body.memoryEnabled;
    }
    if ('autoMemory' in body) {
      if (typeof body.autoMemory !== 'boolean') return res.status(400).json({ error: '自动发现开关的值不合法' });
      next.autoMemory = body.autoMemory;
    }
    if ('memoryMode' in body) {
      if (body.memoryMode !== 'auto' && body.memoryMode !== 'ask') {
        return res.status(400).json({ error: '记忆模式的值不合法' });
      }
      next.memoryMode = body.memoryMode;
    }
    if ('autoRoute' in body) {
      if (typeof body.autoRoute !== 'boolean') return res.status(400).json({ error: '自动调度开关的值不合法' });
      next.autoRoute = body.autoRoute;
      autoRouteCache.at = 0; // 切换调度模式，清掉路由缓存
    }
    if ('autoManage' in body) {
      if (typeof body.autoManage !== 'boolean') return res.status(400).json({ error: '模型管家开关的值不合法' });
      next.autoManage = body.autoManage;
    }
    if ('selectedModels' in body) {
      if (!Array.isArray(body.selectedModels) || body.selectedModels.some((x) => typeof x !== 'string')) {
        return res.status(400).json({ error: '多选模型列表不合法' });
      }
      const ids = new Set((next.models || []).map((m) => m.id));
      next.selectedModels = body.selectedModels.filter((x) => ids.has(x)).slice(0, 20);
      autoRouteCache.at = 0; // 模型池变了，清掉路由缓存
    }
    // 兼容镜像：modelApi 始终跟随"当前激活"的模型
    const activeNow =
      (next.models || []).find((m) => m.id === next.activeModelId) || (next.models || [])[0] || null;
    if (activeNow) next.modelApi = { baseUrl: activeNow.baseUrl, model: activeNow.model };
    modelsStatusCache = { at: 0, data: null }; // 设置变了，状态缓存作废
    store.db.settings = next;
    store.save();
    res.json(next);
  });

  app.get('/api/briefing', (req, res) => {
    const q = typeof req.query.date === 'string' ? req.query.date : '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayLocal();
    res.json(buildBriefing(store.db.data, date));
  });

  /* 记录意图识别（QQ 机器人等非浏览器场景用） */
  app.post('/api/assistant-action', (req, res) => {
    const b = req.body;
    if (!isObject(b) || typeof b.text !== 'string') return res.status(400).json({ error: '请求格式不对' });
    const action = detectAssistantAction(b.text, todayLocal());
    res.json({ action, describe: action ? describeAction(action) : '' });
  });

  /* 一次性对话（QQ 机器人等非流式场景）：走当前激活模型 + 记忆注入；可把这段存进对话记录 */
  app.post('/api/chat-once', async (req, res) => {
    const body = req.body;
    if (!isObject(body) || !Array.isArray(body.messages) || !body.messages.length) {
      return res.status(400).json({ error: '请求格式不对' });
    }
    const lastUser = [...body.messages].reverse().find((m) => m && m.role === 'user');
    const route = await autoSwitchRoute(await resolveBestModel(store, lastUser ? lastUser.content : ''));
    const outMessages = body.messages.slice(-12).map((m) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || '').slice(0, 4000),
    }));
    if (store.db.settings.memoryEnabled !== false) {
      const sys = buildMemorySystem(store.db.data.memories || []);
      if (sys) outMessages.unshift({ role: 'system', content: sys });
    }
    // 学习通通道：把作业/考试近况带进 QQ 聊天（没连接则不注入）
    const xxtSysQQ = buildXxtContext(store.db.settings);
    if (xxtSysQQ) outMessages.unshift({ role: 'system', content: xxtSysQQ });
    // 她（柳月虹）的人设：最先注入，覆盖"我是谁/怎么说话"
    outMessages.unshift({ role: 'system', content: buildPersonaSystem(store.db.settings.persona) });
    // 让"推理型"模型别写长篇大论：QQ 里要的是能读的短回答
    outMessages.unshift({
      role: 'system',
      content: '请给出简洁的中文最终回答（尽量几句话内说完），不要罗列推理过程。',
    });
    // 候选模型依次尝试：选中的挂了自动试下一个（真正的"自动降级"）
    // 全局时间预算 150s：多候选逐个长超时会把调用方（QQ 桥 200s 超时）拖爆
    const chatDeadline = Date.now() + 150000;
    let content = '';
    let usedApi = null;
    let lastErr = null;
    const reasoningTailOf = (msg) => {
      if (!msg || !msg.reasoning_content) return '';
      return String(msg.reasoning_content)
        .trim()
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-6)
        .join('\n')
        .trim();
    };
    for (const cand of route.candidates) {
      const base = (cand.baseUrl || '').replace(/\/+$/, '');
      if (!base) continue;
      if (Date.now() > chatDeadline) {
        lastErr = new Error('模型响应太慢（已等约 150 秒），可稍后再试或切换模型');
        break;
      }
      const isLocal = /127\.0\.0\.1|localhost|\[::1\]/i.test(base);
      try {
        const call = async (noThinking) => {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...modelHeaders(cand) },
            signal: AbortSignal.timeout(Math.max(5000, chatDeadline - Date.now())),
            body: JSON.stringify({
              model: cand.model,
              messages: mergeSystemMessages(outMessages),
              stream: false,
              temperature: 0.6,
              max_tokens: Math.min(Number(body.maxTokens) || 4096, 4096),
              ...(noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            }),
          });
          if (!r.ok) {
            const errText = await r.text().catch(() => '');
            if (r.status === 401 || r.status === 402 || r.status === 403) {
              const hint = r.status === 402 ? '（这个模型的余额不足）' : '（密钥不对或没权限）';
              const e = new Error(`模型服务返回异常（${r.status}）${hint}${errText.slice(0, 100)}`);
              e.authError = true;
              throw e;
            }
            throw new Error(`HTTP ${r.status} ${errText.slice(0, 80)}`);
          }
          const j = await r.json();
          const msg = j.choices && j.choices[0] && j.choices[0].message;
          return { content: (msg && String(msg.content || '').trim()) || '', tail: reasoningTailOf(msg) };
        };
        let got = await call(!isLocal);
        if (!got.content) {
          // 第一次的结果是"思考吃光预算、正式回答空"：
          // 云端→改回开思考再试；本机→试一次关思考（多数 llama.cpp 会忽略参数，随后走思考尾兜底）
          try {
            const retry = await call(isLocal);
            if (retry.content) got = retry;
          } catch {
            // 重试失败用第一次的结果
          }
        }
        // 推理型模型兜底：取思考的结尾部分当回答（本机 R1 等），避免收到空消息
        content = got.content || got.tail;
        if (!content) throw new Error('模型没输出内容');
        usedApi = cand;
        break;
      } catch (e) {
        if (e && e.authError) return res.status(502).json({ error: e.message });
        lastErr = e;
      }
    }
    if (!usedApi) {
      return res.status(502).json({ error: `模型服务返回异常：${lastErr ? lastErr.message : '没有可用模型'}` });
    }
    // 可选：把这一问一答存进工作台对话记录（QQ 里聊的，电脑上"AI 助手-对话"里也能翻到）
    if (body.record && content) {
      const lastUserMsg = outMessages.filter((m) => m.role === 'user').pop();
      const push = (role, text) => {
        store.db.data.chatMessages.push({
          id: crypto.randomUUID(),
          seq: store.nextSeq(),
          createdAt: now(),
          updatedAt: now(),
          role,
          content: text,
          source: 'qq',
        });
      };
      if (lastUserMsg) push('user', lastUserMsg.content);
      push('assistant', content);
    }
    noteChatActivity(store);
    store.save();
    maybeReflect(store);
    maybeDiscoverMemory(store).catch(() => {});
      res.json({ content, model: usedApi.model, name: usedApi.name, auto: route.auto, wanted: route.wanted, switched: route.switched || '' });
  });

  /* ---- 她（柳月虹）的接口 ---- */

  app.get('/api/persona', (req, res) => {
    const p = store.db.settings.persona;
    res.json({ persona: p, wakeLine: computeWakeLine(p, Date.now()) });
  });

  app.put('/api/persona', (req, res) => {
    const b = req.body;
    if (!isObject(b)) return res.status(400).json({ error: '请求内容必须是对象' });
    const p = store.db.settings.persona;
    if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim().slice(0, 20);
    if (typeof b.addressAs === 'string' && b.addressAs.trim()) p.addressAs = b.addressAs.trim().slice(0, 20);
    if (['quiet', 'free', 'active'].includes(b.freedom)) p.freedom = b.freedom;
    if (Array.isArray(b.traits)) {
      p.traits = b.traits
        .filter((t) => t && typeof t.text === 'string' && t.text.trim())
        .slice(-8)
        .map((t) => ({
          text: String(t.text).trim().slice(0, 60),
          weight: Math.max(1, Math.min(5, Number(t.weight) || 1)),
          source: ['reflect', 'feedback', 'manual'].includes(t.source) ? t.source : 'manual',
          updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now(),
        }));
    }
    if (b.clearThoughts === true) p.thoughts = [];
    if (b.clearDreams === true) p.dreams = [];
    // 运行时状态透传（调试/测试用；正常使用由 tick/wake 驱动）
    if (['online', 'daze', 'nap', 'sleep', 'chatty', 'hungry'].includes(b.state)) p.state = b.state;
    if (typeof b.lastActiveAt === 'string' && !Number.isNaN(Date.parse(b.lastActiveAt))) p.lastActiveAt = b.lastActiveAt;
    if (typeof b.nextAt === 'number') p.nextAt = b.nextAt;
    if (typeof b.thoughtAt === 'number') p.thoughtAt = b.thoughtAt;
    if (typeof b.wakeAt === 'number') p.wakeAt = b.wakeAt;
    if (typeof b.dreamAt === 'number') p.dreamAt = b.dreamAt;
    if (typeof b.modelOkUntil === 'number') p.modelOkUntil = b.modelOkUntil;
    if (typeof b.lastDigestAt === 'number') p.lastDigestAt = b.lastDigestAt;
    if (b.pendingModelThought === null) p.pendingModelThought = null;
    if (b.pendingDream === null) p.pendingDream = null;
    if (typeof b.modelBusy === 'boolean') p.modelBusy = b.modelBusy;
    if (typeof b.dreamBusy === 'boolean') p.dreamBusy = b.dreamBusy;
    if (Array.isArray(b.dreams)) {
      p.dreams = b.dreams
        .filter((d) => d && typeof d.text === 'string')
        .slice(-20)
        .map((d) => ({ at: d.at || now(), text: String(d.text).slice(0, 160), type: ['温馨', '奇怪', '搞笑', '怀旧'].includes(d.type) ? d.type : '温馨' }));
    }
    if (b.reset === true) {
      p.traits = [];
      p.thoughts = [];
      p.dreams = [];
      p.chatsSinceReflect = 0;
    }
    store.save();
    res.json({ persona: p });
  });

  /* ---- 拟人化状态机：服务端自治（不依赖页面开着），主动消息落进聊天流 ---- */

  let personaTickBusy = false;
  let lastModelOnline = null;

  async function personaTickCore({ activeAt = 0, sync = false } = {}) {
    const p = store.db.settings.persona;
    const nowMs = Date.now();
    const lastActiveMs = new Date(p.lastActiveAt || 0).getTime() || 0;
    const seenAt = Math.max(lastActiveMs, Number(activeAt) || 0);
    const userActive = nowMs - seenAt < 90 * 1000;
    const rng = makeRng((Math.random() * 2 ** 31) | 0);
    // 生成念头/梦用小提示：提示越短，思考型模型越不容易把预算全花在"思考"上
    const miniPrompt = () => ({
      role: 'system',
      content: `你是「${p.name}」。${PERSONA_OUTLINE}\n请直接按要求输出内容，不要思考过程、不要解释。`,
    });
    const opts = {};

    // ① 自由发挥的念头：让模型真的"想"一句（每小时最多一次；失败回退模板）
    if (p.freedom !== 'quiet' && nowMs >= (p.modelOkUntil || 0) && !p.modelBusy) {
      p.modelBusy = true;
      const gen = quickModelText(store, [
        miniPrompt(),
        {
          role: 'user',
          content: '请直接输出你此刻脑子里冒出来的一个念头（一两句话），可以关于用户最近的事、今天吃什么、一个小发现或小问题（想问用户的）；要完全符合你的性格，带一点小表情。',
        },
      ], 800, 90000);
      const apply = (text) => {
        if (text) {
          p.pendingModelThought = String(text).replace(/^（|^\(|）$|\)$/g, '').trim().slice(0, 120);
          p.modelOkUntil = Date.now() + 45 * 60 * 1000;
        }
      };
      if (sync) {
        apply(await gen);
        p.modelBusy = false;
      } else {
        gen.then(apply).catch(() => {}).finally(() => {
          p.modelBusy = false;
          try { store.save(); } catch { /* 忽略 */ }
        });
      }
    }
    opts.modelText = p.pendingModelThought;
    opts.modelOkUntil = p.modelOkUntil;

    // ② 状态推进（发呆/话多/嘴馋/打盹/睡觉/做梦/醒）
    const prevState = p.state;
    opts.dreamText = p.pendingDream;
    const out = tickPersona(p, store.db.data, nowMs, userActive, rng, opts);
    if (out.dream) p.pendingDream = null;

    // ③ 入睡时预生成一场梦（模型写、模板兜底；做梦内容自由）
    if (out.state === 'sleep' && prevState !== 'sleep' && p.freedom !== 'quiet' && !p.dreamBusy) {
      p.dreamBusy = true;
      const gen = quickModelText(store, [
        miniPrompt(),
        {
          role: 'user',
          content: '你刚睡着，正在做梦。请直接输出一到三句梦的内容（以「梦见」开头）：可以用用户的待办、学习任务或记忆当素材，也可以完全天马行空；像真做梦一样跳脱、没有禁忌，醒了要讲给用户听的。',
        },
      ], 900, 90000);
      const apply = (text) => {
        if (text) p.pendingDream = String(text).replace(/^梦见/, '').trim().slice(0, 260);
      };
      if (sync) {
        apply(await gen);
        p.dreamBusy = false;
      } else {
        gen.then(apply).catch(() => {}).finally(() => {
          p.dreamBusy = false;
          try { store.save(); } catch { /* 忽略 */ }
        });
      }
    }

    // ④ 每日自我整理：没被打扰时把最近的对话理成一条"小记"（只整理有用户参与的对话）
    if (p.freedom !== 'quiet' && !userActive && nowMs - (p.lastDigestAt || 0) > 20 * 60 * 60 * 1000) {
      const recentMsgs = (store.db.data.chatMessages || []).slice(-10);
      const recent = recentMsgs
        .map((m) => `${m.role === 'user' ? p.addressAs : p.name}：${String(m.content || '').slice(0, 160)}`)
        .join('\n');
      if (recent.trim() && recentMsgs.some((m) => m.role === 'user')) {
        const gen = (async () => {
          const digest = await quickModelText(store, [
            miniPrompt(),
            {
              role: 'user',
              content: `请直接输出一份 3~5 句的「小记」：用你的口吻整理你们聊过的事、你记得的细节、接下来可以留意什么。要像你写的日记，带一两个小表情，不要列清单。\n---\n${recent}`,
            },
          ], 700, 60000);
          if (!digest) return;
          const d = new Date();
          const day = `${d.getMonth() + 1}月${d.getDate()}日`;
          store.db.data.documents.push({
            id: crypto.randomUUID(),
            seq: store.nextSeq(),
            createdAt: now(),
            updatedAt: now(),
            title: `${p.name}的小记 · ${day}`,
            content: String(digest).trim(),
            source: 'chat',
          });
          p.thoughts.push({
            at: new Date().toISOString(),
            text: '我把这些天我们聊的东西理了理，写进文档里啦，你去看看嘛～✨',
            mood: 'happy',
            source: 'model',
          });
          p.thoughts = p.thoughts.slice(-50);
          p.lastDigestAt = Date.now();
        })();
        if (sync) await gen;
        else gen.catch(() => {}).finally(() => {
          try { store.save(); } catch { /* 忽略 */ }
        });
      }
    }

    // ⑤ 主动发言落进聊天流（你回来就能看到她干了啥）；限频防刷屏
    if (out.announce && p.freedom !== 'quiet') {
      const gap = nowMs - (p.lastAnnounceAt || 0);
      const kind = out.announce.kind;
      const isWake = kind === 'wake';
      const isThought = kind === 'thought';
      // 睡醒必发；其余 ≥5 分钟一条，发呆念头再抽 35%（避免念头刷屏）
      const allow = isWake || (gap > 5 * 60 * 1000 && (!isThought || makeRng(nowMs & 0x7fffffff)() < 0.35));
      if (allow) {
        store.db.data.chatMessages.push({
          id: crypto.randomUUID(),
          seq: store.nextSeq(),
          createdAt: now(),
          updatedAt: now(),
          role: 'assistant',
          content: out.announce.text,
          source: 'persona',
          personaKind: kind,
        });
        p.lastAnnounceAt = nowMs;
        out.announceSaved = true;
        // 同步进 QQ 推送队列：电脑看到的消息，绑定的 QQ 也要收到
        xxtPushQQ(out.announce.text, 'persona');
      }
    }

    store.save();
    return out;
  }

  app.post('/api/persona/tick', async (req, res) => {
    if (personaTickBusy) return res.json({ state: store.db.settings.persona.state, skipped: true });
    personaTickBusy = true;
    try {
      const b = isObject(req.body) ? req.body : {};
      const activeAt = typeof b.activeAt === 'string' ? new Date(b.activeAt).getTime() : 0;
      const out = await personaTickCore({ activeAt, sync: b.sync === true });
      res.json(out);
    } catch (e) {
      res.json({ state: (store.db.settings.persona || {}).state || 'online', error: '内部出错（已自愈，循环继续）' });
    } finally {
      personaTickBusy = false;
    }
  });

  // 自驱循环：每 20 秒 tick（页面不开她也是活的）；每 60 秒探测模型，刚连上就"来精神"补一轮活动
  let loopTick = 0;
  const personaTimer = setInterval(() => {
    (async () => {
      if (personaTickBusy) return;
      loopTick += 1;
      try {
        if (loopTick % 3 === 0) {
          const m = resolveActiveModel(store.db.settings);
          const online = m.baseUrl ? await probeModel(m, 1500) : false;
          if (lastModelOnline === false && online) {
            // 模型上线沿：她把攒的念想一次做掉——重置额度、来点精神、反思一轮
            const pp = store.db.settings.persona;
            if (pp) {
              pp.modelOkUntil = 0;
              pp.energy = Math.min(1, (typeof pp.energy === 'number' ? pp.energy : 0.5) + 0.15);
            }
            runReflect(store).catch(() => {});
          }
          lastModelOnline = online;
        }
        personaTickBusy = true;
        try {
          await personaTickCore({});
        } finally {
          personaTickBusy = false;
        }
      } catch {
        // 循环永不中断：单次出错自愈
      }
    })();
  }, 20000);
  if (personaTimer.unref) personaTimer.unref();

  app.post('/api/persona/wake', (req, res) => {
    const p = store.db.settings.persona;
    const nowMs = Date.now();
    const wasSleeping = p.state === 'sleep' || p.state === 'nap' || p.state === 'daze';
    let greet = null;
    if (wasSleeping) {
      greet = p.state === 'sleep' ? wakeGreeting(p, makeRng((Math.random() * 2 ** 31) | 0)) : '（揉了揉眼睛）你回来啦～';
    }
    p.state = 'online';
    p.lastActiveAt = new Date(nowMs).toISOString();
    p.energy = Math.min(1, p.energy + 0.15);
    p.wakeAt = null;
    p.dreamAt = null;
    p.nextAt = scheduleIdle(p, nowMs, makeRng((Math.random() * 2 ** 31) | 0));
    store.save();
    res.json({ greet });
  });

  /* ---- 学习通邮箱桥：官方通知 → 作业 → 大专生语料草稿 → QQ 确认闭环（全程免费合法） ---- */

  const xxtLog = (msg) => console.log('[学习通] ' + redact(msg, [store.db.settings.mailWatch.authCode]));

  function xxtPushQQ(text, tag) {
    const s = store.db.settings;
    s.qqPushQueue = [...(s.qqPushQueue || []), { id: crypto.randomUUID(), text, tag: String(tag || ''), at: Date.now() }].slice(-10);
  }

  // 用模型按"大专生语料规范"生成作业草稿（严格按老师要求；可带修改方向重做）
  async function xxtMakeDraft(h, extraNote) {
    const msgs = [{ role: 'system', content: buildDraftPrompt(store.db.settings.persona, h) }];
    if (extraNote) {
      msgs.push({ role: 'user', content: `上一版要按这个方向修改，务必遵守后重新完整输出：${String(extraNote).slice(0, 200)}` });
    }
    const draft = await quickModelText(store, msgs, 2200, 150000);
    const item = (store.db.settings.xxtHomeworks || []).find((x) => x.id === h.id);
    if (!item) return;
    item.updatedAt = Date.now();
    if (draft && draft.length >= 12) {
      item.status = 'drafted';
      item.draft = draft.slice(0, 4000);
      xxtPushQQ(`✍️「${item.title}」做完了，去工作台看草稿；要改就回「重做 ${item.id.slice(0, 8)}+方向」`, 'homework');
    } else {
      item.status = 'failed';
      xxtPushQQ(`😖「${item.title}」这次没做出来，回工作台点"重做"`, 'homework');
    }
    store.save();
  }

  // 一条解析过的通知进系统：去重 → 通知流水 → 作业入计划+排草稿 / 其余走提醒
  async function xxtHandleNotice(n) {
    const s = store.db.settings;
    // 永久去重（直连同步的稳定 ID）+ 24h 文本去重（邮箱/口令通道）
    if (n.extId) {
      if ((s.xxt.seenIds || []).includes(n.extId)) return false;
      s.xxt.seenIds = [...(s.xxt.seenIds || []), n.extId].slice(-2000);
    }
    const dup = (s.xxtNotices || []).some(
      (x) => x.title === n.title && x.due === n.due && x.kind === n.kind && Date.now() - x.at < 24 * 3600000,
    );
    if (dup) return false;
    s.xxtNotices = [...(s.xxtNotices || []), {
      id: crypto.randomUUID(), kind: n.kind, course: n.course, title: n.title, due: n.due, at: Date.now(),
    }].slice(-60);

    if (n.kind === 'homework') {
      const siId = crypto.randomUUID();
      store.db.data.studyItems.push({
        id: siId,
        seq: store.nextSeq(),
        createdAt: now(),
        updatedAt: now(),
        title: String(n.title).slice(0, 60),
        course: n.course,
        kind: '作业',
        due: n.due,
        done: false,
        doneAt: null,
      });
      const h = {
        id: crypto.randomUUID(),
        studyItemId: siId, // 联动锚点：提交成功后把学习计划里这份翻成已完成
        status: 'new',
        extId: String(n.extId || ''), // 直连同步的稳定锚点：没有它，读题/提交找不到作业
        course: n.course,
        title: n.title,
        due: n.due,
        requirement: n.requirement,
        note: '',
        draft: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      s.xxtHomeworks = pruneXxtHomeworks([...(s.xxtHomeworks || []), h]);
      xxtPushQQ(
        `📕《${n.course || '课程'}》${n.title}${n.due ? '｜截止 ' + n.due : ''}，我直接做了`,
        'notice',
      );
      store.save();
      xxtMakeDraft(h, '').catch((e) => xxtLog('草稿生成异常：' + (e && e.message)));
      return true;
    }
    if (n.kind === 'checkin') {
      xxtPushQQ(`⏰ 学习通签到通知（《${n.course || '课'}》）！快回 App 点一下，错过麻烦`, 'checkin');
    } else if (n.kind === 'exam') {
      xxtPushQQ(`📝 学习通考试通知：${n.title}${n.due ? ' · 相关时间 ' + n.due : ''}`, 'notice');
    } else {
      xxtPushQQ(`🔔 学习通通知：${noticeToLine(n)}`, 'notice');
    }
    store.save();
    return true;
  }

  const xxtFetchMail = makeImapFetcher(xxtLog);
  let xxtPollBusy = false;

  async function xxtPollNow() {
    if (xxtPollBusy) return { ok: true, skipped: 'busy', count: 0 };
    xxtPollBusy = true;
    try {
      const mw = store.db.settings.mailWatch;
      const r = await pollMailbox(mw, { fetchMail: xxtFetchMail, onNotice: xxtHandleNotice, log: xxtLog });
      if (r.ok) {
        mw.lastError = '';
        if (typeof r.lastUid === 'number') mw.lastUid = Math.max(mw.lastUid || 0, r.lastUid);
      } else {
        mw.lastError = redact(String(r.error || '失败'), [mw.authCode]).slice(0, 200);
      }
      mw.lastPollAt = Date.now();
      store.save();
      return r;
    } catch (e) {
      const mw = store.db.settings.mailWatch;
      mw.lastError = redact(String((e && e.message) || '轮询异常'), [mw.authCode]).slice(0, 200);
      store.save();
      return { ok: false, error: '轮询异常', count: 0 };
    } finally {
      xxtPollBusy = false;
    }
  }

  /* ================= 学习通直连（方案 A：登录态只读同步） =================
     原则：只读（不提交/不签到/不刷课）、低频+抖动、登录态失效即熔断、Cookie 只存本机。 */

  let xxtLoginBusy = false;
  let xxtSyncBusy = false;

  // 开一个真浏览器让用户自己登录（密码由用户亲手输入，工作台只提取登录后的 Cookie）
  async function xxtOpenLogin() {
    if (xxtLoginBusy) return { ok: false, error: '上一个登录窗口还开着，请先去完成登录' };
    xxtLoginBusy = true;
    (async () => {
      let browser = null;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: false });
        const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
        const page = await ctx.newPage();
        await page.goto('https://i.chaoxing.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        const deadline = Date.now() + 5 * 60 * 1000;
        let cookieStr = '';
        while (Date.now() < deadline) {
          await page.waitForTimeout(2000).catch(() => {});
          try {
            const all = await ctx.cookies();
            const cs = all.filter((c) => /(^|\.)chaoxing\.com$/i.test(c.domain));
            const url = page.url();
            if (cs.some((c) => c.name === 'UID' && c.value) && !/passport/i.test(url)) {
              cookieStr = cs.map((c) => `${c.name}=${c.value}`).join('; ');
              break;
            }
          } catch {
            /* 用户提前关了窗口会抛错，按未登录处理 */
          }
        }
        const x = store.db.settings.xxt;
        if (cookieStr) {
          x.cookie = cookieStr;
          x.status = 'ready';
          x.syncMsg = '已连接（只读）';
          store.save();
          xxtLog('登录态已取得，开始首轮只读同步');
          xxtSyncOnce().catch(() => {});
        } else {
          x.syncMsg = x.cookie ? '这次没等到新登录，现有连接保持不变' : '5 分钟内没完成登录，连接未建立';
          store.save();
        }
      } catch (e) {
        const x = store.db.settings.xxt;
        x.status = 'error';
        x.syncMsg = '登录窗口打开失败：' + String((e && e.message) || e).slice(0, 100);
        store.save();
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch {
            /* 已关 */
          }
        }
        xxtLoginBusy = false;
      }
    })();
    return {
      ok: true,
      message: '浏览器窗口已弹出：请在里面登录学习通（扫码或输账号密码——工作台不存密码，只取登录后的 Cookie），登录成功会自动关闭并接入',
    };
  }

  // 无头浏览器加载器：新版学习通是 JS 渲染的微前端，普通 HTTP 拿不到课程列表；
  // 用 Playwright（本机已有，登录窗口同款）带 Cookie 渲染真实页面。整体无界面、跑完即关。
  async function xxtMakeLoader() {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      });
      const raw = String(store.db.settings.xxt.cookie || '');
      const cookies = raw
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf('=');
          return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: '.chaoxing.com', path: '/' };
        })
        .filter((c) => c.name);
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      const loadPage = async (url) => {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch {
          /* 超时也继续读已渲染部分 */
        }
        // 新版学习通首页把课程列表放在内嵌 iframe 里渲染（主框架 HTML 没有 courseid）：
        // 等子框架加载后，把主框架+所有子框架的 HTML 合并返回
        await page.waitForTimeout(6000);
        let html = '';
        try {
          for (const f of page.frames()) {
            html += await f.content().catch(() => '');
          }
        } catch {
          html = await page.content().catch(() => '');
        }
        return { html, finalUrl: page.url(), status: 200 };
      };
      return { loadPage, done: async () => { try { await browser.close(); } catch { /* 已关 */ } } };
    } catch (e) {
      try {
        await browser.close();
      } catch {
        /* 已关 */
      }
      throw e;
    }
  }

  async function xxtSyncOnce() {
    if (xxtSyncBusy) return { ok: true, skipped: 'busy' };
    const x = store.db.settings.xxt;
    if (!x.cookie) return { ok: false, error: '还没连接学习通' };
    xxtSyncBusy = true;
    try {
      let loader = null;
      for (let attempt = 0; attempt < 2 && !loader; attempt++) {
        try {
          loader = await xxtMakeLoader();
        } catch (e) {
          if (attempt === 0) {
            xxtLog(`无头浏览器拉起失败（${String((e && e.message) || e).slice(0, 80)}），10 秒后重试一次`);
            await new Promise((r) => setTimeout(r, 10000));
          } else {
            xxtLog('无头浏览器仍不可用，退回普通请求（可能读不到 JS 渲染的课程）');
          }
        }
      }
      let r;
      try {
        r = await syncXxt({
          cookie: x.cookie,
          loadPage: loader ? loader.loadPage : undefined,
          onItem: async (item) => {
            try {
              return await xxtHandleNotice(item);
            } catch {
              return false;
            }
          },
        });
      } finally {
        // 防呆（进程泄漏修复）：syncXxt 抛异常时也必须关浏览器，否则每轮崩溃漏一个 chromium
        if (loader) {
          try {
            await loader.done();
          } catch {
            /* 关不掉就算了，别让清理失败盖过真错误 */
          }
        }
      }
      x.lastSyncAt = Date.now();
      if (r.status === 'need_login') {
        x.status = 'need_login'; // 熔断：不再撞接口，等用户重连
        x.syncMsg = r.error || '登录态失效，请重新连接';
        xxtPushQQ('🔌 学习通登录态过期了，在工作台点一下「连接学习通」重新扫码就好', 'xxt');
      } else if (r.ok) {
        x.status = 'synced';
        x.syncMsg = `${r.status === 'partial' ? `时间到只跑了 ${r.doneCourses}/${r.courses} 门课（下轮接着）` : `同步完成：${r.courses} 门课`}，新通知 ${r.newCount} 条${(r.fails || []).length ? `（${r.fails.length} 门课没抓到：${r.fails.slice(0, 3).join('、')}${r.fails.length > 3 ? '…' : ''}）` : ''}`;
        if ((r.fails || []).length) xxtLog(`本轮 ${r.fails.length} 门课抓取失败：${r.fails.join('；')}`);
      } else {
        x.status = 'error';
        x.syncMsg = String(r.error || '同步失败').slice(0, 200);
      }
      store.save();
      return { ok: r.ok, status: x.status, newCount: r.newCount, courses: r.courses };
    } catch (e) {
      const x2 = store.db.settings.xxt;
      x2.status = 'error';
      x2.syncMsg = '同步异常：' + String((e && e.message) || e).slice(0, 160);
      store.save();
      return { ok: false, error: x2.syncMsg };
    } finally {
      xxtSyncBusy = false;
    }
  }

  app.get('/api/xxt/status', (req, res) => {
    const x = store.db.settings.xxt;
    res.json({
      status: x.cookie ? x.status : 'off',
      connected: !!x.cookie,
      lastSyncAt: x.lastSyncAt || 0,
      syncMsg: x.syncMsg || '',
      seen: (x.seenIds || []).length,
      loginBusy: xxtLoginBusy,
      syncing: xxtSyncBusy,
    });
  });

  app.post('/api/xxt/connect', async (req, res) => {
    const r = await xxtOpenLogin();
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.post('/api/xxt/sync', async (req, res) => {
    const x = store.db.settings.xxt;
    if (!x.cookie) return res.status(409).json({ error: '还没连接学习通' });
    if (['error', 'synced', 'ready'].includes(x.status) || x.cookie) {
      const r = await xxtSyncOnce();
      res.json(r);
      return;
    }
    res.status(409).json({ error: x.syncMsg || '当前状态不能同步' });
  });

  // 一键退出：删 Cookie（已入库的计划/草稿保留）
  app.post('/api/xxt/disconnect', (req, res) => {
    const x = store.db.settings.xxt;
    x.cookie = '';
    x.status = 'off';
    x.syncMsg = '已退出学习通连接';
    store.save();
    res.json({ ok: true });
  });

  // 自轮询：正常 30 分钟 ± 3 分钟随机（不掐同一个点去轰炸接口）；上一轮出错自动拉长到 60 分钟退避；
  // need_login 状态不在轮询名单里=天然熔断，等用户重新连接。连上 45 秒后先跑首轮。测试环境不自动跑。
  if (process.env.NO_AUTOSTART !== '1') {
    const xxtLoop = () => {
      let delay = 30 * 60 * 1000;
      try {
        const cur = store.db.settings.xxt || {};
        delay = (cur.status === 'error' ? 60 : 30) * 60000 + Math.floor(Math.random() * 6 * 60000) - 180000;
      } catch {
        /* 测试裸调 createApp（不带 store）：用默认间隔，绝不拦启动 */
      }
      setTimeout(() => {
        try {
          const x = store.db.settings.xxt || {};
          if (x.cookie && ['ready', 'synced', 'error'].includes(x.status)) xxtSyncOnce().catch(() => {});
        } catch {
          /* store 不可用（测试环境）：这轮跳过 */
        }
        xxtLoop();
      }, delay).unref?.();
    };
    xxtLoop();
    const xxtFirstSync = setTimeout(() => {
      const x = store.db.settings.xxt;
      if (x.cookie) xxtSyncOnce().catch(() => {});
    }, 45000);
    if (xxtFirstSync.unref) xxtFirstSync.unref();
  }

  app.get('/api/mailwatch', (req, res) => {
    const mw = store.db.settings.mailWatch;
    res.json({
      config: {
        enabled: !!mw.enabled,
        host: mw.host,
        user: mw.user,
        authCodeSet: !!mw.authCode,
        lastUid: mw.lastUid || 0,
        lastError: mw.lastError || '',
        lastPollAt: mw.lastPollAt || 0,
      },
      notices: (store.db.settings.xxtNotices || []).slice().reverse(),
      homeworks: (store.db.settings.xxtHomeworks || []).slice().reverse(),
    });
  });

  app.put('/api/mailwatch', async (req, res) => {
    const b = req.body;
    if (!isObject(b)) return res.status(400).json({ error: '请求内容必须是对象' });
    const mw = store.db.settings.mailWatch;
    if ('enabled' in b) {
      if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: '开关的值不合法' });
      mw.enabled = b.enabled;
    }
    if (typeof b.host === 'string' && /^[\w.-]+$/.test(b.host)) mw.host = b.host.slice(0, 60);
    if (typeof b.user === 'string') mw.user = b.user.trim().slice(0, 80);
    if (typeof b.authCode === 'string' && b.authCode.trim()) mw.authCode = b.authCode.trim().slice(0, 64);
    store.save();
    let test = null;
    if (b.pollNow === true && mw.enabled && mw.user && mw.authCode) test = await xxtPollNow();
    const pub = () => ({
      enabled: mw.enabled,
      host: mw.host,
      user: mw.user,
      authCodeSet: !!mw.authCode,
      lastUid: mw.lastUid,
      lastError: mw.lastError,
      lastPollAt: mw.lastPollAt,
    });
    res.json({ ok: true, config: pub(), test });
  });

  // 自测通道：把一段邮件原文走一遍真实管道（和轮询同规则：先过"是不是学习通"，不开邮箱也能验证）
  app.post('/api/mailwatch/simulate', async (req, res) => {
    const b = req.body;
    if (!isObject(b) || (typeof b.text !== 'string' && typeof b.subject !== 'string')) {
      return res.status(400).json({ error: '请提供邮件主题/正文' });
    }
    const mail = {
      from: String(b.from || '').slice(0, 80),
      subject: String(b.subject || ''),
      text: String(b.text || '').slice(0, 4000),
    };
    const before = (store.db.settings.xxtNotices || []).length;
    const passed = looksLikeXxt(mail.from, mail.subject, mail.text);
    if (passed) {
      await xxtHandleNotice(parseXxtNotice(mail));
    }
    const after = (store.db.settings.xxtNotices || []).length;
    // 防呆：分被"没签名"挡掉和被"重复"挡掉——都报 filtered 会把排查的人引向错误方向（实测踩坑）
    res.json({ ok: true, added: after - before, filtered: !passed, deduped: passed && after === before, notices: (store.db.settings.xxtNotices || []).slice(-3).reverse() });
  });

  // 截图桥：把"学习通页面读出来的文字"（QQ 截图/屏幕 OCR/自测粘贴）整理成通知，走同一条作业流水线
  app.post('/api/xxt/ingest-text', async (req, res) => {
    const b = req.body;
    if (!isObject(b) || typeof b.text !== 'string' || b.text.trim().length < 6) {
      return res.status(400).json({ error: '文字太少，认不出这是学习通的什么信息（多截点内容再发）' });
    }
    const n = noticeFromPlainText(b.text);
    const before = (store.db.settings.xxtNotices || []).length;
    await xxtHandleNotice(n);
    const after = (store.db.settings.xxtNotices || []).length;
    res.json({
      ok: true,
      added: after - before,
      kind: n.kind,
      course: n.course,
      title: n.title,
      due: n.due,
    });
  });

  // 识图取字（OCR 模式）：把图里所有文字原样抄出来——给学习通截图桥用
  app.post('/api/vision/ocr', async (req, res) => {
    const b = req.body;
    if (!isObject(b) || typeof b.image !== 'string' || !b.image) {
      return res.status(400).json({ error: '缺少图片内容' });
    }
    try {
      // 防呆：视觉模型没开着 OCR 会直接 502——用时按需自启（起不动再交给下方双级回退）
      if (!(await probePort(MODEL_DEFS.vision.port))) {
        const { missing } = modelNeeds('vision');
        if (!missing) {
          try {
            await ensureLocalModel('vision', 45000, '学习通作业读题');
          } catch {
            /* 起失败不拦路，visionChat 自己会报错 */
          }
        }
      }
      const r = await visionChat(
        [
          { type: 'image_url', image_url: { url: `data:${b.mime || 'image/png'};base64,${b.image}` } },
          { type: 'text', text: '请把图片里出现的所有文字逐行原样抄写出来（中文保留中文、数字保留数字），不要翻译、不要解释、不要描述画面；如果没有任何文字，只输出「空」。' },
        ],
        700,
      );
      const text = String(r.text || '').trim();
      res.json({ text: text === '空' ? '' : text, engine: r.engine });
    } catch (e) {
      res.status(502).json({ error: '识别失败：' + (e && e.message ? e.message : e) });
    }
  });

  app.post('/api/xxt/confirm', (req, res) => {
    const b = req.body;
    const id = String((b && b.id) || '');
    const h = (store.db.settings.xxtHomeworks || []).find((x) => x.id === id || x.id.startsWith(id));
    if (!h) return res.status(404).json({ error: '找不到这份作业' });
    if (!h.draft) return res.status(409).json({ error: '还没有草稿，先点"重做"生成一份' });
    h.status = 'confirmed';
    h.updatedAt = Date.now();
    xxtPushQQ(`✅ 「${h.title}」你确认啦，全文在这，复制去交：\n${h.draft}`, 'homework');
    store.save();
    res.json({ ok: true, draft: h.draft });
  });

  app.post('/api/xxt/redo', (req, res) => {
    const b = req.body;
    const id = String((b && b.id) || '');
    const note = String((b && b.note) || '').slice(0, 200);
    const h = (store.db.settings.xxtHomeworks || []).find((x) => x.id === id || x.id.startsWith(id));
    if (!h) return res.status(404).json({ error: '找不到这份作业' });
    h.note = note;
    h.status = 'new';
    h.updatedAt = Date.now();
    store.save();
    xxtMakeDraft(h, note).catch((e) => xxtLog('重做异常：' + (e && e.message)));
    res.json({ ok: true, status: 'generating' });
  });

  // —— 读题干 / 提交答案：钻进作业详情页操作（一次只跑一个浏览器任务，防打架）——
  let xxtTaskBusy = false;
  const findHw = (id) => (store.db.settings.xxtHomeworks || []).find((x) => x.id === id || String(x.id).startsWith(String(id || '').slice(0, 8)));
  const saveProof = (h, b64) => {
    if (!b64) return '';
    try {
      const dir = path.join(store.dataDir, 'xxt-proof');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${h.id}.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return file;
    } catch {
      return '';
    }
  };
  const openHwTask = async (h) => {
    const taskId = String(h.extId || '').split(':')[1] || '';
    if (!taskId) return { error: '这条是老记录，没有作业锚点——先点「重做」重新生成一条' };
    const { chromium } = await import('playwright');
    return openTaskPage({ chromium, cookie: store.db.settings.xxt.cookie, course: h.course, taskId, log: xxtLog });
  };

  app.post('/api/xxt/homework/read', async (req, res) => {
    const h = findHw(String((req.body && req.body.id) || ''));
    if (!h) return res.status(404).json({ error: '找不到这份作业' });
    if (xxtTaskBusy) return res.status(409).json({ error: '学习通正忙着另一个任务，稍等一下再点' });
    xxtTaskBusy = true;
    h.status = 'reading';
    store.save();
    res.json({ ok: true, status: 'reading' });
    try {
      const open = await openHwTask(h);
      if (open.error && !open.page) {
        h.status = 'read_failed';
        h.submitHint = open.error;
        xxtPushQQ(`📕 「${h.title}」读题失败：${open.error}`, 'homework');
        store.save();
        return;
      }
      const r = await readTask({ open });
      if (r.ok) {
        h.requirement = String(r.text).slice(0, 2000);
        h.needUpload = !!r.upload;
        // 读到题了 → 直接按完整要求重做草稿（用户要求：来了就做，别等催）
        xxtLog(`已读到「${h.title}」题干 ${h.requirement.length} 字，重生成草稿`);
        xxtMakeDraft(h, '').catch((e) => xxtLog('草稿重生成异常：' + (e && e.message)));
      } else {
        h.status = 'read_failed';
        h.submitHint = r.error || '读题失败';
        xxtPushQQ(`📕 「${h.title}」读题失败：${h.submitHint}`, 'homework');
        store.save();
      }
    } catch (e) {
      h.status = 'read_failed';
      h.submitHint = String((e && e.message) || e).slice(0, 140);
      store.save();
    } finally {
      xxtTaskBusy = false;
    }
  });

  app.post('/api/xxt/homework/submit', async (req, res) => {
    const h = findHw(String((req.body && req.body.id) || ''));
    if (!h) return res.status(404).json({ error: '找不到这份作业' });
    if (!h.draft) return res.status(409).json({ error: '还没有草稿，先让它做好一份' });
    if (h.needUpload) return res.status(409).json({ error: '这道题要求上传文件/图片，程序不代交——草稿复制出来自己传' });
    if (h.status === 'submitting' || h.status === 'submitted') return res.status(409).json({ error: '这份已经交过或在交了' });
    if (xxtTaskBusy) return res.status(409).json({ error: '学习通正忙着另一个任务，稍等一下再点' });
    xxtTaskBusy = true;
    h.status = 'submitting';
    store.save();
    res.json({ ok: true, status: 'submitting' });
    try {
      const open = await openHwTask(h);
      if (open.error && !open.page) {
        h.status = 'submit_failed';
        h.submitHint = open.error;
        xxtPushQQ(`📕 「${h.title}」提交失败：${open.error}`, 'homework');
        store.save();
        return;
      }
      const r = await submitTask({ open, text: h.draft });
      if (r.ok) {
        h.status = 'submitted';
        h.submittedAt = Date.now();
        h.proof = saveProof(h, r.proof);
        // 联动学习计划：提交成功就把 studyItems 里这份翻成已完成（旧版漏翻，工作台一直显示"还没做"）
        const si = h.studyItemId && store.db.data.studyItems.find((s2) => s2.id === h.studyItemId);
        if (si && !si.done) {
          si.done = true;
          si.doneAt = now();
          si.updatedAt = now();
        }
        xxtPushQQ(`✅ 「${h.title}」已提交进学习通（截图留证）`, 'homework');
      } else if (r.unverified) {
        // 点了提交但没拿到成功回执：不冒充交过，也不报失败——状态留在 drafted 可重来，让用户先去 APP 核对
        h.status = 'drafted';
        h.submitHint = r.error;
        h.proof = saveProof(h, r.proof);
        xxtPushQQ(`⚠️ 「${h.title}」提交回执没拿到：${r.error}`, 'homework');
      } else if (r.needManual) {
        h.status = 'drafted';
        h.submitHint = r.error;
        h.proof = saveProof(h, r.proof);
        xxtPushQQ(`✋ 「${h.title}」：${r.error}`, 'homework');
      } else {
        h.status = 'submit_failed';
        h.submitHint = r.error || '提交失败';
        h.proof = saveProof(h, r.proof);
        xxtPushQQ(`😖 「${h.title}」提交没成功：${h.submitHint}（有截图，去工作台看）`, 'homework');
      }
      store.save();
    } catch (e) {
      h.status = 'submit_failed';
      h.submitHint = String((e && e.message) || e).slice(0, 140);
      store.save();
    } finally {
      xxtTaskBusy = false;
    }
  });

  // ---------- 知识库（正式库对所有人只读；改动必须走 _待审区 + 阿珑批准） ----------
  const KB_ROOT = () => process.env.KB_ROOT || 'D:\\知识库';
  const kbCats = () => {
    try {
      return fs.readdirSync(KB_ROOT(), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
  };
  const kbSafe = (s) => String(s || '').replace(/[\\/:*?"<>|.]/g, '').slice(0, 40); // 防穿越：条目名只留安全字符
  const kbPendingDir = () => path.join(KB_ROOT(), '_待审区');
  function kbRegenIndex() {
    const cats = kbCats();
    const rows = [];
    for (const cat of cats) {
      for (const f of fs.readdirSync(path.join(KB_ROOT(), cat)).filter((x) => x.endsWith('.md'))) {
        let meta = {};
        try {
          const raw = fs.readFileSync(path.join(KB_ROOT(), cat, f), 'utf8');
          const m = raw.match(/^---\n([\s\S]*?)\n---/);
          if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        } catch { /* 坏文件跳过不拖垮索引 */ }
        rows.push(`| ${cat} | ${f.slice(0, -3)} | ${meta['标题'] || f} | ${meta['标签'] || ''} |`);
      }
    }
    const desc = {};
    for (const cat of cats) desc[cat] = cat.replace(/^\d{2}-/, '');
    const idx = [
      `# 知识库总索引（自动生成，共 ${rows.length} 条，${now().slice(0, 10)}）`,
      '',
      '> 自动维护，人工勿改；新条目经「待审区 → 阿珑批准」入库后重建。',
      '',
      '## 分类一览',
      '',
      ...Object.entries(desc).map(([c, d]) => `- **${c}** —— ${d}`),
      '',
      '## 逐条索引',
      '',
      '| 分类 | 条目 id | 标题 | 标签 |',
      '|---|---|---|---|',
      ...rows,
      '',
      '## 怎么查',
      '- 按分类进文件夹读 .md；按关键词用 MCP kb_search 或 grep。',
      '- 接入型 AI 必读顺序：README.md → 本索引 → 02-习惯与规矩/iron（铁律）。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(KB_ROOT(), 'INDEX.md'), idx, 'utf8');
    return rows.length;
  }
  app.get('/api/kb/pending', (req, res) => {
    try {
      const files = fs.readdirSync(kbPendingDir()).filter((f) => f.endsWith('.json'));
      const list = files.map((f) => {
        try {
          return { file: f, ...JSON.parse(fs.readFileSync(path.join(kbPendingDir(), f), 'utf8')) };
        } catch {
          return { file: f, title: '（坏申请文件，可直接驳回）', category: '', id: '' };
        }
      });
      res.json({ items: list, cats: kbCats() });
    } catch {
      res.json({ items: [], cats: [] });
    }
  });
  app.post('/api/kb/approve', (req, res) => {
    const b = req.body;
    const file = String((b && b.file) || '');
    try {
      const p = path.join(kbPendingDir(), path.basename(file)); // basename 掐死路径穿越
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      const cats = kbCats();
      if (!cats.includes(rec.category)) return res.status(400).json({ error: '分类不存在：' + rec.category });
      const cat = rec.category;
      const id = kbSafe(rec.id) || 'kb';
      const body = [
        '---',
        `id: ${cat}/${id}`,
        `分类: ${cat}`,
        `标题: ${String(rec.title).slice(0, 60)}`,
        `标签: ${(Array.isArray(rec.tags) ? rec.tags : []).join('、') || '待补'}`,
        `更新: ${now().slice(0, 10)}`,
        '权限: 只读——修改必须经阿珑同意（走待审区通道）',
        '---',
        '',
        String(rec.body || '').slice(0, 6000),
        '',
      ].join('\n');
      fs.mkdirSync(path.join(KB_ROOT(), cat), { recursive: true });
      fs.writeFileSync(path.join(KB_ROOT(), cat, `${id}.md`), body, 'utf8');
      fs.unlinkSync(p);
      const total = kbRegenIndex();
      xxtPushQQ(`📚 已入库《${rec.title}》，知识库现在 ${total} 条`, 'kb');
      store.save();
      res.json({ ok: true, total });
    } catch (e) {
      res.status(400).json({ error: '批准失败：' + String((e && e.message) || e).slice(0, 120) });
    }
  });
  app.post('/api/kb/reject', (req, res) => {
    const file = String(((req.body && req.body.file) || ''));
    try {
      const src = path.join(kbPendingDir(), path.basename(file));
      const rejectDir = path.join(kbPendingDir(), '已驳回');
      fs.mkdirSync(rejectDir, { recursive: true });
      fs.renameSync(src, path.join(rejectDir, `${Date.now()}-${path.basename(file)}`));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: String((e && e.message) || e).slice(0, 120) });
    }
  });
  // MCP 服务器递交申请后来这里喊一嗓子（不阻塞它，纯通知）
  app.post('/api/kb/notify', (req, res) => {
    const t = String(((req.body && req.body.title) || '新知识').slice(0, 60));
    xxtPushQQ(`📚 知识库收到申请《${t}》，去设置页批一下`, 'kb');
    store.save();
    res.json({ ok: true });
  });
  // 用户亲口的"记进知识库：xxx"和聊天页"📚 进知识库"按钮走这里——
  // 这不算"模型改库"，这是阿珑本人下的指令（他的同意已经发生），直接入库，不用再审。
  app.post('/api/kb/add', (req, res) => {
    const b = req.body;
    const text = String((b && b.text) || '').trim().slice(0, 2000);
    if (text.length < 4) return res.status(400).json({ error: '内容太短，写清楚点（至少几个字）' });
    const cats = kbCats();
    if (!cats.length) return res.status(500).json({ error: '知识库不存在（D:\\知识库 没建好？）' });
    const guess = (s) => {
      if (/^(?:0\d-[\u4e00-\u9fffA-Za-z0-9-]+)$/.test(String(b.category || '')) && cats.includes(String(b.category))) return String(b.category);
      if (/喜欢|习惯|不喜欢|爱吃|称呼|我是|我叫/.test(s)) return cats.find((c) => c.startsWith('01')) || cats[0];
      if (/规则|注释|必须|禁止|规矩|流程/.test(s)) return cats.find((c) => c.startsWith('02')) || cats[0];
      if (/学习通|课程|作业|考试|课表|老师/.test(s)) return cats.find((c) => c.startsWith('09')) || cats[0];
      if (/服务器|隧道|外网|QQ|端口|IP|密码/.test(s)) return cats.find((c) => c.startsWith('05')) || cats[0];
      if (/模型|显卡|显存|llama|gguf/i.test(s)) return cats.find((c) => c.startsWith('06')) || cats[0];
      return cats.find((c) => c.startsWith('03')) || cats[0];
    };
    const cat = guess(text);
    const id = 'kb-' + Date.now().toString(36);
    const title = (b.title ? String(b.title) : text.split('\n')[0]).slice(0, 40);
    const md = [
      '---',
      `id: ${cat}/${id}`,
      `分类: ${cat}`,
      `标题: ${title}`,
      `标签: ${(Array.isArray(b.tags) ? b.tags : ['手动记录']).join('、').slice(0, 80)}`,
      `更新: ${now().slice(0, 10)}`,
      '权限: 只读——修改必须经阿珑同意（走待审区通道）',
      '---',
      '',
      text,
      '',
    ].join('\n');
    try {
      fs.writeFileSync(path.join(KB_ROOT(), cat, `${id}.md`), md, 'utf8');
      const total = kbRegenIndex();
      res.json({ ok: true, category: cat, id, total });
    } catch (e) {
      res.status(500).json({ error: '写入失败：' + String((e && e.message) || e).slice(0, 120) });
    }
  });
  // 后台整理器：把记忆树里"被反复强化/置顶"的高价值记忆自动转成知识库申请（仍要阿珑批准）
  function kbHarvest() {
    try {
      const s = store.db.settings;
      const mem = store.db.data.memories || [];
      const seen = s.kbSeen || [];
      const catMap = { about: '01-用户画像', rules: '02-习惯与规矩', work: '03-项目史', preference: '01-用户画像', life: '09-学习生活', idea: '03-项目史' };
      // 防复发（阿珑大扫除教训）：先捞一遍知识库全文，内容已在库里的记忆不再提名——
      // 否则批准入库的"新条目"和老条目重复，等于把重复从记忆树搬进知识库
      let kbHay = '';
      try {
        for (const cat of kbCats()) {
          for (const f of fs.readdirSync(path.join(KB_ROOT(), cat)).filter((x) => x.endsWith('.md'))) {
            try {
              kbHay += fs.readFileSync(path.join(KB_ROOT(), cat, f), 'utf8');
            } catch {
              /* 单文件读不动继续 */
            }
          }
        }
        kbHay = kbHay.replace(/\s+/g, '');
      } catch {
        /* 没库当空 */
      }
      let fresh = 0;
      for (const m of mem) {
        if (!(m.pinned || (Number(m.weight) || 1) >= 2)) continue;
        if (seen.includes(m.id)) continue;
        const text = String(m.text || '').trim();
        if (text.length < 6) continue;
        const key = text.replace(/\s+/g, '').slice(0, 24);
        if (key && kbHay.includes(key)) {
          seen.push(m.id); // 库里已有等价内容：记账跳过，不进待审区添乱
          continue;
        }
        seen.push(m.id);
        const cat = catMap[m.branch] || '03-项目史';
        const id = 'mem-' + String(m.id).slice(0, 8);
        fs.mkdirSync(kbPendingDir(), { recursive: true });
        const rec = {
          at: now(),
          from: 'workbench',
          category: cat,
          id,
          title: text.slice(0, 40),
          tags: [m.branch || '记忆'],
          body: `## 一句话\n${text.slice(0, 500)}\n\n## 来源\n记忆树（${m.pinned ? '置顶' : `强度 ${m.weight || 1}`}），由后台整理器提名`,
          reason: '记忆树里被强化过，值得升格为长期知识',
        };
        fs.writeFileSync(path.join(kbPendingDir(), `${String(rec.at).replace(/[:.]/g, '-')}-${id}.json`), JSON.stringify(rec, null, 2), 'utf8');
        fresh++;
      }
      s.kbSeen = seen.slice(-400);
      store.save();
      if (fresh) xxtPushQQ(`🧹 我整理了 ${fresh} 条记忆进知识库待审区，得空批一下`, 'kb');
    } catch {
      /* 整理失败不打扰，下轮再来 */
    }
  }
  if (process.env.NO_AUTOSTART !== '1') {
    const kbBootTimer = setTimeout(kbHarvest, 60 * 1000); // 开机一分钟后先清一轮存量
    const kbTimer = setInterval(kbHarvest, 6 * 3600 * 1000); // 之后每 6 小时后台整理
    if (kbBootTimer.unref) kbBootTimer.unref();
    if (kbTimer.unref) kbTimer.unref();
  }

  // QQ 桥的主动推送队列（轮询取走、送达销号）
  app.get('/api/qq/pending', (req, res) => {
    res.json({ queue: (store.db.settings.qqPushQueue || []).slice(-10) });
  });

  app.post('/api/qq/notified', (req, res) => {
    const b = req.body;
    const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
    store.db.settings.qqPushQueue = (store.db.settings.qqPushQueue || []).filter((q) => !ids.includes(q.id));
    store.save();
    res.json({ ok: true });
  });

  // 自轮询：每 5 分钟一轮；启动后 10 秒先来一轮（接住关机期间到的通知）。测试环境不自动跑。
  if (process.env.NO_AUTOSTART !== '1') {
    const xxtTimer = setInterval(() => {
      if (!store.db.settings.mailWatch.enabled) return;
      xxtPollNow().catch(() => {});
    }, 5 * 60 * 1000);
    if (xxtTimer.unref) xxtTimer.unref();
    const xxtBoot = setTimeout(() => {
      if (store.db.settings.mailWatch.enabled) xxtPollNow().catch(() => {});
    }, 10000);
    if (xxtBoot.unref) xxtBoot.unref();
  }

  app.post('/api/persona/reflect', async (req, res) => {
    const p = store.db.settings.persona;
    if (!(store.db.data.chatMessages || []).length) {
      return res.status(409).json({ error: '还没有对话可以反思，先聊几句吧' });
    }
    const recent = (store.db.data.chatMessages || [])
      .slice(-12)
      .map((m) => `${m.role === 'user' ? p.addressAs : p.name}：${String(m.content || '').slice(0, 200)}`)
      .join('\n');
    const answer = await quickModelText(store, [{ role: 'user', content: reflectPrompt(p, recent) }], 200);
    if (!answer) return res.status(502).json({ error: '模型没响应（看看模型是不是在运行）' });
    const lines = answer
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l && l !== '无' && l !== '没有' && !/^#/.test(l))
      .slice(0, 2);
    p.traits = mergeTraits(p.traits, lines, 'reflect', now());
    p.chatsSinceReflect = 0;
    p.lastReflectAt = Date.now();
    store.save();
    res.json({ traits: p.traits });
  });

  /* ---- 记忆树 2.0：静默自动记忆（疑似冲突才问）+ D 盘文件化 ---- */

  const MEMORY_DIR = () => process.env.MEMORY_DIR || 'D:\\AI助手记忆';
  const MEMORY_BRANCH_DIRS = {
    about: '🌸 关于我',
    work: '💼 工作',
    life: '🍚 生活',
    preference: '💕 偏好',
    idea: '💡 灵感',
    rules: '⚠️ 永久注释',
  };
  const MEMORY_BRANCH_KEYS = Object.keys(MEMORY_BRANCH_DIRS);

  function memQuotaLeft() {
    const q = store.db.settings.memoryQuota || { hour: 0, count: 0 };
    const h = Math.floor(Date.now() / 3600000);
    return q.hour === h ? Math.max(0, 3 - q.count) : 3;
  }

  /** 质量过滤：碎片/空壳/半截话不记 */
  function memoryQualityOk(text) {
    const t = String(text || '').trim();
    if (t.length < 4 || t.length > 80) return false;
    if (/[：:，,。…]$/.test(t)) return false;
    if (/^(值得记住|记住了)[：:]/.test(t)) return false;
    // 模型把提示词/JSON 回吐出来的情况，一律不记
    if (/^\[\{/.test(t) || /role.*system|记忆整理助手|已有记忆/i.test(t)) return false;
    return true;
  }

  /** 归一化指纹（去标点空格），用于全量去重 */
  function memoryFingerprint(text) {
    return String(text || '').replace(/[\s，。！？!?、：:；;'"“”‘’（）()【】\[\]·,.…~～]/g, '');
  }

  function memoryFilePath(m) {
    const dir = MEMORY_BRANCH_DIRS[m.branch] || MEMORY_BRANCH_DIRS.about;
    const title =
      String(m.text || '记忆')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24) || '记忆';
    const date = String(m.createdAt || now()).slice(0, 10);
    const name = `${date}-${title}-${String(m.id).slice(0, 8)}.md`;
    return { abs: path.join(MEMORY_DIR(), dir, name), rel: path.join(dir, name) };
  }

  function writeMemoryFile(m) {
    const { abs, rel } = memoryFilePath(m);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        `# ${m.text}`,
        `分支：${MEMORY_BRANCH_DIRS[m.branch] || MEMORY_BRANCH_DIRS.about}`,
        `创建：${m.createdAt}`,
        `更新：${m.updatedAt}`,
        '',
        m.text,
      ].join('\n'),
      'utf8',
    );
    return rel;
  }

  function deleteMemoryFile(m) {
    try {
      if (m && m.file) fs.rmSync(path.join(MEMORY_DIR(), m.file), { force: true });
    } catch {
      // 已不存在
    }
  }

  function parseMemoryFile(abs) {
    try {
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      let text = '';
      let createdAt = null;
      for (const l of lines) {
        const t = l.trim();
        if (t.startsWith('# ')) text = t.slice(2).trim();
        else if (t.startsWith('创建：')) createdAt = t.replace('创建：', '').trim();
        else if (t && !t.startsWith('分支：') && !t.startsWith('更新：') && !t.startsWith('---') && !text) text = t;
      }
      return { text: String(text).trim(), createdAt };
    } catch {
      return null;
    }
  }

  /** 双向同步：外部增删改 D 盘文件 ↔ 应用内记忆树（启动与读取时各跑一次） */
  function syncMemoryFiles() {
    try {
      const root = MEMORY_DIR();
      fs.mkdirSync(root, { recursive: true });
      const memories = store.db.data.memories;
      let changed = false;
      // ① 文件被外部删掉 → 记忆跟着删
      for (const m of [...memories]) {
        if (!m.file) continue;
        if (!fs.existsSync(path.join(root, m.file))) {
          const i = memories.indexOf(m);
          if (i >= 0) {
            memories.splice(i, 1);
            changed = true;
          }
        }
      }
      // ② 文件内容被外部改 → 更新记忆文本
      for (const m of memories) {
        if (!m.file) continue;
        const abs = path.join(root, m.file);
        if (!fs.existsSync(abs)) continue;
        const parsed = parseMemoryFile(abs);
        if (parsed && parsed.text && parsed.text !== m.text) {
          m.text = parsed.text;
          m.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      // ③ 文件夹里有、应用里没有 → 导入
      const known = new Set(memories.map((m) => (m.file ? path.normalize(m.file) : '')));
      for (const [key, dir] of Object.entries(MEMORY_BRANCH_DIRS)) {
        const absDir = path.join(root, dir);
        if (!fs.existsSync(absDir)) continue;
        for (const f of fs.readdirSync(absDir)) {
          if (!f.endsWith('.md')) continue;
          const rel = path.normalize(path.join(dir, f));
          if (known.has(rel)) continue;
          const parsed = parseMemoryFile(path.join(absDir, f));
          if (!parsed || !memoryQualityOk(parsed.text)) continue;
          memories.push({
            id: crypto.randomUUID(),
            seq: store.nextSeq(),
            createdAt: parsed.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            branch: key,
            text: parsed.text,
            pinned: false,
            source: 'file',
            weight: 1,
            file: rel,
          });
          changed = true;
        }
      }
      if (changed) store.save();
    } catch {
      // 同步失败不拦业务
    }
  }

  /** 聊天/屏幕内容里自动发现值得记住的话（静默自动记忆；疑似冲突才进待确认） */
  async function maybeDiscoverMemory(store, textSource) {
    const s = store.db.settings;
    if (s.autoMemory === false) return;
    if (s.persona && s.persona.freedom === 'quiet') return;
    try {
      const memories = store.db.data.memories || [];
      // ① 自动加强：最近用户消息与旧记忆印证 → 强度+1（确定性，无需模型）
      const recentUser = (store.db.data.chatMessages || [])
        .slice(-6)
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join(' ');
      if (recentUser) {
        for (const m of memories) {
          if (similarity(recentUser, m.text) >= 0.55) {
            m.weight = Math.min(5, (Number(m.weight) || 1) + 1);
            m.updatedAt = now();
          }
        }
      }
      // ② 模型发现：只找稳定事实/偏好/决定；疑似与旧记忆矛盾的行以「冲突：」开头
      const recent = (store.db.data.chatMessages || [])
        .slice(-4)
        .map(
          (m) =>
            `${m.role === 'user' ? s.persona?.addressAs || '用户' : s.persona?.name || '助手'}：${String(m.content || '').slice(0, 160)}`,
        )
        .join('\n');
      const src = (textSource ? `屏幕内容：${String(textSource).slice(0, 800)}\n` : '') + (recent || '');
      if (!src.trim()) return;
      const existing = memories.map((m) => `· ${m.text}`).join('\n');
      const answer = await quickModelText(store, [
        { role: 'system', content: '你是记忆整理助手。请直接输出结果，不要思考过程。' },
        {
          role: 'user',
          content: `已有记忆：\n${existing || '（空）'}\n\n从下面的内容里找出"关于用户的稳定事实/偏好/决定"，最多 2 条，每条一行，直接写内容本身（不要编号、不要解释）；没有就只输出「无」。绝不重复已有记忆里的信息；如果一条新信息和已有某条意思相反（例如以前说"不爱吃辣"现在说"爱吃辣"），这一行要以「冲突：」开头输出。\n---\n${src}`,
        },
      ], 600, 60000);
      if (!answer) return;
      const lines = answer
        .split(/\n+/)
        .map((l) => l.replace(/^[-\d.、\s]+/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
      let savedCount = 0;
      for (const raw of lines) {
        if (raw === '无' || raw === '没有' || /^#/.test(raw)) continue;
        const isConflict = raw.startsWith('冲突：');
        const text = raw.replace(/^冲突：/, '').trim().slice(0, 80);
        if (!memoryQualityOk(text)) continue;
        // 模型明确标了「冲突：」→ 唯一会打扰用户的情况：进待确认（优先级最高）
        if (isConflict) {
          const pending = s.memoryPending || [];
          if (!pending.some((p) => p.text === text)) {
            pending.push({ text, branch: guessMemoryBranch(text), at: Date.now(), conflictWith: '' });
          }
          s.memoryPending = pending.slice(-4);
          continue;
        }
        // ① 指纹去重：和全部历史记忆比对
        const fp = memoryFingerprint(text);
        if ((s.memorySeen || []).includes(text)) continue;
        if (memories.some((m) => memoryFingerprint(m.text) === fp)) continue;
        // ② 语义去重（与 boostMemoryIfMatched 同参数）：几乎同句才加强；
        // 相似但未达重复线的，进待确认由阿珑定夺——不许静默丢信息
        const same = memories.find(
          (m) => similarity(m.text, text) >= 0.85 || m.text === text,
        );
        if (same) {
          same.weight = Math.min(5, (Number(same.weight) || 1) + 1);
          same.updatedAt = now();
          continue;
        }
        // 相似但措辞不同 → 疑似矛盾/新信息，进待确认
        const softDup = memories.find((m) => {
          const sim = similarity(m.text, text);
          return sim >= 0.55 && sim < 0.85;
        });
        if (softDup && s.memoryMode !== 'ask') {
          const pending = s.memoryPending || [];
          if (!pending.some((p) => p.text === text)) {
            pending.push({ text, branch: guessMemoryBranch(text), at: Date.now(), conflictWith: softDup.text });
          }
          s.memoryPending = pending.slice(-4);
          continue;
        }
        if (s.memoryMode === 'ask') {
          const pending = s.memoryPending || [];
          if (!pending.some((p) => p.text === text)) {
            pending.push({ text, branch: guessMemoryBranch(text), at: Date.now() });
          }
          s.memoryPending = pending.slice(-4);
          continue;
        }
        // 静默自动保存：写 D 盘文件 + 索引
        if (memQuotaLeft() <= 0) break;
        const m = {
          id: crypto.randomUUID(),
          seq: store.nextSeq(),
          createdAt: now(),
          updatedAt: now(),
          branch: guessMemoryBranch(text),
          text,
          pinned: false,
          source: 'discover',
          weight: 1,
          file: '',
        };
        m.file = writeMemoryFile(m);
        memories.push(m);
        savedCount += 1;
        s.memorySeen = [...(s.memorySeen || []), text].slice(-200);
        const h = Math.floor(Date.now() / 3600000);
        const q = s.memoryQuota || { hour: 0, count: 0 };
        s.memoryQuota = q.hour === h ? { hour: h, count: q.count + 1 } : { hour: h, count: 1 };
      }
      if (savedCount) store.save();
    } catch {
      // 发现失败静默，不影响聊天
    }
  }

  app.get('/api/memory/pending', (req, res) => {
    res.json({
      pending: store.db.settings.memoryPending || [],
      quotaLeft: memQuotaLeft(),
      mode: store.db.settings.memoryMode || 'auto',
    });
  });

  app.post('/api/memory/discover', async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    if (typeof b.text === 'string' && b.text.trim()) {
      await maybeDiscoverMemory(store, b.text);
      store.save();
    }
    res.json({ pending: store.db.settings.memoryPending || [], quotaLeft: memQuotaLeft() });
  });

  app.post('/api/memory/save', (req, res) => {
    const b = req.body;
    const s = store.db.settings;
    const text = String((b && b.text) || '').trim().slice(0, 80);
    if (!text) return res.status(400).json({ error: '内容不能为空' });
    const memories = store.db.data.memories;
    // 和旧记忆撞了 → 加强而不是新增
    const boosted = boostMemoryIfMatched(memories, text);
    let saved = null;
    if (!boosted) {
      const branch = MEMORY_BRANCH_KEYS.includes(b && b.branch) ? b.branch : guessMemoryBranch(text);
      saved = {
        id: crypto.randomUUID(),
        seq: store.nextSeq(),
        createdAt: now(),
        updatedAt: now(),
        branch,
        text,
        pinned: false,
        source: (b && b.source) || 'discover',
        weight: 1,
        file: '',
      };
      saved.file = writeMemoryFile(saved); // 落 D 盘文件
      memories.push(saved);
    }
    s.memoryPending = (s.memoryPending || []).filter((p) => p.text !== text);
    store.save();
    res.json({ boosted, saved });
  });

  app.post('/api/memory/ignore', (req, res) => {
    const b = req.body;
    const s = store.db.settings;
    const text = String((b && b.text) || '').trim();
    if (text) s.memorySeen = [...(s.memorySeen || []), text].slice(-200);
    s.memoryPending = (s.memoryPending || []).filter((p) => p.text !== text);
    store.save();
    res.json({ ok: true });
  });

  // 最近自动记住的（前端静默提示 + 撤销用）
  app.get('/api/memory/recent', (req, res) => {
    const since = Date.now() - 10 * 60 * 1000;
    const list = (store.db.data.memories || [])
      .filter((m) => m.source !== 'file' && new Date(m.createdAt).getTime() > since)
      .slice(-3);
    res.json({ recent: list });
  });

  // 撤销一条自动记忆（删索引 + 删 D 盘文件）
  app.post('/api/memory/undo', (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const memories = store.db.data.memories;
    const i = memories.findIndex((m) => m.id === id);
    if (i === -1) return res.status(404).json({ error: '找不到这条记忆' });
    const [removed] = memories.splice(i, 1);
    deleteMemoryFile(removed);
    store.save();
    res.json({ ok: true });
  });

  app.get('/api/meta', (req, res) => {
    const exists = fs.existsSync(store.file);
    const stat = exists ? fs.statSync(store.file) : null;
    const backupCount = fs.existsSync(store.backupDir) ? fs.readdirSync(store.backupDir).length : 0;
    res.json({
      dataDir: store.dataDir,
      dbFile: store.file,
      size: stat ? stat.size : 0,
      updatedAt: stat ? stat.mtime.toISOString() : null,
      backupCount,
    });
  });

  app.get('/api/export', (req, res) => {
    res.json({
      app: 'AI 助手',
      version: 1,
      exportedAt: now(),
      settings: store.db.settings,
      data: store.db.data,
    });
  });

  app.post('/api/import', (req, res) => {
    const body = req.body;
    if (!isObject(body) || !isObject(body.data)) {
      return res.status(400).json({ error: '这不是一个有效的备份文件' });
    }
    store.backupNow('import');
    store.replaceAll(body);
    res.json({ ok: true, counts: store.counts() });
  });

  app.post('/api/wipe', (req, res) => {
    const body = req.body;
    if (!isObject(body) || body.confirm !== '清空') {
      return res.status(400).json({ error: '需要输入“清空”两个字确认' });
    }
    store.backupNow('wipe');
    store.reset();
    // 记忆树文件一起清空（数据与 D 盘文件夹保持一致）
    try {
      for (const dir of Object.values(MEMORY_BRANCH_DIRS)) {
        fs.rmSync(path.join(MEMORY_DIR(), dir), { recursive: true, force: true });
      }
    } catch {
      // 清不掉不影响清空主数据
    }
    res.json({ ok: true });
  });

  /* ---- 本地 AI 模型（llama-server 等 OpenAI 兼容接口，只连本机） ---- */

  app.get('/api/model/status', async (req, res) => {
    const m = resolveActiveModel(store.db.settings);
    const base = (m.baseUrl || '').replace(/\/+$/, '');
    const online = base ? await probeModel(m) : false;
    res.json({ online, baseUrl: base, model: m.model, name: m.name, id: m.id, type: m.type });
  });

  /* 测试一个模型服务能不能连上（云端/本机都行）：顺带把可用的模型名拉回来 */
  app.post('/api/models/test', async (req, res) => {
    const b = req.body;
    if (!isObject(b) || typeof b.baseUrl !== 'string' || !/^https?:\/\/.+/i.test(b.baseUrl.trim())) {
      return res.status(400).json({ error: '服务地址不合法（要 http/https 开头）' });
    }
    const baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const hint =
          r.status === 401
            ? '密钥不对，或这个密钥没有权限'
            : r.status === 402
              ? '账户余额不足，需要先充值'
              : r.status === 403
                ? '对方拒绝访问（403），检查密钥或账号状态'
                : r.status === 404
                  ? '地址不对（没有 /models 接口），检查服务地址'
                  : `对方返回 HTTP ${r.status}`;
        return res.json({ ok: false, status: r.status, error: hint });
      }
      const data = await r.json().catch(() => null);
      const models = ((data && data.data) || [])
        .map((x) => (x && typeof x.id === 'string' ? x.id : ''))
        .filter(Boolean)
        .slice(0, 50);
      res.json({ ok: true, models });
    } catch (e) {
      res.json({
        ok: false,
        status: 0,
        error: e && e.name === 'AbortError' ? '连接超时：地址不对或网络不通' : `连不上：${e && e.message}`,
      });
    }
  });

  app.get('/api/models/status', async (req, res) => {    // 10 秒缓存，助手页轮询不折腾
    if (modelsStatusCache.data && Date.now() - modelsStatusCache.at < 10000) {
      return res.json(modelsStatusCache.data);
    }
    const s = store.db.settings;
    const list = Array.isArray(s.models) ? s.models : [];
    const chatPorts = ['chat', 'qwen', 'coder'].map((k) => MODEL_DEFS[k] && MODEL_DEFS[k].port).filter(Boolean);
    const data = await Promise.all(
      list.map(async (m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        kind: m.kind || '',
        baseUrl: m.baseUrl,
        model: m.model,
        note: m.note || '',
        active: m.id === s.activeModelId,
        online: await probeModel(m),
        // 聊天模型共用一个显卡位：一起勾选时前端提示"不能同时运行，会自动切换"
        slot: chatPorts.some((p) => String(m.baseUrl || '').includes(`:${p}/`)) ? 'chat' : 'other',
      })),
    );
    modelsStatusCache = { at: Date.now(), data };
    res.json(data);
  });

  app.post('/api/chat', async (req, res) => {
    const body = req.body;
    if (!isObject(body) || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: '请求格式不对' });
    }
    const lastUser = [...body.messages].reverse().find((m) => m && m.role === 'user');
    const route = await autoSwitchRoute(await resolveBestModel(store, lastUser ? lastUser.content : ''));
    const outMessages = body.messages
      .slice(-20)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m && Array.isArray(m.attachments) && m.attachments.length ? { attachments: m.attachments } : {}),
      }));
    // 图片理解：让本机视觉模型把用户发的图翻成文字注入 content——云端/本地纯文本模型也能"看见"图
    try {
      await annotateWithVision(outMessages);
    } catch {
      /* annotate 内部已兜底注记，这里再保一层不阻塞聊天 */
    }
    for (const o of outMessages) delete o.attachments;
    // 记忆树：开启时把记忆作为系统提示带给模型（钉住的优先，总量约 1200 字以内）
    if (store.db.settings.memoryEnabled !== false) {
      const sys = buildMemorySystem(store.db.data.memories || []);
      if (sys) outMessages.unshift({ role: 'system', content: sys });
    }
    // 学习通通道：让工作台聊天里的 AI 看得见课程/作业/考试近况（没连接则不注入）
    const xxtSysWeb = buildXxtContext(store.db.settings);
    if (xxtSysWeb) outMessages.unshift({ role: 'system', content: xxtSysWeb });
    // 她（柳月虹）的人设：最先注入
    outMessages.unshift({ role: 'system', content: buildPersonaSystem(store.db.settings.persona) });
    noteChatActivity(store);
    store.save();
    maybeDiscoverMemory(store).catch(() => {});
    const ctrl = new AbortController();
    let closed = false;
    res.on('close', () => {
      closed = true;
      ctrl.abort();
    });
    // 自动调度：按优先级逐个尝试候选模型，选中的挂了就换下一个（真正的自动回退）
    let lastErr = null;
    let hasBase = false;
    for (const cand of route.candidates) {
      if (closed) return;
      const base = (cand.baseUrl || '').replace(/\/+$/, '');
      if (!base) continue;
      hasBase = true;
      try {
        const upstream = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...modelHeaders(cand) },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: cand.model || 'local-model',
            messages: mergeSystemMessages(outMessages),
            stream: true,
            temperature: 0.6,
            max_tokens: 2048,
          }),
        });
        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => '');
          const hint =
            upstream.status === 402 ? '（这个模型的余额不足）' : upstream.status === 401 ? '（密钥不对或没权限）' : '';
          // 认证/权限问题：不换模型兜底，直接如实报错
          if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
            return res.status(502).json({ error: `模型服务返回异常（${upstream.status}）${hint}${text.slice(0, 120)}` });
          }
          lastErr = `模型服务返回异常（${upstream.status}）${hint}${text.slice(0, 120)}`;
          continue;
        }
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // 先发一条"元信息"：这次由哪个模型回答（自动调度时前端展示用）
        res.write(`data: {"meta":{"model":"${cand.model}","name":"${cand.name}","auto":${route.auto ? 'true' : 'false'},"wanted":"${route.wanted || ''}","switched":"${route.switched || ''}","switchedLabel":"${(route.switchedLabel || '').replace(/"/g, '')}"}}\n\n`);
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
        return;
      } catch (e) {
        if (closed || res.headersSent) return;
        lastErr = `连不上模型：${e && e.message}`;
      }
    }
    if (!hasBase) return res.status(400).json({ error: '还没有配置本地模型服务' });
    const hint = '请先双击 D 盘 DeepSeek-R1-7B 里的「启动模型.bat」';
    res.status(502).json({ error: `${lastErr ? `${lastErr}；` : ''}${hint}` });
  });

  app.post('/api/reveal-data-folder', (req, res) => {
    const dir = store.dataDir;
    const cmd =
      process.platform === 'win32'
        ? `explorer "${dir}"`
        : process.platform === 'darwin'
          ? `open "${dir}"`
          : `xdg-open "${dir}"`;
    exec(cmd, () => {});
    res.json({ ok: true });
  });

  app.get('/api/:collection', (req, res) => {
    const c = req.params.collection;
    if (!isCollection(c)) return res.status(404).json({ error: '未知的数据集合' });
    if (c === 'memories') syncMemoryFiles(); // 读取前先和 D 盘文件夹对账
    res.json(store.db.data[c]);
  });

  app.post('/api/:collection', (req, res, next) => {
    const c = req.params.collection;
    if (c === 'recordings' || c === 'files' || c === 'chat-once' || c === 'assistant-action' || c === 'imagine') return next();
    if (!isCollection(c)) return res.status(404).json({ error: '未知的数据集合' });
    if (!isObject(req.body)) return res.status(400).json({ error: '请求内容必须是对象' });
    const item = { ...req.body };
    delete item.id;
    delete item.createdAt;
    delete item.updatedAt;
    delete item.seq;
    const created = {
      id: crypto.randomUUID(),
      seq: store.nextSeq(),
      createdAt: now(),
      updatedAt: now(),
      ...item,
    };
    store.db.data[c].push(created);
    store.save();
    res.json(created);
  });

  app.patch('/api/:collection/:id', (req, res) => {
    const { collection: c, id } = req.params;
    if (!isCollection(c)) return res.status(404).json({ error: '未知的数据集合' });
    if (!isObject(req.body)) return res.status(400).json({ error: '请求内容必须是对象' });
    const list = store.db.data[c];
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return res.status(404).json({ error: '找不到这条记录' });
    const patch = { ...req.body };
    delete patch.id;
    delete patch.createdAt;
    list[idx] = { ...list[idx], ...patch, updatedAt: now() };
    store.save();
    res.json(list[idx]);
  });

  app.delete('/api/:collection/:id', (req, res) => {
    const { collection: c, id } = req.params;
    if (!isCollection(c)) return res.status(404).json({ error: '未知的数据集合' });
    const list = store.db.data[c];
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return res.status(404).json({ error: '找不到这条记录' });
    const [removed] = list.splice(idx, 1);
    // 记忆：顺手把 D 盘上的记忆文件也删掉
    if (c === 'memories' && removed && removed.file) {
      deleteMemoryFile(removed);
    }
    // 录音笔记 / 素材文件：顺手把磁盘上的文件也删掉（路径必须落在数据目录里）
    if ((c === 'lessonNotes' || c === 'files') && removed && (removed.audioFile || removed.file)) {
      const abs = safeDataPath(store.dataDir, removed.audioFile || removed.file);
      if (abs) {
        for (const f of [abs, `${abs.replace(/\.[^.]+$/, '')}.txt`]) {
          try {
            fs.unlinkSync(f);
          } catch {
            // 文件不在了就算了
          }
        }
      }
    }
    store.save();
    res.json({ ok: true });
  });

  /* ---- 课堂/会议录音：上传 / 转写 / 总结 ---- */

  app.post('/api/recordings', express.raw({ type: () => true, limit: '400mb' }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: '没有收到录音内容' });
    const dir = path.join(store.dataDir, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    const ext = AUDIO_EXTS[String(req.headers['content-type'] || '').split(';')[0].trim()] || 'webm';
    const rel = path.join('recordings', `${id}.${ext}`);
    fs.writeFileSync(path.join(store.dataDir, rel), buf);
    const day = todayLocal();
    const note = {
      id,
      seq: store.nextSeq(),
      createdAt: now(),
      updatedAt: now(),
      title: String(req.query.title || '').trim() || `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} 的录音`,
      course: String(req.query.course || '').trim(),
      date: day,
      duration: Number(req.query.duration) || 0,
      audioFile: rel,
      status: 'recorded',
      transcript: '',
      summary: '',
      error: '',
    };
    store.db.data.lessonNotes.push(note);
    store.save();
    res.json(note);
  });

  app.get('/api/whisper/status', (req, res) => {
    const { bin, model } = whisperPaths();
    res.json({
      available: Boolean(bin && model),
      engine: bin ? (bin.toLowerCase().includes('cuda') ? 'cuda' : 'cpu') : null,
      model: model ? path.basename(model) : null,
    });
  });

  app.post('/api/recordings/:id/transcribe', (req, res) => {
    const note = store.db.data.lessonNotes.find((n) => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: '这条录音不存在' });
    const { bin, model } = whisperPaths();
    if (!bin || !model) {
      return res.status(409).json({ error: '语音识别组件还没装好（正在下载中或还没装），装好后重试' });
    }
    if (note.status === 'transcribing') return res.json({ ok: true, status: 'transcribing' });
    note.status = 'transcribing';
    note.error = '';
    note.updatedAt = now();
    store.save();
    res.json({ ok: true, status: 'transcribing' });
    startTranscribe(store, note);
  });

  app.post('/api/recordings/:id/summarize', (req, res) => {
    const note = store.db.data.lessonNotes.find((n) => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: '这条录音不存在' });
    if (!note.transcript || !note.transcript.trim()) {
      return res.status(409).json({ error: '还没有转写文字，先转写再总结' });
    }
    if (note.status === 'summarizing') return res.json({ ok: true, status: 'summarizing' });
    note.status = 'summarizing';
    note.error = '';
    note.updatedAt = now();
    store.save();
    res.json({ ok: true, status: 'summarizing' });
    runSummarize(store, note);
  });

  /* ---- 素材柜：上传图片/视频/任意文件（存在本机，跟对话一起用） ---- */

  function kindOf(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('text/') || /json|markdown|csv|xml|javascript|plain/.test(m)) return 'text';
    return 'other';
  }

  app.post('/api/files', express.raw({ type: () => true, limit: '400mb' }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: '没有收到文件内容' });
    const rawName = String(req.query.name || '').trim() || '未命名文件';
    const name = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const mime = String(req.query.mime || req.headers['content-type'] || 'application/octet-stream');
    const extMatch = name.match(/\.([A-Za-z0-9]{1,8})$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'bin';
    const dir = path.join(store.dataDir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    const rel = path.join('files', `${id}.${ext}`);
    fs.writeFileSync(path.join(store.dataDir, rel), buf);
    const item = {
      id,
      seq: store.nextSeq(),
      createdAt: now(),
      updatedAt: now(),
      name,
      mime,
      size: buf.length,
      kind: kindOf(mime),
      file: rel,
    };
    store.db.data.files.push(item);
    store.save();
    res.json(item);
  });

  if (store?.dataDir) {
    app.use('/files', express.static(path.join(store.dataDir, 'files')));
  }

  // 录音文件（受局域网口令保护，本机访问免口令）
  if (store?.dataDir) {
    app.use('/recordings', express.static(path.join(store.dataDir, 'recordings')));
  }

  /* ---- 屏幕获取：会话帧暂存 + 结束后统一 OCR 整理 ---- */

  const OCR_SCRIPT = path.join(APP_ROOT, 'tools', 'win-ocr.ps1');
  const SCREEN_DIR = () => path.join(store.dataDir, '.screen-tmp', 'session');

  /** 识别一张图（本机 Windows OCR）；SCREEN_OCR_CMD 可注入假 OCR 供测试 */
  function runOcr(imageAbs) {
    const fake = process.env.SCREEN_OCR_CMD;
    if (fake) {
      return new Promise((resolve, reject) => {
        execFile(process.execPath, [fake, imageAbs], { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout));
        });
      });
    }
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-Path', imageAbs],
        { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
          else resolve(String(stdout));
        },
      );
    });
  }

  /** 从文字里挖日期（明天/周X/下周X/2026-10-20/10月20日/10-20）——与服务端周几工具一致 */
  function extractDueDate(text, ref) {
    const t = String(text || '');
    let m;
    if ((m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/))) {
      const p = (n) => String(n).padStart(2, '0');
      return `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
    }
    if ((m = t.match(/(\d{1,2})[-/.月](\d{1,2})日?(?![题页])/))) {
      const mo = Number(m[1]);
      const d = Number(m[2]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const p = (n) => String(n).padStart(2, '0');
        return `${ref.slice(0, 4)}-${p(mo)}-${p(d)}`;
      }
    }
    const off = { 今天: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
    for (const [k, v] of Object.entries(off)) {
      if (t.includes(k)) return addDaysLocal(ref, v);
    }
    if ((m = t.match(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/))) {
      const W = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
      let delta = ((W[m[2]] - new Date(`${ref}T00:00:00`).getDay()) + 7) % 7;
      if (m[1]) delta += 7;
      return addDaysLocal(ref, delta);
    }
    return '';
  }

  /* ---- 视觉：她能"看见"图片和视频（本机视觉模型 + ffmpeg 抽帧） ---- */

  const VISION_URL = () => process.env.VISION_URL || 'http://127.0.0.1:8083/v1';
  const VISION_FFMPEG = () => process.env.VISION_FFMPEG || 'D:\\DeepSeek-R1-7B\\vision\\ffmpeg.exe';

  /* ---- 我的模型（柳月虹的大脑）：聊天/视觉/语音三件套统一管理，自愈式拉起 ---- */

  const MODEL_DIR = () => process.env.MODEL_DIR || 'D:\\DeepSeek-R1-7B';
  const localChildren = new Map(); // kind -> child process
  // 测试隔离：MODEL_PORT_BASE=9000 时端口整体挪到 9080-9083，绝不碰真机端口
  const MODEL_PORT_BASE = process.env.MODEL_PORT_BASE ? Number(process.env.MODEL_PORT_BASE) : null;
  const effPort = (p) => (MODEL_PORT_BASE ? MODEL_PORT_BASE + (p % 1000) : p);

  const MODEL_DEFS = {
    chat: {
      label: '💬 聊天 · DeepSeek-R1-7B',
      note: '深度思考 · 数学/逻辑/推理题（慢，想得深）',
      port: effPort(8080),
      args: () => [
        ['llama-cuda\\llama-server.exe', ['-m', 'model\\DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf', '-a', 'deepseek-r1-7b', '--host', '127.0.0.1', '--port', '8080', '-c', '4096', '-ngl', '99']],
        ['llama\\llama-server.exe', ['-m', 'model\\DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf', '-a', 'deepseek-r1-7b', '--host', '127.0.0.1', '--port', '8080', '-c', '4096']],
      ],
    },
    vision: {
      label: '👁 视觉 · Qwen2.5-VL-3B',
      note: '看图/看视频 · 柳月虹的眼睛',
      port: effPort(8083),
      args: () => [
        ['llama\\llama-server.exe', ['-m', 'vision\\ggml-model-q4_k_m.gguf', '--mmproj', 'vision\\mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf', '--host', '127.0.0.1', '--port', '8083', '-c', '4096', '-ngl', '0']],
      ],
    },
    qwen: {
      label: '💬 聊天 · 千问 7B（日常大脑）',
      note: '日常聊天 · 快（默认大脑）',
      port: effPort(8081),
      args: () => [
        ['llama-cuda\\llama-server.exe', ['-m', 'model\\qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf', '-a', 'qwen2.5-7b-instruct', '--host', '127.0.0.1', '--port', '8081', '-c', '4096', '-ngl', '99']],
      ],
    },
    coder: {
      label: '💻 编程 · Coder 7B',
      note: '编程 · 写代码/找 bug',
      port: effPort(8082),
      args: () => [
        ['llama-cuda\\llama-server.exe', ['-m', 'model\\qwen2.5-coder-7b-instruct-q4_0.gguf', '-a', 'qwen2.5-coder-7b', '--host', '127.0.0.1', '--port', '8082', '-c', '4096', '-ngl', '99']],
      ],
    },
    qwen4: {
      label: '💬 聊天 · Qwen3.5-4B',
      note: '轻量全才 · 快（新模型）',
      port: effPort(8084),
      args: () => [
        ['llama-cuda\\llama-server.exe', ['-m', 'model\\Qwen3.5-4B-Q4_K_M.gguf', '-a', 'qwen3.5-4b', '--host', '127.0.0.1', '--port', '8084', '-c', '4096', '-ngl', '99']],
        ['llama\\llama-server.exe', ['-m', 'model\\Qwen3.5-4B-Q4_K_M.gguf', '-a', 'qwen3.5-4b', '--host', '127.0.0.1', '--port', '8084', '-c', '4096']],
      ],
    },
  };

  function modelNeeds(kind) {
    const def = MODEL_DEFS[kind];
    const dir = MODEL_DIR();
    const missing = def.args().some(([, a]) => {
      const modelArg = a.find((x, i) => a[i - 1] === '-m' || a[i - 1] === '--mmproj');
      return modelArg && !fs.existsSync(path.join(dir, modelArg));
    });
    return { missing, dir };
  }

  async function probePort(port) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 找可用的启动程序（只找不 spawn），给 ensure 先确认"能启动"再动冲突模型 */
  function modelLauncher(kind) {
    const def = MODEL_DEFS[kind];
    const dir = MODEL_DIR();
    const exe = def.args().find(([rel]) => fs.existsSync(path.join(dir, rel)));
    return exe || null;
  }

  function startLocalModel(kind) {
    const def = MODEL_DEFS[kind];
    const dir = MODEL_DIR();
    // 测试环境：用假模型服务代替真实 llama-server（命令 + 端口参数）
    if (process.env.FAKE_MODEL_CMD) {
      const [cmd, ...rest] = process.env.FAKE_MODEL_CMD.split(' ');
      const child = spawn(cmd, [...rest, String(def.port)], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      localChildren.set(kind, child);
      child.once('exit', () => localChildren.delete(kind));
      return child;
    }
    const exe = modelLauncher(kind);
    const [, argv] = exe;
    const child = spawn(path.join(dir, exe[0]), argv, {
      cwd: dir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    localChildren.set(kind, child);
    child.once('exit', () => localChildren.delete(kind));
    return child;
  }

  app.get('/api/local/status', async (req, res) => {
    const out = [];
    for (const [kind, def] of Object.entries(MODEL_DEFS)) {
      const { missing } = modelNeeds(kind);
      const online = await probePort(def.port);
      out.push({ kind, label: def.label, note: def.note || '', port: def.port, online, files: !missing, running: Boolean(localChildren.get(kind)) });
    }
    const whisper = whisperPaths();
    out.push({
      kind: 'whisper',
      label: '👂 语音 · Whisper（按需调用）',
      note: '语音转文字 · 录音总结',
      port: 0,
      online: Boolean(whisper.bin && whisper.model),
      files: Boolean(whisper.bin && whisper.model),
      running: false,
    });
    res.json({ models: out });
  });

  const CHAT_KINDS = ['chat', 'qwen', 'coder', 'qwen4'];

  /** 模型管家是否被关掉（开关关 / 测试环境禁自动启动） */
  function autoManageDisabled() {
    if (process.env.NO_AUTOSTART === '1') return 'env';
    if (store.db.settings.autoManage === false) return 'off';
    return null;
  }

  /** 按端口找到 llama-server 进程并结束它（关掉"手动打开"的冲突模型；只杀模型进程） */
  async function killByPort(port) {
    if (process.platform !== 'win32') return false;
    const net = await new Promise((resolve) => {
      exec('netstat -ano -p tcp', { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    const line = String(net)
      .split(/\r?\n/)
      .find((l) => l.includes(`127.0.0.1:${port}`) && /\sLISTENING\s/.test(l));
    const pid = line && line.trim().split(/\s+/).pop();
    if (!pid || !/^\d+$/.test(pid)) return false;
    const info = await new Promise((resolve) => {
      exec(`tasklist /FI "PID eq ${pid}"`, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    if (!/llama-server\.exe/i.test(info)) return false; // 不是模型进程，绝不误杀
    await new Promise((resolve) => {
      exec(`taskkill /PID ${pid} /F`, { windowsHide: true }, () => resolve());
    });
    return true;
  }

  /** 停掉一个模型：自己拉起的孩子直接杀；手动开的按端口找 llama-server 杀 */
  async function stopLocalKind(kind) {
    const def = MODEL_DEFS[kind];
    if (!def) return { kind, stopped: false, how: 'none' };
    const child = localChildren.get(kind);
    if (child) {
      try {
        child.kill();
      } catch {
        // 已退
      }
      localChildren.delete(kind);
      return { kind, stopped: true, how: 'child' };
    }
    const killed = await killByPort(def.port);
    return { kind, stopped: killed, how: killed ? 'manual' : 'none' };
  }

  /**
   * 确保某个模型在跑（模型管家核心）：
   * - 已在跑 → already
   * - 聊天模型共用一个显卡位 → 自动关掉正在跑的其它聊天模型（包括手动开的）
   * - 文件不全 / 没有启动程序 → 返回原因，不硬来
   * - 并发去重：同一个模型已在启动中时，等待同一个结果，绝不重复拉起（防内存被双份占用）
   */
  const startingKinds = new Map(); // kind -> Promise

  async function ensureLocalModel(kind, waitMs = 30000, via = '未标注') {
    const def = MODEL_DEFS[kind];
    if (!def) return { ok: false, reason: 'bad-kind' };
    if (await probePort(def.port)) return { ok: true, already: true, kind };
    // 启动审计：每次真实拉起都记账（谁、什么时候、起了没成），追查"模型怎么又跑了"只看此表
    try {
      fs.appendFileSync(
        path.join(store.dataDir, 'model-wake.log'),
        `${now()} | ${def.label || kind} | 来源=${via}\n`,
      );
    } catch {
      /* 记账失败不拦启动 */
    }
    const inflight = startingKinds.get(kind);
    if (inflight) return inflight;
    const p = doEnsureLocalModel(kind, waitMs).finally(() => startingKinds.delete(kind));
    startingKinds.set(kind, p);
    return p;
  }

  async function doEnsureLocalModel(kind, waitMs) {
    const def = MODEL_DEFS[kind];
    // 先确认能启动（文件/启动程序都在），再动"关冲突"——绝不为启动失败白杀正在跑的模型
    const { missing } = modelNeeds(kind);
    if (missing) return { ok: false, reason: 'files', error: `${def.label} 的文件还不全（可能还在后台下载）` };
    if (!process.env.FAKE_MODEL_CMD && !modelLauncher(kind)) {
      return { ok: false, reason: 'launcher', error: '找不到可用的启动程序' };
    }
    const stopped = [];
    if (CHAT_KINDS.includes(kind)) {
      for (const other of CHAT_KINDS) {
        if (other === kind) continue;
        if (await probePort(MODEL_DEFS[other].port)) {
          const r = await stopLocalKind(other);
          if (r.stopped) stopped.push(other);
        }
      }
      if (stopped.length) await new Promise((r) => setTimeout(r, 1500)); // 等端口释放
    }
    const child = startLocalModel(kind);
    if (!child) return { ok: false, reason: 'launcher', error: '找不到可用的启动程序' };
    const ticks = Math.max(1, Math.ceil(waitMs / 2000));
    for (let i = 0; i < ticks; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await probePort(def.port)) return { ok: true, kind, started: true, stopped, warming: false };
    }
    return { ok: true, kind, started: true, stopped, warming: true };
  }

  /** 设置里某个 kind 对应的模型条目（按端口认） */
  function entryForKind(kind) {
    const def = MODEL_DEFS[kind];
    if (!def) return null;
    const list = Array.isArray(store.db.settings.models) ? store.db.settings.models : [];
    return list.find((m) => String(m.baseUrl || '').includes(`:${def.port}/`)) || null;
  }

  /**
   * 自动调度 + 模型管家：任务想要的模型没在跑时，自动启动它（自动关掉冲突模型），
   * 并把它放到候选列表最前面；起不来则维持原候选链（仍然能自动降级）。
   */
  async function autoSwitchRoute(route) {
    if (!route || autoManageDisabled()) return route;
    if (route.auto !== true) {
      // 手动模式自愈：激活的模型没在跑就自动拉起（切换模型后、重启后照常能聊），自动关掉冲突模型
      const entry = (store.db.settings.models || []).find((m) => m.id === store.db.settings.activeModelId);
      if (!entry) return route;
      const kind =
        Object.keys(MODEL_DEFS).find(
          (k) =>
            MODEL_DEFS[k].port &&
            CHAT_KINDS.includes(k) &&
            String(entry.baseUrl || '').includes(`:${MODEL_DEFS[k].port}/`),
        ) || '';
      if (!kind) return route;
      await ensureLocalModel(kind, 40000, '自动调度·手动自愈'); // ensureLocalModel 内部做并发去重
      return route;
    }
    const kind = route.wanted === 'code' ? 'coder' : route.wanted === 'reasoning' ? 'chat' : 'qwen';
    if (!MODEL_DEFS[kind]) return route;
    const entry = entryForKind(kind);
    if (!entry) return route; // 设置里没有这个本机模型条目 → 路由表不认识，不动模型管家
    const poolIds =
      Array.isArray(store.db.settings.selectedModels) && store.db.settings.selectedModels.length
        ? store.db.settings.selectedModels
        : null;
    if (poolIds && !poolIds.includes(entry.id)) return route; // 不在用户多选的池里 → 不自动启动它
    const r = await ensureLocalModel(kind, 40000, '自动调度'); // ensureLocalModel 内部做并发去重
    const use = (k, res) => {
      const e = entryForKind(k);
      if (!e || !res || !res.ok) return null;
      const ensuredPick = {
        id: e.id,
        name: e.name || e.model,
        type: e.type || 'local',
        baseUrl: e.baseUrl,
        model: e.model,
        apiKey: e.apiKey || '',
      };
      const others = (route.candidates || []).filter((c) => c.baseUrl !== ensuredPick.baseUrl);
      return { ...route, pick: ensuredPick, candidates: [ensuredPick, ...others], switched: k, switchedLabel: MODEL_DEFS[k].label };
    };
    const direct = use(kind, r);
    if (direct) return direct;
    // 目标模型起不来：如果现在一个聊天模型都没有，按顺序试试拉起别的（打开助手/发消息时自愈）
    if (!route.anyOnline) {
      for (const k of CHAT_KINDS) {
        if (k === kind) continue;
        const { missing } = modelNeeds(k);
        if (missing) continue;
        const rr = await ensureLocalModel(k, 40000, '自动调度·备胎');
        const alt = use(k, rr);
        if (alt) return alt;
      }
    }
    return route;
  }

  app.post('/api/local/start', async (req, res) => {
    const kind = String((req.body && req.body.kind) || '');
    const def = MODEL_DEFS[kind];
    if (!def) return res.status(400).json({ error: '没有这个模型' });
    const r = await ensureLocalModel(kind, 30000, '手动开关start');
    if (!r.ok) return res.status(409).json({ error: r.error || '启动失败' });
    res.json({ ok: true, already: r.already, stopped: r.stopped || [], warming: r.warming });
  });

  app.post('/api/local/stop', async (req, res) => {
    const kind = String((req.body && req.body.kind) || '');
    const r = await stopLocalKind(kind);
    res.json({ ok: true, none: !r.stopped, how: r.how });
  });

  // 一键全部关闭：把所有在跑的模型都停掉（包括手动开的），返回被停的列表
  app.post('/api/local/stop-all', async (req, res) => {
    const stopped = [];
    for (const kind of Object.keys(MODEL_DEFS)) {
      const r = await stopLocalKind(kind);
      if (r.stopped) stopped.push(kind);
    }
    res.json({ ok: true, stopped });
  });

  // 模型管家：打开 AI 助手时调用——自动启动需要的模型（聊天 + 视觉，全部能力就位）
  // 开关 autoManage=false 时自动启动全部停摆；但用户"亲手点"的操作（设为当前/一键启动）
  // 带 force:true 明确豁免——阿珑要关的是"它自己偷偷开"，不是"我让它开它不开"。
  app.post('/api/local/ensure', async (req, res) => {
    const guard = autoManageDisabled();
    if (guard && !(req.body && req.body.force === true)) return res.json({ ok: false, reason: guard });
    let kind = String((req.body && req.body.kind) || '');
    // 也支持按模型 id 启动：切换模型时前端传 modelId，按条目端口认 kind
    const modelId = String((req.body && req.body.modelId) || '');
    if (!kind && modelId) {
      const entry = (store.db.settings.models || []).find((m) => m.id === modelId);
      if (!entry) return res.status(404).json({ error: '没有这个模型' });
      kind =
        Object.keys(MODEL_DEFS).find(
          (k) => MODEL_DEFS[k].port && String(entry.baseUrl || '').includes(`:${MODEL_DEFS[k].port}/`),
        ) || '';
      if (!kind) return res.json({ ok: false, reason: 'not-local', error: '这个不是本机模型，不需要启动' });
    }
    if (kind) {
      if (!MODEL_DEFS[kind]) return res.status(400).json({ error: '没有这个模型' });
      const r = await ensureLocalModel(kind, 45000, 'ensure接口(modelId)');
      return res.json({
        ok: r.ok,
        reason: r.reason || '',
        started: r.started ? [MODEL_DEFS[kind].label] : [],
        stopped: r.stopped || [],
        already: Boolean(r.already),
        warming: Boolean(r.warming),
      });
    }
    // 默认组合：聊天（哪个在跑就保持哪个；都没跑就按优先级开）+ 视觉（CPU 运行，和聊天不冲突）
    const started = [];
    const errors = [];
    const anyChat = (await Promise.all(CHAT_KINDS.map((k) => probePort(MODEL_DEFS[k].port)))).some(Boolean);
    // 当前激活的是云端模型（地址不在本机）→ 不拉任何本地聊天模型，省显存
    const activeEntry = (store.db.settings.models || []).find((m) => m.id === store.db.settings.activeModelId);
    const activeIsCloud = !!activeEntry && !/127\.0\.0\.1|localhost|\[::1\]/i.test(String(activeEntry.baseUrl || ''));
    if (!anyChat && !activeIsCloud) {
      let prefer = ['qwen', 'chat', 'coder'];
      if (store.db.settings.autoRoute === false) {
        const active = (store.db.settings.models || []).find((m) => m.id === store.db.settings.activeModelId);
        const k = active && CHAT_KINDS.find((x) => String(active.baseUrl || '').includes(`:${MODEL_DEFS[x].port}/`));
        if (k) prefer = [k, ...CHAT_KINDS.filter((x) => x !== k)];
      }
      for (const k of prefer) {
        const { missing } = modelNeeds(k);
        if (missing) continue;
        const r = await ensureLocalModel(k, 45000, 'ensure默认组合');
        if (r.ok) {
          started.push(MODEL_DEFS[k].label);
          break;
        }
        if (r.reason) errors.push(`${MODEL_DEFS[k].label}: ${r.reason}`);
      }
    }
    if (!(await probePort(MODEL_DEFS.vision.port))) {
      const { missing } = modelNeeds('vision');
      if (!missing) {
        const r = await ensureLocalModel('vision', 45000, 'ensure默认组合·视觉');
        if (r.ok) started.push(MODEL_DEFS.vision.label);
      }
    }
    res.json({ ok: true, started, errors });
  });

  const OLLAMA_URL = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434/v1';

  /** 视觉双引擎：先试 llama 版（8083），离线自动用 Ollama（qwen2.5vl:3b）兜底 */
  async function visionChat(blocks, maxTokens = 400) {
    const targets = [
      { url: VISION_URL().replace(/\/$/, ''), model: 'vision', engine: 'llama' },
      { url: OLLAMA_URL().replace(/\/$/, ''), model: 'qwen2.5vl:3b', engine: 'ollama' },
    ];
    let lastErr = null;
    for (const t of targets) {
      try {
        const r = await fetch(`${t.url}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: t.model,
            messages: [{ role: 'user', content: blocks }],
            stream: false,
            temperature: 0.2,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(300000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const msg = j.choices && j.choices[0] && j.choices[0].message;
        const text = (msg && String(msg.content || '').trim()) || '';
        if (!text) throw new Error('无输出');
        return { text, engine: t.engine };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('视觉模型没响应');
  }

  /**
   * 工作台聊天"看图"接线：用户发了图才按需拉起视觉模型（这不是闲时自动启动——
   * 阿珑关的是"开页面就自动拉模型"，主动发图=明确要用视觉，和 OCR 同款豁免）。
   * visionCache：按文件路径缓存描述，供"挑图即预识别"和真实发送共享；inflight 去重防双击。
   */
  const analyzeImageFile = async (file, mime) => {
    if (await probePort(MODEL_DEFS.vision.port)) {
      /* 已在线 */
    } else {
      const { missing } = modelNeeds('vision');
      if (missing) throw new Error('视觉组件未就绪');
      const r = await ensureLocalModel('vision', 45000, '识图OCR按需');
      if (!r.ok) throw new Error((r && r.reason) || '视觉模型启动失败');
    }
    const b64 = fs.readFileSync(path.join(store.dataDir, file)).toString('base64');
    const t = await visionChat(
      [
        { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${b64}` } },
        { type: 'text', text: '这是什么图片？①一句话说明它是什么、画/拍/截的是什么、想表达什么（表格图表报关键数字）；②换行把图里能看见的文字原样抄出来（最多 300 字，没有就省略此行）。直接输出，不要问候。' },
      ],
      450,
    );
    return String(t.text || '').trim().slice(0, 1200);
  };
  const visionInflight = new Set();
  const visionCacheGet = (file) => {
    const c = store.db.settings.visionCache || [];
    const hit = c.find((x) => x && x.file === file && x.desc);
    return hit ? hit.desc : '';
  };
  const visionCachePut = (file, desc) => {
    if (!desc) return;
    let c = store.db.settings.visionCache || [];
    c = c.filter((x) => x && x.file !== file);
    c.push({ file, desc, at: now() });
    store.db.settings.visionCache = c.slice(-40); // 只留最近 40 张，防无限膨胀
    store.save();
  };
  const annotateWithVision = (outMessages) =>
    annotateVisionMessages(outMessages, {
      wakeVision: async () => {
        if (!(await probePort(MODEL_DEFS.vision.port))) {
          const { missing } = modelNeeds('vision');
          if (missing) throw new Error('视觉组件未就绪');
          const r = await ensureLocalModel('vision', 45000, '看图describe按需');
          if (!r.ok) throw new Error((r && r.reason) || '视觉模型启动失败');
        }
      },
      readFile: (rel) => fs.readFileSync(path.join(store.dataDir, rel)),
      visionFn: async (b64, mime) =>
        (
          await visionChat(
            [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
              { type: 'text', text: '这是什么图片？①一句话说明它是什么、画/拍/截的是什么、想表达什么（表格图表报关键数字）；②换行把图里能看见的文字原样抄出来（最多 300 字，没有就省略此行）。直接输出，不要问候。' },
            ],
            450,
          )
        ).text,
      lookupCache: visionCacheGet,
      cacheBack: (file, desc) => {
        visionCachePut(file, desc);
        const list = store.db.data.chatMessages || [];
        for (let i = list.length - 1; i >= 0; i--) {
          const x = list[i];
          if (!x || x.role !== 'user' || !Array.isArray(x.attachments)) continue;
          const t = x.attachments.find((y) => y && y.file === file && !y.desc);
          if (t) {
            t.desc = desc;
            x.updatedAt = now();
            store.save();
            return;
          }
        }
      },
    });

  // 挑图即预识别：前端上传完就 fire-and-forget 调这个，让视觉在用户打字时段先看完图。
  // 只认 files/ 下的相对路径，防目录穿越；inflight 去重（双击/重发不重复算）。
  // 注意：与旧的 /api/vision/describe（收 base64、返回 {description}）是两个不同端点，别混。
  app.post('/api/vision/preanalyze', async (req, res) => {
    const b = req.body;
    const file = String((b && b.file) || '');
    const rel = file.replace(/\\/g, '/');
    if (!rel.startsWith('files/') || rel.includes('..')) return res.status(400).json({ error: '非法文件路径' });
    const cached = visionCacheGet(file);
    if (cached) return res.json({ ok: true, desc: cached, cached: true });
    if (visionInflight.has(file)) return res.json({ ok: false, inflight: true });
    visionInflight.add(file);
    try {
      const desc = await analyzeImageFile(file, (b && b.mime) || 'image/png');
      visionCachePut(file, desc);
      res.json({ ok: true, desc });
    } catch (e) {
      res.status(502).json({ ok: false, error: String((e && e.message) || e).slice(0, 120) });
    } finally {
      visionInflight.delete(file);
    }
  });

  // ---------- AI 画图：auto（默认）有智谱 Key 走智谱、没 Key 自动走零密钥通道，永远能画 ----------
  // Key 来源两路：①「画图密钥：xxx」存的 imagineKey；②模型列表里指向 bigmodel.cn 的条目 apiKey（他注册后装那即通用）
  const zhipuKeyFromModels = () => {
    const e = (store.db.settings.models || []).find(
      (m) => m.type === 'cloud' && /open\.bigmodel\.cn/i.test(String(m.baseUrl || '')) && String(m.apiKey || '').trim().length >= 16,
    );
    return e ? String(e.apiKey).trim() : '';
  };
  const zhipuKey = () => String(store.db.settings.imagineKey || '').trim() || zhipuKeyFromModels();
  app.get('/api/imagine/status', (req, res) => {
    const s = store.db.settings;
    const key = zhipuKey();
    res.json({
      provider: s.imagineProvider || 'auto',
      hasKey: !!key,
      keySource: s.imagineKey ? 'imagineKey' : key ? 'modelEntry' : '',
      activeChannel:
        s.imagineProvider === 'ollama' || s.imagineProvider === 'zhipu' || s.imagineProvider === 'pollinations'
          ? s.imagineProvider
          : key
            ? 'zhipu'
            : 'pollinations',
    });
  });
  app.post('/api/imagine', async (req, res) => {
    const b = req.body;
    const prompt = String((b && b.prompt) || '').trim().slice(0, 800);
    if (prompt.length < 2) return res.status(400).json({ error: '先告诉我想画什么（至少几个字）' });
    const s = store.db.settings;
    const key = zhipuKey();
    const provider = ['ollama', 'zhipu', 'pollinations'].includes(s.imagineProvider) ? s.imagineProvider : 'auto';
    try {
      let buf = null;
      let ext = 'png';
      let mime = 'image/png';
      let channel = provider;
      if (provider === 'ollama') {
        try {
          const r = await fetch('http://127.0.0.1:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: String(s.imagineOllamaModel || 'xccm'), prompt, stream: false }),
            signal: AbortSignal.timeout(600000),
          });
          if (r.ok) {
            const j = await r.json().catch(() => null);
            const raw = j && (Array.isArray(j.images) ? j.images[0] : j.image);
            if (raw) buf = Buffer.from(String(raw), 'base64');
          }
        } catch {
          /* 统一在下面给指引报错 */
        }
        if (!buf) {
          return res.status(502).json({ error: '本地 Ollama 画图没就绪（没装/模型没下载/显存不够）。把通道切回「auto」就能用云端直接画。' });
        }
      } else if (provider === 'zhipu') {
        if (!key) {
          return res.status(400).json({ error: '指定了智谱通道但没装 Key（发「画图密钥：xxx」装上；或发「画图通道：auto」免 Key 直接画）' });
        }
        buf = await imagineViaZhipu(prompt, key);
      } else if (provider === 'pollinations') {
        // 显式锁定零密钥通道（不耗智谱额度；图带 AI 生成水印）
        const pic = await imagineViaPollinations(prompt);
        buf = pic.buf;
        mime = pic.mime;
        ext = pic.ext;
        channel = 'pollinations';
      } else {
        // auto：有 Key 先智谱；没 Key 或智谱失灵 → 零密钥通道兜底，绝不让「画：」落空
        if (key) {
          try {
            buf = await imagineViaZhipu(prompt, key);
            channel = 'zhipu';
          } catch {
            /* 智谱不灵就无感换免Key通道 */
          }
        }
        if (!buf) {
          const pic = await imagineViaPollinations(prompt);
          buf = pic.buf;
          mime = pic.mime;
          ext = pic.ext;
          channel = 'pollinations';
        }
      }
      if (!buf || !buf.length) return res.status(502).json({ error: '生成结果为空，再试一次' });
      const id = crypto.randomUUID();
      const fname = `imagine-${id.slice(0, 8)}.${ext}`;
      fs.writeFileSync(path.join(store.dataDir, 'files', fname), buf);
      store.db.data.files.push({
        id,
        seq: store.nextSeq(),
        createdAt: now(),
        updatedAt: now(),
        name: `🎨${prompt.slice(0, 20)}.${ext}`,
        mime,
        size: buf.length,
        kind: 'image',
        file: path.join('files', fname),
        source: 'imagine',
      });
      store.save();
      res.json({ ok: true, file: `files/${fname}`, url: `/files/${fname}`, prompt, channel });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
  });

  app.get('/api/vision/status', async (req, res) => {
    let online = false;
    let engine = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`${VISION_URL().replace(/\/$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(t);
      online = r.ok;
      if (online) engine = 'llama';
    } catch {
      online = false;
    }
    // llama 版不在线就看 Ollama 兜底
    let ollamaOnline = false;
    if (!online) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`${OLLAMA_URL().replace(/\/$/, '')}/models`, { signal: ctrl.signal });
        clearTimeout(t);
        ollamaOnline = r.ok;
        if (ollamaOnline) engine = 'ollama';
      } catch {
        ollamaOnline = false;
      }
    }
    res.json({ online: online || ollamaOnline, engine, url: VISION_URL(), ffmpeg: fs.existsSync(VISION_FFMPEG()) });
  });

  app.post('/api/vision/describe', async (req, res) => {
    const b = req.body;
    if (!isObject(b) || typeof b.image !== 'string' || !b.image) {
      return res.status(400).json({ error: '缺少图片内容' });
    }
    try {
      // 防呆：视觉模型没开着 OCR 会直接 502——用时按需自启（起不动再交给下方双级回退）
      if (!(await probePort(MODEL_DEFS.vision.port))) {
        const { missing } = modelNeeds('vision');
        if (!missing) {
          try {
            await ensureLocalModel('vision', 45000, '预识别preanalyze');
          } catch {
            /* 起失败不拦路，visionChat 自己会报错 */
          }
        }
      }
      const desc = await visionChat(
        [
          { type: 'image_url', image_url: { url: `data:${b.mime || 'image/png'};base64,${b.image}` } },
          { type: 'text', text: '请把图片里出现的所有文字逐行原样抄写出来（中文保留中文、数字保留数字），不要翻译、不要解释、不要描述画面；如果没有任何文字，只输出「空」。' },
        ],
        700,
      );
      res.json({ description: desc.text, engine: desc.engine });
    } catch (e) {
      res.status(502).json({
        error: `视觉模型没响应：${e.message}（视觉组件还没就绪——正在后台下载 Ollama 兜底方案，稍后再试）`,
      });
    }
  });

  app.post('/api/vision/video', express.raw({ type: () => true, limit: '400mb' }), async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: '没有收到视频' });
    const ff = VISION_FFMPEG();
    if (!fs.existsSync(ff)) {
      return res.status(409).json({ error: 'ffmpeg 还没下载好（正在后台下载中，稍后再试）' });
    }
    const dir = path.join(store.dataDir, '.vision-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${id}.mp4`), buf);
    try {
      await new Promise((resolve, reject) => {
        // 测试时 ffmpeg 可指到 .mjs 假实现（用 node 跑）；正常是 exe 直接 spawn
        const isScript = ff.endsWith('.js') || ff.endsWith('.mjs');
        execFile(
          isScript ? process.execPath : ff,
          isScript
            ? [ff, '-y', '-i', path.join(dir, `${id}.mp4`), '-vf', 'fps=1/3,scale=768:-2', '-frames:v', '10', path.join(dir, `${id}-%02d.jpg`)]
            : ['-y', '-i', path.join(dir, `${id}.mp4`), '-vf', 'fps=1/3,scale=768:-2', '-frames:v', '10', path.join(dir, `${id}-%02d.jpg`)],
          { windowsHide: true, timeout: 120000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      const frames = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.jpg'))
        .sort();
      if (!frames.length) throw new Error('没能从视频里抽出画面');
      const blocks = frames.map((f) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}` },
      }));
      blocks.push({
        type: 'text',
        text: `这是从一段视频里每隔 3 秒抽出的一帧（按时间顺序，共 ${frames.length} 帧）。请用中文描述这段视频大概在讲什么，提到关键画面。`,
      });
      const desc = await visionChat(blocks, 400);
      res.json({ description: desc.text, engine: desc.engine, frames: frames.length });
    } catch (e) {
      res.status(502).json({ error: `视频识别失败：${e.message}` });
    } finally {
      for (const f of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          // 删不掉下次清
        }
      }
    }
  });

  app.post('/api/screen/frame', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: '没有收到画面' });
    const dir = SCREEN_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const n = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    if (n >= 600) return res.status(429).json({ error: '这场记录太长了，先结束整理再开始新的' });
    fs.writeFileSync(path.join(dir, `frame-${Date.now()}-${n}.png`), buf);
    res.json({ ok: true, frames: n + 1 });
  });

  app.post('/api/screen/finish', async (req, res) => {
    const dir = SCREEN_DIR();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')) : [];
    if (!files.length) return res.json({ items: [], summary: '这次没有记录到画面' });
    const texts = [];
    const seen = new Set();
    for (const f of files) {
      try {
        const raw = await runOcr(path.join(dir, f));
        const clean = raw
          .split(/\r?\n/)
          .map((l) =>
            l
              .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
              .replace(/\s+/g, ' ')
              .trim(),
          )
          .filter(Boolean)
          .join('\n');
        if (clean && !seen.has(clean)) {
          seen.add(clean);
          texts.push(clean);
        }
      } catch {
        // 单帧识别失败跳过
      }
    }
    // 整理完立刻清掉临时帧（隐私：不留图）
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // 删不掉下次再清
      }
    }
    if (!texts.length) return res.json({ items: [], summary: '画面里没认出文字（换清晰一点的页面试试）' });
    const combined = texts.join('\n').slice(0, 2500);
    const answer = await quickModelText(
      store,
      [
        { role: 'system', content: '你是整理助手。请直接输出结果，不要思考过程、不要解释。' },
        {
          role: 'user',
          content:
            '把下面的屏幕文字整理成可行动的事项。规则：\n' +
            '- 每行一条，格式「类型|内容」，类型只能是：任务、备忘、学习、记忆\n' +
            '- 任务=要去做的事；学习=课程/作业/考试；备忘=要记下的零散信息（邮箱、号码、地址）；记忆=关于用户的长期信息\n' +
            '- 内容只从屏幕文字里提取，不要编造、不要加自己的话；日期照抄原文（如"明天""下周一""10-20"）\n' +
            '- 最多 8 条；一条都没有就只输出「无」\n' +
            '示例：\n' +
            '学习|第三章课后习题 截止 下周一\n' +
            '备忘|老师邮箱 math@school.edu.cn\n' +
            '任务|周三前交实验报告\n' +
            '---\n' +
            combined,
        },
      ],
      500,
      90000,
    );
    const items = [];
    if (answer) {
      for (const line of answer.split(/\n+/)) {
        const m = line.match(/^(任务|备忘|学习|记忆)[|｜:：]\s*(.+)$/);
        if (!m) continue;
        const kind = m[1] === '任务' ? 'task' : m[1] === '备忘' ? 'memo' : m[1] === '学习' ? 'study' : 'memory';
        const text = m[2].trim().slice(0, 80);
        if (!text) continue;
        let date = '';
        if (kind === 'task' || kind === 'study') date = extractDueDate(text, todayLocal());
        items.push({ kind, text, date });
        if (items.length >= 8) break;
      }
    }
    res.json({ items, summary: combined.slice(0, 600) });
  });

  // 设计概念稿（本地演示页面）：从工作台里一键打开，不联网
  if (fs.existsSync(CONCEPT_DIR)) {
    app.use('/concept', express.static(CONCEPT_DIR));
  }

  if (fs.existsSync(WEB_DIST)) {
    // 带内容 hash 的静态资源可以长期缓存（文件名一变就会重新下载）；页面入口不缓存，永远拿最新
    app.use('/assets', express.static(path.join(WEB_DIST, 'assets'), { maxAge: '365d', immutable: true }));
    app.use(express.static(WEB_DIST, { index: false, maxAge: 0 }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  }

  syncMemoryFiles(); // 启动时与 D 盘记忆文件夹对账（外部增删改都认）

  // Express 错误收口（必须放最后）：路由里同步抛出的异常到这里记日志、回 500——
  // async 路由的 reject Express 4 不接，由上面的进程级 unhandledRejection 兜底，两下一夹服务不会崩
  app.use((err, req, res, next) => {
    crashLog(`路由异常 ${req.method} ${req.path}`, err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: '服务器内部错误，详情见 data/server-crash.log' });
  });

  return app;
}

function findAppBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${local}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** 优先用浏览器的"应用窗口"模式打开：独立窗口 + 任务栏独立图标，像桌面应用 */
function openUrl(url) {
  let cmd;
  if (process.platform === 'win32') {
    const browser = findAppBrowser();
    cmd = browser ? `start "" "${browser}" --app="${url}" --window-size=1360,900` : `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {});
}

async function instanceRunning(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function startServer({
  dataDir = process.env.DATA_DIR ? path.resolve(process.cwd(), process.env.DATA_DIR) : DEFAULT_DATA_DIR,
  port = Number(process.env.PORT) || 8787,
  openBrowser = !process.env.NO_OPEN,
  maxTries = 11,
} = {}) {
  const store = new Store(dataDir);
  store.load();
  const app = createApp(store);
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p) => {
      const server = app.listen(p);
      server.once('listening', () => {
        const actual = server.address().port;
        if (openBrowser) openUrl(`http://localhost:${actual}`);
        resolve({ server, store, app, port: actual });
      });
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < maxTries) {
          attempt += 1;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
    };
    tryListen(port);
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  (async () => {
    const basePort = Number(process.env.PORT) || 8787;
    if (!process.env.NO_INSTANCE_CHECK && (await instanceRunning(basePort))) {
      console.log('🌸 工作台已经在运行，正在打开浏览器…');
      openUrl(`http://localhost:${basePort}`);
      return;
    }
    const { port, app } = await startServer({});
    const pin = app?.locals?.lanPin || '';
    const lan = lanAddresses();
    console.log('');
    console.log(`🌸 AI 助手已启动： http://localhost:${port}`);
    console.log('   数据已实时保存。关闭这个窗口即退出，不影响数据。');
    if (lan.length) {
      console.log('');
      console.log('📱 手机访问（和电脑连同一个 WiFi）：');
      for (const ip of lan) console.log(`   http://${ip}:${port}`);
      if (pin) console.log(`   手机第一次打开会让你输口令：${pin}（电脑上访问不需要）`);
      console.log('   如果手机打不开：Windows 弹防火墙提示时选「允许（专用网络）」；');
      console.log('   不放心的话手机用完可以把本窗口关掉，局域网就访问不到了。');
    }
    console.log('');
  })().catch((err) => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}
