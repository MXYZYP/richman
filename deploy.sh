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

echo "[1/4] 拉取远端最新代码 (origin/$BRANCH) ..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[2/4] 安装依赖（pnpm-lock.yaml 变化时自动执行）..."
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

echo "[3/4] 构建前端 ..."
pnpm --filter @richman/client build

echo "[4/4] 重启进程 ..."
pm2 restart "$PM2_NAME"

echo "===== 部署完成 ====="
pm2 status "$PM2_NAME"
