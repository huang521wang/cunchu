@echo off
title 工作台外网访问（关窗口 = 断开外网）
cd /d "%~dp0"

echo.
echo ==================================================
echo   工作台 外网访问
echo ==================================================
echo   1. 电脑上要开着「我的工作台」（没开的话本程序会自动帮你开）
echo   2. 等下方出现 https://xxxx.trycloudflare.com 的网址
echo   3. 外面用手机/电脑浏览器打开那个网址，输访问口令
echo   4. 用完关掉本窗口 = 外网立刻断开
echo   提示：网址每次都不一样；网络抽风时会自动重连（网址会变）
echo ==================================================
echo.

rem 先检查工作台在不在；不在就自动开一个（最小化窗口，别关）
curl -s -m 2 http://127.0.0.1:8787/api/health >nul 2>nul
if not errorlevel 1 goto ready

echo 工作台没在跑，正在自动帮你启动（最小化的窗口，别关它）...
start "工作台" /min cmd /c "cd /d C:\Users\珑贝\Desktop\long.app\app && node server\server.js"
for /l %%i in (1,1,25) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -m 2 http://127.0.0.1:8787/api/health >nul 2>nul
  if not errorlevel 1 goto ready
)
echo.
echo 工作台没起来...先双击桌面的「我的工作台」，确认窗口开着，再重新打开本程序。
pause
exit /b 1

:ready
echo 工作台在跑 OK
for /f "delims=" %%p in ('node -e "console.log(JSON.parse(require('fs').readFileSync('C:/Users/珑贝/Desktop/long.app/data/lan-access.json','utf8')).pin)"') do echo   访问口令：%%p
echo.

:loop
echo 正在连接外网通道（等几秒会出现方框网址）...
cloudflared.exe tunnel --url http://127.0.0.1:8787 --no-autoupdate --protocol http2 --edge-ip-version 4
echo.
echo 通道断开了。5 秒后自动重连——重连后网址会变，以新出现的方框为准。
ping -n 6 127.0.0.1 >nul
goto loop
