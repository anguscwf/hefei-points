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

function formatRuleItem(item, type, isChild) {
  var source = item && typeof item === 'object' ? item : {};
  var min = finiteNumber(source.min);
  var max = finiteNumber(source.max);
  var defaultValue = finiteNumber(source.default);
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
  var text = String((category && category.category) || '').toLowerCase();
  return text.indexOf(query) >= 0;
}

function itemMatches(item, query) {
  if (!query) return true;
  return [item.label, item.unit, item.hint].some(function(value) {
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
      var rawItems = Array.isArray(category.items) ? category.items : [];
      var categoryMatched = categoryMatches(category, query);
      var items = rawItems.map(function(item, itemIndex) {
        var view = formatRuleItem(item, type, isChild);
        view.categoryIndex = categoryIndex;
        view.itemIndex = itemIndex;
        view.category = String(category.category || '未命名分类');
        return view;
      }).filter(function(item) {
        return !query || categoryMatched || itemMatches(item, query);
      });
      if (query && !categoryMatched && !items.length) return;
      categories.push({
        key: type + '-' + categoryIndex,
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
  var all = [];
  ['reward', 'punish'].forEach(function(type) {
    safe[type].forEach(function(category, categoryIndex) {
      (category.items || []).forEach(function(item, itemIndex) {
        var view = formatRuleItem(item, type, false);
        view.category = category.category || '未命名分类';
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
    var reason = String(record.reason || '');
    if (reason) counts[reason] = (counts[reason] || 0) + 1;
  });
  all.forEach(function(item) { item.usageCount = counts[item.label] || 0; });
  all.sort(function(a, b) {
    return b.usageCount - a.usageCount || a.categoryIndex - b.categoryIndex || a.itemIndex - b.itemIndex;
  });
  return all.slice(0, Math.max(1, Number(limit) || 4));
}

module.exports = {
  buildBrowserData: buildBrowserData,
  cloneRules: cloneRules,
  finiteNumber: finiteNumber,
  formatRuleItem: formatRuleItem,
  frequentRules: frequentRules,
  signedNumber: signedNumber,
  summarizeRules: summarizeRules
};
