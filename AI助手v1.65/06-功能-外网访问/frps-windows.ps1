# AI 工作台外网入口 — 云服务器一键部署（阿里云云助手 · PowerShell 直接整段粘贴运行）
# 作用：装 frp 服务端（家里电脑连进来的"门"）+ Caddy 带密码的门卫，
#       开机自启、防火墙放行，最后打印 ====RESULT====（TOKEN 和密码要抄给我）。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---- 安装位置：服务器上没有你的个人数据，但防呆起见仍优先 D:/E: 盘，实在没有才用 C: ----
$dir = 'C:\aiworkbench-entry'
foreach ($d in 'D:\', 'E:\') { if (Test-Path $d) { $dir = (Join-Path $d 'aiworkbench-entry'); break } }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Get-FileFallback($urls, $out) {
  foreach ($u in $urls) {
    try { Invoke-WebRequest -Uri $u -OutFile $out -TimeoutSec 120; return } catch { Write-Output "镜像失败，换下一个：$($u.Substring(0, [Math]::Min(60, $u.Length)))..." }
  }
  throw "所有下载地址都失败了：$($urls -join ' | ')"
}

# ---- 1. 下载 frp（GitHub 直连太慢，走 ghfast 镜像，失败再回退直连）----
$frpZip = Join-Path $dir 'frp.zip'
if (-not (Test-Path (Join-Path $dir 'frps.exe'))) {
  Get-FileFallback @(
    'https://ghfast.top/https://github.com/fatedier/frp/releases/download/v0.61.2/frp_0.61.2_windows_amd64.zip',
    'https://github.com/fatedier/frp/releases/download/v0.61.2/frp_0.61.2_windows_amd64.zip'
  ) $frpZip
  Expand-Archive -Path $frpZip -DestinationPath $dir -Force
  Get-ChildItem -Path (Join-Path $dir 'frp_*') -Filter '*.exe' | Move-Item -Destination $dir -Force
  Remove-Item $frpZip, (Join-Path $dir 'frp_*') -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- 2. 下载 Caddy（带密码的门卫）----
$caddyZip = Join-Path $dir 'caddy.zip'
if (-not (Test-Path (Join-Path $dir 'caddy.exe'))) {
  Get-FileFallback @(
    'https://ghfast.top/https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_windows_amd64.zip',
    'https://caddyserver.com/api/download?os=windows&arch=amd64'
  ) $caddyZip
  Expand-Archive -Path $caddyZip -DestinationPath $dir -Force
  Remove-Item $caddyZip -Force -ErrorAction SilentlyContinue
}

# ---- 3. 生成凭证（随机、够长；防呆：特殊字符避开引号问题）----
function New-Secret($len) { -join ((48..57) + (97..122) | Get-Random -Count $len | ForEach-Object { [char]$_ }) }
$token = New-Secret 24
$pass  = New-Secret 10
$bcrypt = (& (Join-Path $dir 'caddy.exe') hash-password --plaintext $pass | Out-String).Trim()
if (-not $bcrypt) { throw "caddy 生成密码哈希失败" }

# ---- 4. 写 frps 配置（门：只给拿 TOKEN 的家里电脑开）----
@"
bindPort = 7000
auth.method = "token"
auth.token = "$token"
log.to = "$($dir -replace '\\', '/')/frps.log"
log.level = "info"
log.maxDays = 7
"@ | Set-Content -Path (Join-Path $dir 'frps.toml') -Encoding ASCII

# ---- 5. 写 Caddy 门卫配置：外面访问 18787 要输密码，验完转给 frp 隧道口 18788 ----
@"
:18787 {
	basic_auth {
		ai {
			$bcrypt
		}
	}
	encode gzip
	reverse_proxy 127.0.0.1:18788
}
"@ | Set-Content -Path (Join-Path $dir 'Caddyfile') -Encoding ASCII

# ---- 6. 防火墙放行（Windows 这一层；防呆：先删同名旧规则再添加，重复跑不堆垃圾）----
foreach ($p in 7000, 18787, 18788) {
  cmd /c "netsh advfirewall firewall delete rule name=AIWB-$p >nul 2>&1"
  netsh advfirewall firewall add rule name="AIWB-$p" dir=in action=allow protocol=TCP localport=$p | Out-Null
}

# ---- 7. 开机自启（任务计划程序，不依赖谁登录）----
# 防呆：schtasks 把"任务不存在"写到 stderr，PowerShell 在 Stop 模式下会把原生
# 命令的 stderr 升级成致命错误终止脚本（第一次执行就是栽在这，前 90% 已完成）。
# 这一段临时放宽错误处理。
$ErrorActionPreference = 'Continue'
schtasks /delete /tn "AIWB-frps" /f 2>$null | Out-Null
schtasks /delete /tn "AIWB-caddy" /f 2>$null | Out-Null
schtasks /create /tn "AIWB-frps" /tr "cmd /c cd /d $dir && frps.exe -c frps.toml >> frps-run.log 2>&1" /sc onstart /ru SYSTEM /f | Out-Null
schtasks /create /tn "AIWB-caddy" /tr "cmd /c cd /d $dir && caddy.exe run --config Caddyfile >> caddy-run.log 2>&1" /sc onstart /ru SYSTEM /f | Out-Null
$ErrorActionPreference = 'Stop'

# ---- 8. 立刻启动一次 ----
# 防呆：绝不能用 Start-Process 直接拉服务——云助手会等脚本的全部后代进程退出，
# 常驻的 frps/caddy 会让命令永远"执行中"直到超时（上次执行超时就栽在这）。
# 改由计划任务启动（任务归任务计划程序管，和本脚本进程树脱钩），脚本马上能交差。
Stop-Process -Name frps, caddy -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Continue'
schtasks /run /tn "AIWB-frps"  | Out-Null
schtasks /run /tn "AIWB-caddy" | Out-Null
$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds 5

$frpsOk  = [bool](Get-Process frps -ErrorAction SilentlyContinue)
$caddyOk = [bool](Get-Process caddy -ErrorAction SilentlyContinue)

Write-Output "====RESULT===="
Write-Output "TOKEN=$token"
Write-Output "ENTRY_USER=ai"
Write-Output "ENTRY_PASSWORD=$pass"
Write-Output "FRPS_RUNNING=$frpsOk"
Write-Output "CADDY_RUNNING=$caddyOk"
Write-Output "DIR=$dir"
