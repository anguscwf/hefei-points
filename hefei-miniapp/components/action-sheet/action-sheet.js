// components/action-sheet/action-sheet.js
var rulesViewModel = require('../../utils/rules-view-model.js');

function rawRule(item) {
  if (item && item.raw && typeof item.raw === 'object') return item.raw;
  return item && typeof item === 'object' ? item : {};
}

function inferRuleType(item, fallbackType) {
  if (item && (item.type === 'reward' || item.type === 'punish')) return item.type;
  if (fallbackType === 'reward' || fallbackType === 'punish') return fallbackType;
  return Number(rawRule(item).default) < 0 ? 'punish' : 'reward';
}

function presentRule(item, fallbackType, category, index) {
  var source = rawRule(item);
  var type = inferRuleType(item, fallbackType);
  var view = rulesViewModel.formatRuleItem(source, type, false);
  var defaultDisplay = view.defaultValue === null
    ? '待设置'
    : rulesViewModel.signedNumber(view.defaultValue) + ' 分';
  return {
    key: type + '-' + (source.id || String(category || 'rule') + '-' + index),
    type: type,
    isReward: type === 'reward',
    category: String((item && item.category) || category || '成长规则'),
    label: view.label,
    unit: view.unit,
    hint: view.hint,
    rangeDisplay: view.min !== null && view.max !== null
      ? view.rangeDisplay + ' 分'
      : view.rangeDisplay,
    defaultDisplay: defaultDisplay,
    raw: source
  };
}

function presentCategories(categories, type) {
  return (Array.isArray(categories) ? categories : []).map(function(category, categoryIndex) {
    var categoryName = String((category && category.category) || '未命名分类');
    var sourceItems = category && Array.isArray(category.items) ? category.items : [];
    var items = sourceItems.map(function(item, itemIndex) {
      return presentRule(item, type, categoryName, itemIndex);
    });
    return {
      key: type + '-' + categoryIndex,
      type: type,
      isReward: type === 'reward',
      category: categoryName,
      count: items.length,
      preview: items.slice(0, 2).map(function(item) { return item.label; }).join('、'),
      items: items
    };
  }).filter(function(category) {
    return category.items.length > 0;
  });
}

function presentFrequentRules(frequent, rewardCategories, punishCategories) {
  var supplied = Array.isArray(frequent) ? frequent.filter(function(item) {
    return item && typeof item === 'object';
  }) : [];
  var fallback = [];
  rewardCategories.concat(punishCategories).some(function(category) {
    category.items.some(function(item) {
      fallback.push(item);
      return fallback.length >= 4;
    });
    return fallback.length >= 4;
  });
  var source = supplied.length ? supplied : fallback;
  var seen = {};
  return source.map(function(item, index) {
    return presentRule(item, inferRuleType(item), item.category, index);
  }).filter(function(item) {
    var sourceId = item.raw && item.raw.id;
    var identity = item.type + ':' + (sourceId || item.category + ':' + item.label);
    if (seen[identity]) return false;
    seen[identity] = true;
    return true;
  }).slice(0, 4);
}

