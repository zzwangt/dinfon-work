#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)'; then
  echo "请先安装 Node.js 24 或更高版本。"
  read "dinfon_reply?按回车退出"
  exit 1
fi
if [[ ! -f config/runtime.json ]]; then
  node scripts/setup-local.mjs
fi
echo "鼎峰协同 · 独立账号版；按 Control-C 停止。"
exec node server/standalone.mjs
