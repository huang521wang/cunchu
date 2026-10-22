import { useState } from 'react';
import { StoreProvider, useStore } from './store/StoreContext';
import { PIN_KEY, NeedPinError } from './lib/api';
import Assistant from './pages/Assistant';

/** 手机（同一 WiFi）第一次打开时，输入电脑上显示的口令 */
function PinGate() {
  const { reload } = useStore();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const v = pin.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr('');
    localStorage.setItem(PIN_KEY, v);
    try {
      await reload();
      // 成功的话 reload 会把 needPin 置为 false，这里不用做什么
    } catch (e) {
      localStorage.removeItem(PIN_KEY);
      setErr(
        e instanceof NeedPinError && e.message && e.message !== '需要访问口令'
          ? e.message
          : '口令不对，再看一眼电脑上的「启动工作台」窗口',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin-gate" data-testid="pin-gate">
      <div className="pin-card">
        <div className="pin-emoji">🌸</div>
        <div className="pin-title">AI 助手</div>
        <div className="pin-sub">
          为了不让同一个 WiFi 下的设备随便看到你的数据，
          <br />
          请输入电脑上「启动工作台」窗口里显示的口令
        </div>
        <input
          className="input"
          inputMode="numeric"
          autoFocus
          placeholder="6 位数字口令"
          data-testid="pin-input"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        {err && (
          <div className="text-danger" data-testid="pin-error">
            {err}
          </div>
        )}
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 10 }}
          data-testid="pin-submit"
          disabled={busy || !pin.trim()}
          onClick={submit}
        >
          {busy ? '检查中…' : '进入 AI 助手'}
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const { ready, needPin } = useStore();

  if (needPin) return <PinGate />;

  if (!ready) {
    return <div className="boot">🌸 正在打开 AI 助手…</div>;
  }

  // v3：没有左侧导航了——整个应用就是 AI 助手，一切功能在右侧工具箱里
  return (
    <div className="app-shell">
      <main className="app-main app-main-full">
        <Assistant />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
