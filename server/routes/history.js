const express = require('express');
const router = express.Router();
const repositories = require('../db/repositories');
const validation = require('../lib/validation');
const { verifyToken, requireRole, getToken } = require('../lib/token');

function isFamilyChild(kid, familyId) {
  const user = repositories.users.findById(kid);
  return Boolean(user && user.role === 'child' && user.familyId === familyId);
}

router.get('/history', (req, res) => {
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  const familyId = user.familyId || 'default';
  let kid;
  if (user.role === 'child') {
    kid = user.id;
  } else if (req.query.kid !== undefined) {
    if (typeof req.query.kid !== 'string' || !isFamilyChild(req.query.kid, familyId)) {
      return res.status(400).json({ success: false, message: '无效的孩子' });
    }
    kid = req.query.kid;
  }
  res.json({ success: true, history: repositories.transactions.listByFamily(familyId, kid, 50) });
});

router.post('/history/note', async (req, res) => {
  const { recordId, note } = req.body;
  const user = requireRole(getToken(req), ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '无操作权限' });
  try {
    if (!repositories.transactions.updateNote(recordId, user.familyId || 'default', note)) throw new Error('记录不存在');
    res.json({ success: true });
  } catch (e) {
    res.status(e.message === '记录不存在' ? 404 : 503).json({ success: false, message: e.message || '操作失败' });
  }
});

router.post('/history/delete', async (req, res) => {
  const { recordId } = req.body;
  const user = requireRole(getToken(req), ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '无操作权限' });
  try {
    if (!repositories.transactions.remove(recordId, user.familyId || 'default')) throw new Error('记录不存在');
    res.json({ success: true });
  } catch (e) {
    res.status(e.message === '记录不存在' ? 404 : 503).json({ success: false, message: e.message || '删除失败' });
  }
});

router.post('/history/cleanup', async (req, res) => {
  const { kid, beforeDate, afterDate } = req.body || {};
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可清理记录' });
  const dateError = validation.dateRange(afterDate, beforeDate);
  if (dateError) return res.status(400).json({ success: false, message: dateError });
  if (kid && !isFamilyChild(kid, admin.familyId || 'default')) {
    return res.status(400).json({ success: false, message: '无效的孩子' });
  }
  try {
    const deletedCount = repositories.transactions.cleanup(admin.familyId || 'default', { kid, beforeDate, afterDate });
    return res.json({ success: true, deletedCount, message: `已清理 ${deletedCount} 条记录` });
  } catch (e) {
    return res.status(503).json({ success: false, message: '清理失败：' + e.message });
  }
});

module.exports = router;
