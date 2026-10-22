#!/usr/bin/env bash
# 云服务器一键部署：frps 反向代理 + 可选 Caddy HTTPS 入口
# 用法（SSH 登进云服务器后整段粘贴，或 root 执行）：
#   bash frps-install.sh <访问口令> [你的域名可选]
# 例：bash frps-install.sh MyStr0ng!Pass work.example.com
set -e
AUTH=${1:?用法: bash frps-install.sh 访问口令 [域名]}
DOMAIN=${2:-}
FRP_VER=0.61.2
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
command -v systemctl >/dev/null || { echo "需要 systemd 系统（Ubuntu/Debian/CentOS8+/Alibaba Cloud Linux 都支持）"; exit 1; }

echo "== 1/4 安装 frps（国内镜像优先）=="
cd /tmp
if [ ! -f frps.tar.gz ]; then
  for m in "https://gitee-mirror-not-exist.invalid" "https://ghfast.top/https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz" "https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz"; do
    wget -q -T 20 -t 2 -O frps.tar.gz "$m" && break || true
  done
fi
tar -xzf frps.tar.gz
mkdir -p /etc/frp /var/log/frp
install -m 755 frp_${FRP_VER}_linux_amd64/frps /usr/local/bin/frps

echo "== 2/4 frps 配置 + systemd 常驻 =="
TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20)
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${TOKEN}"
# 工作台固定入口端口（内网穿透映射）
EOF
cat > /etc/systemd/system/frps.service <<EOF
[Unit]
Description=frp server
After=network.target
[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now frps
echo "frps 已常驻 ✓"

echo "== 3/4 入口（带密码的 HTTPS 反代）=="
if command -v caddy >/dev/null 2>&1 || { (command -v apt-get >/dev/null && apt-get install -y -q debian-package-install 2>/dev/null) || true; }; then :; fi
if ! command -v caddy >/dev/null; then
  for m in "https://caddyserver.com/api/download?os=linux&arch=amd64" ; do :; done
  echo "尝试安装 Caddy..."
  if command -v apt-get >/dev/null; then
    apt-get install -y -q debian-keyring 2>/dev/null || true
    curl -o /tmp/caddy.tar.gz "https://caddyserver.com/api/download?os=linux&arch=amd64" --max-time 60 || true
  fi
  if [ -s /tmp/caddy.tar.gz ]; then
    tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy || true
    chmod +x /usr/local/bin/caddy || true
  fi
fi

if command -v caddy >/dev/null && [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  basic_auth {
    long
    $(caddy hash-password --plaintext "${AUTH}")
  }
  reverse_proxy 127.0.0.1:18787
}
EOF
  mkdir -p /etc/caddy; caddy validate --config /etc/caddy/Caddyfile && systemctl enable --now caddy 2>/dev/null && service caddy reload 2>/dev/null
  echo "Caddy HTTPS 入口就绪：https://${DOMAIN} ✓"
elif command -v caddy >/dev/null; then
  cat > /etc/caddy/Caddyfile <<EOF
{
  auto_https off
}
:18788 {
  basic_auth {
    long
    $(caddy hash-password --plaintext "${AUTH}")
  }
  reverse_proxy 127.0.0.1:18787
}
EOF
  systemctl enable --now caddy 2>/dev/null || (nohup caddy run --config /etc/caddy/Caddyfile >/var/log/frp/caddy.log 2>&1 &)
  echo "HTTP+密码 入口就绪：http://<服务器IP>:18788 （建议之后加域名升级 HTTPS）"
else
  echo "⚠ 未装成 Caddy：frps 直连 18787 端口也能用（先手动测试，稍后再补 HTTPS）"
fi

echo "== 4/4 完成 =="
echo "把下面这行【原样发回给我或自己留存】——家里电脑连它需要："
echo "FRPS 地址: 本机公网IP:7000  TOKEN: ${TOKEN}"
ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | grep -v 127.0.0.1 | head -1
echo "下一步：在阿里云/腾讯云控制台安全组放行 18788（和 7000 若未放行）"
