"""自动改进机器人：每次运行让 Claude 在 auto-improve 分支上改进这个 App，
然后提交、推送，并在 GitHub 上留一份中文报告（改了什么、花了多少钱、用了多少 token）。

用的是 Claude Platform 的 API 额度（ANTHROPIC_API_KEY），不是 Claude 订阅。
钱的控制：
  - TOTAL_CAP_USD：这个 App 本月最多花多少
  - DEADLINE：过了这个时间就不再运行（额度到期前用完）
  - 每次运行的预算 = 剩余预算 / 剩余运行次数，自动平均分配
"""
import asyncio
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock, query

ROOT = Path.cwd()
BOT_DIR = ROOT / ".github" / "auto-improve"
STATE_DIR = ROOT / ".auto-improve"  # 存在 auto-improve 分支上
SPEND_FILE = STATE_DIR / "spend.json"
LOG_FILE = STATE_DIR / "LOG.md"
BRANCH = "auto-improve"

REPO = os.environ.get("GITHUB_REPOSITORY", "local/test")
CAP = float(os.environ.get("TOTAL_CAP_USD", "20"))
DEADLINE = dt.datetime.fromisoformat(os.environ.get("DEADLINE", "2026-11-14T18:00:00+00:00"))
RUNS_PER_DAY = int(os.environ.get("RUNS_PER_DAY", "2"))
MODEL = os.environ.get("MODEL", "claude-sonnet-5-5")
MIN_RUN, MAX_RUN = 0.5, float(os.environ.get("MAX_RUN_USD", "4"))
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def sh(*args, check=True):
    r = subprocess.run(args, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r


def prepare_branch():
    """在 auto-improve 分支上继续，并合并最新的 main；合并冲突就从 main 重新开一个分支。"""
    global BRANCH
    sh("git", "config", "user.name", "auto-improve-bot")
    sh("git", "config", "user.email", "auto-improve-bot@users.noreply.github.com")
    if sh("git", "ls-remote", "--exit-code", "--heads", "origin", BRANCH, check=False).returncode == 0:
        sh("git", "fetch", "origin", BRANCH)
        sh("git", "checkout", "-B", BRANCH, f"origin/{BRANCH}")
        if sh("git", "merge", "--no-edit", "origin/main", check=False).returncode != 0:
            sh("git", "merge", "--abort", check=False)
            old = BRANCH
            BRANCH = f"auto-improve-{dt.date.today():%m%d}"
            sh("git", "checkout", "-B", BRANCH, "origin/main")
            sh("git", "checkout", f"origin/{old}", "--", ".auto-improve", check=False)
            print(f"main 和 {old} 冲突，改用新分支 {BRANCH}")
    else:
        sh("git", "checkout", "-B", BRANCH, "origin/main")


def load_spend():
    if SPEND_FILE.exists():
        return json.loads(SPEND_FILE.read_text())
    return {"total_usd": 0.0, "total_tokens": 0, "runs": []}


def run_budget(spend):
    now = dt.datetime.now(dt.timezone.utc)
    left = CAP - spend["total_usd"]
    hours_left = (DEADLINE - now).total_seconds() / 3600
    if hours_left <= 0:
        return 0, "已过截止时间"
    if left < MIN_RUN:
        return 0, f"本月预算已用完（已花 ${spend['total_usd']:.2f} / ${CAP:.2f}）"
    runs_left = max(1, int(hours_left / 24 * RUNS_PER_DAY))
    return min(MAX_RUN, max(MIN_RUN, left / runs_left)), f"剩余 ${left:.2f}，还有约 {runs_left} 次运行"


SYSTEM = """你是这个 App 的全职工程师兼产品经理，在无人看管的情况下工作。老板（pbz）不懂编程，中文为主。
标准（老板的要求）：你要按世界顶级软件大师的水准做事——审美大师（像 Apple 设计团队那样讲究排版、留白、字体、颜色、动效，做出来要高级、干净、有质感，绝不廉价或像模板）、功能大师（每个功能都真正好用、可靠、没有多余步骤）。目标是做到同类 App 排名前 20 的水平。
做法：
- 截图一律用 device_scale_factor=1（不要 2x），Read 截图前先确认文件小于 600KB，太大先用 PIL 缩小；不要 Read 整页超长截图。
- 每次都先当一回真实用户：用无头 Chrome（系统有 google-chrome，Python 有 playwright，已装中文字体）按手机尺寸 390×844 把主要流程从头走一遍并截图，用 Read 看截图，像挑剔的用户一样找出最难用、最难看、最让人困惑的地方，先改最影响体验的。
- 改完再截图复查，确认真的更好看、更好用了，而不是只改了代码。
- 宁可把一件事做到极致，也不要做一堆半成品；不确定的大改动先在 LOG 里写方案，留给老板决定。
规则：
- 只在当前目录（这个仓库）里工作。不要改 .github/ 目录。不要 git commit / push（脚本会做）。
- 绝不部署上线（不要运行 wrangler deploy、railway、eas submit 之类）。改动要等老板审核。
- 绝不打印、写入或泄露任何密钥/环境变量。
- 不要删除用户数据或大段功能；小步改进，每一步都要能跑。
- 改完必须运行项目已有的测试；测试失败就修好，修不好就撤回那部分改动。
- 先读 .auto-improve/LOG.md，看以前做过什么、老板有没有留言（“老板留言”），不要重复。
- 可以用网络搜索研究竞品和最佳做法，但要把时间主要花在真正让 App 变好的改动上。
- 结束前在 .auto-improve/LOG.md 末尾追加本次记录（中文大白话）：做了什么、为什么、测试结果、下一步建议。
- 最后的回复写一份给老板看的简短中文报告（5-10 行）：改了什么、对用户有什么好处、需要老板注意或决定什么。"""


def boss_notes():
    """读取老板在 GitHub 报告 Issue 下的留言（最近 15 条）。"""
    try:
        num = gh("issue", "list", "--state", "open", "--search", "in:title 自动改进 每日报告",
                 "--json", "number", "--jq", ".[0].number").stdout.strip()
        if not num:
            return ""
        out = gh("issue", "view", num, "--json", "comments", "--jq",
                 '.comments[] | select(.author.login == "pbz13p") | "[" + .createdAt[:10] + "] " + .body').stdout.strip()
        return "\n".join(out.splitlines()[-15:])
    except Exception:
        return ""


async def run_agent(budget):
    goals = (BOT_DIR / "goals.md").read_text(encoding="utf-8")
    notes = boss_notes()
    if notes:
        goals = ("【老板最新留言 —— 最优先处理，处理完在 LOG 里写明怎么处理的】\n" + notes + "\n\n" + goals)
    prompt = (
        f"今天是 {dt.date.today()}。这次运行的预算约 ${budget:.2f}，尽量用到八九成再收尾写报告。\n\n"
        f"这个 App 的目标和改进方向：\n{goals}\n\n"
        "现在开始：读代码和 LOG，按优先级一个接一个地做改进：每做完一个就跑测试、确认通过，再做下一个。"
        "不要只做一个小改动就停：这次的预算是专门给你用的，月底不用就作废，请持续工作直到预算用到八九成（或者优先级清单全部做完）。"
        "最后写好记录和报告。"
    )
    opts = ClaudeAgentOptions(
        system_prompt=SYSTEM,
        model=MODEL,
        cwd=str(ROOT),
        permission_mode="bypassPermissions",
        allowed_tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "TodoWrite"],
        max_budget_usd=budget,
        max_turns=200,
        setting_sources=[],
        max_buffer_size=50 * 1024 * 1024,  # 截图读进来会超过默认 1MB
    )
    report, result = "", None
    try:
        async for msg in query(prompt=prompt, options=opts):
            if isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, TextBlock):
                        report = b.text
                        print(b.text[:400], flush=True)
            elif isinstance(msg, ResultMessage):
                result = msg
        if result and result.result:
            report = result.result
    except Exception as e:  # 中途出错也要记账、提交已做的改动
        print("agent 出错：", repr(e)[:500], flush=True)
        report = (report + f"\n\n（这次中途出错停了：{repr(e)[:200]}）").strip()

    return report, result


