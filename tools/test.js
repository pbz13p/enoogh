// Enoogh 测试：不依赖任何 npm 包。
// 1) 检查 index.html 里的脚本没有语法错误
// 2) 用一个极简的假 DOM 跑页面脚本，检查各个页面能渲染、扣款/申诉/结营逻辑正确
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('index.html 里找不到 <script>');
const code = m[1];
new vm.Script(code); // 语法检查

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('✗ ' + msg); } }

function makeEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, disabled: false, files: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, remove() {}, click() {},
    appendChild() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    get firstChild() { return makeEl(); }
  };
  return el;
}

// 在给定的 localStorage 状态和“今天”下跑一遍脚本，返回渲染出的 HTML 和保存的状态
function run(state, todayISO) {
  const store = {};
  if (state) store.enoogh_v1 = JSON.stringify(state);
  const app = makeEl();
  const RealDate = Date;
  const fixed = new RealDate(todayISO + 'T10:00:00');
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed.getTime()); }
  FakeDate.prototype = RealDate.prototype; FakeDate.now = () => fixed.getTime(); FakeDate.parse = RealDate.parse;
  const ctx = {
    Date: FakeDate, Math, JSON, String, Number, Array, Object, Blob: function () {}, FileReader: function () {},
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: {
      getElementById: id => (id === 'app' ? app : makeEl()),
      querySelectorAll: () => [], createElement: () => makeEl(), body: makeEl()
    },
    window: { __test: {}, scrollTo() {}, confirm: () => true }, navigator: {}, setTimeout() {}, setInterval() {}, clearInterval() {},
    Image: function () {}, console
  };
  ctx.window.document = ctx.document;
  vm.runInNewContext(code, ctx);
  return { ctx, html: app.innerHTML, saved: store.enoogh_v1 ? JSON.parse(store.enoogh_v1) : null };
}

// —— 1. 新用户：欢迎页 ——
let r = run(null, '2026-11-09');
ok(r.html.includes('开始定目标'), '新用户应看到欢迎页');
ok(r.html.includes('Enoogh'), '页面应显示品牌名 Enoogh');

// —— 2. 已开始的目标：周一开始，练周一到周六，承诺金 $300（漏一天扣 $15） ——
function goal(extra) {
  return Object.assign({
    v: 1, offset: 0, draft: null, ui: { tab: 'today' }, history: [],
    goal: {
      id: 1, type: 'pte', name: 'PTE 提分', pte: { now: 58, target: 65, exam: '2026-12-20', weak: 'speaking' },
      start: '2026-11-09', plans: [{ fromWeek: 0, plan: { days: [1, 2, 3, 4, 5, 6], time: '20:00',
        tasks: [{ code: 'DI', name: 'Describe Image', qty: 8, unit: '题' }] } }],
      stake: 300, mode: 'normal', pay: 'card', charity: 'amaze', fee: 49, days: {}, ledger: [], appealsUsed: 0, finished: null
    }
  }, extra || {});
}

// 第一天：今天页面能渲染
r = run(goal(), '2026-11-09');
ok(r.html.includes('今天的任务'), '第一天应显示今天的任务');
ok(r.saved.goal.ledger.length === 0, '第一天不应有扣款');

// 周一完成、周二漏练，周三打开：周二应变成“待扣”$15
let s = goal(); s.goal.days['2026-11-09'] = { done: true };
r = run(s, '2026-11-11');
let L = r.saved.goal.ledger;
ok(L.length === 1 && L[0].day === '2026-11-10' && L[0].amt === 15 && L[0].status === 'pending', '漏练一天应产生 $15 待扣款');
ok(r.html.includes('待扣款'), '今天页应提示待扣款');

// 到了下一个周日（11/15）合并扣款：周二那笔应变成已扣
r = run(r.saved, '2026-11-15');
L = r.saved.goal.ledger;
const tue = L.find(l => l.day === '2026-11-10');
ok(tue && tue.status === 'charged' && tue.chargedOn === '2026-11-15', '周日应合并扣款');
ok(L.filter(l => l.status !== 'void').length === 5, '周二到周六共漏 5 天（周日休息不算）');

