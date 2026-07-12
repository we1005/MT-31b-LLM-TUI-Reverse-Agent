#!/usr/bin/env bash
# 串行驱动 pi-agent 跑单题 + 抓指标(lemonade 单并发,勿并发)。
# 用法: run-pi.sh <id> <workdir> <tools> <timeout_s> <sysprompt_file|-> <<< "<task>"
# 产物: $OUT/<id>.out(pi 最终文本) / <id>.meta(耗时/tokens/tools/exit) / <id>.session(会话路径)
PI=/Volumes/zhitai-7100/pi-0.80.6
EXT=$PI/lemonade-provider.ts
MODEL=lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml
CLI=$PI/packages/coding-agent/dist/cli.js
OUT=/private/tmp/claude-501/-Volumes-zhitai-7100-reverse-agent/c0e365ae-d71c-4f31-b0e9-cce71a1d01b6/scratchpad/pi-bench/results
mkdir -p "$OUT"

ID="$1"; WD="$2"; TOOLS="$3"; TO="$4"; SYS="$5"; SYSMODE="${6:-append}"
TASK="$(cat)"

SYSARG=()
if [ "$SYS" != "-" ] && [ -f "$SYS" ]; then
  if [ "$SYSMODE" = "replace" ]; then SYSARG=(--system-prompt "$(cat "$SYS")")
  else SYSARG=(--append-system-prompt "$(cat "$SYS")"); fi
fi

cd "$WD" || { echo "bad workdir $WD"; exit 2; }
t0=$(python3 -c 'import time;print(time.time())')
timeout "$TO" node "$CLI" -e "$EXT" --model "$MODEL" \
  --tools "$TOOLS" --mode text "${SYSARG[@]}" \
  -p "$TASK" > "$OUT/$ID.out" 2> "$OUT/$ID.err"
EX=$?
t1=$(python3 -c 'import time;print(time.time())')
DUR=$(python3 -c "print(round($t1-$t0,1))")

# 找该 workdir 最新 session，抽 tokens/tools
ENC=$(python3 -c "import sys;print('--'+sys.argv[1].replace('/','-').strip('-')+'--')" "$WD")
SDIR="$HOME/.pi/agent/sessions/$ENC"
SF=$(ls -t "$SDIR"/*.jsonl 2>/dev/null | head -1)
python3 - "$SF" "$ID" "$DUR" "$EX" > "$OUT/$ID.meta" <<'PY'
import json,sys
sf,ID,dur,ex=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
tot=rz=cr=0; tools={}; turns=0
try:
  for l in open(sf):
    try: d=json.loads(l)
    except: continue
    t=d.get('type','')
    m=d.get('message') or {}
    u=m.get('usage') or {}
    if u.get('totalTokens'): tot=max(tot,u['totalTokens'])
    if u.get('reasoning'): rz=max(rz,u.get('reasoning',0))
    if u.get('cacheRead'): cr=max(cr,u.get('cacheRead',0))
    c=m.get('content')
    if isinstance(c,list):
      for p in c:
        if isinstance(p,dict) and p.get('type') in ('tool_use','tool_call','toolCall'):
          n=p.get('name') or (p.get('toolCall') or {}).get('name') or '?'
          tools[n]=tools.get(n,0)+1
    if t=='message': turns+=1
except Exception as e: pass
print(json.dumps({'id':ID,'dur_s':float(dur),'exit':int(ex),'totalTokens':tot,'reasoningTokens':rz,'cacheRead':cr,'tools':tools,'session':sf},ensure_ascii=False))
PY
echo "[$ID] exit=$EX dur=${DUR}s  meta:"; cat "$OUT/$ID.meta"
echo "--- out tail ---"; tail -12 "$OUT/$ID.out"
