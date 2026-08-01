const express = require('express');
const router = express.Router();
const repositories = require('../db/repositories');
const validation = require('../lib/validation');
const logger = require('../lib/logger');
const { verifyToken, requireRole, getToken } = require('../lib/token');

class RuleReferenceError extends Error {
  constructor(code, message, field) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

function hasReference(value) {
  return value !== undefined && value !== null && value !== '';
}

function resolveRuleReference(rules, ruleId, categoryId, amount) {
  const hasRuleId = hasReference(ruleId);
  const hasCategoryId = hasReference(categoryId);
  if (!hasRuleId) {
    if (hasCategoryId) {
      throw new RuleReferenceError('RULE_REFERENCE_INVALID', '分类 ID 不能脱离规则 ID 单独使用', 'categoryId');
    }
    return null;
  }
  if (typeof ruleId !== 'string') {
    throw new RuleReferenceError('RULE_REFERENCE_INVALID', '规则 ID 格式不正确', 'ruleId');
  }
  if (hasCategoryId && typeof categoryId !== 'string') {
    throw new RuleReferenceError('RULE_REFERENCE_INVALID', '分类 ID 格式不正确', 'categoryId');
  }

  let match = null;
  for (const type of ['reward', 'punish']) {
    for (const category of Array.isArray(rules && rules[type]) ? rules[type] : []) {
      const item = (Array.isArray(category && category.items) ? category.items : [])
        .find(candidate => candidate && candidate.id === ruleId);
      if (item) {
        match = { category, item };
        break;
      }
    }
    if (match) break;
  }
  if (!match) {
    throw new RuleReferenceError('RULE_REFERENCE_INVALID', '规则不存在或不属于当前家庭', 'ruleId');
  }
  if (hasCategoryId && match.category.id !== categoryId) {
    throw new RuleReferenceError('RULE_REFERENCE_INVALID', '规则与分类不匹配', 'categoryId');
  }
  if (typeof match.category.id !== 'string' || !match.category.id) {
    throw new RuleReferenceError('RULE_REFERENCE_INVALID', '规则分类缺少稳定 ID，请先保存规则配置', 'categoryId');
  }
  if (amount < match.item.min || amount > match.item.max) {
    throw new RuleReferenceError(
      'RULE_AMOUNT_OUT_OF_RANGE',
      `分数必须在规则范围 ${match.item.min}~${match.item.max} 内`,
      'amount'
    );
  }
  return {
    ruleId: match.item.id,
    categoryId: match.category.id,
    reason: match.item.label
  };
}

router.get('/points', (req, res) => {
  const user = verifyToken(getToken(req));
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  const familyId = user.familyId || 'default';
  const family = repositories.families.findById(familyId);
  res.json({
    success: true,
    points: repositories.points.getFamilyPoints(familyId),
    rules: repositories.config.getRules(familyId),
    family: family ? { id: family.id, name: family.name } : null,
    user: { id: user.id, name: user.name, role: user.role, familyId }
  });
});

router.post('/points/change', async (req, res) => {
  const { kid, amount, reason, note, ruleId, categoryId } = req.body;
  const user = requireRole(getToken(req), ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '无操作权限' });
  const familyId = user.familyId || 'default';
  const child = repositories.users.findById(kid);
  if (!child || child.role !== 'child' || child.familyId !== familyId) return res.status(400).json({ success: false, message: '无效的孩子' });
  const parsedAmount = validation.amount(amount);
  if (parsedAmount.error) return res.status(400).json({ success: false, message: parsedAmount.error });
  const amountNum = parsedAmount.value;
  let ruleReference;
  try {
    ruleReference = resolveRuleReference(
      repositories.config.getRules(familyId),
      ruleId,
      categoryId,
      amountNum
    );
  } catch (error) {
    if (error instanceof RuleReferenceError) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
        field: error.field
      });
    }
    (req.log || logger).error({ err: error, familyId }, 'failed to resolve rule reference');
    return res.status(503).json({ success: false, message: '规则校验失败，请稍后重试' });
  }
  if (!ruleReference && reason !== undefined && reason !== null && reason !== '') {
    const reasonError = validation.text(reason, { field: '原因', min: 1, max: 100 });
    if (reasonError) return res.status(400).json({ success: false, message: reasonError });
  }
  if (note !== undefined && note !== null) {
    const noteError = validation.text(note, { field: '备注', min: 0, max: 500 });
    if (noteError) return res.status(400).json({ success: false, message: noteError });
  }
  try {
    const result = repositories.points.changePoints({
      familyId, kid, kidName: child.name, amount: amountNum,
      reason: ruleReference
        ? ruleReference.reason
        : (typeof reason === 'string' && reason.trim() ? reason.trim() : (amountNum > 0 ? '手动加分' : '手动减分')),
      operator: user.name,
      note: note || '',
      ruleId: ruleReference && ruleReference.ruleId,
      categoryId: ruleReference && ruleReference.categoryId
    });
    (req.log || logger).info({
      event: 'audit.points.changed',
      operatorId: user.id,
      familyId,
      targetKidId: kid,
      amount: amountNum,
      beforeBalance: result.beforeBalance,
      afterBalance: result.afterBalance,
      transactionId: result.record.id,
      ruleId: result.record.ruleId,
      categoryId: result.record.categoryId
    }, 'points changed');
    const { beforeBalance, afterBalance, ...response } = result;
    res.json({ success: true, ...response });
  } catch (e) {
    res.status(503).json({ success: false, message: e.message || '操作失败，请稍后重试' });
  }
});

module.exports = router;
