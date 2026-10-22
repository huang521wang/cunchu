import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-static-'));
}

async function boot(dir) {
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('优化：页面/接口有 gzip 压缩；带 hash 的静态资源长缓存；页面入口不缓存', async () => {
  const dir = tmpDir();
  const t = await boot(dir);
  try {
    // 页面入口：不缓存
    const idx = await fetch(`${t.base}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get('cache-control'), 'no-store');
    // 首页 HTML 很小，压缩器按设计跳过 <1KB 的内容（不断言 gzip）

    // API JSON（造点数据让它超过 1KB）也应压缩
    for (let i = 0; i < 20; i++) {
      await fetch(`${t.base}/api/memos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `测试备忘第 ${i} 条，内容稍微长一点用来超过压缩阈值` }),
      });
    }
    const api = await fetch(`${t.base}/api/all`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(api.headers.get('content-encoding'), 'gzip');
    // 明确不要压缩时（identity）就不压缩
    const raw = await fetch(`${t.base}/api/all`, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(raw.headers.get('content-encoding'), null);

    // 静态资源：找 dist/assets 里的一个真实文件，验证长缓存头
    const distAssets = path.resolve(process.cwd(), 'web', 'dist', 'assets');
    if (fs.existsSync(distAssets)) {
      const file = fs.readdirSync(distAssets).find((f) => /\.(js|css)$/.test(f));
      if (file) {
        const r = await fetch(`${t.base}/assets/${file}`, { headers: { 'Accept-Encoding': 'gzip' } });
        assert.equal(r.status, 200);
        const cc = r.headers.get('cache-control') || '';
        assert.ok(cc.includes('max-age=31536000'), `应长缓存，实际：${cc}`);
        assert.ok(cc.includes('immutable'));
        assert.equal(r.headers.get('content-encoding'), 'gzip'); // JS/CSS 也应压缩
      }
    }
  } finally {
    await t.close();
  }
});
