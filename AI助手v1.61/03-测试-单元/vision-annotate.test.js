import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateVisionMessages } from '../server/server.js';

const fakeFile = Buffer.from('fakepngbytes');

test('视觉注释：图片描述注入到 content，并回写缓存', async () => {
  const cached = [];
  let calls = 0;
  const messages = [
    { role: 'user', content: '这张图里写了啥', attachments: [{ kind: 'image', file: 'files/a.png', mime: 'image/png' }] },
  ];
  const n = await annotateVisionMessages(messages, {
    readFile: () => fakeFile,
    visionFn: async () => {
      calls++;
      return '这是一张作业截图。文字：第三章课后习题，截止10月30日';
    },
    cacheBack: (file, desc) => cached.push([file, desc]),
  });
  assert.equal(n, 1, '一张图记一处');
  assert.equal(calls, 1);
  assert.match(messages[0].content, /第三章课后习题/);
  assert.ok(messages[0].content.startsWith('这张图里写了啥'), '原话保留');
  assert.deepEqual(cached[0][0], 'files/a.png');
  assert.match(cached[0][1], /截止10月30日/);
});

test('视觉注释：已有缓存描述则不再跑视觉模型', async () => {
  let calls = 0;
  const messages = [
    { role: 'user', content: '再看一眼', attachments: [{ kind: 'image', file: 'files/a.png', desc: '上次看到的：猫片' }] },
  ];
  await annotateVisionMessages(messages, {
    readFile: () => {
      calls++;
      return fakeFile;
    },
    visionFn: async () => '不该被调用',
  });
  assert.equal(calls, 0, '命中缓存不读文件不跑模型');
  assert.match(messages[0].content, /上次看到的：猫片/);
});

test('视觉注释：视觉模型挂了也不崩，注入"看不清"兜底并提示别瞎编', async () => {
  const messages = [{ role: 'user', content: '看图', attachments: [{ kind: 'image', file: 'files/x.png' }] }];
  const n = await annotateVisionMessages(messages, {
    readFile: () => fakeFile,
    visionFn: async () => {
      throw new Error('模型没启动');
    },
  });
  assert.equal(n, 1);
  assert.match(messages[0].content, /没能看清|没启动/);
  assert.match(messages[0].content, /别瞎编/);
});

test('视觉注释：预识别缓存命中则不跑模型（挑图即看的提速关键）', async () => {
  let visionCalls = 0;
  const messages = [{ role: 'user', content: '图里是啥', attachments: [{ kind: 'image', file: 'files/b.png' }] }];
  await annotateVisionMessages(messages, {
    readFile: () => {
      visionCalls++;
      return fakeFile;
    },
    visionFn: async () => {
      visionCalls++;
      return '不该跑';
    },
    lookupCache: (file) => (file === 'files/b.png' ? '缓存里早就看过了：一只橘猫' : ''),
  });
  assert.equal(visionCalls, 0, '命中缓存不读文件不跑模型');
  assert.match(messages[0].content, /一只橘猫/);
});

test('视觉注释：纯文本消息与非图片附件原样不动', async () => {
  const messages = [
    { role: 'user', content: '普通聊天' },
    { role: 'user', content: '发个文件', attachments: [{ kind: 'file', file: 'files/z.pdf' }] },
    { role: 'assistant', content: '好的' },
  ];
  const n = await annotateVisionMessages(messages, { readFile: () => fakeFile, visionFn: async () => 'x' });
  assert.equal(n, 0);
  assert.equal(messages[0].content, '普通聊天');
  assert.equal(messages[1].content, '发个文件');
  assert.equal(messages[2].content, '好的');
});
