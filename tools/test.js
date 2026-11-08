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
// 再开一期：带上上一期计划，完成率低时自动调轻
{ const g = r.saved.goal, nd = r.ctx.window.__test.nextDraft(g, 0);
  ok(nd.step === 2 && nd.type === g.type && nd.charity === g.charity && nd.stake === g.stake, '再开一期应带上上一期的类型、慈善和承诺金');
  ok(nd.days.length === Math.max(3, g.plans[0].plan.days.length - 2), '完成率低时每周天数应减两天（不少于 3 天）');
  ok(nd.tasks.every((t, i) => t.qty === Math.max(1, Math.round(g.plans[0].plan.tasks[i].qty / 2))), '完成率低时任务量应减半');
  const nd2 = r.ctx.window.__test.nextDraft(g, 100);
  ok(nd2.days.length === g.plans[0].plan.days.length && nd2.tasks[0].qty === g.plans[0].plan.tasks[0].qty, '完成率高时计划原样带入'); }

// 本周日刚合并扣款：今天页要告诉用户扣了多少、捐给了谁
s = goal(); r = run(s, '2026-11-15');
ok(r.html.includes('已合并扣款'), '扣款当天今天页应显示已扣款提示');

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

console.log(`${passed} 项通过，${failed} 项失败`);
if (failed) process.exit(1);
