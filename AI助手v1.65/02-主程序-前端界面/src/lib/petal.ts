/** 勾选完成时飘一朵小花瓣：纯装饰、不挡鼠标、自动清理 */
export function petalBurst(x: number, y: number): void {
  try {
    const el = document.createElement('div');
    el.className = 'petal';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = '🌸';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  } catch {
    // 装饰性效果失败不影响任何功能
  }
}
