import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = [
  'tasks',
  'memos',
  'memories',
  'chatMessages',
  'studyItems',
  'lessonNotes',
  'files',
  'documents',
  'ideas',
  'contentItems',
  'publishStats',
  'projects',
  'projectTasks',
  'devLogs',
  'clients',
  'followUps',
  'commLogs',
  'timeEntries',
  'workoutLogs',
  'weightLogs',
  'mealDays',
  'gameItems',
  'playLogs',
];

export const THEMES = ['light', 'dark', 'system'];

export function defaultSettings() {
  return {
    theme: 'light',
    platforms: ['小红书', '抖音', 'B站', '公众号', '其他'],
    weeklyPlan: ['休息', '休息', '休息', '休息', '休息', '休息', '休息'],
    gamePlan: ['休息', '休息', '休息', '休息', '休息', '休息', '休息'],
    waterGoal: 8,
    // AI 模型列表：可以加多个（本机/以后接云端），当前激活其中一个
    models: [
      {
        id: 'local-r1-7b',
        name: '本机 · DeepSeek-R1-7B',
        type: 'local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'deepseek-r1-7b',
        apiKey: '',
        note: '深度思考：数学/逻辑/推理（慢，想得深）',
      },
    ],
    activeModelId: 'local-r1-7b',
    // 兼容镜像：始终跟随"当前激活"的模型（老代码/老配置都读这里）
    modelApi: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'deepseek-r1-7b' },
    // 是否让 AI 助手在对话时带上"记忆树"的内容
    memoryEnabled: true,
    // 记忆机制：自动发现值得记住的话 + 发现配额与去重缓存
    autoMemory: true,
    // 记忆模式：auto = 静默自动记忆（只撤销）；ask = 每条都要确认（老行为）
    memoryMode: 'auto',
    memorySeen: [],
    memoryQuota: { hour: 0, count: 0 },
    memoryPending: [],
    // 模型协同：自动调度（按问题在你多选的模型里切换，目标离线自动降级）；默认关——默认突出用一个模型
    autoRoute: false,
    // 多选模型池：用户在助手页勾选的模型 id；空 = 全部可用
    selectedModels: [],
    // 模型管家：打开 AI 助手自动启动模型；自动调度需要时自动切换（并自动关掉冲突模型）
    autoManage: true,
    // 学习通邮箱桥：走邮箱官方 IMAP 免费通道收"学习通通知"（授权码只存本机）
    mailWatch: {
      enabled: false,
      host: 'imap.qq.com',
      user: '',
      authCode: '',
      lastUid: 0,
      lastError: '',
      lastPollAt: 0,
    },
    // 学习通直连（方案 A）：登录态只读同步。cookie 只存本机；need_login=登录失效待重连
    xxt: {
      cookie: '',
      status: 'off', // off | ready | synced | need_login | error
      lastSyncAt: 0,
      syncMsg: '',
      seenIds: [],
    },
    // 学习通通知流水（作业/考试/签到/成绩），最近 60 条
    xxtNotices: [],
    // 作业草稿队列：new → drafted（QQ 已通知）→ confirmed；可 redo
    xxtHomeworks: [],
    // QQ 主动推送队列（机器人轮询取走）
    qqPushQueue: [],
    // 她（柳月虹）：工作台里的 AI 伙伴（人设 + 性格档案 + 心事本 + 梦记）
    persona: {
      name: '柳月虹',
      addressAs: '阿珑',
      freedom: 'free',
      traits: [],
      thoughts: [],
      dreams: [],
      lastActiveAt: new Date().toISOString(),
      energy: 0.6,
      chatsSinceReflect: 0,
      // 运行时状态（随机状态机用；刷新/重启后接着算）
      state: 'online',
      nextAt: null,
      thoughtAt: null,
      thoughtCount: 0,
      sleepStartedAt: null,
      wakeAt: null,
      dreamAt: null,
      dreamCount: 0,
      modelOkUntil: 0,
      lastReflectAt: 0,
      pendingModelThought: null,
      modelBusy: false,
      dreamBusy: false,
      pendingDream: null,
      lastDigestAt: 0,
    },
  };
}

