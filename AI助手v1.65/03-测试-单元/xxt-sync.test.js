import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCourseList, parseTaskList, parseTaskMenuLinks, syncXxt } from '../server/xxtsync.js';

/* ---------- 解析器（用代表性页面结构做 fixture） ---------- */

test('解析课程列表：courseid+clazzid 成对提取、去重、带课程名、带 cpi', () => {
  const html = `
    <a href="https://mooc1.chaoxing.com/course-ans/coursevisit?courseid=123&classid=456&uid=7" title="高等数学">进课程</a>
    <a href="/mycourse/coursestudy?courseid=123&clazzid=999">另一班</a>
    <a href="https://mooc2-ans.chaoxing.com/mooc2-ans/course/studycourse?courseId=888&classId=77&cpi=503007705"><span>毛概</span></a>
    <a href="courseid=abc&clazzid=1">非法数字跳过</a>
  `;
  const cs = parseCourseList(html);
  assert.ok(cs.some((c) => c.courseid === '123' && (c.clazzid === '456' || c.clazzid === '999')));
  const mao = cs.find((c) => c.courseid === '888');
  assert.ok(mao);
  assert.equal(mao.cpi, '503007705');
  assert.ok(!cs.some((c) => c.courseid === 'abc'));
});

test('解析作业列表·旧结构：标题/截止时间/稳定 id；无时间也出条目', () => {
  const html = `
    <li class="bottom"><a href="work/detail?id=7788">
      <p class="coltitle ellipsis2">第三章课后习题</p>
      <span>定时间：2026-10-30 23:59</span>
    </a></li>
    <li><a href="work/detail?id=9911">
      <p class="coltitle">曲线拟合实训</p>
    </a></li>
    <li><span>没有标题块的行跳过</span></li>
  `;
  const rows = parseTaskList(html, 'homework');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '第三章课后习题');
  assert.equal(rows[0].due, '2026-10-30');
  assert.equal(rows[0].extId, 'homework:7788');
  assert.equal(rows[1].due, '');
});

test('解析作业列表·新结构（getAllWork 的 inspectTask，2025+ 实测格式）', () => {
  const html = `
    <div class="ulDiv"><ul class="clearfix">
      <li style="padding:30px 0"><div class="titTxt" data="0"><p>
        <a class="inspectTask" data="57094306" data2="0" title="用AI生成视频作业3选1">用AI生成视频作业3选1</a>
      </p><span class="pt5"><span class="fl">截止时间：</span>2026年10月25日</span></div></li>
      <li><div class="titTxt"><p>
        <a class="inspectTask" data="57094307" title="完成大学学习规划ppt">完成大学学习规划ppt</a>
      </p><span>开始时间：2026-10-01</span></div></li>
    </ul></div>
  `;
  const rows = parseTaskList(html, 'homework');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '用AI生成视频作业3选1');
  assert.equal(rows[0].due, '2026-10-25');
  assert.equal(rows[0].extId, 'homework:57094306');
  assert.equal(rows[1].due, '');
  assert.equal(rows[1].extId, 'homework:57094307');
});

test('抽课程空间任务菜单链接：data= 属性、&amp; 还原、origin 补全', () => {
  const space = `
    <a href="javascript:;" data="/work/getAllWork?classId=153&amp;courseId=253&amp;ut=s&amp;enc=abc123&amp;cpi=705">作业</a>
    <a href="javascript:;" data="/exam-ans/exam/test?classId=153&amp;courseId=253&amp;enc=abc123">考试</a>
  `;
  const m = parseTaskMenuLinks(space, 'https://mooc1-2.chaoxing.com/mooc-ans/mycourse/studentcourse?x=1');
  assert.equal(m.work, 'https://mooc1-2.chaoxing.com/work/getAllWork?classId=153&courseId=253&ut=s&enc=abc123&cpi=705');
  assert.equal(m.exam, 'https://mooc1-2.chaoxing.com/exam-ans/exam/test?classId=153&courseId=253&enc=abc123');
  const empty = parseTaskMenuLinks('<div>无菜单</div>', 'https://mooc1-2.chaoxing.com/x');
  assert.equal(empty.work, null);
  assert.equal(empty.exam, null);
});

