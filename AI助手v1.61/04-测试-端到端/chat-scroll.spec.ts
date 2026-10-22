import { test, expect } from '@playwright/test';
import { resetData } from './helpers';

test('聊天滚动吸底：上滑出现「回到底部」，点击回底后按钮消失，不再抢滚动条', async ({ page, request }) => {
  await resetData(request);
  // 造长对话让 chat-list 出滚动条
  for (let i = 0; i < 24; i++) {
    await request.post('/api/chatMessages', {
      data: { role: i % 2 ? 'assistant' : 'user', content: `第${i}条消息：${'很长很长的回复内容'.repeat(12)}` },
    });
  }
  await page.goto('/');
  const list = page.getByTestId('chat-list');
  await expect(list).toBeVisible();
  await page.waitForTimeout(800); // 等消息载入+初始贴底
  // 模拟用户上滑翻看（滚到顶）
  await list.evaluate((el) => {
    el.style.scrollBehavior = 'auto'; // 测试里免掉平滑动画干扰读数
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  const jump = page.getByTestId('chat-jump-bottom');
  await expect(jump).toBeVisible({ timeout: 3000 });
  // 点回到底部 → 按钮消失、真的在底部
  await jump.click();
  await page.waitForTimeout(500);
  await expect(jump).toHaveCount(0);
  const gap = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeLessThan(60);
});
