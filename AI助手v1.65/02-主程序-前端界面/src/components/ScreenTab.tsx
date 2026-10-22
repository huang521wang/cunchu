import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { pFetch } from '../lib/api';
import { today } from '../lib/date';
import { Modal, Toast } from './common';

interface ScreenItem {
  kind: 'task' | 'memo' | 'study' | 'memory';
  text: string;
  date: string;
}

const KIND_ICON: Record<ScreenItem['kind'], string> = { task: '📋', memo: '✎', study: '📚', memory: '🌳' };
const KIND_LABEL: Record<ScreenItem['kind'], string> = { task: '任务', memo: '备忘', study: '学习', memory: '记忆' };

/** 🖥 屏幕助手：阅读时静默抓帧，结束后统一 OCR + 柳月虹整理成待确认清单 */
export default function ScreenTab() {
  const { create } = useStore();
  const [on, setOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [frames, setFrames] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { items: ScreenItem[]; summary: string }>(null);
  const [doneIdx, setDoneIdx] = useState<Set<number>>(new Set());
  const [dates, setDates] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const captureOnce = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((r) => canvas.toBlob((b) => r(b as Blob | null), 'image/png'));
      if (!blob) return;
      await pFetch('/api/screen/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      setFrames((n) => n + 1);
    } catch {
      // 单帧失败跳过
    }
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      streamRef.current = stream;
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = stream;
      v.play().catch(() => {});
      videoRef.current = v;
      setRecording(true);
      setFrames(0);
      secRef.current = 0;
      setSeconds(0);
      setResult(null);
      captureOnce();
      timerRef.current = setInterval(() => {
        secRef.current += 1;
        setSeconds(secRef.current);
        captureOnce();
      }, 8000);
    } catch {
      setToast('没拿到屏幕共享权限——请在系统弹窗里选择要记录的窗口，或换 Chrome/Edge 浏览器');
    }
  };

  const endRec = async () => {
    if (!recording) return;
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    videoRef.current = null;
    setBusy(true);
    try {
      const j = await (await pFetch('/api/screen/finish', { method: 'POST' })).json();
      setResult({ items: j.items || [], summary: j.summary || '' });
      setDoneIdx(new Set());
      const d: Record<number, string> = {};
      (j.items || []).forEach((it: ScreenItem, i: number) => {
        if (it.date) d[i] = it.date;
      });
      setDates(d);
    } catch (e) {
      setToast(`整理失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (next: boolean) => {
    setOn(next);
    if (!next) await endRec();
  };

  const confirmItem = async (i: number) => {
    const it = result!.items[i];
    if (it.kind === 'task') {
      await create('tasks', {
        title: it.text,
        date: dates[i] || it.date || today(),
        time: '',
        estimate: '',
        note: '',
        priority: 'none',
        done: false,
        doneAt: null,
      });
    } else if (it.kind === 'memo') {
      await create('memos', { text: it.text });
    } else if (it.kind === 'study') {
      await create('studyItems', {
        title: it.text,
        course: '',
        kind: '作业',
        due: dates[i] || it.date,
        done: false,
        doneAt: null,
      });
    } else {
      await pFetch('/api/memory/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: it.text }),
      });
    }
    const next = new Set(doneIdx);
    next.add(i);
    setDoneIdx(next);
    setToast(`✓ 已记入${KIND_LABEL[it.kind]}`);
  };

  const confirmAll = async () => {
    for (let i = 0; i < (result?.items.length || 0); i++) {
      if (!doneIdx.has(i)) await confirmItem(i);
    }
  };

  const fmtMin = (s: number) => `${Math.floor(s / 60)} 分 ${s % 60} 秒`;

  return (
    <div className="stack">
      <div className="card" data-testid="screen-tab">
        <div className="card-head">
          <span className="card-title">🖥 屏幕助手</span>
          <div className="grow" />
          <label className="screen-switch">
            <input
              type="checkbox"
              data-testid="screen-toggle"
              checked={on}
              onChange={(e) => toggle(e.target.checked)}
            />
            <span className="screen-switch-label">{on ? '屏幕获取 开' : '屏幕获取 关'}</span>
          </label>
        </div>
        <div className="row-sub" style={{ lineHeight: 2 }}>
          开着的时候它每 8 秒悄悄存一帧（**不会打扰你看学习通/微信/QQ**）；点「结束记录」后，才统一识别并整理成任务/备忘/学习/记忆。
          画面只在本机暂存，整理完立即删除。
        </div>
        {on ? (
          <>
            <div className="input-row" style={{ marginTop: 10 }}>
              {recording ? (
                <>
                  <span className="chip chip-pink" data-testid="screen-status">
                    ● 正在记录 {fmtMin(seconds)} · {frames} 帧（不打扰你）
                  </span>
                  <button type="button" className="btn btn-primary btn-sm" data-testid="screen-end" disabled={busy} onClick={endRec}>
                    {busy ? '整理中…' : '■ 结束记录并整理'}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-primary btn-sm" data-testid="screen-start" onClick={startRec}>
                    ● 开始记录
                  </button>
                  <span className="row-sub">会弹出系统授权框，选你要记录的那个窗口</span>
                </>
              )}
            </div>
            {busy && <div className="row-sub" style={{ marginTop: 8 }}>正在识别画面文字并让柳月虹整理…（可能要十几秒）</div>}
            {result && (
              <div className="screen-result" data-testid="screen-result">
                <div className="row-sub">这次认出 {result.items.length} 条可行动的事：</div>
                <div className="list">
                  {result.items.map((it, i) => (
                    <div className="list-row" key={i} data-testid={`screen-item-${i}`}>
                      <span className="chip chip-gray">
                        {KIND_ICON[it.kind]} {KIND_LABEL[it.kind]}
                      </span>
                      <span className="text grow">{it.text}</span>
                      {(it.kind === 'task' || it.kind === 'study') && (
                        <input
                          type="date"
                          className="input"
                          style={{ maxWidth: 140 }}
                          data-testid={`screen-date-${i}`}
                          value={dates[i] || it.date || ''}
                          onChange={(e) => setDates({ ...dates, [i]: e.target.value })}
                        />
                      )}
                      {doneIdx.has(i) ? (
                        <span className="chip chip-mint">已记入 ✓</span>
                      ) : (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" data-testid={`screen-item-ok-${i}`} onClick={() => confirmItem(i)}>
                            ✓
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            data-testid={`screen-item-skip-${i}`}
                            onClick={() => {
                              const next = new Set(doneIdx);
                              next.add(i);
                              setDoneIdx(next);
                            }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {result.items.length > 0 && (
                  <div className="input-row" style={{ marginTop: 10 }}>
                    <button type="button" className="btn btn-primary btn-sm" data-testid="screen-all-ok" onClick={confirmAll}>
                      全部确认
                    </button>
                    <span className="row-sub">剩下的点「✕」跳过；不点就不写</span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="empty" data-testid="screen-off">
            <EmptyHint />
          </div>
        )}
      </div>

      {toast && <Toast message={toast} onClose={() => setToast(null)} testid="screen-toast" />}
    </div>
  );
}

function EmptyHint() {
  return (
    <div style={{ padding: '18px 6px', color: 'var(--text-2)', fontSize: 13, lineHeight: 2 }}>
      打开上面的开关，就能在看书/刷学习通/微信/QQ 的时候让它帮忙记录。
      <br />
      看完后点「结束记录」，柳月虹会把画面里的作业、截止时间、要记的事整理成清单给你确认。
    </div>
  );
}
