import { useState } from 'react';
import { useStore } from '../store/StoreContext';
import { PIN_KEY, pFetch } from '../lib/api';
import type { Asset, Doc } from '../types';
import { EmptyState, Modal, Toast } from './common';

const KIND_ICON: Record<Asset['kind'], string> = { image: '🖼', video: '🎬', audio: '🎵', text: '📄', other: '📦' };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 素材柜（图片/视频/任意文件，存本机）+ 文档区（AI 产出的作品、手写文档） */
export default function Materials({ onReadText }: { onReadText: (name: string, text: string) => void }) {
  const { data, create, update, remove, reload } = useStore();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [draftOpen, setDraftOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  const pin = typeof localStorage !== 'undefined' ? localStorage.getItem(PIN_KEY) || '' : '';
  const assets = [...data.files].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  const docs = [...data.documents].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  const urlOf = (a: Asset) => `/files/${a.file.split(/[\\/]/).pop()}${pin ? `?k=${pin}` : ''}`;

  const uploadFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        const q = new URLSearchParams({ name: f.name, mime: f.type || 'application/octet-stream' });
        const r = await pFetch(`/api/files?${q}`, {
          method: 'POST',
          headers: { 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        });
        if (!r.ok) {
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '上传失败');
        }
      }
      await reload();
      setToast(`✓ 已存到本机（${list.length} 个文件）`);
    } catch (e) {
      setToast(`上传失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const readText = async (a: Asset) => {
    setBusy(true);
    try {
      const r = await pFetch(urlOf(a));
      const text = (await r.text()).slice(0, 4000);
      onReadText(a.name, text);
    } catch {
      setToast('这个文件读不出文字内容');
    } finally {
      setBusy(false);
    }
  };

  const openNewDoc = () => {
    setEditId(null);
    setDraftTitle('');
    setDraftBody('');
    setDraftOpen(true);
  };

  const openEditDoc = (d: Doc) => {
    setEditId(d.id);
    setDraftTitle(d.title);
    setDraftBody(d.content);
    setDraftOpen(true);
  };

  const saveDoc = async () => {
    const title = draftTitle.trim() || '未命名文档';
    const content = draftBody;
    setDraftOpen(false);
    if (editId) await update('documents', editId, { title, content });
    else await create('documents', { title, content, source: 'manual' });
    setToast('✓ 已保存到文档');
  };

  const exportDoc = (d: Doc) => {
    const blob = new Blob([`# ${d.title}\n\n${d.content}`], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${d.title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="stack">
        <div className="card" data-testid="asset-box">
          <div className="card-head">
            <span className="card-title">📎 素材柜</span>
            <span className="chip chip-gray">{assets.length} 个</span>
            <div className="grow" />
            <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer' }}>
              📥 上传文件
              <input
                type="file"
                multiple
                style={{ display: 'none' }}
                data-testid="asset-upload"
                onChange={(e) => {
                  uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            图片、视频、文档都能放进来（单个 400MB 以内），存在你自己的电脑里。
            文本类文件（txt/md/csv/json 等）还能点「发给 AI 读」让助手读内容。
            <br />
            说明：本机模型是纯文字的，看不了图片和视频内容——图片视频在这里是"存着、能看、能播"，不是给 AI 分析。
          </div>
          {assets.length === 0 ? (
            <div style={{ marginTop: 8 }}>
              <EmptyState text="还没有素材，点右上角「上传文件」传点图片或视频试试" icon="📎" />
            </div>
          ) : (
            <div className="list" data-testid="asset-list" style={{ marginTop: 8 }}>
              {assets.map((a) => (
                <div className="list-row asset-row" key={a.id} data-testid={`asset-row-${a.id}`}>
                  {a.kind === 'image' ? (
                    <img className="asset-thumb" src={urlOf(a)} alt={a.name} data-testid={`asset-thumb-${a.id}`} />
                  ) : a.kind === 'video' ? (
                    <video className="asset-video" controls preload="metadata" src={urlOf(a)} />
                  ) : (
                    <span className="asset-icon">{KIND_ICON[a.kind]}</span>
                  )}
                  <div className="asset-info grow">
                    <div className="asset-name" data-testid={`asset-name-${a.id}`}>
                      {a.name}
                    </div>
                    <div className="asset-meta">
                      {KIND_ICON[a.kind]} {fmtSize(a.size)} · {a.createdAt.slice(0, 10)}
                    </div>
                  </div>
                  {a.kind === 'text' && (
                    <button
                      type="button"
                      className="btn btn-blue btn-sm"
                      data-testid={`asset-read-${a.id}`}
                      disabled={busy}
                      onClick={() => readText(a)}
                    >
                      发给 AI 读
                    </button>
                  )}
                  <a
                    className="link-more"
                    href={urlOf(a)}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`asset-open-${a.id}`}
                  >
                    打开
                  </a>
                  <div className="hover-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除（磁盘文件一起删）"
                      data-testid={`asset-del-${a.id}`}
                      onClick={() => remove('files', a.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" data-testid="doc-box">
          <div className="card-head">
            <span className="card-title">📄 文档</span>
            <span className="chip chip-gray">{docs.length} 篇</span>
            <div className="grow" />
            <button type="button" className="btn btn-primary btn-sm" data-testid="doc-new" onClick={openNewDoc}>
              ✎ 新建文档
            </button>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            AI 助手回答下面有「📄 存为文档」按钮，一键把好内容存到这里；也可以自己新建。点「导出」下载成 md 文件。
          </div>
          {docs.length === 0 ? (
            <div style={{ marginTop: 8 }}>
              <EmptyState text="还没有文档：去对话里把 AI 的回答存下来，或点「新建文档」" icon="📄" />
            </div>
          ) : (
            <div className="list" data-testid="doc-list" style={{ marginTop: 8 }}>
              {docs.map((d) => (
                <div className="list-row doc-row" key={d.id} data-testid={`doc-row-${d.id}`}>
                  <button
                    type="button"
                    className="doc-head-btn grow"
                    data-testid={`doc-open-${d.id}`}
                    onClick={() => setOpenDoc(openDoc === d.id ? null : d.id)}
                  >
                    <span className="doc-title" data-testid={`doc-title-${d.id}`}>
                      {openDoc === d.id ? '▾' : '▸'} {d.title}
                    </span>
                    <span className="asset-meta">
                      {d.source === 'chat' ? 'AI 存稿' : '手写'} · {d.createdAt.slice(0, 10)} · {d.content.length} 字
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid={`doc-export-${d.id}`}
                    onClick={() => exportDoc(d)}
                  >
                    导出
                  </button>
                  <div className="hover-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="编辑"
                      data-testid={`doc-edit-${d.id}`}
                      onClick={() => openEditDoc(d)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除"
                      data-testid={`doc-del-${d.id}`}
                      onClick={() => remove('documents', d.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {openDoc === d.id && (
                    <pre className="rec-text doc-body" data-testid={`doc-content-${d.id}`}>
                      {d.content}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={draftOpen}
        title={editId ? '编辑文档' : '新建文档'}
        onClose={() => setDraftOpen(false)}
        testid="doc-modal"
      >
        <div className="field">
          <label className="field-label">标题</label>
          <input
            className="input"
            autoFocus
            data-testid="doc-title-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label">内容（支持 Markdown 写法）</label>
          <textarea
            className="input"
            style={{ minHeight: 200, resize: 'vertical', fontFamily: 'inherit' }}
            data-testid="doc-body-input"
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setDraftOpen(false)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="doc-save" onClick={saveDoc}>
            保存
          </button>
        </div>
      </Modal>

      {toast && <Toast message={toast} onClose={() => setToast(null)} testid="mat-toast" />}
    </>
  );
}
