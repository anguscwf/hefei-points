const express = require('express');
const router = express.Router();
const repositories = require('../db/repositories');
const validation = require('../lib/validation');
const { verifyToken, requireRole, getToken, hashPwd, isHashed } = require('../lib/token');

function safeUser(user) {
  return { id: user.id, name: user.name, role: user.role, familyId: user.familyId || 'default' };
}

router.get('/config', (req, res) => {
  const user = verifyToken(getToken(req));
  const familyId = user ? (user.familyId || 'default') : 'default';
  const family = repositories.families.findById(familyId);
  if (user && !family) return res.status(404).json({ success: false, message: '家庭不存在' });
  const publicUserList = repositories.users.listAll().map(safeUser);
  if (!user) {
    return res.json({ success: true, public: true, users: publicUserList });
  }
  return res.json({
    success: true,
    rules: repositories.config.getRules(),
    families: { [familyId]: family },
    users: repositories.users.listByFamily(familyId).map(safeUser)
  });
});

router.post('/config/rules', async (req, res) => {
  if (!requireRole(getToken(req), ['admin'])) return res.status(403).json({ success: false, message: '仅管理员可修改规则' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rules = body.rules;
  const rulesError = validation.validateRules(rules);
  if (rulesError) {
    return res.status(400).json({
      success: false,
      code: rulesError.code,
      message: rulesError.message,
      field: rulesError.field
    });
  }

  const hasBodyRevision = Object.prototype.hasOwnProperty.call(body, 'revision');
  const hasRulesRevision = Object.prototype.hasOwnProperty.call(rules, 'revision');
  const expectedRevision = hasBodyRevision ? body.revision : (hasRulesRevision ? rules.revision : undefined);
  if (expectedRevision !== undefined) {
    const revisionError = validation.validateRulesRevision(expectedRevision);
    if (revisionError) {
      return res.status(400).json({
        success: false,
        code: revisionError.code,
        message: revisionError.message,
        field: revisionError.field
      });
    }
  }
  if (hasBodyRevision && hasRulesRevision && body.revision !== rules.revision) {
    return res.status(400).json({
      success: false,
      code: 'RULES_VALIDATION_ERROR',
      message: '请求revision与rules.revision不一致',
      field: 'revision'
    });
  }

  try {
    const savedRules = repositories.config.setRules(rules, { expectedRevision });
    return res.json({ success: true, revision: savedRules.revision, rules: savedRules });
  } catch (error) {
    if (error.code === 'RULES_REVISION_CONFLICT') {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: '规则已被其他管理员更新，请查看最新版本后重试',
        field: 'revision',
        revision: error.currentRevision,
        currentRevision: error.currentRevision,
        rules: error.currentRules
      });
    }
    if (error.code === 'RULES_VALIDATION_ERROR') {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
        field: error.field
      });
    }
    return res.status(503).json({ success: false, message: '保存失败' });
  }
});

router.post('/config/users', async (req, res) => {
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可管理用户' });
  const inputs = req.body.users;
  if (!Array.isArray(inputs) || inputs.length > 100) return res.status(400).json({ success: false, message: '用户列表格式无效' });

  const familyId = admin.familyId || 'default';
  const existing = new Map(repositories.users.listByFamily(familyId).map(user => [user.id, user]));
  const seen = new Set();
  const prepared = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || !/^[a-z0-9_]{2,20}$/.test(input.id || '') || seen.has(input.id)) {
      return res.status(400).json({ success: false, message: '用户ID无效或重复' });
    }
    const nameError = validation.text(input.name, { field: '用户姓名', min: 1, max: 30 });
    const roleError = validation.role(input.role);
    if (nameError || roleError) return res.status(400).json({ success: false, message: nameError || roleError });
    seen.add(input.id);
    const old = existing.get(input.id);
    let password = input.password || old?.password || '';
    if (password && !isHashed(password)) password = hashPwd(password);
    prepared.push({ ...input, name: input.name.trim(), password, familyId });
  }

  try {
    const savedUsers = repositories.users.replaceFamily(familyId, prepared, admin.id);
    res.json({ success: true, users: savedUsers.map(safeUser) });
  } catch (error) {
    const badRequest = ['不能删除当前管理员', '不能修改当前管理员角色', '用户ID已被其他家庭使用'].includes(error.message);
    res.status(badRequest ? 400 : 503).json({ success: false, message: badRequest ? error.message : '保存失败' });
  }
});

module.exports = router;
