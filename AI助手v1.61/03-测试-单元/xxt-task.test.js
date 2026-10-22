import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieToWire, extractTaskText, needsUpload } from '../server/xxttask.js';

test('xxttask：cookie 串转浏览器注入格式（过滤空项/畸形项）', () => {
  const wire = cookieToWire('UID=123; fid=45; source=""; =bad; novalue');
  assert.ok(wire.some((c) => c.name === 'UID' && c.value === '123'));
  assert.ok(wire.some((c) => c.name === 'fid'));
  assert.ok(!wire.some((c) => c.name === 'source' || c.name === '' || !c.name), '引号/空名条目被过滤');
  assert.equal(wire[0].domain, '.chaoxing.com');
  assert.deepEqual(cookieToWire(''), []);
});

test('xxttask：详情页文本提取（去噪、截断、保题干）', () => {
  const text = extractTaskText([
    '作业标题\n用AI生成视频作业3选1\n章节：第二章\n',
    '请选择一款AI视频工具，生成一段30秒宣传视频的文字脚本，不少于500字。评分标准：创意40%，完整性60%。',
    '未交\n重做\n返回\n附件\n下载',
  ]);
  assert.match(text, /不少于500字/);
  assert.ok(!text.includes('重做'), '按钮噪声被去掉');
  assert.ok(!text.includes('作业标题'), '字段名噪声被去掉');
});

test('xxttask：附件/拍照类作业判定（这类只读不代交）', () => {
  assert.equal(needsUpload('要求手写拍照上传'), true);
  assert.equal(needsUpload('提交PPT文件到附件'), true);
  assert.equal(needsUpload('在下方输入框写一篇500字小论文'), false);
});
