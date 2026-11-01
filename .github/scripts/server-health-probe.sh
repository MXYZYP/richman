# 服务器本机健康探针（health-check.yml 经 SSH 调用执行）。
# 输入：$EXPECT —— 期望的 SW 版本（如 richman-v28），由 runner 侧从仓库 checkout 提取传入。
# 五项检查任一失败即 exit 1：
#   1. /healthz 返回 200
#   2. pm2 里 richman 在线（防止孤儿进程占 3000 端口代答 /healthz）
#   3. dist sw.js 版本 == $EXPECT（抓「部署没跑新前端」与「忘升 SW 版本」）
#   4. 首页（静态托管）返回 200 且是 index.html
#   5. 首页引用的主 JS 资源返回 200（抓「白屏」）
#   6. /api/metrics 返回 200 且带 uptimeSeconds（运营 O2）
#   7. 主 JS 资源带压缩（E1）：带 Accept-Encoding 请求必须拿到 content-encoding
# 第 6 项是关键：**「部署成功」不等于「新代码在跑」**。/healthz 任何人都能答（包括占住
# 3000 端口的孤儿进程），而 /api/metrics 是只有这一版代码才有的端点 —— 它答得出来，
# 才说明跑着的确实是刚部署上去的那份构建。
set -u
fail() { echo "::error::$1"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/healthz)
echo "healthz=$code"
[ "$code" = "200" ] || fail "/healthz returned $code (expected 200)"

# pm2 状态用 jlist + node 解析：describe 的表格用制表符 │（U+2502），
# ASCII 竖线的 grep 永远匹配不上（health-check 曾因此每小时假警报，2026-10-29 实锤）。
pm2_status=$(pm2 jlist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const l=JSON.parse(d);const p=l.find(x=>x.name==='richman');console.log(p&&p.pm2_env?p.pm2_env.status:'absent')}catch(e){console.log('parse-error')}})")
echo "pm2 richman status: $pm2_status"
[ "$pm2_status" = "online" ] || fail "pm2 richman is not online（status=$pm2_status；/healthz 可能被孤儿进程代答）"

[ -n "${EXPECT:-}" ] || fail "EXPECT env is empty"
online=$(grep -o 'richman-v[0-9]*' /root/richman-main/apps/client/dist/sw.js | head -1)
echo "dist SW: $online (expected $EXPECT)"
[ "$online" = "$EXPECT" ] || fail "SW version drift: dist=$online expected=$EXPECT（部署没跑新前端，或仓库忘了升 SW 版本）"

# 静态托管探测：/healthz 只证明 Node 进程活着 —— 静态目录/nginx 坏掉时它照样 200（假绿）。
# 抓两类真事故：首页不返回 200 / 首页里引用的主 JS 拿不到（玩家打开就是白屏）。
root_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/)
echo "root=$root_code"
[ "$root_code" = "200" ] || fail "static root returned $root_code (expected 200)"

html=$(curl -s --max-time 15 http://127.0.0.1:3000/)
printf '%s' "$html" | grep -q '<title>' || fail "static root has no <title>（返回的可能不是 index.html）"

asset=$(printf '%s' "$html" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$asset" ] || fail "no /assets/*.js referenced in index.html"
asset_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:3000$asset")
echo "asset=$asset code=$asset_code"
[ "$asset_code" = "200" ] || fail "main asset $asset returned $asset_code (expected 200，玩家会白屏)"

metrics_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/api/metrics)
echo "metrics=$metrics_code"
[ "$metrics_code" = "200" ] || fail "/api/metrics returned $metrics_code (expected 200；跑着的可能不是刚部署的那份代码)"

metrics_body=$(curl -s --max-time 15 http://127.0.0.1:3000/api/metrics)
printf '%s' "$metrics_body" | grep -q 'uptimeSeconds' || fail "/api/metrics 缺 uptimeSeconds（端点存在但内容不对：可能命中了旧的静态兜底）"
echo "metrics body: $(printf '%s' "$metrics_body" | head -c 160)"

# E1：压缩是纯服务端改动，/healthz 与首屏 200 都证明不了它生效。
# 只有带上 Accept-Encoding 真去要一次、看到 content-encoding，才算确认玩家拿到的是压缩后的包。
asset_encoding=$(curl -s -o /dev/null -D - -H 'Accept-Encoding: br, gzip' --max-time 15 "http://127.0.0.1:3000$asset" | grep -i '^content-encoding:' | tr -d '\r' | head -1)
echo "asset encoding: ${asset_encoding:-none}"
[ -n "$asset_encoding" ] || fail "main asset $asset served without content-encoding（压缩没生效：要么 scripts/compress-dist.mjs 没跑，要么 sirv 没开 brotli/gzip）"

echo "ALL_OK"
