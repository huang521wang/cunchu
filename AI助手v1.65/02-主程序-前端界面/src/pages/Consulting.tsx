import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtMD, monthStr, today, weekRange } from '../lib/date';
import type { Client, FollowUp } from '../types';
import { Confirm, EmptyState } from '../components/common';

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtHours = (h: number) => (h >= 0.01 ? `${round2(h)}h` : '<0.01h');
const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

export default function Consulting() {
  const { data, create, update, remove } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'followups' | 'commlogs' | 'time'>('followups');
  const [clientDraft, setClientDraft] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [followText, setFollowText] = useState('');
  const [followDate, setFollowDate] = useState('');
  const [editFollowId, setEditFollowId] = useState<string | null>(null);
  const [editFollowText, setEditFollowText] = useState('');
  const [commText, setCommText] = useState('');
  const [commDate, setCommDate] = useState(today());
  const [timerStart, setTimerStart] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [timerNote, setTimerNote] = useState('');
  const [mDate, setMDate] = useState(today());
  const [mHours, setMHours] = useState('');
  const [mNote, setMNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<null | (() => void)>(null);

  const clients = data.clients;
  const selected = clients.find((c) => c.id === selectedId) ?? clients[0];

  /* ----- 计时器 ----- */
  useEffect(() => {
    if (timerStart === null) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [timerStart]);

  useEffect(() => {
    document.title = timerStart !== null ? `⏱ ${fmtDur(nowTick - timerStart)} · AI 助手` : 'AI 助手';
  }, [timerStart, nowTick]);

  useEffect(
    () => () => {
      document.title = 'AI 助手';
    },
    [],
  );

  const startTimer = () => {
    setNowTick(Date.now());
    setTimerStart(Date.now());
  };

  const stopTimer = async () => {
    if (timerStart === null || !selected) return;
    const ms = Date.now() - timerStart;
    const note = timerNote;
    setTimerStart(null);
    setTimerNote('');
    const hours = Math.round((ms / 3600000) * 10000) / 10000;
    await create('timeEntries', { clientId: selected.id, date: today(), hours, note, source: 'timer' });
  };

  /* ----- 客户 ----- */
  const addClient = async () => {
    const name = clientDraft.trim();
    if (!name) return;
    setClientDraft('');
    const created = await create('clients', { name, note: '' });
    setSelectedId(created.id);
    setTab('followups');
  };

  const selectClient = (id: string) => {
    setSelectedId(id);
    setNameDraft(null);
    setNoteDraft(null);
    setTab('followups');
  };

  const commitName = () => {
    const value = nameDraft;
    setNameDraft(null);
    if (selected && value !== null && value.trim() && value !== selected.name) {
      update('clients', selected.id, { name: value.trim() });
    }
  };

  const commitNote = () => {
    const value = noteDraft;
    setNoteDraft(null);
    if (selected && value !== null && value !== (selected.note ?? '')) {
      update('clients', selected.id, { note: value });
    }
  };

  const deleteClient = (client: Client) => {
    setConfirmDel(() => async () => {
      await remove('clients', client.id);
      for (const f of data.followUps.filter((x) => x.clientId === client.id)) await remove('followUps', f.id);
      for (const c of data.commLogs.filter((x) => x.clientId === client.id)) await remove('commLogs', c.id);
      for (const e of data.timeEntries.filter((x) => x.clientId === client.id)) await remove('timeEntries', e.id);
      setSelectedId(null);
    });
  };

  /* ----- 工时统计 ----- */
  const { start: weekStart, end: weekEnd } = weekRange();
  const sumHours = (list: { hours: number }[]) => round2(list.reduce((s, e) => s + e.hours, 0));
  const clientTime = selected ? data.timeEntries.filter((e) => e.clientId === selected.id) : [];
  const clientMonth = sumHours(clientTime.filter((e) => e.date.startsWith(monthStr())));
  const allMonthTotal = sumHours(data.timeEntries.filter((e) => e.date.startsWith(monthStr())));
  const weekTotal = sumHours(clientTime.filter((e) => e.date >= weekStart && e.date <= weekEnd));
  const monthTotal = clientMonth;

  const addManual = async () => {
    if (!selected) return;
    const hours = Number(mHours);
    if (!hours || hours <= 0) return;
    const note = mNote.trim();
    const date = mDate || today();
    setMHours('');
    setMNote('');
    await create('timeEntries', { clientId: selected.id, date, hours, note, source: 'manual' });
  };

  /* ----- 跟进 / 沟通 ----- */
  const addFollowUp = async () => {
    if (!selected) return;
    const text = followText.trim();
    if (!text) return;
    const dueDate = followDate;
    setFollowText('');
    setFollowDate('');
    await create('followUps', { clientId: selected.id, text, dueDate, done: false });
  };

  const commitFollowEdit = async () => {
    const id = editFollowId;
    if (!id) return;
    setEditFollowId(null);
    const text = editFollowText.trim();
    if (text) await update('followUps', id, { text });
  };

  const addCommLog = async () => {
    if (!selected) return;
    const text = commText.trim();
    if (!text) return;
    const date = commDate || today();
    setCommText('');
    await create('commLogs', { clientId: selected.id, date, text });
  };

  const followUps = selected
    ? data.followUps
        .filter((f) => f.clientId === selected.id)
        .sort(
          (a, b) =>
            Number(a.done) - Number(b.done) ||
            (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') ||
            a.createdAt.localeCompare(b.createdAt),
        )
    : [];

  const commLogs = selected
    ? data.commLogs
        .filter((c) => c.clientId === selected.id)
        .sort((a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0))
    : [];

  const timeList = [...clientTime].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0),
  );

  const isOverdue = (f: FollowUp) => !f.done && f.dueDate !== '' && f.dueDate < today();

  return (
    <section className="page" data-testid="page-consulting">
      <div className="page-head">
        <h1 className="page-title">咨询工作</h1>
        <div className="grow" />
        <span className="row-sub" data-testid="month-total">
          本月总工时 {allMonthTotal}h
        </span>
      </div>

      <div className="dev-layout">
        {/* 客户列表 */}
        <div className="card" style={{ alignSelf: 'start' }}>
          <div className="card-head">
            <span className="card-title">客户</span>
          </div>
          <div className="list" data-testid="client-list">
            {clients.length === 0 ? (
              <div className="row-sub" style={{ padding: '8px 6px' }}>
                还没有客户，下面新建一个吧
              </div>
            ) : (
              clients.map((c) => {
                const monthH = sumHours(
                  data.timeEntries.filter((e) => e.clientId === c.id && e.date.startsWith(monthStr())),
                );
                return (
                  <div
                    key={c.id}
                    className={`project-row${selected?.id === c.id ? ' active' : ''}`}
                    data-testid="client-row"
                    onClick={() => selectClient(c.id)}
                  >
                    <span className="dot dot-active" />
                    <span className="row-main">{c.name}</span>
                    {monthH > 0 && <span className="chip chip-mint">{monthH}h</span>}
                  </div>
                );
              })
            )}
          </div>
          <div className="input-row" style={{ marginTop: 10 }}>
            <input
              className="input"
              placeholder="＋ 新建客户…（回车）"
              data-testid="new-client"
              value={clientDraft}
              onChange={(e) => setClientDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addClient();
              }}
            />
          </div>
        </div>

        {/* 客户详情 */}
        {!selected ? (
          <div className="card" data-testid="consulting-empty">
            <EmptyState icon="💼" text="左边新建一个客户，开始记录咨询工作吧" />
          </div>
        ) : (
          <div className="stack" data-testid="client-detail">
            <div className="card">
              <div className="card-head" style={{ flexWrap: 'wrap' }}>
                <input
                  className="input project-name"
                  data-testid="client-name"
                  value={nameDraft ?? selected.name}
                  onFocus={() => setNameDraft(selected.name)}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="client-delete"
                  onClick={() => deleteClient(selected)}
                >
                  🗑 删除客户
                </button>
              </div>
              <input
                className="input"
                placeholder="备注（选填）"
                data-testid="client-note"
                value={noteDraft ?? selected.note ?? ''}
                onFocus={() => setNoteDraft(selected.note ?? '')}
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={commitNote}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <div className="row-sub" style={{ marginTop: 10 }} data-testid="time-totals">
                本周 {weekTotal}h · 本月 {monthTotal}h
              </div>
            </div>

            <div className="card">
              <div className="tabs" style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  className={`tab${tab === 'followups' ? ' active' : ''}`}
                  data-testid="tab-followups"
                  onClick={() => setTab('followups')}
                >
                  待办跟进
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'commlogs' ? ' active' : ''}`}
                  data-testid="tab-commlogs"
                  onClick={() => setTab('commlogs')}
                >
                  沟通记录
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'time' ? ' active' : ''}`}
                  data-testid="tab-time"
                  onClick={() => setTab('time')}
                >
                  工时
                </button>
              </div>

              {tab === 'followups' && (
                <div>
                  <div className="input-row" style={{ marginBottom: 10 }}>
                    <input
                      className="input"
                      placeholder="添加跟进事项…（回车）"
                      data-testid="followup-input"
                      value={followText}
                      onChange={(e) => setFollowText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addFollowUp();
                      }}
                    />
                    <input
                      type="date"
                      className="input day-pick"
                      data-testid="followup-date"
                      value={followDate}
                      onChange={(e) => setFollowDate(e.target.value)}
                    />
                  </div>
                  <div className="list" data-testid="followup-list">
                    {followUps.length === 0 ? (
                      <EmptyState icon="✅" text="没有待跟进的事，清爽～" />
                    ) : (
                      followUps.map((f) => (
                        <div className="list-row" key={f.id}>
                          <button
                            type="button"
                            className={`checkbox${f.done ? ' checked' : ''}`}
                            aria-label="完成"
                            data-testid={`followup-check-${f.id}`}
                            onClick={() => update('followUps', f.id, { done: !f.done })}
                          >
                            {f.done ? '♥' : ''}
                          </button>
                          {editFollowId === f.id ? (
                            <input
                              className="input"
                              autoFocus
                              value={editFollowText}
                              onChange={(e) => setEditFollowText(e.target.value)}
                              onBlur={commitFollowEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitFollowEdit();
                                if (e.key === 'Escape') setEditFollowId(null);
                              }}
                            />
                          ) : (
                            <span
                              className={`row-main${f.done ? ' done-text' : ''}`}
                              onClick={() => {
                                setEditFollowId(f.id);
                                setEditFollowText(f.text);
                              }}
                            >
                              {f.text}
                            </span>
                          )}
                          {f.dueDate && (
                            <span className={`chip ${isOverdue(f) ? 'text-danger' : 'chip-blue'}`}>
                              {fmtMD(f.dueDate)}
                              {isOverdue(f) ? ' 已逾期' : ''}
                            </span>
                          )}
                          <div className="hover-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="删除"
                              data-testid="followup-del"
                              onClick={() => remove('followUps', f.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {tab === 'commlogs' && (
                <div>
                  <div className="input-row" style={{ marginBottom: 10 }}>
                    <input
                      type="date"
                      className="input day-pick"
                      data-testid="commlog-date"
                      value={commDate}
                      onChange={(e) => setCommDate(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="这次聊了什么…（回车）"
                      data-testid="commlog-input"
                      value={commText}
                      onChange={(e) => setCommText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addCommLog();
                      }}
                    />
                  </div>
                  <div className="list" data-testid="commlog-list">
                    {commLogs.length === 0 ? (
                      <EmptyState icon="💬" text="还没有沟通记录" />
                    ) : (
                      commLogs.map((c) => (
                        <div className="list-row" key={c.id}>
                          <span className="row-sub" style={{ flex: '0 0 auto' }}>
                            {fmtMD(c.date)}
                          </span>
                          <span className="row-main">{c.text}</span>
                          <div className="hover-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="删除"
                              data-testid="commlog-del"
                              onClick={() => remove('commLogs', c.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {tab === 'time' && (
                <div>
                  <div className="input-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className={`btn ${timerStart === null ? 'btn-primary' : 'btn-mint'}`}
                      data-testid="timer-toggle"
                      onClick={timerStart === null ? startTimer : stopTimer}
                    >
                      {timerStart === null ? '▶ 开始计时' : '■ 停止并记录'}
                    </button>
                    <span className="timer-display" data-testid="timer-display">
                      {timerStart === null ? '00:00:00' : fmtDur(nowTick - timerStart)}
                    </span>
                    <input
                      className="input"
                      style={{ maxWidth: 220 }}
                      placeholder="这次做的什么（选填）"
                      data-testid="timer-note"
                      value={timerNote}
                      onChange={(e) => setTimerNote(e.target.value)}
                    />
                  </div>

                  <div className="input-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                    <input
                      type="date"
                      className="input day-pick"
                      data-testid="time-manual-date"
                      value={mDate}
                      onChange={(e) => setMDate(e.target.value)}
                    />
                    <input
                      className="input"
                      style={{ maxWidth: 120 }}
                      placeholder="小时数"
                      inputMode="decimal"
                      data-testid="time-manual-hours"
                      value={mHours}
                      onChange={(e) => setMHours(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addManual();
                      }}
                    />
                    <input
                      className="input"
                      placeholder="备注"
                      data-testid="time-manual-note"
                      value={mNote}
                      onChange={(e) => setMNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addManual();
                      }}
                    />
                    <button type="button" className="btn" data-testid="time-manual-add" onClick={addManual}>
                      手动记录
                    </button>
                  </div>

                  <div className="list" data-testid="time-list">
                    {timeList.length === 0 ? (
                      <EmptyState icon="⏱" text="还没有工时记录，点上面开始计时吧" />
                    ) : (
                      timeList.map((e) => (
                        <div className="list-row" key={e.id}>
                          <span className="row-sub" style={{ flex: '0 0 auto' }}>
                            {fmtMD(e.date)}
                          </span>
                          <span className="row-main">
                            {fmtHours(e.hours)} · {e.source === 'timer' ? '计时' : '手动'}
                            {e.note ? ` · ${e.note}` : ''}
                          </span>
                          <div className="hover-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="删除"
                              data-testid="time-del"
                              onClick={() => remove('timeEntries', e.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Confirm
        open={confirmDel !== null}
        title="确定删除这个客户吗？"
        text="跟进事项、沟通记录和工时都会一起删除。"
        onOk={() => {
          confirmDel?.();
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </section>
  );
}
