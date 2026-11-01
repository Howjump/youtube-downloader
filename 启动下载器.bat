@echo off
cd /d "%~dp0"
title YouTube Downloader
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo   ============================================
echo     YouTube Downloader
echo   ============================================
echo.

set "NODE_EXE="
if exist "%ROOT%\runtime\node\node.exe" set "NODE_EXE=%ROOT%\runtime\node\node.exe"
if not defined NODE_EXE if exist "%ROOT%\bin\node.exe" set "NODE_EXE=%ROOT%\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\nodejs\node.exe" set "NODE_EXE=%USERPROFILE%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODE_EXE (
  echo   [X] Node.js not found.
  echo       Install Node.js LTS, or put node.exe into the bin folder.
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%\bin\ffmpeg.exe" (
  echo   [X] Missing bin\ffmpeg.exe
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%\server.js" (
  echo   [X] Missing server.js
  echo.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem  NOTE: do NOT start a separate PO Token service window here.
rem
rem  The app generates PO tokens locally by forking the bundled script
rem  (youtubepot-bgutilscript), which needs no background HTTP service at all.
rem  Launching one used to pop up a SECOND console window for nothing.
rem
rem  If that script is ever missing, server.js starts the service by itself
rem  with a hidden window. So there is never a need for a second window here.
rem ---------------------------------------------------------------------------

echo   Node  : %NODE_EXE%
echo   Open  : http://127.0.0.1:8808
echo.
echo   Keep this window open. Press Ctrl+C to stop.
echo.

rem  Run the server in THIS console so there is only one window.
rem  server.js opens the browser by itself once it is actually listening.
"%NODE_EXE%" "%ROOT%\server.js"

echo.
echo   Server stopped.
pause
