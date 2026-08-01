const ROLES = new Set(['admin', 'parent', 'child']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const RULE_LIMITS = Object.freeze({
  categoriesPerType: 30,
  itemsPerCategory: 100,
  itemsPerType: 500,
  special: 100,
  category: 30,
  label: 50,
  unit: 20,
  hint: 200,
  specialText: 300,
  aliases: 20
});

function text(value, { field, min = 0, max }) {
  if (typeof value !== 'string') return `${field}格式无效`;
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) return `${field}长度必须为${min}-${max}个字符`;
  return null;
}

function role(value) {
  return ROLES.has(value) ? null : '角色无效';
}

function amount(value) {
  if (value === '' || value === null || value === undefined) return { error: '无效的分数' };
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number === 0 || Math.abs(number) > 1000) {
    return { error: '分数必须是绝对值不超过1000的非零整数' };
  }
  return { value: number };
}

function validDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateRange(afterDate, beforeDate) {
  if (afterDate && !validDate(afterDate)) return '开始日期格式必须为 YYYY-MM-DD';
  if (beforeDate && !validDate(beforeDate)) return '结束日期格式必须为 YYYY-MM-DD';
  if (afterDate && beforeDate && afterDate > beforeDate) return '开始日期不能晚于结束日期';
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rulesError(field, message) {
  return { field, message, code: 'RULES_VALIDATION_ERROR' };
}

function validateRuleText(value, field, min, max) {
  if (typeof value !== 'string') return rulesError(field, `${field}必须是字符串`);
  const length = value.trim().length;
  if (length < min || length > max) {
    return rulesError(field, `${field}长度必须为${min}-${max}个字符`);
  }
  return null;
}

function validateAliases(value, field, maxTextLength) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return rulesError(field, `${field}必须是数组`);
  if (value.length > RULE_LIMITS.aliases) {
    return rulesError(field, `${field}最多包含${RULE_LIMITS.aliases}项`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const error = validateRuleText(value[index], `${field}[${index}]`, 1, maxTextLength);
    if (error) return error;
  }
  return null;
}

function validateRuleNumber(value, field) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return rulesError(field, `${field}必须是有限整数`);
  }
  return null;
}

function validateRules(rules) {
  if (!isPlainObject(rules)) return rulesError('rules', 'rules必须是对象');

  if (rules.revision !== undefined) {
    if (!Number.isSafeInteger(rules.revision) || rules.revision < 0) {
      return rulesError('revision', 'revision必须是非负安全整数');
    }
  }
  if (rules.hint !== undefined) {
    const hintError = validateRuleText(rules.hint, 'hint', 0, RULE_LIMITS.hint);
    if (hintError) return hintError;
  }

  const seenIds = new Set();
  for (const type of ['reward', 'punish']) {
    const categories = rules[type];
    if (!Array.isArray(categories)) return rulesError(type, `${type}必须是数组`);
    if (categories.length > RULE_LIMITS.categoriesPerType) {
      return rulesError(type, `${type}最多包含${RULE_LIMITS.categoriesPerType}个分类`);
    }

    let itemCount = 0;
    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const categoryPath = `${type}[${categoryIndex}]`;
      const category = categories[categoryIndex];
      if (!isPlainObject(category)) return rulesError(categoryPath, `${categoryPath}必须是对象`);

      let error = validateRuleText(category.category, `${categoryPath}.category`, 1, RULE_LIMITS.category);
      if (error) return error;
      if (category.hint !== undefined) {
        error = validateRuleText(category.hint, `${categoryPath}.hint`, 0, RULE_LIMITS.hint);
        if (error) return error;
      }

      if (category.id !== undefined) {
        if (typeof category.id !== 'string' || !RULE_ID.test(category.id)) {
          return rulesError(`${categoryPath}.id`, `${categoryPath}.id格式无效`);
        }
        if (seenIds.has(category.id)) return rulesError(`${categoryPath}.id`, `${categoryPath}.id不能重复`);
        seenIds.add(category.id);
      }

      error = validateAliases(category.aliases, `${categoryPath}.aliases`, RULE_LIMITS.category);
      if (error) return error;

      if (!Array.isArray(category.items)) return rulesError(`${categoryPath}.items`, `${categoryPath}.items必须是数组`);
      if (category.items.length > RULE_LIMITS.itemsPerCategory) {
        return rulesError(`${categoryPath}.items`, `${categoryPath}.items最多包含${RULE_LIMITS.itemsPerCategory}项`);
      }
      itemCount += category.items.length;
      if (itemCount > RULE_LIMITS.itemsPerType) {
        return rulesError(type, `${type}最多包含${RULE_LIMITS.itemsPerType}条规则`);
      }

      for (let itemIndex = 0; itemIndex < category.items.length; itemIndex += 1) {
        const itemPath = `${categoryPath}.items[${itemIndex}]`;
        const item = category.items[itemIndex];
        if (!isPlainObject(item)) return rulesError(itemPath, `${itemPath}必须是对象`);

        if (typeof item.id !== 'string' || !RULE_ID.test(item.id)) {
          return rulesError(`${itemPath}.id`, `${itemPath}.id格式无效`);
        }
        if (seenIds.has(item.id)) return rulesError(`${itemPath}.id`, `${itemPath}.id不能重复`);
        seenIds.add(item.id);

        error = validateRuleText(item.label, `${itemPath}.label`, 1, RULE_LIMITS.label);
        if (error) return error;
        error = validateRuleText(item.unit, `${itemPath}.unit`, 0, RULE_LIMITS.unit);
        if (error) return error;
        if (item.hint !== undefined) {
          error = validateRuleText(item.hint, `${itemPath}.hint`, 0, RULE_LIMITS.hint);
          if (error) return error;
        }
        error = validateAliases(item.aliases, `${itemPath}.aliases`, RULE_LIMITS.label);
        if (error) return error;

        for (const key of ['min', 'default', 'max']) {
          error = validateRuleNumber(item[key], `${itemPath}.${key}`);
          if (error) return error;
        }
        const lowerBound = type === 'reward' ? 0 : -500;
        const upperBound = type === 'reward' ? 1000 : -1;
        for (const key of ['min', 'default', 'max']) {
          if (item[key] < lowerBound || item[key] > upperBound) {
            const description = type === 'reward' ? '加分规则必须在0-1000分范围内' : '扣分规则必须在-500到-1分范围内';
            return rulesError(`${itemPath}.${key}`, description);
          }
        }
        if (item.min > item.default) {
          return rulesError(`${itemPath}.default`, `${itemPath}.default不能小于min`);
        }
        if (item.default > item.max) {
          return rulesError(`${itemPath}.default`, `${itemPath}.default不能大于max`);
        }
      }
    }
  }

  if (!Array.isArray(rules.special)) return rulesError('special', 'special必须是数组');
  if (rules.special.length > RULE_LIMITS.special) {
    return rulesError('special', `special最多包含${RULE_LIMITS.special}项`);
  }
  for (let index = 0; index < rules.special.length; index += 1) {
    const error = validateRuleText(rules.special[index], `special[${index}]`, 1, RULE_LIMITS.specialText);
    if (error) return error;
  }
  return null;
}

function validateRulesRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return rulesError('revision', 'revision必须是非负安全整数');
  }
  return null;
}

module.exports = {
  ROLES,
  RULE_ID,
  RULE_LIMITS,
  text,
  role,
  amount,
  validDate,
  dateRange,
  isPlainObject,
  rulesError,
  validateRules,
  validateRulesRevision
};
