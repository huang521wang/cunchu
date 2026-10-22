import { test, expect } from '@playwright/test';
import http from 'node:http';
import { resetData, openModule } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetData(request);
});

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}
function fmtMD(s: string): string {
  const [, m, d] = s.split('-');
  return `${Number(m)}/${Number(d)}`;
}

test('学习计划：添加/完成/编辑/删除，刷新后还在', async ({ page }) => {
  await page.goto('/');
  await openModule(page, 'study');
  await expect(page.getByTestId('page-study')).toBeVisible();
  await expect(page.getByTestId('study-empty')).toBeVisible();

  const t2 = dateStr(addDays(new Date(), 2));
  await page.getByTestId('study-input').fill('第三章课后习题');
  await page.getByTestId('study-course-input').fill('高等数学');
  await page.getByTestId('study-due').fill(t2);
  await page.getByTestId('study-add').click();
  await expect(page.getByTestId('study-list')).toContainText('第三章课后习题');
  await expect(page.getByTestId('study-list')).toContainText('高等数学');
  await expect(page.getByTestId('study-list')).toContainText(`截止 ${fmtMD(t2)}`);
  await expect(page.getByTestId('study-stat-doing')).toContainText('进行中 1');

  // 再加一条"昨天截止"的，看已过期标记、排序和侧边栏徽标
  const tY = dateStr(addDays(new Date(), -1));
  await page.getByTestId('study-input').fill('昨天的作业');
  await page.getByTestId('study-due').fill(tY);
  await page.getByTestId('study-add').click();
  await expect(page.getByTestId('study-stat-late')).toContainText('已过期 1');
  const rows = page.getByTestId('study-list').locator('.study-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('昨天的作业'); // 过期的排最前
  await expect(rows.first()).toContainText('已过期');
  await openModule(page, 'study');
  await expect(page.getByTestId('badge-study')).toHaveText('1');

  // 完成"昨天的作业"
  await rows.first().locator('[data-testid^="study-check-"]').click();
  await expect(page.getByTestId('study-stat-doing')).toContainText('进行中 1');
  await page.getByTestId('study-done-toggle').click();
  await expect(page.getByTestId('study-done-group')).toContainText('昨天的作业');

  // 编辑剩下那条
  const only = page.getByTestId('study-list').locator('.study-item').first();
  await only.hover();
  await only.locator('[data-testid^="study-edit-"]').click();
  const editInput = page.locator('[data-testid^="study-edit-input-"]');
  await editInput.fill('第三章课后习题（改）');
  await editInput.press('Enter');
  await expect(page.getByTestId('study-list')).toContainText('第三章课后习题（改）');

  // 刷新后还在
  await page.reload();
  await openModule(page, 'study');
  await expect(page.getByTestId('study-stat-doing')).toContainText('进行中 1');
  await expect(page.getByTestId('study-list')).toContainText('第三章课后习题（改）');
  await expect(page.getByTestId('study-done-group')).toContainText('已完成 1');

  // 删除剩下的
  const last = page.getByTestId('study-list').locator('.study-item').first();
  await last.hover();
  await last.locator('[data-testid^="study-del-"]').click();
  await expect(page.getByTestId('study-list').locator('.study-item')).toHaveCount(0);
});

test('粘贴导入：从学习通复制的文字，本地解析成任务（不碰账号）', async ({ page, request }) => {
  const tmr = dateStr(addDays(new Date(), 1));
  await page.goto('/');
  await openModule(page, 'study');
  await page.getByTestId('study-import-open').click();
  await expect(page.getByTestId('study-import')).toBeVisible();

  await page
    .getByTestId('study-import-text')
    .fill(
      '【高等数学】第三章课后习题 截止：明天 23:59\n大学英语|背诵 Unit 5 单词|后天\n期中考试 11月5日\n下周一的实验报告',
    );
  await page.getByTestId('study-import-parse').click();

  const preview = page.getByTestId('study-import-preview');
  await expect(preview.locator('[data-testid^="study-preview-"]')).toHaveCount(4);
  await expect(preview).toContainText('高等数学');
  await expect(preview).toContainText('第三章课后习题');
  await expect(preview).toContainText('大学英语');
  await expect(preview).toContainText('期中考试');
  await expect(preview).toContainText('实验报告');
  await expect(preview).not.toContainText('的实验报告');
  await expect(preview).toContainText(`截止 ${fmtMD(tmr)}`);

  await page.getByTestId('study-import-confirm').click();
  await expect(page.getByTestId('study-toast')).toContainText('已导入 4 条');

  const api = await (await request.get('/api/studyItems')).json();
  expect(api.length).toBe(4);
  const math = api.find((x: any) => x.course === '高等数学');
  expect(math.title).toBe('第三章课后习题');
  expect(math.due).toBe(tmr);
  expect(math.kind).toBe('作业');
  const eng = api.find((x: any) => x.course === '大学英语');
  expect(eng.title).toBe('背诵 Unit 5 单词');
  const exam = api.find((x: any) => x.kind === '考试');
  expect(exam.title).toBe('期中考试');

  await expect(page.getByTestId('study-list')).toContainText('第三章课后习题');
});

test('AI 助手：说「加作业」→ 确认卡（日期自动认出来）→ 进学习计划', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"好的"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await request.put('/api/settings', {
      data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-r1' } },
    });
    const tmr = dateStr(addDays(new Date(), 1));
    await page.goto('/');
    await page.getByTestId('page-assistant').waitFor();
    await page.getByTestId('chat-input').fill('加作业：明天 交高数第三章');
    await page.getByTestId('chat-input').press('Enter');

    await expect(page.getByTestId('action-confirm')).toBeVisible();
    await expect(page.getByTestId('action-confirm-text')).toContainText('高数第三章');
    await expect(page.getByTestId('action-study-due')).toHaveValue(tmr); // "明天"被自动认出来
    await page.getByTestId('action-confirm-ok').click();
    await expect(page.getByTestId('assistant-toast')).toContainText('已记入学习计划');

    const api = await (await request.get('/api/studyItems')).json();
    expect(api.length).toBe(1);
    expect(api[0].title).toBe('交高数第三章');
    expect(api[0].due).toBe(tmr);
    expect(api[0].kind).toBe('作业');

    await page.getByTestId('assistant-toast').getByRole('button', { name: '去看看' }).click();
    await expect(page.getByTestId('page-study')).toBeVisible();
    await expect(page.getByTestId('study-list')).toContainText('交高数第三章');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('AI 助手快捷操作「加作业」也能记（不需要模型）', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('page-assistant').waitFor();
  await page.getByTestId('quick-study').click();
  await page.getByTestId('q-study-title').fill('背单词 Unit 5');
  await page.getByTestId('q-study-course').fill('大学英语');
  await page.getByTestId('q-study-kind').selectOption('复习');
  await page.getByTestId('q-save').click();
  await expect(page.getByTestId('assistant-toast')).toContainText('已记入学习计划');
  const api = await (await request.get('/api/studyItems')).json();
  expect(
    api.some((x: any) => x.title === '背单词 Unit 5' && x.course === '大学英语' && x.kind === '复习'),
  ).toBeTruthy();
});

test('课堂录音：上传 → 转写 → 总结 → 删除（本地假引擎 + 桩模型，全流程）', async ({ page, request }) => {
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'stub-r1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({ choices: [{ message: { content: 'STUB 总结：本节讲了矩阵的秩，作业下周一截止。' } }] }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    await request.put('/api/settings', {
      data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub' } },
    });

    await page.goto('/');
    await openModule(page, 'study');
    await expect(page.getByTestId('recording-box')).toBeVisible();

    // 上传一段"录音"（模拟手机录音机传回来的文件）
    await page.getByTestId('rec-upload').setInputFiles({
      name: '课堂.webm',
      mimeType: 'audio/webm',
      buffer: Buffer.from('fake-audio-bytes'),
    });
    await expect(page.getByTestId('rec-list').locator('.rec-item')).toHaveCount(1);
    const notes = await (await request.get('/api/lessonNotes')).json();
    expect(notes.length).toBe(1);
    const id = notes[0].id;
    await expect(page.getByTestId(`rec-state-${id}`)).toContainText('已录音');

    // 转写（后台跑，页面自动刷新）
    await page.getByTestId(`rec-transcribe-${id}`).click();
    await expect(page.getByTestId(`rec-state-${id}`)).toContainText('已转写', { timeout: 25000 });

    // 总结
    await page.getByTestId(`rec-summarize-${id}`).click();
    await expect(page.getByTestId(`rec-state-${id}`)).toContainText('已总结', { timeout: 30000 });

    // 展开看原文和总结
    await page.getByTestId(`rec-view-${id}`).click();
    await expect(page.getByTestId(`rec-transcript-${id}`)).toContainText('矩阵的秩');
    await expect(page.getByTestId(`rec-summary-${id}`)).toContainText('STUB 总结');
    // 播放器在（音频文件能播）
    await expect(page.getByTestId(`rec-row-${id}`).locator('audio')).toHaveCount(1);

    // 删除：记录和音频文件一起清（服务器端会顺手删掉文件）
    await page.getByTestId(`rec-del-${id}`).click();
    await expect(page.getByTestId('rec-list').locator('.rec-item')).toHaveCount(0);
    const left = await (await request.get('/api/lessonNotes')).json();
    expect(left.length).toBe(0);
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
