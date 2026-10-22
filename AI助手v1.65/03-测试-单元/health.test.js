import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';

test('M0: 服务能启动，/api/health 返回正常', async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'AI 助手');
  } finally {
    server.close();
  }
});
