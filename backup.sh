#!/bin/bash
# 赫菲积分管理 - 每日自动备份脚本
# crontab: 0 2 * * * /home/ubuntu/hefei-points/backup.sh

set -e
APP_DIR="/home/ubuntu/hefei-points"
BACKUP_DIR="${APP_DIR}/backups"
TS=$(date +%Y-%m-%d_%H%M%S)
DEST="${BACKUP_DIR}/${TS}"

mkdir -p "${DEST}"

# 复制核心数据文件
for f in points.json config.json history.json; do
  if [ -f "${APP_DIR}/data/${f}" ]; then
    cp "${APP_DIR}/data/${f}" "${DEST}/${f}"
  fi
done

# 保留最近 365 天，删除更早的
find "${BACKUP_DIR}" -maxdepth 1 -type d -mtime +365 -exec rm -rf {} \; 2>/dev/null || true

# 日志
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份完成: ${DEST}"
