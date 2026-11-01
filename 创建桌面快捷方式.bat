@echo off
cd /d "%~dp0"
title YouTube Downloader - Create Shortcut
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "PY="
if exist "%ROOT%\runtime\python\python.exe" set "PY=%ROOT%\runtime\python\python.exe"
if not defined PY if exist "%ROOT%\runtime\venv\Scripts\python.exe" set "PY=%ROOT%\runtime\venv\Scripts\python.exe"
if not defined PY if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined PY for %%P in (python.exe) do if not defined PY set "PY=%%~$PATH:P"

if not defined PY (
  echo   [X] Python not found.
  echo       Please run the VBS creator instead.
  pause
  exit /b 1
)

echo.
echo   Creating desktop shortcut ...
echo.

"%PY%" "%ROOT%\tools\make_shortcut.py"

if errorlevel 1 (
  echo.
  echo   [X] Failed. Please run the VBS creator instead.
) else (
  echo.
  echo   Done. Check your Desktop.
)
echo.
pause