// 扣款封顶：一直不练到结营，总扣款不超过承诺金
s = goal(); r = run(s, '2026-12-10');
const total = r.saved.goal.ledger.reduce((a, l) => a + (l.status === 'void' ? 0 : l.amt), 0);
ok(total <= 300 + 1e-9, '总扣款不能超过承诺金，实际 ' + total);
ok(!!r.saved.goal.finished, '28 天后应结营');
ok(r.html.includes('再开一期'), '结营页应能再开一期');
ok(r.html.includes('Amaze'), '结营页应写明捐给了哪家慈善');
ok(r.html.includes('下一期'), '完成率低时结营页应给出下一期建议');
ok(r.html.includes('生成成绩图片') && r.html.includes('复制文字'), '结营页应有图片和文字两种分享');
ok(r.ctx.window.__test.shareCard(r.saved.goal, 80, 16, 20, 5, 60) === null, '没有 canvas 时成绩图片安全返回 null');
{ const tx = r.ctx.window.__test.shareText(r.saved.goal, 40, 8, 20, 3, 75);
  ok(tx.includes('40%') && tx.includes('Amaze') && tx.includes('enoogh.com'), '分享文案应含完成率、慈善和网址');
  ok(!/赌|保过/.test(tx), '分享文案不能出现“赌”“保过”');
  ok(!r.ctx.window.__test.shareText(r.saved.goal, 100, 20, 20, 20, 0).includes('捐给'), '没扣钱时分享文案不提捐款'); }
// 再开一期：带上上一期计划，完成率低时自动调轻
{ const g = r.saved.goal, nd = r.ctx.window.__test.nextDraft(g, 0);
  ok(nd.step === 2 && nd.type === g.type && nd.charity === g.charity && nd.stake === g.stake, '再开一期应带上上一期的类型、慈善和承诺金');
  ok(nd.days.length === Math.max(3, g.plans[0].plan.days.length - 2), '完成率低时每周天数应减两天（不少于 3 天）');
  ok(nd.tasks.every((t, i) => t.qty === Math.max(1, Math.round(g.plans[0].plan.tasks[i].qty / 2))), '完成率低时任务量应减半');
  const nd2 = r.ctx.window.__test.nextDraft(g, 100);
  ok(nd2.days.length === g.plans[0].plan.days.length && nd2.tasks[0].qty === g.plans[0].plan.tasks[0].qty, '完成率高时计划原样带入');
  ok(nd2.carried === 'up' && r.ctx.window.__test.nextDraft(g, 85).carried === 'same', '几乎全勤时提示可以加一点，80–94% 原样');
  const q0 = nd2.tasks.map(t => t.qty), b = r.ctx.window.__test.bumpPlan(nd2);
  ok(b.carried === 'upped' && b.tasks.every((t, i) => t.qty === q0[i] + Math.max(1, Math.round(q0[i] * 0.2))), '加一点：每项任务量约 +20%，至少 +1');
  const cd = r.ctx.window.__test.newDraft(); cd.tasks = [{ name: '跑步', qty: 3, unit: '公里', mins: 30 }];
  r.ctx.window.__test.bumpPlan(cd); ok(cd.tasks[0].qty === 4 && cd.tasks[0].mins === 40, '自定义任务加量时预计时间同步增加'); }

// 监督人只读链接：快照能往返解析，坏链接安全忽略
{ const s2 = goal(); s2.goal.days['2026-11-09'] = { done: true }; const r2 = run(s2, '2026-11-11'), T = r2.ctx.window.__test;
  ok(r2.html.includes('请朋友当监督人'), '今天页应有“请朋友当监督人”按钮');
  const url = T.witnessLink(r2.saved.goal), w = T.parseWitness(url.slice(url.indexOf('#')));
  ok(url.startsWith('https://enoogh.com/#w=') && w && w.n === 'PTE 提分' && w.d.length === 28 && w.d[0] === 'o' && w.d[1] === 'x' && w.d[2] === 't', '监督链接应带上目标名和每天状态');
  const v = T.viewWitness(w); ok(v.includes('漏了 1 天') && v.includes('做到 1 天') && v.includes('只读'), '监督页显示进度且注明只读');
  ok(T.parseWitness('#w=%7Bbad') === null && T.parseWitness('#w=' + encodeURIComponent('{"n":"x","s":"2026-11-09","a":"2026-11-10","d":"<script>"}')) === null && T.parseWitness('') === null, '坏的监督链接应安全忽略');
  ok(!T.viewWitness(T.parseWitness('#w=' + encodeURIComponent(JSON.stringify({ n: '<img src=x>', s: '2026-11-09', a: '2026-11-10', d: 'oo' })))).includes('<img'), '监督页要转义目标名');
  ok(!T.top(true).includes('演示版') && !T.top(true).includes('demoNext') && T.top().includes('演示版'), '监督人只读页不显示演示版“下一天”条'); }
