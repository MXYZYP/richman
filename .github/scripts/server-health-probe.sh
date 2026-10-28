# 服务器本机健康探针（health-check.yml 经 SSH 调用执行）。
# 输入：$EXPECT —— 期望的 SW 版本（如 richman-v28），由 runner 侧从仓库 checkout 提取传入。
# 三项检查任一失败即 exit 1：
#   1. /healthz 返回 200
#   2. pm2 里 richman 在线（防止孤儿进程占 3000 端口代答 /healthz）
#   3. dist sw.js 版本 == $EXPECT（抓「部署没跑新前端」与「忘升 SW 版本」）
set -u
fail() { echo "::error::$1"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/healthz)
echo "healthz=$code"
[ "$code" = "200" ] || fail "/healthz returned $code (expected 200)"

pm2_online=$(pm2 describe richman 2>/dev/null | grep -c '| status .*online' || true)
echo "pm2 richman online: $pm2_online"
[ "$pm2_online" -ge 1 ] || fail "pm2 richman is not online（/healthz 可能被孤儿进程代答）"

[ -n "${EXPECT:-}" ] || fail "EXPECT env is empty"
online=$(grep -o 'richman-v[0-9]*' /root/richman-main/apps/client/dist/sw.js | head -1)
echo "dist SW: $online (expected $EXPECT)"
[ "$online" = "$EXPECT" ] || fail "SW version drift: dist=$online expected=$EXPECT（部署没跑新前端，或仓库忘了升 SW 版本）"

echo "ALL_OK"
