const crypto = require('crypto');
const { getDb, inTransaction } = require('../connection');
const validation = require('../../lib/validation');
const users = require('./users');
const families = require('./families');

class RulesRevisionConflictError extends Error {
  constructor(currentRules) {
    super('规则已被其他管理员更新');
    this.name = 'RulesRevisionConflictError';
    this.code = 'RULES_REVISION_CONFLICT';
    this.currentRules = currentRules;
    this.currentRevision = currentRules.revision || 0;
  }
}

class RulesValidationError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = 'RulesValidationError';
    this.code = detail.code;
    this.field = detail.field;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseRules(value) {
  try {
    const parsed = JSON.parse(value);
    return validation.isPlainObject(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function readRules(db) {
  const row = db.prepare('SELECT data_json FROM rules WHERE id = 1').get();
  return row ? parseRules(row.data_json) : {};
}

function normalizeAliases(aliases, extraAlias, currentName, maxLength) {
  const values = [];
  if (extraAlias) values.push(extraAlias);
  if (Array.isArray(aliases)) values.push(...aliases);
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const alias = value.trim();
    if (!alias || alias === currentName || alias.length > maxLength || seen.has(alias)) continue;
    seen.add(alias);
    normalized.push(alias);
    if (normalized.length >= validation.RULE_LIMITS.aliases) break;
  }
  return normalized;
}

function categoryCandidate(category, currentCategories) {
  if (!Array.isArray(currentCategories)) return null;
  if (category.id) {
    const byId = currentCategories.find(current => current && current.id === category.id);
    if (byId) return byId;
  }
  const names = new Set([category.category, ...(Array.isArray(category.aliases) ? category.aliases : [])]);
  const byName = currentCategories.find(current => current && (
    names.has(current.category) ||
    (Array.isArray(current.aliases) && current.aliases.some(alias => names.has(alias)))
  ));
  if (byName) return byName;

  const itemIds = new Set(Array.isArray(category.items) ? category.items.map(item => item && item.id).filter(Boolean) : []);
  let best = null;
  let bestScore = 0;
  for (const current of currentCategories) {
    const score = Array.isArray(current && current.items)
      ? current.items.reduce((count, item) => count + (itemIds.has(item && item.id) ? 1 : 0), 0)
      : 0;
    if (score > bestScore) {
      best = current;
      bestScore = score;
    }
  }
  return best;
}

function generatedCategoryId(type, categoryName, usedIds) {
  const digest = crypto.createHash('sha256').update(`${type}:${categoryName.trim()}`).digest('hex').slice(0, 12);
  const base = `cat_${type}_${digest}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeRules(rules, currentRules = {}) {
  const normalized = cloneJson(rules);
  const current = validation.isPlainObject(currentRules) ? currentRules : {};
  normalized.revision = Number.isSafeInteger(normalized.revision) && normalized.revision >= 0
    ? normalized.revision
    : 0;

  const currentItems = new Map();
  for (const type of ['reward', 'punish']) {
    for (const category of Array.isArray(current[type]) ? current[type] : []) {
      for (const item of Array.isArray(category && category.items) ? category.items : []) {
        if (item && typeof item.id === 'string') currentItems.set(item.id, item);
      }
    }
  }

  const usedIds = new Set();
  for (const type of ['reward', 'punish']) {
    for (const category of Array.isArray(normalized[type]) ? normalized[type] : []) {
      for (const item of Array.isArray(category && category.items) ? category.items : []) {
        if (item && typeof item.id === 'string') usedIds.add(item.id);
      }
      if (category && typeof category.id === 'string') usedIds.add(category.id);
    }
  }

  for (const type of ['reward', 'punish']) {
    const categories = Array.isArray(normalized[type]) ? normalized[type] : [];
    const currentCategories = Array.isArray(current[type]) ? current[type] : [];
    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const category = categories[categoryIndex];
      const previousCategory = categoryCandidate(category, currentCategories);
      if (!category.id) {
        const previousId = previousCategory && typeof previousCategory.id === 'string' && validation.RULE_ID.test(previousCategory.id)
          ? previousCategory.id
          : null;
        if (previousId && !usedIds.has(previousId)) {
          category.id = previousId;
          usedIds.add(previousId);
        } else {
          category.id = generatedCategoryId(type, category.category, usedIds);
          usedIds.add(category.id);
        }
      }
      category.aliases = normalizeAliases(
        [...(Array.isArray(category.aliases) ? category.aliases : []), ...(Array.isArray(previousCategory && previousCategory.aliases) ? previousCategory.aliases : [])],
        previousCategory && previousCategory.category !== category.category ? previousCategory.category : '',
        category.category,
        validation.RULE_LIMITS.category
      );

      for (const item of category.items) {
        const previousItem = currentItems.get(item.id);
        item.aliases = normalizeAliases(
          [...(Array.isArray(item.aliases) ? item.aliases : []), ...(Array.isArray(previousItem && previousItem.aliases) ? previousItem.aliases : [])],
          previousItem && previousItem.label !== item.label ? previousItem.label : '',
          item.label,
          validation.RULE_LIMITS.label
        );
      }
    }
  }
  return normalized;
}

function normalizedStoredRules(rawRules) {
  if (!validation.isPlainObject(rawRules) || Object.keys(rawRules).length === 0) return {};
  const normalized = normalizeRules(rawRules, rawRules);
  // 历史版本允许扣分下限到 -999；读取时收敛到当前 -500 规范，
  // 让旧数据可继续编辑，同时不放宽保存接口对新输入的严格校验。
  for (const category of Array.isArray(normalized.punish) ? normalized.punish : []) {
    for (const item of Array.isArray(category && category.items) ? category.items : []) {
      for (const key of ['min', 'default', 'max']) {
        if (Number.isSafeInteger(item[key]) && item[key] < -500) item[key] = -500;
      }
    }
  }
  return normalized;
}

function getRules() {
  return normalizedStoredRules(readRules(getDb()));
}

function setRules(rules, { expectedRevision } = {}) {
  return inTransaction(db => {
    const current = normalizedStoredRules(readRules(db));
    const currentRevision = Number.isSafeInteger(current.revision) ? current.revision : 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new RulesRevisionConflictError(current);
    }

    const normalized = normalizeRules(rules, current);
    normalized.revision = currentRevision + 1;
    const error = validation.validateRules(normalized);
    if (error) throw new RulesValidationError(error);

    db.prepare(`
      INSERT INTO rules(id, data_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
    `).run(JSON.stringify(normalized));
    return normalized;
  });
}

function getConfig() {
  return { rules: getRules(), users: users.listAll(), families: families.asObject() };
}

module.exports = {
  RulesRevisionConflictError,
  RulesValidationError,
  getRules,
  setRules,
  getConfig,
  normalizeRules
};