// 确认页的条款不能承诺还没有的功能（小组），也不能写死成考试
{ const src = html; ok(!/公开打卡|不承诺考试成绩/.test(src) && src.includes('23:59 前打卡'), '确认条款要通用、只写真实存在的规则'); }

// 本周日刚合并扣款：今天页要告诉用户扣了多少、捐给了谁
s = goal(); r = run(s, '2026-11-15');
ok(r.html.includes('已合并扣款'), '扣款当天今天页应显示已扣款提示');

// 多笔待扣：申诉时可选哪一天，最新的排第一，同一天不重复
s = goal(); r = run(s, '2026-11-14');
{ const ad = r.ctx.window.__test.appealDays(r.saved.goal);
  ok(ad.length >= 2, '漏练多天时应有多笔可申诉');
  ok(ad.every((l, i) => i === 0 || ad[i - 1].day > l.day), '可申诉的日子应按最新在前排序');
  ok(r.html.includes('选一天申诉'), '多笔待扣时按钮应提示选一天申诉'); }

// 周六漏练：周日才发通知，满 24 小时后到下周日才扣，页面要说明原因
s = goal(); r = run(s, '2026-11-15');
{ const sat = r.saved.goal.ledger.find(l => l.day === '2026-11-14');
  if (sat) { ok(sat.status === 'pending', '周六漏练在周日应仍是待扣（保证提前 24 小时通知）');
    ok(r.html.includes('24 小时'), '周六漏练顺延时应说明是为了提前 24 小时通知'); } }

// 申诉过的日子不扣钱
s = goal(); s.goal.days['2026-11-10'] = { excused: true, reason: '发烧' }; s.goal.appealsUsed = 1;
r = run(s, '2026-11-11');
ok(!r.saved.goal.ledger.some(l => l.day === '2026-11-10' && l.status !== 'void'), '申诉通过的日子不应扣款');

// 旧数据里的慈善机构 id 不存在时，承诺金页也不能出错
s = goal(); s.goal.charity = 'edu'; s.ui.tab = 'money'; r = run(s, '2026-11-12');
ok(r.html.includes('Amaze'), '旧慈善 id 应回退到第一个机构');

// 其他几个标签页能渲染
for (const [tab, word] of [['plan', '本周复盘'], ['money', '扣款记录'], ['learn', '时间先花在哪']]) {
  s = goal(); s.ui.tab = tab; r = run(s, '2026-11-12');
  ok(r.html.includes(word), tab + ' 页应能渲染');
}

// 日期用中文写法，避免 10/11 被看成 10 月 11 日
s = goal(); r = run(s, '2026-11-10');
ok(r.html.includes('11月10日 周二'), '演示条应显示中文日期“11月10日 周二”');
ok(!r.html.includes('10/11/2026'), '不应再出现 D/M/YYYY 日期');

// 今天还没打卡时，“已合并扣款”通知放在今天任务下面，不挤占首屏
s = goal(); s.goal.start = '2026-11-02'; r = run(s, '2026-11-10');
ok(r.html.includes('已合并扣款') && r.html.indexOf('今天的任务') < r.html.indexOf('已合并扣款'), '待打卡日：今天任务应排在扣款通知前面');

// 上一个练习日漏了、今天还没打卡：提示“别连漏两天”，帮他回来
s = goal(); r = run(s, '2026-11-10');
ok(r.html.includes('别连漏两天'), '昨天漏练、今天待打卡时应提示别连漏两天');
ok(r.html.indexOf('别连漏两天') < r.html.indexOf('data-tick'), '回归提示应在任务勾选框之前');
s = goal(); r = run(s, '2026-11-11');
ok(r.html.includes('连着漏了 2 天') && !r.html.includes('别连漏两天'), '连漏两天以上时换成“今天回来最重要”的提示');
s = goal(); s.goal.days['2026-11-10'] = { done: true }; r = run(s, '2026-11-11');
ok(!r.html.includes('别连漏两天'), '昨天做到了就不显示回归提示');


// 定计划页“下一步”灰着时，要告诉用户还差什么
s = { v: 1, offset: 0, ui: { tab: 'today' }, history: [], goal: null,
  draft: { step: 2, type: 'custom', goalName: '', pte: { now: 58, target: 65, exam: '2026-12-20', weak: 'speaking' },
    days: [1, 2, 3], time: '20:00', tasks: [{ name: '', qty: 1, unit: '次', mins: 15 }], stake: 300, mode: 'normal', pay: 'card', charity: 'amaze', agree: {} } };
