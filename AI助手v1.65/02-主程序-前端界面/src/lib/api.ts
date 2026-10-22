import type { AllData, Settings } from '../types';

export const PIN_KEY = 'workbench-pin';

/** 局域网访问时服务端要求口令（401 needPin / 429 锁定），由解锁页负责输入 */
export class NeedPinError extends Error {
  constructor(message = '需要访问口令') {
    super(message);
    this.name = 'NeedPinError';
  }
}

/** 所有请求都带上口令（在本机访问时服务端不用口令，带了也无妨） */
export function pinHeaders(base?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = { ...((base as Record<string, string>) || {}) };
  const pin = typeof localStorage !== 'undefined' ? localStorage.getItem(PIN_KEY) : '';
  if (pin) headers['x-workbench-pin'] = pin;
  return headers;
}

/** 统一请求入口：自动带口令 + 识别"需要口令"（401）和"口令错太多次被锁"（429） */
export async function pFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, headers: pinHeaders(init?.headers) });
  if (res.status === 401 || res.status === 429) {
    let body: { needPin?: boolean; error?: string } | null = null;
    try {
      body = await res.clone().json();
    } catch {
      // 不是 JSON 就当普通失败
    }
    if (body && body.needPin) throw new NeedPinError(body.error || '需要访问口令');
  }
  return res;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const b = await res.json();
      if (b && b.error) msg = b.error;
    } catch {
      // 忽略解析失败，用默认提示
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export interface MetaInfo {
  dataDir: string;
  dbFile: string;
  size: number;
  updatedAt: string | null;
  backupCount: number;
}

export const api = {
  all: () => pFetch('/api/all').then(j<{ data: AllData; settings: Settings }>),
  create: (c: string, item: Record<string, unknown>) => pFetch(`/api/${c}`, jsonInit('POST', item)).then(j<any>),
  update: (c: string, id: string, patch: Record<string, unknown>) =>
    pFetch(`/api/${c}/${id}`, jsonInit('PATCH', patch)).then(j<any>),
  remove: (c: string, id: string) => pFetch(`/api/${c}/${id}`, jsonInit('DELETE', {})).then(j<{ ok: true }>),
  settings: (patch: Partial<Settings>) => pFetch('/api/settings', jsonInit('PUT', patch)).then(j<Settings>),
  meta: () => pFetch('/api/meta').then(j<MetaInfo>),
  exportAll: () => pFetch('/api/export').then(j<Record<string, unknown>>),
  importAll: (backup: unknown) =>
    pFetch('/api/import', jsonInit('POST', backup)).then(j<{ ok: true; counts: Record<string, number> }>),
  wipe: (confirm: string) => pFetch('/api/wipe', jsonInit('POST', { confirm })).then(j<{ ok: true }>),
  reveal: () => pFetch('/api/reveal-data-folder', jsonInit('POST', {})).then(j<{ ok: true }>),
};
