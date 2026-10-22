import { useCallback, useEffect, useState } from 'react';
import { pFetch } from '../lib/api';

/**
 * 学习通卡片（计划 B）：邮箱官方 IMAP 收通知 → 作业排草稿 → QQ/界面双确认 → 复制提交。
 * 零脚本碰学习通账号；授权码只存本机。
 */

interface XxtCfg {
  enabled: boolean;
  host: string;
  user: string;
  authCodeSet: boolean;
  lastUid: number;
  lastError: string;
  lastPollAt: number;
}
interface Notice {
  id: string;
  kind: string;
  course: string;
  title: string;
  due: string;
  at: number;
}
interface Homework {
  id: string;
  status: 'new' | 'drafted' | 'confirmed' | 'failed' | 'reading' | 'read_failed' | 'submitting' | 'submitted' | 'submit_failed';
  course: string;
  title: string;
  due: string;
  requirement: string;
  draft: string;
  note: string;
  needUpload?: boolean;
  submitHint?: string;
}

const KIND_ICON: Record<string, string> = { homework: '📕', exam: '📝', checkin: '⏰', grade: '🎯', other: '🔔' };
const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  new: { label: '制作中…', cls: 'chip-blue' },
  drafted: { label: '草稿好了', cls: 'chip-mint' },
  confirmed: { label: '已确认', cls: 'chip-pink' },
  failed: { label: '没做成', cls: 'chip-gray' },
  reading: { label: '读题中…', cls: 'chip-blue' },
  read_failed: { label: '读题失败', cls: 'chip-gray' },
  submitting: { label: '提交中…', cls: 'chip-blue' },
  submitted: { label: '已提交 ✓', cls: 'chip-mint' },
  submit_failed: { label: '提交没成', cls: 'chip-gray' },
};

interface DirectStatus {
  status: string;
  connected: boolean;
  lastSyncAt: number;
  syncMsg: string;
  seen: number;
  loginBusy: boolean;
  syncing: boolean;
}

