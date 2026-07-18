#!/usr/bin/env bash
# 一键部署 showcase → Netlify 站点 rev-agent-showcase
#   账户: li mark (2602167682@qq.com) · team ljcman
#   站点: https://rev-agent-showcase.netlify.app
#
# 用法:
#   ./deploy.sh              构建 + 生产部署(--prod)
#   ./deploy.sh --draft      构建 + 预览(draft)部署,不动生产
#   ./deploy.sh --skip-build 跳过构建,直接部署现有 dist
#   ./deploy.sh --help       显示帮助
#
# 原理: 用 --no-build 上传本地已构建的 dist,不触发 Netlify 云端构建
#       (不吃构建额度)。生产部署每次约 15 credits;draft 预览免费。
#       用 --site 显式锁定目标站点,不受本地 netlify link 影响。
set -euo pipefail
cd "$(dirname "$0")"

SITE_ID="89cabfe2-4478-4191-81e3-0f3cbce0923a"   # rev-agent-showcase

MODE="--prod"; DO_BUILD=1
for a in "$@"; do
  case "$a" in
    --draft)      MODE="" ;;
    --skip-build) DO_BUILD=0 ;;
    -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $a  (可用: --draft / --skip-build / --help)"; exit 1 ;;
  esac
done

# 核对当前 CLI 登录账户(多账号时防止部署到错误账户;--site 也会兜底鉴权)
CUR="$(netlify api getCurrentUser 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).email||"?")}catch{console.log("?")}})' 2>/dev/null || echo '?')"
echo "▶ 当前 CLI 账户: $CUR"
echo "▶ 目标站点: rev-agent-showcase ($SITE_ID)"

if [ "$DO_BUILD" = 1 ]; then
  echo "▶ 构建 dist …"
  npm run build
fi

echo "▶ 部署中(${MODE:-draft 预览})…"
netlify deploy --dir=dist --no-build $MODE --site "$SITE_ID"
