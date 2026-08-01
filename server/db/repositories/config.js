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

class RulesVersionNotFoundError extends Error {
  constructor() {
    super('规则历史版本不存在');
    this.name = 'RulesVersionNotFoundError';
    this.code = 'RULES_VERSION_NOT_FOUND';
  }
}

class RulesFamilyNotFoundError extends Error {
  constructor(familyId) {
    super('家庭不存在');
    this.name = 'RulesFamilyNotFoundError';
    this.code = 'RULES_FAMILY_NOT_FOUND';
    this.familyId = familyId;
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

function rulesRow(db, familyId) {
  return db.prepare(`
    SELECT family_id, revision, data_json, updated_by, updated_at
    FROM rules
    WHERE family_id = ?
  `).get(familyId);
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

function familyKey(familyId) {
  return typeof familyId === 'string' && familyId ? familyId : 'default';
}

function rulesFromRow(row) {
  if (!row) return {};
  const parsed = parseRules(row.data_json);
  parsed.revision = Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
  return normalizedStoredRules(parsed);
}

// Historical snapshots are audit records. Return their stored values exactly;
// current-schema validation happens only when a snapshot is restored.
function rulesSnapshotFromRow(row) {
  if (!row) return {};
  const parsed = parseRules(row.data_json);
  parsed.revision = Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
  return parsed;
}

function identityNames(entity, nameField) {
  const names = [entity && entity[nameField], ...(Array.isArray(entity && entity.aliases) ? entity.aliases : [])];
  return names.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean);
}

function addHistoricalIdentity(map, id, names, type) {
  if (typeof id !== 'string' || !id) return;
  if (!map.has(id)) map.set(id, { names: new Set(), types: new Set() });
  const entry = map.get(id);
  names.forEach(name => entry.names.add(name));
  if (type) entry.types.add(type);
}

function collectHistoricalIdentities(db, familyId) {
  const categories = new Map();
  const rules = new Map();
  const snapshots = db.prepare('SELECT data_json FROM rule_versions WHERE family_id = ?').all(familyId);
  for (const row of snapshots) {
    const snapshot = parseRules(row.data_json);
    for (const type of ['reward', 'punish']) {
      for (const category of Array.isArray(snapshot[type]) ? snapshot[type] : []) {
        addHistoricalIdentity(categories, category && category.id, identityNames(category, 'category'), type);
        for (const item of Array.isArray(category && category.items) ? category.items : []) {
          addHistoricalIdentity(rules, item && item.id, identityNames(item, 'label'), type);
        }
      }
    }
  }
  for (const row of db.prepare(`
    SELECT rule_id, reason
    FROM transactions
    WHERE family_id = ? AND rule_id IS NOT NULL
  `).all(familyId)) {
    addHistoricalIdentity(rules, row.rule_id, [String(row.reason || '').trim()].filter(Boolean));
  }
  return { categories, rules };
}

function currentIdentityTypes(rules) {
  const categories = new Map();
  const items = new Map();
  for (const type of ['reward', 'punish']) {
    for (const category of Array.isArray(rules && rules[type]) ? rules[type] : []) {
      if (category && category.id) categories.set(category.id, type);
      for (const item of Array.isArray(category && category.items) ? category.items : []) {
        if (item && item.id) items.set(item.id, type);
      }
    }
  }
  return { categories, items };
}

function hasKnownMeaning(historyEntry, names, type) {
  if (!historyEntry) return true;
  if (historyEntry.types.size && !historyEntry.types.has(type)) return false;
  return names.some(name => historyEntry.names.has(name));
}

function assertStableIdsNotReused(db, familyId, nextRules, currentRules) {
  const history = collectHistoricalIdentities(db, familyId);
  const current = currentIdentityTypes(currentRules);
  for (const type of ['reward', 'punish']) {
    const categories = Array.isArray(nextRules[type]) ? nextRules[type] : [];
    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const category = categories[categoryIndex];
      const categoryId = category && category.id;
      if (history.rules.has(categoryId)) {
        throw new RulesValidationError({
          code: 'RULES_VALIDATION_ERROR',
          message: `分类 ID ${categoryId} 曾用于具体规则，不能复用`,
          field: `${type}[${categoryIndex}].id`
        });
      }
      if (!current.categories.has(categoryId) && !hasKnownMeaning(
        history.categories.get(categoryId), identityNames(category, 'category'), type
      )) {
        throw new RulesValidationError({
          code: 'RULES_VALIDATION_ERROR',
          message: `分类 ID ${categoryId} 已被历史版本保留，请使用新 ID`,
          field: `${type}[${categoryIndex}].id`
        });
      }
      if (current.categories.has(categoryId) && current.categories.get(categoryId) !== type) {
        throw new RulesValidationError({
          code: 'RULES_VALIDATION_ERROR',
          message: `分类 ID ${categoryId} 不能在鼓励与提醒之间改变用途`,
          field: `${type}[${categoryIndex}].id`
        });
      }

      const items = Array.isArray(category && category.items) ? category.items : [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        const ruleId = item && item.id;
        if (history.categories.has(ruleId)) {
          throw new RulesValidationError({
            code: 'RULES_VALIDATION_ERROR',
            message: `规则 ID ${ruleId} 曾用于分类，不能复用`,
            field: `${type}[${categoryIndex}].items[${itemIndex}].id`
          });
        }
        if (!current.items.has(ruleId) && !hasKnownMeaning(
          history.rules.get(ruleId), identityNames(item, 'label'), type
        )) {
          throw new RulesValidationError({
            code: 'RULES_VALIDATION_ERROR',
            message: `规则 ID ${ruleId} 已关联历史流水，请使用新 ID`,
            field: `${type}[${categoryIndex}].items[${itemIndex}].id`
          });
        }
        if (current.items.has(ruleId) && current.items.get(ruleId) !== type) {
          throw new RulesValidationError({
            code: 'RULES_VALIDATION_ERROR',
            message: `规则 ID ${ruleId} 不能在鼓励与提醒之间改变用途`,
            field: `${type}[${categoryIndex}].items[${itemIndex}].id`
          });
        }
      }
    }
  }
}

function insertVersion(db, familyId, rules, {
  createdBy = null,
  source = 'save',
  restoredFromVersionId = null,
  createdAt = new Date().toISOString()
} = {}) {
  const result = db.prepare(`
    INSERT INTO rule_versions(
      family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    familyId,
    rules.revision,
    JSON.stringify(rules),
    createdBy || null,
    createdAt,
    source,
    restoredFromVersionId || null
  );
  return Number(result.lastInsertRowid);
}

// A non-default family starts with its own empty rule set. The migrated default
// row may contain private family wording, so it must never be used as a template
// for another family. Administrators can then create or import rules explicitly.
function ensureFamilyRules(db, familyId) {
  const existing = rulesRow(db, familyId);
  if (existing) return existing;
  if (!db.prepare('SELECT 1 FROM families WHERE id = ?').get(familyId)) {
    throw new RulesFamilyNotFoundError(familyId);
  }
  if (familyId === 'default') return null;

  const initial = { reward: [], punish: [], special: [], revision: 0 };
  const createdAt = new Date().toISOString();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO rules(family_id, revision, data_json, updated_by, updated_at)
    VALUES (?, 0, ?, NULL, ?)
  `).run(familyId, JSON.stringify(initial), createdAt);
  if (inserted.changes > 0) {
    insertVersion(db, familyId, initial, { source: 'initialize', createdAt });
  }
  return rulesRow(db, familyId);
}

function getRules(familyId = 'default') {
  const targetFamilyId = familyKey(familyId);
  const current = rulesRow(getDb(), targetFamilyId);
  if (current) return rulesFromRow(current);
  return inTransaction(db => rulesFromRow(ensureFamilyRules(db, targetFamilyId)));
}

function resolveSetArguments(familyId, rules, options) {
  // Repository compatibility for v2.4 internal callers. HTTP callers never
  // choose this default: routes always pass the authenticated user's family ID.
  if (validation.isPlainObject(familyId)) {
    return { familyId: 'default', rules: familyId, options: rules || {} };
  }
  return { familyId: familyKey(familyId), rules, options: options || {} };
}

function writeRules(db, familyId, rules, {
  expectedRevision,
  updatedBy = null,
  source = 'save',
  restoredFromVersionId = null
} = {}) {
  const currentRow = ensureFamilyRules(db, familyId);
  const current = rulesFromRow(currentRow);
  const currentRevision = currentRow ? currentRow.revision : 0;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new RulesRevisionConflictError(current);
  }

