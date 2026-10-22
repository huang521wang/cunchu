import { test, expect } from '@playwright/test';
import http from 'node:http';
// @ts-ignore 纯 ESM 服务端模块，Playwright 转译不做类型检查，直接复用生产代码
import { submitTask } from '../server/xxttask.js';

/**
 * 学习通「提交作业」全链路——用一个复刻超星结构的本地假页跑真浏览器：
 *   隐藏的源码 textarea（DOM 最前，旧代码会误写这里）＋ 可见 contenteditable 富文本 iframe
 *   ＋「提 交」链接 ＋「确认提交吗」弹窗（不点确定=没交）。
 * 三种回执：成功文案 / 空回执（必须 unverified，不许假成功）/「答案不能为空」。
 * 绝不连真超星——红线：自动化停在用户确认之前，这里验证的是"确认之后真能交上去"的机制。
 */

const EDITOR_HTML = `<!doctype html><html><body contenteditable="true" style="margin:0;min-height:180px;border:1px solid #999"></body></html>`;

function mainHtml(mode: 'success' | 'silent' | 'empty'): string {
  const done = mode === 'success' ? "txt.length > 10 ? '提交成功' : '答案不能为空'" : mode === 'empty' ? "'答案不能为空'" : "''";
  return `<!doctype html><html><body>
<div style="display:none"><textarea id="src">OLD</textarea></div>
<h3 id="title">水准测量原理与计算（截止时间：2026-09-26）</h3>
<iframe id="editor" src="/editor.html" width="600" height="200"></iframe>
<a class="red" id="sub" href="javascript:void(0)">提 交</a>
<div id="mask" style="display:none"><span>确认提交作业吗？</span>
  <a class="layui-layer-btn0" id="okbtn" href="javascript:void(0)">确 定</a>
  <a id="nobtn" href="javascript:void(0)">取 消</a></div>
<div id="result"></div>
<script>
  document.getElementById('sub').onclick = function(){ document.getElementById('mask').style.display = 'block'; };
  document.getElementById('nobtn').onclick = function(){ document.getElementById('mask').style.display = 'none'; };
  document.getElementById('okbtn').onclick = function(){
    document.getElementById('mask').style.display = 'none';
    var txt = document.getElementById('editor').contentDocument.body.innerText.trim();
    document.getElementById('result').textContent = ${done};
  };
</script></body></html>`;
}

let srv: http.Server;
let origin = '';

test.beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const u = String(req.url || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (u.startsWith('/editor')) res.end(EDITOR_HTML);
    else if (u.includes('silent')) res.end(mainHtml('silent'));
    else if (u.includes('empty')) res.end(mainHtml('empty'));
    else res.end(mainHtml('success'));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(srv.address() as any).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
});

const DRAFT = '先算高差：hAB等于A尺读数减B尺读数，1526减1182等于344毫米，也就是0.344米。B点高程HB等于HA加hAB，12.658加0.344等于13.002米。';

test('学习通提交（假页全链路）：写进可见富文本、点掉确认弹窗、见回执才算交上', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(`${origin}/`);
  const r = await submitTask({ open: { page, cleanup: async () => {} }, text: DRAFT });
  expect(r.ok).toBe(true);
  expect(r.proof && r.proof.length > 100, '成功也要留证据截图').toBe(true);
  // 草稿必须进可见编辑器……
  const bodyText = await page.frameLocator('iframe#editor').locator('body').innerText();
  expect(bodyText.replace(/\s/g, '').length).toBeGreaterThan(20);
  // ……而不是隐藏源码 textarea（上晚事故的确切形状）
  expect(await page.evaluate(() => (document.getElementById('src') as HTMLTextAreaElement).value)).toBe('OLD');
});

test('学习通提交（假页）：点了提交但没回执 → unverified，绝不冒充已交', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(`${origin}/m/silent`);
  const r = await submitTask({ open: { page, cleanup: async () => {} }, text: DRAFT });
  expect(r.ok).toBe(false);
  expect(r.unverified).toBe(true);
  expect(!!r.needManual).toBe(false);
});

test('学习通提交（假页）：平台回"答案不能为空" → 指路人工，不无限重试', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(`${origin}/m/empty`);
  const r = await submitTask({ open: { page, cleanup: async () => {} }, text: DRAFT });
  expect(r.ok).toBe(false);
  expect(r.needManual).toBe(true);
});
