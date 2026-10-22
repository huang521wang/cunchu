/** 通用趋势折线图：粉→薄荷渐变 + 圆点，用于体重曲线、游戏时长趋势等 */
export default function LineChart({
  pts,
  suffix = '',
  testid,
}: {
  pts: { id: string; value: number }[];
  suffix?: string;
  testid: string;
}) {
  if (pts.length === 0) {
    return (
      <div className="row-sub" style={{ padding: '24px 8px', textAlign: 'center' }}>
        还没有记录，有一条数据就有曲线啦
      </div>
    );
  }
  const W = 320;
  const H = 130;
  const PAD = 16;
  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (pts.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (pts.length - 1));
  const y = (v: number) => PAD + ((max - v) / span) * (H - 2 * PAD);
  const points = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const gradId = `grad-${testid}`;
  return (
    <svg className="trend-chart" viewBox={`0 0 ${W} ${H}`} data-testid={testid}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff9ec4" />
          <stop offset="100%" stopColor="#7edcc6" />
        </linearGradient>
      </defs>
      {pts.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {pts.map((p, i) => (
        <circle key={p.id} cx={x(i)} cy={y(p.value)} r="4" fill="#ff9ec4" />
      ))}
      <text x={PAD} y={12} fontSize="11" fill="#9a8a94">
        {max}
        {suffix}
      </text>
      <text x={PAD} y={H - 4} fontSize="11" fill="#9a8a94">
        {min}
        {suffix}
      </text>
    </svg>
  );
}
