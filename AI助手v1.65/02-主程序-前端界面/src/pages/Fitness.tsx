import { useState } from 'react';
import { useStore } from '../store/StoreContext';
import { WEEKDAYS, addDays, fmtMD, today, weekdayIndex, weekRange } from '../lib/date';
import { EmptyState, Modal } from '../components/common';
import LineChart from '../components/LineChart';

export default function Fitness() {
  const { data, settings, create, update, remove, updateSettings } = useStore();
  const t = today();
  const todayIdx = weekdayIndex(t);
  const { start, end } = weekRange();

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [planText, setPlanText] = useState('');
  const [workoutModal, setWorkoutModal] = useState(false);
  const [workoutNote, setWorkoutNote] = useState('');
  const [weightInput, setWeightInput] = useState('');
  const [chartRange, setChartRange] = useState<'30' | 'all'>('30');

  const plan = settings.weeklyPlan;
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const hasLog = (date: string) => data.workoutLogs.some((w) => w.date === date);

  const weekWorkouts = data.workoutLogs.filter((w) => w.date >= start && w.date <= end).length;
  const plannedWorkouts = plan.filter((p) => p.trim() !== '' && p !== '休息').length;

  /* 连续记录：从今天（今天没记就从昨天）往前数，连续有训练或体重记录的天数 */
  const recorded = new Set([...data.workoutLogs.map((w) => w.date), ...data.weightLogs.map((w) => w.date)]);
  let streak = 0;
  let cursor = recorded.has(t) ? t : addDays(t, -1);
  while (recorded.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  const startEditPlan = (idx: number) => {
    setEditingIdx(idx);
    setPlanText(plan[idx] ?? '');
  };

  const commitPlan = async () => {
    if (editingIdx === null) return;
    const idx = editingIdx;
    setEditingIdx(null);
    const next = [...plan];
    next[idx] = planText.trim() || '休息';
    await updateSettings({ weeklyPlan: next });
  };

  const checkIn = async () => {
    const content = plan[todayIdx] && plan[todayIdx] !== '休息' ? plan[todayIdx] : '训练';
    const note = workoutNote;
    setWorkoutNote('');
    setWorkoutModal(false);
    await create('workoutLogs', { date: t, content, note });
  };

  const addWeight = async () => {
    const w = Number(weightInput);
    if (!w || w <= 0) return;
    setWeightInput('');
    await create('weightLogs', { date: t, weight: Math.round(w * 10) / 10 });
  };

  const workoutList = [...data.workoutLogs].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0),
  );
  const weightList = [...data.weightLogs].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0),
  );
  const chartLogs =
    chartRange === '30' ? data.weightLogs.filter((w) => w.date >= addDays(t, -29)) : data.weightLogs;

  return (
    <section className="page" data-testid="page-fitness">
      <div className="page-head">
        <h1 className="page-title">健身计划</h1>
        <div className="grow" />
        <span className="row-sub" data-testid="fitness-stats">
          本周已练 {weekWorkouts}/{plannedWorkouts} 次
        </span>
        <span className="chip chip-mint" data-testid="streak">
          连续记录 {streak} 天
        </span>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <span className="card-title">本周安排</span>
            <div className="grow" />
            <span className="row-sub">点格子就能改</span>
          </div>
          <div className="plan-strip" data-testid="week-strip">
            {plan.map((text, i) => (
              <div
                key={i}
                className={`plan-cell${i === todayIdx ? ' today' : ''}`}
                data-testid={`plan-cell-${i}`}
                onClick={() => startEditPlan(i)}
              >
                <div className="plan-day">{WEEKDAYS[i]}</div>
                {editingIdx === i ? (
                  <input
                    className="input"
                    autoFocus
                    value={planText}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPlanText(e.target.value)}
                    onBlur={commitPlan}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitPlan();
                      if (e.key === 'Escape') setEditingIdx(null);
                    }}
                  />
                ) : (
                  <>
                    <div className="plan-text">{text}</div>
                    {hasLog(weekDates[i]) && (
                      <div className="plan-check" data-testid={`plan-check-${i}`}>
                        ✓ 已练
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="complete-workout"
              onClick={() => setWorkoutModal(true)}
            >
              ✓ 完成今日训练{plan[todayIdx] && plan[todayIdx] !== '休息' ? `（${plan[todayIdx]}）` : ''}
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <span className="card-title">训练记录</span>
            </div>
            <div className="list" data-testid="workout-list">
              {workoutList.length === 0 ? (
                <EmptyState icon="🏋️" text="还没有训练记录，练完点上面打个卡吧" />
              ) : (
                workoutList.map((w) => (
                  <div className="list-row" key={w.id}>
                    <span className="row-sub" style={{ flex: '0 0 auto' }}>
                      {fmtMD(w.date)}
                    </span>
                    <span className="row-main">
                      {w.content}
                      {w.note ? ` · ${w.note}` : ''}
                    </span>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除"
                        data-testid="workout-del"
                        onClick={() => remove('workoutLogs', w.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">体重</span>
              <div className="grow" />
              <div className="tabs">
                <button
                  type="button"
                  className={`tab${chartRange === '30' ? ' active' : ''}`}
                  data-testid="chart-30"
                  onClick={() => setChartRange('30')}
                >
                  最近30天
                </button>
                <button
                  type="button"
                  className={`tab${chartRange === 'all' ? ' active' : ''}`}
                  data-testid="chart-all"
                  onClick={() => setChartRange('all')}
                >
                  全部
                </button>
              </div>
            </div>
            <div className="input-row" style={{ marginBottom: 10 }}>
              <input
                className="input"
                placeholder="今天的体重（kg）"
                inputMode="decimal"
                data-testid="weight-input"
                value={weightInput}
                onChange={(e) => setWeightInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addWeight();
                }}
              />
              <button type="button" className="btn" data-testid="weight-add" onClick={addWeight}>
                记录
              </button>
            </div>
            <LineChart
              testid="weight-chart"
              suffix="kg"
              pts={[...chartLogs]
                .sort((a, b) => a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0))
                .map((l) => ({ id: l.id, value: l.weight }))}
            />
            <div className="list" style={{ marginTop: 8 }} data-testid="weight-list">
              {weightList.length === 0 ? (
                <div className="row-sub" style={{ padding: 6 }}>
                  还没有体重记录
                </div>
              ) : (
                weightList.map((w) => (
                  <div className="list-row" key={w.id}>
                    <span className="row-sub" style={{ flex: '0 0 auto' }}>
                      {fmtMD(w.date)}
                    </span>
                    <span className="row-main">{w.weight} kg</span>
                    <div className="hover-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除"
                        data-testid="weight-del"
                        onClick={() => remove('weightLogs', w.id)}
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
      </div>

      <Modal
        open={workoutModal}
        title="完成今日训练 🎉"
        onClose={() => setWorkoutModal(false)}
        testid="workout-modal"
      >
        <div className="field">
          <label className="field-label">备注（选填，比如：卧推加了 2.5kg）</label>
          <input
            className="input"
            data-testid="workout-note"
            value={workoutNote}
            onChange={(e) => setWorkoutNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') checkIn();
            }}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setWorkoutModal(false)}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid="workout-save" onClick={checkIn}>
            打卡完成
          </button>
        </div>
      </Modal>
    </section>
  );
}
