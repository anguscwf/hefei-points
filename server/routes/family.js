const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const repositories = require('../db/repositories');
const validation = require('../lib/validation');
const { signToken, verifyToken, requireRole, getToken, hashPwd } = require('../lib/token');
const { joinRateLimit } = require('../middleware/rate-limit');
const features = require('../config/features');

function generateInvite() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    if (!repositories.families.findByInviteCode(code)) {
      return { code, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), maxUses: 3, usedCount: 0, isActive: true };
    }
  }
  throw new Error('邀请码生成失败（碰撞次数过多）');
}

router.get('/family', async (req, res) => {
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  const familyId = user.familyId || 'default';
  const family = repositories.families.findById(familyId);
  if (!family) return res.status(404).json({ success: false, message: '家庭不存在' });
  if (user.role === 'child') {
    const state = repositories.guardianConsents.getPrivacyState({ familyId, childId: user.id });
    if (!state || state.status !== 'active') {
      return res.status(409).json({
        success: false,
        code: 'CHILD_PROCESSING_BLOCKED',
        message: '儿童档案当前不可访问'
      });
    }
  }
  const authorizedChildIds = user.role === 'child'
    ? new Set([user.id])
    : new Set(repositories.guardianConsents.listActiveGuardianChildIds({
      familyId,
      guardianId: user.id
    }));
  const members = user.role === 'child'
    ? [{ id: user.id, name: user.name, role: user.role }]
    : repositories.users.listByFamily(familyId)
      .filter(member => member.role !== 'child' || authorizedChildIds.has(member.id))
      .map(member => ({ id: member.id, name: member.name, role: member.role }));
  const safeFamily = user.role === 'child'
    ? { id: family.id, name: family.name, createdAt: family.createdAt }
    : { id: family.id, name: family.name, inviteCode: family.inviteCode, createdAt: family.createdAt };
  res.json({ success: true, family: safeFamily, members });
});

router.post('/family/create', async (req, res) => {
  const { familyName } = req.body;
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  if (user.role === 'child') return res.status(403).json({ success: false, message: '请联系家长操作' });
  const familyNameError = validation.text(familyName, { field: '家庭名称', min: 2, max: 50 });
  if (familyNameError) return res.status(400).json({ success: false, message: familyNameError });
  try {
    const invite = generateInvite();
    const familyId = 'fam_' + Date.now().toString(36);
    repositories.families.createWithAdmin({ id: familyId, name: familyName.trim(), invite, inviteCode: invite.code, createdAt: new Date().toISOString() }, user.id);
    const newToken = signToken(user.id, 'admin', familyId);
    res.json({ success: true, token: newToken, familyId, inviteCode: invite.code, message: `家庭「${familyName.trim()}」创建成功！邀请码：${invite.code}` });
  } catch (_) {
    res.status(503).json({ success: false, message: '创建失败' });
  }
});

router.post('/family/join', joinRateLimit, async (req, res) => {
  const { inviteCode } = req.body;
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  if (user.role === 'child') return res.status(403).json({ success: false, message: '请联系家长操作' });
  if (typeof inviteCode !== 'string' || inviteCode.trim().length < 4 || inviteCode.trim().length > 20) {
    return res.status(400).json({ success: false, message: '请输入有效邀请码' });
  }
  try {
    const family = repositories.families.joinByInvite(user.id, inviteCode.trim().toUpperCase());
    const newToken = signToken(user.id, user.role, family.id);
    res.json({ success: true, token: newToken, family: { id: family.id, name: family.name }, message: `已加入家庭「${family.name}」！` });
  } catch (e) {
    const status = ['邀请码无效', '用户不存在', '你已在该家庭中'].includes(e.message) ? 400 : 503;
    res.status(status).json({ success: false, message: e.message || '加入失败' });
  }
});

router.post('/family/leave', async (req, res) => {
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  const familyId = user.familyId || 'default';
  if (familyId === 'default') return res.status(400).json({ success: false, message: '已在默认家庭，无需离开' });
  if (user.role === 'child') return res.status(403).json({ success: false, message: '请联系家长操作' });
  if (user.role === 'admin') return res.status(400).json({ success: false, message: '管理员不能直接离开家庭，请先转让或删除家庭' });
  try {
    if (!repositories.families.moveUser(user.id, 'default')) throw new Error('用户不存在');
    res.json({ success: true, token: signToken(user.id, user.role, 'default'), message: '已回到默认家庭' });
  } catch (e) {
    res.status(503).json({ success: false, message: e.message || '操作失败' });
  }
});

