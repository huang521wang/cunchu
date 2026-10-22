import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { today, weekdayIndex, addDays, fmtCN, fmtTime, localDay } from '../lib/date';
import type { MealDay, PageKey } from '../types';
import { Modal, Toast } from '../components/common';
import MemoryTree from '../components/MemoryTree';
import Materials from '../components/Materials';
import PersonaCard from '../components/PersonaCard';
import ScreenTab from '../components/ScreenTab';
import Today from './Today';
import Study from './Study';
import Fitness from './Fitness';
import Diet from './Diet';
import Games from './Games';
import Media from './Media';
import Dev from './Dev';
import Consulting from './Consulting';
import Design from './Design';
import Home from './Home';
import SettingsPage from './Settings';
import { BRANCHES } from '../lib/branches';
import type { BranchKey } from '../lib/branches';
import { parseStudyText } from '../lib/parseStudy';
import { pFetch } from '../lib/api';

type ActionKey = 'task' | 'study' | 'memo' | 'workout' | 'weight' | 'hours' | 'idea' | 'meal' | 'playtime';

/** 工具箱标签：全部功能都收纳在这里（v3：没有左侧导航了） */
type ToolKey =
  | 'overview'
  | 'today'
  | 'study'
  | 'fitness'
  | 'diet'
  | 'games'
  | 'media'
  | 'dev'
  | 'consulting'
  | 'design'
  | 'materials'
  | 'memory'
  | 'screen'
  | 'settings';

const ACTIONS: { key: ActionKey; icon: string; label: string; target: PageKey; targetName: string }[] = [
  { key: 'task', icon: '📋', label: '加任务', target: 'today', targetName: '今日计划' },
  { key: 'study', icon: '📚', label: '加作业', target: 'study', targetName: '学习计划' },
  { key: 'memo', icon: '✎', label: '记备忘', target: 'home', targetName: '快速备忘' },
  { key: 'workout', icon: '🏋️', label: '健身打卡', target: 'fitness', targetName: '健身计划' },
  { key: 'weight', icon: '⚖️', label: '记体重', target: 'fitness', targetName: '健身计划' },
  { key: 'hours', icon: '⏱', label: '记工时', target: 'consulting', targetName: '咨询工作' },
  { key: 'idea', icon: '💡', label: '加自媒体想法', target: 'media', targetName: '自媒体灵感库' },
  { key: 'meal', icon: '🍚', label: '记饮食', target: 'diet', targetName: '饮食计划' },
  { key: 'playtime', icon: '🎮', label: '记游戏时长', target: 'games', targetName: '游戏娱乐' },
];

const MODAL_TITLES: Record<ActionKey, string> = {
  task: '加一条任务',
  study: '加一条学习任务',
  memo: '记一条备忘',
  workout: '今天练完了？',
  weight: '记今天的体重',
  hours: '记一笔工时',
  idea: '记一个灵感',
  meal: '记一顿饭',
  playtime: '记一段游玩时长',
};

interface ModelStatus {
  online: boolean;
  baseUrl: string;
  model: string;
  name?: string;
}

/** 对话里识别出来的"要执行的动作"（前端规则识别，稳定可靠，不依赖模型能力） */
type PendingAction =
  | { kind: 'memory'; text: string }
  | { kind: 'kb'; text: string }
  | { kind: 'task'; text: string; date: string }
  | { kind: 'study'; text: string; course: string; due: string; itemKind: '作业' | '考试' | '复习' | '其他' }
  | { kind: 'memo'; text: string }
  | { kind: 'workout'; note: string }
  | { kind: 'weight'; value: string }
  | { kind: 'meal'; slot: 'breakfast' | 'lunch' | 'dinner' | 'snack'; text: string };

const MEAL_SLOT_LABEL: Record<'breakfast' | 'lunch' | 'dinner' | 'snack', string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

/* ---- 发图给柳月虹看：本地读像素（不上传任何服务），拼一句诚实的"印象" ---- */

function hueBucket(h: number): string {
  if (h < 15 || h >= 345) return '红色系';
  if (h < 45) return '橙色系';
  if (h < 70) return '黄色系';
  if (h < 160) return '绿色系';
  if (h < 200) return '青色系';
  if (h < 260) return '蓝色系';
  if (h < 300) return '紫色系';
  return '粉色系';
}

