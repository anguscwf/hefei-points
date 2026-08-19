#!/bin/bash
# 糖罐积分管理 - 每日自动备份脚本
# crontab: 0 2 * * * /home/ubuntu/hefei-points/backup.sh

set -e
APP_DIR="/home/ubuntu/hefei-points"
BACKUP_DIR="${APP_DIR}/backups"

# 通过 SQLite VACUUM INTO 创建事务一致的单文件快照
cd "${APP_DIR}"
DATA_DIR="${APP_DIR}/data" node scripts/backup-sqlite.js

# 保留最近 365 天，删除更早的
find "${BACKUP_DIR}" -maxdepth 1 -type d -mtime +365 -exec rm -rf {} \; 2>/dev/null || true

# 日志
echo "[$(date '+%Y-%m-%d %H:%M:%S')] SQLite 备份完成"
