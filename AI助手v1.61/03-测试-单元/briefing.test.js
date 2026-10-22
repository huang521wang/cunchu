import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longapp-brief-'));
}

async function boot() {
  const dir = tmpDir();
process.env.MEMORY_DIR = path.join(dir, 'memory-files');
    const { server, port } = await startServer({ dataDir: dir, port: 0, openBrowser: false });
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDay = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ds(d);
};

async function post(base, collection, body) {
  const res = await fetch(`${base}/api/${collection}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('GET /api/briefing：把今日任务和学习截止合成简报', async () => {
  const t = await boot();
  try {
    const today = ds(new Date());
    await post(t.base, 'tasks', {
      title: '交方案',
      date: today,
      time: '',
      estimate: '',
      note: '',
      priority: 'none',
      done: false,
      doneAt: null,
    });
    await post(t.base, 'tasks', {
      title: '已完成的不该出现',
      date: today,
      time: '',
      estimate: '',
      note: '',
      priority: 'none',
      done: true,
      doneAt: null,
    });
    await post(t.base, 'studyItems', {
      title: '第三章课后习题',
      course: '高等数学',
      kind: '作业',
      due: addDay(1),
      done: false,
      doneAt: null,
    });
    await post(t.base, 'studyItems', {
      title: '过期作业',
      course: '大学英语',
      kind: '作业',
      due: addDay(-1),
      done: false,
      doneAt: null,
    });
    await post(t.base, 'studyItems', {
      title: '已完成的作业',
      course: '物理',
      kind: '作业',
      due: addDay(1),
      done: true,
      doneAt: null,
    });

    const res = await fetch(`${t.base}/api/briefing`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.date, today);
    assert.deepEqual(b.tasks, ['交方案']);
    assert.deepEqual(b.studyDueTomorrow, ['第三章课后习题（高等数学）']);
    assert.deepEqual(b.studyLate, ['过期作业（大学英语）']);
    assert.deepEqual(b.studyDueToday, []);
    assert.ok(b.text.includes('交方案'));
    assert.ok(b.text.includes('明天截止：第三章课后习题（高等数学）'));
    assert.ok(b.text.includes('已过期：过期作业（大学英语）'));
    assert.ok(!b.text.includes('已完成的不该出现'));
    assert.ok(!b.text.includes('已完成的作业'));
  } finally {
    await t.close();
  }
});

test('GET /api/briefing：没任务时给鼓励语；可以指定日期', async () => {
  const t = await boot();
  try {
    const res = await fetch(`${t.base}/api/briefing?date=2030-01-01`);
    const b = await res.json();
    assert.equal(b.date, '2030-01-01');
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
      new Date('2030-01-01T00:00:00').getDay()
    ];
    assert.equal(b.weekday, wd);
    assert.ok(b.text.includes('享受一天吧'));

    // 非法日期回退到今天
    const res2 = await fetch(`${t.base}/api/briefing?date=hehe`);
    const b2 = await res2.json();
    assert.equal(b2.date, ds(new Date()));
  } finally {
    await t.close();
  }
});