def tokens_of(usage):
    if not usage:
        return 0
    return sum(int(usage.get(k) or 0) for k in (
        "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))


def gh(*args):
    return sh("gh", *args, check=False)


def post_report(body, changed):
    """有改动：开/更新一个 PR；开 PR 失败（仓库没开权限）就发到一个固定的 Issue 里。"""
    compare = f"https://github.com/{REPO}/compare/main...{BRANCH}"
    pr = gh("pr", "list", "--head", BRANCH, "--state", "open", "--json", "number", "--jq", ".[0].number").stdout.strip()
    if changed and not pr:
        r = gh("pr", "create", "--head", BRANCH, "--base", "main",
               "--title", "🤖 自动改进（审核后合并才会上线）",
               "--body", "机器人每天的改进都会加到这个 PR 里。每次的报告见下面的评论。\n\n"
                         "看完觉得可以：点 **Merge pull request** 就上线。不想要：直接关掉。\n"
                         "想给机器人留话：写在评论里，或者写进 `.auto-improve/LOG.md` 的“老板留言”。")
        pr = r.stdout.strip().rsplit("/", 1)[-1] if r.returncode == 0 else ""
    if pr:
        gh("pr", "comment", pr, "--body", body)
        return
    title = "🤖 自动改进 每日报告"
    issue = gh("issue", "list", "--state", "open", "--search", f"in:title {title}",
               "--json", "number", "--jq", ".[0].number").stdout.strip()
    if changed:
        body += f"\n\n👉 查看改动并上线：打开 {compare} → 点 **Create pull request** → 再点 **Merge**。"
    if issue:
        gh("issue", "comment", issue, "--body", body)
    else:
        gh("issue", "create", "--title", title, "--body", body)


def preflight():
    """检查钥匙：只打印长度/开头类型，不打印钥匙本身。"""
    import httpx
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    clean = key.strip().strip('"').strip("'")
    if clean != key:
        print("注意：钥匙前后有空格/引号，已自动去掉", flush=True)
        os.environ["ANTHROPIC_API_KEY"] = clean
    print(f"钥匙长度 {len(clean)}，开头 {clean[:11]}…", flush=True)
    body = {"model": "claude-haiku-5-5", "max_tokens": 5, "messages": [{"role": "user", "content": "hi"}]}
    base = {"anthropic-version": "2023-06-01", "content-type": "application/json"}
    for name, h in (("x-api-key", {"x-api-key": clean}), ("bearer", {"authorization": f"Bearer {clean}"})):
        try:
            r = httpx.post("https://api.anthropic.com/v1/messages", headers={**base, **h}, json=body, timeout=30)
            print(f"preflight {name}: HTTP {r.status_code} {r.text[:160] if r.status_code != 200 else ''}", flush=True)
        except Exception as e:
            print(f"preflight {name}: {e}", flush=True)


def main():
    if not DRY_RUN:
        prepare_branch()
    spend = load_spend()
    budget, why = run_budget(spend)
    print(f"[{REPO}] 本次预算 ${budget:.2f}（{why}）", flush=True)
    if budget <= 0:
        return
    if DRY_RUN:
        return
    preflight()

    report, result = asyncio.run(run_agent(budget))
    cost = float(getattr(result, "total_cost_usd", 0) or 0) if result else budget  # 出错拿不到花费，按预算保守记
    toks = tokens_of(getattr(result, "usage", None))
    spend["total_usd"] = round(spend["total_usd"] + cost, 4)
    spend["total_tokens"] += toks
    spend["runs"].append({"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
                          "usd": round(cost, 4), "tokens": toks,
                          "status": getattr(result, "subtype", "unknown")})
    STATE_DIR.mkdir(exist_ok=True)
    SPEND_FILE.write_text(json.dumps(spend, indent=1, ensure_ascii=False))

    sh("git", "add", "-A", "--", ".", ":!.github", ":!**/node_modules/**", ":!**/__pycache__/**", ":!**/.pytest_cache/**", ":!**/.env")
    changed_code = bool(sh("git", "diff", "--cached", "--name-only", "--", ".", ":!.auto-improve").stdout.strip())
    sh("git", "commit", "-m", f"auto-improve {dt.date.today()}: ${cost:.2f}", check=False)
    sh("git", "push", "-u", "origin", BRANCH)
    branch_differs = bool(sh("git", "diff", "--name-only", "origin/main...HEAD",
                             "--", ".", ":!.auto-improve").stdout.strip())
    merged = ""
    if os.environ.get("AUTO_MERGE") == "1" and branch_differs:
        # 老板说：还没正式上线，测试通过就直接合并到 main，不用等他审核
        tc = os.environ.get("TEST_CMD", "").strip()
        ok = True
        if tc:
            t = subprocess.run(tc, shell=True, capture_output=True, text=True)
            ok = t.returncode == 0
            if not ok:
                print("测试没通过，不合并：", (t.stdout + t.stderr)[-1500:], flush=True)
        if ok and sh("git", "push", "origin", "HEAD:main", check=False).returncode == 0:
            merged = "✅ 测试通过，已自动合并到 main"
            branch_differs = False
        else:
            merged = "⚠️ 测试没通过或合并冲突，这次没合并，改动留在 " + BRANCH + " 分支"

    body = (f"### {dt.date.today()} 报告\n\n{report or '（这次没有写出报告）'}\n\n"
            f"---\n💰 本次花费 **${cost:.2f}**，用了 **{toks:,}** 个 token｜"
            f"本月累计 ${spend['total_usd']:.2f} / ${CAP:.2f}，{spend['total_tokens']:,} token｜"
            f"代码{'有' if changed_code else '没有'}改动" + (f"｜{merged}" if merged else ""))
    post_report(body, branch_differs)
    print(body)


if __name__ == "__main__":
    sys.exit(main())