test('解析课程列表·双卡合并：图卡在前无标题，文字卡在后补名；"退课"脚本文案不得当课名', () => {
  const html = `
    <script>var quitthecourse="退课"; var quitcoursemsg1="退课后，你将删除学习记录";</script>
    <a href="//mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=501&amp;clazzid=601&amp;vc=1&amp;cpi=705"><img src="cover.png"></a>
    <a href="//mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=501&amp;clazzid=601&amp;cpi=705" title="人工智能通识课">人工智能通识课</a>
    <a href="x?courseid=502&clazzid=602" title="李金玲"></a>
  `;
  const cs = parseCourseList(html);
  const ai = cs.find((c) => c.courseid === '501');
  assert.equal(cs.filter((c) => c.courseid === '501').length, 1, '两张卡只出一条');
  assert.equal(ai.name, '人工智能通识课');
  assert.equal(ai.cpi, '705');
  assert.ok(!cs.some((c) => c.name.includes('退课')));
});

/* ---------- 同步引擎（注入假页面，验证两跳流程与熔断） ---------- */

// 空间页 fixture：给出一门课 + 两条带 enc 的任务链接
const SPACE = (host) => `<a data="//${host}/work/getAllWork?classId=2&courseId=1&enc=aaa&cpi=7">作业</a>
  <a data="/exam-ans/exam/test?classId=2&courseId=1&enc=aaa">考试</a>`;
const WORK_PAGE = '<div class="titTxt"><a class="inspectTask" data="88001" title="第三章习题">第三章习题</a><span>截止时间：2026年11月20日</span></div>';
const EXAM_PAGE = '<div class="titTxt"><a class="inspectTask" data="88002" title="期中测验">期中测验</a><span>截止时间：12月1日</span></div>';

