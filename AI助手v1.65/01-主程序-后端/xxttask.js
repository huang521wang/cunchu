/**
 * 学习通「作业详情操作」：钻进具体某份作业的详情页，读题干 / 填答案并提交。
 * 链路：课程首页找卡片 → 课程空间现签 enc → AllWork 页 → 点本任务的 inspectTask → 详情页。
 * 防呆：每一步失败都返回"卡在哪一步 + 现场截图"，绝不静默；附件/拍照类作业只读题不代交。
 * 提交前有工作台二次确认（server 端只认用户点过"确认提交"的请求）。
 */
import { parseCourseList } from './xxtsync.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** cookie 串 → Playwright addCookies 数组 */
export function cookieToWire(cookieStr) {
  return String(cookieStr || '')
    .split(';')
    .map((kv) => kv.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      if (i <= 0) return null; // 没有值或空名的残片直接丢，别注入垃圾 cookie
      return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: '.chaoxing.com', path: '/' };
    })
    .filter((c) => c && c.name && !c.name.includes('"') && !c.value.includes('"'));
}

/** 从详情页各 frame 的纯文本里提出题干（去噪 + 截断）；测试纯函数 */
export function extractTaskText(frameTexts) {
  const joined = (frameTexts || []).map((t) => String(t || '')).join('\n');
  const lines = joined.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const drop = /^(作业标题|所属课程|章节|待批|已批|未交|已交|重做|返回|收起|展开|评分|成绩|评论|附件|下载|查看原文)$/;
  const keep = lines.filter((l) => !drop.test(l) && !/^\/\//.test(l));
  return keep.join('\n').slice(0, 4000);
}

/** 判断题干文本是否是"要上传文件/拍照"类（这类不能自动提交） */
export function needsUpload(text) {
  return /上传|拍照|图片附件|附件|文件提交|\.zip|视频文件|文档.*上传|提交.{0,6}(文件|图片|照片|pdf|PPT|pptx?)/i.test(String(text || ''));
}

async function grab(page) {
  await page.waitForTimeout(3000);
  let text = '';
  try {
    for (const f of page.frames()) {
      const t = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      text += '\n' + (t || '');
    }
  } catch {
    text = await page.evaluate(() => document.body.innerText).catch(() => '');
  }
  return text;
}

/**
 * 走到某份作业的详情页。返回 { page, browser, cleanup } 或 { error, stage }。
 * taskId 是 inspectTask 的 data 属性（extId 冒号后段）。
 */
export async function openTaskPage({ chromium, cookie, course, taskId, log = () => {} }) {
  const browser = await chromium.launch({ headless: true });
  const cleanup = async () => { try { await browser.close(); } catch { /* 已关 */ } };
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    await ctx.addCookies(cookieToWire(cookie));
    const page = await ctx.newPage();

    // 1) 首页找课程卡片（按课名）
    await page.goto(`https://i.chaoxing.com/base?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    let homeHtml = '';
    for (const f of page.frames()) homeHtml += (await f.content().catch(() => '')) || '';
    const courses = parseCourseList(homeHtml);
    const hit = courses.find((c) => c.name && course && (c.name === course || c.name.includes(course) || course.includes(c.name))) || courses.find((c) => c.courseid === (course || '').split('#')[0]);
    if (!hit) { await cleanup(); return { error: `首页里没找到课程「${course}」（可能改名或不在前 20 门里）`, stage: 'course' }; }

    // 2) 进课程空间 → 现签的 AllWork 链接
    const spaceUrl = `https://mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=${hit.courseid}&clazzid=${hit.clazzid}&vc=1${hit.cpi ? `&cpi=${hit.cpi}` : ''}`;
    await page.goto(spaceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    let spaceHtml = '';
    for (const f of page.frames()) spaceHtml += (await f.content().catch(() => '')) || '';
    if (/passport/i.test(page.url())) { await cleanup(); return { error: '登录态失效，请在工作台重新连接学习通', stage: 'login' }; }
    const workM = spaceHtml.match(/data="([^"]*\/work\/getAllWork[^"]*)"/i);
    if (!workM) { await cleanup(); return { error: `这门课的空间页里没有"作业"菜单（可能没有作业区）`, stage: 'menu' }; }
    let workUrl = workM[1].replace(/&amp;/g, '&');
    if (workUrl.startsWith('//')) workUrl = 'https:' + workUrl;
    else if (workUrl.startsWith('/')) workUrl = new URL(page.url()).origin + workUrl;

    // 3) AllWork 列表 → 点本任务的 inspectTask（新窗口打开详情）
    await page.goto(workUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    const sel = `a.inspectTask[data="${taskId}"]`;
    let detail = null;
    try {
      const found = await page.waitForSelector(sel, { timeout: 12000 });
      if (!found) throw new Error('nf');
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null),
        found.click(),
      ]);
      detail = popup || page;
      await detail.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    } catch {
      await cleanup();
      return { error: `作业列表里没找到这条任务（老师可能改动或删除了它）`, stage: 'task' };
    }
    return { browser, ctx, page: detail, cleanup, log };
  } catch (e) {
    await cleanup();
    return { error: '打开作业详情失败：' + String((e && e.message) || e).slice(0, 120), stage: 'unknown' };
  }
}

