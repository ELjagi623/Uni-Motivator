#!/bin/bash
# Uni Motivator portable launcher for macOS on Apple Silicon (M1 and newer). Double-click it in Finder.
# It runs the Node.js runtime bundled in runtime/, so nothing has to be installed. In the release zip this file is
# named start.command.
# First time only: macOS asks for confirmation once for downloaded files. Right-click the file -> "Open" -> "Open".
# On macOS 15 or newer, if that is not offered: System Settings -> Privacy & Security -> "Open Anyway".
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

# Files from a download carry a quarantine flag; clearing it lets the bundled runtime start. Harmless when absent.
xattr -dr com.apple.quarantine . >/dev/null 2>&1
chmod +x runtime/node >/dev/null 2>&1

if [ ! -f "runtime/node" ]; then
  echo
  echo "[ERROR] runtime/node is missing. Unzip the whole archive first and do not run this file from inside the zip."
  echo "[错误] 找不到 runtime/node。请先完整解压 zip，不要在压缩包里直接运行。"
  pause_on_error
  exit 1
fi

# hw.optional.arm64 is 1 on every Apple Silicon Mac, even in a terminal that runs under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
  echo
  echo "[ERROR] This portable edition is for Apple Silicon Macs (M1 or newer). On an Intel Mac, install Node.js 22+"
  echo "from https://nodejs.org/ and use the lite edition (Uni-Motivator-vX.Y.Z-lite.zip)."
  echo "[错误] 此免安装版仅适用于 Apple 芯片（M1 及更新）的 Mac。Intel Mac 请安装 Node.js 22 或更高版本，并改用轻量版（lite）。"
  pause_on_error
  exit 1
fi

if ! ./runtime/node -e "process.exit(0)" >/dev/null 2>&1; then
  echo
  echo "[ERROR] The bundled Node.js runtime could not start. If macOS blocked it, open System Settings -> Privacy & Security"
  echo "and click \"Open Anyway\" for node, then double-click start.command again."
  echo "[错误] 自带的 Node.js 运行环境无法启动。如果是被 macOS 拦截了，请打开「系统设置」→「隐私与安全性」，"
  echo "点击 node 旁边的「仍要打开」，然后重新双击 start.command。"
  pause_on_error
  exit 1
fi

echo "Starting Uni Motivator. Close this window to stop it. / 正在启动学费计价器。关闭此窗口即停止服务。"
if ! ./runtime/node server/index.js "$@"; then
  echo
  echo "[ERROR] The server exited with an error. See the messages above. / 服务异常退出，请查看上面的信息。"
  pause_on_error
  exit 1
fi
exit 0
