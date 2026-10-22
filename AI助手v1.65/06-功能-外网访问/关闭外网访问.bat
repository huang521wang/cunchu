@echo off
title 关闭外网访问
taskkill /IM cloudflared.exe /F >nul 2>nul
if errorlevel 1 (
  echo 外网访问本来就没在开（不用关）。
) else (
  echo 已关闭外网访问 - 现在外网已经连不到你的工作台了。
)
pause
