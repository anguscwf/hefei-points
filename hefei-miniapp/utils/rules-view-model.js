// 规则展示公共适配：仅生成前端派生数据，不改变 API 的 reward/punish/special 结构。

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cloneRules(rules) {
  var source = rules && typeof rules === 'object' && !Array.isArray(rules) ? deepClone(rules) : {};
  if (!Array.isArray(source.reward)) source.reward = [];
  if (!Array.isArray(source.punish)) source.punish = [];
  if (!Array.isArray(source.special)) source.special = [];
  return source;
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  var number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signedNumber(value) {
  var number = finiteNumber(value);
  if (number === null) return '';
  if (number < 0) return '−' + Math.abs(number);
  return '+' + number;
}

function stableId(value) {
  return String(value || '').trim();
}

function ruleNames(item) {
  var source = item && typeof item === 'object' ? item : {};
  var seen = Object.create(null);
  return [source.label].concat(Array.isArray(source.aliases) ? source.aliases : []).map(function(name) {
    return String(name || '').trim();
  }).filter(function(name) {
    if (!name || seen[name]) return false;
    seen[name] = true;
    return true;
  });
}

function formatRuleItem(item, type, isChild) {
  var source = item && typeof item === 'object' ? item : {};
  var aliases = Array.isArray(source.aliases) ? source.aliases.map(function(alias) {
    return String(alias || '').trim();
  }).filter(Boolean) : [];
  var min = finiteNumber(source.min);
  var max = finiteNumber(source.max);
  var defaultValue = finiteNumber(source.default);
  if (type === 'punish') {
    if (min !== null && min < -500) min = -500;
    if (max !== null && max < -500) max = -500;
    if (defaultValue !== null && defaultValue < -500) defaultValue = -500;
  }
  var validRange = min !== null && max !== null && min <= max;
  var defaultText = defaultValue === null ? '分值待设置' : (isChild ? '通常 ' : '通常 ') + signedNumber(defaultValue);
  var rangeText = '范围待设置';
  if (validRange) {
    rangeText = min === max ? signedNumber(min) : signedNumber(min) + '～' + signedNumber(max);
  }
  return {
    id: source.id || '',
    label: String(source.label || '未命名规则'),
    min: min,
    max: max,
    defaultValue: defaultValue,
    defaultText: defaultText,
    rangeText: rangeText,
    rangeDisplay: validRange ? '可调 ' + rangeText : rangeText,
    unit: String(source.unit || ''),
    hint: String(source.hint || ''),
    aliases: aliases,
    type: type,
    isReward: type === 'reward',
    raw: source
  };
}

function summarizeRules(rules) {
  var safe = cloneRules(rules);
  var rewardCount = safe.reward.reduce(function(total, category) {
    return total + (Array.isArray(category.items) ? category.items.length : 0);
  }, 0);
  var punishCount = safe.punish.reduce(function(total, category) {
    return total + (Array.isArray(category.items) ? category.items.length : 0);
  }, 0);
  var specialCount = safe.special.filter(function(text) {
    return typeof text === 'string' && text.trim();
  }).length;
  return {
    categoryCount: safe.reward.length + safe.punish.length,
    ruleCount: rewardCount + punishCount,
    rewardCount: rewardCount,
    punishCount: punishCount,
    specialCount: specialCount,
    isEmpty: rewardCount + punishCount + specialCount === 0
  };
}

function categoryMatches(category, query) {
  if (!query) return false;
  var source = category && typeof category === 'object' ? category : {};
  return [source.category].concat(Array.isArray(source.aliases) ? source.aliases : []).some(function(value) {
    return String(value || '').toLowerCase().indexOf(query) >= 0;
  });
}

function itemMatches(item, query) {
  if (!query) return true;
  return [item.label, item.unit, item.hint].concat(item.aliases || []).some(function(value) {
    return String(value || '').toLowerCase().indexOf(query) >= 0;
  });
}

function buildBrowserData(rules, options) {
  var safe = cloneRules(rules);
  var opts = options || {};
  var filter = opts.filter || 'all';
  var query = String(opts.query || '').trim().toLowerCase();
  var isChild = !!opts.isChild;
  var categories = [];

  ['reward', 'punish'].forEach(function(type) {
    if (filter !== 'all' && filter !== type) return;
    safe[type].forEach(function(category, categoryIndex) {
      var categoryId = String((category && category.id) || '').trim();
      var rawItems = Array.isArray(category.items) ? category.items : [];
      var categoryMatched = categoryMatches(category, query);
      var items = rawItems.map(function(item, itemIndex) {
        var view = formatRuleItem(item, type, isChild);
        view.categoryIndex = categoryIndex;
        view.itemIndex = itemIndex;
        view.category = String(category.category || '未命名分类');
        view.categoryId = categoryId;
        return view;
      }).filter(function(item) {
        return !query || categoryMatched || itemMatches(item, query);
      });
      if (query && !categoryMatched && !items.length) return;
      categories.push({
        key: type + '-' + (categoryId || categoryIndex),
        id: categoryId,
        type: type,
        isReward: type === 'reward',
        categoryIndex: categoryIndex,
        category: String(category.category || '未命名分类'),
        count: items.length,
        totalCount: rawItems.length,
        preview: rawItems.slice(0, 3).map(function(item) { return item.label; }).filter(Boolean).join('、'),
        items: items
      });
    });
  });

  var specials = [];
  if (filter === 'all' || filter === 'special') {
    specials = safe.special.map(function(text, index) {
      return { key: 'special-' + index, index: index, text: String(text || '') };
    }).filter(function(item) {
      return item.text && (!query || item.text.toLowerCase().indexOf(query) >= 0);
    });
  }

  return {
    categories: categories,
    specials: specials,
    resultCount: categories.reduce(function(total, category) { return total + category.items.length; }, 0) + specials.length
  };
}

// 建立只读规则索引。流水优先通过稳定 ID 关联；旧流水再按名称快照和 aliases 兜底。
function buildRuleLookup(rules) {
  var safe = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
  var lookup = {
    _isRuleLookup: true,
    byRuleId: Object.create(null),
    byCategoryId: Object.create(null),
    byReason: Object.create(null),
    entries: []
  };
  ['reward', 'punish'].forEach(function(type) {
    var categories = Array.isArray(safe[type]) ? safe[type] : [];
    categories.forEach(function(category, categoryIndex) {
      var sourceCategory = category && typeof category === 'object' ? category : {};
      var categoryId = stableId(sourceCategory.id);
      var categoryEntry = {
        id: categoryId,
        category: String(sourceCategory.category || '未命名分类'),
        type: type,
        categoryIndex: categoryIndex,
        raw: sourceCategory,
        rules: []
      };
      if (categoryId) lookup.byCategoryId[categoryId] = categoryEntry;
      (Array.isArray(sourceCategory.items) ? sourceCategory.items : []).forEach(function(item, itemIndex) {
        var sourceItem = item && typeof item === 'object' ? item : {};
        var ruleId = stableId(sourceItem.id);
        var names = ruleNames(sourceItem);
        var entry = {
          id: ruleId,
          categoryId: categoryId,
          category: categoryEntry.category,
          type: type,
          categoryIndex: categoryIndex,
          itemIndex: itemIndex,
          label: String(sourceItem.label || '未命名规则'),
          aliases: names.slice(1),
          raw: sourceItem,
          categoryRaw: sourceCategory
        };
        categoryEntry.rules.push(entry);
        lookup.entries.push(entry);
        if (ruleId) lookup.byRuleId[ruleId] = entry;
        names.forEach(function(name) {
          if (!lookup.byReason[name]) lookup.byReason[name] = entry;
        });
      });
    });
  });
  return lookup;
}

function ensureRuleLookup(rulesOrLookup) {
  return rulesOrLookup && rulesOrLookup._isRuleLookup
    ? rulesOrLookup
    : buildRuleLookup(rulesOrLookup);
}

function resolveRecordRule(record, rulesOrLookup) {
  var source = record && typeof record === 'object' ? record : {};
  var lookup = ensureRuleLookup(rulesOrLookup);
  var ruleId = stableId(source.ruleId);
  var categoryId = stableId(source.categoryId);
  if (ruleId) return lookup.byRuleId[ruleId] || null;

  var reason = String(source.reason || '').trim();
  if (!reason) return null;
  if (categoryId && lookup.byCategoryId[categoryId]) {
    var categoryRules = lookup.byCategoryId[categoryId].rules;
    for (var i = 0; i < categoryRules.length; i++) {
      if (ruleNames(categoryRules[i].raw).indexOf(reason) >= 0) return categoryRules[i];
    }
    return null;
  }
  return lookup.byReason[reason] || null;
}

function recordMatchesCategory(record, category, rulesOrLookup) {
  var source = record && typeof record === 'object' ? record : {};
  var target = category && typeof category === 'object' ? category : {};
  var recordCategoryId = stableId(source.categoryId);
  var categoryId = stableId(target.id);
  if (recordCategoryId) return !!categoryId && recordCategoryId === categoryId;

  var ruleId = stableId(source.ruleId);
  if (ruleId) {
    var resolvedById = resolveRecordRule(source, rulesOrLookup || {
      reward: [target],
      punish: []
    });
    if (!resolvedById) return false;
    if (categoryId) return resolvedById.categoryId === categoryId;
    return resolvedById.categoryRaw === target || resolvedById.category === String(target.category || '');
  }

  var reason = String(source.reason || '').trim();
  if (!reason) return false;
  return (Array.isArray(target.items) ? target.items : []).some(function(item) {
    return ruleNames(item).indexOf(reason) >= 0;
  });
}

function recordRuleIdentity(record, rulesOrLookup) {
  var source = record && typeof record === 'object' ? record : {};
  var ruleId = stableId(source.ruleId);
  if (ruleId) return 'rule:' + ruleId;
  var resolved = resolveRecordRule(source, rulesOrLookup);
  if (resolved && resolved.id) return 'rule:' + resolved.id;
  if (resolved) return 'reason:' + resolved.label;
  return 'reason:' + String(source.reason || '其他成长').trim();
}

function recordRuleLabel(record, rulesOrLookup) {
  var resolved = resolveRecordRule(record, rulesOrLookup);
  return resolved ? resolved.label : String((record && record.reason) || '其他成长');
}

function recordTimestamp(record) {
  var value = record && (record.time || record.occurredAt || record.createdAt);
  if (typeof value === 'number') return value;
  var text = String(value || '').trim();
  var localMatch = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (localMatch) {
    return new Date(
      Number(localMatch[1]),
      Number(localMatch[2]) - 1,
      Number(localMatch[3]),
      Number(localMatch[4] || 0),
      Number(localMatch[5] || 0),
      Number(localMatch[6] || 0)
    ).getTime();
  }
  var timestamp = new Date(text).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function frequentRules(rules, history, limit) {
  var safe = cloneRules(rules);
  var lookup = buildRuleLookup(safe);
  var all = [];
  ['reward', 'punish'].forEach(function(type) {
    safe[type].forEach(function(category, categoryIndex) {
      (category.items || []).forEach(function(item, itemIndex) {
        var view = formatRuleItem(item, type, false);
        view.category = category.category || '未命名分类';
        view.categoryId = stableId(category.id);
        view.categoryIndex = categoryIndex;
        view.itemIndex = itemIndex;
        view.key = type + '-' + (item.id || categoryIndex + '-' + itemIndex);
        view.usageCount = 0;
        all.push(view);
      });
    });
  });

  var cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  var counts = {};
  (Array.isArray(history) ? history : []).forEach(function(record) {
    if (recordTimestamp(record) < cutoff) return;
    var identity = recordRuleIdentity(record, lookup);
    if (identity !== 'reason:') counts[identity] = (counts[identity] || 0) + 1;
  });
  all.forEach(function(item) {
    var identity = item.id ? 'rule:' + item.id : 'reason:' + item.label;
    item.usageCount = counts[identity] || 0;
  });
  all.sort(function(a, b) {
    return b.usageCount - a.usageCount || a.categoryIndex - b.categoryIndex || a.itemIndex - b.itemIndex;
  });
  return all.slice(0, Math.max(1, Number(limit) || 4));
}

module.exports = {
  buildRuleLookup: buildRuleLookup,
  buildBrowserData: buildBrowserData,
  cloneRules: cloneRules,
  finiteNumber: finiteNumber,
  formatRuleItem: formatRuleItem,
  frequentRules: frequentRules,
  recordMatchesCategory: recordMatchesCategory,
  recordRuleIdentity: recordRuleIdentity,
  recordRuleLabel: recordRuleLabel,
  resolveRecordRule: resolveRecordRule,
  signedNumber: signedNumber,
  summarizeRules: summarizeRules
};
