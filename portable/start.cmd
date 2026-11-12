@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Uni Motivator

rem Portable edition: uses the Node.js runtime bundled in runtime\ so nothing has to be installed.
rem This file must stay ASCII-only (see the note in the lightweight start.cmd). Messages come from server\messages\*.txt.
rem Set TT_NO_OPEN=1 to suppress opening the browser (used by automated tests).

if not exist "runtime\node.exe" (
  echo.
  echo [ERROR] runtime\node.exe is missing. Extract the whole zip first, do not run start.cmd from inside the zip.
  if not "%TT_NO_OPEN%"=="1" pause
  exit /b 1
)

type "server\messages\starting.txt"
"runtime\node.exe" server\index.js %*
if errorlevel 1 (
  echo.
  echo [ERROR] The server exited with an error. See the messages above.
  type "server\messages\server-failed.txt"
  if not "%TT_NO_OPEN%"=="1" pause
  exit /b 1
)
exit /b 0