Component({
  properties: {
    show: { type: Boolean, value: false },
    kidName: { type: String, value: '' },
    kidPoints: { type: Number, value: 0 },
    theme: { type: String, value: 'mint' },
    rewardRules: { type: Array, value: [] },
    punishRules: { type: Array, value: [] },
    frequentRules: { type: Array, value: [] }
  },

  data: {
    manualAmt: '',
    manualReason: '',
    manualSign: 1,
    manualExpanded: false,
    expandedCategoryKey: '',
    rewardCategories: [],
    punishCategories: [],
    frequentRuleViews: [],
    rulesTotal: 0,
    rulesEmpty: true,
    guideText: '选择一条成长规则，轻点即可记录通常分值'
  },

  observers: {
    'rewardRules,punishRules,frequentRules,kidName': function(rewardRules, punishRules, frequentRules, kidName) {
      this._buildRuleView(rewardRules, punishRules, frequentRules, kidName);
    },
    show: function(show) {
      if (!show) {
        this.setData({
          expandedCategoryKey: '',
          manualExpanded: false
        });
      }
    }
  },

  lifetimes: {
    detached: function() {
      clearTimeout(this._longRuleTimer);
    }
  },

  methods: {
    _buildRuleView: function(rewardRules, punishRules, frequentRules, kidName) {
      var rewardCategories = presentCategories(rewardRules, 'reward');
      var punishCategories = presentCategories(punishRules, 'punish');
      var frequentRuleViews = presentFrequentRules(frequentRules, rewardCategories, punishCategories);
      var rulesTotal = rewardCategories.concat(punishCategories).reduce(function(total, category) {
        return total + category.count;
      }, 0);
      this.setData({
        rewardCategories: rewardCategories,
        punishCategories: punishCategories,
        frequentRuleViews: frequentRuleViews,
        rulesTotal: rulesTotal,
        rulesEmpty: rulesTotal === 0 && frequentRuleViews.length === 0,
        guideText: kidName
          ? '为' + kidName + '记一颗成长糖：轻点按通常分记录，长按可调整'
          : '选择一条成长规则：轻点按通常分记录，长按可调整'
      });
    },

    noop: function() {
    },

    onClose: function() {
      this.setData({
        manualAmt: '',
        manualReason: '',
        manualSign: 1,
        manualExpanded: false,
        expandedCategoryKey: ''
      });
      this.triggerEvent('close');
    },

    onToggleCategory: function(e) {
      var key = String(e.currentTarget.dataset.key || '');
      this.setData({
        expandedCategoryKey: this.data.expandedCategoryKey === key ? '' : key
      });
    },

    onToggleManual: function() {
      this.setData({ manualExpanded: !this.data.manualExpanded });
    },

    onSelectRule: function(e) {
      if (this._longRuleTriggered) {
        this._longRuleTriggered = false;
        return;
      }
      this.triggerEvent('quick', e.currentTarget.dataset.item);
    },

    onAdjustRule: function(e) {
      var that = this;
      this._longRuleTriggered = true;
      clearTimeout(this._longRuleTimer);
      this._longRuleTimer = setTimeout(function() {
        that._longRuleTriggered = false;
      }, 800);
      this.triggerEvent('adjust', e.currentTarget.dataset.item);
    },

    onAmtInput: function(e) {
      this.setData({ manualAmt: e.detail.value });
    },

    onManualSignChange: function(e) {
      var sign = Number(e.currentTarget.dataset.sign) === -1 ? -1 : 1;
      this.setData({ manualSign: sign });
    },

    onReasonInput: function(e) {
      this.setData({ manualReason: e.detail.value });
    },

    onManualConfirm: function() {
      var raw = String(this.data.manualAmt || '').trim();
      var absAmt = Math.abs(Number(raw));
      var sign = this.data.manualSign === -1 ? -1 : 1;
      var amt = absAmt * sign;
      var reason = String(this.data.manualReason || '').trim();
      if (!raw || !Number.isInteger(absAmt) || absAmt === 0) {
        wx.showToast({ title: '请输入有效分数', icon: 'none' });
        return;
      }
      var maxAbs = sign === -1 ? 500 : 1000;
      if (absAmt > maxAbs) {
        wx.showToast({ title: sign === -1 ? '扣分不能超过500分' : '加分不能超过1000分', icon: 'none' });
        return;
      }
      if (reason.length > 50) {
        wx.showToast({ title: '事由不能超过50字', icon: 'none' });
        return;
      }
      this.triggerEvent('manual', {
        amount: amt,
        reason: reason || (sign === -1 ? '手动扣分' : '手动加分'),
        note: ''
      });
      this.setData({ manualAmt: '', manualReason: '', manualSign: 1 });
    }
  }
});
