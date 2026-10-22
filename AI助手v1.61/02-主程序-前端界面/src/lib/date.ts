export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return dateStr(new Date());
}

/** 时间戳（ISO 字符串）换算成本机日期 YYYY-MM-DD */
export function localDay(iso: string): string {
  return dateStr(new Date(iso));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateStr(d);
}

/** 0 = 周一 … 6 = 周日 */
export function weekdayIndex(date: string): number {
  const d = new Date(`${date}T00:00:00`);
  return (d.getDay() + 6) % 7;
}

export function fmtMD(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function fmtCN(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[weekdayIndex(date)]}`;
}

export function fmtTime(v: string | Date): string {
  const d = typeof v === 'string' ? new Date(v) : v;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本周一 ~ 本周日（含） */
export function weekRange(ref = today()): { start: string; end: string } {
  const idx = weekdayIndex(ref);
  const start = addDays(ref, -idx);
  return { start, end: addDays(start, 6) };
}

/** 当前月份 YYYY-MM */
export function monthStr(ref = today()): string {
  return ref.slice(0, 7);
}

export function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}
