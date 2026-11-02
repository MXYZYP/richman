#!/usr/bin/env bash
# 服务器端一键部署：拉取最新代码 -> 构建前端 -> 重启 pm2 进程
# 用法（在服务器上）：cd /root/richman-main && bash deploy.sh
#
# 说明：
#  - 服务端用 tsx 直跑 TS 源码，所以「服务端改动」只需 pm2 restart；
#    「前端改动」必须重新 pnpm build 才会更新 apps/client/dist。
#  - 这个脚本假设你在服务器上从不手动改代码（部署目标 = 只读对齐远端）。
#    因此用 fetch + reset --hard 强制与 GitHub 的 main 完全一致。
set -euo pipefail

# 非交互式 SSH（例如 GitHub Actions 的 appleboy/ssh-action）不会加载登录 profile，
# PATH 里可能找不到 pnpm/pm2/node。这里补齐常见安装位置；若你的 node 装在别处
# （nvm/fnm/独立目录），把对应的 bin 目录也加到下面即可。
export PATH="$PATH:/root/.local/share/pnpm:/usr/local/bin:/usr/local/sbin:/usr/bin"
if [ -d "$HOME/.nvm/versions/node" ]; then
  for _node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$_node_bin" ] && export PATH="$PATH:$_node_bin"
  done
fi

command -v pnpm >/dev/null 2>&1 || { echo "[ERROR] 找不到 pnpm，请把 node/pnpm 的 bin 目录加入 PATH（当前 PATH=$PATH）"; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "[ERROR] 找不到 pm2，请把 pm2 的 bin 目录加入 PATH（当前 PATH=$PATH）"; exit 1; }

APP_DIR="/root/richman-main"
BRANCH="main"
PM2_NAME="richman"

cd "$APP_DIR"

echo "[1/5] 拉取远端最新代码 (origin/$BRANCH) ..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[2/5] 安装依赖（pnpm-lock.yaml 变化时自动执行）..."
# 为什么不能用 pnpm install 一直禁用：服务端新增/升级运行时依赖时，
# 旧 node_modules 会导致线上 "Cannot find module"，必须在部署时对齐 lockfile。
#
# 为什么用 stamp 做条件判断：pnpm install 在依赖无变化时也要跑 ~20s，
# 且会把 devDependencies（@playwright/test）装回服务器。用上次安装时的
# lockfile 摘要做标记，不变即跳过，变化才真正安装。
#
# 关于 pnpm 10 的 "Ignored build scripts: esbuild, vue-demi" 警告：
# 本项目已实测 —— 忽略这些脚本不影响 vite 生产构建产物（esbuild 的平台二进制
# 来自 optionalDependencies，不依赖 postinstall），故无需 onlyBuiltDependencies。
#
# --frozen-lockfile：lockfile 与 package.json 不一致时直接报错退出（预期保护，
# 避免部署出一份依赖状态不可复现的代码）。--prefer-offline：优先用本地缓存加速。
LOCKFILE_STAMP="$APP_DIR/.runtime/pnpm-lock.sha256"
CURRENT_LOCK_STAMP="$(sha256sum "$APP_DIR/pnpm-lock.yaml" 2>/dev/null || echo missing)"
if [ -f "$LOCKFILE_STAMP" ] && [ "$(cat "$LOCKFILE_STAMP")" = "$CURRENT_LOCK_STAMP" ]; then
  echo "  pnpm-lock.yaml 未变化，跳过依赖安装（强制重装：删除 $LOCKFILE_STAMP 后重跑本脚本）"
else
  pnpm install --frozen-lockfile --prefer-offline
  mkdir -p "$(dirname "$LOCKFILE_STAMP")"
  printf '%s\n' "$CURRENT_LOCK_STAMP" > "$LOCKFILE_STAMP"
fi

