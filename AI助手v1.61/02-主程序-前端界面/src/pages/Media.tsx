import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtMD, monthStr, today } from '../lib/date';
import type { ContentItem, PublishStat } from '../types';
import { Confirm, EmptyState, SlidePanel } from '../components/common';

const STATUSES: { key: ContentItem['status']; label: string; icon: string }[] = [
  { key: 'idea', label: '想法', icon: '💡' },
  { key: 'writing', label: '创作中', icon: '✏️' },
  { key: 'ready', label: '待发布', icon: '📮' },
  { key: 'published', label: '已发布', icon: '🎉' },
];
const STATUS_LABEL: Record<ContentItem['status'], string> = {
  idea: '想法',
  writing: '创作中',
  ready: '待发布',
  published: '已发布',
};
const STATUS_ORDER: ContentItem['status'][] = ['idea', 'writing', 'ready', 'published'];

export default function Media() {
  const { data, settings, create, update, remove, updateSettings } = useStore();
  const [tab, setTab] = useState<'board' | 'ideas'>('board');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [panelId, setPanelId] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    platform: '',
    plannedDate: '',
    draft: '',
    note: '',
    link: '',
  });
  const [statForm, setStatForm] = useState({ date: today(), reads: '', likes: '', comments: '' });
  const [ideaText, setIdeaText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<null | (() => void)>(null);
  const [dragOver, setDragOver] = useState<ContentItem['status'] | null>(null);

  const editing = panelId ? data.contentItems.find((c) => c.id === panelId) : undefined;

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title,
        platform: editing.platform,
        plannedDate: editing.plannedDate,
        draft: editing.draft ?? '',
        note: editing.note ?? '',
        link: editing.link ?? '',
      });
      setStatForm({ date: today(), reads: '', likes: '', comments: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  const monthPublished = useMemo(() => {
    const ids = new Set(
      data.publishStats.filter((s) => s.date.startsWith(monthStr())).map((s) => s.itemId),
    );
    return ids.size;
  }, [data.publishStats]);
  const readyItems = data.contentItems.filter((c) => c.status === 'ready');
  const nextReady = [...readyItems].sort((a, b) =>
    (a.plannedDate || '9999').localeCompare(b.plannedDate || '9999'),
  )[0];

  const statsOf = (itemId: string): PublishStat[] =>
    data.publishStats
      .filter((s) => s.itemId === itemId)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0));
  const latestStat = (itemId: string) => statsOf(itemId)[0];

  const addToColumn = async (status: ContentItem['status']) => {
    const text = (drafts[status] ?? '').trim();
    if (!text) return;
    setDrafts((prev) => ({ ...prev, [status]: '' }));
    await create('contentItems', {
      title: text,
      platform: '',
      status,
      plannedDate: '',
      draft: '',
      note: '',
      link: '',
    });
  };

  const move = async (c: ContentItem, dir: 1 | -1) => {
    const idx = STATUS_ORDER.indexOf(c.status) + dir;
    if (idx < 0 || idx >= STATUS_ORDER.length) return;
    await update('contentItems', c.id, { status: STATUS_ORDER[idx] });
  };

  const savePanel = async () => {
    if (!editing) return;
    const title = form.title.trim();
    await update('contentItems', editing.id, {
      title: title || editing.title,
      platform: form.platform.trim(),
      plannedDate: form.plannedDate,
      draft: form.draft,
      note: form.note,
      link: form.link.trim(),
    });
    const platform = form.platform.trim();
    if (platform && !settings.platforms.includes(platform)) {
      await updateSettings({ platforms: [...settings.platforms, platform] });
    }
    setPanelId(null);
  };

  const addStat = async () => {
    if (!editing) return;
    await create('publishStats', {
      itemId: editing.id,
      date: statForm.date || today(),
      reads: Number(statForm.reads) || 0,
      likes: Number(statForm.likes) || 0,
      comments: Number(statForm.comments) || 0,
    });
    setStatForm({ date: today(), reads: '', likes: '', comments: '' });
  };

  const addIdea = async () => {
    const text = ideaText.trim();
    if (!text) return;
    setIdeaText('');
    await create('ideas', { text });
  };

  const ideaToContent = async (id: string, text: string) => {
    await create('contentItems', {
      title: text,
      platform: '',
      status: 'idea',
      plannedDate: '',
      draft: '',
      note: '',
      link: '',
    });
    await remove('ideas', id);
  };

  const renderCard = (c: ContentItem) => {
    const idx = STATUS_ORDER.indexOf(c.status);
    const stat = latestStat(c.id);
    const overdue = c.plannedDate && c.plannedDate < today() && c.status !== 'published';
    return (
      <div
        className="kcard"
        key={c.id}
        data-testid={`content-card-${c.id}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', c.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => setPanelId(c.id)}
      >
        <div className="kcard-title">{c.title}</div>
        <div className="kcard-meta">
          {c.platform && <span className="chip chip-gray">{c.platform}</span>}
          {c.plannedDate && (
            <span className={overdue ? 'text-danger' : ''}>{fmtMD(c.plannedDate)}</span>
          )}
          {c.status === 'published' && stat && (
            <span>
              ❤ {stat.likes} · 阅 {stat.reads}
            </span>
          )}
        </div>
        <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
          {idx > 0 && (
            <button
              type="button"
              className="icon-btn"
              data-testid="move-prev"
              title={`退回「${STATUS_LABEL[STATUS_ORDER[idx - 1]]}」`}
              onClick={() => move(c, -1)}
            >
              ‹
            </button>
          )}
          {idx < STATUS_ORDER.length - 1 && (
            <button
              type="button"
              className="icon-btn"
              data-testid="move-next"
              title={`推进到「${STATUS_LABEL[STATUS_ORDER[idx + 1]]}」`}
              onClick={() => move(c, 1)}
            >
              ›
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            data-testid="card-del"
            title="删除"
            onClick={() => setConfirmDelete(() => () => remove('contentItems', c.id))}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="page" data-testid="page-media">
      <div className="page-head">
        <h1 className="page-title">自媒体</h1>
        <div className="tabs" style={{ marginLeft: 8 }}>
          <button
            type="button"
            className={`tab${tab === 'board' ? ' active' : ''}`}
            data-testid="media-tab-board"
            onClick={() => setTab('board')}
          >
            内容看板
          </button>
          <button
            type="button"
            className={`tab${tab === 'ideas' ? ' active' : ''}`}
            data-testid="media-tab-ideas"
            onClick={() => setTab('ideas')}
          >
            灵感库
          </button>
        </div>
        <div className="grow" />
        <span className="row-sub" data-testid="media-stats">
          本月已发 {monthPublished} · 待发布 {readyItems.length}
        </span>
      </div>

      {tab === 'board' && (
        <div className="card">
          <div className="hint-line" data-testid="media-next-hint">
            {nextReady
              ? `下一条该发：《${nextReady.title}》${nextReady.platform ? ` · ${nextReady.platform}` : ''}${
                  nextReady.plannedDate ? ` · ${fmtMD(nextReady.plannedDate)}` : ''
                }`
              : '暂无待发布内容，去灵感库找找灵感吧'}
          </div>
          <div className="kanban">
            {STATUSES.map((col) => {
              const items = data.contentItems.filter((c) => c.status === col.key);
              return (
                <div
                  className={`kanban-col${dragOver === col.key ? ' dragover' : ''}`}
                  key={col.key}
                  data-testid={`col-${col.key}`}
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
                    const item = data.contentItems.find((x) => x.id === id);
                    if (item && item.status !== col.key) {
                      update('contentItems', id, { status: col.key });
                    }
                  }}
                >
                  <div className="kanban-col-head">
                    <span>
                      {col.icon} {col.label} ({items.length})
                    </span>
                  </div>
                  {items.map(renderCard)}
                  {items.length === 0 && (
                    <div className="row-sub" style={{ padding: '4px 6px 8px' }}>
                      空空的
                    </div>
                  )}
                  {col.key !== 'published' && (
                    <div className="kanban-new">
                      <input
                        className="input"
                        placeholder="＋ 新建…"
                        data-testid={`new-${col.key}`}
                        value={drafts[col.key] ?? ''}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [col.key]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addToColumn(col.key);
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'ideas' && (
        <div className="card">
          <div className="input-row" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="随手记一个灵感…（回车即存）"
              data-testid="idea-input"
              value={ideaText}
              onChange={(e) => setIdeaText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addIdea();
              }}
            />
          </div>
          <div className="list" data-testid="idea-list">
            {data.ideas.length === 0 ? (
              <EmptyState icon="💡" text="灵感库空空的，先把想法丢进来吧" />
            ) : (
              [...data.ideas]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((idea) => (
                  <div className="list-row" key={idea.id}>
                    <span className="row-main">💡 {idea.text}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-blue"
                      data-testid="idea-to-content"
                      onClick={() => ideaToContent(idea.id, idea.text)}
                    >
                      转为内容
                    </button>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除"
                        data-testid="idea-del"
                        onClick={() => remove('ideas', idea.id)}
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

      <SlidePanel
        open={editing !== undefined}
        title={`编辑内容 · ${editing ? STATUS_LABEL[editing.status] : ''}`}
        onClose={() => setPanelId(null)}
        testid="content-panel"
      >
        {editing && (
          <div>
            <div className="field">
              <label className="field-label">标题</label>
              <input
                className="input"
                data-testid="content-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">平台</label>
              <input
                className="input"
                list="platform-options"
                placeholder="选一个或输入新的平台名"
                data-testid="content-platform"
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
              />
              <datalist id="platform-options">
                {settings.platforms.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label className="field-label">计划发布日期</label>
              <input
                type="date"
                className="input"
                data-testid="content-planned"
                value={form.plannedDate}
                onChange={(e) => setForm({ ...form, plannedDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">内容草稿 / 大纲</label>
              <textarea
                className="input"
                data-testid="content-draft"
                value={form.draft}
                onChange={(e) => setForm({ ...form, draft: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">备注</label>
              <input
                className="input"
                data-testid="content-note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">发布链接</label>
              <input
                className="input"
                data-testid="content-link"
                value={form.link}
                onChange={(e) => setForm({ ...form, link: e.target.value })}
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
              <button type="button" className="btn btn-primary" data-testid="content-save" onClick={savePanel}>
                保存
              </button>
            </div>

            {editing.status === 'published' && (
              <div style={{ marginTop: 22 }}>
                <div className="card-title" style={{ marginBottom: 8 }}>
                  发布数据
                </div>
                <div className="input-row" style={{ marginBottom: 8 }}>
                  <input
                    type="date"
                    className="input"
                    style={{ width: 140 }}
                    data-testid="stat-date"
                    value={statForm.date}
                    onChange={(e) => setStatForm({ ...statForm, date: e.target.value })}
                  />
                  <input
                    className="input"
                    placeholder="阅读"
                    data-testid="stat-reads"
                    value={statForm.reads}
                    onChange={(e) => setStatForm({ ...statForm, reads: e.target.value })}
                  />
                  <input
                    className="input"
                    placeholder="点赞"
                    data-testid="stat-likes"
                    value={statForm.likes}
                    onChange={(e) => setStatForm({ ...statForm, likes: e.target.value })}
                  />
                  <input
                    className="input"
                    placeholder="评论"
                    data-testid="stat-comments"
                    value={statForm.comments}
                    onChange={(e) => setStatForm({ ...statForm, comments: e.target.value })}
                  />
                  <button type="button" className="btn" data-testid="stat-add" onClick={addStat}>
                    记录
                  </button>
                </div>
                <div className="list" data-testid="stat-list">
                  {statsOf(editing.id).length === 0 ? (
                    <div className="row-sub" style={{ padding: 6 }}>
                      还没有数据，发布后回来记一笔
                    </div>
                  ) : (
                    statsOf(editing.id).map((s) => (
                      <div className="list-row" key={s.id}>
                        <span className="row-main">
                          {fmtMD(s.date)} · 阅 {s.reads} · ❤ {s.likes} · 💬 {s.comments}
                        </span>
                        <div className="hover-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            title="删除这条数据"
                            onClick={() => remove('publishStats', s.id)}
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
        )}
      </SlidePanel>

      <Confirm
        open={confirmDelete !== null}
        text="删除后这条内容就找不回来了"
        onOk={() => {
          confirmDelete?.();
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}
