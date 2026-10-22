/**
 * 学习通邮件通知解析（纯函数，无网络、可测试、零第三方）
 * 只处理"学习通发到你自己邮箱的通知"——官方通道，不碰学习通账号。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 是否像学习通的通知邮件 */
export function looksLikeXxt(from, subject, text) {
  const s = `${from} ${subject} ${text}`;
  return /chaoxing\.com|xiaoying\.com|学习通|课程通知/i.test(s);
}

/** 从"10月24日""2026年10月24日 23:59""10.24前"提取日期 → YYYY-MM-DD */
export function parseDueDate(raw) {
  if (!raw) return '';
  let m = String(raw).match(/(20\d{2})[年.\-/](\d{1,2})[月.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = String(raw).match(/(\d{1,2})[月.\-/](\d{1,2})(?!\d)/);
  if (m) {
    const now = new Date();
    let y = now.getFullYear();
    // 只写"月日"时：比今天早的就是明年
    const mm = +m[1];
    const dd = +m[2];
    if (mm < now.getMonth() + 1 || (mm === now.getMonth() + 1 && dd < now.getDate())) y += 1;
    return `${y}-${pad(mm)}-${pad(dd)}`;
  }
  return '';
}

/** 提取课程名：【高数】/《高等数学》/课程名称：xxx */
export function parseCourse(subject, text) {
  const all = `${subject} ${text}`;
  let m = all.match(/【([^】]{2,20})】/);
  if (m) return m[1].trim();
  m = all.match(/《([^》]{2,20})》/);
  if (m) return m[1].trim();
  m = all.match(/课程名[称字]?\s*[：:]\s*([^\s，。;；]{2,20})/);
  if (m) return m[1].trim();
  return '';
}

/** 把邮件解析成结构化通知 */
export function parseXxtNotice({ from = '', subject = '', text = '' }) {
  const s = `${subject} ${text}`;
  let kind = 'other';
  // 顺序：作业优先（"跑步打卡"这类作业正文常含"打卡/签到"字样），纯签到其次
  if (/作业/.test(s)) kind = 'homework';
  else if (/签到/.test(s)) kind = 'checkin';
  else if (/考试|测验/.test(s)) kind = 'exam';
  else if (/成绩/.test(s)) kind = 'grade';
  const course = parseCourse(subject, text);
  // 标题：去掉常见前后缀，保留信息本体
  let title = String(subject)
    .replace(/^【[^】]*】/, '')
    .replace(/(的通知|提醒|催办|催交)$/g, '')
    .trim();
  if (!title) title = String(text).slice(0, 50).replace(/\s+/g, ' ').trim();
  title = title.slice(0, 60) || '学习通通知';
  // 截止时间：整段文本里找"截止/交/前"附近的日期
  const dueZone = (s.match(/(截止|交作业|提交|之前|前)[^。;]{0,30}/) || [''])[0] || s;
  const due = parseDueDate(dueZone) || parseDueDate(s);
  // 老师的具体要求（正文里引号/书名号之外，截一段作需求原文）
  const requirement = String(text).replace(/\s+/g, ' ').trim().slice(0, 800);
  return { kind, course, title, due, requirement, from: String(from).slice(0, 80) };
}

/** 通知 → 给人看的一句话 */
export function noticeToLine(n) {
  const label = { homework: '作业', exam: '考试', checkin: '签到', grade: '成绩', other: '通知' }[n.kind] || '通知';
  const c = n.course ? `《${n.course}》` : '';
  const d = n.due ? `，截止 ${n.due}` : '';
  return `学习通·${label}：${c}${n.title}${d}`;
}

/** 大专生语料的作业草稿提示词（严格按老师要求 + 去 AI 话术；不套人设壳——人设腔会漏进正文） */
export function buildDraftPrompt(persona, notice) {
  void persona;
  return [
    '把下面这份学习通作业做出来。严格按老师要求执行：题目、字数、格式、内容范围，让做什么就做什么，不超额发挥。',
    '【硬性文风】普通大专学生的口吻：',
    '- 句子短、口语自然，允许"我觉得""大概""应该是"这类说法',
    '- 禁用：「首先/其次/最后/综上所述/值得注意的是/总而言之/深入探讨/在当今社会/赋能/抓手/闭环/不仅…而且…」等 AI 腔和排比',
    '- 段落长短不齐，不用 markdown 标题、不用列表符号，就像学生手打在输入框里那样',
    '- 不编造数据、引用和名人名言；没把握的就写"据我了解"',
    '只输出作业正文本身。禁止开场白、结束语、解释、emoji、角色扮演、称呼同学或自称——第一句就是作业内容。',
    '---',
    `课程：${notice.course || '（未知）'}`,
    `作业题目：${notice.title}`,
    `截止时间：${notice.due || '（老师没写明）'}`,
    `老师原文：${notice.requirement || '（无更多细节）'}`,
  ].join('\n');
}

/** 从截图文字（OCR 结果）里猜作业标题/内容：取含关键词的一行 */
export function pickTitleLine(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const hit = lines.find((l) => /作业|考试|测验|签到|截止|提交/.test(l)) || lines[0] || '';
  return hit.slice(0, 60);
}

/**
 * 把一段"截图读出来的文字"整理成通知（视觉模型/OCR 的输出格式五花八门）。
 * 规则先行（不依赖模型），标题取最有信息量的一行。
 */
export function noticeFromPlainText(text) {
  const t = String(text || '');
  const s = t.replace(/\s+/g, ' ');
  let kind = 'other';
  if (/作业/.test(s)) kind = 'homework';
  else if (/签到/.test(s)) kind = 'checkin';
  else if (/考试|测验/.test(s)) kind = 'exam';
  else if (/成绩/.test(s)) kind = 'grade';
  const course = parseCourse('', t) || parseCourse(pickTitleLine(t), '');
  let due = parseDueDate((s.match(/(截止|之前|前)[^。;]{0,30}/) || [''])[0]) || parseDueDate(s);
  if (kind !== 'homework' && kind !== 'exam') due = due || '';
  const title = pickTitleLine(t) || '学习通截图通知';
  const requirement = t.replace(/\s+/g, ' ').trim().slice(0, 800);
  return { kind, course, title: title.slice(0, 60), due, requirement, from: 'screenshot' };
}

/** 日志脱敏：授权码等敏感值不入库不进日志 */
export function redact(s, secrets = []) {
  let out = String(s == null ? '' : s);
  for (const sec of secrets) {
    const t = String(sec || '');
    if (t.length >= 4) out = out.split(t).join('****');
  }
  return out;
}
