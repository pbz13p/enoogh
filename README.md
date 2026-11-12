# Enoogh 一诺 · 说到做到

定一个计划，交一笔承诺金。做到了，钱一分不少；做不到，扣下的钱 100% 捐给慈善机构，平台只收服务费。

- 网站：https://enoogh.com（GitHub Pages）
- 代码：单文件 `index.html`，数据暂存在用户手机浏览器（localStorage）
- 测试：`node tools/test.js`
- 图标：`icons/`（App 图标、网页图标）
- 自动改进机器人：`.github/workflows/auto-improve.yml`，方向见 `.github/auto-improve/goals.md`，记录见 `auto-improve` 分支的 `.auto-improve/LOG.md`

当前是演示版：不会真的扣钱，付款（Stripe）和账号/小组功能还没接。

## 规则要点（改代码前先看）
- 一期 28 天，从开始那天算周（不一定是周一）；改计划下一周生效。
- 漏练一天扣承诺金的 1/20，最多扣到承诺金为止；漏练第二天通知，满 24 小时后周日合并扣。
- 早睡、戒奶茶（`GRACE_HOUR`）：昨天的卡次日中午 12 点前可补，期间状态是 `late`，不算漏练；最后一天也要等补卡或过中午才结营。
- 戒奶茶（`PLEDGE`）用一句诚信承诺代替照片。
- 存储满时（`save()`）先清 14 天前的照片和录音，打卡记录保留。
- 照片/录音地址只接受 `data:` 格式（`safeMedia`）；备份导入要过 `validBackup`。

## 其他文件
- `sw.js`：离线缓存（先走网络，断网用缓存），只在 https 正式站注册。
- `404.html`、`robots.txt`、`sitemap.xml`、`icons/og.jpg`（分享预览图）。
