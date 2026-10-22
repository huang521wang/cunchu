import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { pFetch } from '../lib/api';
import type { PersonaThought } from '../types';

type PState = 'online' | 'daze' | 'nap' | 'sleep' | 'chatty' | 'hungry';

const MOOD_EMOJI: Record<string, string> = { happy: '😊', worry: '😟', curious: '🤔', sleepy: '😴', hungry: '🤤', excited: '🥳' };
const MOOD_LABEL: Record<string, string> = { happy: '开心', worry: '担心', curious: '好奇', sleepy: '困', hungry: '馋了', excited: '兴奋' };
const SOURCE_LABEL: Record<string, string> = { data: '看到的事', memory: '回忆', model: '自由发挥' };
const STATE_LABEL: Record<string, string> = {
  online: '在呢',
  daze: '发呆中…',
  nap: '打盹中…',
  sleep: '睡着了',
  chatty: '攒了好多话想说✨',
  hungry: '肚子咕咕了🍚',
  input: '正在输入…',
  think: '想着呢…',
};

/** 柳月虹的小头像：眼睛状态随心情，容器负责呼吸/漂移动效 */
function Face({ eyes }: { eyes: 'open' | 'half' | 'closed' }) {
  return (
    <svg viewBox="0 0 96 96" className="p-face" aria-hidden>
      <defs>
        <linearGradient id="p-hair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e587b4" />
          <stop offset="1" stopColor="#c96a9d" />
        </linearGradient>
        <radialGradient id="p-skin" cx="0.5" cy="0.42" r="0.75">
          <stop offset="0" stopColor="#ffeef6" />
          <stop offset="1" stopColor="#ffd9ea" />
        </radialGradient>
      </defs>
      {/* 头发 */}
      <path d="M18 46 Q18 20 48 20 Q78 20 78 46 L78 34 Q72 14 48 14 Q24 14 18 34 Z" fill="url(#p-hair)" />
      <path d="M20 40 Q26 24 36 22 L36 30 Q30 34 27 42 Z" fill="url(#p-hair)" />
      <path d="M76 40 Q70 24 60 22 L60 30 Q66 34 69 42 Z" fill="url(#p-hair)" />
      {/* 脸 */}
      <circle cx="48" cy="50" r="30" fill="url(#p-skin)" stroke="#f3c2da" strokeWidth="1.5" />
      {/* 呆毛 */}
      <path d="M48 20 Q54 12 60 14 Q54 18 52 24 Z" fill="url(#p-hair)" />
      {/* 腮红 */}
      <ellipse cx="33" cy="60" rx="6" ry="3.6" fill="#ffb9d8" opacity="0.85" />
      <ellipse cx="63" cy="60" rx="6" ry="3.6" fill="#ffb9d8" opacity="0.85" />
      {/* 眼睛 */}
      {eyes === 'closed' ? (
        <g stroke="#8a5a70" strokeWidth="2.4" strokeLinecap="round">
          <path d="M34 51 Q40 55 46 51" fill="none" />
          <path d="M50 51 Q56 55 62 51" fill="none" />
        </g>
      ) : eyes === 'half' ? (
        <g stroke="#8a5a70" strokeWidth="2.4" strokeLinecap="round">
          <path d="M34 52 Q40 50 46 52" fill="none" />
          <path d="M50 52 Q56 50 62 52" fill="none" />
        </g>
      ) : (
        <g>
          <circle cx="40" cy="50" r="3.4" fill="#6d4a5b" />
          <circle cx="56" cy="50" r="3.4" fill="#6d4a5b" />
          <circle cx="41.2" cy="48.8" r="1.1" fill="#fff" />
          <circle cx="57.2" cy="48.8" r="1.1" fill="#fff" />
        </g>
      )}
      {/* 嘴 */}
      {eyes === 'closed' ? (
        <circle cx="48" cy="62" r="2.6" fill="#b57d95" />
      ) : (
        <path d="M43 62 Q48 67 53 62" stroke="#b57d95" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      )}
      {/* 侧边小樱花 */}
      <g transform="translate(76 60)">
        <circle cx="0" cy="-4" r="2.6" fill="#ffc9e0" />
        <circle cx="3.8" cy="-1.2" r="2.6" fill="#ffc9e0" />
        <circle cx="2.4" cy="2.6" r="2.6" fill="#ffc9e0" />
        <circle cx="-2.4" cy="2.6" r="2.6" fill="#ffc9e0" />
        <circle cx="-3.8" cy="-1.2" r="2.6" fill="#ffc9e0" />
        <circle cx="0" cy="0" r="1.8" fill="#ffd98e" />
      </g>
    </svg>
  );
}

