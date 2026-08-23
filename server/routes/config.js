const express = require('express');
const router = express.Router();
const repositories = require('../db/repositories');
const validation = require('../lib/validation');
const { verifyToken, requireRole, getToken, hashPwd, isHashed } = require('../lib/token');
const features = require('../config/features');

function safeUser(user) {
  return { id: user.id, name: user.name, role: user.role, familyId: user.familyId || 'default' };
}

router.get('/config', (req, res) => {
  const user = verifyToken(getToken(req));
  if (!user) {
    return res.json({ success: true, public: true, users: [] });
  }
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
  const visibleUsers = user.role === 'child'
    ? [safeUser(user)]
    : repositories.users.listByFamily(familyId)
      .filter(candidate => candidate.role !== 'child' || authorizedChildIds.has(candidate.id))
      .map(safeUser);
  const visibleFamily = user.role === 'child'
    ? { id: family.id, name: family.name, createdAt: family.createdAt }
    : family;
  return res.json({
    success: true,
    rules: repositories.config.getRules(familyId),
    families: { [familyId]: visibleFamily },
    users: visibleUsers
  });
});

router.post('/config/rules', async (req, res) => {
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可修改规则' });
  const familyId = admin.familyId || 'default';
  if (!repositories.families.findById(familyId)) {
    return res.status(404).json({ success: false, message: '家庭不存在' });
  }
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
    // familyId in the request body is intentionally ignored. The current user
    // record resolved from the Token is the only authority for rule ownership.
    const savedRules = repositories.config.setRules(familyId, rules, {
      expectedRevision,
      updatedBy: admin.id
    });
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

function parseVersionId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function historyAdmin(req, res) {
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) {
    res.status(403).json({ success: false, message: '仅管理员可查看或恢复规则历史' });
    return null;
  }
  return admin;
}

router.get('/config/rules/history', (req, res) => {
  const admin = historyAdmin(req, res);
  if (!admin) return;
  const familyId = admin.familyId || 'default';
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    return res.status(400).json({ success: false, message: '分页参数无效' });
  }
  try {
    const history = repositories.config.listRuleVersions(familyId, { limit, offset });
    const currentRevision = repositories.config.getRules(familyId).revision || 0;
    return res.json({ success: true, currentRevision, history, versions: history });
  } catch (error) {
    if (error.code === 'RULES_FAMILY_NOT_FOUND') {
      return res.status(404).json({ success: false, message: '家庭不存在' });
    }
    return res.status(503).json({ success: false, message: '读取规则历史失败' });
  }
});

router.get('/config/rules/history/:versionId', (req, res) => {
  const admin = historyAdmin(req, res);
  if (!admin) return;
  const versionId = parseVersionId(req.params.versionId);
  if (!versionId) return res.status(400).json({ success: false, message: '版本ID无效' });
  const version = repositories.config.getRuleVersion(admin.familyId || 'default', versionId);
  if (!version) {
    // A version from another family is deliberately indistinguishable from a
    // missing version, preventing cross-family history enumeration.
    return res.status(404).json({ success: false, code: 'RULES_VERSION_NOT_FOUND', message: '规则历史版本不存在' });
  }
  return res.json({ success: true, version });
});

router.post('/config/rules/history/:versionId/restore', (req, res) => {
  const admin = historyAdmin(req, res);
  if (!admin) return;
  const versionId = parseVersionId(req.params.versionId);
  if (!versionId) return res.status(400).json({ success: false, message: '版本ID无效' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Object.prototype.hasOwnProperty.call(body, 'revision')) {
    return res.status(400).json({
      success: false,
      code: 'RULES_REVISION_REQUIRED',
      message: '恢复历史版本必须携带当前 revision',
      field: 'revision'
    });
  }
  const expectedRevision = body.revision;
  const revisionError = validation.validateRulesRevision(expectedRevision);
  if (revisionError) {
    return res.status(400).json({
      success: false,
      code: revisionError.code,
      message: revisionError.message,
      field: revisionError.field
    });
  }

  try {
    const restored = repositories.config.restoreRuleVersion(admin.familyId || 'default', versionId, {
      expectedRevision,
      updatedBy: admin.id
    });
    return res.json({
      success: true,
      revision: restored.rules.revision,
      rules: restored.rules,
      version: restored.version
    });
  } catch (error) {
    if (error.code === 'RULES_VERSION_NOT_FOUND') {
      return res.status(404).json({ success: false, code: error.code, message: error.message });
    }
    if (error.code === 'RULES_REVISION_CONFLICT') {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: '规则已被其他管理员更新，请刷新历史后重试',
        field: 'revision',
        revision: error.currentRevision,
        currentRevision: error.currentRevision,
        rules: error.currentRules
      });
    }
    if (error.code === 'RULES_VALIDATION_ERROR') {
      return res.status(400).json({ success: false, code: error.code, message: error.message, field: error.field });
    }
    return res.status(503).json({ success: false, message: '恢复规则历史失败' });
  }
});

