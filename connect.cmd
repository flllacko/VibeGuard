@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更高版本，并重新打开此向导。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过低，请使用 Node.js 24 或更高版本。
  pause
  exit /b 1
)
if not exist "dist\cli.js" (
  echo 当前是源码原型，请先在此目录运行 pnpm install 和 pnpm build。
  pause
  exit /b 1
)
node dist\cli.js connect
set "vibeguard_exit=%errorlevel%"
pause
exit /b %vibeguard_exit%
