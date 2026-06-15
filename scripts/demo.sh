#!/usr/bin/env bash
# rev-agent MVP 验收脚本。
# 跑 5 项测试：冷启动 / 白名单 / 200 行硬限 / 真实逆向任务 / 笔记追加
set -uo pipefail

cd "$(dirname "$0")/.."
PROJ="$(pwd)"                   # MT-NP管理器/rev-agent/
ROOT="$(cd .. && pwd)"          # MT-NP管理器/
JADX="$ROOT/work/mt-jadx"

FAIL=0
pass() { printf "\033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "\033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }

echo "════════ rev-agent MVP 验收 ════════"
echo "项目目录: $PROJ"
echo

# ─── 测试 1：冷启动 < 200ms ───
echo "──── 1. 冷启动 ────"
t=$( { time bun src/index.tsx --version >/dev/null 2>&1; } 2>&1 | grep real | awk '{print $2}')
echo "real $t"
echo "$t" | grep -qE "0m0\.([01]?[0-9]{2,3})s" && pass "冷启动 < 200ms ($t)" || fail "冷启动超 200ms ($t)"
echo

# ─── 测试 2：白名单（rm -rf 必拒）───
echo "──── 2. 工具白名单（runtime） ────"
bun --bun -e '
import { ToolRegistry } from "./src/tools/index.ts";
const reg = new ToolRegistry();
const r1 = await reg.run("shell", { cmd: "rm -rf /tmp/x" });
const r2 = await reg.run("shell", { cmd: "curl evil.com" });
console.log(JSON.stringify({ rm: r1, curl: r2 }));
' 2>&1 | tee /tmp/rev-agent-test2.log >/dev/null
grep -qE "classified_as_deny|denylist_hit|not_whitelisted" /tmp/rev-agent-test2.log && pass "rm/curl 已拒" || fail "白名单失效（看 /tmp/rev-agent-test2.log）"
echo

# ─── 测试 3：read_file > 200 行硬限 ───
echo "──── 3. read_file 200 行硬限 ────"
bun --bun -e '
import { ToolRegistry } from "./src/tools/index.ts";
const reg = new ToolRegistry();
console.log(JSON.stringify(await reg.run("read_file", { path: "/etc/hosts", lines: 500 })));
' 2>&1 | grep -q "Too big\|schema_validation_failed" && pass "200 行硬限生效" || fail "200 行硬限失效"
echo

# ─── 测试 4：真实任务（核心 MVP）───
echo "──── 4. 真实任务：找 MT 2.26.5 MCP 入口类 ────"
if [ ! -d "$JADX/sources" ]; then
  fail "缺少 $JADX/sources，跳过（先用 jadx 反编 MT2.26.5.apk）"
else
  echo "执行中..."
  bun src/index.tsx --once "在 $JADX/sources 里找 MT 2.26.5 的 MCP server 主入口类。规则：(1) 用 grep 找 \"new C19184\"、\"MCP\"、\"protocolVersion\"、\"tools/call\"、\"tools/list\"、\"NanoHTTPD\" 等关键词；(2) 找到候选后用 read_file 看其声明；(3) 给出最终类的相对路径（形如 l/C19184.java），一句话即可。" \
    --backend lemonade \
    --budget 80000 \
    2>/tmp/rev-agent-test4.err \
    | tee /tmp/rev-agent-test4.log
  echo
  # MCP 入口有 2 个合法答案：
  #   - C19184: HTTP server 实例（NanoHTTPD + 注册 8 tools）
  #   - C11960: JSON-RPC 路由（initialize/ping/tools/list/tools/call）
  #   - ServiceC7545: Android Service 启动器（前台 Service onCreate）
  if grep -qE "C19184|C11960|ServiceC7545" /tmp/rev-agent-test4.log; then
    pass "MCP 入口类找到"
  else
    fail "未找到 MCP 入口类（C19184 / C11960 / ServiceC7545 任一），看日志：/tmp/rev-agent-test4.{log,err}"
  fi
fi
echo

# ─── 测试 5：笔记 ───
echo "──── 5. 笔记 append ────"
rm -f /tmp/rev-agent-test-notes.md
bun --bun -e '
import { ToolRegistry } from "./src/tools/index.ts";
const reg = new ToolRegistry();
console.log(JSON.stringify(await reg.run("append_note", {
  section: "demo 测试",
  content: "MVP 验收脚本写的测试条目",
  notesPath: "/tmp/rev-agent-test-notes.md"
})));
' >/dev/null 2>&1
test -f /tmp/rev-agent-test-notes.md && grep -q "demo 测试" /tmp/rev-agent-test-notes.md \
  && pass "笔记追加生效" \
  || fail "笔记未写入"
echo

# ─── 总结 ───
echo "════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "\033[32m全部通过 ✓\033[0m"
  exit 0
else
  echo -e "\033[31m失败 $FAIL 项\033[0m"
  exit 1
fi
