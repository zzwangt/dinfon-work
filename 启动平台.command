#!/bin/zsh
set -e
cd "$(dirname "$0")"

stop_with_message() {
  echo "$1"
  read "dinfon_reply?按回车退出"
  exit 1
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  stop_with_message "需要先安装 Node.js 22.13.0 或更高版本及 npm，再重新打开此文件。"
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  stop_with_message "当前 Node.js 版本过低；请升级到 22.13.0 或更高版本。"
fi

if [[ ! -f node_modules/vinext/dist/cli.js ]]; then
  stop_with_message "尚未安装依赖。请在本目录终端执行 npm run install:ci，然后重新启动。"
fi

echo "鼎峰平台 v2 · 本地开发"
echo "启动后打开 http://localhost:4173；按 Control-C 停止。"
echo "首次配置请阅读 README.md。本地使用模拟登录，不应向局域网或公网开放。"
exec npm run dev -- --port 4173
