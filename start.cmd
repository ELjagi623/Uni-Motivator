@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Tuition Ticker

rem This file must stay ASCII-only. cmd.exe mis-parses UTF-8 batch files that contain multi-byte text
rem (lines near 512-byte buffer boundaries get cut and executed as garbage). The Chinese messages live in
rem server\messages\*.txt and are shown with "type", which is safe under chcp 65001.
rem Set TT_NO_OPEN=1 to suppress opening any browser or web page (used by automated tests).
rem Do not put a closing parenthesis inside echo text in a block.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/
  type "server\messages\no-node.txt"
  if not "%TT_NO_OPEN%"=="1" start "" "https://nodejs.org/"
  if not "%TT_NO_OPEN%"=="1" pause
  exit /b 1
)

node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is too old, version 22 or newer is required. Installed version:
  node -v
  type "server\messages\old-node.txt"
  if not "%TT_NO_OPEN%"=="1" start "" "https://nodejs.org/"
  if not "%TT_NO_OPEN%"=="1" pause
  exit /b 1
)

if not exist "app\index.html" (
  type "server\messages\first-run.txt"
  where npm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [ERROR] npm was not found. Reinstall Node.js from https://nodejs.org/ and keep npm.
    type "server\messages\no-npm.txt"
    if not "%TT_NO_OPEN%"=="1" pause
    exit /b 1
  )
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check the network connection and double-click start.cmd again.
    type "server\messages\install-failed.txt"
    if not "%TT_NO_OPEN%"=="1" pause
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    echo.
    echo [ERROR] npm run build failed. See the messages above.
    type "server\messages\build-failed.txt"
    if not "%TT_NO_OPEN%"=="1" pause
    exit /b 1
  )
)

type "server\messages\starting.txt"
node server\index.js %*
if errorlevel 1 (
  echo.
  echo [ERROR] The server exited with an error. See the messages above.
  type "server\messages\server-failed.txt"
  if not "%TT_NO_OPEN%"=="1" pause
  exit /b 1
)
exit /b 0
