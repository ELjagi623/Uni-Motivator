#!/bin/bash
# Tuition Ticker launcher for macOS (the counterpart of start.cmd). Double-click it in Finder.
# First time only: right-click the file -> "Open" -> "Open" (macOS asks for confirmation once for downloaded files).
# If the file does not start at all, run `chmod +x start.command` once in Terminal.
#
# This file must keep LF line endings (a CRLF here breaks the #! line). Set TT_NO_OPEN=1 to suppress opening a browser.

cd "$(dirname "$0")" || exit 1

pause_on_error() {
  # Keep the Terminal window open so the message can be read (not when TT_NO_OPEN=1, i.e. automated runs).
  if [ "$TT_NO_OPEN" != "1" ]; then
    echo
    read -r -p "Press Enter to close this window / 按回车键关闭窗口 " _
  fi
}

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[ERROR] Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/"
  echo "[错误] 没有找到 Node.js。学费计价器需要 Node.js 22 或更高版本。"
  echo "请到 https://nodejs.org/ 下载安装 LTS 版本，装好后重新双击 start.command。"
  if [ "$TT_NO_OPEN" != "1" ]; then open "https://nodejs.org/" 2>/dev/null; fi
  pause_on_error
  exit 1
fi

if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" >/dev/null 2>&1; then
  echo
  echo "[ERROR] Node.js is too old, version 22 or newer is required. Installed version:"
  node -v
  echo "[错误] Node.js 版本过低，学费计价器需要 Node.js 22 或更高版本（上面是当前版本）。"
  echo "请到 https://nodejs.org/ 下载安装最新的 LTS 版本，装好后重新双击 start.command。"
  if [ "$TT_NO_OPEN" != "1" ]; then open "https://nodejs.org/" 2>/dev/null; fi
  pause_on_error
  exit 1
fi

# The release zip already contains the built app. Only a source checkout needs a build.
if [ ! -f "app/index.html" ]; then
  echo "First run from source: installing dependencies and building the interface... / 首次运行：正在安装依赖并构建界面，请稍候……"
  if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm was not found. Reinstall Node.js from https://nodejs.org/ and keep npm."
    echo "[错误] 没有找到 npm，请重新安装 Node.js。"
    pause_on_error
    exit 1
  fi
  if ! npm install; then
    echo "[ERROR] npm install failed. Check the network connection and start again. / 依赖安装失败，请检查网络后重试。"
    pause_on_error
    exit 1
  fi
  if ! npm run build; then
    echo "[ERROR] npm run build failed. See the messages above. / 构建失败，请查看上面的信息。"
    pause_on_error
    exit 1
  fi
fi

echo "Starting Tuition Ticker. Close this window to stop it. / 正在启动学费计价器。关闭此窗口即停止服务。"
if ! node server/index.js "$@"; then
  echo
  echo "[ERROR] The server exited with an error. See the messages above. / 服务异常退出，请查看上面的信息。"
  pause_on_error
  exit 1
fi
exit 0