router.post('/config/users', async (req, res) => {
  const admin = requireRole(getToken(req), ['admin']);
  if (!admin) return res.status(403).json({ success: false, message: '仅管理员可管理用户' });
  const inputs = req.body && req.body.users;
  if (!Array.isArray(inputs) || inputs.length > 100) return res.status(400).json({ success: false, message: '用户列表格式无效' });

  const familyId = admin.familyId || 'default';
  const existing = new Map(repositories.users.listByFamily(familyId).map(user => [user.id, user]));
  const legacyChildManagementEnabled = features.isLegacyChildManagementEnabled();
  const seen = new Set();
  const prepared = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || !/^[a-z0-9_]{2,20}$/.test(input.id || '') || seen.has(input.id)) {
      return res.status(400).json({ success: false, message: '用户ID无效或重复' });
    }
    const old = existing.get(input.id);
    seen.add(input.id);
    if (!legacyChildManagementEnabled && old && old.role === 'child') {
      // A stale client may still submit a child it saw before consent was
      // withdrawn. Preserve an unchanged record, but reject any attempted
      // mutation of the protected child.
      const changesProtectedChild = input.role !== old.role
        || input.name !== old.name
        || (Boolean(input.password) && input.password !== old.password);
      if (changesProtectedChild) {
        return res.status(403).json({
          success: false,
          code: 'FEATURE_DISABLED',
          message: '旧版儿童账号管理已停用，请使用监护人授权建档流程'
        });
      }
      continue;
    }
    const nameError = validation.text(input.name, { field: '用户姓名', min: 1, max: 30 });
    const roleError = validation.role(input.role);
    if (nameError || roleError) return res.status(400).json({ success: false, message: nameError || roleError });
    const changesChildCredentials = input.role === 'child' && (!old || old.role !== 'child' || Boolean(input.password));
    if (changesChildCredentials && legacyChildManagementEnabled) {
      const passwordError = validation.text(input.password, { field: '孩子密码', min: 8, max: 128 });
      if (passwordError || isHashed(input.password)) {
        return res.status(400).json({ success: false, message: passwordError || '孩子密码必须以明文提交后由服务端安全哈希' });
      }
    }
    let password = input.password || old?.password || '';
    if (password && !isHashed(password)) password = hashPwd(password);
    prepared.push({ id: input.id, name: input.name.trim(), role: input.role, password, familyId });
  }
  if (!legacyChildManagementEnabled) {
    for (const old of existing.values()) {
      if (old.role === 'child') {
        prepared.push({
          id: old.id,
          name: old.name,
          role: old.role,
          password: old.password,
          familyId
        });
      }
    }
  }

  try {
    const savedUsers = repositories.users.replaceFamily(familyId, prepared, admin.id);
    const authorizedChildIds = new Set(repositories.guardianConsents.listActiveGuardianChildIds({
      familyId,
      guardianId: admin.id
    }));
    res.json({
      success: true,
      users: savedUsers
        .filter(user => user.role !== 'child' || authorizedChildIds.has(user.id))
        .map(safeUser)
    });
  } catch (error) {
    if (error.code === 'FEATURE_DISABLED') {
      return res.status(403).json({ success: false, code: error.code, message: error.message });
    }
    const badRequest = ['不能删除当前管理员', '不能修改当前管理员角色', '用户ID已被其他家庭使用'].includes(error.message);
    res.status(badRequest ? 400 : 503).json({ success: false, message: badRequest ? error.message : '保存失败' });
  }
});

module.exports = router;
