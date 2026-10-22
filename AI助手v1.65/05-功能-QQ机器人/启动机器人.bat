@echo off
title 工作台 QQ 机器人
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  没有找到 Node.js，请先安装或把 Node 加到 PATH。
  pause
  exit /b 1
)

echo.
echo  正在启动 QQ 机器人连接程序（按 Ctrl+C 或关窗口退出）...
echo  第一次用请先看「使用说明.md」把 config.json 填好。
echo.

node bridge.mjs
echo.
echo  机器人已退出。
pause
