interface Draft {
  key: string;
  file: string;
  icon: string;
  name: string;
  desc: string;
}

const DRAFTS: Draft[] = [
  { key: 'wxdesk', file: '微信-桌面版.html', icon: '🖥', name: '微信 · 桌面版（Win 布局）', desc: '三栏布局：导航条 + 会话列表 + 聊天区，和电脑版微信一个思路' },
  { key: 'cxxdesk', file: '学习通-桌面版.html', icon: '🎓', name: '学习通 · 桌面版（粉蓝）', desc: '同款三栏布局，粉蓝配色：勾任务、勾章节、打卡、专注计时都能点' },
  { key: 'wechat', file: '微信-概念稿.html', icon: '💬', name: '微信 · 概念重设计（手机版）', desc: '会话聊天 · 通讯录 · 朋友圈（发/赞/删）· 表情面板' },
  { key: 'qq', file: 'QQ-概念稿.html', icon: '🐧', name: 'QQ · 概念重设计', desc: '动态瀑布（发/赞/删）· 联系人在线状态 · 心情选择' },
  { key: 'cxx', file: '学习通-概念稿.html', icon: '📚', name: '学习通 · 概念重设计', desc: '章节打卡联动进度 · 打卡养成 · 学习档案' },
  { key: 'fs', file: '飞书-概念稿.html', icon: '✈️', name: '飞书 · 概念重设计', desc: '文档能写能存 · 加待办 · 状态切换 · 消息与日程' },
];

export default function Design() {
  const open = (href: string) => window.open(href, '_blank');

  return (
    <section className="page" data-testid="page-design">
      <div className="page-head">
        <h1 className="page-title">设计稿</h1>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-blue"
          data-testid="open-concept-index"
          onClick={() => open('/concept/')}
        >
          打开总览页 →
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row-sub" style={{ lineHeight: 2 }}>
          🖌 这四份是个人设计练习的"概念重设计"（非官方，不使用官方标志）。每一份都能点着玩：
          进会话聊天、发一条朋友圈、勾章节打卡、写一份文档（自动保存）……全部本地运行、不联网。
          点卡片会新开一个标签页打开。
        </div>
      </div>

      <div className="grid grid-2">
        {DRAFTS.map((d) => (
          <div
            key={d.key}
            className="card summary-card"
            data-testid={`draft-${d.key}`}
            onClick={() => open(`/concept/${d.file}`)}
          >
            <div className="card-head">
              <span className="card-ico">{d.icon}</span>
              <span className="card-title">{d.name}</span>
            </div>
            <div className="row-sub">{d.desc}</div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  open(`/concept/${d.file}`);
                }}
              >
                打开概念稿 →
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
