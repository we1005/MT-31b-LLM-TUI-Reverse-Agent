#!/usr/bin/env bash
# P1: 离线生成「递归 --help」文档库 → docs-resources/tool-help/<tool>.md
#
# 动机（见「三提议深度分析」§3）：小模型偶尔不知道某工具的 flag/子命令语法（benchmark recon-3
# 就栽在不会 aapt2 dump xmltree --file）。答案常埋在两跳 --help 之外，且 jadx --help 12.4KB
# 超过 shell 4KB 截断，agent「自己跑 --help」拿不全。把递归展开的 help 物化成 grep-able 的 MD，
# agent 一条 `grep -i xmltree tool-help/aapt2.md` 就能自助补上。
#
# 红线合规：全程本地、不联网、不 load 模型、不起 Docker、纯静态文件生成。
# 从安装现场的真二进制生成（避免和 prompt 里写死的版本漂移）。
#
# 用法：bash scripts/gen-tool-help.sh   （幂等，重跑覆盖）
set -uo pipefail

cd "$(dirname "$0")/.."
OUT="docs-resources/tool-help"
mkdir -p "$OUT"

# 工具 → 探测子命令的方式。多数工具 `--help` 就够；aapt2/apktool 有子命令要递归。
TOOLS=(jadx apktool aapt2 apksigner zipalign apkid adb frida objection androguard baksmali smali)

# 已知有子命令的工具，列出要递归展开的子命令（避免瞎跑）。
# 用函数+case 而非关联数组——macOS 自带 bash 3.2 不支持 declare -A。
subcmds_for() {
  case "$1" in
    aapt2)   echo "dump dump:xmltree dump:badging dump:permissions dump:resources" ;;
    apktool) echo "d b" ;;
    adb)     echo "shell install" ;;
    *)       echo "" ;;
  esac
}

now_note="> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。"

# 跑一个命令的 help，抓 stdout+stderr（很多工具把 help 打到 stderr），限长防爆
run_help() {
  # shellcheck disable=SC2068
  timeout 15 $@ 2>&1 | head -c 20000
}

gen_one() {
  local tool="$1"
  local bin; bin="$(command -v "$tool" 2>/dev/null)"
  local md="$OUT/${tool}.md"

  if [ -z "$bin" ]; then
    echo "  [skip] $tool 未安装"
    return
  fi

  local ver; ver="$($tool --version 2>&1 | head -1 | tr -d '\r')"
  {
    echo "# $tool — 命令帮助（离线物化）"
    echo
    echo "$now_note"
    echo
    echo "- 二进制：\`$bin\`"
    echo "- 版本：\`${ver:-未知}\`"
    echo "- 生成于：本机（版本随安装现场，不联网）"
    echo
    echo "---"
    echo
    echo "## $tool --help"
    echo
    echo '```'
    run_help "$tool" --help
    echo
    echo '```'
  } > "$md"

  # 递归展开已知子命令
  local subs; subs="$(subcmds_for "$tool")"
  if [ -n "$subs" ]; then
    for sc in $subs; do
      # sc 形如 "dump" 或 "dump:xmltree"（冒号=多级子命令）
      local args; args="$(echo "$sc" | tr ':' ' ')"
      {
        echo
        echo "## $tool $args --help"
        echo
        echo '```'
        run_help "$tool" $args --help
        echo
        echo '```'
      } >> "$md"
    done
  fi

  local bytes; bytes="$(wc -c < "$md" | tr -d ' ')"
  echo "  [ok]   $tool → $md (${bytes}B, ver=${ver:-?})"
}

echo "════ 生成工具帮助库 → $OUT/ ════"
for t in "${TOOLS[@]}"; do
  gen_one "$t"
done

# 生成一个索引 README，方便 agent 先看有哪些工具
{
  echo "# tool-help 索引"
  echo
  echo "$now_note"
  echo
  echo "agent 用法：不确定某工具的 flag/子命令语法时，先 \`grep -i <关键词> docs-resources/tool-help/<tool>.md\`，再决定命令。"
  echo
  echo "| 工具 | 文件 | 大小 |"
  echo "|------|------|------|"
  for t in "${TOOLS[@]}"; do
    if [ -f "$OUT/${t}.md" ]; then
      echo "| $t | tool-help/${t}.md | $(wc -c < "$OUT/${t}.md" | tr -d ' ')B |"
    fi
  done
} > "$OUT/README.md"

echo
echo "总大小：$(du -sh "$OUT" 2>/dev/null | cut -f1)"
echo "完成。"
