import { useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtCN, fmtMD, today, weekdayIndex, weekRange, monthStr } from '../lib/date';
import type { Memo, PageKey, Task } from '../types';
import { petalBurst } from '../lib/petal';
import PlanModal from '../components/PlanModal';
import type { PlanValue } from '../components/PlanModal';
import { Toast } from '../components/common';

const PRIORITY_ORDER: Record<Task['priority'], number> = { high: 0, mid: 1, none: 2 };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export default function Home({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { data, settings, create, update, remove } = useStore();
  const t = today();

  const [taskText, setTaskText] = useState('');
  const [memoText, setMemoText] = useState('');
  const [memoEditId, setMemoEditId] = useState<string | null>(null);
  const [memoEditText, setMemoEditText] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planInitial, setPlanInitial] = useState<Partial<PlanValue> | undefined>(undefined);
  const [planMemo, setPlanMemo] = useState<Memo | null>(null);
  const [toast, setToast] = useState<null | { msg: string; target: PageKey }>(null);

  const closePlan = () => {
    setPlanOpen(false);
    setPlanInitial(undefined);
    setPlanMemo(null);
  };

  /* ----- 今日待办 ----- */
  const dayTasks = useMemo(() => data.tasks.filter((x) => x.date === t), [data.tasks, t]);
  const pending = useMemo(
    () =>
      dayTasks
        .filter((x) => !x.done)
        .sort(
          (a, b) =>
            PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt.localeCompare(b.createdAt),
        ),
    [dayTasks],
  );
  const doneList = dayTasks.filter((x) => x.done);

  const addTask = async () => {
    const text = taskText.trim();
    if (!text) return;
    setTaskText('');
    await create('tasks', { title: text, date: t, priority: 'none', done: false, doneAt: null });
  };

  const toggleTask = (task: Task) =>
    update('tasks', task.id, { done: !task.done, doneAt: task.done ? null : new Date().toISOString() });

  /* ----- 快速备忘 ----- */
  const memos = useMemo(
    () => [...data.memos].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)),
    [data.memos],
  );

  const addMemo = async () => {
    const text = memoText.trim();
    if (!text) return;
    setMemoText('');
    await create('memos', { text });
  };

  const commitMemoEdit = async () => {
    const id = memoEditId;
    if (!id) return;
    setMemoEditId(null);
    const text = memoEditText.trim();
    if (text) await update('memos', id, { text });
  };

  /* ----- 模块摘要 ----- */
  const readyItems = data.contentItems.filter((c) => c.status === 'ready');
  const nextReady = [...readyItems].sort((a, b) =>
    (a.plannedDate || '9999').localeCompare(b.plannedDate || '9999'),
  )[0];

  const doingTasks = data.projectTasks.filter((x) => x.status === 'doing');
  const latestDoing = [...doingTasks].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.seq ?? 0) - (a.seq ?? 0),
  )[0];

  const monthHours = data.timeEntries
    .filter((x) => x.date.startsWith(monthStr()))
    .reduce((sum, x) => sum + x.hours, 0);
  const openFollowUps = data.followUps
    .filter((x) => !x.done)
    .sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31'));
  const nextFollowUp = openFollowUps[0];

  const { start, end } = weekRange();
  const weekWorkouts = data.workoutLogs.filter((x) => x.date >= start && x.date <= end).length;
  const plannedWorkouts = settings.weeklyPlan.filter((x) => x.trim() !== '' && x !== '休息').length;
  const todayPlan = settings.weeklyPlan[weekdayIndex(t)] ?? '休息';

  const todayMeal = data.mealDays.find((x) => x.date === t);
  const mealsLogged = [todayMeal?.breakfast, todayMeal?.lunch, todayMeal?.dinner].filter(
    (x) => x && x.trim() !== '',
  ).length;

  const playing = data.gameItems.filter((x) => x.status === 'playing');
  const lastPlay = [...data.playLogs].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0];
  const lastPlayItem = lastPlay ? data.gameItems.find((x) => x.id === lastPlay.itemId) : undefined;

  const summaryCard = (
    key: PageKey,
    icon: string,
    name: string,
    big: string,
    sub: string,
  ) => (
    <div
      className="card summary-card"
      data-testid={`summary-${key}`}
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onNavigate(key);
      }}
    >
      <div className="card-head">
        <span className="card-ico">{icon}</span>
        <span className="card-title">{name}</span>
      </div>
      <div className="stat-num">{big}</div>
      <div className="row-sub" style={{ marginTop: 4 }}>
        {sub}
      </div>
    </div>
  );

  return (
    <section className="page" data-testid="page-home">
      <div className="home-greeting">
        <span className="greeting-flower">🌸</span>
        <span className="greeting-text">
          {fmtCN(t)} · {greeting()}
        </span>
        <span className="greeting-spark">✨</span>
      </div>

      <div className="stack">
        <div className="grid grid-2">
          {/* 今日待办 */}
          <div className="card" data-testid="home-todo">
            <div className="card-head">
              <span className="card-title">今日待办</span>
              <span className="chip chip-pink" data-testid="home-progress">
                {doneList.length}/{dayTasks.length}
              </span>
              <div className="grow" />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="home-plan-btn"
                onClick={() => {
                  setPlanInitial(undefined);
                  setPlanMemo(null);
                  setPlanOpen(true);
                }}
              >
                ✨ 一键计划
              </button>
              <button type="button" className="link-more" data-testid="goto-today" onClick={() => onNavigate('today')}>
                去今日计划 →
              </button>
            </div>
            <div className="progress" style={{ marginBottom: 12 }}>
              <div
                className="progress-fill"
                style={{ width: dayTasks.length ? `${(doneList.length / dayTasks.length) * 100}%` : '0%' }}
              />
            </div>
            <div className="list" data-testid="home-todo-list">
              {pending.length === 0 && doneList.length === 0 ? (
                <div className="row-sub" style={{ padding: '10px 8px' }}>
                  今天还没有任务，在下面加一条吧
                </div>
              ) : (
                pending.map((task) => (
                  <div className="list-row task-item" key={task.id}>
                    <button
                      type="button"
                      className="checkbox task-checkbox"
                      aria-label="完成"
                      data-testid={`home-check-${task.id}`}
                      onClick={(e) => {
                        petalBurst(e.clientX, e.clientY);
                        toggleTask(task);
                      }}
                    >
                      {''}
                    </button>
                    <div className="task-body">
                      <div className="row-main task-title">{task.title}</div>
                      <div className="task-meta">
                        {task.time && <span className="chip chip-blue">⏰ {task.time}</span>}
                        {task.estimate && <span className="chip chip-mint">预计 {task.estimate}</span>}
                        {task.priority !== 'none' && (
                          <span className={`chip ${task.priority === 'high' ? 'chip-pink' : 'chip-blue'}`}>
                            {task.priority === 'high' ? '高' : '中'}
                          </span>
                        )}
                        {task.note && <span className="row-sub">{task.note}</span>}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            {doneList.length > 0 && (
              <div data-testid="home-done-group">
                <div className="group-label">── 已完成 ({doneList.length}) ──</div>
                <div className="list">
                  {doneList.map((task) => (
                    <div className="list-row" key={task.id}>
                      <button
                        type="button"
                        className="checkbox checked"
                        aria-label="取消完成"
                        onClick={() => toggleTask(task)}
                      >
                        ♥
                      </button>
                      <span className="row-main done-text">{task.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="input-row" style={{ marginTop: 10 }}>
              <input
                className="input"
                placeholder="添加今天的任务…（回车即加）"
                data-testid="home-task-input"
                value={taskText}
                onChange={(e) => setTaskText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTask();
                }}
              />
            </div>
          </div>

          {/* 快速备忘 */}
          <div className="card" data-testid="home-memo">
            <div className="card-head">
              <span className="card-title">快速备忘</span>
            </div>
            <div className="input-row" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="记一笔…（回车即存）"
                data-testid="memo-input"
                value={memoText}
                onChange={(e) => setMemoText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addMemo();
                }}
              />
            </div>
            <div className="list memo-list" data-testid="memo-list">
              {memos.length === 0 ? (
                <div className="row-sub" style={{ padding: '10px 8px' }}>
                  备忘录空空的，随手记点什么吧
                </div>
              ) : (
                memos.map((m) => (
                  <div className="list-row" key={m.id}>
                    {memoEditId === m.id ? (
                      <input
                        className="input"
                        autoFocus
                        value={memoEditText}
                        onChange={(e) => setMemoEditText(e.target.value)}
                        onBlur={commitMemoEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitMemoEdit();
                          if (e.key === 'Escape') setMemoEditId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="row-main"
                        onClick={() => {
                          setMemoEditId(m.id);
                          setMemoEditText(m.text);
                        }}
                      >
                        • {m.text}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-blue"
                      data-testid="memo-plan"
                      title="把这条备忘计划成任务"
                      onClick={() => {
                        setPlanInitial({ title: m.text });
                        setPlanMemo(m);
                        setPlanOpen(true);
                      }}
                    >
                      → 计划
                    </button>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除"
                        data-testid={`memo-del-${m.id}`}
                        onClick={() => remove('memos', m.id)}
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

        {/* 模块摘要卡 */}
        <div className="grid grid-3">
          {summaryCard(
            'study',
            '📚',
            '学习计划',
            `进行中 ${data.studyItems.filter((s) => !s.done).length}`,
            (() => {
              const next = data.studyItems
                .filter((s) => !s.done && !!s.due)
                .sort((a, b) => (a.due! < b.due! ? -1 : 1))[0];
              return next ? `最近截止：${next.title} ${fmtMD(next.due!)}` : '暂无 · 点击开始';
            })(),
          )}
          {summaryCard(
            'media',
            '📣',
            '自媒体',
            `待发布 ${readyItems.length}`,
            nextReady
              ? `下一条：《${nextReady.title}》${nextReady.plannedDate ? ` ${fmtMD(nextReady.plannedDate)}` : ''} ${nextReady.platform}`
              : '暂无 · 点击开始',
          )}
          {summaryCard(
            'dev',
            '💻',
            '开发工作',
            `进行中 ${doingTasks.length}`,
            latestDoing ? `最新：${latestDoing.title}` : '暂无 · 点击开始',
          )}
          {summaryCard(
            'consulting',
            '💼',
            '咨询工作',
            `本月 ${Math.round(monthHours * 100) / 100}h`,
            nextFollowUp
              ? `待跟进：${nextFollowUp.text}${nextFollowUp.dueDate ? ` ${fmtMD(nextFollowUp.dueDate)}` : ''}`
              : '暂无 · 点击开始',
          )}
          {summaryCard('fitness', '🏋️', '健身计划', `本周 ${weekWorkouts}/${plannedWorkouts} 次`, `今天：${todayPlan}`)}
          {summaryCard(
            'diet',
            '🍚',
            '饮食计划',
            `三餐已记 ${mealsLogged}/3`,
            `喝水 ${todayMeal?.water ?? 0}/${settings.waterGoal} 杯`,
          )}
          {summaryCard(
            'games',
            '🎮',
            '游戏娱乐',
            `在玩 ${playing.length}`,
            lastPlay && lastPlayItem ? `最近：《${lastPlayItem.name}》 ${lastPlay.hours}h` : '暂无 · 点击开始',
          )}
        </div>
      </div>

      <PlanModal
        open={planOpen}
        initial={planInitial}
        defaultDate={t}
        onClose={closePlan}
        onCreated={async () => {
          const memo = planMemo;
          closePlan();
          if (memo) {
            await remove('memos', memo.id);
            setToast({ msg: '✓ 备忘已计划成任务', target: 'today' });
          }
        }}
      />

      {toast && (
        <Toast
          message={toast.msg}
          actionLabel="去看看"
          onAction={() => {
            onNavigate(toast.target);
            setToast(null);
          }}
          onClose={() => setToast(null)}
          testid="home-toast"
        />
      )}
    </section>
  );
}
