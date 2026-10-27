@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Download: https://nodejs.org/
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 20+ is required. Current version:
  node -v
  pause
  exit /b 1
)

echo Starting Live2D Simple Workbench...
echo The browser will open automatically. Keep this window open.
node "%~dp0tools\workbench\server.mjs" --port 4700 --open
if errorlevel 1 pause
endlocal
