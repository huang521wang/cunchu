import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 知识库出厂体检（真库 D:\知识库）：每次全量回归都跑——规格不达标直接红。
 * 标准：README 讲清规矩 / 每条知识 front-matter 齐全带只读声明 / 分类目录合法 / 索引与磁盘一致 / 无空文。
 */
const ROOT = 'D:\\知识库';

test('知识库体检：结构、格式、索引一致性（真库）', () => {
  if (!fs.existsSync(ROOT)) {
    console.log('（本机没有 ' + ROOT + '，跳过体检）');
    return;
  }
  // README 必备条款
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const must of ['只读', '待审区', '批准', '铁律', 'mcpServers']) {
    assert.ok(readme.includes(must), `README 缺关键条款：${must}`);
  }
  // 目录与条目
  const cats = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name)).map((d) => d.name);
  assert.ok(cats.length >= 9, '分类数不足 9');
  const ids = new Set();
  let count = 0;
  for (const cat of cats) {
    for (const f of fs.readdirSync(path.join(ROOT, cat)).filter((x) => x.endsWith('.md'))) {
      count++;
      const raw = fs.readFileSync(path.join(ROOT, cat, f), 'utf8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      assert.ok(m, `条目缺 front-matter：${cat}/${f}`);
      const meta = {};
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      for (const key of ['id', '分类', '标题', '标签', '更新', '权限']) {
        assert.ok(meta[key], `缺字段「${key}」：${cat}/${f}`);
      }
      assert.ok(meta['权限'].includes('只读') && meta['权限'].includes('阿珑'), `权限声明必须写明只读+需阿珑同意：${cat}/${f}`);
      assert.equal(meta['分类'], cat, `分类与目录不符：${cat}/${f}`);
      assert.ok(m[2].trim().length >= 20, `正文太空：${cat}/${f}`);
      assert.ok(!ids.has(meta.id), `id 重复：${meta.id}`);
      ids.add(meta.id);
    }
  }
  // 索引与磁盘一致
  const idx = fs.readFileSync(path.join(ROOT, 'INDEX.md'), 'utf8');
  assert.ok(idx.includes(`共 ${count} 条`), `索引条数与实际不符（应 ${count}）`);
  for (const id of ids) {
    const leaf = id.split('/')[1];
    assert.ok(idx.includes(leaf), `索引缺条目 ${id}`);
  }
  // 待审区存在 + 正式库内不许有 json 散件
  assert.ok(fs.existsSync(path.join(ROOT, '_待审区')), '缺 _待审区');
  for (const cat of cats) {
    assert.ok(!fs.readdirSync(path.join(ROOT, cat)).some((x) => x.endsWith('.json')), `${cat} 混入 json（只能 .md）`);
  }
  // MCP 服务器文件就位且可解析
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp', 'server.mjs'), 'utf8');
  assert.ok(mcp.includes('kb_pending_add') && mcp.includes('kb_overview'), 'MCP 工具不全');
  console.log(`体检通过：${cats.length} 类 / ${count} 条`);
});
