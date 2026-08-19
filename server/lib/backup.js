const fs = require('fs');
const path = require('path');
const { DATA_DIR, getDb } = require('../db/connection');
const logger = require('./logger');

const BACKUP_DIR = path.join(DATA_DIR, '..', 'backups');

function doBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(BACKUP_DIR, ts);
  const destination = path.join(dir, 'hefei-points.sqlite');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const escaped = destination.replace(/'/g, "''");
    getDb().exec(`VACUUM INTO '${escaped}'`);
    logger.info({ event: 'backup.completed', directory: dir }, 'backup completed');
    return { ok: true, dir, ts };
  } catch (e) {
    logger.error({ event: 'backup.failed', error: e.message }, 'backup failed');
    return { ok: false, error: e.message };
  }
}

module.exports = { doBackup, BACKUP_DIR };