r = run(s, '2026-11-11');
ok(r.html.includes('还差：目标名称、任务名称'), '下一步不可点时应提示还差目标名称和任务名称');
s.draft.goalName = '每天健身'; s.draft.tasks[0].name = '跑步'; r = run(s, '2026-11-11');
ok(!r.html.includes('还差：'), '都填好后不再显示“还差”提示');

// 自定义任务的单位可以自己改（公里、页、分钟）
s.draft.tasks[0].unit = '公里'; r = run(s, '2026-11-11');
ok(r.html.includes('data-tunit="0"') && r.html.includes('value="公里"'), '自定义任务应有可改的单位输入框');
// 自定义任务一行一项：名称占满一行，数量/单位/分钟在下一行，顺序固定
(function(){ var m = r.html.match(/<div class="cq">([\s\S]*?)<\/div>/);
  ok(r.html.includes('task ctask') && m && m[1].indexOf('data-tqty="0"') < m[1].indexOf('data-tunit="0"') && m[1].indexOf('data-tunit="0"') < m[1].indexOf('data-tmins="0"'), '自定义任务的数量、单位、分钟应排在名称下面同一行'); })();

// 今天还没打卡：任务卡在待扣款提醒前面（首屏先给能做的事）；打完卡后待扣款照样显示
s = goal(); s.goal.days['2026-11-09'] = { done: true };
r = run(s, '2026-11-11');
ok(r.html.indexOf('今天的任务') >= 0 && r.html.indexOf('今天的任务') < r.html.indexOf('待扣款'), '还没打卡时任务卡应在待扣款提醒前面');
s.goal.days['2026-11-11'] = { done: true, doneAt: '20:10' }; r = run(s, '2026-11-11');
ok(r.html.includes('待扣款') && r.html.includes('appealPending'), '打完卡后仍显示待扣款和申诉入口');

// 练习日写短
r = run(goal({ ui: { tab: 'plan' } }), '2026-11-09');
ok(r.html.includes('周一至周六'), '连续的练习日应写成“周一至周六”');

// 打完卡：显示连续天数；周六打完卡，下次提醒写“周一”而不是“明天”
s = goal(); ['2026-11-09','2026-11-10','2026-11-11'].forEach(function (d) { s.goal.days[d] = { done: true }; });
s.goal.days['2026-11-12'] = { done: true, doneAt: '20:31' }; r = run(s, '2026-11-12');
ok(r.html.includes('连续做到 4 天'), '打完卡应显示连续做到 4 天');
ok(r.html.includes('明天要做'), '打完卡应预告明天要做的任务');
s = goal(); ['2026-11-13','2026-11-14'].forEach(function (d) { s.goal.days[d] = { done: true, doneAt: '20:00' }; });
r = run(s, '2026-11-14');
ok(r.html.includes('周一 20:00 提醒你') && !r.html.includes('明天 20:00 提醒你'), '周六打完卡下次提醒应是周一');

// 欢迎页不承诺还没有的小组功能
r = run(null, '2026-11-11');
ok(!r.html.includes('小组里互相看得见'), '欢迎页不应写还没上线的小组功能');

// 漏练后回来、已经勾了任务：把回归提示换成鼓励
s = goal(); s.goal.days['2026-11-10'] = { tasks: { 0: true } }; r = run(s, '2026-11-10');
ok(r.html.includes('开了头，继续') && !r.html.includes('别连漏两天'), '勾了任务后回归提示应换成鼓励');


// 进度线：在轨道上 / 掉队 + 照这个速度会扣多少
s = goal(); r = run(s, '2026-11-09');
ok(r.html.includes('在轨道上') && r.html.includes('全额不扣'), '没漏练时进度线应显示在轨道上');
s = goal(); s.goal.days['2026-11-09'] = { done: true }; r = run(s, '2026-11-11');
// 2 个已过练习日漏 1 天（50%），剩 21 个练习日（含今天）→ 再漏约 11 天 → 共 12 天 × $15 = $180
ok(r.html.includes('掉队了 1 天') && r.html.includes('结营约扣 $180') && r.html.includes('只扣已漏的 <b style="color:var(--ink)">$15'), '漏练后进度线应显示掉队和预计扣款');
s = goal(); r = run(s, '2026-11-30');
ok(r.html.includes('结营约扣 $300') && !r.html.includes('结营约扣 $3000'), '预计扣款不应超过承诺金');
// 掉队时先说“之后天天做到只扣已漏的”，再说最坏情况，不吓人
s = goal(); s.goal.days['2026-11-09'] = { done: true }; r = run(s, '2026-11-11');
ok(r.html.indexOf('只扣已漏的') > -1 && r.html.indexOf('只扣已漏的') < r.html.indexOf('结营约扣'), '进度线应先说能挽回的，再说最坏情况');

