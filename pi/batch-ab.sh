#!/usr/bin/env bash
# 多 seed × 2 模式(count/signal) 单变量 A/B 加固(lemonade 单并发→严格串行)。
# 治 temp>0 单跑方差:每格跑 N 次取中位数。产 CSV。
cd /Volumes/zhitai-7100/reverse-agent/rev-agent || exit 1
OUT=/private/tmp/claude-501/-Volumes-zhitai-7100-reverse-agent/c0e365ae-d71c-4f31-b0e9-cce71a1d01b6/scratchpad/pi-bench/ab
mkdir -p "$OUT"
CSV="$OUT/results.csv"
echo "task,mode,seed,dur_s,exit,steps,reads,greps,hops,checkpoints,forced,conclusion,gt_hit" > "$CSV"

MED_TASK="在当前工作目录的反编译产物里，找出 MT 管理器 2.26.5 的 MCP server 入口类（真正实例化并注册工具的那个）。给出相对路径 + 类名，并说明它与 JSON-RPC 路由类、Android Service 启动器的关系。"
MED_WD=/Volumes/zhitai-7100/reverse-agent/work/mt-jadx
EN_TASK="审计这个被破解的 EasyNotes VIP mod 版：它是如何绕过原版的 VIP/会员校验解锁功能的？给出四段式结论（破解点 类.方法+行号 / 破解手法 / 调用链 / 修复加固）。只读分析。"
EN_WD=/Volumes/zhitai-7100/reverse-agent/apk-moded/easynotes-jadx

run() { # task_id workdir mode seed gt_regex timeout <<< task
  local tid="$1" wd="$2" mode="$3" seed="$4" gt="$5" to="$6"; local task; task="$(cat)"
  local tag="${tid}-${mode}-s${seed}"
  local o="$OUT/$tag.out" e="$OUT/$tag.err"
  export REV_GUARD_MODE="$mode"
  local t0 t1 dur ex
  t0=$(python3 -c 'import time;print(time.time())')
  timeout "$to" bun src/index.tsx --once "$task" --workdir "$wd" --backend lemonade --auto-approve --budget 80000 > "$o" 2> "$e"
  ex=$?
  t1=$(python3 -c 'import time;print(time.time())'); dur=$(python3 -c "print(round($t1-$t0,1))")
  local sc; sc=$(grep -a 'SCORECARD' "$e" | tail -1)
  local steps reads greps hops cp forced concl gthit
  steps=$(echo "$sc" | grep -oE 'steps=[0-9]+' | head -1 | cut -d= -f2); reads=$(echo "$sc" | grep -oE 'reads=[0-9]+' | head -1 | cut -d= -f2)
  greps=$(echo "$sc" | grep -oE 'greps=[0-9]+' | head -1 | cut -d= -f2); hops=$(echo "$sc" | grep -oE 'hops=[0-9]+' | head -1 | cut -d= -f2)
  cp=$(echo "$sc" | grep -oE 'checkpoints=[0-9]+' | head -1 | cut -d= -f2); forced=$(echo "$sc" | grep -oE 'forced=[0-9]+' | head -1 | cut -d= -f2)
  concl=$(echo "$sc" | grep -oE 'conclusion=[0-9]+' | head -1 | cut -d= -f2)
  gthit=$(grep -oaiE "$gt" "$o" | head -1 | wc -l | tr -d ' ')
  echo "$tid,$mode,$seed,$dur,$ex,${steps:-0},${reads:-0},${greps:-0},${hops:-0},${cp:-0},${forced:-0},${concl:-0},$gthit" >> "$CSV"
  echo "[$tag] dur=${dur}s reads=${reads:-?} hops=${hops:-?} cp=${cp:-?} forced=${forced:-?} gt_hit=$gthit"
}

for seed in 1 2 3; do
  for mode in count signal; do
    run easynotes "$EN_WD" "$mode" "$seed" 'getHasBuyed|getHasSubscribe' 900 <<< "$EN_TASK"
    run medium "$MED_WD" "$mode" "$seed" 'C19184' 700 <<< "$MED_TASK"
  done
done
echo "[BATCH DONE] CSV: $CSV"
