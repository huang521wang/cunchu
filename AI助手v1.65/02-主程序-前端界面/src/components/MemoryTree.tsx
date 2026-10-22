import { useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtMD } from '../lib/date';
import { BRANCHES, BRANCH_MAP } from '../lib/branches';
import type { BranchKey } from '../lib/branches';
import { EmptyState } from './common';

/* 树枝的曲线与每朵花的落点（手调坐标，视觉上顺着枝条生长） */
const TREE: Record<BranchKey, { path: string; flowers: [number, number][]; label: [number, number] }> = {
  about: {
    path: 'M160 300 C118 268 92 210 74 138',
    flowers: [
      [79, 144],
      [92, 160],
      [104, 176],
      [115, 192],
      [126, 208],
      [136, 224],
      [145, 241],
    ],
    label: [26, 122],
  },
  work: {
    path: 'M160 272 C182 238 205 194 228 156',
    flowers: [
      [225, 161],
      [211, 177],
      [198, 193],
      [187, 209],
      [179, 225],
      [172, 241],
      [167, 257],
    ],
    label: [238, 142],
  },
  life: {
    path: 'M158 236 C124 212 92 202 58 204',
    flowers: [
      [61, 208],
      [79, 207],
      [97, 211],
      [113, 219],
      [127, 229],
      [139, 241],
      [148, 253],
    ],
    label: [10, 190],
  },
  preference: {
    path: 'M162 236 C196 214 228 204 262 206',
    flowers: [
      [259, 210],
      [241, 209],
      [223, 213],
      [207, 221],
      [193, 231],
      [181, 243],
      [172, 255],
    ],
    label: [256, 192],
  },
  idea: {
    path: 'M160 300 C168 240 172 150 166 78',
    flowers: [
      [166, 82],
      [166, 104],
      [165, 126],
      [165, 148],
      [164, 170],
      [163, 192],
      [162, 214],
    ],
    label: [178, 64],
  },
  rules: {
    path: 'M160 300 C200 296 240 296 276 300',
    flowers: [
      [272, 300],
      [254, 298],
      [236, 298],
      [218, 298],
      [200, 298],
      [182, 298],
    ],
    label: [222, 322],
  },
};

function Petals({ color }: { color: string }) {
  return (
    <g className="flower-in">
      {[0, 72, 144, 216, 288].map((a) => {
        const r = (a * Math.PI) / 180;
        return <circle key={a} cx={Math.cos(r) * 4.2} cy={Math.sin(r) * 4.2} r={3.5} fill={color} opacity="0.88" />;
      })}
      <circle r="2.2" fill="#FFF6E8" stroke="#D9C8A6" strokeWidth="0.7" />
    </g>
  );
}