// 加到手机日历：.ics 每周重复，含练习日和提醒时间，到结营为止
s = goal(); s.ui.tab = 'plan'; r = run(s, '2026-11-12');
ok(r.html.includes('加到手机日历'), '计划页应有加到手机日历按钮');
const ics = r.ctx.window.__test.icsText(r.saved.goal, new Date(2026, 10, 12));
ok(ics.includes('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA;UNTIL=20261206') && ics.includes('DTSTART:20261112T200000') && ics.includes('BEGIN:VALARM'), '.ics 应按练习日每周重复到结营并带提醒');

// 承诺金页常见问题：钱去哪、服务费、什么时候扣、申诉、演示版
s = goal(); s.ui.tab = 'money'; r = run(s, '2026-11-12');
ok(['扣下的钱去哪了','平台收多少钱','$49','什么时候扣','1/20','$15','申诉','演示版'].every(x => r.html.includes(x)), '承诺金页应有常见问题且数字与规则一致');


// 通用目标模板：6 个，选了自动填任务、单位、练习日和提醒时间
s = goal(); s.goal = null; s.draft = { step: 1 }; r = run(null, '2026-11-12');
{ const T = r.ctx.window.__test, D = T.newDraft();
  T.applyTpl(D, 'run');
  ok(D.type === 'custom' && D.goalName === '跑步' && D.tasks[0].unit === '公里' && D.tasks[0].qty === 3 && D.time === '07:00', '跑步模板应填好任务、单位和时间');
  const D2 = T.newDraft(); T.applyTpl(D2, 'sleep');
  ok(D2.days.join() === '0,1,2,3,4' && D2.tasks.length === 1, '早睡模板应只在周日到周四晚上');
  ['read','english','milktea','gym'].forEach(id => { const d = T.newDraft(); T.applyTpl(d, id); ok(d.tasks.length && d.goalName && T.estMinutes(d.tasks) <= 60, '模板 ' + id + ' 应可用且不超过 60 分钟'); });
  const D3 = T.newDraft(); T.applyTpl(D3, 'nope'); ok(D3.type === null, '未知模板不改草稿'); }
{ const st = { v: 1, offset: 0, goal: null, ui: { tab: 'today' }, history: [], draft: { step: 1, type: null, goalName: '', pte: { now: 58, target: 65, exam: '2026-12-24', weak: 'speaking' }, days: [1,2,3,4,5,6], time: '20:00', tasks: [], stake: 300, mode: 'normal', pay: 'card', charity: 'amaze', agree: {} } };
  r = run(st, '2026-11-12');
  ok(['跑步','读书','学英语','早睡','戒奶茶','健身','从空白开始','PTE'].every(x => r.html.includes(x)), '选目标页应列出 PTE、6 个模板和空白目标'); }

// 打卡流程（任务→证据→打卡按钮）不被待扣款卡打断；完成率 0% 时圆环不画进度（不出现小圆点）
{ let s2 = goal(); r = run(s2, '2026-11-11');
  ok(r.html.indexOf('submitDay') >= 0 && r.html.indexOf('submitDay') < r.html.indexOf('待扣款'), '待扣款卡应排在打卡按钮之后');
  ok(r.html.includes('0%') && !r.html.includes('stroke="#0E9C8C" stroke-width="9" stroke-linecap="round" stroke-dasharray="0 '), '0% 时圆环不应画出进度小圆点'); }

// 掉队但最近连续做到 ≥2 天：进度线标题显示“在追”，不只是“掉队了”
{ let s3 = goal(); s3.goal.days['2026-11-10'] = { done: true }; s3.goal.days['2026-11-11'] = { done: true };
  r = run(s3, '2026-11-12');
  ok(r.html.includes('连续 2 天在追'), '掉队后连续做到 2 天应显示“在追”');
  r = run(goal(), '2026-11-12'); ok(r.html.includes('掉队了') && !r.html.includes('天在追'), '一直没做时仍显示“掉队了”'); }

