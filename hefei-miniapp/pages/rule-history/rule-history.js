var app = getApp();

function formatDate(value) {
  if (!value) return '时间待确认';
  var date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  var pad = function(number) { return number < 10 ? '0' + number : String(number); };
  return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function countRules(rules) {
  var source = rules && typeof rules === 'object' ? rules : {};
  var countType = function(type) {
    return (Array.isArray(source[type]) ? source[type] : []).reduce(function(total, category) {
      return total + (Array.isArray(category && category.items) ? category.items.length : 0);
    }, 0);
  };
  return {
    reward: countType('reward'),
    punish: countType('punish'),
    special: (Array.isArray(source.special) ? source.special : []).filter(function(item) {
      return typeof item === 'string' && item.trim();
    }).length
  };
}

function sourceLabel(source) {
  var labels = {
    migration: '迁移初始版本',
    bootstrap: '家庭初始版本',
    initialize: '家庭初始版本',
    save: '管理员保存',
    restore: '从历史恢复'
  };
  return labels[source] || '规则更新';
}

function firstDefined(values, fallback) {
  for (var index = 0; index < values.length; index += 1) {
    if (values[index] !== undefined && values[index] !== null) return values[index];
  }
  return fallback;
}

function signedScore(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) return '待设置';
  return number > 0 ? '+' + number : String(number);
}

function buildRuleGroups(rules) {
  var source = rules && typeof rules === 'object' ? rules : {};
  var groups = [];
  [
    { type: 'reward', title: '鼓励规则' },
    { type: 'punish', title: '护糖提醒' }
  ].forEach(function(meta) {
    var categories = (Array.isArray(source[meta.type]) ? source[meta.type] : []).map(function(category, categoryIndex) {
      return {
        key: String((category && category.id) || meta.type + '-' + categoryIndex),
        name: String((category && category.category) || '未命名分类'),
        items: (Array.isArray(category && category.items) ? category.items : []).map(function(item, itemIndex) {
          var min = item && item.min;
          var max = item && item.max;
          return {
            key: String((item && item.id) || itemIndex),
            label: String((item && item.label) || '未命名规则'),
            range: signedScore(min) + (Number(min) === Number(max) ? '' : '～' + signedScore(max)) + ' 分'
          };
        })
      };
    });
    if (categories.length) groups.push({ type: meta.type, title: meta.title, categories: categories });
  });
  var specialItems = (Array.isArray(source.special) ? source.special : []).map(function(item, index) {
    return { key: String(index), label: String(item || '') };
  }).filter(function(item) { return item.label.trim(); });
  return { groups: groups, specialItems: specialItems };
}

function decorateVersion(version, currentRevision) {
  var source = version || {};
  var calculated = countRules(source.rules);
  var summary = source.summary || source.counts || {};
  var preview = buildRuleGroups(source.rules);
  var versionId = source.versionId || source.id || '';
  var revision = Number(source.revision || 0);
  return Object.assign({}, source, {
    versionId: String(versionId),
    revision: revision,
    createdAtText: formatDate(source.createdAt || source.created_at),
    operatorText: source.createdByName || source.createdBy || source.updatedBy || '系统',
    sourceText: sourceLabel(source.source),
    rewardCount: Number(firstDefined([source.rewardCount, summary.reward, summary.rewardCount], calculated.reward)),
    punishCount: Number(firstDefined([source.punishCount, summary.punish, summary.punishCount], calculated.punish)),
    specialCount: Number(firstDefined([source.specialCount, summary.special, summary.specialCount], calculated.special)),
    ruleGroups: preview.groups,
    specialItems: preview.specialItems,
    isCurrent: revision === Number(currentRevision || 0)
  });
}

