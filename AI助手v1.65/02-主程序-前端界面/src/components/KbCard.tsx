import { useCallback, useEffect, useState } from 'react';
import { pFetch } from '../lib/api';

/**
 * 知识库审批卡：所有 AI（含 MCP 接入的模型）想动 D:\知识库，只能递申请到这里，
 * 批准才入库，驳回进已驳回堆。正式库对模型永远只读——这是阿珑定的规矩。
 */
interface Pending {
  file: string;
  at?: string;
  from?: string;
  category?: string;
  id?: string;
  title?: string;
  tags?: string[];
  reason?: string;
  body?: string;
}

export default function KbCard() {
  const [items, setItems] = useState<Pending[]>([]);
  const [toast, setToast] = useState('');
  const [openBody, setOpenBody] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await (await pFetch('/api/kb/pending')).json();
      setItems(j.items || []);
    } catch {
      /* 服务没起就安静 */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const act = async (url: string, file: string, okMsg: string) => {
    try {
      const r = await pFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
      const j = await r.json();
      if (j.ok || r.ok) {
        setToast(okMsg);
        await load();
      } else setToast(j.error || '操作失败');
    } catch {
      setToast('操作失败：服务没在跑？');
    }
  };

  return (
    <div className="card" data-testid="kb-card">
      <div className="card-head">
        <span className="card-title">📚 知识库审批</span>
        <span className="row-sub">正式库只读；AI 要新增/修改只能递申请，这里你说了算</span>
      </div>
      {items.length === 0 ? (
        <div className="row-sub" data-testid="kb-empty">暂无待审申请（聊天里攒的重要记忆，我会在后台整理成申请放进来）</div>
      ) : (
        <div className="list">
          {items.map((it) => (
            <div className="list-row" key={it.file} data-testid={`kb-item-${it.file}`}>
              <span className="text grow">
                {it.title || it.file}
                <span className="row-sub">
                  {' '}· {it.category || '?'} · 来自{it.from === 'mcp' ? '外接模型' : '我的整理'}{it.reason ? ` · ${it.reason.slice(0, 40)}` : ''}
                </span>
              </span>
              <button type="button" className="btn btn-ghost btn-sm" data-testid={`kb-view-${it.file}`} onClick={() => setOpenBody(openBody === it.file ? null : it.file)}>
                {openBody === it.file ? '收起' : '看内容'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" data-testid={`kb-reject-${it.file}`} onClick={() => void act('/api/kb/reject', it.file, '已驳回（留档在 已驳回/）')}>
                ✋ 驳回
              </button>
              <button type="button" className="btn btn-primary btn-sm" data-testid={`kb-approve-${it.file}`} onClick={() => void act('/api/kb/approve', it.file, '已批准入库 ✓')}>
                ✓ 批准入库
              </button>
            </div>
          ))}
          {openBody && (
            <div className="think" style={{ whiteSpace: 'pre-wrap' }} data-testid="kb-body">
              {items.find((x) => x.file === openBody)?.body || '（空）'}
            </div>
          )}
        </div>
      )}
      {toast && <div className="p-toast" data-testid="kb-toast">{toast}</div>}
    </div>
  );
}