/** 校验并整理「她」的人设数据（限长，防脏数据） */
export function normalizePersona(raw) {
  const base = defaultSettings().persona;
  if (!raw || typeof raw !== 'object') return { ...base };
  const p = { ...base };
  if (typeof raw.name === 'string' && raw.name.trim()) p.name = raw.name.trim().slice(0, 20);
  if (typeof raw.addressAs === 'string' && raw.addressAs.trim()) p.addressAs = raw.addressAs.trim().slice(0, 20);
  if (['quiet', 'free', 'active'].includes(raw.freedom)) p.freedom = raw.freedom;
  if (Array.isArray(raw.traits)) {
    p.traits = raw.traits
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .slice(-8)
      .map((t) => ({
        text: String(t.text).trim().slice(0, 60),
        weight: Math.max(1, Math.min(5, Number(t.weight) || 1)),
        source: ['reflect', 'feedback', 'manual'].includes(t.source) ? t.source : 'reflect',
        updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
      }));
  }
  if (Array.isArray(raw.thoughts)) {
    p.thoughts = raw.thoughts
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .slice(-50)
      .map((t) => ({
        at: typeof t.at === 'string' ? t.at : new Date().toISOString(),
        text: String(t.text).trim().slice(0, 120),
        mood: ['happy', 'worry', 'curious', 'sleepy'].includes(t.mood) ? t.mood : 'curious',
        source: ['data', 'memory', 'model'].includes(t.source) ? t.source : 'data',
      }));
  }
  if (Array.isArray(raw.dreams)) {
    p.dreams = raw.dreams
      .filter((d) => d && typeof d.text === 'string' && d.text.trim())
      .slice(-20)
      .map((d) => ({
        at: typeof d.at === 'string' ? d.at : new Date().toISOString(),
        text: String(d.text).trim().slice(0, 160),
        type: ['温馨', '奇怪', '搞笑', '怀旧'].includes(d.type) ? d.type : '温馨',
      }));
  }
  if (typeof raw.lastActiveAt === 'string' && raw.lastActiveAt) p.lastActiveAt = raw.lastActiveAt;
  if (typeof raw.energy === 'number') p.energy = Math.max(0, Math.min(1, raw.energy));
  if (typeof raw.chatsSinceReflect === 'number') p.chatsSinceReflect = Math.max(0, raw.chatsSinceReflect | 0);
  // 运行时状态：随机状态机的计时器，原样保留
  for (const k of ['state', 'nextAt', 'thoughtAt', 'thoughtCount', 'sleepStartedAt', 'wakeAt', 'dreamAt', 'dreamCount', 'modelOkUntil', 'lastReflectAt', 'pendingModelThought', 'modelBusy', 'dreamBusy', 'pendingDream', 'lastDigestAt']) {
    if (k in raw) p[k] = raw[k];
  }
  return p;
}

/** 校验并整理一份模型条目；合法就返回规范化对象，不合法返回 null */
export function normalizeModelEntry(m, seen) {
  if (!m || typeof m !== 'object') return null;
  const baseUrl = typeof m.baseUrl === 'string' ? m.baseUrl.trim().replace(/\/$/, '') : '';
  const model = typeof m.model === 'string' ? m.model.trim() : '';
  if (!/^https?:\/\/.+/i.test(baseUrl) || !model) return null;
  let id = typeof m.id === 'string' && m.id.trim() ? m.id.trim().slice(0, 64) : '';
  if (!id) {
    // 没有 id 的旧数据：用地址+模型名生成一个稳定的 id，保证每次加载都一样
    id = `auto-${Buffer.from(`${baseUrl}|${model}`).toString('hex').slice(0, 12)}`;
  }
  let unique = id;
  let n = 2;
  while (seen.has(unique)) unique = `${id}-${n++}`;
  seen.add(unique);
  const type = m.type === 'cloud' ? 'cloud' : 'local';
  const name =
    typeof m.name === 'string' && m.name.trim()
      ? m.name.trim().slice(0, 60)
      : `${type === 'cloud' ? '云端' : '本机'} · ${model}`;
  return {
    id: unique,
    name,
    type,
    baseUrl,
    model,
    apiKey: typeof m.apiKey === 'string' ? m.apiKey : '',
    note: typeof m.note === 'string' ? m.note.slice(0, 120) : '',
  };
}

