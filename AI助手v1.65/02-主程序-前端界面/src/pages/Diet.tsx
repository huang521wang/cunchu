import { useRef, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtCN, fmtMD, inRange, today, weekRange } from '../lib/date';
import type { MealDay } from '../types';
import { Confirm, EmptyState, SlidePanel } from '../components/common';

type MealField = 'breakfast' | 'lunch' | 'dinner' | 'snack';
const MEAL_LABELS: { field: MealField; label: string }[] = [
  { field: 'breakfast', label: '早餐' },
  { field: 'lunch', label: '午餐' },
  { field: 'dinner', label: '晚餐' },
  { field: 'snack', label: '加餐（选填）' },
];

function MealEditor({
  testid,
  label,
  value,
  onSave,
}: {
  testid: string;
  label: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<number | null>(null);

  const flush = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    onSave(text);
  };

  return (
    <div className="meal-card">
      <div className="meal-label">{label}</div>
      <textarea
        className="input"
        placeholder="吃了什么…（自动保存）"
        data-testid={testid}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onSave(v), 800);
        }}
        onBlur={flush}
      />
    </div>
  );
}

function WaterRow({
  prefix,
  water,
  goal,
  onSet,
}: {
  prefix: string;
  water: number;
  goal: number;
  onSet: (n: number) => void;
}) {
  return (
    <div className="water-row" data-testid={`${prefix}-row`}>
      {Array.from({ length: goal }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`drop${i < water ? ' filled' : ''}`}
          title={`${i + 1} 杯`}
          aria-label={`第 ${i + 1} 杯`}
          data-testid={`${prefix}-drop-${i + 1}`}
          onClick={() => onSet(water === i + 1 ? i : i + 1)}
        >
          💧
        </button>
      ))}
      <span className="row-sub" data-testid={`${prefix}-count`}>
        {water}/{goal} 杯
      </span>
    </div>
  );
}

export default function Diet() {
  const { data, settings, create, update, remove } = useStore();
  const t = today();
  const goal = settings.waterGoal || 8;

  const [panelDate, setPanelDate] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<null | (() => void)>(null);

  const todayMeal = data.mealDays.find((m) => m.date === t);

  // 同一天的写入串行执行，避免快速连点时同一天被创建出两条记录
  const idByDate = useRef<Record<string, string>>({});
  const writeChain = useRef<Record<string, Promise<unknown>>>({});

  const upsertMeal = (date: string, patch: Partial<MealDay>) => {
    const prev = writeChain.current[date] ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!idByDate.current[date]) {
        const found = data.mealDays.find((m) => m.date === date);
        if (found) idByDate.current[date] = found.id;
      }
      const knownId = idByDate.current[date];
      if (knownId) {
        await update('mealDays', knownId, patch as Record<string, unknown>);
      } else {
        const created = await create('mealDays', {
          date,
          breakfast: '',
          lunch: '',
          dinner: '',
          snack: '',
          water: 0,
          ...patch,
        });
        idByDate.current[date] = created.id;
      }
    });
    writeChain.current[date] = next.catch(() => {});
    return next;
  };

  const mealsLogged = [todayMeal?.breakfast, todayMeal?.lunch, todayMeal?.dinner].filter(
    (x) => x && x.trim() !== '',
  ).length;

  const { start, end } = weekRange();
  const weekDays = data.mealDays.filter(
    (m) =>
      inRange(m.date, start, end) &&
      [m.breakfast, m.lunch, m.dinner, m.snack].some((x) => x && x.trim() !== ''),
  ).length;

  const history = [...data.mealDays].sort((a, b) => b.date.localeCompare(a.date));
  const panelMeal = panelDate ? data.mealDays.find((m) => m.date === panelDate) : undefined;

  return (
    <section className="page" data-testid="page-diet">
      <div className="page-head">
        <h1 className="page-title">饮食计划</h1>
        <span className="row-sub">{fmtCN(t)}</span>
        <div className="grow" />
        <span className="chip chip-pink" data-testid="diet-progress">
          三餐已记 {mealsLogged}/3
        </span>
        <span className="chip chip-mint" data-testid="diet-week">
          本周记录 {weekDays}/7 天
        </span>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <span className="card-title">今天吃了什么</span>
          </div>
          <div className="meal-grid">
            {MEAL_LABELS.map((m) => (
              <MealEditor
                key={`${t}-${m.field}`}
                testid={`meal-${m.field}`}
                label={m.label}
                value={todayMeal?.[m.field] ?? ''}
                onSave={(v) => upsertMeal(t, { [m.field]: v })}
              />
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">喝水</span>
            <div className="grow" />
            <span className="row-sub">点第几个水滴就是几杯，再点一下可以减</span>
          </div>
          <WaterRow
            prefix="water"
            water={todayMeal?.water ?? 0}
            goal={goal}
            onSet={(n) => upsertMeal(t, { water: n })}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">最近记录</span>
          </div>
          <div className="list" data-testid="diet-history">
            {history.length === 0 ? (
              <EmptyState icon="🍚" text="还没有记录，从今天的早餐开始吧" />
            ) : (
              history.map((m) => (
                <div className="list-row" key={m.id} data-testid="history-row">
                  <span className="row-sub" style={{ flex: '0 0 auto' }}>
                    {fmtMD(m.date)}
                  </span>
                  <span className="row-main">
                    早:{m.breakfast || '—'} 午:{m.lunch || '—'} 晚:{m.dinner || '—'}
                    {m.snack ? ` 加:${m.snack}` : ''}
                  </span>
                  <span className="row-sub" style={{ flex: '0 0 auto' }}>
                    喝水 {m.water}/{goal}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-blue"
                    data-testid="history-view"
                    onClick={() => setPanelDate(m.date)}
                  >
                    查看
                  </button>
                  <div className="hover-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除这一天的记录"
                      data-testid="history-del"
                      onClick={() => setConfirmDel(() => () => remove('mealDays', m.id))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <SlidePanel
        open={panelDate !== null}
        title={panelDate ? `编辑 ${fmtCN(panelDate)}` : ''}
        onClose={() => setPanelDate(null)}
        testid="day-panel"
      >
        {panelDate && (
          <div>
            <div className="stack">
              {MEAL_LABELS.map((m) => (
                <MealEditor
                  key={`${panelDate}-${m.field}`}
                  testid={`panel-${m.field}`}
                  label={m.label}
                  value={panelMeal?.[m.field] ?? ''}
                  onSave={(v) => upsertMeal(panelDate, { [m.field]: v })}
                />
              ))}
              <div className="meal-card">
                <div className="meal-label">喝水</div>
                <WaterRow
                  prefix="panel-water"
                  water={panelMeal?.water ?? 0}
                  goal={goal}
                  onSet={(n) => upsertMeal(panelDate, { water: n })}
                />
              </div>
            </div>
          </div>
        )}
      </SlidePanel>

      <Confirm
        open={confirmDel !== null}
        title="删除这一天的饮食记录？"
        onOk={() => {
          confirmDel?.();
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </section>
  );
}
