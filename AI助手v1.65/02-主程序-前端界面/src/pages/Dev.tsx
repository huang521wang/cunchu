import { useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtMD } from '../lib/date';
import type { Project, ProjectTask } from '../types';
import { Confirm, EmptyState, Modal } from '../components/common';

const TASK_COLS: { key: ProjectTask['status']; label: string; icon: string }[] = [
  { key: 'todo', label: '待办', icon: '📌' },
  { key: 'doing', label: '进行中', icon: '🚀' },
  { key: 'done', label: '完成', icon: '🎊' },
];
const TASK_ORDER: ProjectTask['status'][] = ['todo', 'doing', 'done'];
const PRIORITY_LABEL: Record<ProjectTask['priority'], string> = { high: '高', mid: '中', none: '' };
const PROJECT_STATUSES: { key: Project['status']; label: string }[] = [
  { key: 'active', label: '活跃' },
  { key: 'paused', label: '暂停' },
  { key: 'done', label: '已完成' },
];

export default function Dev() {
  const { data, create, update, remove } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'tasks' | 'logs'>('tasks');
  const [projectDraft, setProjectDraft] = useState('');
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null);
  const [taskForm, setTaskForm] = useState({ title: '', priority: 'none' as ProjectTask['priority'], note: '' });
  const [logText, setLogText] = useState('');
  const [logEditId, setLogEditId] = useState<string | null>(null);
  const [logEditText, setLogEditText] = useState('');
  const [confirmDel, setConfirmDel] = useState<null | (() => void)>(null);
  const [dragOver, setDragOver] = useState<ProjectTask['status'] | null>(null);

  const projects = data.projects;
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0];
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);

  const selectProject = (id: string) => {
    setSelectedId(id);
    setNameDraft(null);
    setDescDraft(null);
    setTab('tasks');
  };

  const commitName = () => {
    const value = nameDraft;
    setNameDraft(null);
    if (selected && value !== null && value.trim() && value !== selected.name) {
      update('projects', selected.id, { name: value.trim() });
    }
  };

  const commitDesc = () => {
    const value = descDraft;
    setDescDraft(null);
    if (selected && value !== null && value !== (selected.desc ?? '')) {
      update('projects', selected.id, { desc: value });
    }
  };

  const addProject = async () => {
    const name = projectDraft.trim();
    if (!name) return;
    setProjectDraft('');
    const created = await create('projects', { name, status: 'active', desc: '' });
    setSelectedId(created.id);
    setTab('tasks');
  };

  const deleteProject = (project: Project) => {
    setConfirmDel(() => async () => {
      await remove('projects', project.id);
      for (const t of data.projectTasks.filter((x) => x.projectId === project.id)) {
        await remove('projectTasks', t.id);
      }
      for (const l of data.devLogs.filter((x) => x.projectId === project.id)) {
        await remove('devLogs', l.id);
      }
      setSelectedId(null);
    });
  };

  const undoneCount = (projectId: string) =>
    data.projectTasks.filter((t) => t.projectId === projectId && t.status !== 'done').length;

  const addTask = async (status: ProjectTask['status']) => {
    if (!selected) return;
    const text = (taskDrafts[status] ?? '').trim();
    if (!text) return;
    setTaskDrafts((prev) => ({ ...prev, [status]: '' }));
    await create('projectTasks', {
      projectId: selected.id,
      title: text,
      status,
      priority: 'none',
      note: '',
    });
  };

  const moveTask = async (task: ProjectTask, dir: 1 | -1) => {
    const idx = TASK_ORDER.indexOf(task.status) + dir;
    if (idx < 0 || idx >= TASK_ORDER.length) return;
    await update('projectTasks', task.id, { status: TASK_ORDER[idx] });
  };

  const openTaskModal = (task: ProjectTask) => {
    setEditingTask(task);
    setTaskForm({ title: task.title, priority: task.priority, note: task.note ?? '' });
  };

  const saveTask = async () => {
    if (!editingTask) return;
    const title = taskForm.title.trim();
    await update('projectTasks', editingTask.id, {
      title: title || editingTask.title,
      priority: taskForm.priority,
      note: taskForm.note,
    });
    setEditingTask(null);
  };

  const addLog = async () => {
    if (!selected) return;
    const text = logText.trim();
    if (!text) return;
    setLogText('');
    await create('devLogs', { projectId: selected.id, text });
  };

  const commitLogEdit = async () => {
    const id = logEditId;
    if (!id) return;
    setLogEditId(null);
    const text = logEditText.trim();
    if (text) await update('devLogs', id, { text });
  };

  const projectTasks = selected ? data.projectTasks.filter((t) => t.projectId === selected.id) : [];
  const logs = selected
    ? data.devLogs
        .filter((l) => l.projectId === selected.id)
        .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    : [];

  return (
    <section className="page" data-testid="page-dev">
      <h1 className="page-title">开发工作</h1>
      <div className="dev-layout">
        {/* 项目列表 */}
        <div className="card" style={{ alignSelf: 'start' }}>
          <div className="card-head">
            <span className="card-title">项目</span>
          </div>
          <div className="list" data-testid="project-list">
            {projects.length === 0 ? (
              <div className="row-sub" style={{ padding: '8px 6px' }}>
                还没有项目，下面新建一个吧
              </div>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className={`project-row${selected?.id === p.id ? ' active' : ''}${
                    p.status === 'done' ? ' done' : ''
                  }`}
                  data-testid="project-row"
                  onClick={() => selectProject(p.id)}
                >
                  <span className={`dot dot-${p.status}`} />
                  <span className="row-main">{p.name}</span>
                  {undoneCount(p.id) > 0 && <span className="nav-badge">{undoneCount(p.id)}</span>}
                </div>
              ))
            )}
          </div>
          <div className="input-row" style={{ marginTop: 10 }}>
            <input
              className="input"
              placeholder="＋ 新建项目…（回车）"
              data-testid="new-project"
              value={projectDraft}
              onChange={(e) => setProjectDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addProject();
              }}
            />
          </div>
        </div>

        {/* 项目详情 */}
        {!selected ? (
          <div className="card" data-testid="dev-empty">
            <EmptyState icon="💻" text="左边新建一个项目，开始记录你的开发工作吧" />
          </div>
        ) : (
          <div className="stack" data-testid="dev-detail">
            <div className="card">
              <div className="card-head" style={{ flexWrap: 'wrap' }}>
                <input
                  className="input project-name"
                  data-testid="project-name"
                  value={nameDraft ?? selected.name}
                  onFocus={() => setNameDraft(selected.name)}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <select
                  className="input"
                  style={{ width: 110 }}
                  data-testid="project-status"
                  value={selected.status}
                  onChange={(e) => update('projects', selected.id, { status: e.target.value })}
                >
                  {PROJECT_STATUSES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="project-delete"
                  onClick={() => deleteProject(selected)}
                >
                  🗑 删除项目
                </button>
              </div>
              <input
                className="input"
                placeholder="一句话描述这个项目…"
                data-testid="project-desc"
                value={descDraft ?? selected.desc ?? ''}
                onFocus={() => setDescDraft(selected.desc ?? '')}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={commitDesc}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <div className="row-sub" style={{ marginTop: 10 }}>
                任务 {projectTasks.length} · 已完成 {projectTasks.filter((t) => t.status === 'done').length}
              </div>
            </div>

            <div className="card">
              <div className="tabs" style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  className={`tab${tab === 'tasks' ? ' active' : ''}`}
                  data-testid="dev-tab-tasks"
                  onClick={() => setTab('tasks')}
                >
                  任务
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'logs' ? ' active' : ''}`}
                  data-testid="dev-tab-logs"
                  onClick={() => setTab('logs')}
                >
                  进展记录
                </button>
              </div>

              {tab === 'tasks' && (
                <div className="kanban kanban-3">
                  {TASK_COLS.map((col) => {
                    const items = projectTasks.filter((t) => t.status === col.key);
                    return (
                      <div
                        className={`kanban-col${dragOver === col.key ? ' dragover' : ''}`}
                        key={col.key}
                        data-testid={`task-col-${col.key}`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOver !== col.key) setDragOver(col.key);
                        }}
                        onDragLeave={() => setDragOver((k) => (k === col.key ? null : k))}
                        onDrop={(e) => {
                          e.preventDefault();
                          const id = e.dataTransfer.getData('text/plain');
                          setDragOver(null);
                          const item = data.projectTasks.find((x) => x.id === id);
                          if (item && item.status !== col.key) {
                            update('projectTasks', id, { status: col.key });
                          }
                        }}
                      >
                        <div className="kanban-col-head">
                          <span>
                            {col.icon} {col.label} ({items.length})
                          </span>
                        </div>
                        {items.map((task) => {
                          const idx = TASK_ORDER.indexOf(task.status);
                          return (
                            <div
                              className="kcard"
                              key={task.id}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', task.id);
                                e.dataTransfer.effectAllowed = 'move';
                              }}
                              onClick={() => openTaskModal(task)}
                            >
                              <div className="kcard-title">{task.title}</div>
                              <div className="kcard-meta">
                                {task.priority !== 'none' && (
                                  <span
                                    className={`chip ${task.priority === 'high' ? 'chip-pink' : 'chip-blue'}`}
                                  >
                                    {PRIORITY_LABEL[task.priority]}
                                  </span>
                                )}
                                {task.note && <span>{task.note}</span>}
                              </div>
                              <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                                {idx > 0 && (
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    data-testid="move-prev"
                                    title="退回"
                                    onClick={() => moveTask(task, -1)}
                                  >
                                    ‹
                                  </button>
                                )}
                                {idx < TASK_ORDER.length - 1 && (
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    data-testid="move-next"
                                    title="推进"
                                    onClick={() => moveTask(task, 1)}
                                  >
                                    ›
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="icon-btn"
                                  data-testid="task-del"
                                  title="删除"
                                  onClick={() => remove('projectTasks', task.id)}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        <div className="kanban-new">
                          <input
                            className="input"
                            placeholder="＋ 新建任务…"
                            data-testid={`new-task-${col.key}`}
                            value={taskDrafts[col.key] ?? ''}
                            onChange={(e) => setTaskDrafts((prev) => ({ ...prev, [col.key]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') addTask(col.key);
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === 'logs' && (
                <div>
                  <div className="input-row" style={{ marginBottom: 10 }}>
                    <input
                      className="input"
                      placeholder="今天推进了什么、踩了什么坑…（回车记一笔）"
                      data-testid="log-input"
                      value={logText}
                      onChange={(e) => setLogText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addLog();
                      }}
                    />
                  </div>
                  <div className="list" data-testid="log-list">
                    {logs.length === 0 ? (
                      <EmptyState icon="📝" text="还没有记录，把过程随手记下来吧" />
                    ) : (
                      logs.map((log) => (
                        <div className="list-row" key={log.id}>
                          <span className="row-sub" style={{ flex: '0 0 auto' }}>
                            {fmtMD(log.createdAt.slice(0, 10))}
                          </span>
                          {logEditId === log.id ? (
                            <input
                              className="input"
                              autoFocus
                              value={logEditText}
                              onChange={(e) => setLogEditText(e.target.value)}
                              onBlur={commitLogEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitLogEdit();
                                if (e.key === 'Escape') setLogEditId(null);
                              }}
                            />
                          ) : (
                            <span
                              className="row-main"
                              onClick={() => {
                                setLogEditId(log.id);
                                setLogEditText(log.text);
                              }}
                            >
                              {log.text}
                            </span>
                          )}
                          <div className="hover-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="删除"
                              data-testid="log-del"
                              onClick={() => remove('devLogs', log.id)}
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

      <Modal
        open={editingTask !== null}
        title="编辑任务"
        onClose={() => setEditingTask(null)}
        testid="task-modal"
      >
        <div className="field">
          <label className="field-label">标题</label>
          <input
            className="input"
            data-testid="edit-task-title"
            value={taskForm.title}
            onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label">优先级</label>
          <select
            className="input"
            data-testid="edit-task-priority"
            value={taskForm.priority}
            onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value as ProjectTask['priority'] })}
          >
            <option value="none">无</option>
            <option value="mid">中</option>
            <option value="high">高</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label">备注</label>
          <input
            className="input"
            data-testid="edit-task-note"
            value={taskForm.note}
            onChange={(e) => setTaskForm({ ...taskForm, note: e.target.value })}
          />
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="edit-task-del"
            onClick={() => {
              if (editingTask) remove('projectTasks', editingTask.id);
              setEditingTask(null);
            }}
          >
            删除任务
          </button>
          <button type="button" className="btn btn-primary" data-testid="edit-task-save" onClick={saveTask}>
            保存
          </button>
        </div>
      </Modal>

      <Confirm
        open={confirmDel !== null}
        title="确定删除这个项目吗？"
        text="项目里的任务和进展记录会一起删除。"
        onOk={() => {
          confirmDel?.();
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </section>
  );
}