/**
 * 整理模型列表：
 * - 有合法 models 就用；
 * - 一个都没有时，用旧的 modelApi（或默认值）自动迁移成第一条（老用户无感升级）。
 */
export function normalizeModels(rawModels, fallbackApi) {
  const models = [];
  const seen = new Set();
  if (Array.isArray(rawModels)) {
    for (const m of rawModels) {
      const entry = normalizeModelEntry(m, seen);
      if (entry) models.push(entry);
    }
  }
  if (!models.length) {
    const api = fallbackApi && typeof fallbackApi === 'object' ? fallbackApi : {};
    const migrated =
      normalizeModelEntry(
        { baseUrl: api.baseUrl, model: api.model, name: '深度思考', type: 'local', id: 'local-r1-7b' },
        seen,
      ) || null;
    models.push(
      migrated || {
        id: 'local-r1-7b',
        name: '深度思考',
        type: 'local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'deepseek-r1-7b',
        apiKey: '',
        note: '深度思考：数学/逻辑/推理（慢，想得深）',
      },
    );
  }
  return models;
}

export function emptyDb() {
  const data = {};
  for (const c of COLLECTIONS) data[c] = [];
  // seq：全局递增序号，保证"最新一条"的排序在 createdAt 相同（同一毫秒）时依然稳定
  return { version: 1, seq: 0, settings: defaultSettings(), data };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timestampStr(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeSettings(raw) {
  const s = defaultSettings();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (THEMES.includes(raw.theme)) s.theme = raw.theme;
    if (Array.isArray(raw.platforms) && raw.platforms.every((x) => typeof x === 'string')) {
      s.platforms = raw.platforms;
    }
    if (
      Array.isArray(raw.weeklyPlan) &&
      raw.weeklyPlan.length === 7 &&
      raw.weeklyPlan.every((x) => typeof x === 'string')
    ) {
      s.weeklyPlan = raw.weeklyPlan;
    }
    if (
      Array.isArray(raw.gamePlan) &&
      raw.gamePlan.length === 7 &&
      raw.gamePlan.every((x) => typeof x === 'string')
    ) {
      s.gamePlan = raw.gamePlan;
    }
    if (typeof raw.waterGoal === 'number' && raw.waterGoal > 0) s.waterGoal = raw.waterGoal;
    if (raw.modelApi && typeof raw.modelApi === 'object') {
      if (typeof raw.modelApi.baseUrl === 'string') s.modelApi.baseUrl = raw.modelApi.baseUrl.trim();
      if (typeof raw.modelApi.model === 'string') s.modelApi.model = raw.modelApi.model.trim();
    }
    // 模型列表：校验 + 老配置自动迁移（只有 modelApi 没 models 时）
    s.models = normalizeModels(raw.models, s.modelApi);
    s.activeModelId = s.models.some((m) => m.id === raw.activeModelId) ? raw.activeModelId : s.models[0].id;
    // 兼容镜像：modelApi 始终指向"当前激活"的模型
    const activeModel = s.models.find((m) => m.id === s.activeModelId) || s.models[0];
    s.modelApi = { baseUrl: activeModel.baseUrl, model: activeModel.model };
    if (typeof raw.memoryEnabled === 'boolean') s.memoryEnabled = raw.memoryEnabled;
    if (typeof raw.autoMemory === 'boolean') s.autoMemory = raw.autoMemory;
    if (raw.memoryMode === 'auto' || raw.memoryMode === 'ask') s.memoryMode = raw.memoryMode;
    if (typeof raw.autoRoute === 'boolean') s.autoRoute = raw.autoRoute;
    if (typeof raw.autoManage === 'boolean') s.autoManage = raw.autoManage;
    if (Array.isArray(raw.selectedModels)) {
      s.selectedModels = raw.selectedModels
        .filter((x) => typeof x === 'string' && x)
        .slice(0, 20);
    }
    if (Array.isArray(raw.memorySeen)) {
      s.memorySeen = raw.memorySeen.filter((x) => typeof x === 'string').slice(-200);
    }
    if (raw.memoryQuota && typeof raw.memoryQuota === 'object') {
      s.memoryQuota = { hour: 0, count: 0 };
      if (typeof raw.memoryQuota.hour === 'number') s.memoryQuota.hour = raw.memoryQuota.hour;
      if (typeof raw.memoryQuota.count === 'number') s.memoryQuota.count = raw.memoryQuota.count;
    }
    if (Array.isArray(raw.memoryPending)) {
      s.memoryPending = raw.memoryPending
        .filter((p) => p && typeof p.text === 'string')
        .slice(-4)
        .map((p) => ({
          text: String(p.text).slice(0, 80),
          branch: typeof p.branch === 'string' ? p.branch : 'life',
          at: typeof p.at === 'number' ? p.at : Date.now(),
        }));
    }
    // ---- 学习通邮箱桥 ----
    if (raw.mailWatch && typeof raw.mailWatch === 'object') {
      const mw = raw.mailWatch;
      s.mailWatch = {
        enabled: mw.enabled === true,
        host: typeof mw.host === 'string' && /^[\w.-]+$/.test(mw.host) ? mw.host : 'imap.qq.com',
        user: typeof mw.user === 'string' ? mw.user.trim().slice(0, 80) : '',
        authCode: typeof mw.authCode === 'string' ? mw.authCode.trim().slice(0, 64) : '',
        lastUid: Number.isFinite(mw.lastUid) && mw.lastUid >= 0 ? Math.floor(mw.lastUid) : 0,
        lastError: typeof mw.lastError === 'string' ? mw.lastError.slice(0, 200) : '',
        lastPollAt: Number.isFinite(mw.lastPollAt) ? mw.lastPollAt : 0,
      };
    }
    // ---- 学习通直连（只读同步）----
    if (raw.xxt && typeof raw.xxt === 'object') {
      const x = raw.xxt;
      s.xxt = {
        cookie: typeof x.cookie === 'string' ? x.cookie.slice(0, 8000) : '',
        status: ['off', 'ready', 'synced', 'need_login', 'error'].includes(x.status) ? x.status : 'off',
        lastSyncAt: Number.isFinite(x.lastSyncAt) ? x.lastSyncAt : 0,
        syncMsg: typeof x.syncMsg === 'string' ? x.syncMsg.slice(0, 200) : '',
        seenIds: Array.isArray(x.seenIds) ? x.seenIds.filter((v) => typeof v === 'string').slice(-400) : [],
      };
    }
    if (Array.isArray(raw.xxtNotices)) {
      s.xxtNotices = raw.xxtNotices
        .filter((n) => n && typeof n.title === 'string' && n.title)
        .slice(-60)
        .map((n) => ({
          id: String(n.id || '').slice(0, 36),
          kind: ['homework', 'exam', 'checkin', 'grade', 'other'].includes(n.kind) ? n.kind : 'other',
          course: String(n.course || '').slice(0, 30),
          title: String(n.title).slice(0, 60),
          due: String(n.due || '').slice(0, 20),
          at: typeof n.at === 'number' ? n.at : Date.now(),
        }));
    }
    if (Array.isArray(raw.xxtHomeworks)) {
      s.xxtHomeworks = raw.xxtHomeworks
        .filter((h) => h && typeof h.title === 'string' && h.title)
        .slice(-20)
        .map((h) => ({
          id: String(h.id || '').slice(0, 36),
          status: ['new', 'drafted', 'confirmed', 'failed'].includes(h.status) ? h.status : 'new',
          course: String(h.course || '').slice(0, 30),
          title: String(h.title).slice(0, 60),
          due: String(h.due || '').slice(0, 20),
          requirement: String(h.requirement || '').slice(0, 900),
          note: String(h.note || '').slice(0, 200),
          draft: String(h.draft || '').slice(0, 4000),
          createdAt: typeof h.createdAt === 'number' ? h.createdAt : Date.now(),
          updatedAt: typeof h.updatedAt === 'number' ? h.updatedAt : Date.now(),
        }));
    }
    if (Array.isArray(raw.qqPushQueue)) {
      s.qqPushQueue = raw.qqPushQueue
        .filter((q) => q && typeof q.text === 'string' && q.text && typeof q.id === 'string')
        .slice(-10)
        .map((q) => ({
          id: String(q.id).slice(0, 36),
          text: String(q.text).slice(0, 2000),
          tag: String(q.tag || '').slice(0, 20),
          at: typeof q.at === 'number' ? q.at : Date.now(),
        }));
    }
    s.persona = normalizePersona(raw.persona);
  }
  return s;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.file = path.join(dataDir, 'db.json');
    this.db = emptyDb();
    this._lastDailyBackupDate = null;
    // 可注入，便于测试"跨天自动备份"
    this._today = () => localDateStr(new Date());
  }

  load() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.db = this._normalize(parsed);
      } catch (e) {
        // 数据文件损坏：先保留损坏文件，再重建空库，避免数据被直接覆盖
        const broken = `${this.file}.broken-${timestampStr(new Date())}`;
        try {
          fs.copyFileSync(this.file, broken);
        } catch {}
        console.error('数据文件损坏，已保留损坏副本：', broken);
        this.db = emptyDb();
        this.save();
      }
    } else {
      this.db = emptyDb();
      this.save();
      // 全新安装创建空库不占当天的备份名额：
      // 当天第一次真正写入数据时，仍会备份一次"这天的起始状态"
      this._lastDailyBackupDate = null;
    }
    return this.db;
  }

  _normalize(parsed) {
    const db = emptyDb();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      db.settings = normalizeSettings(parsed.settings);
      const d = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : {};
      for (const c of COLLECTIONS) {
        if (Array.isArray(d[c])) {
          db.data[c] = d[c].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
        }
      }
    }
    // 序号从"现有记录的最大值"和"备份里的记录值"中取较大者，避免导入后序号回退
    let maxSeq = 0;
    for (const c of COLLECTIONS) {
      for (const r of db.data[c]) {
        if (typeof r.seq === 'number' && r.seq > maxSeq) maxSeq = r.seq;
      }
    }
    const parsedSeq = typeof parsed?.seq === 'number' ? parsed.seq : 0;
    db.seq = Math.max(maxSeq, parsedSeq);
    return db;
  }

  nextSeq() {
    this.db.seq += 1;
    return this.db.seq;
  }

  _writeNow(db) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _dailyBackupIfNeeded() {
    const today = this._today();
    if (this._lastDailyBackupDate === today) return;
    this._lastDailyBackupDate = today;
    if (!fs.existsSync(this.file)) return;
    try {
      fs.copyFileSync(this.file, path.join(this.backupDir, `auto-${today}.json`));
      this._pruneBackups();
    } catch (e) {
      console.error('自动备份失败：', e);
    }
  }

  _pruneBackups() {
    try {
      const prune = (prefix, keep) => {
        const files = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(prefix)).sort();
        while (files.length > keep) {
          const f = files.shift();
          try {
            fs.unlinkSync(path.join(this.backupDir, f));
          } catch {}
        }
      };
      prune('auto-', 30);
      prune('before-', 20);
    } catch {}
  }

  save() {
    try {
      this._dailyBackupIfNeeded();
      this._writeNow(this.db);
    } catch (e) {
      console.error('写入数据文件失败：', e);
      throw e;
    }
  }

  /** 在重要操作（导入/清空）前手动留一份备份 */
  backupNow(label = 'manual') {
    if (!fs.existsSync(this.file)) return null;
    const dest = path.join(this.backupDir, `before-${label}-${timestampStr(new Date())}.json`);
    fs.copyFileSync(this.file, dest);
    this._pruneBackups();
    return dest;
  }

  replaceAll(parsed) {
    this.db = this._normalize(parsed);
    this.save();
  }

  reset() {
    this.db = emptyDb();
    this.save();
  }

  counts() {
    const out = {};
    for (const c of COLLECTIONS) out[c] = this.db.data[c].length;
    return out;
  }
}