async function imageStats(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('读不了这张图'));
      img.src = url;
    });
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(img, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    r /= n;
    g /= n;
    b /= n;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    let s = 0;
    let h = 0;
    if (max !== min) {
      const delta = max - min;
      s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
      if (max === r / 255) h = 60 * (((g / 255 - b / 255) / delta) % 6);
      else if (max === g / 255) h = 60 * ((b / 255 - r / 255) / delta + 2);
      else h = 60 * ((r / 255 - g / 255) / delta + 4);
      if (h < 0) h += 360;
    }
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      hue: s < 0.12 ? '中性色' : hueBucket(h),
      warmth: r - b > 12 ? '暖' : b - r > 12 ? '冷' : '中性',
      brightness: l > 0.7 ? '高' : l < 0.35 ? '低' : '中等',
      vivid: s > 0.5 ? '鲜艳' : '柔和',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function impressionText(stats: {
  w: number;
  h: number;
  hue: string;
  warmth: string;
  brightness: string;
  vivid: string;
}): string {
  const warm = stats.warmth === '暖' ? '、暖洋洋的' : stats.warmth === '冷' ? '、清清爽爽的' : '';
  const bright = stats.brightness === '高' ? '、亮亮的' : stats.brightness === '低' ? '、暗暗的' : '';
  return `我发了一张图给你看（${stats.w}×${stats.h}）。我替你读了一下它的像素：主色调偏${stats.hue}${warm}${bright}，颜色偏${stats.vivid}。请按你的人设回应我：诚实地说你还没有真正的眼睛，再描述这张图给你的感觉。`;
}

function detectAction(text: string, day: string): PendingAction | null {  const t = text.trim();
  let m: RegExpMatchArray | null;
  if (
    (m = t.match(/^(?:请)?(?:帮我)?(?:加|添加|新增|新建|记)(?:一[条个])?(?:个)?任务[：:，,\s]*(.+)$/)) ||
    (m = t.match(/^(?:待办|任务)[：:，,\s]*(.+)$/))
  ) {
    return { kind: 'task', text: m[1].trim(), date: day };
  }
  if ((m = t.match(/^(?:请)?(?:帮我)?(?:记|加|添加)(?:一[条个])?备忘[：:，,\s]*(.+)$/)) || (m = t.match(/^备忘[：:，,\s]*(.+)$/))) {
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
  // 「加考试：xxx」「加作业：下周一 高数第三章」——用本地解析器把日期/科目拆出来
  let rest: string | null = null;
  let itemKind: '作业' | '考试' = '作业';
  if (
    (m = t.match(/^(?:请)?(?:帮我)?(?:加|添加|新增|新建|记)(?:一[条个])?(?:个)?考试[：:，,\s]*(.+)$/)) ||
    (m = t.match(/^考试[：:，,\s]*(.+)$/))
  ) {
    rest = m[1];
    itemKind = '考试';
  } else if (
    (m = t.match(/^(?:请)?(?:帮我)?(?:加|添加|新增|新建|记)(?:一[条个])?(?:个)?(?:作业|学习任务)[：:，,\s]*(.+)$/)) ||
    (m = t.match(/^(?:作业|学习任务)[：:，,\s]*(.+)$/))
  ) {
    rest = m[1];
  }
  if (rest !== null && rest.trim()) {
    const p = parseStudyText(rest.trim(), day)[0];
    return {
      kind: 'study',
      text: p ? p.title : rest.trim(),
      course: p ? p.course : '',
      due: p ? p.due : '',
      itemKind,
    };
  }
  const kbM =
    t.match(/^(?:请)?(?:帮我)?(?:记|存|加)(?:入|进|到)?知识(?:库)?[：:，,\s]*(.+)$/) || t.match(/^知识[：:]\s*(.+)$/);
  if (kbM) {
    return { kind: 'kb', text: kbM[1].trim() };
  }
  if (/记住|记一下|帮我记着|记着点/.test(t)) {
    const cleaned = t.replace(/^.*?(记住|记一下|帮我记着|记着点)[：:，,、\s]*/, '').trim();
    return { kind: 'memory', text: cleaned || t };
  }
  return null;
}

/** 工具箱收纳的全部功能（v3：没有左侧导航了，一切都在助手里） */
const MODULE_TABS: { key: ToolKey; label: string; emoji: string }[] = [
  { key: 'overview', label: '总览', emoji: '🏠' },
  { key: 'today', label: '今日计划', emoji: '📋' },
  { key: 'study', label: '学习计划', emoji: '📚' },
  { key: 'fitness', label: '健身计划', emoji: '🏋️' },
  { key: 'diet', label: '饮食计划', emoji: '🍚' },
  { key: 'games', label: '游戏娱乐', emoji: '🎮' },
  { key: 'media', label: '自媒体', emoji: '📣' },
  { key: 'dev', label: '开发工作', emoji: '💻' },
  { key: 'consulting', label: '咨询工作', emoji: '💼' },
  { key: 'design', label: '设计稿', emoji: '🎨' },
  { key: 'materials', label: '素材', emoji: '📄' },
  { key: 'memory', label: '记忆树', emoji: '🌳' },
  { key: 'screen', label: '屏幕助手', emoji: '🖥' },
  { key: 'settings', label: '设置', emoji: '⚙️' },
];

export default function Assistant() {
  const { data, settings, create, update, remove, updateSettings, reload, savedAt } = useStore();
  // 保存指示：改动后几秒内出现「✓ 已保存」（原侧边栏语义）
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShowSaved(true);
    const tm = setTimeout(() => setShowSaved(false), 6000);
    return () => clearTimeout(tm);
  }, [savedAt]);
  const [current, setCurrent] = useState<ActionKey | null>(null);
  const [toast, setToast] = useState<null | { msg: string; target?: PageKey | ToolKey; tool?: ToolKey; memoryUndo?: string }>(null);
  // 工具箱开合记忆：刷新/重开后回到刚才的模块（v3）
  const [tool, setToolState] = useState<ToolKey | null>(() => {
    try {
      return (localStorage.getItem('toolbox-tab') as ToolKey) || null;
    } catch {
      return null;
    }
  });
  const setTool = (v: ToolKey | null) => {
    setToolState(v);
    try {
      if (v) localStorage.setItem('toolbox-tab', v);
      else localStorage.removeItem('toolbox-tab');
    } catch {
      // 无痕模式忽略
    }
  };
  /** PageKey → 工具箱标签：home→总览、assistant→收起 */
  const openTool = (p: PageKey | ToolKey) => {
    if (p === 'home') setTool('overview');
    else if (p === 'assistant') setTool(null);
    else setTool(p as ToolKey);
  };
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [memBranch, setMemBranch] = useState<BranchKey>('about');
  const [memProps, setMemProps] = useState<{ text: string; branch: string; conflictWith?: string }[]>([]);
  const [memPropBranch, setMemPropBranch] = useState<BranchKey>('life');
  const shownMemRef = useRef<string[]>([]); // 已提示过的静默记忆，避免重复弹

  /** 撤销一条刚自动记住的记忆 */
  const undoMemory = async (id: string) => {
    await pFetch('/api/memory/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await reload();
    setToast(null);
  };

  /** 聊完后查两样：静默自动记住的（轻提示+撤销）；疑似冲突的（确认卡，唯一打扰） */
  const checkMemoryPending = (delayMs = 4000) => {
    setTimeout(() => {
      pFetch('/api/memory/recent')
        .then((r) => r.json())
        .then((j) => {
          const recents = (j && Array.isArray(j.recent) ? j.recent : []).filter(
            (m: { id: string }) => !shownMemRef.current.includes(m.id),
          );
          if (recents.length) {
            const m = recents[0];
            shownMemRef.current = [...shownMemRef.current, m.id].slice(-20);
            setToast({ msg: `🌱 已记住：${m.text}`, tool: 'memory', memoryUndo: m.id });
          }
        })
        .catch(() => {});
      pFetch('/api/memory/pending')
        .then((r) => r.json())
        .then((j) => {
          if (j && Array.isArray(j.pending) && j.pending.length) {
            setMemProps(j.pending);
            setMemPropBranch((j.pending[0].branch || 'life') as BranchKey);
          }
        })
        .catch(() => {});
    }, delayMs);
  };

  const saveProposed = async () => {
    const p = memProps[0];
    if (!p) return;
    const rest = memProps.slice(1);
    setMemProps(rest);
    if (rest[0]) setMemPropBranch((rest[0].branch || 'life') as BranchKey);
    await pFetch('/api/memory/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p.text, branch: memPropBranch }),
    });
    setToast({ msg: '✓ 已记进记忆树', tool: 'memory' });
  };

  const ignoreProposed = async () => {
    const p = memProps[0];
    if (!p) return;
    const rest = memProps.slice(1);
    setMemProps(rest);
    if (rest[0]) setMemPropBranch((rest[0].branch || 'life') as BranchKey);
    await pFetch('/api/memory/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p.text }),
    });
  };

  /* ---------------- 本地模型对话（记录存本机数据文件，重启不丢） ---------------- */
  const chatHistory = useMemo(
    () => [...data.chatMessages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [data.chatMessages],
  );
  /** 按"天"分组：每天一段（旧的一天在前），段头带"清除这天" */
  const chatDays = useMemo(() => {
    const map = new Map<string, typeof chatHistory>();
    for (const m of chatHistory) {
      const k = localDay(m.createdAt);
      const list = map.get(k);
      if (list) list.push(m);
      else map.set(k, [m]);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, items]) => ({ key, items }));
  }, [chatHistory]);
  const [clearDay, setClearDay] = useState<string | null>(null);
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const [streaming, setStreaming] = useState<null | { content: string; reasoning: string }>(null);
  const [usedModel, setUsedModel] = useState<null | { name: string; auto: boolean }>(null);
  const [chatInput, setChatInput] = useState('');
  const [pendingImage, setPendingImage] = useState<null | { file: File; impression: string; kind: 'image' | 'video' }>(null);
  const [looking, setLooking] = useState(false);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [warming, setWarming] = useState(false); // 模型管家正在启动模型
  const [checking, setChecking] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [chatError, setChatError] = useState('');
  const [modelMenu, setModelMenu] = useState(false);
  const [sel, setSel] = useState<string[]>([]); // 菜单里勾选的模型 id
  const [conflict, setConflict] = useState(false); // 勾了多个聊天模型：共用显卡位的提示
  const [models, setModels] = useState<
    Array<{ id: string; name: string; type: string; kind?: string; online: boolean; active: boolean; slot: 'chat' | 'other'; note: string }>
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const warmTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // 智能吸底：用户手动上滑→暂停自动跟随（回复时不再被拽回底部）；回到底部附近或发新消息→恢复跟随
  const stickBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const scrollBottomNow = (smooth = false) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  };

  // 打开小下拉时拉一次各模型的状态（画图专用模型不进聊天菜单，它只在下方"画图引擎"段出现）
  useEffect(() => {
    if (!modelMenu) return;
    pFetch('/api/models/status')
      .then((r) => r.json())
      .then((rows: Array<{ id: string; name: string; type: string; kind?: string; online: boolean; active: boolean; slot: 'chat' | 'other'; note: string }>) =>
        setModels((rows || []).filter((m) => m.kind !== 'image')),
      )
      .catch(() => setModels([]));
  }, [modelMenu]);

  // 多选模型：打开菜单时把当前池勾出来（没勾过 = 全部）
  const openModelMenu = () => {
    const pool =
      settings.selectedModels && settings.selectedModels.length
        ? settings.selectedModels
        : models.map((m) => m.id);
    setSel(pool.filter((id) => models.some((m) => m.id === id)));
    setConflict(false);
    setModelMenu(true);
  };

  const toggleSel = (id: string) => {
    setConflict(false);
    setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 切到某个模型后，让模型管家把它启动起来（自动关掉冲突的聊天模型）
  const startPickedModel = async (id: string) => {
    setWarming(true);
    let needWarm = false;
    try {
      const j = await (
        await pFetch('/api/local/ensure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id }),
        })
      ).json();
      if (j && Array.isArray(j.started) && j.started.length) {
        needWarm = true;
        setToast({ msg: `⏳ 正在启动：${j.started.join('、')}（约 20~30 秒，好了自动亮绿）` });
      } else if (j && j.error) {
        setWarming(false);
        setToast({ msg: `启动没成功：${j.error}` });
        await checkStatus();
        return;
      } else if (j && j.already) {
        needWarm = true; // 已经在跑：检查一次就亮绿
      } else {
        setWarming(false); // 管家没启用等情况：不进入启动中状态
        await checkStatus();
        return;
      }
    } catch {
      setWarming(false);
      await checkStatus();
      return;
    }
    if (!needWarm) return;
    const online = await checkStatus();
    if (online) {
      setWarming(false);
      return;
    }
    let tries = 0;
    if (warmTimer.current) clearInterval(warmTimer.current);
    warmTimer.current = setInterval(async () => {
      tries += 1;
      const ok = await checkStatus();
      if (ok || tries >= 20) {
        if (warmTimer.current) clearInterval(warmTimer.current);
        setWarming(false);
      }
    }, 3000);
  };

  // 默认单模型模式：点一下就切换（突出使用一个模型），并自动启动它
  const pickOne = async (id: string) => {
    setModelMenu(false);
    await updateSettings({ activeModelId: id, autoRoute: false });
    setToast({ msg: '✓ 已切换到这个模型' });
    void startPickedModel(id);
  };

  // 多选模式开关：开 = 勾多个按问题自动切换；关 = 回到单个模型
  const toggleMulti = async () => {
    const next = settings.autoRoute === false;
    if (next) {
      const pool =
        settings.selectedModels && settings.selectedModels.length
          ? settings.selectedModels
          : models.map((m) => m.id);
      setSel(pool.filter((id) => models.some((m) => m.id === id)));
      setConflict(false);
    }
    await updateSettings({ autoRoute: next });
  };

  const applySelection = async () => {
    if (!sel.length) {
      setToast({ msg: '至少勾选一个模型' });
      return;
    }
    setModelMenu(false);
    if (sel.length === 1) {
      // 只勾一个 = 固定用这个（并自动启动它）
      await updateSettings({ activeModelId: sel[0], selectedModels: sel, autoRoute: false });
      setToast({ msg: '✓ 已固定用这一个模型' });
      void startPickedModel(sel[0]);
    } else {
      // 勾多个 = 按问题在勾选的模型里自动切换
      await updateSettings({ selectedModels: sel, autoRoute: true });
      setToast({ msg: `✓ 已选 ${sel.length} 个模型，按问题自动切换` });
    }
  };

  const confirmSelection = () => {
    const chatSel = models.filter((m) => sel.includes(m.id) && m.slot === 'chat');
    if (chatSel.length > 1) {
      setConflict(true); // 共用显卡位：提示后由用户决定"重新选择"或"确定继续"
      return;
    }
    void applySelection();
  };

  const checkStatus = async (): Promise<boolean> => {
    setChecking(true);
    try {
      const r = await pFetch('/api/model/status');
      const s = await r.json();
      setStatus(s);
      return Boolean(s && s.online);
    } catch {
      setStatus({ online: false, baseUrl: '', model: '' });
      return false;
    } finally {
      setChecking(false);
    }
  };

  // 切换模型/调度模式后顶栏芯片立即刷新（v3：助手常驻，不再靠页面重挂载）
  useEffect(() => {
    checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.activeModelId, settings.autoRoute]);

  useEffect(() => {
    // 打开助手页只查模型状态，不再自动拉起本地模型（阿珑要求：本地模型不要自动开启）。
    // 要用模型时：设置里点「启动/一键启动」或选某个本地模型（那属于手动操作，保留）。
    checkStatus();
    return () => {
      if (warmTimer.current) clearInterval(warmTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 只在"贴底"时跟随最新消息滚动；用户上滑翻看历史时绝不再抢滚动条
    if (stickBottom.current) scrollBottomNow();
  }, [chatHistory, streaming]);

  const sendChat = async (customText?: string, skipDetect = false) => {
    let text = (customText ?? chatInput).trim();
    // ---------- 画图通道：在对话里直接"画：xxx"，成品图挂进她的回复气泡 ----------
    if (customText === undefined && !pendingImage) {
      // 「画图通道」查询 / 「画图通道：智谱|免费|auto|本地」切换——你接入的模型和备选通道一键换
      const chM = text.match(/^(?:画图通道|切换画图通道|切换画图模型)(?:[：:，,\s]+\s*(.{0,12}))?$/);
      if (chM) {
        await create('chatMessages', { role: 'user', content: text });
        setChatInput('');
        const want = (chM[1] || '').trim().toLowerCase();
        const map: Record<string, 'auto' | 'zhipu' | 'pollinations' | ''> = { '': '', auto: 'auto', 自动: 'auto', 智谱: 'zhipu', zhipu: 'zhipu', 免费: 'pollinations', 免密钥: 'pollinations', pollinations: 'pollinations' };
        try {
          if (want) {
            const p = map[want];
            if (!p) {
              await create('chatMessages', { role: 'assistant', content: '没听清这个通道名～可选：`画图通道：auto`（自动，推荐）/ `智谱`（你接入的那个，画质好）/ `免费`（零密钥兜底）' });
              return;
            }
            await updateSettings({ imagineProvider: p });
          }
          const st = await (await pFetch('/api/imagine/status')).json();
          const names: Record<string, string> = { zhipu: '智谱「生成图片」（你接入的模型）', pollinations: '零密钥云端（免费兜底）', ollama: '本地 Ollama', auto: '自动挑选' };
          await create('chatMessages', {
            role: 'assistant',
            content: `${want ? '✓ 通道设置好了。' : ''}当前策略：${names[st.provider] || st.provider}；实际生效：**${names[st.activeChannel] || st.activeChannel}**${st.hasKey ? '（Key 已就位 ✓）' : '（还没装智谱 Key）'}。说「画：什么东西」就开工。`,
          });
        } catch {
          await create('chatMessages', { role: 'assistant', content: '通道没答话——工作台服务在跑吗？' });
        }
        return;
      }
      const keyM = text.match(/^(?:画图密钥|设画图密钥)[：:，,\s]*(\S+)$/);
      if (keyM) {
        await create('chatMessages', { role: 'user', content: text });
        if (customText === undefined) setChatInput('');
        // 防呆：先验格式再存（中文占位/太短/没点号的脏 Key 直接教会，不吞进设置里）
        if (!/^[!-~]{16,120}$/.test(keyM[1]) || !keyM[1].includes('.')) {
          await create('chatMessages', {
            role: 'assistant',
            content: '这串不像智谱 Key 哦——真的 Key 是 30~60 位英文数字、中间带一个点（长这样：ab3…cd.12ef…89）。去 bigmodel.cn → 头像 → API Keys → 把整串复制全再发一次「画图密钥：整串」。刚才那串我没存，免得装把坏钥匙。',
          });
          return;
        }
        try {
          await updateSettings({ imagineKey: keyM[1] });
          await create('chatMessages', {
            role: 'assistant',
            content: '✓ 智谱 Key 收好了（只存你本机，绝不外传）。从现在起随时说「画：想画的东西」，我直接出图。',
          });
        } catch {
          await create('chatMessages', { role: 'assistant', content: '密钥没存上——工作台服务在跑吗？再发一次「画图密钥：xxx」试试。' });
        }
        return;
      }
      const paintM = text.match(/^(?:帮我|给我|请)?(?:画一下|画一张|画个|画幅|画|生成图片|生成图)[：:\s]?\s*(.{2,})$/);
      if (paintM && paintM[1].trim()) {
        const subject = paintM[1].trim().slice(0, 800);
        await create('chatMessages', { role: 'user', content: text });
        setChatInput('');
        setGenerating(true);
        setStreaming({ content: '🎨 提笔画去了…（云端大约 10~30 秒）', reasoning: '' });
        try {
          const r = await pFetch('/api/imagine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: subject }),
          });
          const j = await r.json();
          setStreaming(null);
          if (r.ok && j.file) {
            await create('chatMessages', {
              role: 'assistant',
              content: `画好啦——「${subject.slice(0, 30)}」🎨（点开大图，素材柜里也存了一份）`,
              attachments: [{ kind: 'image', name: `🎨${subject.slice(0, 20)}.png`, mime: 'image/png', file: j.file }],
            });
          } else {
            const hint = /Key|密钥/.test(String(j.error || ''))
              ? '我还没拿到智谱的 Key 开不了笔。去 bigmodel.cn 免费注册拿一个，发我「画图密钥：粘贴进来」就好，一秒装笔。'
              : String(j.error || '生成失败');
            await create('chatMessages', { role: 'assistant', content: `😖 没画成：${hint}` });
          }
        } catch (e) {
          setStreaming(null);
          await create('chatMessages', { role: 'assistant', content: `😖 画图请求没送到：${(e as Error).message}` });
        } finally {
          setGenerating(false);
          reload().catch(() => {});
        }
        return;
      }
    }
    // 附件记录：发图时把图片本身显示在气泡里（点开看大图），柳月虹照常"看见"
    let attachment: { kind: 'image'; name: string; mime: string; file: string } | null = null;
    // 附了图/视频：先存素材柜，再让柳月虹"真的看见"（视觉模型描述）；图片没视觉时退回像素印象
    if (pendingImage && customText === undefined) {
      const img = pendingImage;
      setPendingImage(null);
      const mime = img.file.type || (img.kind === 'video' ? 'video/mp4' : 'image/png');
      // 挑图时已预上传就直接复用（不再二次上传）；没有则补传一次
      const pre = preUploaded.current.get(img.file);
      if (pre && img.kind === 'image') {
        preUploaded.current.delete(img.file);
        attachment = { kind: 'image', name: pre.name, mime: pre.mime, file: pre.file };
      } else if (img.kind === 'image') {
        try {
          const q = new URLSearchParams({ name: img.file.name, mime });
          const up = await pFetch(`/api/files?${q}`, {
            method: 'POST',
            headers: { 'Content-Type': mime },
            body: img.file,
          });
          if (up.ok) {
            const saved = await up.json().catch(() => null);
            if (saved && saved.file) attachment = { kind: 'image', name: saved.name || img.file.name, mime, file: saved.file };
          }
        } catch {
          // 存不进素材柜也不拦着对话
        }
      }
      if (img.kind === 'video') {
        setLooking(true);
        try {
          const r = await pFetch('/api/vision/video', {
            method: 'POST',
            headers: { 'Content-Type': mime },
            body: img.file,
          });
          if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '视频识别失败');
          const desc = ((await r.json()) as { description: string }).description;
          text = text ? `我发了一段视频给你。你看到的画面是：${desc}\n\n${text}` : `我发了一段视频给你。你看到的画面是：${desc}`;
        } catch (e) {
          setToast({ msg: `视频识别没成功：${(e as Error).message}` });
          return;
        } finally {
          setLooking(false);
        }
      } else if (attachment) {
        // 图片不再在前端同步"看"（那 10~16 秒全发生在发送时=慢的根源）——
        // 挑图已预识别进 visionCache，服务端 annotate 命中缓存即注入描述，发送基本秒过。
        // 没配文字时用像素印象垫话（也保证空文本不至于把发送整个拦掉）
        if (!text) text = img.impression;
      } else {
        // 图没存进素材柜才走老兜底：像素印象垫话
        text = text ? `${img.impression}\n\n${text}` : img.impression;
      }
    }
    if (!text || generating || !status?.online) return;
    if (customText === undefined) setChatInput('');
    setChatError('');
    setUsedModel(null);
    // 先把"我"这条存进对话记录（关机重启也不丢；图片附件一起存，气泡里能看到图）
    await create('chatMessages', {
      role: 'user',
      content: text,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    // 发了新消息=想看她的回复：重新贴底，自动跟随恢复
    stickBottom.current = true;
    setAtBottom(true);
    // 发送瞬间就识别"让它帮忙记录"的意图，确认卡不用等模型说完（读文件时不识别）
    if (!skipDetect) {
      const detected = detectAction(text, today());
      if (detected) setPending(detected);
    }
    setGenerating(true);
    setStreaming({ content: '', reasoning: '' });
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let content = '';
    let reasoning = '';
    const flush = () => setStreaming({ content, reasoning });
    const contextMessages = [
      ...chatHistory.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments && m.attachments.length ? { attachments: m.attachments } : {}),
      })),
      { role: 'user' as const, content: text, ...(attachment ? { attachments: [attachment] } : {}) },
    ];

    try {
      const res = await pFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: contextMessages }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        throw new Error((err && err.error) || `请求失败（${res.status}）`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let inThink = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            // 第一条元信息：这次由哪个模型回答（自动调度）
            if (j.meta) {
              setUsedModel({ name: j.meta.name || j.meta.model, auto: j.meta.auto === true });
              if (j.meta.switched) {
                setToast({ msg: `⚡ 模型管家已自动切换：${j.meta.switchedLabel || j.meta.name}` });
              }
              continue;
            }
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (!d) continue;
            if (d.reasoning_content) reasoning += d.reasoning_content;
            if (d.content) {
              let c: string = d.content;
              while (c.length) {
                if (inThink) {
                  const close = c.indexOf('</think>');
                  if (close === -1) {
                    reasoning += c;
                    c = '';
                  } else {
                    reasoning += c.slice(0, close);
                    c = c.slice(close + 8);
                    inThink = false;
                  }
                } else {
                  const open = c.indexOf(' thinking');
                  if (open === -1) {
                    content += c;
                    c = '';
                  } else {
                    content += c.slice(0, open);
                    c = c.slice(open + 7);
                    inThink = true;
                  }
                }
              }
            }
            flush();
          } catch {
            // 半包 JSON 忽略，等下一段
          }
        }
      }
      flush();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof DOMException && e.name === 'AbortError')) setChatError(msg);
    } finally {
      // 把这次回答存进记录（就算中途点了停止，也保留已经生成的部分）
      if (content.trim() || reasoning.trim()) {
        try {
          await create('chatMessages', { role: 'assistant', content, reasoning });
        } catch {
          // 保存失败不影响界面，内容还在屏幕上
        }
      }
      setGenerating(false);
      setStreaming(null);
      abortRef.current = null;
      // 聊完过几秒看看她有没有"想帮你记住"的提议
      checkMemoryPending(4000);
      checkMemoryPending(9000);
    }
  };

  const stopChat = () => abortRef.current?.abort();

  // 画图引擎切换（模型菜单底部"画图引擎"段；本地档按阿珑要求不设）
  const [savingEngine, setSavingEngine] = useState('');
  const pickEngine = async (p: 'auto' | 'zhipu' | 'pollinations') => {
    setSavingEngine(p);
    try {
      await updateSettings({ imagineProvider: p });
      setToast({
        msg:
          p === 'auto'
            ? '🎨 画图引擎＝自动：优先智谱「生成图片」，失灵换免费兜底，永不落空'
            : p === 'zhipu'
              ? '⭐ 已锁定智谱「生成图片」（画质好、无第三方水印）'
              : '🆓 已锁定免费云端（带 AI 生成小水印，不耗智谱额度）',
      });
    } finally {
      setSavingEngine('');
    }
  };

  // 挑图即上传+预识别：她"看图中"和用户打字并行，发送时服务端多半已缓存描述，秒回
  const preUploaded = useRef(new Map<File, { file: string; mime: string; name: string }>());
  const preanalyzeImage = (f: File) => {
    const mime = f.type || 'image/png';
    (async () => {
      try {
        const q = new URLSearchParams({ name: f.name, mime });
        const up = await pFetch(`/api/files?${q}`, { method: 'POST', headers: { 'Content-Type': mime }, body: f });
        if (!up.ok) return;
        const saved = await up.json().catch(() => null);
        if (!saved?.file) return;
        preUploaded.current.set(f, { file: saved.file, mime, name: saved.name || f.name });
        // 视觉预分析：不等结果，识别好之前发了也没事（发送时服务端 annotate 会等/命中缓存）
        pFetch('/api/vision/preanalyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: saved.file, mime }),
        }).catch(() => {});
      } catch {
        /* 预传失败就算了，发送时照常走原路上传 */
      }
    })();
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const stats = await imageStats(f);
      setPendingImage({ file: f, impression: impressionText(stats), kind: 'image' });
      preanalyzeImage(f);
    } catch {
      setToast({ msg: '这张图读不了，换一张试试' });
    }
  };

  const handleVideoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setPendingImage({ file: f, impression: '', kind: 'video' });
  };

  const dayLabel = (key: string) => {
    const t = today();
    if (key === t) return '今天';
    if (key === addDays(t, -1)) return '昨天';
    if (key === addDays(t, -2)) return '前天';
    return fmtCN(key);
  };

  /** 只清掉某一天的对话（记忆树和其它模块不受影响） */
  const clearOneDay = async (dayKey: string) => {
    setClearDay(null);
    let n = 0;
    for (const m of data.chatMessages) {
      if (localDay(m.createdAt) === dayKey) {
        await remove('chatMessages', m.id);
        n++;
      }
    }
    setToast({ msg: `✓ 已清除${dayLabel(dayKey)}的 ${n} 条对话` });
  };

  /** 清空全部对话 */
  const clearAllChat = async () => {
    setClearAllArmed(false);
    const n = data.chatMessages.length;
    for (const m of data.chatMessages) await remove('chatMessages', m.id);
    setToast({ msg: `✓ 已清空全部对话（${n} 条）` });
  };

  const executeAction = async () => {
    if (!pending) return;
    const action = pending;
    const t = today();
    if (action.kind === 'kb') {
      const text = action.text.trim();
      setPending(null);
      if (!text) return;
      try {
        const j = await (await pFetch('/api/kb/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
        setToast({ msg: j.ok ? `✓ 你亲口吩咐的，直接写进知识库了（${j.category}，共 ${j.total} 条）` : j.error || '没写进去' });
      } catch {
        setToast({ msg: '知识库没接住，检查服务在不在跑' });
      }
    } else if (action.kind === 'memory') {
      const text = action.text.trim();
      setPending(null);
      if (!text) return;
      await create('memories', { branch: memBranch, text, pinned: false, source: 'chat' });
      setToast({ msg: '✓ 已记入记忆树', tool: 'memory' });
    } else if (action.kind === 'task') {
      const title = action.text.trim();
      setPending(null);
      if (!title) return;
      await create('tasks', {
        title,
        date: action.date || t,
        time: '',
        estimate: '',
        note: '',
        priority: 'none',
        done: false,
        doneAt: null,
      });
      setToast({ msg: '✓ 已记入今日计划', target: 'today' });
    } else if (action.kind === 'study') {
      const title = action.text.trim();
      setPending(null);
      if (!title) return;
      await create('studyItems', {
        title,
        course: action.course,
        kind: action.itemKind,
        due: action.due,
        done: false,
        doneAt: null,
      });
      setToast({ msg: '✓ 已记入学习计划', target: 'study' });
    } else if (action.kind === 'memo') {
      const text = action.text.trim();
      setPending(null);
      if (!text) return;
      await create('memos', { text });
      setToast({ msg: '✓ 已记入快速备忘', target: 'home' });
    } else if (action.kind === 'workout') {
      const planToday = settings.weeklyPlan[weekdayIndex(t)];
      const note = action.note;
      setPending(null);
      await create('workoutLogs', {
        date: t,
        content: planToday && planToday !== '休息' ? planToday : '训练',
        note,
      });
      setToast({ msg: '✓ 已记入健身计划', target: 'fitness' });
    } else if (action.kind === 'weight') {
      const w = Number(action.value);
      if (!w || w <= 0) return;
      setPending(null);
      await create('weightLogs', { date: t, weight: Math.round(w * 10) / 10 });
      setToast({ msg: '✓ 已记入健身计划', target: 'fitness' });
    } else if (action.kind === 'meal') {
      const text = action.text.trim();
      const slot = action.slot;
      setPending(null);
      if (!text) return;
      const existing = data.mealDays.find((m) => m.date === t);
      const prev = (existing?.[slot] ?? '').trim();
      const merged = prev ? `${prev}\n${text}` : text;
      if (existing) {
        const patch: Record<string, unknown> = {};
        patch[slot] = merged;
        await update('mealDays', existing.id, patch);
      } else {
        await create('mealDays', {
          date: t,
          breakfast: '',
          lunch: '',
          dinner: '',
          snack: '',
          water: 0,
          [slot]: merged,
        });
      }
      setToast({ msg: '✓ 已记入饮食计划', target: 'diet' });
    }
    // 对话↔工具联动：记完自动打开右侧对应模块（需要时才出现）
    const toolOf: Partial<Record<PendingAction['kind'], PageKey>> = {
      task: 'today',
      study: 'study',
      workout: 'fitness',
      weight: 'fitness',
      meal: 'diet',
    };
    const tk = toolOf[action.kind];
    if (tk) setTool(tk as ToolKey);
  };

  /* ---------------- 快捷操作（保持原样） ---------------- */
  const [taskForm, setTaskForm] = useState({
    title: '',
    date: today(),
    time: '',
    estimate: '',
    note: '',
    priority: 'none',
  });
  const [studyForm, setStudyForm] = useState<{
    title: string;
    course: string;
    kind: '作业' | '考试' | '复习' | '其他';
    due: string;
  }>({ title: '', course: '', kind: '作业', due: '' });
  const [memoText, setMemoText] = useState('');
  const [workoutNote, setWorkoutNote] = useState('');
  const [weight, setWeight] = useState('');
  const [hoursForm, setHoursForm] = useState({ clientId: '', hours: '', note: '' });
  const [ideaText, setIdeaText] = useState('');
  const [mealForm, setMealForm] = useState<{ slot: 'breakfast' | 'lunch' | 'dinner' | 'snack'; text: string }>({
    slot: 'breakfast',
    text: '',
  });
  const [playForm, setPlayForm] = useState({ itemId: '', hours: '' });

  const done = (key: ActionKey) => {
    const action = ACTIONS.find((a) => a.key === key)!;
    setCurrent(null);
    setToast({ msg: `✓ 已记入${action.targetName}`, target: action.target });
    // 对话↔工具联动：记完自动打开右侧对应模块（需要时才出现）
    if (action.target === 'home') setTool('overview');
    else if (MODULE_TABS.some((m) => m.key === action.target)) setTool(action.target as ToolKey);
  };

  const handleSave = async () => {
    const t = today();
    if (current === 'task') {
      const title = taskForm.title.trim();
      if (!title) return;
      await create('tasks', {
        title,
        date: taskForm.date || t,
        time: taskForm.time,
        estimate: taskForm.estimate.trim(),
        note: taskForm.note.trim(),
        priority: taskForm.priority,
        done: false,
        doneAt: null,
      });
      setTaskForm({ title: '', date: today(), time: '', estimate: '', note: '', priority: 'none' });
      done('task');
    } else if (current === 'study') {
      const title = studyForm.title.trim();
      if (!title) return;
      await create('studyItems', {
        title,
        course: studyForm.course.trim(),
        kind: studyForm.kind,
        due: studyForm.due,
        done: false,
        doneAt: null,
      });
      setStudyForm({ title: '', course: '', kind: '作业', due: '' });
      done('study');
    } else if (current === 'memo') {
      const text = memoText.trim();
      if (!text) return;
      await create('memos', { text });
      setMemoText('');
      done('memo');
    } else if (current === 'workout') {
      const planToday = settings.weeklyPlan[weekdayIndex(t)];
      await create('workoutLogs', {
        date: t,
        content: planToday && planToday !== '休息' ? planToday : '训练',
        note: workoutNote.trim(),
      });
      setWorkoutNote('');
      done('workout');
    } else if (current === 'weight') {
      const w = Number(weight);
      if (!w || w <= 0) return;
      await create('weightLogs', { date: t, weight: Math.round(w * 10) / 10 });
      setWeight('');
      done('weight');
    } else if (current === 'hours') {
      const h = Number(hoursForm.hours);
      if (!hoursForm.clientId || !h || h <= 0) return;
      await create('timeEntries', {
        clientId: hoursForm.clientId,
        date: t,
        hours: h,
        note: hoursForm.note.trim(),
        source: 'manual',
      });
      setHoursForm({ clientId: '', hours: '', note: '' });
      done('hours');
    } else if (current === 'idea') {
      const text = ideaText.trim();
      if (!text) return;
      await create('ideas', { text });
      setIdeaText('');
      done('idea');
    } else if (current === 'meal') {
      const text = mealForm.text.trim();
      if (!text) return;
      const existing = data.mealDays.find((m) => m.date === t);
      const prev = (existing?.[mealForm.slot] ?? '').trim();
      const merged = prev ? `${prev}\n${text}` : text;
      if (existing) {
        const patch: Record<string, unknown> = {};
        patch[mealForm.slot] = merged;
        await update('mealDays', existing.id, patch);
      } else {
        await create('mealDays', {
          date: t,
          breakfast: '',
          lunch: '',
          dinner: '',
          snack: '',
          water: 0,
          [mealForm.slot]: merged,
        });
      }
      setMealForm({ ...mealForm, text: '' });
      done('meal');
    } else if (current === 'playtime') {
      const h = Number(playForm.hours);
      if (!playForm.itemId || !h || h <= 0) return;
      await create('playLogs', {
        itemId: playForm.itemId,
        date: t,
        hours: Math.round(h * 100) / 100,
        note: '',
      });
      setPlayForm({ itemId: '', hours: '' });
      done('playtime');
    }
  };

  const modalTitle = current ? MODAL_TITLES[current] : '';
  // 按时辰的问候（豆包式：开口先叫人）
  const greetWord = (() => {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好呀';
    if (h < 14) return '中午好呀';
    if (h < 19) return '下午好呀';
    return '晚上好呀';
  })();
  const digestTasks = data.tasks.filter((x) => x.date === today() && !x.done).length;
  const digestDue = (() => {
    const due = data.studyItems
      .filter((s) => !s.done && s.due && s.due >= today())
      .sort((a, b) => (a.due || '').localeCompare(b.due || ''))[0];
    if (!due || !due.due) return '';
    const label = due.due === addDays(today(), 1) ? '明天' : due.due === today() ? '今天' : fmtCN(due.due);
    return `${label}「${due.title}」截止`;
  })();
  // 各模块待办红点（原侧边栏语义，迁到工具箱标签上）
  const badgeCounts: Partial<Record<ToolKey, number>> = {
    today: data.tasks.filter((x) => x.date === today() && !x.done).length,
    study: data.studyItems.filter((s) => !s.done && !!s.due && s.due <= today()).length,
    media: data.contentItems.filter((c) => c.status === 'ready').length,
    dev: data.projectTasks.filter((x) => x.status === 'doing').length,
  };
  const totalBadge = Object.values(badgeCounts).reduce((a, b) => a + (b || 0), 0);

  return (
    <section className="page assistant-page" data-testid="page-assistant">
      <div className="assistant-layout">
        <div className="assistant-main">
          <div className="assistant-topbar" data-testid="assistant-topbar">
            <button type="button" className="topbar-logo" data-testid="topbar-logo" onClick={() => setTool(null)}>
              🐾 AI 助手
            </button>
            {status && (
                      <span className="model-pick">
                        {usedModel?.auto && (
                          <span className="chip chip-mint" data-testid="chat-used-model">
                            ✨ 整合 · {usedModel.name}
                          </span>
                        )}
                        <button
                          type="button"
                          className={`chip ${status.online ? 'chip-mint' : 'chip-gray'}`}
                          data-testid={status.online ? 'model-online' : warming ? 'model-warming' : 'model-offline'}
                          title="点这里切换模型"
                          onClick={openModelMenu}
                        >
                          {status.online
                            ? settings.autoRoute !== false && (settings.selectedModels || []).length > 1
                              ? `● 多选 ${(settings.selectedModels || []).length} 个`
                              : `● ${status.name || status.model}`
                            : warming
                              ? '⏳ 模型启动中…'
                              : '模型未启动'}{' '}
                          ▾
                        </button>
                        {modelMenu && (
                          <>
                            <span className="menu-backdrop" onClick={() => setModelMenu(false)} />
                            <div className="model-menu" data-testid="model-menu">
                              <div className="model-menu-title">切换模型</div>
                              <label className="model-menu-item model-multi-row">
                                <input
                                  type="checkbox"
                                  className="model-checkbox"
                                  data-testid="model-multi-toggle"
                                  checked={settings.autoRoute !== false}
                                  onChange={() => void toggleMulti()}
                                />
                                <span className="grow">多选模式</span>
                                <span className="row-sub">勾多个，按问题自动切换</span>
                              </label>
                              {models.map((m) =>
                                settings.autoRoute !== false ? (
                                  <label key={m.id} className="model-menu-item" data-testid={`model-check-${m.id}`}>
                                    <input
                                      type="checkbox"
                                      className="model-checkbox"
                                      checked={sel.includes(m.id)}
                                      onChange={() => toggleSel(m.id)}
                                    />
                                    <span className={`model-dot ${m.online ? 'on' : 'off'}`} />
                                    <span className="grow model-col">
                                      <span className="model-name">{m.name}</span>
                                      {m.note ? <span className="model-note">{m.note}</span> : null}
                                    </span>
                                    {m.slot === 'chat' && (
                                      <span className="row-sub" title="聊天模型共用一个显卡位，不能同时运行；勾选多个会按问题自动切换">
                                        共享显卡
                                      </span>
                                    )}
                                  </label>
                                ) : (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className={`model-menu-item${m.active ? ' active' : ''}`}
                                    data-testid={`model-check-${m.id}`}
                                    onClick={() => void pickOne(m.id)}
                                  >
                                    <span className={`model-dot ${m.online ? 'on' : 'off'}`} />
                                    <span className="grow model-col">
                                      <span className="model-name">{m.name}</span>
                                      {m.note ? <span className="model-note">{m.note}</span> : null}
                                    </span>
                                    {m.active ? <span className="row-sub">✓ 使用中</span> : null}
                                  </button>
                                ),
                              )}
                              {settings.autoRoute !== false && conflict && (
                                <div className="model-conflict" data-testid="model-conflict">
                                  ⚠️ 不兼容：这些聊天模型共用一个显卡位，不能同时运行
                                  （{models
                                    .filter((m) => sel.includes(m.id) && m.slot === 'chat')
                                    .map((m) => m.name)
                                    .join('、')}
                                  ）。勾选多个时我会按问题自动切换（不会同时占卡）。
                                  <div className="model-conflict-actions">
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      data-testid="model-reselect"
                                      onClick={() => setConflict(false)}
                                    >
                                      重新选择
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-blue btn-sm"
                                      data-testid="model-confirm-ok"
                                      onClick={() => void applySelection()}
                                    >
                                      确定继续
                                    </button>
                                  </div>
                                </div>
                              )}
                              {models.length === 0 && (
                                <div className="row-sub" style={{ padding: 8 }}>
                                  还没有模型，去「数据与设置」里添加
                                </div>
                              )}
                              {/* 画图引擎：聊天模型一键切换处管聊天，这里管画笔（本地不做，按阿珑令） */}
                              <div className="model-menu-title model-engine-title" data-testid="draw-engine-section">
                                🎨 画图引擎
                              </div>
                              {(
                                [
                                  ['auto', '🎨 自动（推荐）', '优先智谱「生成图片」，失灵自动换免费兜底'],
                                  ['zhipu', '⭐ 智谱「生成图片」', '你接入的云端画图模型：画质好、无第三方水印'],
                                  ['pollinations', '🆓 免费云端', '零密钥兜底通道：图带 AI 生成小水印'],
                                ] as const
                              ).map(([val, label, tip]) => (
                                <button
                                  key={val}
                                  type="button"
                                  className={`model-menu-item model-engine-item${(settings.imagineProvider || 'auto') === val ? ' active' : ''}`}
                                  data-testid={`draw-engine-${val}`}
                                  title={tip}
                                  disabled={savingEngine === val}
                                  onClick={() => void pickEngine(val)}
                                >
                                  <span className="grow model-col">
                                    <span className="model-name">{label}</span>
                                    <span className="model-note">{tip}</span>
                                  </span>
                                  {(settings.imagineProvider || 'auto') === val ? <span className="row-sub">✓ 使用中</span> : null}
                                </button>
                              ))}
                              {settings.autoRoute !== false && (
                                <button type="button" className="btn btn-blue btn-block" data-testid="model-confirm" onClick={confirmSelection}>
                                  确定
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </span>
                    )}
            <div className="grow" />
                        <span className="row-sub" data-testid="saved-indicator">
              {showSaved && savedAt ? `✓ 已保存 ${fmtTime(savedAt)}` : ''}
            </span>
            <button type="button" className="icon-btn" data-testid="open-settings" title="设置" onClick={() => setTool('settings')}>
              ⚙️
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="toolbox-open"
              onClick={() => setTool(tool ? null : 'today')}
            >
              🧰 工具箱
              {totalBadge > 0 && (
                <span className="tab-badge" data-testid="toolbox-badge">
                  {totalBadge}
                </span>
              )}
            </button>
          </div>
          <button
            type="button"
            className="chat-digest"
            data-testid="chat-digest"
            onClick={() => setTool('overview')}
            title="点开看今日总览"
          >
            {greetWord}，{settings.persona?.addressAs || '阿珑'}～
            <span className="chat-digest-sub">
              今日 {digestTasks} 项待办{digestDue ? ` · ${digestDue}` : ''}
            </span>
          </button>
                <div className="stack">
        {/* 她（柳月虹） */}
        <PersonaCard
          typing={generating}
          onThoughtClick={(text) => {
            setChatInput(text);
          }}
        />
        {/* 本地模型对话 */}
        <div className="card chat-main-card">
          <div className="card-head">
            <span className="card-title">本地 AI 对话</span>
            <div className="grow" />
            {chatHistory.length > 0 &&
              (clearAllArmed ? (
                <>
                  <button
                    type="button"
                    className="day-clear danger"
                    data-testid="clear-chat-ok"
                    onClick={clearAllChat}
                  >
                    确定清空全部
                  </button>
                  <button
                    type="button"
                    className="day-clear"
                    data-testid="clear-chat-cancel"
                    onClick={() => setClearAllArmed(false)}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="link-more"
                  data-testid="clear-chat"
                  disabled={generating}
                  onClick={() => setClearAllArmed(true)}
                >
                  清空全部对话
                </button>
              ))}
          </div>

          {status && !status.online ? (
            <div className="chat-offline" data-testid={warming ? 'chat-warming' : 'chat-offline'}>
              <div className="empty-icon">🌙</div>
              <div>{warming ? '模型正在启动，马上就好' : '本地模型还没启动'}</div>
              <div className="row-sub" style={{ lineHeight: 2 }}>
                {warming ? (
                  '模型管家正在自动启动模型（显卡加载约 20~30 秒），不用你动手'
                ) : (
                  <>
                    双击 D 盘「DeepSeek-R1-7B」文件夹里的「启动模型.bat」，
                    <br />
                    等窗口出现「就绪」字样后，点下面的按钮（打开助手时模型管家一般已经帮你启动了）
                  </>
                )}
              </div>
              <button type="button" className="btn btn-blue" data-testid="retry-status" onClick={() => checkStatus()} disabled={checking}>
                {warming ? '⏳ 启动中…' : checking ? '检测中…' : '重新检测'}
              </button>
            </div>
          ) : (
            <>
              <div
                className="chat-wrap"
                style={{ position: 'relative', minHeight: 0 }}
              >
              <div
                className="chat-list"
                data-testid="chat-list"
                ref={listRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                  const bottom = gap < 48; // 48px 内算"在底部"（程序滚动/滚轮惯性不误伤）
                  stickBottom.current = bottom;
                  setAtBottom((prev) => (prev === bottom ? prev : bottom));
                }}
              >
                {chatHistory.length === 0 && !streaming && (
                  <div className="chat-empty" data-testid="chat-empty">
                    <div className="paw-empty">🐾</div>
                    <div className="row-sub" style={{ padding: '14px 6px', lineHeight: 2 }}>
                    和本地的模型聊点什么吧，比如"帮我规划今天的任务"。
                    <br />
                    也可以直接让它帮你记录，比如：「加任务：明天交方案」「记体重：55.5」「备忘：买牛奶」「打卡：卧推+2.5kg」「记住：我喜欢低饱和的配色」——
                    它会弹一张确认卡，点确认才写入。
                    <br />
                    对话记录按天分组、一直保留（存在你自己的电脑里），每段可以单独「清除这天」；完全离线，不联网。
                    </div>
                  </div>
                )}
                {chatDays.map((d, di) => (
                  <div key={d.key} className="chat-day-block">
                    <div className="chat-day" data-testid={`chat-day-${di}`}>
                      <span className="chat-day-line" />
                      <span className="chat-day-label" data-testid={`chat-day-label-${di}`}>
                        {dayLabel(d.key)} · {d.items.length} 条
                      </span>
                      <span className="chat-day-line" />
                      {clearDay === d.key ? (
                        <>
                          <button
                            type="button"
                            className="day-clear danger"
                            data-testid={`day-clear-ok-${di}`}
                            onClick={() => clearOneDay(d.key)}
                          >
                            确定清除
                          </button>
                          <button
                            type="button"
                            className="day-clear"
                            data-testid={`day-clear-cancel-${di}`}
                            onClick={() => setClearDay(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="day-clear"
                          data-testid={`day-clear-${di}`}
                          title={`清除${dayLabel(d.key)}的对话（不影响记忆树）`}
                          disabled={generating}
                          onClick={() => setClearDay(d.key)}
                        >
                          ⌫ 清除这天
                        </button>
                      )}
                    </div>
                    {d.items.map((m) => {
                      const i = chatHistory.indexOf(m);
                      return (
                        <div
                          key={m.id}
                          className={`chat-msg ${m.role}`}
                          data-testid={m.role === 'assistant' ? 'chat-answer' : 'chat-question'}
                        >
                          {m.role === 'assistant' && m.reasoning ? (
                            <details className="think">
                              <summary>思考过程</summary>
                              <div>{m.reasoning}</div>
                            </details>
                          ) : null}
                          {m.source === 'persona' && (
                            <div className="p-src-tag" data-testid="persona-msg-tag">
                              💭 她一个人待着的时候，主动跟你说的
                            </div>
                          )}
                          <div className="chat-bubble" title={fmtTime(m.createdAt)}>
                            {m.attachments && m.attachments.length > 0 && (
                              <div className="chat-attachments">
                                {m.attachments.map((a, ai) =>
                                  a.kind === 'image' ? (
                                    <a
                                      key={ai}
                                      className="chat-img-link"
                                      href={`/files/${String(a.file || '').split(/[\\/]/).pop()}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={a.name}
                                      data-testid={`chat-attach-image-${i}`}
                                    >
                                      <img
                                        src={`/files/${String(a.file || '').split(/[\\/]/).pop()}`}
                                        alt={a.name}
                                        className="chat-img"
                                        loading="lazy"
                                      />
                                      <span className="chat-img-name">{a.name}</span>
                                    </a>
                                  ) : null,
                                )}
                              </div>
                            )}
                            {m.content}
                          </div>
                          {m.role === 'assistant' && m.content && (
                            <>
                              <button
                                type="button"
                                className="leaf-btn"
                                title="收藏到记忆树"
                                data-testid={`leaf-${i}`}
                                onClick={() => {
                                  setPending({ kind: 'memory', text: m.content.slice(0, 120).trim() });
                                  setMemBranch('about');
                                }}
                              >
                                🍃 记到记忆树
                              </button>
                              <button
                                type="button"
                                className="leaf-btn"
                                title="这条直接写进知识库（你亲手点的，算你本人授权）"
                                data-testid={`leaf-kb-${i}`}
                                onClick={async () => {
                                  const text = m.content.slice(0, 2000).trim();
                                  if (!text) return;
                                  try {
                                    const j = await (await pFetch('/api/kb/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
                                    setToast({ msg: j.ok ? `✓ 已写入知识库（${j.category}，共 ${j.total} 条）` : j.error || '没写进去' });
                                  } catch {
                                    setToast({ msg: '知识库没接住，检查服务' });
                                  }
                                }}
                              >
                                📚 进知识库
                              </button>
                              <button
                                type="button"
                                className="leaf-btn"
                                title="把这条回答存进文档"
                                data-testid={`make-doc-${i}`}
                                onClick={async () => {
                                  const title =
                                    m.content.split('\n').map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 24) ||
                                    'AI 回答';
                                  await create('documents', { title, content: m.content, source: 'chat' });
                                  setToast({ msg: '✓ 已存为文档', tool: 'materials' });
                                }}
                              >
                                📄 存为文档
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
                {streaming && (
                  <div className="chat-msg assistant" data-testid="chat-answer" key="streaming">
                    {streaming.reasoning ? (
                      <details className="think" open>
                        <summary>思考过程</summary>
                        <div>{streaming.reasoning}</div>
                      </details>
                    ) : null}
                    <div className="chat-bubble">{streaming.content || <span className="paw-thinking">🐾 柳月虹正在想…</span>}</div>
                  </div>
                )}
              </div>
              {!atBottom && (
                <button
                  type="button"
                  className="btn jump-bottom"
                  data-testid="chat-jump-bottom"
                  onClick={() => {
                    stickBottom.current = true;
                    setAtBottom(true);
                    scrollBottomNow(true);
                  }}
                >
                  ↓ 回到底部
                </button>
              )}
              </div>
              {chatError && (
                <div className="text-danger" data-testid="chat-error" style={{ padding: '6px 4px' }}>
                  {chatError}
                </div>
              )}
              {pending && pending.kind === 'memory' && (
                <div className="memory-confirm" data-testid="memory-confirm">
                  <div className="mc-head">🍃 要记到记忆树吗？</div>
                  <div className="mc-text" data-testid="memory-confirm-text">
                    {pending.text}
                  </div>
                  <div className="input-row">
                    <select
                      className="input"
                      style={{ maxWidth: 150 }}
                      data-testid="memory-branch"
                      value={memBranch}
                      onChange={(e) => setMemBranch(e.target.value as BranchKey)}
                    >
                      {BRANCHES.map((b) => (
                        <option key={b.key} value={b.key}>
                          {b.emoji} {b.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-testid="memory-save"
                      onClick={executeAction}
                    >
                      记下来
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>
                      不用
                    </button>
                  </div>
                </div>
              )}
              {pending && pending.kind !== 'memory' && (
                <div className="memory-confirm" data-testid="action-confirm">
                  <div className="mc-head">✨ 助手想要执行</div>
                  <div className="mc-text" data-testid="action-confirm-text">
                    {pending.kind === 'task' && <>把「{pending.text}」加进今日计划</>}
                    {pending.kind === 'study' && (
                      <>
                        记一条{pending.itemKind}：「{pending.text}」
                        {pending.course ? `（科目：${pending.course}）` : ''}
                      </>
                    )}
                    {pending.kind === 'memo' && <>记一条备忘：「{pending.text}」</>}
                    {pending.kind === 'workout' && (
                      <>记一次健身打卡{pending.note ? `（备注：${pending.note}）` : ''}</>
                    )}
                    {pending.kind === 'weight' && <>记录体重 {pending.value} kg</>}
                    {pending.kind === 'meal' && (
                      <>记一顿{MEAL_SLOT_LABEL[pending.slot]}：「{pending.text}」</>
                    )}
                  </div>
                  {pending.kind === 'task' && (
                    <div className="input-row">
                      <span className="row-sub">日期</span>
                      <input
                        type="date"
                        className="input"
                        style={{ maxWidth: 150 }}
                        data-testid="action-task-date"
                        value={pending.date}
                        onChange={(e) => setPending({ ...pending, date: e.target.value })}
                      />
                    </div>
                  )}
                  {pending.kind === 'study' && (
                    <>
                      <div className="input-row">
                        <span className="row-sub">类型</span>
                        <select
                          className="input"
                          style={{ maxWidth: 120 }}
                          data-testid="action-study-kind"
                          value={pending.itemKind}
                          onChange={(e) =>
                            setPending({ ...pending, itemKind: e.target.value as typeof pending.itemKind })
                          }
                        >
                          <option value="作业">作业</option>
                          <option value="考试">考试</option>
                          <option value="复习">复习</option>
                          <option value="其他">其他</option>
                        </select>
                        <span className="row-sub">截止</span>
                        <input
                          type="date"
                          className="input"
                          style={{ maxWidth: 150 }}
                          data-testid="action-study-due"
                          value={pending.due}
                          onChange={(e) => setPending({ ...pending, due: e.target.value })}
                        />
                      </div>
                    </>
                  )}
                  {pending.kind === 'meal' && (
                    <div className="input-row">
                      <span className="row-sub">哪一餐</span>
                      <select
                        className="input"
                        style={{ maxWidth: 130 }}
                        data-testid="action-meal-slot"
                        value={pending.slot}
                        onChange={(e) =>
                          setPending({ ...pending, slot: e.target.value as typeof pending.slot })
                        }
                      >
                        <option value="breakfast">早餐</option>
                        <option value="lunch">午餐</option>
                        <option value="dinner">晚餐</option>
                        <option value="snack">加餐</option>
                      </select>
                    </div>
                  )}
                  <div className="input-row">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-testid="action-confirm-ok"
                      onClick={executeAction}
                    >
                      ✓ 确认执行
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid="action-cancel"
                      onClick={() => setPending(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              <div className="input-row" style={{ marginTop: 12 }}>
                <label className="btn" style={{ cursor: 'pointer' }} title="发一张图给柳月虹看">
                  📷
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    data-testid="chat-image-input"
                    onChange={handleImagePick}
                  />
                </label>
                <label className="btn" style={{ cursor: 'pointer' }} title="发一段视频给柳月虹看">
                  🎬
                  <input
                    type="file"
                    accept="video/*"
                    style={{ display: 'none' }}
                    data-testid="chat-video-input"
                    onChange={handleVideoPick}
                  />
                </label>
                <input
                  className="input"
                  placeholder={status?.online ? '说点什么…（回车发送）' : warming ? '⏳ 模型正在启动，稍等一下…' : '先启动本地模型…'}
                  disabled={!status?.online || generating}
                  data-testid="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendChat();
                  }}
                />
                {generating ? (
                  <button type="button" className="btn" data-testid="chat-stop" onClick={stopChat}>
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="chat-send"
                    onClick={() => sendChat()}
                    disabled={!status?.online || (!chatInput.trim() && !pendingImage)}
                  >
                    🐾 发送
                  </button>
                )}
              </div>
              {pendingImage && (
                <div className="row-sub" style={{ marginTop: 6 }} data-testid="chat-image-preview">
                  {pendingImage.kind === 'video' ? '🎬' : '📷'} 已附{pendingImage.kind === 'video' ? '视频' : '图片'}（{pendingImage.file.name}）
                  ——发送后柳月虹会看，{pendingImage.kind === 'video' ? '视频要抽帧识别，稍慢' : '马上说她的感觉'}
                </div>
              )}
              {looking && (
                <div className="row-sub" style={{ marginTop: 6 }} data-testid="chat-looking">
                  👁 柳月虹正在看…
                </div>
              )}
              {memProps.length > 0 && (
                <div className="memory-confirm" data-testid="mem-propose">
                  <div className="mc-head">
                    {memProps[0].conflictWith ? '🌳 这条和你之前记的好像有出入' : '🌳 我想帮你记住'}
                  </div>
                  <div className="mc-text" data-testid="mem-propose-text">
                    {memProps[0].text}
                  </div>
                  {memProps[0].conflictWith && (
                    <div className="row-sub" data-testid="mem-propose-conflict">
                      之前记的是：{memProps[0].conflictWith}
                    </div>
                  )}
                  <div className="input-row">
                    <select
                      className="input"
                      style={{ maxWidth: 150 }}
                      data-testid="mem-propose-branch"
                      value={memPropBranch}
                      onChange={(e) => setMemPropBranch(e.target.value as BranchKey)}
                    >
                      {BRANCHES.map((b) => (
                        <option key={b.key} value={b.key}>
                          {b.emoji} {b.label}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-primary btn-sm" data-testid="mem-propose-ok" onClick={saveProposed}>
                      ✓ 记下来
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" data-testid="mem-propose-cancel" onClick={ignoreProposed}>
                      不用了
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 快捷操作 */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">快捷操作</span>
            <div className="grow" />
            <span className="row-sub">不用翻页面，点一下就能记</span>
          </div>
          <div className="quick-grid">
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                className="quick-btn"
                data-testid={`quick-${a.key}`}
                onClick={() => setCurrent(a.key)}
              >
                <span className="quick-icon">{a.icon}</span>
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <Modal open={current !== null} title={modalTitle} onClose={() => setCurrent(null)} testid="quick-modal">
        {current === 'task' && (
          <>
            <div className="field">
              <label className="field-label">任务内容</label>
              <input
                className="input"
                autoFocus
                data-testid="q-task-title"
                value={taskForm.title}
                onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                }}
              />
            </div>
            <div className="field">
              <label className="field-label">日期</label>
              <input
                type="date"
                className="input"
                data-testid="q-task-date"
                value={taskForm.date}
                onChange={(e) => setTaskForm({ ...taskForm, date: e.target.value })}
              />
            </div>
            <div className="input-row" style={{ alignItems: 'flex-start' }}>
              <div className="field grow">
                <label className="field-label">时间</label>
                <input
                  type="time"
                  className="input"
                  data-testid="q-task-time"
                  value={taskForm.time}
                  onChange={(e) => setTaskForm({ ...taskForm, time: e.target.value })}
                />
              </div>
              <div className="field grow">
                <label className="field-label">预计时间</label>
                <input
                  className="input"
                  placeholder="比如 1 小时"
                  data-testid="q-task-estimate"
                  value={taskForm.estimate}
                  onChange={(e) => setTaskForm({ ...taskForm, estimate: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label">备注（选填）</label>
              <input
                className="input"
                data-testid="q-task-note"
                value={taskForm.note}
                onChange={(e) => setTaskForm({ ...taskForm, note: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">优先级</label>
              <select
                className="input"
                data-testid="q-task-priority"
                value={taskForm.priority}
                onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
              >
                <option value="none">无</option>
                <option value="mid">中</option>
                <option value="high">高</option>
              </select>
            </div>
          </>
        )}

        {current === 'study' && (
          <>
            <div className="field">
              <label className="field-label">内容</label>
              <input
                className="input"
                autoFocus
                placeholder="比如：第三章课后习题"
                data-testid="q-study-title"
                value={studyForm.title}
                onChange={(e) => setStudyForm({ ...studyForm, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                }}
              />
            </div>
            <div className="input-row" style={{ alignItems: 'flex-start' }}>
              <div className="field grow">
                <label className="field-label">科目（选填）</label>
                <input
                  className="input"
                  placeholder="比如：高等数学"
                  data-testid="q-study-course"
                  value={studyForm.course}
                  onChange={(e) => setStudyForm({ ...studyForm, course: e.target.value })}
                />
              </div>
              <div className="field grow">
                <label className="field-label">类型</label>
                <select
                  className="input"
                  data-testid="q-study-kind"
                  value={studyForm.kind}
                  onChange={(e) => setStudyForm({ ...studyForm, kind: e.target.value as typeof studyForm.kind })}
                >
                  <option value="作业">作业</option>
                  <option value="考试">考试</option>
                  <option value="复习">复习</option>
                  <option value="其他">其他</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label className="field-label">截止日期（选填）</label>
              <input
                type="date"
                className="input"
                data-testid="q-study-due"
                value={studyForm.due}
                onChange={(e) => setStudyForm({ ...studyForm, due: e.target.value })}
              />
            </div>
          </>
        )}

        {current === 'memo' && (
          <div className="field">
            <label className="field-label">一句话</label>
            <input
              className="input"
              autoFocus
              data-testid="q-memo-text"
              value={memoText}
              onChange={(e) => setMemoText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
            />
          </div>
        )}
        {current === 'workout' && (
          <div className="field">
            <label className="field-label">备注（选填）</label>
            <input
              className="input"
              autoFocus
              placeholder="比如：卧推加了 2.5kg"
              data-testid="q-workout-note"
              value={workoutNote}
              onChange={(e) => setWorkoutNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
            />
          </div>
        )}

        {current === 'weight' && (
          <div className="field">
            <label className="field-label">体重（kg）</label>
            <input
              className="input"
              autoFocus
              inputMode="decimal"
              data-testid="q-weight"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
            />
          </div>
        )}

        {current === 'hours' && (
          <>
            {data.clients.length === 0 ? (
              <div className="confirm-text" data-testid="q-hours-empty">
                还没有客户，先去「咨询工作」里新建一个客户，再回来记工时。
              </div>
            ) : (
              <>
                <div className="field">
                  <label className="field-label">客户</label>
                  <select
                    className="input"
                    data-testid="q-hours-client"
                    value={hoursForm.clientId}
                    onChange={(e) => setHoursForm({ ...hoursForm, clientId: e.target.value })}
                  >
                    <option value="">选一个客户…</option>
                    {data.clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">小时数</label>
                  <input
                    className="input"
                    inputMode="decimal"
                    data-testid="q-hours-hours"
                    value={hoursForm.hours}
                    onChange={(e) => setHoursForm({ ...hoursForm, hours: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="field-label">备注（选填）</label>
                  <input
                    className="input"
                    data-testid="q-hours-note"
                    value={hoursForm.note}
                    onChange={(e) => setHoursForm({ ...hoursForm, note: e.target.value })}
                  />
                </div>
              </>
            )}
          </>
        )}

        {current === 'idea' && (
          <div className="field">
            <label className="field-label">灵感内容</label>
            <input
              className="input"
              autoFocus
              data-testid="q-idea-text"
              value={ideaText}
              onChange={(e) => setIdeaText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
            />
          </div>
        )}

        {current === 'meal' && (
          <>
            <div className="field">
              <label className="field-label">哪一餐</label>
              <select
                className="input"
                data-testid="q-meal-slot"
                value={mealForm.slot}
                onChange={(e) => setMealForm({ ...mealForm, slot: e.target.value as typeof mealForm.slot })}
              >
                <option value="breakfast">早餐</option>
                <option value="lunch">午餐</option>
                <option value="dinner">晚餐</option>
                <option value="snack">加餐</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label">吃了什么</label>
              <input
                className="input"
                autoFocus
                data-testid="q-meal-text"
                value={mealForm.text}
                onChange={(e) => setMealForm({ ...mealForm, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                }}
              />
            </div>
          </>
        )}

        {current === 'playtime' && (
          <>
            {data.gameItems.length === 0 ? (
              <div className="confirm-text" data-testid="q-playtime-empty">
                还没有条目，先去「游戏娱乐」里添加一个，再回来记时长。
              </div>
            ) : (
              <>
                <div className="field">
                  <label className="field-label">哪一个</label>
                  <select
                    className="input"
                    data-testid="q-playtime-item"
                    value={playForm.itemId}
                    onChange={(e) => setPlayForm({ ...playForm, itemId: e.target.value })}
                  >
                    <option value="">选一个…</option>
                    {data.gameItems.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">时长（小时）</label>
                  <input
                    className="input"
                    inputMode="decimal"
                    data-testid="q-playtime-hours"
                    value={playForm.hours}
                    onChange={(e) => setPlayForm({ ...playForm, hours: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSave();
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setCurrent(null)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="q-save" onClick={handleSave}>
            记下来
          </button>
        </div>
      </Modal>

        </div>
        {tool && (
          <aside className="assistant-toolbox" data-testid="assistant-toolbox">
            <div className="toolbox-head">
              <span className="toolbox-title">🧰 工具箱</span>
              <div className="grow" />
              <button
                type="button"
                className="link-more"
                data-testid="toolbox-close"
                onClick={() => setTool(null)}
              >
                ✕ 收起
              </button>
            </div>
            <div className="toolbox-tabs">
              {MODULE_TABS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`toolbox-tab${tool === m.key ? ' active' : ''}`}
                  data-testid={`toolbox-${m.key}`}
                  onClick={() => setTool(m.key)}
                >
                  {m.emoji} {m.label}
                  {badgeCounts[m.key] ? (
                    <span className="tab-badge" data-testid={`badge-${m.key}`}>
                      {badgeCounts[m.key]}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="toolbox-body">
              {tool === 'overview' && <Home onNavigate={openTool} />}
              {tool === 'today' && <Today />}
              {tool === 'study' && <Study />}
              {tool === 'fitness' && <Fitness />}
              {tool === 'diet' && <Diet />}
              {tool === 'games' && <Games />}
              {tool === 'media' && <Media />}
              {tool === 'dev' && <Dev />}
              {tool === 'consulting' && <Consulting />}
              {tool === 'design' && <Design />}
              {tool === 'materials' && (
                <Materials
                  onReadText={(name, text) => {
                    setTool(null);
                    sendChat(
                      `【文件：${name}】
${text}

（请读一下这个文件的内容；我没有另外提问的话，就先概括要点）`,
                      true,
                    );
                  }}
                />
              )}
              {tool === 'memory' && <MemoryTree />}
              {tool === 'screen' && <ScreenTab />}
              {tool === 'settings' && <SettingsPage />}
            </div>
          </aside>
        )}
      </div>

      {toast && (
        <Toast
          message={toast.msg}
          actionLabel={toast.memoryUndo ? '撤销' : toast.tool || toast.target ? '去看看' : undefined}
          onAction={
            toast.memoryUndo
              ? () => void undoMemory(toast.memoryUndo as string)
              : toast.tool || toast.target
                ? () => {
                    if (toast.tool) setTool(toast.tool);
                    else if (toast.target) openTool(toast.target);
                    setToast(null);
                  }
                : undefined
          }
          onClose={() => setToast(null)}
          testid="assistant-toast"
        />
      )}
    </section>
  );
}
