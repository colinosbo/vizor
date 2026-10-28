@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/en/download first.
  echo Then reopen Start Vizor.cmd. No Git or database software is needed.
  pause
  exit /b 1
)
node scripts\launch.mjs %*
if errorlevel 1 (
  echo.
  echo Vizor could not start. Read the message above for the next step.
  pause
  exit /b 1
)
