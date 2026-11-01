@echo off
cd /d "%~dp0"
title YouTube Downloader - Diagnostics

set "LOG=%~dp0_diagnose_result.txt"
> "%LOG%" echo === YouTube Downloader Diagnostics ===
>> "%LOG%" echo Date: %DATE% %TIME%
>> "%LOG%" echo.

>> "%LOG%" echo [1] Current directory:
>> "%LOG%" cd
>> "%LOG%" echo.

>> "%LOG%" echo [2] Script location (%~dp0):
>> "%LOG%" echo %~dp0
>> "%LOG%" echo.

>> "%LOG%" echo [3] Checking bundled node:
if exist "%~dp0runtime\node\node.exe" (
  >> "%LOG%" echo     OK  runtime\node\node.exe
) else (
  >> "%LOG%" echo     MISSING  runtime\node\node.exe
)

>> "%LOG%" echo.
>> "%LOG%" echo [4] Checking ffmpeg:
if exist "%~dp0bin\ffmpeg.exe" (
  >> "%LOG%" echo     OK  bin\ffmpeg.exe
) else (
  >> "%LOG%" echo     MISSING  bin\ffmpeg.exe
)

>> "%LOG%" echo.
>> "%LOG%" echo [5] Checking server.js:
if exist "%~dp0server.js" (
  >> "%LOG%" echo     OK  server.js
) else (
  >> "%LOG%" echo     MISSING  server.js
)

>> "%LOG%" echo.
>> "%LOG%" echo [6] Checking POT server:
if exist "%~dp0runtime\pot-server\build\main.js" (
  >> "%LOG%" echo     OK  runtime\pot-server\build\main.js
) else (
  >> "%LOG%" echo     MISSING  runtime\pot-server\build\main.js
)

>> "%LOG%" echo.
>> "%LOG%" echo [7] Node version test:
"%~dp0runtime\node\node.exe" --version >> "%LOG%" 2>&1
if errorlevel 1 (
  >> "%LOG%" echo     node FAILED to run
) else (
  >> "%LOG%" echo     node ran OK
)

>> "%LOG%" echo.
>> "%LOG%" echo [8] Port check (8808 / 4416):
netstat -ano | findstr ":8808 :4416" >> "%LOG%" 2>&1

>> "%LOG%" echo.
>> "%LOG%" echo [9] Testing server.js startup (5 seconds):
start "test" /min cmd /c ""%~dp0runtime\node\node.exe" "%~dp0server.js" > "%~dp0_diagnose_server.txt" 2>&1"
ping -n 6 127.0.0.1 >nul 2>&1
if exist "%~dp0_diagnose_server.txt" (
  >> "%LOG%" echo     --- server output ---
  type "%~dp0_diagnose_server.txt" >> "%LOG%" 2>&1
) else (
  >> "%LOG%" echo     server produced no output file
)

>> "%LOG%" echo.
>> "%LOG%" echo === Done. Please send _diagnose_result.txt ===

echo.
echo   Diagnostics complete.
echo   Result saved to _diagnose_result.txt
echo   Please send that file back.
echo.
pause