export default function XxtCard() {
  const [cfg, setCfg] = useState<XxtCfg | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [homeworks, setHomeworks] = useState<Homework[]>([]);
  const [user, setUser] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [host, setHost] = useState('imap.qq.com');
  const [customHost, setCustomHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [redoNote, setRedoNote] = useState<Record<string, string>>({});
  const [simMail, setSimMail] = useState('');
  const [direct, setDirect] = useState<DirectStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await (await pFetch('/api/mailwatch')).json();
      setCfg(j.config);
      setNotices(j.notices || []);
      setHomeworks(j.homeworks || []);
      setUser((u) => u || j.config.user || '');
      setHost((h) => h || j.config.host || 'imap.qq.com');
    } catch {
      /* 服务没起就静默 */
    }
    try {
      setDirect(await (await pFetch('/api/xxt/status')).json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const save = async (patch: Record<string, unknown>, pollNow = false) => {
    setBusy(true);
    try {
      const r = await pFetch('/api/mailwatch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, ...(pollNow ? { pollNow: true } : {}) }),
      });
      const j = await r.json();
      if (pollNow && j.test && j.test.ok) setToast(`已连上邮箱${j.test.count ? `，这轮 ${j.test.count} 条学习通通知` : '，一切正常 ✓'}`);
      else if (pollNow && j.test && !j.test.ok) setToast(`邮箱连接失败：${j.test.error || '看下授权码/网络'}`);
      else if (pollNow) setToast('要填好授权码并打开开关，才能测试连接');
      else setToast('已保存 ✓');
      await load();
    } catch {
      setToast('保存失败：工作台服务没在跑？');
    } finally {
      setBusy(false);
    }
  };

  const confirmHw = async (h: Homework) => {
    try {
      const j = await (
        await pFetch('/api/xxt/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: h.id }) })
      ).json();
      if (j.ok) {
        setToast('已确认，草稿全文也推送到 QQ 了 ✓');
        await load();
      } else setToast(j.error || '确认失败');
    } catch {
      setToast('确认失败');
    }
  };

  const redoHw = async (h: Homework) => {
    try {
      await pFetch('/api/xxt/redo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: h.id, note: (redoNote[h.id] || '').trim() }),
      });
      setToast('🔁 已开始按新方向重做，稍等…');
      setTimeout(load, 6000);
    } catch {
      setToast('重做启动失败');
    }
  };

  const copyDraft = async (h: Homework) => {
    try {
      await navigator.clipboard.writeText(h.draft);
      setToast('全文已复制，去粘贴提交吧 ✓');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = h.draft;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setToast('全文已复制 ✓');
    }
  };

  /* ---- 读题干：钻进作业详情页把老师要求读全，读完自动按全文重做草稿 ---- */
  const [confirmSubmitId, setConfirmSubmitId] = useState<string | null>(null);
  const readHw = async (h: Homework) => {
    setBusy(true);
    try {
      const r = await pFetch('/api/xxt/homework/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: h.id }) });
      const j = await r.json();
      setToast(j.ok ? '🔍 去读题了，读完自动重做草稿，稍等…' : j.error || '读题启动失败');
      setTimeout(load, 15000);
    } catch {
      setToast('读题启动失败');
    } finally {
      setBusy(false);
    }
  };
  /* ---- 提交：两次点击确认（第一下变红"真交？"，第二下才真的往学习通交） ---- */
  const submitHw = async (h: Homework) => {
    if (confirmSubmitId !== h.id) {
      setConfirmSubmitId(h.id);
      setToast('再点一次「真交」就替你提交到学习通');
      return;
    }
    setConfirmSubmitId(null);
    setBusy(true);
    try {
      const r = await pFetch('/api/xxt/homework/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: h.id }) });
      const j = await r.json();
      setToast(j.ok ? '🚀 正在提交，几分钟后看状态' : j.error || '提交启动失败');
      setTimeout(load, 20000);
    } catch {
      setToast('提交启动失败');
    } finally {
      setBusy(false);
    }
  };

  /* ---- 直连学习通（方案 A：只读同步） ---- */
  const doConnect = async () => {
    setBusy(true);
    try {
      const r = await pFetch('/api/xxt/connect', { method: 'POST' });
      const j = await r.json();
      setToast(j.ok ? '🖥 ' + j.message : j.error || '打开登录窗口失败');
      setTimeout(load, 3000);
    } catch {
      setToast('连不上工作台服务');
    } finally {
      setBusy(false);
    }
  };

  const doDirectSync = async () => {
    setBusy(true);
    try {
      const j = await (await pFetch('/api/xxt/sync', { method: 'POST' })).json();
      setToast(j.ok ? `✓ 同步完成：${j.courses} 门课，新通知 ${j.newCount ?? 0} 条` : j.error || j.syncMsg || '同步失败');
      setTimeout(load, 1200);
    } catch {
      setToast('同步请求失败');
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    try {
      await pFetch('/api/xxt/disconnect', { method: 'POST' });
      setToast('已退出学习通连接 ✓（已入库的作业记录保留）');
      await load();
    } catch {
      setToast('退出失败');
    }
  };

  const DIRECT_LABEL: Record<string, { t: string; cls: string }> = {
    off: { t: '直连：未连接', cls: 'chip-gray' },
    ready: { t: '直连：已连接', cls: 'chip-mint' },
    synced: { t: '直连：已同步', cls: 'chip-mint' },
    need_login: { t: '直连：登录过期，点重连', cls: 'chip-pink' },
    error: { t: '直连：异常', cls: 'chip-gray' },
  };

  const simulate = async () => {
    if (!simMail.trim()) return;
    setBusy(true);
    try {
      const j = await (
        await pFetch('/api/mailwatch/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: simMail, subject: simMail.split('\n')[0].slice(0, 80) }),
        })
      ).json();
      setToast(j.added ? '✓ 认出来了！已进通知列表（真实邮件同样处理）' : '这封没认出是学习通通知——发我原文我调规则');
      setSimMail('');
      await load();
    } catch {
      setToast('自测失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="xxt-card">
      <div className="card-head">
        <span className="card-title">🎓 学习通桥（做作业草稿 · 盯通知）</span>
        {direct && direct.status !== 'off' ? (
          <span className={`chip ${DIRECT_LABEL[direct.status]?.cls || 'chip-gray'}`} data-testid="xxt-direct-state">
            {DIRECT_LABEL[direct.status]?.t || direct.status}
          </span>
        ) : (
          cfg && (
            <span className={`chip ${cfg.enabled ? 'chip-mint' : 'chip-gray'}`} data-testid="xxt-state">
              {cfg.enabled ? '邮箱监听中' : '未连接'}
            </span>
          )
        )}
      </div>

      {/* ⓪ 直连学习通：登录一次，之后只读自动同步（推荐） */}
      <div data-testid="xxt-direct-box" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || direct?.loginBusy} data-testid="xxt-connect-btn" onClick={() => void doConnect()}>
            {direct?.loginBusy ? '⏳ 等你在浏览器里登录…' : direct?.connected ? '🔄 重连（刷新登录态）' : '🔗 连接学习通（只读）'}
          </button>
          {direct?.connected && (
            <button type="button" className="btn btn-blue btn-sm" disabled={busy || direct?.syncing} data-testid="xxt-sync-btn" onClick={() => void doDirectSync()}>
              {direct?.syncing ? '⏳ 同步中…' : '立即同步一次'}
            </button>
          )}
          {direct?.connected && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} data-testid="xxt-drop-btn" onClick={() => void doDisconnect()}>
              退出连接
            </button>
          )}
        </div>
        <div className="row-sub" style={{ marginTop: 4 }}>
          登录后每 30 分钟自动"看"一遍你的课程/作业/考试/签到通知（只读：不提交、不代签、不刷课）。密码只在你自己弹出的浏览器里输，工作台不留存。
          {direct?.syncMsg ? ` · ${direct.syncMsg}` : ''}
          {direct?.lastSyncAt ? ` · 上次同步 ${new Date(direct.lastSyncAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>

      <div className="row-sub" style={{ lineHeight: 1.9, marginBottom: 8 }}>
        走学习通官方的邮件通知 + 邮箱官方协议（免费）。作业来了它直接做：可按「读题目」把老师要求读全再重做；做好后一键复制自己交，或按「帮我提交」（要按两下确认）由它代填代交——附件/拍照类只读题不代交。
      </div>

      {/* ① 通知列表 */}
      {notices.length > 0 && (
        <div className="list" style={{ marginBottom: 10 }} data-testid="xxt-notices">
          {notices.slice(0, 8).map((n) => (
            <div className="list-row" key={n.id} data-testid={`xxt-notice-${n.id}`}>
              <span>{KIND_ICON[n.kind] || '🔔'}</span>
              <span className="text grow">
                {n.course ? `《${n.course}》` : ''}
                {n.title}
                {n.due ? <span className="row-sub"> · 截止 {n.due}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ② 作业草稿 */}
      {homeworks.length > 0 && (
        <div className="stack" style={{ gap: 8, marginBottom: 10 }}>
          {homeworks.slice(0, 6).map((h) => {
            const chip = STATUS_CHIP[h.status] || STATUS_CHIP.new;
            const open = openDraft === h.id;
            return (
              <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} key={h.id} data-testid={`xxt-hw-${h.id}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="text grow">
                    {h.course ? `《${h.course}》` : ''}
                    {h.title}
                    {h.due ? <span className="row-sub"> · 截止 {h.due}</span> : null}
                  </span>
                  <span className={`chip ${chip.cls}`} data-testid={`xxt-hw-status-${h.id}`}>{chip.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-ghost btn-sm" data-testid={`xxt-hw-view-${h.id}`} disabled={!h.draft} onClick={() => setOpenDraft(open ? null : h.id)}>
                    {open ? '收起草稿' : '看草稿'}
                  </button>
                  {open && h.draft && (
                    <>
                      <button type="button" className="btn btn-blue btn-sm" data-testid={`xxt-hw-copy-${h.id}`} onClick={() => void copyDraft(h)}>
                        📋 复制全文
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" data-testid={`xxt-hw-confirm-${h.id}`} disabled={h.status === 'confirmed'} onClick={() => void confirmHw(h)}>
                        {h.status === 'confirmed' ? '已确认 ✓' : '✓ 确认这版'}
                      </button>
                    </>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" data-testid={`xxt-hw-read-${h.id}`} disabled={h.status === 'reading' || h.status === 'submitting'} onClick={() => void readHw(h)}>
                    {h.status === 'reading' ? '🔍 读题中…' : '🔍 读题目'}
                  </button>
                  {h.status !== 'submitted' && h.status !== 'submitting' && (
                    <button
                      type="button"
                      className={`btn btn-sm ${confirmSubmitId === h.id ? 'btn-primary' : 'btn-ghost'}`}
                      data-testid={`xxt-hw-submit-${h.id}`}
                      disabled={!h.draft || h.needUpload || busy}
                      title={h.needUpload ? '这道题要上传文件，得自己动手' : '把草稿填进学习通并交掉（要按两下）'}
                      onClick={() => void submitHw(h)}
                    >
                      {confirmSubmitId === h.id ? '⚠️ 真交？再点一下' : '🚀 帮我提交'}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" data-testid={`xxt-hw-redo-${h.id}`} onClick={() => void redoHw(h)}>
                    🔁 重做
                  </button>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder="重做方向（如：少点字、别写例子）"
                    value={redoNote[h.id] || ''}
                    onChange={(e) => setRedoNote({ ...redoNote, [h.id]: e.target.value })}
                  />
                </div>
                {h.submitHint && <div className="row-sub" data-testid={`xxt-hw-hint-${h.id}`}>💡 {h.submitHint}</div>}
                {open && h.draft && (
                  <div className="think" style={{ whiteSpace: 'pre-wrap' }} data-testid={`xxt-hw-draft-${h.id}`}>
                    {h.draft}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ③ 配置区 */}
      <div className="input-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="input" style={{ maxWidth: 130 }} value={host} onChange={(e) => setHost(e.target.value)} data-testid="xxt-host">
          <option value="imap.qq.com">QQ 邮箱</option>
          <option value="imap.163.com">163 邮箱</option>
          <option value="imap.126.com">126 邮箱</option>
          <option value="custom">其他/学校邮箱</option>
        </select>
        {host === 'custom' && (
          <input
            className="input"
            style={{ maxWidth: 190 }}
            placeholder="IMAP 服务器（问邮箱客服要）"
            value={customHost}
            onChange={(e) => setCustomHost(e.target.value)}
            data-testid="xxt-customhost"
          />
        )}
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="绑定学习通的邮箱（如 123@qq.com）" value={user} onChange={(e) => setUser(e.target.value)} data-testid="xxt-user" />
        <input
          className="input"
          style={{ flex: 1, minWidth: 150 }}
          placeholder={cfg?.authCodeSet ? '授权码已存（输入新的可替换）' : '邮箱 IMAP 授权码（不是登录密码）'}
          type="password"
          value={authCode}
          onChange={(e) => setAuthCode(e.target.value)}
          data-testid="xxt-authcode"
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-blue btn-sm" disabled={busy} data-testid="xxt-save" onClick={() => void save({ user, host: host === 'custom' ? customHost.trim() : host, ...(authCode.trim() ? { authCode: authCode.trim() } : {}) })}>
          保存配置
        </button>
        <button
          type="button"
          className={`btn btn-sm ${cfg?.enabled ? 'btn-ghost' : 'btn-primary'}`}
          disabled={busy}
          data-testid="xxt-toggle"
          onClick={() => void save({ enabled: !cfg?.enabled })}
        >
          {cfg?.enabled ? '关闭监听' : '开启监听'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} data-testid="xxt-test" onClick={() => void save({ user, host: host === 'custom' ? customHost.trim() : host, ...(authCode.trim() ? { authCode: authCode.trim() } : {}) }, true)}>
          📶 测试收信一次
        </button>
      </div>
      {cfg?.lastError && (
        <div className="text-danger row-sub" style={{ marginTop: 6 }} data-testid="xxt-error">
          上次连接问题：{cfg.lastError}
        </div>
      )}
      {cfg?.lastPollAt ? <div className="row-sub" style={{ marginTop: 4 }}>上次收信：{new Date(cfg.lastPollAt).toLocaleTimeString('zh-CN')}</div> : null}

      {/* ④ 自测解析（不开邮箱也能试） */}
      <details style={{ marginTop: 10 }} data-testid="xxt-sim">
        <summary className="row-sub" data-testid="xxt-sim-toggle">🧪 自测：粘一条学习通通知邮件，看能不能被认出</summary>
        <textarea className="input" rows={3} style={{ marginTop: 6 }} placeholder="粘贴学习通发你的通知邮件原文…" value={simMail} onChange={(e) => setSimMail(e.target.value)} data-testid="xxt-sim-input" />
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} disabled={busy || !simMail.trim()} data-testid="xxt-sim-run" onClick={() => void simulate()}>
          试解析
        </button>
      </details>

      {toast && (
        <div className="p-toast" data-testid="xxt-toast">
          {toast}
        </div>
      )}
    </div>
  );
}
