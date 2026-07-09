#!/usr/bin/env bash
# V0.3 笔记续传验收脚本。
# 造一份「上一会话」的工作笔记（§4 下一步指向真实 grep 定位任务），
# 跑 --resume，验证 agent 读笔记 → 跳到 §4 → 接续执行 → 命中答案。
set -uo pipefail

cd "$(dirname "$0")/.."
PROJ="$(pwd)"
ROOT="$(cd .. && pwd)"
JADX="$ROOT/work/mt-jadx/sources"
NOTES=/tmp/rev-agent-resume-test-notes.md

FAIL=0
pass() { printf "\033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "\033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }

echo "════════ V0.3 笔记续传验收 ════════"
[ ! -d "$JADX" ] && { echo "❌ 缺少 $JADX，跳过"; exit 1; }

# ─── 1. 错误路径：笔记不存在应 exit=1 ───
echo "──── 1. 笔记不存在 → 报错退出 ────"
rm -f /tmp/rev-agent-resume-none.md
bun src/index.tsx --resume --once "继续" --notes /tmp/rev-agent-resume-none.md >/dev/null 2>&1
[ $? -eq 1 ] && pass "笔记不存在正确 exit=1" || fail "笔记不存在未报错"

# ─── 2. 造一份带 §4 的「上一会话」笔记 ───
echo "──── 2. 造上一会话笔记（§1 有摘要 / §4 指向 grep 任务）────"
cat > "$NOTES" <<'EOF'
# LLM 工作笔记

## 0. 任务元信息
| 用户原始诉求 | 找 MT 2.26.5 MCP server 的 JSON-RPC 路由类 |
| 当前轮次 | 第 2 次会话 |

## 1. APK 基础摘要
| 包名 | bin.mt.plus |
| versionCode | 26052685 |
> 阶段1摘要已完成，不要重跑 aapt2。

## 2. 已完成步骤
- [x] aapt2 dump badging 完成 → 摘要见 §1
- [x] 确认反编译源码在 work/mt-jadx/sources
- [ ] 定位 JSON-RPC 路由类

## 4. 下一步
N1: 在当前工作目录用 grep 搜高区分度字面量 "tools/call"（全源码仅一处命中）定位 JSON-RPC 路由类
N2: read_file 打开命中的类，确认它按 method 分派 initialize/ping/tools/list/tools/call
N3: 给出该路由类的相对路径（形如 l/Cxxxxx.java）

## 6. 避免重复 / 禁区
- ❌ 不要重跑 aapt2（§1 已有摘要）
- ❌ 不要用 initialize|tools|ping 通用词做交替 grep（会命中一大堆）
EOF
pass "笔记已造（$(wc -l < "$NOTES") 行）"

# ─── 3. 续传执行：应接续 §4 → grep tools/call → 命中 C11960 ───
echo "──── 3. --resume 接续执行（真实 grep 定位）────"
echo "执行中（本地模型，约 1-3 分钟）..."
timeout 300 bun src/index.tsx --resume --once "继续" \
  --backend lemonade \
  --workdir "$JADX" \
  --notes "$NOTES" \
  --budget 40000 \
  --auto-approve \
  >/tmp/rev-agent-resume.log 2>/tmp/rev-agent-resume.err
rc=$?

echo "  exit=$rc"
# 3a. 续传模式启动（stderr 应有"续传模式"日志 + §3 prompt）
grep -q "续传模式" /tmp/rev-agent-resume.err && pass "续传模式已启动" || fail "未进入续传模式"
grep -q "prompt=§3" /tmp/rev-agent-resume.err && pass "用了 §3 续传 prompt" || fail "未用 §3 prompt"
# 3b. 抽出了 §4 下一步
grep -q "tools/call" /tmp/rev-agent-resume.err && pass "§4 下一步已回显" || fail "未回显 §4"
# 3c. agent 没重跑 aapt2（遵守笔记 §6 禁区 / §1 已有摘要）
if grep -qE "→ shell.*aapt2 dump badging" /tmp/rev-agent-resume.err; then
  fail "agent 重跑了 aapt2（违反续传纪律）"
else
  pass "未重跑 aapt2（遵守续传纪律）"
fi
# 3d. 最终答案命中路由类 C11960
if grep -q "C11960" /tmp/rev-agent-resume.log; then
  pass "接续定位到路由类 C11960"
else
  fail "未定位到 C11960（看 /tmp/rev-agent-resume.{log,err}）"
fi

echo
echo "════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "\033[32m续传验收全部通过 ✓\033[0m"; exit 0
else
  echo -e "\033[31m续传验收失败 $FAIL 项\033[0m"; exit 1
fi
