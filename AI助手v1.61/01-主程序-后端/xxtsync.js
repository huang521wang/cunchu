/**
 * 学习通「直连同步」引擎（方案 A）：登录态只读拉取——看自己的课、自己的作业，
 * 只读不写：不提交、不签到、不刷课、不对抗检测；低频 + 随机抖动 + 异常熔断。
 * fetchImpl 可注入：生产用 global fetch（带 Cookie），测试注入假页面。
 */
import { parseDueDate } from './xuexitong.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 900 + Math.floor(Math.random() * 1800);

/**
 * 首页课程卡解析：抓 courseid + clazzid + 课程名 + cpi。
 * 真实页面每门课两张卡：封面图 <a>（无标题）和文字 <a title="课名">（同 id 两张先后出现）。
 * 旧实现按"撞见哪个算哪个"配 ±600 字启发式找名字，图卡在前时会抓到"退课"按钮/老师名
 * （实测事故）。现在：只看 <a> 标签自己的 title/内文取名，同 id 后出现的卡补名，
 * 非 <a> 上下文的课程对只作兜底（保留老启发式）。
 */
export function parseCourseList(html) {
  const texts = String(html || '');
  const byKey = new Map();
  const badName = (s) => !s || /退课|javascript|function|var |quit/i.test(s);
  let m;
  const cardRx = /<a[^>]*courseid=(\d+)[^"'>]{0,120}?c(?:lass|lazz)id=(\d+)[^>]*>([\s\S]{0,80})<\/a>/gi;
  while ((m = cardRx.exec(texts)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    const tag = m[0];
    let name = tag.match(/title="([^"<>]{2,40})"/)?.[1] || '';
    if (badName(name)) name = '';
    if (!name) {
      const inner = (m[3] || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      if (inner.length >= 2 && inner.length <= 40 && !badName(inner) && !/[{};=<>]/.test(inner)) name = inner;
    }
    const cpi = tag.match(/cpi=(\d+)/i)?.[1] || '';
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { courseid: m[1], clazzid: m[2], name, cpi });
    else {
      if (!cur.name && name) cur.name = name; // 图卡在前、文字卡在后 → 补名
      if (!cur.cpi && cpi) cur.cpi = cpi;
    }
  }
  // 兜底：<a> 之外的课程对（老结构/跳转脚本），沿用就近启发式但拒绝坏名
  const rx = /courseid=(\d+)[^"'\s>]{0,80}?c(?:lass|lazz)id=(\d+)[^"'\s>]*/gi;
  while ((m = rx.exec(texts)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { courseid: m[1], clazzid: m[2], name: '', cpi: '' });
    const around = texts.slice(Math.max(0, m.index - 600), m.index + 600);
    const cands = [...around.matchAll(/(?:title|alt)="([^"<>]{2,40})"/g)].map((x) => x[1]).filter((s) => !badName(s));
    const cur = byKey.get(key);
    cur.name = cands[0] || `课程 ${m[1]}`;
    cur.cpi = around.match(/cpi=(\d+)/i)?.[1] || '';
  }
  return [...byKey.values()].map((c) => ({ ...c, name: (c.name || `课程 ${c.courseid}`).replace(/\s+/g, ' ').trim().slice(0, 40) }));
}

/**
 * 从课程空间页抽「作业/考试」菜单链接。超星真链接不在 <a href> 里（href 是 javascript:;），
 * 而是 data="/work/getAllWork?...enc=签名" 属性——enc 是从空间页现签的，拼裸 URL 会被
 * 判"无权限的操作"（旧版直接拼 mooc2/work/list 就是这样全军覆没的）。
 */
export function parseTaskMenuLinks(html, pageUrl) {
  let origin = 'https://mooc1-2.chaoxing.com';
  try { origin = new URL(String(pageUrl || '')).origin || origin; } catch {}
  const abs = (p) => (!p ? null : /^https?:/i.test(p) ? p : /^\/\//.test(p) ? 'https:' + p : origin + p);
  const fix = (m) => (m ? m[1].replace(/&amp;/g, '&') : null);
  // data 值可能是 "/path"、"//host/path" 或全 URL——三种写法都从中间抽出目标路径
  return {
    work: abs(fix(html.match(/data="([^"]*\/work\/getAllWork[^"]*)"/i))),
    exam: abs(fix(html.match(/data="([^"]*\/exam-ans\/exam\/test[^"]*)"/i))),
  };
}

/**
 * 作业/考试列表页解析：标题 + 截止时间 + 稳定 id（用于永久去重）。
 * 兼容三种结构：mooc2 旧卡片 coltitle / getAllWork 的 titTxt+a.inspectTask（实测主格式）/
 * 卡片块 data="6,截止时间"。
 */
export function parseTaskList(html, kind) {
  const rows = [];
  const texts = String(html || '');
  const seenExt = new Set();
  const push = (r) => {
    const key = r.extId || `${kind}:${r.title}`;
    if (seenExt.has(key)) return;
    seenExt.add(key);
    rows.push(r);
  };
  // 结构一：旧作业卡片（coltitle 标题 + "截止时间"）
  const blockRx = /<li[\s\S]*?<\/li>/gi;
  let m;
  while ((m = blockRx.exec(texts)) !== null) {
    const block = m[0];
    const title = block.match(/class="[^"]*(?:coltitle|overHidden2|wordLimit)[^"]*"[^>]*>\s*([^<]{2,80})/i);
    if (!title) continue;
    const due = parseDueDate(block.replace(/<[^>]+>/g, ' ').match(/(截止时间|定时间|截止)[：:]?\s*([\d年月日.\-: ]{4,24})/i)?.[0] || '');
    const idm = block.match(/(?:id|workId|data-id|encId)=["']?([\w-]{3,40})/i);
    push({ kind, title: title[1].replace(/\s+/g, ' ').trim().slice(0, 60), due, extId: idm ? `${kind}:${idm[1]}` : '' });
  }
  // 结构二（实测 2025+ getAllWork / exam-test）：a.inspectTask 标题 + data 属性 id + 块内"截止时间"
  const tagRx = /<a[^>]*class="inspectTask"[^>]*>/gi;
  while ((m = tagRx.exec(texts)) !== null) {
    const tag = m[0];
    const title = tag.match(/title="([^"]{2,80})"/);
    if (!title) continue;
    const idm = tag.match(/\sdata="(\d{3,})"/);
    // 条目上下文：从标题 tag 往后看 500 字，抓"截止时间"
    const around = texts.slice(m.index, m.index + 500).replace(/<[^>]+>/g, ' ');
    const due = parseDueDate(around.match(/(截止时间|结束时间|截止)[：:]?\s*([\d年月日.\-: ]{4,24})/i)?.[0] || '');
    push({
      kind,
      title: title[1].replace(/\s+/g, ' ').trim().slice(0, 60),
      due,
      extId: idm ? `${kind}:${idm[1]}` : '',
    });
  }
  return rows;
}

/**
 * 一轮同步：课程列表 → 逐课程拉作业/考试列表 → 新条目交给 onItem。
 * 返回 { ok, status: 'synced'|'need_login'|'error', newCount, courses, error }
 */
export async function syncXxt({ cookie, fetchImpl = fetch, loadPage, onItem, maxCourses = 20, base = 'https://i.chaoxing.com' }) {
  const call = async (url) =>
    fetchImpl(url, {
      headers: { Cookie: cookie || '', 'User-Agent': UA, Referer: base + '/' },
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  // 页面加载器：生产环境注入无头浏览器的 loadPage（新版学习通是 JS 渲染，必须真实浏览器）；
  // 未注入时退回普通 fetch（单测、无 playwright 的机器）
  const getPage =
    loadPage ||
    (async (url) => {
      const r = await call(url);
      const loc = (r.headers && r.headers.get('location')) || '';
      if (r.status >= 300 && r.status < 400) return { html: '', finalUrl: loc, status: r.status };
      if (!r.ok) return { html: '', finalUrl: url, status: r.status };
      return { html: await r.text().catch(() => ''), finalUrl: url, status: 200 };
    });

  let home;
  try {
    home = await getPage(`${base}/base?t=${Date.now()}`);
  } catch (e) {
    return { ok: false, status: 'error', newCount: 0, courses: 0, error: '网络不通：' + ((e && e.message) || e) };
  }
  if (/passport|login/i.test(String(home.finalUrl || ''))) {
    return { ok: false, status: 'need_login', newCount: 0, courses: 0, error: '登录态失效，需要重新扫码/登录' };
  }
  if (home.status === 403) {
    return { ok: false, status: 'need_login', newCount: 0, courses: 0, error: 'HTTP 403：登录态可能失效' };
  }
  if (home.status >= 400) {
    return { ok: false, status: 'error', newCount: 0, courses: 0, error: `HTTP ${home.status}` };
  }
  if (/扫码登录|请登录/.test(home.html) && !/courseid=/i.test(home.html)) {
    return { ok: false, status: 'need_login', newCount: 0, courses: 0, error: '页面要求重新登录' };
  }

  const courses = parseCourseList(home.html).slice(0, maxCourses);
  let newCount = 0;
  const fails = []; // 静默吞错是事故之源：哪门课哪个环节坏了，要能说出口
  for (const c of courses) {
    await sleep(jitter()); // 低频 + 抖动：不轰炸接口
    // 第一步：进课程空间，现签的 enc 任务链接只在这里能拿到
    let menu = { work: null, exam: null };
    const spaceUrl = `https://mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=${c.courseid}&clazzid=${c.clazzid}&vc=1${c.cpi ? `&cpi=${c.cpi}` : ''}`;
    try {
      const space = await getPage(spaceUrl);
      if (/passport|login/i.test(String(space.finalUrl || ''))) {
        return { ok: false, status: 'need_login', newCount, courses: courses.length, error: '登录态中途失效，需重新连接' };
      }
      menu = parseTaskMenuLinks(space.html || '', space.finalUrl || spaceUrl);
    } catch (e) {
      fails.push(`${c.name}(空间页)`);
      continue;
    }
    if (!menu.work && !menu.exam) {
      fails.push(`${c.name}(无任务菜单)`);
      continue;
    }
    for (const [url, kind] of [[menu.work, 'homework'], [menu.exam, 'exam']]) {
      if (!url) continue;
      try {
        const p = await getPage(url);
        if ((p.html || '').includes('无权限')) {
          fails.push(`${c.name}(${kind === 'homework' ? '作业' : '考试'}:无权限)`);
          continue;
        }
        const items = parseTaskList(p.html || '', kind);
        for (const it of items) {
          const added = await onItem({
            kind,
            course: c.name,
            title: it.title,
            due: it.due,
            requirement: `${c.name}·${kind === 'homework' ? '作业' : '考试'}「${it.title}」${it.due ? '，截止 ' + it.due : ''}`,
            extId: it.extId,
          });
          if (added) newCount += 1;
        }
      } catch {
        fails.push(`${c.name}(${kind === 'homework' ? '作业页' : '考试页'})`);
      }
    }
  }
  return { ok: true, status: 'synced', newCount, courses: courses.length, fails, error: '' };
}