/** 读题干：返回 { ok, text } */
export async function readTask({ open }) {
  try {
    const { page, cleanup } = open;
    const text = extractTaskText([await grab(page)]);
    await cleanup();
    if (text.replace(/\s/g, '').length < 8) return { ok: false, error: '详情页读不出内容（可能是空白页或纯图片题目）' };
    return { ok: true, text, upload: needsUpload(text) };
  } catch (e) {
    try { await open.cleanup(); } catch { /* 忽略 */ }
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/**
 * 提交结果判定（纯函数，可测）：必须看到明确的成功回执才算交上。
 * 两条红线：页面没写"未提交"≠成功（旧判据的假成功事故）；详情窗被关掉也不算成功——
 * 关窗的原因太多（超时/被踢/前端跳转），宁可报"未确认"让用户核对，也不冒充已交。
 */
export function judgeSubmitResult(afterText) {
  const t = String(afterText || '');
  if (/答案?不能为空|内容为空|请填写答案/.test(t)) return 'empty';
  if (/提交成功|操作成功|保存成功|已提交/.test(t)) return 'success';
  if (/提交失败|系统繁忙|网络繁忙|登录超时|登录失效|登录状态失效|会话已?过期/.test(t)) return 'failed';
  return 'unknown';
}

/**
 * 找「真正可见的」答案输入区。UEditor 类富文本页面上，隐藏的源码 textarea 在 DOM 里排最前，
 * 先抓 textarea 会把草稿写进看不见的盒子里、可见编辑器仍是空的（上晚事故）。
 * 优先级：可见的 contenteditable（富文本正文）→ 可见的 textarea（纯文本输入框）。
 */
export async function findAnswerEditor(page) {
  for (const f of page.frames()) {
    try {
      const ce = f.locator('[contenteditable="true"], [contenteditable=""]').first();
      if ((await ce.count()) && (await ce.isVisible())) return { kind: 'ce', loc: ce };
    } catch {
      /* frame 已脱离 */
    }
  }
  for (const f of page.frames()) {
    try {
      const ta = f.locator('textarea').first();
      if ((await ta.count()) && (await ta.isVisible())) return { kind: 'textarea', loc: ta };
    } catch {
      /* frame 已脱离 */
    }
  }
  return null;
}

/** 点完「提交」后，超星常弹「确认提交吗？」小窗——不点掉它这次提交根本不会发生。轮询几秒等它出现 */
export async function clickConfirmModal(page) {
  for (let i = 0; i < 7; i++) {
    await page.waitForTimeout(i ? 600 : 1300);
    for (const f of page.frames()) {
      for (const sel of ['.layui-layer-btn0', '.d_box a.red', 'a:has-text("确 定")', 'a:has-text("确定")', 'button:has-text("确定")']) {
        try {
          const btn = f.locator(sel).first();
          if ((await btn.count()) && (await btn.isVisible())) {
            await btn.click({ timeout: 4000 }).catch(() => {});
            return true;
          }
        } catch {
          /* 弹窗可能瞬间消失 */
        }
      }
    }
  }
  return false;
}

/**
 * 提交文本答案：定位可见输入区 → 填 → 写回校验 → 点提交 → 点确认弹窗 → 按回执严格判定。
 * 返回 { ok } / { ok:false, needManual } / { ok:false, unverified }；任何一步失败都带截图。
 */
export async function submitTask({ open, text }) {
  const shot = async (page) => { try { return (await page.screenshot({ type: 'png' })).toString('base64'); } catch { return ''; } };
  try {
    const { page, cleanup } = open;
    await page.waitForTimeout(2000);

    const editor = await findAnswerEditor(page);
    if (!editor) {
      const proof = await shot(page);
      await cleanup();
      return { ok: false, error: '没找到文字答案输入区（这份作业可能要求上传文件/拍照，请在详情页手动完成）', needManual: true, proof };
    }
    await editor.loc.click({ timeout: 8000 }).catch(() => {});
    // 大段文本用剪贴板式插入，比逐字 type 快且不易丢字
    const filled = await editor.loc.evaluate((el, t) => {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        set && set.set.call(el, t);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      el.focus();
      return document.execCommand('insertText', false, t);
    }, String(text)).catch(() => false);
    if (!filled) {
      const proof = await shot(page);
      await cleanup();
      return { ok: false, error: '答案写不进输入框（编辑器结构不认识），请手动粘贴提交', needManual: true, proof };
    }
    await page.waitForTimeout(400);
    // 写回校验：读回输入区里的字数。上晚就是"填"进了隐藏盒子、可见编辑器空着交白卷。
    // 阈值按草稿长度成比例（短答案也放行，一刀切 10 字会把"344毫米"这类短答误判成没填上）
    const landed = await editor.loc
      .evaluate((el) => String((el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText) || '').trim().length)
      .catch(() => 0);
    if (landed < Math.max(1, Math.floor(String(text).trim().length * 0.6))) {
      const proof = await shot(page);
      await cleanup();
      return { ok: false, error: '草稿没写进可见的答案框（读回来几乎是空的），请手动粘贴提交', needManual: true, proof };
    }

    // 点提交按钮（角色按钮 → 常见类名 → 整格文字"提 交"的链接；找不到就交人工，绝不盲点）
    let clicked = false;
    for (const f of page.frames()) {
      try {
        const btn = f.getByRole('button', { name: /提\s*交|确\s*认\s*提\s*交/ }).first();
        if (await btn.count()) { await btn.click({ timeout: 8000 }).catch(() => {}); clicked = true; break; }
        const a = f.locator('a.btn, .submit, [class*=submit]').filter({ hasText: /提交/ }).first();
        if (await a.count()) { await a.click({ timeout: 8000 }).catch(() => {}); clicked = true; break; }
        const ax = f.locator('a').filter({ hasText: /^\s*提\s*交\s*$/ }).first();
        if (await ax.count()) { await ax.click({ timeout: 8000 }).catch(() => {}); clicked = true; break; }
      } catch {
        /* frame 脱离就换下一个 */
      }
    }
    if (!clicked) {
      const proof = await shot(page);
      await cleanup();
      return { ok: false, error: '答案填好了，但没找到"提交"按钮——别担心草稿还在，去详情页点一下提交就行', needManual: true, proof };
    }
    await clickConfirmModal(page); // 超星的"确认提交吗"弹窗——不点等于没交
    await page.waitForTimeout(1500);

    let closed = false;
    try {
      closed = page.isClosed ? page.isClosed() : false;
    } catch {
      closed = true;
    }
    const after = closed ? '' : await grab(page);
    const proof = closed ? '' : await shot(page);
    await cleanup();
    const verdict = judgeSubmitResult(after);
    if (verdict === 'success') return { ok: true, proof };
    if (verdict === 'empty') return { ok: false, needManual: true, proof, error: '学习通提示答案是空的——草稿没真正填进去，去详情页手动粘贴提交（截图已留证）' };
    if (verdict === 'failed') return { ok: false, proof, error: '提交被学习通拒绝，页面有失败提示（截图已留证，草稿还在可重试）' };
    return { ok: false, unverified: true, proof, error: '点了提交但没看到成功回执——先别重复提交，去 APP 里核对这份交了没有（截图已留证）' };
  } catch (e) {
    try { await open.cleanup(); } catch { /* 忽略 */ }
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}