Page({
  data: {
    accessAllowed: false,
    loading: true,
    loadError: '',
    history: [],
    currentRevision: 0,
    detailVisible: false,
    detailLoading: false,
    selectedVersion: null,
    restoringId: '',
    themePageStyle: '',
    themeClass: '',
    iconTheme: 'mint',
    toastMessage: '',
    toastVisible: false
  },

  onLoad: function() {
    if (!this.ensureAdminAccess()) return;
    this.syncTheme();
    this.loadHistory();
  },

  onShow: function() {
    this.syncTheme();
  },

  syncTheme: function() {
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: app.globalData.theme === 'amber' ? 'amber' : 'mint'
    });
  },

  ensureAdminAccess: function() {
    var user = app.globalData.user;
    if (app.globalData.token && user && user.role === 'admin') {
      this.setData({ accessAllowed: true });
      return true;
    }
    wx.showToast({ title: '仅管理员可查看规则历史', icon: 'none' });
    wx.navigateBack({ fail: function() { wx.reLaunch({ url: '/pages/index/index' }); } });
    return false;
  },

  loadHistory: function() {
    var that = this;
    this.setData({ loading: true, loadError: '' });
    return Promise.all([
      app.fetchAPI('/api/config'),
      app.fetchAPI('/api/config/rules/history?limit=50')
    ]).then(function(results) {
      var config = results[0] || {};
      var historyResult = results[1] || {};
      if (!historyResult.success) throw new Error(historyResult.message || '规则历史加载失败');
      if (config.success && config.rules) app.globalData.rules = app.normalizeRules(config.rules);
      var currentRevision = Number(firstDefined([
        historyResult.currentRevision,
        config.rules && config.rules.revision
      ], 0));
      var rows = historyResult.history || historyResult.versions || [];
      that.setData({
        loading: false,
        currentRevision: currentRevision,
        history: rows.map(function(item) { return decorateVersion(item, currentRevision); })
      });
    }).catch(function(error) {
      that.setData({ loading: false, loadError: error.message || '规则历史加载失败' });
    });
  },

  retryLoad: function() {
    this.loadHistory();
  },

  openVersion: function(e) {
    var versionId = String(e.currentTarget.dataset.id || '');
    if (!versionId || this.data.detailLoading) return;
    var that = this;
    this.setData({ detailVisible: true, detailLoading: true, selectedVersion: null });
    app.fetchAPI('/api/config/rules/history/' + encodeURIComponent(versionId)).then(function(result) {
      if (!result.success) throw new Error(result.message || '版本详情加载失败');
      var version = result.version || result.history || result;
      that.setData({
        detailLoading: false,
        selectedVersion: decorateVersion(version, that.data.currentRevision)
      });
    }).catch(function(error) {
      that.setData({ detailVisible: false, detailLoading: false });
      that.showToast(error.message || '版本详情加载失败');
    });
  },

  closeDetail: function() {
    if (this.data.restoringId) return;
    this.setData({ detailVisible: false, detailLoading: false, selectedVersion: null });
  },

  restoreSelectedVersion: function() {
    var selected = this.data.selectedVersion;
    if (!selected || selected.isCurrent || this.data.restoringId) return;
    var that = this;
    wx.showModal({
      title: '恢复规则版本 r' + selected.revision + '？',
      content: '恢复会生成一个新的规则版本，不会删除或改写任何积分流水。恢复后全家立即使用该套规则。',
      confirmText: '确认恢复',
      confirmColor: '#2D9B7A',
      success: function(modalResult) {
        if (modalResult.confirm) that.commitRestore(selected);
      }
    });
  },

  commitRestore: function(selected) {
    var that = this;
    this.setData({ restoringId: selected.versionId });
    app.fetchAPI('/api/config/rules/history/' + encodeURIComponent(selected.versionId) + '/restore', {
      method: 'POST',
      body: JSON.stringify({ revision: this.data.currentRevision })
    }).then(function(result) {
      that.setData({ restoringId: '' });
      if (result.success) {
        if (result.rules) app.globalData.rules = app.normalizeRules(result.rules);
        app.globalData.ruleHistoryRestored = true;
        that.setData({ detailVisible: false, selectedVersion: null });
        return app.loadData().then(function() {
          that.showToast('规则已恢复并生成新版本');
          return that.loadHistory();
        });
      }
      if (result.code === 'RULES_REVISION_CONFLICT') {
        wx.showModal({
          title: '规则已被更新',
          content: '另一位管理员刚刚保存了规则。已保留全部历史，请刷新后重新确认要恢复的版本。',
          showCancel: false,
          success: function() { that.loadHistory(); }
        });
        return;
      }
      that.showToast(result.message || '恢复失败');
    }).catch(function(error) {
      that.setData({ restoringId: '' });
      that.showToast(error.message || '恢复失败，请稍后重试');
    });
  },

  showToast: function(message) {
    var that = this;
    clearTimeout(this._toastTimer);
    this.setData({ toastMessage: message, toastVisible: true });
    this._toastTimer = setTimeout(function() { that.setData({ toastVisible: false }); }, 2200);
  },

  stopBubble: function() {}
});
