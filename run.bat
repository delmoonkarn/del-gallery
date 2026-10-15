@echo off
setlocal EnableExtensions
title Manga Reader
cd /d "%~dp0"

echo.
echo  ========================================
echo   Manga Reader launcher
echo  ========================================
echo   Working dir: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js not found on PATH. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo  [OK] node found

where npm >nul 2>&1
if errorlevel 1 (
  echo  [X] npm not found on PATH.
  pause
  exit /b 1
)
echo  [OK] npm found

if not exist node_modules (
  echo  Installing dependencies, please wait ^(3-5 min^)...
  call npm install
  if errorlevel 1 (
    echo  [X] npm install failed.
    pause
    exit /b 1
  )
)
echo  [OK] node_modules present

echo.
echo  Launching the app. A window will open in ~5 seconds.
echo  Leave this terminal open while you use the app.
echo  Close the app window or press Ctrl+C here to stop.
echo.

call npm run dev
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo  npm run dev exited with code %EXITCODE%
  echo  Something went wrong — see the output above.
  pause
)