router.post('/family/kick', async (req, res) => {
  const { userId } = req.body;
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可踢出成员' });
  if (!userId) return res.status(400).json({ success: false, message: '请指定要踢出的用户ID' });
  if (userId === admin.id) return res.status(400).json({ success: false, message: '不能踢出自己' });
  const target = repositories.users.findById(userId);
  if (target && target.familyId === (admin.familyId || 'default') && target.role === 'child') {
    const consent = repositories.guardianConsents.findActiveConsent({
      familyId: admin.familyId || 'default',
      childId: target.id,
      guardianId: admin.id
    });
    const state = repositories.guardianConsents.getPrivacyState({
      familyId: admin.familyId || 'default',
      childId: target.id
    });
    if (!consent || !state || state.status !== 'active') {
      return res.status(404).json({ success: false, message: '该用户不在你的家庭中' });
    }
  }
  if (target && target.familyId === (admin.familyId || 'default') && target.role === 'child' && !features.isLegacyChildManagementEnabled()) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_DISABLED',
      message: '旧版儿童账号管理已停用，请使用儿童数据权利流程'
    });
  }
  try {
    const name = repositories.families.kickUser(userId, admin.familyId || 'default');
    res.json({ success: true, message: `已将「${name}」踢出家庭` });
  } catch (e) {
    res.status(e.message === '该用户不在你的家庭中' ? 404 : 503).json({ success: false, message: e.message || '操作失败' });
  }
});

router.post('/family/delete', async (req, res) => {
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可删除家庭' });
  const familyId = admin.familyId || 'default';
  if (familyId === 'default') return res.status(400).json({ success: false, message: '不能删除默认家庭' });
  const hasChildren = repositories.users.listByFamily(familyId).some(member => member.role === 'child');
  if (hasChildren && !features.isLegacyChildManagementEnabled()) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_DISABLED',
      message: '家庭包含受保护档案，请先通过数据权利流程处理'
    });
  }
  try {
    repositories.families.deleteFamily(familyId);
    res.json({ success: true, token: signToken(admin.id, admin.role, 'default'), message: '家庭已删除，已回到默认家庭' });
  } catch (e) {
    res.status(e.message === '家庭不存在' ? 404 : 503).json({ success: false, message: e.message || '删除失败' });
  }
});

router.post('/family/child/create', async (req, res) => {
  const { id, name, password } = req.body;
  const user = requireRole(getToken(req), ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '仅家长或管理员可添加孩子' });
  if (!features.isLegacyChildManagementEnabled()) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_DISABLED',
      message: '旧版儿童账号创建已停用，请使用监护人授权建档流程'
    });
  }
  if (!id || !name) return res.status(400).json({ success: false, message: '请输入孩子ID和姓名' });
  if (!/^[a-z0-9_]{2,20}$/.test(id)) return res.status(400).json({ success: false, message: '孩子ID仅限小写字母/数字/下划线，2-20字符' });
  const childNameError = validation.text(name, { field: '孩子姓名', min: 1, max: 30 });
  if (childNameError) return res.status(400).json({ success: false, message: childNameError });
  const childPasswordError = validation.text(password, { field: '孩子密码', min: 8, max: 128 });
  if (childPasswordError) return res.status(400).json({ success: false, message: childPasswordError });
  const familyId = user.familyId || 'default';
  try {
    if (repositories.users.findById(id)) throw new Error('该ID已被使用');
    repositories.users.insert({ id, name: name.trim(), role: 'child', password: hashPwd(password), familyId });
    res.json({ success: true, user: { id, name: name.trim(), role: 'child', familyId }, message: `孩子「${name.trim()}」添加成功！` });
  } catch (e) {
    res.status(e.message === '该ID已被使用' ? 409 : 503).json({ success: false, message: e.message || '创建失败' });
  }
});

module.exports = router;
