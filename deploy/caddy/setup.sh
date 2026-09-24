#!/usr/bin/env bash
# 大富翁游戏 - Caddy 反代一键安装脚本（在服务器上以 root 或有 sudo 的账号运行）
# 前置（务必先完成）：
#   1) 域名控制台：game.mxyzyp.xyz 的 A 记录 -> 101.200.189.252 已生效（ping 得通）
#   2) 阿里云安全组：入站放行 TCP 80、TCP 443（来源 0.0.0.0/0）
# 说明：Caddy 用 HTTP-01 挑战申请证书，需要 80 端口可达且域名已解析到本机；
#       若 DNS 尚未生效，Caddy 会后台重试，待解析生效后自动签发，无需重跑本脚本。
set -euo pipefail

DOMAIN="game.mxyzyp.xyz"
UPSTREAM="127.0.0.1:3000"

echo "==> 安装 Caddy"
if command -v apt >/dev/null 2>&1; then
  sudo apt update
  # Ubuntu/Debian 默认仓库没有 caddy，必须先加官方 Cloudsmith 源
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y 'caddy'
elif command -v yum >/dev/null 2>&1; then
  sudo yum install -y 'caddy'
else
  echo "未识别到 apt/dnf/yum，请按 https://caddyserver.com/docs/install 手动安装 Caddy 后重跑脚本"
  exit 1
fi

echo "==> 备份并写入 Caddyfile"
if [ -f /etc/caddy/Caddyfile ]; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${DOMAIN} {
    reverse_proxy ${UPSTREAM}
}
EOF

echo "==> 放行防火墙 80/443（若启用了 ufw / firewalld）"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-service=http
  sudo firewall-cmd --permanent --add-service=https
  sudo firewall-cmd --reload
fi

echo "==> 启用并启动 Caddy"
sudo systemctl enable --now caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

echo
echo "==> 完成。请核对："
echo "   1) https://${DOMAIN} 能打开游戏（HTTPS 小锁）"
echo "   2) 创建/加入房间后，浏览器 DevTools -> Network 中 WebSocket 为 wss://${DOMAIN}"
echo "   3) 验证通过后，到阿里云安全组关闭公网 3000 入站（源站 IP:端口不再暴露）"
echo "   4) Cloudflare Tunnel 可退役（或留作备用）；邀请链接会自动变为新域名"
