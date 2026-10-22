import { addDays, today, weekdayIndex } from './date';

export interface ParsedStudy {
  title: string;
  course: string;
  kind: '作业' | '考试' | '复习' | '其他';
  due: string;
}

const WEEKDAY_MAP: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function detectKind(line: string): ParsedStudy['kind'] {
  if (/考试|测验|期中|期末|测试/.test(line)) return '考试';
  if (/复习/.test(line)) return '复习';
  return '作业';
}

/** 从一行文字里找日期（找到就从文字里去掉），支持：2026-10-25 / 10月25日 / 10-25 / 明天 / 下周一 */
function extractDue(line: string, ref: string): { due: string; rest: string } {
  let due = '';
  let rest = line;
  let m: RegExpMatchArray | null;

  if ((m = rest.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/))) {
    due = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
    rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/(\d{1,2})[-/.月](\d{1,2})日?(?![题页])/))) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      due = `${ref.slice(0, 4)}-${pad(mo)}-${pad(d)}`;
      rest = rest.replace(m[0], ' ');
    }
  }

  if (!due) {
    if ((m = rest.match(/(大后天|后天|明天|明日|今天)/))) {
      const off =
        m[1] === '今天' ? 0 : m[1] === '明天' || m[1] === '明日' ? 1 : m[1] === '后天' ? 2 : 3;
      due = addDays(ref, off);
      rest = rest.replace(m[0], ' ');
    } else if ((m = rest.match(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/))) {
      const w = WEEKDAY_MAP[m[2]];
      let delta = (w - weekdayIndex(ref) + 7) % 7;
      if (m[1]) delta += 7;
      due = addDays(ref, delta);
      rest = rest.replace(m[0], ' ');
    }
  }
  return { due, rest };
}

/**
 * 把用户自己复制来的文本（每行一条）解析成学习任务。
 * 完全本地处理：不联网、不登录、不接触任何平台数据。
 */
export function parseStudyText(text: string, ref = today()): ParsedStudy[] {
  const out: ParsedStudy[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    let course = '';
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^[【\[]([^】\]]{1,16})[】\]]\s*/))) {
      course = m[1].trim();
      line = line.slice(m[0].length);
    } else if ((m = line.match(/^#(\S{1,16})\s+/))) {
      course = m[1];
      line = line.slice(m[0].length);
    } else if (/[|｜\t]/.test(line)) {
      const segs = line
        .split(/[|｜\t]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (segs.length >= 2 && segs[0].length <= 16) {
        course = segs[0];
        line = segs.slice(1).join(' ');
      }
    }

    const kind = detectKind(raw);
    const { due, rest } = extractDue(line, ref);
    const hadDeadlineWord = /截止|最晚|截止时间/.test(raw);
    let title = rest;
    if (hadDeadlineWord) title = title.replace(/截止(时间)?[:：]?/g, ' ');
    if (due || hadDeadlineWord) title = title.replace(/(\d{1,2})[:：]\d{2}(?::\d{2})?/g, ' ');
    title = title
      .replace(/\s+/g, ' ')
      .replace(/^\s*的+/, '')
      .replace(/^[\s\-—–~～:：,，.。|｜]+|[\s\-—–~～:：,，.。|｜]+$/g, '')
      .trim();
    if (!title) title = raw.trim();
    if (!title) continue;
    out.push({ title, course, kind, due });
  }
  return out;
}
