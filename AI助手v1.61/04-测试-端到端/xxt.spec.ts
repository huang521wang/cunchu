import { test, expect } from '@playwright/test';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

test('学习通桥：自测邮件进通知、配置保存且授权码不回显', async ({ page, request }) => {
  await page.goto('/');
  await openModule(page, 'study');
  const card = page.getByTestId('xxt-card');
  await expect(card).toBeVisible();

  // ① 自测：模拟一封学习通作业邮件 → 进通知列表（真实管道）
  await page.getByTestId('xxt-sim-toggle').click();
  await page.getByTestId('xxt-sim-input').fill('【高等数学】作业提醒：第三章课后习题\n课程【高等数学】有一份作业「第三章课后习题」，截止 10月30日 23:00 提交，要求手写拍照上传。\n—— 来自学习通');
  await page.getByTestId('xxt-sim-run').click();
  await expect(page.getByTestId('xxt-toast')).toContainText('认出来', { timeout: 10000 });
  await expect(card).toContainText('第三章课后习题');
  await expect(card).toContainText('高等数学');
  // 直连学习通入口在位（未连接状态）
  await expect(page.getByTestId('xxt-connect-btn')).toBeVisible();
  await expect(card).toContainText('只读');
  // 作业自动进了学习计划
  await expect(page.getByTestId('page-study')).toContainText('第三章课后习题');

  // ② 配置保存：授权码只存不回显
  await page.getByTestId('xxt-user').fill('abc@qq.com');
  await page.getByTestId('xxt-authcode').fill('SECRET-DONT-ECHO');
  await page.getByTestId('xxt-save').click();
  await expect(page.getByTestId('xxt-toast')).toContainText('已保存');
  const mw = await (await request.get('/api/mailwatch')).json();
  expect(mw.config.user).toBe('abc@qq.com');
  expect(mw.config.authCodeSet).toBe(true);
  expect(JSON.stringify(mw)).not.toContain('SECRET-DONT-ECHO', '接口绝不能回显授权码');

  // ③ 开启监听开关生效
  await page.getByTestId('xxt-toggle').click();
  await expect(page.getByTestId('xxt-state')).toHaveText('邮箱监听中', { timeout: 8000 });

  // ④ 非法邮件不被学习通认领（自测区在①已展开，保持展开直接填）
  await page.getByTestId('xxt-sim-input').scrollIntoViewIfNeeded();
  await page.getByTestId('xxt-sim-input').fill('双十一大促，全场五折！');
  await page.getByTestId('xxt-sim-run').click();
  await expect(page.getByTestId('xxt-toast')).toContainText('没认出', { timeout: 8000 });
});
