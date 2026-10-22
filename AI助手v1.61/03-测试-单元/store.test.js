import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, COLLECTIONS, defaultSettings } from '../server/store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-store-'));
}

test('首次加载会自动创建空库，包含全部集合和默认设置', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  assert.ok(fs.existsSync(store.file), '数据文件应被创建');
  const parsed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(parsed.version, 1);
  for (const c of COLLECTIONS) {
    assert.ok(Array.isArray(parsed.data[c]), `集合 ${c} 应该存在且为数组`);
    assert.equal(parsed.data[c].length, 0);
  }
  const expected = defaultSettings();
  expected.persona.lastActiveAt = parsed.settings.persona.lastActiveAt; // 时间戳动态，单独对齐
  assert.deepEqual(parsed.settings, expected);
});

test('保存后重新加载，数据完全一致（持久化）', () => {
  const dir = tmpDir();
  const s1 = new Store(dir);
  s1.load();
  s1.db.data.tasks.push({
    id: 'x1',
    title: '写周报',
    date: '2026-10-11',
    priority: 'high',
    done: false,
    doneAt: null,
    createdAt: 't',
    updatedAt: 't',
  });
  s1.db.settings.theme = 'dark';
  s1.save();

  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.db.data.tasks.length, 1);
  assert.equal(s2.db.data.tasks[0].title, '写周报');
  assert.equal(s2.db.data.tasks[0].priority, 'high');
  assert.equal(s2.db.settings.theme, 'dark');
});

test('原子写入：保存后没有残留的临时文件', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  store.save();
  assert.ok(!fs.existsSync(`${store.file}.tmp`), '不应残留 .tmp 临时文件');
});

test('每天首次写入自动备份，且备份的是写入前的状态', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  assert.equal(store.db.data.memos.length, 0);
  store.db.data.memos.push({ id: 'm1', text: '买牛奶' });
  store.save();

  const backupDir = path.join(dir, 'backups');
  const files = fs.readdirSync(backupDir);
  assert.equal(files.length, 1, '应该只生成一份当日自动备份');
  assert.match(files[0], /^auto-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, files[0]), 'utf8'));
  assert.equal(backup.data.memos.length, 0, '自动备份应是写入前的状态');

  // 同一天再次保存：不重复生成备份，但数据正常写入
  store.db.data.memos.push({ id: 'm2', text: '取快递' });
  store.save();
  assert.equal(fs.readdirSync(backupDir).length, 1, '同一天不重复备份');
  const reloaded = new Store(dir);
  reloaded.load();
  assert.equal(reloaded.db.data.memos.length, 2, '两条备忘都应持久化');
});

test('跨天会生成新的自动备份', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  store.save();
  const before = fs.readdirSync(path.join(dir, 'backups')).length;

  store._today = () => '2000-01-02';
  store.save();

  const after = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(after.length, before + 1);
  assert.ok(after.includes('auto-2000-01-02.json'));
});

test('backupNow 在导入/清空前生成手动备份', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  store.db.data.tasks.push({ id: 't1', title: '任务', date: '2026-10-11' });
  store.save();
  const dest = store.backupNow('import');
  assert.ok(dest && fs.existsSync(dest));
  assert.match(path.basename(dest), /^before-import-\d{8}-\d{6}\.json$/);
  const content = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(content.data.tasks.length, 1, '手动备份应包含操作前的数据');
});

test('replaceAll 导入数据后数据一致', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  store.replaceAll({
    settings: { theme: 'dark' },
    data: { tasks: [{ id: 'a', title: '导入的任务' }], unknownCollection: [1, 2] },
  });
  assert.equal(store.db.data.tasks.length, 1);
  assert.equal(store.db.data.tasks[0].title, '导入的任务');
  assert.equal(store.db.settings.theme, 'dark');
  assert.equal(store.db.settings.platforms.length, 5, '未提供的设置应回落到默认值');
  assert.ok(!('unknownCollection' in store.db.data), '未知集合应被忽略');

  const reloaded = new Store(dir);
  reloaded.load();
  assert.equal(reloaded.db.data.tasks.length, 1);
});

test('reset 清空全部数据并回到默认设置', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  store.db.data.tasks.push({ id: 't1', title: '任务' });
  store.db.settings.theme = 'dark';
  store.save();
  store.reset();
  const reloaded = new Store(dir);
  reloaded.load();
  assert.equal(reloaded.db.data.tasks.length, 0);
  const expected = defaultSettings();
  expected.persona.lastActiveAt = reloaded.db.settings.persona.lastActiveAt;
  assert.deepEqual(reloaded.db.settings, expected);
});

test('数据文件损坏时保留损坏副本并重建空库', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.load();
  fs.writeFileSync(store.file, '{ 这不是合法JSON', 'utf8');

  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.db.data.tasks.length, 0);
  const broken = fs.readdirSync(dir).filter((f) => f.includes('.broken-'));
  assert.equal(broken.length, 1, '应保留一份损坏副本');
});