export default function MemoryTree() {
  const { data, create, update, remove } = useStore();
  const [branch, setBranch] = useState<BranchKey>('about');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [flashId, setFlashId] = useState<string | null>(null);

  const memories = data.memories;
  const byBranch = useMemo(() => {
    const map = new Map<BranchKey, typeof memories>();
    for (const b of BRANCHES) map.set(b.key, []);
    for (const m of memories) {
      const k = (map.has(m.branch as BranchKey) ? m.branch : 'about') as BranchKey;
      map.get(k)!.push(m);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)),
      );
    }
    return map;
  }, [memories]);

  const current = byBranch.get(branch) ?? [];
  const visible = query.trim()
    ? current.filter((m) => m.text.includes(query.trim()))
    : current;
  const meta = BRANCH_MAP[branch];

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await create('memories', { branch, text: t, pinned: false, source: 'manual' });
  };

  const commitEdit = async () => {
    const id = editId;
    if (!id) return;
    setEditId(null);
    const t = editText.trim();
    if (t) await update('memories', id, { text: t });
  };

  const focusCard = (id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1200);
    requestAnimationFrame(() => {
      document.getElementById(`mem-card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  return (
    <div className="memory-layout" data-testid="memory-tree">
      {/* 左边：树 */}
      <div className="card tree-card">
        <div className="tree-stat" data-testid="tree-stat">
          这棵树已经记住了 {memories.length} 件事 🌸
        </div>
        <svg viewBox="0 0 300 460" className="tree-svg" role="img" aria-label="记忆树">
          <ellipse cx="160" cy="440" rx="66" ry="9" fill="#EADFD3" opacity="0.6" />
          {/* 树根 */}
          <path d="M160 430 C148 436 138 437 126 435" className="trunk trunk-thin" />
          <path d="M160 430 C172 436 182 437 194 435" className="trunk trunk-thin" />
          {/* 树干 */}
          <path d="M160 434 C159 380 159 330 160 292" className="trunk trunk-outer" />
          <path d="M160 430 C159 384 159 334 160 296" className="trunk trunk-inner" />
          {/* 五根枝 */}
          {BRANCHES.map((b) => {
            const t = TREE[b.key];
            const list = byBranch.get(b.key) ?? [];
            const on = b.key === branch;
            const show = list.length > 7 ? 6 : list.length;
            return (
              <g key={b.key} className={`branch${on ? ' on' : ''}`}>
                <path d={t.path} className="branch-hit" data-testid={`branch-${b.key}`} onClick={() => setBranch(b.key)} />
                <path
                  d={t.path}
                  className="branch-line"
                  style={{ stroke: b.color, opacity: on ? 0.9 : 0.5, strokeWidth: on ? 4.6 : 3.4 }}
                />
                <text
                  x={t.label[0]}
                  y={t.label[1]}
                  className="branch-label"
                  style={{ fill: b.color }}
                  data-testid={`branch-label-${b.key}`}
                  onClick={() => setBranch(b.key)}
                >
                  {b.emoji} {b.label}
                  {list.length > 0 ? ` · ${list.length}` : ''}
                </text>
                {list.slice(0, show).map((m, i) => {
                  const [x, y] = t.flowers[i];
                  return (
                    <g
                      key={m.id}
                      className={`flower${flashId === m.id ? ' on' : ''}`}
                      transform={`translate(${x} ${y})`}
                      data-testid={`flower-${m.id}`}
                      onClick={() => {
                        setBranch(b.key);
                        focusCard(m.id);
                      }}
                    >
                      <title>{m.text}</title>
                      <Petals color={b.color} />
                    </g>
                  );
                })}
                {list.length > 7 && (
                  <g
                    className="more-badge"
                    transform={`translate(${t.flowers[6][0]} ${t.flowers[6][1]})`}
                    data-testid={`flower-more-${b.key}`}
                    onClick={() => setBranch(b.key)}
                  >
                    <title>还有 {list.length - 6} 条，点开看</title>
                    <circle r="9.5" fill="#fff" stroke={b.color} strokeWidth="1.4" />
                    <text y="3.5" textAnchor="middle" fontSize="8" fontWeight="600" fill="#8C8489">
                      +{list.length - 6}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        <div className="branch-chips">
          {BRANCHES.map((b) => (
            <button
              type="button"
              key={b.key}
              className={`branch-chip${b.key === branch ? ' on' : ''}`}
              style={b.key === branch ? { color: b.color } : undefined}
              data-testid={`branch-chip-${b.key}`}
              onClick={() => setBranch(b.key)}
            >
              {b.emoji} {b.label} · {(byBranch.get(b.key) ?? []).length}
            </button>
          ))}
        </div>
      </div>

      {/* 右边：记忆卡片 */}
      <div className="card">
        <div className="card-head">
          <span className="card-title" data-testid="branch-title">
            {meta.emoji} {meta.label}
          </span>
          <span className="chip chip-pink" data-testid="branch-count">
            {current.length} 条
          </span>
          <div className="grow" />
          <input
            className="input"
            style={{ width: 158 }}
            placeholder="搜索记忆…"
            data-testid="memory-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="memory-list" data-testid="memory-list">
          {visible.length === 0 ? (
            <EmptyState
              icon={query ? '🔍' : '🌸'}
              text={query ? '这一枝里没有找到' : '这一枝还空着，在下面记点什么吧'}
            />
          ) : (
            visible.map((m) => (
              <div
                className={`memory-card${m.pinned ? ' pinned' : ''}${flashId === m.id ? ' flash' : ''}`}
                key={m.id}
                id={`mem-card-${m.id}`}
                data-testid={`memory-card-${m.id}`}
              >
                {editId === m.id ? (
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
                  <div
                    className="text"
                    onClick={() => {
                      setEditId(m.id);
                      setEditText(m.text);
                    }}
                  >
                    {m.text}
                  </div>
                )}
                <div className="memory-meta">
                  <span className={`chip ${m.source === 'chat' ? 'chip-blue' : 'chip-gray'}`}>
                    {m.source === 'chat' ? '聊天里记的' : '手动记的'}
                  </span>
                  <span className="mem-weight" title={`强度 ${m.weight || 1}/5：被再次印证会 +1`} data-testid={`memory-weight-${m.id}`}>
                    {'⋆'.repeat(Math.max(1, Math.min(5, Number(m.weight) || 1)))}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="强度 +1（手动加强）"
                    data-testid={`memory-plus-${m.id}`}
                    onClick={() => update('memories', m.id, { weight: Math.min(5, (Number(m.weight) || 1) + 1) })}
                  >
                    ＋
                  </button>
                  <span className="row-sub">{fmtMD(String(m.createdAt).slice(0, 10))}</span>
                  <div className="grow" />
                  <button
                    type="button"
                    className={`icon-btn pin-btn${m.pinned ? ' on' : ''}`}
                    title={m.pinned ? '取消钉住' : '钉住（优先带给助手）'}
                    data-testid={`memory-pin-${m.id}`}
                    onClick={() => update('memories', m.id, { pinned: !m.pinned })}
                  >
                    {m.pinned ? '⭐' : '☆'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="删除"
                    data-testid={`memory-del-${m.id}`}
                    onClick={() => remove('memories', m.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="input-row" style={{ marginTop: 12 }}>
          <input
            className="input"
            placeholder={`＋ 又想起点什么…（回车存到「${meta.label}」）`}
            data-testid="memory-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
        </div>
      </div>
    </div>
  );
}