function fakeServer(routes) {
  return async (url) => {
    for (const [rx, r] of routes) {
      if (rx.test(String(url))) {
        return {
          ok: r.status >= 200 && r.status < 300 && r.status < 400,
          status: r.status,
          headers: { get: (k) => (k === 'location' ? r.location || '' : '') },
          text: async () => r.body || '',
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  };
}

test('同步引擎（fetch 模式）：课程→空间页现签链接→作业/考试→onItem 上报', async () => {
  const items = [];
  const r = await syncXxt({
    cookie: 'UID=7; fid=x',
    fetchImpl: fakeServer([
      [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=2&cpi=7" title="高数">' }],
      [/stucoursemiddle/, { status: 200, body: SPACE('mooc1-2.chaoxing.com') }],
      [/getAllWork/, { status: 200, body: WORK_PAGE }],
      [/exam\/test/, { status: 200, body: EXAM_PAGE }],
    ]),
    onItem: async (it) => {
      items.push(it);
      return true;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'synced');
  assert.equal(r.courses, 1);
  assert.equal(r.fails.length, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].course, '高数');
  assert.equal(items[0].due, '2026-11-20');
  assert.ok(items[0].extId);
  assert.equal(items[1].kind, 'exam');
});

test('同步引擎：任务页"无权限的操作"记入 fails（不再静默吞）', async () => {
  const r = await syncXxt({
    cookie: 'x',
    fetchImpl: fakeServer([
      [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=2" title="无人机">' }],
      [/stucoursemiddle/, { status: 200, body: '<a data="/work/getAllWork?courseId=1&enc=z">作业</a>' }],
      [/getAllWork/, { status: 200, body: '<div class="null_wid700"><p>无权限的操作！</p></div>' }],
    ]),
    onItem: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.newCount, 0);
  assert.equal(r.fails.length, 1);
  assert.match(r.fails[0], /无人机.*无权限/);
});

test('同步引擎：空间页没任务菜单 → 记 fails 不炸', async () => {
  const r = await syncXxt({
    cookie: 'x',
    fetchImpl: fakeServer([
      [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=2" title="体育课">' }],
      [/stucoursemiddle/, { status: 200, body: '<div>只有课件没有作业菜单</div>' }],
    ]),
    onItem: async () => true,
  });
  assert.equal(r.fails.length, 1);
  assert.match(r.fails[0], /体育课/);
});

test('同步引擎：302 到 passport = 登录失效熔断（need_login，不再拉课程）', async () => {
  let called = 0;
  const r = await syncXxt({
    cookie: 'stale',
    fetchImpl: async () => {
      called += 1;
      return { ok: false, status: 302, headers: { get: () => 'https://passport2.chaoxing.com/login' }, text: async () => '' };
    },
    onItem: async () => true,
  });
  assert.equal(r.status, 'need_login');
  assert.equal(r.ok, false);
  assert.equal(called, 1, '熔断后不再请求后续页面');
});

test('同步引擎：空间页中途被踢到登录页 → need_login 熔断', async () => {
  const r = await syncXxt({
    cookie: 'x',
    fetchImpl: fakeServer([
      [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=2" title="高数">' }],
      [/stucoursemiddle/, { status: 302, location: 'https://passport2.chaoxing.com/newlogin' }],
    ]),
    onItem: async () => true,
  });
  assert.equal(r.status, 'need_login');
});

test('同步引擎：首页出现登录墙文案也判 need_login', async () => {
  const r = await syncXxt({
    cookie: 'x',
    fetchImpl: fakeServer([[/i\.chaoxing/, { status: 200, body: '请先扫码登录' }]]),
    onItem: async () => true,
  });
  assert.equal(r.status, 'need_login');
});

test('同步引擎：网络异常只 error 不抛（重试一次仍不通才认输）', async () => {
  let calls = 0;
  const r = await syncXxt({
    cookie: 'x',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error('网络挂了');
    },
    onItem: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(calls, 2, '首页瞬时抖动会重试一次');
});

test('同步引擎：首页第一次抖、第二次通 → 整轮照常跑完', async () => {
  let calls = 0;
  const okServer = fakeServer([
    [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=2" title="高数"></a>' }],
    [/stucoursemiddle/, { status: 200, body: '<div>只有课件没有作业菜单</div>' }],
  ]);
  const r = await syncXxt({
    cookie: 'x',
    sleepImpl: async () => {},
    fetchImpl: async (...a) => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return okServer(...a);
    },
    onItem: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'synced');
  assert.equal(r.fails.length, 1, '课程本身的小问题照常记入 fails');
});

test('同步引擎：到时间预算带进度返回 partial（不是错误，下轮接着跑）', async () => {
  const r = await syncXxt({
    cookie: 'x',
    deadlineAt: Date.now() + 50, // 注入绝对截止时间：第一门课跑完就"时间到"
    sleepImpl: async () => { await new Promise((res) => setTimeout(res, 60)); },
    fetchImpl: fakeServer([
      [/i\.chaoxing\.com\/base/, { status: 200, body: '<a href="x?courseid=1&clazzid=1" title="甲"></a><a href="x?courseid=2&clazzid=2" title="乙"></a><a href="x?courseid=3&clazzid=3" title="丙"></a>' }],
      [/stucoursemiddle/, { status: 200, body: '<div>只有课件没有作业菜单</div>' }],
    ]),
    onItem: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  assert.equal(r.courses, 3, '总课数照报');
  assert.ok(r.doneCourses >= 1 && r.doneCourses < 3, '只跑了一部分就收工');
});

test('同步引擎：注入浏览器 loadPage（JS 渲染页面）走通两跳', async () => {
  const pages = [];
  const items = [];
  const loadPage = async (url) => {
    pages.push(url);
    if (/i\.chaoxing/.test(url)) {
      return {
        html: '<div class="card-list"><a href="https://mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=501&clazzid=601&cpi=705" title="形势与政策"></a></div>',
        finalUrl: url,
        status: 200,
      };
    }
    if (/stucoursemiddle/.test(url)) {
      return { html: SPACE('mooc1-2.chaoxing.com'), finalUrl: 'https://mooc1-2.chaoxing.com/mooc-ans/mycourse/studentcourse', status: 200 };
    }
    if (/getAllWork/.test(url)) return { html: WORK_PAGE, finalUrl: url, status: 200 };
    if (/exam\/test/.test(url)) return { html: EXAM_PAGE, finalUrl: url, status: 200 };
    return { html: '', finalUrl: url, status: 200 };
  };
  const r = await syncXxt({ cookie: 'x', loadPage, onItem: async (it) => { items.push(it); return true; } });
  assert.equal(r.ok, true);
  assert.equal(r.courses, 1);
  assert.equal(items.length, 2);
  assert.equal(items[0].course, '形势与政策');
  assert.equal(items[0].due, '2026-11-20');
  assert.ok(items[0].extId.includes('88001'));
  assert.ok(pages.some((p) => /courseId=501|courseid=501/.test(p)));
});
