import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { PIN_KEY, pFetch } from '../lib/api';
import type { LessonNote } from '../types';
import { Toast } from './common';

const STATUS_LABEL: Record<LessonNote['status'], string> = {
  recorded: '已录音',
  transcribing: '转写中…',
  transcribed: '已转写',
  summarizing: '总结中…',
  done: '已总结',
  failed: '出错了',
};

function fmtDur(sec: number): string {
  if (!sec) return '--';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 课堂/会议录音：录下来 → 本机转文字（whisper）→ 本机模型总结。全程不上云。 */
export default function RecordingBox() {
  const { data, update, remove, reload } = useStore();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [whisper, setWhisper] = useState<null | { available: boolean; engine: string | null; model: string | null }>(
    null,
  );

  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secRef = useRef(0);

  const notes = [...data.lessonNotes].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  const inFlight = notes.some((n) => n.status === 'transcribing' || n.status === 'summarizing');

  // 转写/总结在后台跑，界面每隔几秒刷一下状态
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      reload().catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [inFlight, reload]);

  useEffect(() => {
    pFetch('/api/whisper/status')
      .then((r) => r.json())
      .then(setWhisper)
      .catch(() => setWhisper({ available: false, engine: null, model: null }));
  }, [inFlight]);

  const upload = async (blob: Blob, dur: number) => {
    setBusy(true);
    try {
      const d = new Date();
      const q = new URLSearchParams({
        duration: String(dur || 0),
        title: `${d.getMonth() + 1}/${d.getDate()} 的录音`,
      });
      const r = await pFetch(`/api/recordings?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '上传失败');
      await reload();
      setToast('✓ 已存到本机，点「转写」就能出文字');
    } catch (e) {
      setToast(`上传失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        await upload(blob, secRef.current);
      };
      mediaRef.current = mr;
      secRef.current = 0;
      setSeconds(0);
      mr.start(1000);
      setRecording(true);
      timerRef.current = setInterval(() => {
        secRef.current += 1;
        setSeconds(secRef.current);
      }, 1000);
    } catch {
      setToast('拿不到麦克风权限——手机浏览器不让网页录音（浏览器安全限制），请用手机自带录音机录好，再点「上传录音文件」');
    }
  };

  const stopRec = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
    mediaRef.current?.stop();
  };

  const onFile = async (f: File | null) => {
    if (!f) return;
    await upload(f, 0);
  };

  const act = async (id: string, path: 'transcribe' | 'summarize') => {
    setBusy(true);
    try {
      const r = await pFetch(`/api/recordings/${id}/${path}`, { method: 'POST' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || '操作失败');
      await reload();
      setToast(path === 'transcribe' ? '开始转写（后台跑，页面会自动刷新）' : '开始总结（后台跑，页面会自动刷新）');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = async (id: string) => {
    const t = editText.trim();
    setEditId(null);
    if (t) await update('lessonNotes', id, { title: t });
  };

  const pin = typeof localStorage !== 'undefined' ? localStorage.getItem(PIN_KEY) || '' : '';
  const audioUrl = (n: LessonNote) =>
    `/recordings/${n.audioFile.split(/[\\/]/).pop()}${pin ? `?k=${pin}` : ''}`;

  return (
    <div className="card" data-testid="recording-box">
      <div className="card-head">
        <span className="card-title">🎙️ 课堂/会议录音</span>
        {recording ? (
          <span className="chip chip-pink" data-testid="rec-timer">
            ● 录音中 {fmtDur(seconds)}
          </span>
        ) : (
          <span className="chip chip-gray" data-testid="rec-status">
            {whisper === null ? '…' : whisper.available ? `语音组件就绪（${whisper.engine} · ${whisper.model}）` : '语音组件还没装好'}
          </span>
        )}
        <div className="grow" />
        {recording ? (
          <button type="button" className="btn btn-danger btn-sm" data-testid="rec-stop" onClick={stopRec}>
            ■ 停止并保存
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" data-testid="rec-start" disabled={busy} onClick={startRec}>
            ● 开始录音
          </button>
        )}
        <label className="btn btn-blue btn-sm" style={{ cursor: 'pointer' }}>
          📁 上传录音文件
          <input
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            data-testid="rec-upload"
            onChange={(e) => {
              onFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <div className="row-sub" style={{ lineHeight: 2 }}>
        上课/开会时让它听着（电脑上点「开始录音」）；手机上就用自带录音机录，回来传上来也一样。
        转成文字和总结都在这台电脑上算，不上云。
      </div>

      {notes.length > 0 && (
        <div className="list" data-testid="rec-list" style={{ marginTop: 10 }}>
          {notes.map((n) => (
            <div className={`list-row rec-item${n.id === openId ? ' open' : ''}`} key={n.id} data-testid={`rec-row-${n.id}`}>
              <span className={`chip ${n.status === 'failed' ? 'chip-gray' : n.status === 'done' ? 'chip-mint' : 'chip-blue'}`} data-testid={`rec-state-${n.id}`}>
                {STATUS_LABEL[n.status]}
              </span>
              {editId === n.id ? (
                <input
                  className="input grow"
                  autoFocus
                  data-testid={`rec-rename-input-${n.id}`}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTitle(n.id);
                    if (e.key === 'Escape') setEditId(null);
                  }}
                  onBlur={() => saveTitle(n.id)}
                />
              ) : (
                <span className="text grow" data-testid={`rec-title-${n.id}`}>
                  {n.title}
                  <span className="row-sub"> · {n.date.slice(5)} · 时长 {fmtDur(n.duration)}</span>
                </span>
              )}
              <audio controls preload="none" src={audioUrl(n)} style={{ height: 30, maxWidth: 180 }} />
              {(n.status === 'recorded' || n.status === 'failed') && (
                <button
                  type="button"
                  className="btn btn-blue btn-sm"
                  data-testid={`rec-transcribe-${n.id}`}
                  disabled={busy}
                  onClick={() => act(n.id, 'transcribe')}
                >
                  转写
                </button>
              )}
              {(n.status === 'transcribed' || n.status === 'done') && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-testid={`rec-summarize-${n.id}`}
                  disabled={busy || n.status === 'done'}
                  onClick={() => act(n.id, 'summarize')}
                >
                  {n.status === 'done' ? '已总结' : '生成总结'}
                </button>
              )}
              {(n.transcript || n.summary || n.error) && (
                <button
                  type="button"
                  className="link-more"
                  data-testid={`rec-view-${n.id}`}
                  onClick={() => setOpenId(openId === n.id ? null : n.id)}
                >
                  {openId === n.id ? '收起' : '查看'}
                </button>
              )}
              <div className="hover-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="重命名"
                  data-testid={`rec-edit-${n.id}`}
                  onClick={() => {
                    setEditId(n.id);
                    setEditText(n.title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="删除（连音频一起删）"
                  data-testid={`rec-del-${n.id}`}
                  onClick={() => remove('lessonNotes', n.id)}
                >
                  ✕
                </button>
              </div>
              {openId === n.id && (
                <div className="rec-detail" data-testid={`rec-detail-${n.id}`}>
                  {n.error && <div className="text-danger">{n.error}</div>}
                  {n.summary && (
                    <>
                      <div className="rec-label">📝 总结</div>
                      <pre className="rec-text" data-testid={`rec-summary-${n.id}`}>
                        {n.summary}
                      </pre>
                    </>
                  )}
                  {n.transcript && (
                    <>
                      <div className="rec-label">🎧 转写原文</div>
                      <pre className="rec-text" data-testid={`rec-transcript-${n.id}`}>
                        {n.transcript}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} testid="rec-toast" />}
    </div>
  );
}
