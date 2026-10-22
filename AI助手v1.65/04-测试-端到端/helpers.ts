import { APIRequestContext, Page, expect } from '@playwright/test';

/** 每个测试开始前，把服务端数据清空，保证测试之间互不影响 */
export async function resetData(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/wipe', { data: { confirm: '清空' } });
  expect(res.ok()).toBeTruthy();
}

/** 打开右侧工具箱并切到指定模块（v3：没有左侧导航，功能都在工具箱） */
export async function openModule(page: Page, key: string): Promise<void> {
  const tab = page.getByTestId(`toolbox-${key}`);
  if (!(await tab.isVisible().catch(() => false))) {
    await page.getByTestId('toolbox-open').click();
    await expect(tab).toBeVisible({ timeout: 5000 });
  }
  await tab.click();
}

/* ---- 假聊天模型：让 e2e 的"模型在线"状态自给自足，不再偷依赖本机真实模型进程 ---- */
import http from 'node:http';

let stubSrv: http.Server | null = null;

export async function useStubModel(request: APIRequestContext): Promise<void> {
  if (!stubSrv) {
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"stub"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    stubSrv = srv;
  }
  const port = (stubSrv.address() as { port: number }).port;
  const res = await request.put('/api/settings', {
    data: { modelApi: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-model' } },
  });
  expect(res.ok()).toBeTruthy();
}

export async function releaseStubModel(): Promise<void> {
  if (stubSrv) {
    await new Promise<void>((r) => stubSrv!.close(() => r()));
    stubSrv = null;
  }
}
