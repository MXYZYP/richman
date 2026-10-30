#!/usr/bin/env bash
# 服务器玩家数据每日备份（cron 调用）。
#
# 备份对象：apps/server/.runtime/ —— leaderboard.json（排行榜）、
#           player-accounts.json（账号）、room-snapshots/（进行中房间存档）。
# 为什么必须备份：该目录是 gitignore 的（deploy 的 git reset --hard 不会删它，
# 这点是好事），但也意味着**它从来没进过任何版本库/快照**。误删或文件损坏 = 零恢复。
# 实测总大小 16K（2026-10-30），代价约等于零。
#
# 用法：bash backup-richman-data.sh        # 手动跑一次
#       bash backup-richman-data.sh --restore <日期>   # 例：--restore 20261030
# 回滚/卸载：crontab -e 删掉那一行；rm -rf /root/backups
set -euo pipefail

APP_DIR=/root/richman-main
SRC_DIR="$APP_DIR/apps/server/.runtime"
BACKUP_DIR=/root/backups
KEEP_DAYS=7
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# ---- 恢复模式 ----
if [[ "${1:-}" == "--restore" ]]; then
  day="${2:-}"
  tar_file="$BACKUP_DIR/richman-data-$day.tar.gz"
  if [[ ! -f "$tar_file" ]]; then
    echo "找不到备份：$tar_file"
    echo "可用备份："
    ls -1 "$BACKUP_DIR" | grep '^richman-data-' || true
    exit 1
  fi
  # 恢复前先把当前数据另存一份，绝不直接覆盖（宁可多一份垃圾，也不丢现有数据）
  pre="$BACKUP_DIR/pre-restore-$(date '+%Y%m%d-%H%M%S').tar.gz"
  tar -czf "$pre" -C "$APP_DIR/apps/server" .runtime
  echo "当前数据已另存：$pre"
  tar -xzf "$tar_file" -C "$APP_DIR/apps/server"
  echo "已从 $tar_file 恢复到 $SRC_DIR"
  echo "注意：服务端进程正在内存中持有数据，需 pm2 restart richman 才会重新读盘。"
  exit 0
fi

# ---- 备份模式 ----
if [[ ! -d "$SRC_DIR" ]]; then
  log "ERROR 源目录不存在：$SRC_DIR"
  exit 1
fi

day=$(date '+%Y%m%d')
out="$BACKUP_DIR/richman-data-$day.tar.gz"
tar -czf "$out" -C "$APP_DIR/apps/server" .runtime
size=$(du -h "$out" | cut -f1)
log "OK $out ($size)"

# 轮转：删掉超过 KEEP_DAYS 天的归档（按文件名日期切，mtime 不可靠）
find "$BACKUP_DIR" -maxdepth 1 -name 'richman-data-*.tar.gz' -type f \
  | while read -r f; do
      d=$(basename "$f" | sed 's/richman-data-\([0-9]*\)\.tar\.gz/\1/')
      if [[ -n "$d" && "$d" < "$(date -d "-$KEEP_DAYS days" '+%Y%m%d')" ]]; then
        rm -f "$f"
        log "ROTATE 删除过期备份 $(basename "$f")"
      fi
    done

# 只保留最近 20 条日志
tail -n 20 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
