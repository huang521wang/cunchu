import { useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { WEEKDAYS, addDays, fmtMD, monthStr, today, weekdayIndex, weekRange } from '../lib/date';
import type { GameItem } from '../types';
import { Confirm, EmptyState, Modal, SlidePanel } from '../components/common';
import LineChart from '../components/LineChart';

const CATEGORY_LABEL: Record<GameItem['category'], string> = { game: '游戏', movie: '影视', other: '其他' };
const STATUS_LABEL: Record<GameItem['status'], string> = {
  wish: '想玩/想看',
  playing: '在玩/在看',
  done: '已完成',
  shelved: '搁置',
};
const STATUSES: GameItem['status'][] = ['wish', 'playing', 'done', 'shelved'];
const CATEGORIES: GameItem['category'][] = ['game', 'movie', 'other'];

const round2 = (n: number) => Math.round(n * 100) / 100;

export default function Games() {
  const { data, settings, create, update, remove, updateSettings } = useStore();
  const t = today();
  const todayIdx = weekdayIndex(t);
  const { start, end } = weekRange();

  /* ---- 周计划 + 打卡（和健身计划同一套结构） ---- */
  const gamePlan = settings.gamePlan ?? ['休息', '休息', '休息', '休息', '休息', '休息', '休息'];
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [planText, setPlanText] = useState('');
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkinForm, setCheckinForm] = useState({ itemId: '', hours: '', note: '' });

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const hasLog = (date: string) => data.playLogs.some((p) => p.date === date);
  const weekCount = data.playLogs.filter((p) => p.date >= start && p.date <= end).length;

  const startEditPlan = (idx: number) => {
    setEditingIdx(idx);
    setPlanText(gamePlan[idx] ?? '');
  };

  const commitPlan = async () => {
    if (editingIdx === null) return;
    const idx = editingIdx;
    setEditingIdx(null);
    const next = [...gamePlan];
    next[idx] = planText.trim() || '休息';
    await updateSettings({ gamePlan: next });
  };

  const checkIn = async () => {
    const hours = Number(checkinForm.hours);
    if (!checkinForm.itemId || !hours || hours <= 0) return;
    const payload = {
      itemId: checkinForm.itemId,
      date: t,
      hours: round2(hours),
      note: checkinForm.note.trim(),
    };
    setCheckinOpen(false);
    setCheckinForm({ itemId: '', hours: '', note: '' });
    await create('playLogs', payload);
  };

  /* ---- 记录 + 趋势 ---- */
  const itemName = (id: string) => data.gameItems.find((g) => g.id === id)?.name ?? '已删除的条目';
  const records = [...data.playLogs].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0),
  );

  const [chartRange, setChartRange] = useState<'30' | 'all'>('30');
  const daily = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.playLogs) m.set(p.date, (m.get(p.date) ?? 0) + p.hours);
    return [...m.entries()]
      .map(([date, hours]) => ({ id: date, value: round2(hours) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [data.playLogs]);
  const chartPts = chartRange === '30' ? daily.filter((d) => d.id >= addDays(t, -29)) : daily;

  /* ---- 游戏库（保留原有全部功能） ---- */
  const [filter, setFilter] = useState<'all' | GameItem['status']>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<{ name: string; category: GameItem['category']; status: GameItem['status'] }>(
    { name: '', category: 'game', status: 'wish' },
  );
  const [panelId, setPanelId] = useState<string | null>(null);
  const [panelForm, setPanelForm] = useState({
    name: '',
    category: 'game' as GameItem['category'],
    status: 'wish' as GameItem['status'],
    progressNote: '',
  });
  const [logItemId, setLogItemId] = useState<string | null>(null);
  const [logForm, setLogForm] = useState({ date: today(), hours: '', note: '' });
  const [confirmDel, setConfirmDel] = useState<null | (() => void)>(null);

  const editing = panelId ? data.gameItems.find((g) => g.id === panelId) : undefined;

  const totalHours = (itemId: string) =>
    round2(data.playLogs.filter((p) => p.itemId === itemId).reduce((s, p) => s + p.hours, 0));

  const monthHours = round2(
    data.playLogs.filter((p) => p.date.startsWith(monthStr())).reduce((s, p) => s + p.hours, 0),
  );
  const playingCount = data.gameItems.filter((g) => g.status === 'playing').length;

  const items = data.gameItems
    .filter((g) => filter === 'all' || g.status === filter)
    .sort((a, b) => {
      const order: Record<GameItem['status'], number> = { playing: 0, wish: 1, done: 2, shelved: 3 };
      return order[a.status] - order[b.status] || a.seq - b.seq;
    });

  const addItem = async () => {
    const name = addForm.name.trim();
    if (!name) return;
    setAddOpen(false);
    setAddForm({ name: '', category: 'game', status: 'wish' });
    const created = await create('gameItems', {
      name,
      category: addForm.category,
      status: addForm.status,
      progressNote: '',
    });
    setPanelId(created?.id ?? null);
    if (created) {
      setPanelForm({ name, category: addForm.category, status: addForm.status, progressNote: '' });
    }
  };

  const openPanel = (g: GameItem) => {
    setPanelId(g.id);
    setPanelForm({ name: g.name, category: g.category, status: g.status, progressNote: g.progressNote ?? '' });
  };

  const savePanel = async () => {
    if (!editing) return;
    const name = panelForm.name.trim();
    await update('gameItems', editing.id, {
      name: name || editing.name,
      category: panelForm.category,
      status: panelForm.status,
      progressNote: panelForm.progressNote,
    });
    setPanelId(null);
  };

  const addPlayLog = async () => {
    if (!logItemId) return;
    const hours = Number(logForm.hours);
    if (!hours || hours <= 0) return;
    const itemId = logItemId;
    const payload = {
      itemId,
      date: logForm.date || t,
      hours: round2(hours),
      note: logForm.note.trim(),
    };
    setLogItemId(null);
    setLogForm({ date: today(), hours: '', note: '' });
    await create('playLogs', payload);
  };

  const logsOf = (itemId: string) =>
    data.playLogs
      .filter((p) => p.itemId === itemId)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0));

  return (
    <section className="page" data-testid="page-games">
      <div className="page-head" style={{ flexWrap: 'wrap' }}>
        <h1 className="page-title">游戏娱乐</h1>
        <span className="chip chip-mint" data-testid="games-playing">
          在玩 {playingCount} 个
        </span>
        <span className="chip chip-blue" data-testid="games-week">
          本周 {weekCount} 次
        </span>
        <span className="row-sub" data-testid="games-month">
          本月娱乐 {monthHours}h
        </span>
        <div className="grow" />
        <button type="button" className="btn btn-primary" data-testid="game-add" onClick={() => setAddOpen(true)}>
          ＋ 添加
        </button>
      </div>

      <div className="stack">
        {/* 本周计划（和健身计划同样的样子） */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">本周计划</span>
            <div className="grow" />
            <span className="row-sub">点格子就能改，比如写"塞尔达"或"休息"</span>
          </div>
          <div className="plan-strip" data-testid="game-week-strip">
            {gamePlan.map((text, i) => (
              <div
                key={i}
                className={`plan-cell${i === todayIdx ? ' today' : ''}`}
                data-testid={`plan-cell-${i}`}
                onClick={() => startEditPlan(i)}
              >
                <div className="plan-day">{WEEKDAYS[i]}</div>
                {editingIdx === i ? (
                  <input
                    className="input"
                    autoFocus
                    value={planText}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPlanText(e.target.value)}
                    onBlur={commitPlan}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitPlan();
                      if (e.key === 'Escape') setEditingIdx(null);
                    }}
                  />
                ) : (
                  <>
                    <div className="plan-text">{text}</div>
                    {hasLog(weekDates[i]) && (
                      <div className="plan-check" data-testid={`plan-check-${i}`}>
                        ✓ 已玩
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="complete-play"
              onClick={() => setCheckinOpen(true)}
            >
              完成今日娱乐{gamePlan[todayIdx] && gamePlan[todayIdx] !== '休息' ? `（${gamePlan[todayIdx]}）` : ''}
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          {/* 娱乐记录 */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">娱乐记录</span>
            </div>
            <div className="list" data-testid="play-records">
              {records.length === 0 ? (
                <EmptyState icon="🎮" text="还没有记录，玩完点上面打个卡吧" />
              ) : (
                records.map((p) => (
                  <div className="list-row" key={p.id}>
                    <span className="row-sub" style={{ flex: '0 0 auto' }}>
                      {fmtMD(p.date)}
                    </span>
                    <span className="row-main">
                      《{itemName(p.itemId)}》 {p.hours}h{p.note ? ` · ${p.note}` : ''}
                    </span>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除这条记录"
                        data-testid="record-del"
                        onClick={() => remove('playLogs', p.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 时长趋势 */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">时长趋势</span>
              <div className="grow" />
              <div className="tabs">
                <button
                  type="button"
                  className={`tab${chartRange === '30' ? ' active' : ''}`}
                  data-testid="gchart-30"
                  onClick={() => setChartRange('30')}
                >
                  最近30天
                </button>
                <button
                  type="button"
                  className={`tab${chartRange === 'all' ? ' active' : ''}`}
                  data-testid="gchart-all"
                  onClick={() => setChartRange('all')}
                >
                  全部
                </button>
              </div>
            </div>
            <LineChart testid="games-chart" suffix="h" pts={chartPts} />
          </div>
        </div>

        {/* 游戏库 */}
        <div className="card">
          <div className="card-head" style={{ flexWrap: 'wrap' }}>
            <span className="card-title">游戏库</span>
            <div className="tabs" style={{ marginLeft: 6 }}>
              <button
                type="button"
                className={`tab${filter === 'all' ? ' active' : ''}`}
                data-testid="games-filter-all"
                onClick={() => setFilter('all')}
              >
                全部
              </button>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`tab${filter === s ? ' active' : ''}`}
                  data-testid={`games-filter-${s}`}
                  onClick={() => setFilter(s)}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {items.length === 0 ? (
            <EmptyState icon="🎮" text="这里空空的，点右上角添加一个想玩/想看的吧" />
          ) : (
            <div className="grid grid-3">
              {items.map((g) => (
                <div className="card summary-card" key={g.id} data-testid="game-card" onClick={() => openPanel(g)}>
                  <div className="card-head" style={{ marginBottom: 6 }}>
                    <span className="card-title" style={{ wordBreak: 'break-all' }}>
                      {g.name}
                    </span>
                    <div className="grow" />
                  </div>
                  <div className="kcard-meta" style={{ marginBottom: 8 }}>
                    <span className="chip chip-gray">{CATEGORY_LABEL[g.category]}</span>
                    <span className={`chip ${g.status === 'playing' ? 'chip-mint' : 'chip-blue'}`}>
                      {STATUS_LABEL[g.status]}
                    </span>
                  </div>
                  <div className="row-sub">累计 {totalHours(g.id)}h</div>
                  {g.progressNote && (
                    <div className="row-sub" style={{ marginTop: 4 }}>
                      进度：{g.progressNote}
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-blue"
                      data-testid="log-time"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLogItemId(g.id);
                      }}
                    >
                      ＋ 记时长
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 今日打卡 */}
      <Modal
        open={checkinOpen}
        title="完成今日娱乐 🎉"
        onClose={() => setCheckinOpen(false)}
        testid="checkin-modal"
      >
        {data.gameItems.length === 0 ? (
          <div className="confirm-text" data-testid="checkin-empty">
            还没有条目，先在下面的"游戏库"里添加一个，再回来打卡。
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field-label">玩的哪一个</label>
              <select
                className="input"
                data-testid="checkin-item"
                value={checkinForm.itemId}
                onChange={(e) => setCheckinForm({ ...checkinForm, itemId: e.target.value })}
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
              <label className="field-label">玩了多久（小时）</label>
              <input
                className="input"
                inputMode="decimal"
                placeholder="比如 1.5"
                data-testid="checkin-hours"
                value={checkinForm.hours}
                onChange={(e) => setCheckinForm({ ...checkinForm, hours: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">备注（选填）</label>
              <input
                className="input"
                data-testid="checkin-note"
                value={checkinForm.note}
                onChange={(e) => setCheckinForm({ ...checkinForm, note: e.target.value })}
              />
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setCheckinOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="checkin-save"
            disabled={data.gameItems.length === 0}
            onClick={checkIn}
          >
            打卡完成
          </button>
        </div>
      </Modal>

      {/* 添加条目 */}
      <Modal open={addOpen} title="添加一个" onClose={() => setAddOpen(false)} testid="game-modal">
        <div className="field">
          <label className="field-label">名称</label>
          <input
            className="input"
            autoFocus
            data-testid="game-name"
            value={addForm.name}
            onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addItem();
            }}
          />
        </div>
        <div className="field">
          <label className="field-label">类别</label>
          <select
            className="input"
            data-testid="game-category"
            value={addForm.category}
            onChange={(e) => setAddForm({ ...addForm, category: e.target.value as GameItem['category'] })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">状态</label>
          <select
            className="input"
            data-testid="game-status"
            value={addForm.status}
            onChange={(e) => setAddForm({ ...addForm, status: e.target.value as GameItem['status'] })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="game-save" onClick={addItem}>
            添加
          </button>
        </div>
      </Modal>

      {/* 记时长 */}
      <Modal
        open={logItemId !== null}
        title={`记一笔时长 · ${data.gameItems.find((g) => g.id === logItemId)?.name ?? ''}`}
        onClose={() => setLogItemId(null)}
        testid="playlog-modal"
      >
        <div className="field">
          <label className="field-label">玩了多久（小时）</label>
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            placeholder="比如 1.5"
            data-testid="playlog-hours"
            value={logForm.hours}
            onChange={(e) => setLogForm({ ...logForm, hours: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPlayLog();
            }}
          />
        </div>
        <div className="field">
          <label className="field-label">备注（选填）</label>
          <input
            className="input"
            data-testid="playlog-note"
            value={logForm.note}
            onChange={(e) => setLogForm({ ...logForm, note: e.target.value })}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setLogItemId(null)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="playlog-save" onClick={addPlayLog}>
            记下来
          </button>
        </div>
      </Modal>

      {/* 编辑条目 */}
      <SlidePanel open={editing !== undefined} title="编辑条目" onClose={() => setPanelId(null)} testid="game-panel">
        {editing && (
          <div>
            <div className="field">
              <label className="field-label">名称</label>
              <input
                className="input"
                data-testid="game-edit-name"
                value={panelForm.name}
                onChange={(e) => setPanelForm({ ...panelForm, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">类别</label>
              <select
                className="input"
                data-testid="game-edit-category"
                value={panelForm.category}
                onChange={(e) => setPanelForm({ ...panelForm, category: e.target.value as GameItem['category'] })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">状态</label>
              <select
                className="input"
                data-testid="game-edit-status"
                value={panelForm.status}
                onChange={(e) => setPanelForm({ ...panelForm, status: e.target.value as GameItem['status'] })}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">进度备注</label>
              <input
                className="input"
                placeholder="比如：第 3 章 / 第 5 集"
                data-testid="game-edit-progress"
                value={panelForm.progressNote}
                onChange={(e) => setPanelForm({ ...panelForm, progressNote: e.target.value })}
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="game-entry-delete"
                onClick={() =>
                  setConfirmDel(() => () => {
                    const id = editing.id;
                    setPanelId(null);
                    remove('gameItems', id);
                    for (const p of data.playLogs.filter((x) => x.itemId === id)) remove('playLogs', p.id);
                  })
                }
              >
                🗑 删除条目
              </button>
              <button type="button" className="btn btn-primary" data-testid="game-edit-save" onClick={savePanel}>
                保存
              </button>
            </div>

            <div style={{ marginTop: 22 }}>
              <div className="card-title" style={{ marginBottom: 8 }}>
                时长记录（累计 {totalHours(editing.id)}h）
              </div>
              <div className="list" data-testid="game-playlog-list">
                {logsOf(editing.id).length === 0 ? (
                  <div className="row-sub" style={{ padding: 6 }}>
                    还没有记录，用卡片上的"＋ 记时长"记一笔
                  </div>
                ) : (
                  logsOf(editing.id).map((p) => (
                    <div className="list-row" key={p.id}>
                      <span className="row-sub" style={{ flex: '0 0 auto' }}>
                        {fmtMD(p.date)}
                      </span>
                      <span className="row-main">
                        {p.hours}h{p.note ? ` · ${p.note}` : ''}
                      </span>
                      <div className="hover-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除这条记录"
                          data-testid="playlog-del"
                          onClick={() => remove('playLogs', p.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </SlidePanel>

      <Confirm
        open={confirmDel !== null}
        title="确定删除这个条目吗？"
        text="它的时长记录也会一起删除。"
        onOk={() => {
          confirmDel?.();
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </section>
  );
}