export default function PersonaCard({
  typing = false,
  thinking = false,
  onThoughtClick,
}: {
  typing?: boolean;
  thinking?: boolean;
  onThoughtClick: (text: string) => void;
}) {
  const { settings } = useStore();
  const persona = settings.persona;
  const [state, setState] = useState<PState>('online');
  const [thought, setThought] = useState<PersonaThought | null>(null);
  const [dream, setDream] = useState<PersonaThought | null>(null);
  const [greet, setGreet] = useState<string | null>(null);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [thoughts, setThoughts] = useState<PersonaThought[]>([]);
  const lastActive = useRef<number>(Date.now());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const touch = () => {
    lastActive.current = Date.now();
  };

  // 打开页面 / 点击她：叫醒并同步心事
  const wake = async () => {
    touch();
    try {
      const r = await pFetch('/api/persona/wake', { method: 'POST' });
      const j = await r.json();
      if (j.greet) setGreet(j.greet);
    } catch {
      // 服务没起就静默
    }
  };

  useEffect(() => {
    wake();
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (typing) return; // 正在聊就不 tick
      pFetch('/api/persona/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeAt: new Date(lastActive.current).toISOString() }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (j && j.state) setState(j.state);
          if (j.thought) showThought(j.thought);
          if (j.dream) setDream(j.dream);
          if (j.woke && j.greet) setGreet(j.greet);
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [typing]);

  const showThought = (t: PersonaThought) => {
    setThought(t);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setThought(null), 12000);
  };

  const openThoughts = async () => {
    setThoughtsOpen(true);
    try {
      const j = await (await pFetch('/api/persona')).json();
      setThoughts(j.persona.thoughts || []);
    } catch {
      setThoughts([]);
    }
  };

  // 8 秒后悄悄收起问候
  useEffect(() => {
    if (!greet) return;
    const t = setTimeout(() => setGreet(null), 9000);
    return () => clearTimeout(t);
  }, [greet]);

  const eyes: 'open' | 'half' | 'closed' =
    state === 'sleep' ? 'closed' : state === 'nap' || state === 'daze' ? 'half' : 'open';
  const shownState = typing ? 'input' : thinking ? 'think' : state;
  const statusText = greet || STATE_LABEL[shownState] || '在呢';

  const timeAgo = useMemo(() => {
    return (iso: string) => {
      const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
      return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`;
    };
  }, []);

  return (
    <div className="card persona-card" data-testid="persona-card" onClick={wake}>
      <div className={`persona-avatar st-${state}${typing ? ' typing' : ''}${thinking ? ' thinking' : ''}`}>
        <Face eyes={eyes} />
        {state === 'sleep' && (
          <>
            <span className="p-zzz">💤</span>
            <span className="p-star s1">✨</span>
            <span className="p-star s2">🌙</span>
            <span className="p-star s3">⭐</span>
          </>
        )}
        {thinking && <span className="p-spark">✦</span>}
      </div>
      <div className="persona-info">
        <div className="persona-name">
          {persona?.name || '柳月虹'}
          <button
            type="button"
            className="link-more"
            data-testid="persona-thoughts"
            onClick={(e) => {
              e.stopPropagation();
              openThoughts();
            }}
          >
            心事本
          </button>
        </div>
        <div className="persona-status" data-testid="persona-status">
          {typing ? (
            <span className="p-dots">
              <i>●</i>
              <i>●</i>
              <i>●</i>
            </span>
          ) : null}
          {statusText}
        </div>
      </div>

      {/* 念头气泡（发呆时） */}
      {thought && (
        <button
          type="button"
          className="p-thought-bubble"
          data-testid="persona-thought"
          onClick={(e) => {
            e.stopPropagation();
            onThoughtClick(`你刚才在想「${thought.text}」，展开说说？`);
          }}
        >
          <span className="p-thought-text">（{thought.text}）</span>
        </button>
      )}

      {/* 梦境气泡（睡觉时） */}
      {dream && state === 'sleep' && (
        <div className="p-dream-bubble" data-testid="persona-dream">
          {dream.text}
        </div>
      )}

      {/* 心事本 */}
      {thoughtsOpen && (
        <div className="modal-mask" onClick={() => setThoughtsOpen(false)}>
          <div className="modal" data-testid="persona-thoughts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">🌙 {persona?.name || '柳月虹'}的心事本</div>
            <div className="row-sub" style={{ marginBottom: 8 }}>
              她发呆时想的事都记在这里（保留最近 50 条），点一条可以接着聊。
            </div>
            <div className="list">
              {thoughts.length === 0 && <div className="row-sub">她还没开始想什么，先让她发会儿呆吧～</div>}
              {[...thoughts].reverse().map((t, i) => (
                <button
                  key={i}
                  type="button"
                  className="thought-item"
                  data-testid={`thought-${i}`}
                  onClick={() => {
                    setThoughtsOpen(false);
                    onThoughtClick(`你刚才在想「${t.text}」，展开说说？`);
                  }}
                >
                  <span>{MOOD_EMOJI[t.mood] || '🤔'}</span>
                  <span className="grow thought-text">{t.text}</span>
                  <span className="row-sub">
                    {SOURCE_LABEL[t.source] || ''} · {timeAgo(t.at)}
                  </span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setThoughtsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