// 确认页：点整行条款文字也能勾选（data-agree 放在整行上，按钮本身不重复绑定，避免点一下勾两次）
{ ok(/<div class="task agree" data-agree="/.test(html) && !/<button class="check[^>]*data-agree/.test(html), '确认条款整行可点、且不会重复切换'); }

// 提醒时间：24 小时制“时 : 分”下拉，不用系统 time 控件（英文系统会显示 PM）
{ const ts = r.ctx.window.__test.timeSel('pTime', '21:30');
  ok(ts.includes('<option value="21" selected>21 点</option>') && ts.includes('<option value="30" selected>30 分</option>'), '提醒时间下拉选中当前时分');
  ok(r.ctx.window.__test.timeSel('x', '07:05').includes('<option value="05" selected>05 分</option>'), '非整刻钟的旧时间也保留');
  ok(!/type="time"/.test(html), '页面不再用系统 time 控件'); }

// 点“开始第一天”后要回到页面顶部（之前停在确认页的滚动位置，看不到第几天和进度圈）
{ ok(/S\.ui\.tab='today';save\(\);render\(\);window\.scrollTo\(0,0\)/.test(html), '开始第一天后滚回顶部'); }

// 漏练后“回来”提示：只有一项任务时不说“第一项”
{ ok(/p\.tasks\.length>1\?'先只做第一项':'现在就开始'/.test(html), '只有一项任务时回来提示不说“第一项”'); }

// 申诉通过的日子不算“做到”，也不算进分母（之前一天没做、只申诉了一天也显示“做到 1 天”、完成率 33%）
{ const s2 = goal(); s2.goal.days['2026-11-10'] = { excused: true, reason: '发烧' }; s2.goal.appealsUsed = 1;
  const r2 = run(s2, '2026-11-11');
  ok(r2.html.includes('做到 0 天') && !r2.html.includes('做到 1 天'), '申诉日不算做到的天数'); }

// 打开弹窗时先收起提示条（提示条层级比弹窗高，会盖住申诉原因输入框）
{ ok(/function sheet\(html,onMount\)\{\s*document\.querySelectorAll\('\.toast'\)\.forEach/.test(html), '打开弹窗时收起提示条'); }

// 计划页选星期：一行 7 格、选中为实心主色，标题用通用说法（不写“练习”）
{ ok(/class="wkpick"/.test(html) && /\.wkpick\{display:grid;grid-template-columns:repeat\(7,1fr\)/.test(html), '选星期一行 7 格'); ok(html.includes('<h3>哪几天做</h3>') && !html.includes('每次练习要做'), '计划页标题不写死“练习”'); }

// 第一天圆环不再重复“第 1 天”：还没有该做的日子时显示今天任务完成几项
{ ok(!html.includes('刚起步') && /'<b>'\+tdid\+'\/'\+tn\+'<\/b><span>今天任务<\/span>'/.test(html), '第一天圆环显示今天任务进度，不重复“第几天”'); }

// 打卡按钮下的提示说清还差什么（之前只写“再交证据。”，看不懂）
{ const hs = html.match(/function ckHint[^\n]*/);
  const f = new Function('return (' + hs[0].replace('function ckHint', 'function') + ')')();
  ok(f(2, false) === '还差 2 项没勾，再交上证据就能打卡。' && f(1, true) === '还差 1 项没勾，勾完就能打卡。' && f(0, false) === '就差最后一步：交上证据就能打卡。', '打卡提示说清还差几项、还差证据');
  ok(!html.includes('再交证据。'), '不再出现看不懂的“再交证据。”'); }


// 模板技巧：选了模板的目标，技巧页和每日小技巧带上该模板的办法；旧数据没有 tpl 也能用
ok(/tpl:D\.type==='custom'&&D\.tpl\|\|null/.test(code), '开始目标时记下选的模板');
ok(/TPL_TIPS=\{[\s\S]*run:\[[\s\S]*gym:\[/.test(code), '每个模板都有自己的技巧');
ok(/function goalTips\(g\)\{return \(TPL_TIPS\[g\.tpl\]\|\|\[\]\)\.concat\(GENERAL_TIPS\)/.test(code), '没有模板时退回通用技巧');
ok(code.indexOf('任何目标都管用')>0, '技巧页分成模板技巧和通用技巧两组');
ok(/b\.onclick=function\(\)\{document\.querySelectorAll\('\.toast'\)/.test(code), '切换标签时收起提示条');
console.log(`${passed} 项通过，${failed} 项失败`);
if (failed) process.exit(1);
