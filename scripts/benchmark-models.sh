#!/usr/bin/env bash
# rev-agent 多模型实战 benchmark
# 任务：在 13 万 .java 反编译产物里找 MT 2.26.5 MCP 入口类（demo.sh 测试 4 同款）
# 跑 10 个火山引擎 Coding Plan SKU + 1 个本地 lemonade baseline = 11 次

set -uo pipefail
cd "$(dirname "$0")/.."

PROJ="$(pwd)"
ROOT="$(cd .. && pwd)"
JADX="$ROOT/work/mt-jadx"
RESULTS=/tmp/rev-agent-benchmark

[ ! -d "$JADX/sources" ] && { echo "❌ $JADX/sources 不存在"; exit 1; }
mkdir -p "$RESULTS"

# 读 .env 里的 ARK_API_KEY（不要 echo）
ARK_KEY=$(grep -E '^ark-api-key' .env 2>/dev/null | sed 's/.*= *//' | tr -d ' "')
[ -z "$ARK_KEY" ] && { echo "❌ 没在 .env 里读到 ark-api-key"; exit 1; }
export ARK_API_KEY="$ARK_KEY"

TASK='在 sources/ 里找 MT 2.26.5 的 MCP server 入口类。规则：(1) 用 grep 找 "new C19184"/"MCP"/"protocolVersion"/"tools/call"/"tools/list"/"NanoHTTPD" 等关键词；(2) 找到候选后用 read_file 看其声明；(3) 给出最终类的相对路径（形如 l/C19184.java），一句话即可。'

# 模型列表：backend, model_id, label
declare -a MODELS=(
  "lemonade|Huihui-Qwen3.6-35B-A3B-abliterated-ggml|local-qwen3.6-35B-MoE"
  "volcengine|doubao-seed-2.0-code|doubao-seed-2.0-code"
  "volcengine|doubao-seed-2.0-pro|doubao-seed-2.0-pro"
  "volcengine|doubao-seed-2.0-lite|doubao-seed-2.0-lite"
  "volcengine|doubao-seed-code|doubao-seed-code"
  "volcengine|minimax-m2.7|minimax-m2.7"
  "volcengine|minimax-m3|minimax-m3"
  "volcengine|glm-5.1|glm-5.1"
  "volcengine|deepseek-v4-flash|deepseek-v4-flash"
  "volcengine|deepseek-v4-pro|deepseek-v4-pro"
  "volcengine|kimi-k2.6|kimi-k2.6"
)

echo "════ rev-agent benchmark：11 模型 × 1 任务 ════"
echo "数据: $JADX (13w+ java files)"
echo "任务: 找 MCP 入口类（期待 C11960 / C19184 / ServiceC7545 任一）"
echo "结果: $RESULTS/"
echo

# 单跑：参数 backend, model, label, timeout
run_one() {
  local backend=$1 model=$2 label=$3 timeout_s=${4:-300}
  local outlog="$RESULTS/${label}.log"
  local outerr="$RESULTS/${label}.err"
  local outmeta="$RESULTS/${label}.meta"

  echo "──── [$label] ($backend / $model) ────"
  local t0=$(date +%s)
  timeout "$timeout_s" bun "$PROJ/src/index.tsx" --once "$TASK" \
    --backend "$backend" --model "$model" \
    --workdir "$JADX" \
    --budget 80000 \
    > "$outlog" 2> "$outerr"
  local rc=$?
  local t1=$(date +%s)
  local elapsed=$((t1 - t0))

  # 判答案命中
  local hit="未找到"
  if grep -qE "C19184|C11960|ServiceC7545" "$outlog" 2>/dev/null; then
    hit=$(grep -oE "C19184|C11960|ServiceC7545" "$outlog" | sort -u | tr '\n' ',' | sed 's/,$//')
  fi

  # 从 stderr 抽 budget 行
  local budget=$(grep -oE "budget=[0-9]+/[0-9]+" "$outerr" | tail -1)

  # 工具调用次数
  local tools_called=$(grep -cE "^→ (shell|read_file|grep|append_note) " "$outerr" 2>/dev/null || echo 0)
  local tools_denied=$(grep -cE "^  ✗ " "$outerr" 2>/dev/null || echo 0)

  {
    echo "label=$label"
    echo "backend=$backend"
    echo "model=$model"
    echo "exit_code=$rc"
    echo "elapsed_sec=$elapsed"
    echo "answer_hit=$hit"
    echo "budget=$budget"
    echo "tools_called=$tools_called"
    echo "tools_denied=$tools_denied"
    echo "output_chars=$(wc -c < "$outlog")"
  } > "$outmeta"

  if [ "$rc" -eq 0 ] && [ "$hit" != "未找到" ]; then
    echo "  ✓ ${elapsed}s | hit=$hit | $budget | tools=$tools_called"
  elif [ "$rc" -eq 124 ]; then
    echo "  ⏱ 超时 ${timeout_s}s | hit=$hit"
  else
    echo "  ✗ exit=$rc ${elapsed}s | hit=$hit | err=$(head -1 "$outerr" 2>/dev/null | cut -c1-100)"
  fi
}

# 跑所有模型（串行，避免火山引擎并发限流；本地 lemonade 排第一）
for entry in "${MODELS[@]}"; do
  IFS='|' read -r backend model label <<< "$entry"
  run_one "$backend" "$model" "$label" 300
done

echo
echo "════ 汇总 ════"
printf "%-35s %8s %10s %8s %8s %s\n" "model" "exit" "elapsed" "tools" "denied" "answer"
for f in "$RESULTS"/*.meta; do
  source "$f"
  printf "%-35s %8s %10s %8s %8s %s\n" "$label" "$exit_code" "${elapsed_sec}s" "$tools_called" "$tools_denied" "$answer_hit"
done | sort
