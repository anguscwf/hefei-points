const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { doBackup, BACKUP_DIR } = require('../lib/backup');
const { requireRole, getToken } = require('../lib/token');

// ============== 备份 API ==============
router.post('/backup', async (req, res) => {
  if (!requireRole(getToken(req), ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可触发备份' });
  }
  res.json(doBackup());
});

router.get('/backups', async (req, res) => {
  if (!requireRole(getToken(req), ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可查看备份列表' });
  }
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
      .sort().reverse().slice(0, 30);
    res.json({ success: true, backups });
  } catch (e) { res.json({ success: true, backups: [] }); }
});

module.exports = router;
