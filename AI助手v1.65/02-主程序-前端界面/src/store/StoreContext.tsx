import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, NeedPinError } from '../lib/api';
import type { AllData, CollectionName, Settings } from '../types';

export interface StoreApi {
  data: AllData;
  settings: Settings;
  ready: boolean;
  /** 手机等局域网设备首次访问时，服务端要求输入访问口令 */
  needPin: boolean;
  savedAt: Date | null;
  create: (c: CollectionName, item: Record<string, unknown>) => Promise<any>;
  update: (c: CollectionName, id: string, patch: Record<string, unknown>) => Promise<any>;
  remove: (c: CollectionName, id: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  reload: () => Promise<void>;
}

const EMPTY_DATA: AllData = {
  tasks: [],
  memos: [],
  memories: [],
  chatMessages: [],
  studyItems: [],
  lessonNotes: [],
  files: [],
  documents: [],
  ideas: [],
  contentItems: [],
  publishStats: [],
  projects: [],
  projectTasks: [],
  devLogs: [],
  clients: [],
  followUps: [],
  commLogs: [],
  timeEntries: [],
  workoutLogs: [],
  weightLogs: [],
  mealDays: [],
  gameItems: [],
  playLogs: [],
};

const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  platforms: ['小红书', '抖音', 'B站', '公众号', '其他'],
  weeklyPlan: ['休息', '休息', '休息', '休息', '休息', '休息', '休息'],
  gamePlan: ['休息', '休息', '休息', '休息', '休息', '休息', '休息'],
  waterGoal: 8,
  modelApi: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'deepseek-r1-7b' },
  models: [
    {
      id: 'local-r1-7b',
      name: '本机 · DeepSeek-R1-7B',
      type: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'deepseek-r1-7b',
      apiKey: '',
      note: '免费离线 · 约 36 字/秒',
    },
  ],
  activeModelId: 'local-r1-7b',
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
  },
  memoryEnabled: true,
};

const StoreContext = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AllData>(EMPTY_DATA);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [needPin, setNeedPin] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.all();
      setData(r.data);
      setSettings(r.settings);
      setReady(true);
      setNeedPin(false);
    } catch (e) {
      if (e instanceof NeedPinError) {
        setNeedPin(true);
        // 继续抛出，让"输口令"的界面知道口令不对
      }
      throw e;
    }
  }, []);

  useEffect(() => {
    reload().catch((e) => console.error('加载数据失败：', e));
  }, [reload]);

  const create = useCallback(async (c: CollectionName, item: Record<string, unknown>) => {
    const created = await api.create(c, item);
    setData((prev) => ({ ...prev, [c]: [...(prev[c] as unknown[]), created] }) as AllData);
    setSavedAt(new Date());
    return created;
  }, []);

  const update = useCallback(async (c: CollectionName, id: string, patch: Record<string, unknown>) => {
    const updated = await api.update(c, id, patch);
    setData(
      (prev) =>
        ({
          ...prev,
          [c]: (prev[c] as any[]).map((x) => (x.id === id ? updated : x)),
        }) as AllData,
    );
    setSavedAt(new Date());
    return updated;
  }, []);

  const remove = useCallback(async (c: CollectionName, id: string) => {
    await api.remove(c, id);
    setData((prev) => ({ ...prev, [c]: (prev[c] as any[]).filter((x) => x.id !== id) }) as AllData);
    setSavedAt(new Date());
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    // 先立即生效（开关/主题点下去马上有反应），再落盘
    setSettings((prev) => ({ ...prev, ...patch }));
    const s = await api.settings(patch);
    setSettings(s);
    setSavedAt(new Date());
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  const value: StoreApi = { data, settings, ready, needPin, savedAt, create, update, remove, updateSettings, reload };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