  const normalized = normalizeRules(rules, current);
  normalized.revision = currentRevision + 1;
  const error = validation.validateRules(normalized);
  if (error) throw new RulesValidationError(error);
  assertStableIdsNotReused(db, familyId, normalized, current);

  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO rules(family_id, revision, data_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET
      revision = excluded.revision,
      data_json = excluded.data_json,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(familyId, normalized.revision, JSON.stringify(normalized), updatedBy || null, updatedAt);
  const versionId = insertVersion(db, familyId, normalized, {
    createdBy: updatedBy,
    source,
    restoredFromVersionId,
    createdAt: updatedAt
  });
  return { rules: normalized, versionId, updatedAt };
}

function setRules(familyId, rules, options) {
  const args = resolveSetArguments(familyId, rules, options);
  return inTransaction(db => writeRules(db, args.familyId, args.rules, args.options).rules);
}

function rulesCount(rules) {
  const rewardCount = (Array.isArray(rules.reward) ? rules.reward : [])
    .reduce((total, category) => total + (Array.isArray(category && category.items) ? category.items.length : 0), 0);
  const punishCount = (Array.isArray(rules.punish) ? rules.punish : [])
    .reduce((total, category) => total + (Array.isArray(category && category.items) ? category.items.length : 0), 0);
  const specialCount = Array.isArray(rules.special) ? rules.special.length : 0;
  return { rewardCount, punishCount, specialCount };
}

function versionSummary(row) {
  const rules = rulesSnapshotFromRow(row);
  return {
    versionId: Number(row.version_id),
    revision: row.revision,
    createdAt: row.created_at,
    createdBy: row.created_by || null,
    source: row.source,
    restoredFromVersionId: row.restored_from_version_id === null ? null : Number(row.restored_from_version_id),
    ...rulesCount(rules)
  };
}

function listRuleVersions(familyId = 'default', { limit = 50, offset = 0 } = {}) {
  const targetFamilyId = familyKey(familyId);
  // Materialize once so a newly-created family has an explicit, isolated
  // revision-zero baseline before its history is requested.
  getRules(targetFamilyId);
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
  const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
  return getDb().prepare(`
    SELECT version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
    FROM rule_versions
    WHERE family_id = ?
    ORDER BY revision DESC, version_id DESC
    LIMIT ? OFFSET ?
  `).all(targetFamilyId, safeLimit, safeOffset).map(versionSummary);
}

function getRuleVersion(familyId = 'default', versionId) {
  const targetFamilyId = familyKey(familyId);
  const row = getDb().prepare(`
    SELECT version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
    FROM rule_versions
    WHERE family_id = ? AND version_id = ?
  `).get(targetFamilyId, versionId);
  if (!row) return null;
  return { ...versionSummary(row), rules: rulesSnapshotFromRow(row) };
}

function restoreRuleVersion(familyId = 'default', versionId, {
  expectedRevision,
  updatedBy = null
} = {}) {
  const targetFamilyId = familyKey(familyId);
  return inTransaction(db => {
    const snapshot = db.prepare(`
      SELECT version_id, revision, data_json
      FROM rule_versions
      WHERE family_id = ? AND version_id = ?
    `).get(targetFamilyId, versionId);
    if (!snapshot) throw new RulesVersionNotFoundError();
    const restored = rulesSnapshotFromRow(snapshot);
    const written = writeRules(db, targetFamilyId, restored, {
      expectedRevision,
      updatedBy,
      source: 'restore',
      restoredFromVersionId: Number(snapshot.version_id)
    });
    const version = db.prepare(`
      SELECT version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
      FROM rule_versions
      WHERE version_id = ?
    `).get(written.versionId);
    return { rules: written.rules, version: versionSummary(version) };
  });
}

function getConfig(familyId = 'default') {
  const targetFamilyId = familyKey(familyId);
  return {
    rules: getRules(targetFamilyId),
    users: users.listByFamily(targetFamilyId),
    families: { [targetFamilyId]: families.findById(targetFamilyId) }
  };
}

module.exports = {
  RulesRevisionConflictError,
  RulesValidationError,
  RulesVersionNotFoundError,
  RulesFamilyNotFoundError,
  getRules,
  setRules,
  listRuleVersions,
  getRuleVersion,
  restoreRuleVersion,
  getConfig,
  normalizeRules
};
