import { useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { addDays, fmtCN, today } from '../lib/date';
import type { Task } from '../types';
import { useConfirm } from '../components/common';
import PlanModal from '../components/PlanModal';
import { petalBurst } from '../lib/petal';

const PRIORITY_LABEL: Record<Task['priority'], string> = { high: '高', mid: '中', none: '' };
const PRIORITY_ORDER: Record<Task['priority'], number> = { high: 0, mid: 1, none: 2 };

export default function Today() {
  const { data, create, update, remove } = useStore();
  const [date, setDate] = useState(today());
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('none');
  const [showDone, setShowDone] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planEdit, setPlanEdit] = useState<Task | null>(null);
  const confirm = useConfirm();

  const dayTasks = useMemo(() => data.tasks.filter((t) => t.date === date), [data.tasks, date]);
  const pending = useMemo(
    () =>
      dayTasks
        .filter((t) => !t.done)
        .sort(
          (a, b) =>
            PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt.localeCompare(b.createdAt),
        ),
    [dayTasks],
  );
  const doneList = useMemo(
    () => dayTasks.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')),
    [dayTasks],
  );

  const t = today();
  const isToday = date === t;
  const completeCount = doneList.length;

  const addTask = async () => {
    const text = title.trim();
    if (!text) return;
    // 先清空表单再保存：避免保存较慢时，上一次的重置把刚输入的下一条内容或优先级清掉
    const chosenPriority = priority;
    setTitle('');
    setPriority('none');
    await create('tasks', {
      title: text,
      date,
      priority: chosenPriority,
      time: '',
      estimate: '',
      note: '',
      done: false,
      doneAt: null,
    });
  };

  const toggle = (task: Task) =>
    update('tasks', task.id, { done: !task.done, doneAt: task.done ? null : new Date().toISOString() });

  const startEdit = (task: Task) => {
    setEditId(task.id);
    setEditText(task.title);
  };

  const commitEdit = async () => {
    const id = editId;
    if (!id) return;
    setEditId(null);
    const text = editText.trim();
    if (text) await update('tasks', id, { title: text });
  };

  const postponeTarget = date < t ? t : addDays(date, 1);
  const canPostpone = pending.length > 0 && date <= t;
  const postpone = async () => {
    const target = postponeTarget;
    for (const task of pending) {
      await update('tasks', task.id, { date: target });
    }
  };

  /* 待办任务：醒目的大卡片 */
  const renderPending = (task: Task) => (
    <div className="list-row task-item" data-testid={`task-row-${task.id}`} key={task.id}>
      <button
        type="button"
        className="checkbox task-checkbox"
        data-testid={`task-check-${task.id}`}
        aria-label="完成"
        onClick={(e) => {
          petalBurst(e.clientX, e.clientY);
          toggle(task);
        }}
      >
        {''}
      </button>
      <div className="task-body">
        {editId === task.id ? (
          <input
            className="input"
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setEditId(null);
            }}
          />
        ) : (
          <div className="row-main task-title" onClick={() => startEdit(task)}>
            {task.title}
          </div>
        )}
        <div className="task-meta">
          {task.time && <span className="chip chip-blue">⏰ {task.time}</span>}
          {task.estimate && <span className="chip chip-mint">预计 {task.estimate}</span>}
          {task.priority !== 'none' && (
            <span className={`chip ${task.priority === 'high' ? 'chip-pink' : 'chip-blue'}`}>
              {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          {task.note && <span className="row-sub">{task.note}</span>}
        </div>
      </div>
      <div className="hover-actions">
        <button
          type="button"
          className="icon-btn"
          title="编辑详情"
          data-testid={`task-edit-${task.id}`}
          onClick={() => {
            setPlanEdit(task);
            setPlanOpen(true);
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="icon-btn"
          title="删除"
          data-testid={`task-del-${task.id}`}
          onClick={() => remove('tasks', task.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );

  /* 已完成：低调的小行 */
  const renderDone = (task: Task) => (
    <div className="list-row" data-testid={`task-row-${task.id}`} key={task.id}>
      <button
        type="button"
        className={`checkbox${task.done ? ' checked' : ''}`}
        data-testid={`task-check-${task.id}`}
        aria-label="取消完成"
        onClick={() => toggle(task)}
      >
        {task.done ? '♥' : ''}
      </button>
      <span className={`row-main${task.done ? ' done-text' : ''}`} onClick={() => startEdit(task)}>
        {task.title}
      </span>
      <div className="hover-actions">
        <button
          type="button"
          className="icon-btn"
          title="删除"
          data-testid={`task-del-${task.id}`}
          onClick={() => remove('tasks', task.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <section className="page" data-testid="page-today">
      <div className="page-head">
        <h1 className="page-title">今日计划</h1>
        <div className="grow" />
        <div className="day-nav">
          <button type="button" className="icon-btn" data-testid="prev-day" title="前一天" onClick={() => setDate(addDays(date, -1))}>
            ‹
          </button>
          <div className="day-nav-title" data-testid="day-title">
            {fmtCN(date)}
          </div>
          <button type="button" className="icon-btn" data-testid="next-day" title="后一天" onClick={() => setDate(addDays(date, 1))}>
            ›
          </button>
          {!isToday && (
            <button type="button" className="btn btn-ghost btn-sm" data-testid="back-today" onClick={() => setDate(t)}>
              回到今天
            </button>
          )}
          <input
            type="date"
            className="input day-pick"
            data-testid="date-picker"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <span className="card-title" data-testid="today-progress">
            已完成 {completeCount}/{dayTasks.length}
          </span>
          {pending.length > 0 && (
            <span className="chip chip-pink" data-testid="today-remaining">
              待完成 {pending.length} 件
            </span>
          )}
          <div className="grow" />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="open-plan"
            onClick={() => {
              setPlanEdit(null);
              setPlanOpen(true);
            }}
          >
            ✨ 一键计划
          </button>
        </div>
        <div className="progress" style={{ marginBottom: 14 }}>
          <div
            className="progress-fill"
            style={{ width: dayTasks.length ? `${(completeCount / dayTasks.length) * 100}%` : '0%' }}
          />
        </div>

        <div className="input-row" style={{ marginBottom: 10 }}>
          <input
            className="input"
            placeholder="快速加一条（想填时间/预计时间就用右上角一键计划）"
            data-testid="task-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTask();
            }}
          />
          <select
            className="input"
            style={{ width: 92 }}
            data-testid="task-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Task['priority'])}
          >
            <option value="none">无</option>
            <option value="mid">中</option>
            <option value="high">高</option>
          </select>
          <button type="button" className="btn btn-primary" data-testid="task-add" onClick={addTask}>
            添加
          </button>
        </div>

        <div className="list" data-testid="today-task-list">
          {pending.length === 0 && doneList.length === 0 ? (
            <div className="empty" data-testid="today-empty">
              <div className="empty-icon">🌸</div>
              这天还空空的，添加第一件事吧
            </div>
          ) : (
            pending.map(renderPending)
          )}
        </div>

        {doneList.length > 0 && (
          <div data-testid="today-done-group">
            <button type="button" className="group-label" data-testid="done-toggle" onClick={() => setShowDone(!showDone)}>
              ── 已完成 ({doneList.length}) ── {showDone ? '收起' : '点击展开'}
            </button>
            {showDone && <div className="list">{doneList.map(renderDone)}</div>}
          </div>
        )}

        {canPostpone && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-mint" data-testid="postpone-btn" onClick={postpone}>
              ↘ 把 {pending.length} 个未完成任务顺延到{date < t ? '今天' : '明天'}
            </button>
          </div>
        )}
        {confirm.dialog}
      </div>

      <PlanModal
        open={planOpen}
        editing={planEdit}
        defaultDate={date}
        onClose={() => {
          setPlanOpen(false);
          setPlanEdit(null);
        }}
      />
    </section>
  );
}
