import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieToWire, extractTaskText, needsUpload, judgeSubmitResult, findAnswerEditor, clickConfirmModal } from '../server/xxttask.js';

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

test('提交结果判定：必须看到明确回执，禁止宽松放行（假成功回归）', () => {
  assert.equal(judgeSubmitResult('…提交成功…'), 'success');
  assert.equal(judgeSubmitResult('页面：已提交，等待老师批改'), 'success');
  assert.equal(judgeSubmitResult(''), 'unknown', '没有可见回执（包括详情窗被关掉）不算成功——宁可让用户核对');
  assert.equal(judgeSubmitResult('答案不能为空'), 'empty');
  assert.equal(judgeSubmitResult('会话已过期，请重新登录'), 'failed');
  assert.equal(judgeSubmitResult('登录超时'), 'failed');
  // 旧版事故判据：页面只要没写"未提交"就算成功——现在必须认 unknown，不许冒充成功
  assert.equal(judgeSubmitResult('填写答案\n（页面上什么回执都没有）'), 'unknown');
});

test('答案输入区选择：可见富文本优先，隐藏源码 textarea 绝不碰（上晚事故）', async () => {
  const hiddenTa = { first: () => ({ count: async () => 1, isVisible: async () => false }) };
  const none = { first: () => ({ count: async () => 0, isVisible: async () => false }) };
  const visCe = { first: () => ({ count: async () => 1, isVisible: async () => true }) };
  const page = {
    frames: () => [
      // 主框架：UEditor 的隐藏源码 textarea 排最前（旧代码先抓 textarea 就会写进这里）
      { locator: (sel) => (sel.includes('textarea') ? hiddenTa : none) },
      // 富文本 iframe：可见的 contenteditable 正文才是真输入区
      { locator: () => visCe },
    ],
  };
  const ed = await findAnswerEditor(page);
  assert.equal(ed?.kind, 'ce', '选中可见富文本正文');
});

test('答案输入区兜底：纯文本判决时认可见 textarea；全都隐藏则交人工', async () => {
  const visTa = { first: () => ({ count: async () => 1, isVisible: async () => true }) };
  const none = { first: () => ({ count: async () => 0, isVisible: async () => false }) };
  const taPage = { frames: () => [{ locator: (sel) => (sel.includes('textarea') ? visTa : none) }] };
  assert.equal((await findAnswerEditor(taPage))?.kind, 'textarea');
  const allHidden = { frames: () => [{ locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => false }) }) }] };
  assert.equal(await findAnswerEditor(allHidden), null);
});

test('确认提交弹窗：出现后必须点"确定"，没弹窗也不算错', async () => {
  let shown = false;
  const clicks = [];
  const page = {
    frames: () => [
      {
        locator: (sel) => ({
          first: () =>
            sel === '.layui-layer-btn0' && shown
              ? { count: async () => 1, isVisible: async () => true, click: async () => { clicks.push(sel); } }
              : { count: async () => 0, isVisible: async () => false, click: async () => {} },
        }),
      },
    ],
    waitForTimeout: async () => {
      shown = true; // 模拟：提交按钮点下去之后弹窗才出现
    },
  };
  assert.equal(await clickConfirmModal(page), true);
  assert.equal(clicks.length, 1, '确定只点一次');
  const noModalPage = {
    frames: () => [{ locator: () => ({ first: () => ({ count: async () => 0 }) }) }],
    waitForTimeout: async () => {},
  };
  assert.equal(await clickConfirmModal(noModalPage), false, '没有弹窗时轮询完优雅退出');
});
