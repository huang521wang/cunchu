import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { api, pFetch } from '../lib/api';
import type { MetaInfo } from '../lib/api';
import { fmtTime, today } from '../lib/date';
import { Modal, Toast } from '../components/common';
import KbCard from '../components/KbCard';
import type { ModelEntry } from '../types';

interface ModelStatusRow {
  id: string;
  name: string;
  type: 'local' | 'cloud';
  online: boolean;
  active: boolean;
  note?: string;
}

/** 常用服务商预设：一击填好地址（模型名只是建议，可以改/也可以测试后拉取） */
const MODEL_PRESETS: { id: string; label: string; type: ModelEntry['type']; baseUrl: string; model: string; hint?: string }[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方 API',
    type: 'cloud',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '按量计费，余额不足会提示 402',
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    type: 'cloud',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    type: 'cloud',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: 'glm-4-flash 有免费额度',
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面）',
    type: 'cloud',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  {
    id: 'siliconflow',
    label: '硅基流动（SiliconFlow）',
    type: 'cloud',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  { id: 'local', label: '本机模型（llama.cpp）', type: 'local', baseUrl: 'http://127.0.0.1:8081/v1', model: '' },
  { id: 'custom', label: '自定义（OpenAI 兼容接口）', type: 'cloud', baseUrl: '', model: '' },
];

const OVERVIEW_LABELS: { key: string; label: string }[] = [
  { key: 'tasks', label: '任务' },
  { key: 'memos', label: '备忘' },
  { key: 'memories', label: '记忆' },
  { key: 'chatMessages', label: '对话消息' },
  { key: 'studyItems', label: '学习任务' },
  { key: 'lessonNotes', label: '录音笔记' },
  { key: 'files', label: '素材文件' },
  { key: 'documents', label: '文档' },
  { key: 'ideas', label: '灵感' },
  { key: 'contentItems', label: '自媒体内容' },
  { key: 'publishStats', label: '发布数据' },
  { key: 'projects', label: '开发项目' },
  { key: 'projectTasks', label: '项目任务' },
  { key: 'devLogs', label: '进展记录' },
  { key: 'clients', label: '客户' },
  { key: 'followUps', label: '跟进事项' },
  { key: 'commLogs', label: '沟通记录' },
  { key: 'timeEntries', label: '工时记录' },
  { key: 'workoutLogs', label: '训练记录' },
  { key: 'weightLogs', label: '体重记录' },
  { key: 'mealDays', label: '饮食记录' },
  { key: 'gameItems', label: '娱乐条目' },
  { key: 'playLogs', label: '时长记录' },
];

const THEMES: { key: 'light' | 'dark' | 'system'; label: string }[] = [
  { key: 'light', label: '浅色（少女风）' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
];

export default function SettingsPage() {
  const { data, settings, updateSettings, reload } = useStore();
  const [meta, setMeta] = useState<MetaInfo | null>(null);
  const [pendingImport, setPendingImport] = useState<null | {
    backup: unknown;
    counts: Record<string, number>;
  }>(null);
  const [importError, setImportError] = useState('');
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [pName, setPName] = useState('');
  const [pCall, setPCall] = useState('');
  const [pFreedom, setPFreedom] = useState<'quiet' | 'free' | 'active'>('free');
  const [newTrait, setNewTrait] = useState('');
  const persona = settings.persona;

  useEffect(() => {
    if (persona) {
      setPName(persona.name || '柳月虹');
      setPCall(persona.addressAs || '阿珑');
      setPFreedom(persona.freedom || 'free');
    }
  }, [persona?.name, persona?.addressAs, persona?.freedom]);

  const savePersona = async (patch: Record<string, unknown>) => {
    await pFetch('/api/persona', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await reload();
  };

  const reflectNow = async () => {
    try {
      const r = await pFetch('/api/persona/reflect', { method: 'POST' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '反思失败');
      await reload();
      setToast('✓ 她刚刚回顾了你们的对话，性格档案更新了');
    } catch (e) {
      setToast(`反思没成功：${(e as Error).message}`);
    }
  };
  const [modelsStatus, setModelsStatus] = useState<ModelStatusRow[] | null>(null);
  const [modelEdit, setModelEdit] = useState<null | { mode: 'new' | 'edit'; entry: ModelEntry }>(null);
  const [presetId, setPresetId] = useState('');
  const [testState, setTestState] = useState<null | { busy?: boolean; ok?: boolean; msg: string; models?: string[] }>(null);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = MODEL_PRESETS.find((x) => x.id === id);
    if (!p || !modelEdit) return;
    setTestState(null);
    setModelEdit({
      ...modelEdit,
      entry: {
        ...modelEdit.entry,
        type: p.type,
        baseUrl: p.baseUrl || modelEdit.entry.baseUrl,
        model: p.model || modelEdit.entry.model,
        note: modelEdit.entry.note || p.hint || '',
      },
    });
  };

  const testModel = async () => {
    if (!modelEdit) return;
    const e = modelEdit.entry;
    setTestState({ busy: true, msg: '正在连接…' });
    try {
      const r = await pFetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: e.baseUrl, apiKey: e.apiKey || '' }),
      });
      const j = await r.json();
      if (j.ok) {
        setTestState({
          ok: true,
          msg: j.models && j.models.length ? `连接成功 ✓ 拉到 ${j.models.length} 个可用模型，下面选一个` : '连接成功 ✓（对方没提供模型列表，手动填模型名即可）',
          models: j.models || [],
        });
      } else {
        setTestState({ ok: false, msg: `连不上：${j.error}` });
      }
    } catch {
      setTestState({ ok: false, msg: '测试请求失败，稍后再试' });
    }
  };

  const loadModelsStatus = () => {
    pFetch('/api/models/status')
      .then((r) => r.json())
      .then(setModelsStatus)
      .catch(() => setModelsStatus(null));
  };

  interface LocalModelRow {
    kind: string;
    label: string;
    note?: string;
    port: number;
    online: boolean;
    files: boolean;
    running: boolean;
  }

  const [localModels, setLocalModels] = useState<LocalModelRow[] | null>(null);
  const [starting, setStarting] = useState<string[]>([]); // 正在启动的模型 kind（显示"启动中"）
  const [allBusy, setAllBusy] = useState(false); // 一键全部关闭/启动进行中（防呆：忙态不可再点）

  // AI 画图已迁入「AI 助手」对话（「画：xxx」出图 / 「画图密钥：xxx」装 Key），此处不再放独立窗口

  const loadLocal = () => {
    pFetch('/api/local/status')
      .then((r) => r.json())
      .then((j) => setLocalModels(j.models || []))
      .catch(() => setLocalModels(null));
  };

  const startLocal = async (kind: string) => {
    setStarting((prev) => [...prev, kind]);
    try {
      const r = await pFetch('/api/local/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      if (!r.ok) {
        setStarting((prev) => prev.filter((k) => k !== kind));
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '启动失败');
      }
      const j = await r.json().catch(() => ({}));
      // 自动关掉的冲突模型：提示给用户（傻瓜式：不用自己先关）
      const labelOf = (k: string) => (localModels || []).find((m) => m.kind === k)?.label || k;
      const closed = Array.isArray(j.stopped) ? j.stopped.map(labelOf) : [];
      setToast(
        closed.length
          ? `⏳ 正在启动…（已自动关闭 ${closed.join('、')}，共用一个显卡位）`
          : '⏳ 正在启动模型…（约 20~30 秒，好了自动亮绿）',
      );
      // 启动期间每 3 秒刷新一次状态，起来就停
      let tries = 0;
      const poll = setInterval(async () => {
        tries += 1;
        try {
          const j2 = await (await pFetch('/api/local/status')).json();
          setLocalModels(j2.models || []);
          const row = (j2.models || []).find((m: { kind: string; online: boolean }) => m.kind === kind);
          if (row?.online || tries >= 20) {
            clearInterval(poll);
            setStarting((prev) => prev.filter((k) => k !== kind));
          }
        } catch {
          clearInterval(poll);
          setStarting((prev) => prev.filter((k) => k !== kind));
        }
      }, 3000);
    } catch (e) {
      setToast(`启动失败：${(e as Error).message}`);
    }
    loadLocal();
  };

  const stopLocal = async (kind: string) => {
    await pFetch('/api/local/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    loadLocal();
  };

  // 一键全部关闭 / 一键全部启动（防呆：进行中按钮变忙，不可重复点）
  const toggleAll = async () => {
    const anyOnline = (localModels || []).some((m) => m.kind !== 'whisper' && m.online);
    setAllBusy(true);
    try {
      if (anyOnline) {
        const j = await (
          await pFetch('/api/local/stop-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).json();
        setToast(`✓ 已全部关闭（${(j.stopped || []).length} 个模型）`);
        loadLocal();
      } else {
        setToast('⏳ 正在一键启动模型…（约 20~30 秒）');
        const j = await (
          await pFetch('/api/local/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }),
          })
        ).json();
        if (j && Array.isArray(j.started) && j.started.length) {
          setToast(`✓ 已启动：${j.started.join('、')}`);
        }
        loadLocal();
      }
    } catch (e) {
      setToast(`操作失败：${(e as Error).message}`);
    } finally {
      setAllBusy(false);
    }
  };

  // 「设为当前」= 切换模型：自动关掉正在跑的冲突模型，并把新模型启动起来
  const useModel = async (id: string) => {
    await updateSettings({ activeModelId: id });
    try {
      const j = await (
        await pFetch('/api/local/ensure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id, force: true }),
        })
      ).json();
      if (j && Array.isArray(j.started) && j.started.length) {
        setToast(`✓ 已切换（旧模型已自动关闭）⏳ 正在启动：${j.started.join('、')}`);
      } else if (j && j.error && j.reason !== 'not-local') {
        setToast(`切换完成，但启动没成功：${j.error}`);
      }
    } catch {
      // 管家不可用不拦着切换
    }
    loadLocal();
  };

  const modelsList = settings.models ?? [];

  const saveModelEntry = async () => {
    if (!modelEdit) return;
    const e = modelEdit.entry;
    const model = e.model.trim();
    const baseUrl = e.baseUrl.trim().replace(/\/$/, '');
    const name = e.name.trim() || `${e.type === 'cloud' ? '云端' : '本机'} · ${model}`;
    const entry: ModelEntry = {
      ...e,
      id: e.id || `m-${Date.now().toString(36)}`,
      name,
      baseUrl,
      model,
    };
    const list = e.id ? modelsList.map((x) => (x.id === entry.id ? entry : x)) : [...modelsList, entry];
    setModelEdit(null);
    await updateSettings({ models: list });
    loadModelsStatus();
  };

  const loadBriefing = () => {
    pFetch(`/api/briefing?date=${today()}`)
      .then((r) => r.json())
      .then((b) => setBriefing(b.text as string))
      .catch(() => setBriefing('（简报生成失败，刷新试试）'));
  };

  useEffect(() => {
    loadBriefing();
    loadModelsStatus();
    loadLocal();
  }, [data]);

  const refreshMeta = () => {
    api
      .meta()
      .then(setMeta)
      .catch(() => {});
  };

  useEffect(() => {
    refreshMeta();
  }, [data]);

  const kb = meta ? Math.max(1, Math.round(meta.size / 1024)) : 0;

  const doExport = async () => {
    const backup = await api.exportAll();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `工作台备份-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    refreshMeta();
    setToast('✓ 备份文件已导出，记得放到别的地方存一份');
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError('');
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup || typeof backup !== 'object' || !backup.data || typeof backup.data !== 'object') {
        throw new Error('not a backup');
      }
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(backup.data as Record<string, unknown>)) {
        if (Array.isArray(v)) counts[k] = v.length;
      }
      setPendingImport({ backup, counts });
    } catch {
      setImportError('这个文件看起来不是工作台的备份文件');
    } finally {
      e.target.value = '';
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    await api.importAll(pendingImport.backup);
    setPendingImport(null);
    await reload();
    refreshMeta();
    setToast('✓ 数据已恢复（恢复前的数据已自动备份在 data 文件夹里）');
  };

  const doWipe = async () => {
    if (wipeText !== '清空') return;
    await api.wipe('清空');
    setWipeOpen(false);
    setWipeText('');
    await reload();
    refreshMeta();
    setToast('已清空全部数据（清空前已自动备份）');
  };

  return (
    <section className="page" data-testid="page-settings">
      <h1 className="page-title">数据与设置</h1>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <span className="card-title">备份</span>
          </div>
          <div className="input-row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" data-testid="export-btn" onClick={doExport}>
              导出全部数据
            </button>
            <span className="row-sub">导出一个文件，可以放网盘或别的盘；换电脑时用它恢复</span>
          </div>
          <div className="input-row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <input
              type="file"
              accept=".json,application/json"
              data-testid="import-file"
              onChange={onFile}
            />
            <span className="row-sub">从备份恢复（恢复前会自动先备份当前数据）</span>
          </div>
          {importError && (
            <div className="text-danger" style={{ marginTop: 8 }} data-testid="import-error">
              {importError}
            </div>
          )}
          <div className="row-sub" style={{ marginTop: 14 }} data-testid="data-location">
            数据实时保存在：{meta ? meta.dataDir : '读取中…'}
            {meta && ` （${kb} KB · 最近更新 ${meta.updatedAt ? fmtTime(meta.updatedAt) : '—'} · 备份 ${meta.backupCount} 份）`}
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm" data-testid="open-folder" onClick={() => api.reveal()}>
              打开数据文件夹
            </button>
          </div>
        </div>

        {/* AI 画图已迁入「AI 助手」对话：说「画：xxx」出图，「画图密钥：xxx」装 Key */}

        <div className="card">
          <div className="card-head">
            <span className="card-title">外观</span>
          </div>
          <div className="input-row" style={{ flexWrap: 'wrap' }}>
            {THEMES.map((t) => (
              <label key={t.key} className="radio-line">
                <input
                  type="radio"
                  name="theme"
                  data-testid={`theme-${t.key}`}
                  checked={settings.theme === t.key}
                  onChange={() => updateSettings({ theme: t.key })}
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>

        <KbCard />

        <div className="card">
          <div className="card-head">
            <span className="card-title">数据概览</span>
          </div>
          <div className="overview-grid" data-testid="overview-grid">
            {OVERVIEW_LABELS.map((o) => {
              const n = (data as unknown as Record<string, unknown[]>)[o.key]?.length ?? 0;
              return (
                <div className="overview-item" key={o.key} data-testid={`overview-${o.key}`}>
                  <span className="overview-num">{n}</span>
                  <span className="row-sub">{o.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">AI 助手</span>
          </div>
          <label className="radio-line" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              data-testid="memory-toggle"
              checked={settings.memoryEnabled !== false}
              onChange={(e) => updateSettings({ memoryEnabled: e.target.checked })}
            />
            让助手使用记忆（对话时带上「记忆树」里的内容）
          </label>
          <label className="radio-line" style={{ cursor: 'pointer', marginTop: 8 }}>
            <input
              type="checkbox"
              data-testid="auto-memory-toggle"
              checked={settings.autoMemory !== false}
              onChange={(e) => updateSettings({ autoMemory: e.target.checked })}
            />
            自动发现值得记住的话（聊完/屏幕整理后自动进行）
          </label>
          <label className="radio-line" style={{ cursor: 'pointer', marginTop: 8 }}>
            <input
              type="checkbox"
              data-testid="memory-mode-toggle"
              checked={(settings.memoryMode ?? 'auto') === 'ask'}
              onChange={(e) => updateSettings({ memoryMode: e.target.checked ? 'ask' : 'auto' })}
            />
            每条都要我确认（默认关 = 静默自动记忆，只弹 5 秒「已记住」可撤销；只有和旧记忆矛盾时才问）
          </label>
        </div>

        <div className="card" data-testid="models-card">
          <div className="card-head">
            <span className="card-title">🤖 AI 模型</span>
            <div className="grow" />
            <button type="button" className="link-more" data-testid="models-refresh" onClick={loadModelsStatus}>
              刷新状态
            </button>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            当前用哪个模型，对话和录音总结都跟着它。以后加了别的本地模型，各用各的端口（比如 8081）就行。
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {modelsList.map((m) => {
              const st = modelsStatus?.find((x) => x.id === m.id);
              const active = settings.activeModelId === m.id;
              return (
                <div className="list-row" key={m.id} data-testid={`model-row-${m.id}`}>
                  <span
                    className={`model-dot${st ? (st.online ? ' on' : ' off') : ''}`}
                    title={st ? (st.online ? '在线' : '连不上（可能没启动）') : '状态检测中…'}
                    data-testid={`model-dot-${m.id}`}
                  />
                  <span className="text grow">
                    {m.name}
                    <span className="row-sub">
                      {' '}
                      · {m.type === 'cloud' ? '云端' : '本机'} · {m.model}
                      {m.note ? ` · ${m.note}` : ''}
                    </span>
                  </span>
                  {active ? (
                    <span className="chip chip-mint" data-testid={`model-active-${m.id}`}>
                      当前
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid={`model-use-${m.id}`}
                      onClick={() => void useModel(m.id)}
                    >
                      设为当前
                    </button>
                  )}
                  <div className="hover-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="编辑"
                      data-testid={`model-edit-${m.id}`}
                      onClick={() => {
                        setPresetId('');
                        setTestState(null);
                        setModelEdit({ mode: 'edit', entry: { ...m } });
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title={modelsList.length <= 1 ? '至少要留一个模型' : '删除'}
                      data-testid={`model-del-${m.id}`}
                      disabled={modelsList.length <= 1}
                      onClick={() => updateSettings({ models: modelsList.filter((x) => x.id !== m.id) })}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="input-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="model-add"
              onClick={() => {
                setPresetId('');
                setTestState(null);
                setModelEdit({
                  mode: 'new',
                  entry: { id: '', name: '', type: 'local', baseUrl: 'http://127.0.0.1:8081/v1', model: '', apiKey: '', note: '' },
                });
              }}
            >
              ＋ 添加模型
            </button>
            <span className="row-sub">比如以后装第二个本地模型，就再开一个端口填进来</span>
          </div>
          <label className="radio-line" style={{ cursor: 'pointer', marginTop: 10 }}>
            <input
              type="checkbox"
              data-testid="auto-route-toggle"
              checked={settings.autoRoute !== false}
              onChange={(e) => updateSettings({ autoRoute: e.target.checked })}
            />
            自动调度（模型协同）：按问题在你勾选的模型里自动切换，目标离线自动换别的（勾选在 AI 助手页做）
          </label>
          <label className="radio-line" style={{ cursor: 'pointer', marginTop: 10 }}>
            <input
              type="checkbox"
              data-testid="auto-manage-toggle"
              checked={settings.autoManage !== false}
              onChange={(e) => updateSettings({ autoManage: e.target.checked })}
            />
            模型管家：打开 AI 助手自动启动模型；自动调度需要别的模型时自动切换，并自动关掉冲突的模型
          </label>
        </div>

        <div className="card" data-testid="local-models">
          <div className="card-head">
            <span className="card-title">🧠 我的模型（柳月虹的大脑）</span>
            <div className="grow" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="local-all-toggle"
              disabled={allBusy}
              onClick={() => void toggleAll()}
            >
              {allBusy
                ? '⏳ 处理中…'
                : (localModels || []).some((m) => m.kind !== 'whisper' && m.online)
                  ? '🔴 一键全部关闭'
                  : '🟢 一键全部启动'}
            </button>
            <button type="button" className="link-more" data-testid="local-refresh" onClick={loadLocal}>
              刷新
            </button>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            一个她，三种感官——聊天（说话）、视觉（看图看视频）、语音（听录音）。全部本机离线；点右边的开关就行，不用记端口。聊天模型共用一个显卡位：开另一个会自动关掉当前这个。
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {(localModels || []).map((m) => {
              const isStarting = starting.includes(m.kind);
              const isChat = ['chat', 'qwen', 'coder'].includes(m.kind);
              return (
                <div className="list-row model-row" key={m.kind} data-testid={`local-${m.kind}`}>
                  <span className={`model-dot ${m.online ? 'on' : 'off'}${isStarting ? ' pulsing' : ''}`} />
                  <span className="text grow">
                    <span className="model-row-name">{m.label}</span>
                    {m.note ? <span className="model-note">{m.note}</span> : null}
                  </span>
                  {m.kind === 'whisper' ? (
                    <span className="model-status model-status-ready" data-testid={`local-status-${m.kind}`}>
                      按需自动调用
                    </span>
                  ) : !m.files ? (
                    <span className="model-status model-status-off" data-testid={`local-status-${m.kind}`}>
                      未下载
                    </span>
                  ) : isStarting ? (
                    <span className="model-status model-status-starting" data-testid={`local-status-${m.kind}`}>
                      ⏳ 启动中…
                    </span>
                  ) : m.online ? (
                    <span className="model-status model-status-on" data-testid={`local-status-${m.kind}`}>
                      ● 运行中
                    </span>
                  ) : (
                    <span className="model-status model-status-off" data-testid={`local-status-${m.kind}`}>
                      已关闭{isChat ? ' · 共享显卡' : ''}
                    </span>
                  )}
                  {m.kind !== 'whisper' && m.files && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={m.online}
                      aria-label={`${m.label} ${m.online ? '关闭' : '打开'}`}
                      className={`model-switch${m.online ? ' on' : ''}${isStarting ? ' busy' : ''}`}
                      data-testid={`local-switch-${m.kind}`}
                      disabled={isStarting}
                      onClick={() => (m.online ? stopLocal(m.kind) : startLocal(m.kind))}
                    >
                      <span className="knob" />
                    </button>
                  )}
                </div>
              );
            })}
            {localModels === null && <div className="row-sub">状态加载中…</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">📨 提醒简报</span>
            <div className="grow" />
            <button type="button" className="link-more" data-testid="briefing-refresh" onClick={loadBriefing}>
              刷新
            </button>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            这就是将来每天定时发给你（QQ 机器人 / 邮箱）的内容——本机生成，只读你自己的数据，不联网外发。
          </div>
          <pre className="briefing-text" data-testid="briefing-preview">
            {briefing ?? '生成中…'}
          </pre>
        </div>

        <div className="card" data-testid="persona-settings">
          <div className="card-head">
            <span className="card-title">🌸 她（{persona?.name || '柳月虹'}）</span>
            <div className="grow" />
            <button type="button" className="btn btn-blue btn-sm" data-testid="persona-reflect" onClick={reflectNow}>
              现在反思一次
            </button>
          </div>
          <div className="row-sub" style={{ lineHeight: 2, marginBottom: 8 }}>
            她不预设性格——每聊 6~8 轮会自己回顾一次，慢慢形成「她的性格」。你也可以手动补充一条、删掉不喜欢的，或者重新开始。
          </div>
          <div className="input-row">
            <div className="field grow">
              <label className="field-label">她的名字</label>
              <input
                className="input"
                data-testid="persona-name-input"
                value={pName}
                onChange={(e) => setPName(e.target.value)}
                onBlur={() => savePersona({ name: pName })}
              />
            </div>
            <div className="field grow">
              <label className="field-label">她怎么称呼你</label>
              <input
                className="input"
                data-testid="persona-call-input"
                value={pCall}
                onChange={(e) => setPCall(e.target.value)}
                onBlur={() => savePersona({ addressAs: pCall })}
              />
            </div>
            <div className="field">
              <label className="field-label">自由程度</label>
              <select
                className="input"
                data-testid="persona-freedom"
                value={pFreedom}
                onChange={(e) => {
                  const v = e.target.value as 'quiet' | 'free' | 'active';
                  setPFreedom(v);
                  savePersona({ freedom: v });
                }}
              >
                <option value="quiet">安静（只回答）</option>
                <option value="free">自由（会主动关心你）</option>
                <option value="active">活泼（更爱说话）</option>
              </select>
            </div>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label">性格档案（在相处中慢慢形成）</label>
            {(persona?.traits || []).length === 0 ? (
              <div className="row-sub" style={{ padding: '6px 0' }}>
                还是空的——多聊几轮，或点上面的「现在反思一次」。
              </div>
            ) : (
              <div className="list">
                {(persona?.traits || []).map((t, i) => (
                  <div className="list-row" key={i} data-testid={`persona-trait-${i}`}>
                    <span className="text grow">{t.text}</span>
                    <span className="chip chip-gray">强度 {t.weight}</span>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删掉这条"
                        data-testid={`persona-trait-del-${i}`}
                        onClick={() => savePersona({ traits: persona!.traits.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="input-row" style={{ marginTop: 8 }}>
              <input
                className="input grow"
                placeholder="手动补充一条，比如：说话喜欢带小小的比喻"
                data-testid="persona-trait-input"
                value={newTrait}
                onChange={(e) => setNewTrait(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTrait.trim()) {
                    savePersona({
                      traits: [...(persona?.traits || []), { text: newTrait.trim(), weight: 1, source: 'manual' }],
                    });
                    setNewTrait('');
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-blue btn-sm"
                data-testid="persona-trait-add"
                disabled={!newTrait.trim()}
                onClick={() => {
                  savePersona({
                    traits: [...(persona?.traits || []), { text: newTrait.trim(), weight: 1, source: 'manual' }],
                  });
                  setNewTrait('');
                }}
              >
                补充
              </button>
            </div>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label">梦记（睡着时做的梦，最近 5 场）</label>
            {(persona?.dreams || []).length === 0 ? (
              <div className="row-sub" style={{ padding: '6px 0' }}>
                还没做过梦（她睡着以后 10~50 分钟会做第一场）。
              </div>
            ) : (
              <div className="list">
                {[...(persona?.dreams || [])]
                  .reverse()
                  .slice(0, 5)
                  .map((d, i) => (
                    <div className="list-row" key={i}>
                      <span className="text grow">💭 {d.text}</span>
                      <span className="row-sub">{d.at.slice(0, 10)}</span>
                    </div>
                  ))}
              </div>
            )}
            <div className="input-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="persona-dreams-clear"
                onClick={() => savePersona({ clearDreams: true })}
              >
                清空梦记
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="persona-reset"
                onClick={() => savePersona({ reset: true })}
              >
                重新开始（清空性格/心事/梦）
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title text-danger">危险区</span>
          </div>
          <div className="input-row" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-danger"
              data-testid="wipe-btn"
              onClick={() => {
                setWipeText('');
                setWipeOpen(true);
              }}
            >
              清空全部数据
            </button>
            <span className="row-sub">清空前会自动备份一份当前数据</span>
          </div>
        </div>
      </div>

      {/* 恢复预览 */}
      <Modal
        open={pendingImport !== null}
        title="确认从这份备份恢复？"
        onClose={() => setPendingImport(null)}
        testid="import-preview"
      >
        <div className="confirm-text">这份备份里有：</div>
        <div className="preview-chips">
          {pendingImport &&
            OVERVIEW_LABELS.filter((o) => (pendingImport.counts[o.key] ?? 0) > 0).map((o) => (
              <span className="chip chip-blue" key={o.key}>
                {o.label} {pendingImport.counts[o.key]}
              </span>
            ))}
        </div>
        <div className="confirm-text" style={{ marginTop: 10 }}>
          恢复后当前的数据会被替换（替换前会自动备份一份）。
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setPendingImport(null)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="import-confirm" onClick={confirmImport}>
            确认恢复
          </button>
        </div>
      </Modal>

      {/* 清空确认 */}
      <Modal open={wipeOpen} title="清空全部数据" onClose={() => setWipeOpen(false)} testid="wipe-modal">
        <div className="confirm-text">
          这个操作会把所有模块的数据清空（清空前会自动备份一份）。想好了的话，在下面输入「清空」两个字：
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <input
            className="input"
            data-testid="wipe-input"
            value={wipeText}
            onChange={(e) => setWipeText(e.target.value)}
            placeholder="清空"
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setWipeOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="wipe-confirm"
            disabled={wipeText !== '清空'}
            onClick={doWipe}
          >
            清空全部数据
          </button>
        </div>
      </Modal>

      {/* 模型编辑 */}
      <Modal
        open={modelEdit !== null}
        title={modelEdit?.mode === 'edit' ? '编辑模型' : '添加模型'}
        onClose={() => setModelEdit(null)}
        testid="model-modal"
      >
        {modelEdit && (
          <>
            <div className="field">
              <label className="field-label">常用服务商（选一个自动填好地址）</label>
              <select
                className="input"
                data-testid="model-form-preset"
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">— 手动填写 —</option>
                {MODEL_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">名称（随便起，能认出就行）</label>
              <input
                className="input"
                autoFocus
                data-testid="model-form-name"
                placeholder="比如：深度思考"
                value={modelEdit.entry.name}
                onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, name: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="field-label">服务地址</label>
              <input
                className="input"
                data-testid="model-form-url"
                placeholder="http://127.0.0.1:8081/v1"
                value={modelEdit.entry.baseUrl}
                onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, baseUrl: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="field-label">模型名</label>
              <input
                className="input"
                data-testid="model-form-model"
                placeholder="启动模型窗口里显示的名字"
                value={modelEdit.entry.model}
                onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, model: e.target.value } })}
              />
            </div>
            <div className="input-row" style={{ alignItems: 'flex-start' }}>
              <div className="field grow">
                <label className="field-label">类型</label>
                <select
                  className="input"
                  data-testid="model-form-type"
                  value={modelEdit.entry.type}
                  onChange={(e) =>
                    setModelEdit({
                      ...modelEdit,
                      entry: { ...modelEdit.entry, type: e.target.value as ModelEntry['type'] },
                    })
                  }
                >
                  <option value="local">本机模型</option>
                  <option value="cloud">云端模型</option>
                </select>
              </div>
              <div className="field grow">
                <label className="field-label">密钥（只有云端才要）</label>
                <input
                  className="input"
                  type="password"
                  data-testid="model-form-key"
                  placeholder="只存在这台电脑上"
                  value={modelEdit.entry.apiKey || ''}
                  onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, apiKey: e.target.value } })}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label">备注（选填）</label>
              <input
                className="input"
                data-testid="model-form-note"
                placeholder="比如：免费离线、快/慢"
                value={modelEdit.entry.note || ''}
                onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, note: e.target.value } })}
              />
            </div>
            <div className="input-row">
              <button
                type="button"
                className="btn btn-blue btn-sm"
                data-testid="model-form-test"
                disabled={!modelEdit.entry.baseUrl.trim() || Boolean(testState?.busy)}
                onClick={testModel}
              >
                {testState?.busy ? '连接中…' : '🔌 测试连接'}
              </button>
              {testState && !testState.busy && (
                <span
                  className={testState.ok ? 'row-sub' : 'text-danger'}
                  style={{ fontSize: 12.5 }}
                  data-testid="model-form-test-result"
                >
                  {testState.msg}
                </span>
              )}
            </div>
            {testState?.ok && testState.models && testState.models.length > 0 && (
              <div className="field">
                <label className="field-label">对方可用的模型（选一个就填到上面）</label>
                <select
                  className="input"
                  data-testid="model-form-models"
                  value={testState.models.includes(modelEdit.entry.model) ? modelEdit.entry.model : ''}
                  onChange={(e) => setModelEdit({ ...modelEdit, entry: { ...modelEdit.entry, model: e.target.value } })}
                >
                  <option value="">— 选择模型 —</option>
                  {testState.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {modelEdit.entry.type === 'cloud' && (
              <div className="text-danger" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                注意：云端模型的对话内容会离开这台电脑（走对方的服务器），并按量计费——余额不足时会提示 402。
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setModelEdit(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="model-form-save"
                disabled={!modelEdit.entry.baseUrl.trim() || !modelEdit.entry.model.trim()}
                onClick={saveModelEntry}
              >
                保存
              </button>
            </div>
          </>
        )}
      </Modal>

      {toast && <Toast message={toast} onClose={() => setToast(null)} testid="settings-toast" />}
    </section>
  );
}
