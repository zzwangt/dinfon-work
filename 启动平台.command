#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "需要安装 Python 3 后才能启动本地平台。"
  read "reply?按回车退出"
  exit 1
fi
python3 serve.py --open