echo "[3/5] 构建前端 + 类型检查服务端（串行、限堆、带硬超时）..."
# ★ 2026-11-02 事故背景（保留，别再改回并行）：这台服务器物理内存只有 1.6GB，
#   且 **没有 swap**（free -m 显示 Swap: 0 0 0）。原实现把 vue-tsc（前端）与
#   tsc（服务端）**并行**跑，两个类型检查器同时吃内存、又完全没有交换区兜底，
#   机器进入「TCP 能握手，但 nginx、sshd 一律无响应」的假死状态：
#   站点中断 39 分钟（12:17→12:56），Actions 卡到 30m 超时，最后只能从阿里云
#   控制台重启实例才恢复。parallel 省下的两分钟，代价是一次线上中断。
#   加固三条：
#   ① 串行 —— 同一时刻只有一个类型检查在跑；
#   ② NODE_OPTIONS 限堆 —— 内存不够时**快速明确失败**，而不是把整机拖死；
#   ③ timeout 硬超时 —— 杜绝无限挂起（780s×2 = 26m < Actions 的 30m command_timeout）。
BUILD_TIMEOUT=780
export NODE_OPTIONS="--max-old-space-size=1024"
# swap 体检：小内存机器「没有 swap」是 2026-11-02 事故的另一半根因 —— 内存吃紧时
# 没有缓冲，不会被 OOM killer 救场，只会整机假死到必须云控制台重启。这里只告警不阻断：
# 加 swap 属于改系统配置（会写 /etc/fstab），不该由部署脚本擅自做，交给运维决定。
SWAP_MB="$(awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
PHYS_MB="$(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
SWAP_MB="${SWAP_MB:-0}"
PHYS_MB="${PHYS_MB:-0}"
if [ "$SWAP_MB" -eq 0 ] && [ "$PHYS_MB" -le 2048 ]; then
  echo "  [WARN] 物理内存仅 ${PHYS_MB}MB 且 **没有 swap**（SwapTotal=0）。" >&2
  echo "         构建一旦吃紧，整机可能假死到只能在云控制台重启（2026-11-02 已发生过一次，中断 39 分钟）。" >&2
  echo "         建议一次性补 2GB swap（root 执行，约 10 秒，重启后仍生效）：" >&2
  echo "         fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab" >&2
else
  echo "  物理内存 ${PHYS_MB}MB / swap ${SWAP_MB}MB"
fi

AVAIL_MB="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo unknown)"
echo "  可用内存 ${AVAIL_MB}MB（本机内存小 ⇒ 构建必须串行 + 限堆）"
if [ "$AVAIL_MB" != "unknown" ] && [ "$AVAIL_MB" -lt 700 ]; then
  echo "  [WARN] 可用内存偏低（<700MB），构建有失败风险；建议先释放内存或给服务器加 swap。" >&2
fi

CLIENT_FAIL=0
SERVER_FAIL=0
timeout "$BUILD_TIMEOUT" pnpm --filter @richman/client build || CLIENT_FAIL=$?
if [ "$CLIENT_FAIL" -ne 0 ]; then
  echo "[ERROR] 前端构建失败（退出码 $CLIENT_FAIL；124=超过 ${BUILD_TIMEOUT}s 硬超时），部署中止。" >&2
  exit 1
fi
echo "  前端构建通过。"

timeout "$BUILD_TIMEOUT" pnpm --filter @richman/server build || SERVER_FAIL=$?
if [ "$SERVER_FAIL" -ne 0 ]; then
  echo "[ERROR] 服务端类型检查未通过（退出码 $SERVER_FAIL；124=超过 ${BUILD_TIMEOUT}s 硬超时），部署中止（绝不重启旧进程）。" >&2
  exit 1
fi
echo "  前端构建与服务端类型检查均通过。"

echo "[4/5] 重启进程 ..."
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  # pm2 守护进程可能随机器重启消失且未配 pm2 startup（2026-10-26 实测发生过：
  # 守护进程被重新拉起后报「Process richman not found」，线上静默宕机）。
  # 按发布 SOP 的首次启动命令拉起；端口用服务端默认 3000（与反代约定一致）。
  echo "  pm2 中无 $PM2_NAME 进程，按首次启动拉起 ..."
  pm2 start "pnpm --filter @richman/server start" --name "$PM2_NAME"
fi
pm2 save

echo "===== 健康检查 ====="
# 部署即验证：服务起不来就判整次部署失败（Actions 日志可直接看到），不带病收工。
HEALTH_OK=0
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
    echo "  /healthz ok"
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [ "$HEALTH_OK" -ne 1 ]; then
  echo "[ERROR] 重启后 /healthz 持续不可达（按服务端默认端口 3000 检查）——上服务器跑 pm2 logs richman 排查" >&2
  pm2 status "$PM2_NAME" || true
  exit 1
fi

echo "===== 部署完成 ====="
pm2 status "$PM2_NAME"
