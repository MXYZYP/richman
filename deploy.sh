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

APP_DIR="/root/richman-main"
BRANCH="main"
PM2_NAME="richman"

cd "$APP_DIR"

echo "[1/4] 拉取远端最新代码 (origin/$BRANCH) ..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[2/4] 安装依赖（锁文件有变化时才需要，可注释掉以加速）..."
# pnpm install --frozen-lockfile

echo "[3/4] 构建前端 ..."
pnpm --filter @richman/client build

echo "[4/4] 重启进程 ..."
pm2 restart "$PM2_NAME"

echo "===== 部署完成 ====="
pm2 status "$PM2_NAME"
