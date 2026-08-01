// pages/admin/admin.js
var app = getApp();
var rulesViewModel = require('../../utils/rules-view-model.js');
var cloneRules = rulesViewModel.cloneRules;

var RULE_LIMITS = {
  category: 30,
  label: 50,
  unit: 20,
  hint: 200,
  special: 300,
  id: 64,
  aliases: 20
};
var RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

var RULE_TEMPLATES = [
  { id: 'homework', name: '作业', rewardLabel: '按时完成作业', punishLabel: '作业拖延需提醒', default: 5, min: 1, max: 10, unit: '每次', hint: '按约定时间认真完成，并主动检查。' },
  { id: 'reading', name: '阅读', rewardLabel: '主动阅读', punishLabel: '阅读计划未完成', default: 3, min: 1, max: 10, unit: '每次', hint: '安静阅读并愿意分享今天的收获。' },
  { id: 'chores', name: '家务', rewardLabel: '主动做家务', punishLabel: '家务约定未完成', default: 3, min: 1, max: 10, unit: '每次', hint: '完成力所能及的家务，让家里更温暖。' },
  { id: 'exercise', name: '运动', rewardLabel: '坚持运动', punishLabel: '运动计划未完成', default: 5, min: 1, max: 20, unit: '每次', hint: '认真运动，照顾好自己的身体。' },
  { id: 'routine', name: '作息', rewardLabel: '按时作息', punishLabel: '没有按时作息', default: 3, min: 1, max: 10, unit: '每天', hint: '按家庭约定准时睡觉、起床。' },
  { id: 'selfcare', name: '自理', rewardLabel: '自己的事情自己做', punishLabel: '自理事项需提醒', default: 2, min: 1, max: 10, unit: '每次', hint: '主动整理并照顾好自己的物品。' }
];

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hashText(value) {
  var hash = 2166136261;
  var text = String(value || '');
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function ensureCategoryIds(rules) {
  ['reward', 'punish'].forEach(function(type) {
    var used = {};
    (rules[type] || []).forEach(function(cat, index) {
      var id = String(cat.id || '').trim();
      if (!id || used[id]) {
        var base = 'cat_' + type.charAt(0) + '_' + hashText(type + '|' + String(cat.category || '') + '|' + index);
        id = base;
        var suffix = 1;
        while (used[id]) id = base + '_' + suffix++;
        cat.id = id;
      }
      used[id] = true;
    });
  });
  return rules;
}

function normalizeLegacyRuleRanges(rules) {
  (rules.punish || []).forEach(function(category) {
    (category.items || []).forEach(function(item) {
      ['min', 'default', 'max'].forEach(function(key) {
        if (Number.isSafeInteger(item[key]) && item[key] < -500) item[key] = -500;
      });
    });
  });
  return rules;
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  var output = {};
  Object.keys(value).sort().forEach(function(key) {
    if (key === 'revision' || key.indexOf('_ui') === 0 || key === '_source') return;
    output[key] = comparable(value[key]);
  });
  return output;
}

function sameValue(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function ruleEntityMap(rules) {
  var map = {};
  ['reward', 'punish'].forEach(function(type) {
    (rules[type] || []).forEach(function(cat, ci) {
      var categoryKey = 'category:' + type + ':' + String(cat.id || ci);
      map[categoryKey] = Object.assign({}, cat, {
        items: undefined,
        _diffOrder: ci
      });
      (cat.items || []).forEach(function(item, ii) {
        map['rule:' + type + ':' + String(item.id || (String(cat.id || ci) + ':' + ii))] = Object.assign({}, item, {
          _diffCategoryId: String(cat.id || ci),
          _diffOrder: ii
        });
      });
    });
  });
  (rules.special || []).forEach(function(text, index) {
    map['special:' + index] = text;
  });
  return map;
}

function diffRuleSets(before, after) {
  var oldMap = ruleEntityMap(before || {});
  var newMap = ruleEntityMap(after || {});
  var summary = { added: 0, modified: 0, removed: 0 };
  Object.keys(newMap).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(oldMap, key)) summary.added++;
    else if (!sameValue(oldMap[key], newMap[key])) summary.modified++;
  });
  Object.keys(oldMap).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(newMap, key)) summary.removed++;
  });
  return summary;
}

function integerValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  var number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

function scoreText(type, value) {
  var number = integerValue(value);
  if (number === null) return '待设置';
  return type === 'punish' ? '通常扣 ' + Math.abs(number) : '通常 +' + number;
}

function aliasesWithPreviousName(aliases, previousName, currentName, maxTextLength) {
  var values = [previousName].concat(Array.isArray(aliases) ? aliases : []);
  var seen = {};
  var result = [];
  values.forEach(function(value) {
    var alias = typeof value === 'string' ? value.trim() : '';
    if (!alias || alias === currentName || alias.length > maxTextLength || seen[alias] || result.length >= RULE_LIMITS.aliases) return;
    seen[alias] = true;
    result.push(alias);
  });
  return result;
}

function editableItemFromRaw(rawItem, type) {
  var item = deepClone(rawItem || {});
  var isPunish = type === 'punish';
  var storedMin = integerValue(item.min);
  var storedMax = integerValue(item.max);
  var storedDefault = integerValue(item.default);
  item._source = deepClone(rawItem || {});
  item.editLabel = item.label === undefined || item.label === null ? '' : String(item.label);
  item.editMin = isPunish ? (storedMax === null ? '' : Math.abs(storedMax)) : (storedMin === null ? '' : storedMin);
  item.editMax = isPunish ? (storedMin === null ? '' : Math.abs(storedMin)) : (storedMax === null ? '' : storedMax);
  item.editDefault = storedDefault === null ? '' : (isPunish ? Math.abs(storedDefault) : storedDefault);
  item.editUnit = item.unit === undefined || item.unit === null ? '' : String(item.unit);
  item.editHint = item.hint === undefined || item.hint === null ? '' : String(item.hint);
  return item;
}

Page({
  data: {
    accessAllowed: false,
    adminTab: 'users',

    // 用户管理
    userList: [],
    roleOptions: ['管理员', '家长', '孩子'],
    skinOptions: ['糖罐', '星空糖罐'],
    newUid: '',
    newName: '',
    newPwd: '',
    newRoleIdx: 2,
    newRoleName: '孩子',

    // 规则管理
    editRules: { reward: [], punish: [], special: [] },
    newRCatName: '',
    newPCatName: '',
    ruleType: 'reward',
    expandedRuleCategory: '',
    ruleStats: { reward: 0, punish: 0, special: 0 },
    ruleDirty: false,
    ruleChangeCount: 0,
    ruleValidationMessage: '',
    rulesSaving: false,
    ruleEditorVisible: false,
    ruleEditorAdvanced: false,
    ruleEditorDirty: false,
    ruleEditor: null,
    ruleTemplates: RULE_TEMPLATES,
    quickScores: [1, 3, 5, 10, 20, 50, 100],
    draftRestored: false,
    draftSavedAt: '',
    ruleConflict: false,
    conflictRevision: null,
    undoVisible: false,
    undoMessage: '',

    toastMessage: '',
    toastVisible: false,

    // 数据清理
    cleanupKidOptions: [{ id: 'all', name: '所有孩子' }],
    cleanupKidIdx: 0,
    cleanupBefore: '',
    cleanupAfter: '',
    cleanupPreviewCount: -1,
    themePageStyle: '',
    themeClass: '',
    iconTheme: 'mint'
  },

  onLoad: function() {
    if (!this.ensureAdminAccess()) return;
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: app.globalData.theme === 'amber' ? 'amber' : 'mint'
    });
    this.loadData();
  },

  onShow: function() {
    if (!this.ensureAdminAccess()) return;
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: app.globalData.theme === 'amber' ? 'amber' : 'mint'
    });
    if (app.globalData.ruleHistoryRestored) {
      app.globalData.ruleHistoryRestored = false;
      this.loadData({ skipDraftPrompt: true });
      this.showToast('已载入恢复后的规则版本');
    }
  },

  onUnload: function() {
    if (this.data.ruleDirty) this._saveRuleDraftNow();
    clearTimeout(this._draftTimer);
    clearTimeout(this._undoTimer);
  },

  ensureAdminAccess: function() {
    var user = app.globalData.user;
    if (app.globalData.token && user && user.role === 'admin') {
      if (!this.data.accessAllowed) this.setData({ accessAllowed: true });
      return true;
    }
    if (this.data.accessAllowed) this.setData({ accessAllowed: false });
    if (!this._redirectingUnauthorized) {
      this._redirectingUnauthorized = true;
      wx.showToast({ title: '仅管理员可访问', icon: 'none' });
      var goHome = function() {
        wx.switchTab({
          url: '/pages/index/index',
          fail: function() {
            wx.reLaunch({ url: '/pages/index/index' });
          }
        });
      };
      wx.navigateBack({
        delta: 1,
        fail: goHome
      });
    }
    return false;
  },

  _buildEditableRules: function(rawRules) {
    var sourceRules = normalizeLegacyRuleRanges(ensureCategoryIds(cloneRules(rawRules || { reward: [], punish: [], special: [] })));
    var editRules = cloneRules(sourceRules);
    ['reward', 'punish'].forEach(function(type) {
      editRules[type].forEach(function(cat, ci) {
        var sourceCat = sourceRules[type][ci] || {};
        var sourceItems = Array.isArray(sourceCat.items) ? sourceCat.items : [];
        cat._source = sourceCat;
        cat.items = Array.isArray(cat.items) ? cat.items : [];
        cat.items.forEach(function(item, ii) {
          var isPunish = type === 'punish';
          var storedMin = integerValue(item.min);
          var storedMax = integerValue(item.max);
          var storedDefault = integerValue(item.default);
          item._source = sourceItems[ii] || {};
          item.editLabel = item.label === undefined || item.label === null ? '' : String(item.label);
          item.editMin = isPunish ? (storedMax === null ? '' : Math.abs(storedMax)) : (storedMin === null ? '' : storedMin);
          item.editMax = isPunish ? (storedMin === null ? '' : Math.abs(storedMin)) : (storedMax === null ? '' : storedMax);
          item.editDefault = storedDefault === null ? '' : (isPunish ? Math.abs(storedDefault) : storedDefault);
          item.editUnit = item.unit === undefined || item.unit === null ? '' : String(item.unit);
          item.editHint = item.hint === undefined || item.hint === null ? '' : String(item.hint);
        });
      });
    });
    this._decorateRuleDraft(editRules);
    return { source: sourceRules, edit: editRules };
  },

  // ========== 加载数据 ==========
  loadData: function(options) {
    options = options || {};
    var hadUnsavedRules = !!this.data.ruleDirty;
    if (hadUnsavedRules) this._saveRuleDraftNow();
    var g = app.globalData;
    var allUsers = g.allUsers || [];
    var roles = ['管理员', '家长', '孩子'];
    var roleMap = { admin: 0, parent: 1, child: 2 };
    var userList = allUsers.map(function(u) {
      var roleIdx = Object.prototype.hasOwnProperty.call(roleMap, u.role) ? roleMap[u.role] : 2;
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        roleIdx: roleIdx,
        roleName: roles[roleIdx],
        editName: u.name,
        editPwd: '',
        password: u.password,
        skin: app.getKidSkin(u.id),
        skinIdx: app.getKidSkin(u.id) === 'star' ? 1 : 0
      };
    });

    // 原始模型和编辑草稿始终深拷贝，保留未来新增的未知字段。
    var built = this._buildEditableRules(g.rules || { reward: [], punish: [], special: [] });
    var sourceRules = built.source;
    var editRules = built.edit;
    this._ruleSourceRoot = sourceRules;
    this._ruleServerSnapshot = cloneRules(sourceRules);
    this._rulesBaseRevision = sourceRules.revision === undefined || sourceRules.revision === null ? 0 : sourceRules.revision;

    this._rulesDirtyKeys = {};
    var currentRuleType = ['reward', 'punish', 'special'].indexOf(this.data.ruleType) >= 0 ? this.data.ruleType : 'reward';
    var firstCategory = currentRuleType === 'special' || !editRules[currentRuleType][0]
      ? ''
      : editRules[currentRuleType][0]._uiKey;

    this.setData({
      userList: userList,
      editRules: editRules,
      ruleType: currentRuleType,
      expandedRuleCategory: firstCategory,
      ruleStats: this._countRules(editRules),
      ruleDirty: false,
      ruleChangeCount: 0,
      ruleValidationMessage: '',
      ruleEditorVisible: false,
      ruleEditorDirty: false,
      ruleEditor: null,
      draftRestored: false,
      draftSavedAt: '',
      ruleConflict: false,
      conflictRevision: null,
      undoVisible: false,
      cleanupKidOptions: [{ id: 'all', name: '所有孩子' }].concat(
        allUsers.filter(function(u) { return u.role === 'child'; }).map(function(u) { return { id: u.id, name: u.name }; })
      )
    });
    this._disableRuleUnloadAlert();
    if (!options.skipDraftPrompt) this._offerRuleDraftRestore(hadUnsavedRules);
  },

  _ruleFamilyId: function() {
    return String((app.globalData.user && app.globalData.user.familyId) || 'default');
  },

  _ruleDraftKey: function() {
    return 'hefei_rules_draft_v24:' + this._ruleFamilyId() + ':' + String(this._rulesBaseRevision === undefined ? 0 : this._rulesBaseRevision);
  },

  _formatDraftTime: function(timestamp) {
    if (!timestamp) return '';
    var date = new Date(timestamp);
    var pad = function(value) { return value < 10 ? '0' + value : String(value); };
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  },

  _saveRuleDraftNow: function() {
    if (!this.data.ruleDirty) return;
    clearTimeout(this._draftTimer);
    var savedAt = Date.now();
    var payload = {
      familyId: this._ruleFamilyId(),
      baseRevision: this._rulesBaseRevision,
      savedAt: savedAt,
      rules: this._serializeRules()
    };
    try {
      wx.setStorageSync(this._ruleDraftKey(), payload);
      this.setData({ draftSavedAt: this._formatDraftTime(savedAt) });
    } catch (error) {
      this.showToast('本地草稿保存失败，请尽快保存规则');
    }
  },

  _scheduleRuleDraftSave: function() {
    var that = this;
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(function() { that._saveRuleDraftNow(); }, 350);
  },

  _clearRuleDraft: function() {
    clearTimeout(this._draftTimer);
    try { wx.removeStorageSync(this._ruleDraftKey()); } catch (error) {}
    this.setData({ draftRestored: false, draftSavedAt: '' });
  },

  _offerRuleDraftRestore: function(force) {
    var that = this;
    var key = this._ruleDraftKey();
    if (!force && this._draftPromptedKey === key) return;
    this._draftPromptedKey = key;
    var draft;
    try { draft = wx.getStorageSync(key); } catch (error) { draft = null; }
    if (!draft || draft.familyId !== this._ruleFamilyId() || String(draft.baseRevision) !== String(this._rulesBaseRevision) || !draft.rules) return;
    wx.showModal({
      title: '发现未保存的规则草稿',
      content: '草稿保存于 ' + (this._formatDraftTime(draft.savedAt) || '本机') + '，是否恢复继续编辑？',
      confirmText: '恢复草稿',
      cancelText: '放弃草稿',
      success: function(res) {
        if (!res.confirm) {
          that._clearRuleDraft();
          return;
        }
        that._restoreRuleDraftPayload(draft);
      }
    });
  },

  _restoreRuleDraftPayload: function(draft) {
    if (!draft || !draft.rules) return false;
    var draftRules = deepClone(draft.rules);
    // 草稿可以从旧 revision 安全迁移过来；真正保存时始终使用当前服务端基准版本。
    draftRules.revision = this._rulesBaseRevision;
    var built = this._buildEditableRules(draftRules);
    var firstCategory = this.data.ruleType === 'special' || !built.edit[this.data.ruleType][0]
      ? '' : built.edit[this.data.ruleType][0]._uiKey;
    this._rulesDirtyKeys = { restoredDraft: true };
    this.setData({
      editRules: built.edit,
      expandedRuleCategory: firstCategory,
      ruleStats: this._countRules(built.edit),
      ruleDirty: true,
      ruleChangeCount: 1,
      draftRestored: true,
      draftSavedAt: this._formatDraftTime(draft.savedAt),
      ruleConflict: false,
      conflictRevision: null,
      ruleValidationMessage: ''
    });
    this._enableRuleUnloadAlert();
    this._scheduleRuleDraftSave();
    return true;
  },

  _enableRuleUnloadAlert: function() {
    if (this._unloadAlertEnabled || !wx.enableAlertBeforeUnload) return;
    try {
      wx.enableAlertBeforeUnload({ message: '规则还有未完成或未保存的修改，确认要离开吗？' });
      this._unloadAlertEnabled = true;
    } catch (error) {}
  },

  _disableRuleUnloadAlert: function() {
    if (!this._unloadAlertEnabled || !wx.disableAlertBeforeUnload) return;
    try { wx.disableAlertBeforeUnload({}); } catch (error) {}
    this._unloadAlertEnabled = false;
  },

  // ========== Tab 切换 ==========
  switchTab: function(e) {
    var that = this;
    var nextTab = e.currentTarget.dataset.tab;
    if (this.data.adminTab === 'rules' && nextTab !== 'rules' && this.data.ruleDirty) {
      this._saveRuleDraftNow();
      wx.showModal({
        title: '规则尚未保存',
        content: '已自动暂存在本机。可以离开，稍后回到规则页继续编辑。',
        confirmText: '暂存离开',
        cancelText: '继续编辑',
        success: function(res) { if (res.confirm) that.setData({ adminTab: nextTab }); }
      });
      return;
    }
    this.setData({ adminTab: nextTab });
  },

  // ========== 用户管理 ==========
  onUserName: function(e) {
    var idx = parseInt(e.currentTarget.dataset.index);
    var key = 'userList[' + idx + '].editName';
    this.setData({ [key]: e.detail.value });
  },
  onUserPwd: function(e) {
    var idx = parseInt(e.currentTarget.dataset.index);
    var key = 'userList[' + idx + '].editPwd';
    this.setData({ [key]: e.detail.value });
  },
  onUserRole: function(e) {
    var idx = parseInt(e.currentTarget.dataset.index);
    var ri = parseInt(e.detail.value);
    var roles = ['管理员', '家长', '孩子'];
    this.setData({
      ['userList[' + idx + '].roleIdx']: ri,
      ['userList[' + idx + '].roleName']: roles[ri],
      ['userList[' + idx + '].role']: ['admin', 'parent', 'child'][ri]
    });
  },

  onKidSkin: function(e) {
    var idx = Number(e.currentTarget.dataset.index);
    var skinIdx = Number(e.detail.value);
    var user = this.data.userList[idx];
    if (!user || user.roleIdx !== 2 || (skinIdx !== 0 && skinIdx !== 1)) return;
    var skin = skinIdx === 1 ? 'star' : 'classic';
    app.setKidSkin(user.id, skin);
    this.setData({
      ['userList[' + idx + '].skin']: skin,
      ['userList[' + idx + '].skinIdx']: skinIdx
    });
    this.showToast('已为' + user.editName + '切换为' + this.data.skinOptions[skinIdx]);
  },

  saveUser: function(e) {
    var that = this;
    var idx = parseInt(e.currentTarget.dataset.index);
    var u = this.data.userList[idx];
    var roleMap = ['admin', 'parent', 'child'];
    var updatedUser = {
      id: u.id,
      name: u.editName,
      role: roleMap[u.roleIdx],
      password: u.editPwd || u.password
    };
    var users = this.data.userList.map(function(item, i) {
      if (i === idx) return updatedUser;
      return { id: item.id, name: item.editName, role: roleMap[item.roleIdx], password: item.editPwd || item.password };
    });

    app.fetchAPI('/api/config/users', {
      method: 'POST',
      body: JSON.stringify({ token: app.globalData.token, users: users })
    }).then(function(res) {
      if (res.success) {
        that.showToast('「' + updatedUser.name + '」已保存');
        app.globalData.allUsers = res.users;
        that.loadData();
      } else {
        that.showToast(res.message || '保存失败');
      }
    });
  },

  deleteUser: function(e) {
    var that = this;
    var idx = parseInt(e.currentTarget.dataset.index);
    var name = this.data.userList[idx].editName;
    wx.showModal({
      title: '确认删除',
      content: '确定删除 ' + name + ' 吗？',
      success: function(res) {
        if (res.confirm) {
          var roleMap = ['admin', 'parent', 'child'];
          var users = that.data.userList.filter(function(_, i) { return i !== idx; })
            .map(function(u) { return { id: u.id, name: u.editName, role: roleMap[u.roleIdx], password: u.editPwd || u.password }; });
          app.fetchAPI('/api/config/users', {
            method: 'POST',
            body: JSON.stringify({ token: app.globalData.token, users: users })
          }).then(function(res) {
            if (res.success) {
              that.showToast('已删除');
              app.globalData.allUsers = res.users;
              that.loadData();
            }
          });
        }
      }
    });
  },

  onNewUid: function(e) { this.setData({ newUid: e.detail.value }); },
  onNewName: function(e) { this.setData({ newName: e.detail.value }); },
  onNewPwd: function(e) { this.setData({ newPwd: e.detail.value }); },
  onNewRole: function(e) {
    var ri = parseInt(e.detail.value);
    var roles = ['管理员', '家长', '孩子'];
    this.setData({ newRoleIdx: ri, newRoleName: roles[ri] });
  },

  addUser: function() {
    var that = this;
    var uid = this.data.newUid.trim();
    var name = this.data.newName.trim();
    var pwd = this.data.newPwd.trim();
    if (!uid || !name || !pwd) { this.showToast('请填写完整'); return; }

    var roleMap = ['admin', 'parent', 'child'];
    var users = this.data.userList.map(function(u) {
      return { id: u.id, name: u.editName, role: roleMap[u.roleIdx], password: u.editPwd || u.password };
    });
    users.push({ id: uid, name: name, password: pwd, role: roleMap[this.data.newRoleIdx] });

    app.fetchAPI('/api/config/users', {
      method: 'POST',
      body: JSON.stringify({ token: app.globalData.token, users: users })
    }).then(function(res) {
      if (res.success) {
        app.globalData.allUsers = res.users;
        that.setData({ newUid: '', newName: '', newPwd: '', newRoleIdx: 2 });
        that.showToast('已添加');
        that.loadData();
      } else {
        that.showToast(res.message || '添加失败');
      }
    });
  },

  // ========== 规则管理 ==========
  _countRules: function(rules) {
    var result = { reward: 0, punish: 0, special: 0 };
    ['reward', 'punish'].forEach(function(type) {
      result[type] = (rules[type] || []).reduce(function(total, cat) {
        return total + (Array.isArray(cat.items) ? cat.items.length : 0);
      }, 0);
    });
    result.special = (rules.special || []).filter(function(text) {
      return typeof text === 'string' && text.trim();
    }).length;
    return result;
  },

  _decorateRuleDraft: function(rules) {
    ['reward', 'punish'].forEach(function(type) {
      (rules[type] || []).forEach(function(cat, ci) {
        cat._uiKey = type + '_cat_' + String(cat.id || ci);
        cat._uiCanMoveUp = ci > 0;
        cat._uiCanMoveDown = ci < (rules[type] || []).length - 1;
        cat.items = Array.isArray(cat.items) ? cat.items : [];
        cat._uiItemCount = cat.items.length;
        cat._uiPreview = cat.items.slice(0, 3).map(function(item) {
          return String(item.editLabel || item.label || '').trim();
        }).filter(Boolean).join('、');
        cat.items.forEach(function(item, ii) {
          item._uiKey = type + '_item_' + String(item.id || (String(cat.id || ci) + '_' + ii));
          item._uiScoreText = scoreText(type, item.editDefault);
          item._uiCanMoveUp = ii > 0;
          item._uiCanMoveDown = ii < cat.items.length - 1;
        });
      });
    });
  },

  _markRulesDirty: function(key) {
    this._rulesDirtyKeys = this._rulesDirtyKeys || {};
    this._rulesDirtyKeys[key] = true;
    this.setData({
      ruleDirty: true,
      ruleChangeCount: Object.keys(this._rulesDirtyKeys).length,
      ruleValidationMessage: ''
    });
    this._enableRuleUnloadAlert();
    this._scheduleRuleDraftSave();
  },

  _refreshRuleDraft: function(extra) {
    var rules = this.data.editRules;
    this._decorateRuleDraft(rules);
    this.setData(Object.assign({
      editRules: rules,
      ruleStats: this._countRules(rules)
    }, extra || {}));
  },

  _ruleMutationBlocked: function() {
    return !!this.data.rulesSaving;
  },

  openRuleHistory: function() {
    if (this._ruleMutationBlocked()) return;
    if (this.data.ruleDirty || this.data.ruleEditorDirty) {
      wx.showModal({
        title: '请先处理当前修改',
        content: '为避免历史恢复覆盖正在编辑的内容，请先保存或放弃当前规则草稿，再查看历史版本。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    wx.navigateTo({ url: '/pages/rule-history/rule-history' });
  },

  switchRuleType: function(e) {
    var type = e.currentTarget.dataset.type;
    if (['reward', 'punish', 'special'].indexOf(type) < 0) return;
    var firstCategory = type === 'special' || !this.data.editRules[type][0]
      ? ''
      : this.data.editRules[type][0]._uiKey;
    this.setData({ ruleType: type, expandedRuleCategory: firstCategory, ruleValidationMessage: '' });
  },

  toggleRuleCategory: function(e) {
    var key = e.currentTarget.dataset.key;
    this.setData({ expandedRuleCategory: this.data.expandedRuleCategory === key ? '' : key });
  },

  onCategoryName: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var value = e.detail.value;
    if (!this.data.editRules[type] || !this.data.editRules[type][ci]) return;
    this.setData({ ['editRules.' + type + '[' + ci + '].category']: value });
    this._markRulesDirty('category:' + type + ':' + ci);
  },

  onNewRCat: function(e) { if (!this._ruleMutationBlocked()) this.setData({ newRCatName: e.detail.value }); },
  onNewPCat: function(e) { if (!this._ruleMutationBlocked()) this.setData({ newPCatName: e.detail.value }); },

  _categoryIdExists: function(id) {
    return ['reward', 'punish'].some(function(type) {
      return (this.data.editRules[type] || []).some(function(cat) {
        if (String(cat.id || '') === id) return true;
        return (cat.items || []).some(function(item) { return String(item.id || '') === id; });
      });
    }, this);
  },

  _newCategoryId: function(type) {
    var base = 'cat_' + type.charAt(0) + '_' + Date.now().toString(36);
    var candidate = base;
    var suffix = 1;
    while (this._categoryIdExists(candidate)) candidate = base + '_' + suffix++;
    return candidate;
  },

  addRCategory: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    if (type !== 'reward' && type !== 'punish') return;
    var sourceKey = type === 'reward' ? 'newRCatName' : 'newPCatName';
    var name = String(this.data[sourceKey] || '').trim();
    if (!name) { this.showToast('请填写分类名称'); return; }
    if (name.length > RULE_LIMITS.category) { this.showToast('分类名称最多 ' + RULE_LIMITS.category + ' 个字'); return; }
    var arr = this.data.editRules[type].slice();
    var newCat = {
      _source: {},
      _uiKey: type + '_cat_' + Date.now(),
      id: this._newCategoryId(type),
      category: name,
      items: []
    };
    arr.push(newCat);
    this.data.editRules[type] = arr;
    this._refreshRuleDraft({
      expandedRuleCategory: type + '_cat_' + newCat.id,
      newRCatName: type === 'reward' ? '' : this.data.newRCatName,
      newPCatName: type === 'punish' ? '' : this.data.newPCatName
    });
    this._markRulesDirty('add-category:' + type + ':' + Date.now());
  },

  delRCategory: function(e) {
    if (this._ruleMutationBlocked()) return;
    var that = this;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var cat = this.data.editRules[type] && this.data.editRules[type][ci];
    if (!cat) return;
    wx.showModal({
      title: '删除整个分类？',
      content: '「' + (cat.category || '未命名分类') + '」中的 ' + cat.items.length + ' 条规则也会一起删除。',
      confirmColor: '#D96262',
      success: function(res) {
        if (!res.confirm) return;
        that.data.editRules[type] = that.data.editRules[type].filter(function(_, index) { return index !== ci; });
        that._refreshRuleDraft({ expandedRuleCategory: '' });
        that._markRulesDirty('delete-category:' + type + ':' + Date.now());
      }
    });
  },

  _rawItemFromDraft: function(type, item) {
    var min = integerValue(item.editMin);
    var max = integerValue(item.editMax);
    var defaultValue = integerValue(item.editDefault);
    var isPunish = type === 'punish';
    var currentFields = {};
    Object.keys(item || {}).forEach(function(key) {
      if (key === '_source' || key.indexOf('_ui') === 0 || key.indexOf('edit') === 0) return;
      currentFields[key] = deepClone(item[key]);
    });
    return Object.assign({}, deepClone(item._source || {}), currentFields, {
      id: String(item.id || '').trim(),
      label: String(item.editLabel || '').trim(),
      min: isPunish ? -max : min,
      max: isPunish ? -min : max,
      default: isPunish ? -defaultValue : defaultValue,
      unit: String(item.editUnit || '').trim(),
      hint: String(item.editHint || '').trim()
    });
  },

  _rawCategoryFromDraft: function(type, cat) {
    var category = Object.assign({}, deepClone(cat._source || {}), {
      id: String(cat.id || '').trim(),
      category: String(cat.category || '').trim(),
      items: (cat.items || []).map(function(item) { return this._rawItemFromDraft(type, item); }, this)
    });
    var originalName = String((cat._source && cat._source.category) || '').trim();
    if (originalName && originalName !== category.category) {
      category.aliases = aliasesWithPreviousName(category.aliases, originalName, category.category, RULE_LIMITS.category);
    }
    return category;
  },

  copyCategory: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var cat = this.data.editRules[type] && this.data.editRules[type][ci];
    if (!cat) return;
    var raw = deepClone(this._rawCategoryFromDraft(type, cat));
    raw.id = this._newCategoryId(type);
    raw.category = (String(raw.category || '未命名分类') + ' 副本').slice(0, RULE_LIMITS.category);
    raw.aliases = [];
    raw.items = (raw.items || []).map(function(item) {
      item.id = this._newRuleId(type);
      return item;
    }, this);
    var copied = deepClone(raw);
    copied._source = raw;
    copied.items = raw.items.map(function(item) { return editableItemFromRaw(item, type); });
    this.data.editRules[type].splice(ci + 1, 0, copied);
    this._refreshRuleDraft({ expandedRuleCategory: type + '_cat_' + raw.id });
    this._markRulesDirty('copy-category:' + type + ':' + raw.id);
    this.showToast('已复制分类和其中规则');
  },

  moveCategory: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var direction = Number(e.currentTarget.dataset.direction);
    var list = this.data.editRules[type];
    var target = ci + direction;
    if (!list || target < 0 || target >= list.length) return;
    var moved = list.splice(ci, 1)[0];
    list.splice(target, 0, moved);
    this._refreshRuleDraft({ expandedRuleCategory: type + '_cat_' + moved.id });
    this._markRulesDirty('sort-category:' + type + ':' + moved.id + ':' + target);
  },

  _newRuleId: function(type) {
    var prefix = type === 'punish' ? 'p_' : 'r_';
    this._localIdCounter = (this._localIdCounter || 0) + 1;
    var base = prefix + Date.now().toString(36) + '_' + this._localIdCounter.toString(36);
    var candidate = base;
    var suffix = 1;
    while (this._ruleIdExists(candidate, type, -1, -1)) {
      candidate = base + '_' + suffix;
      suffix++;
    }
    return candidate;
  },

  _editorFromItem: function(type, ci, ii, item) {
    var isPunish = type === 'punish';
    return {
      type: type,
      typeTitle: isPunish ? '编辑护糖提醒' : '编辑鼓励规则',
      scoreLabel: isPunish ? '通常扣除' : '通常奖励',
      rangeMinLabel: isPunish ? '最低扣分' : '最低分',
      rangeMaxLabel: isPunish ? '最高扣分' : '最高分',
      ci: ci,
      ii: ii,
      isNew: false,
      id: item.id,
      editLabel: item.editLabel,
      editDefault: item.editDefault,
      editUnit: item.editUnit,
      editHint: item.editHint,
      editMin: item.editMin,
      editMax: item.editMax,
      errors: {}
    };
  },

  openRuleEditor: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var ii = Number(e.currentTarget.dataset.ii);
    var category = this.data.editRules[type] && this.data.editRules[type][ci];
    var item = category && category.items[ii];
    if (!item) return;
    this.setData({
      ruleEditor: this._editorFromItem(type, ci, ii, item),
      ruleEditorVisible: true,
      ruleEditorAdvanced: false,
      ruleEditorDirty: false
    });
  },

  addRItem: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    if (!this.data.editRules[type] || !this.data.editRules[type][ci]) return;
    this._openNewRuleEditor(type, ci, null);
  },

  _openNewRuleEditor: function(type, ci, template) {
    var isPunish = type === 'punish';
    template = template || {};
    this.setData({
      ruleEditor: {
        type: type,
        typeTitle: isPunish ? '新增护糖提醒' : '新增鼓励规则',
        scoreLabel: isPunish ? '通常扣除' : '通常奖励',
        rangeMinLabel: isPunish ? '最低扣分' : '最低分',
        rangeMaxLabel: isPunish ? '最高扣分' : '最高分',
        ci: ci,
        ii: -1,
        isNew: true,
        id: this._newRuleId(type),
        editLabel: isPunish ? (template.punishLabel || '') : (template.rewardLabel || ''),
        editDefault: template.default === undefined ? 5 : template.default,
        editUnit: template.unit || '',
        editHint: template.hint || '',
        editMin: template.min === undefined ? (isPunish ? 1 : 0) : template.min,
        editMax: template.max === undefined ? 10 : template.max,
        errors: {}
      },
      ruleEditorVisible: true,
      ruleEditorAdvanced: false,
      ruleEditorDirty: false
    });
  },

  useRuleTemplate: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var templateId = e.currentTarget.dataset.template;
    var template = RULE_TEMPLATES.find(function(item) { return item.id === templateId; });
    if (!template || !this.data.editRules[type] || !this.data.editRules[type][ci]) return;
    this._openNewRuleEditor(type, ci, template);
    this.setData({ ruleEditorDirty: true });
    this._enableRuleUnloadAlert();
  },

  copyRule: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var ii = Number(e.currentTarget.dataset.ii);
    var cat = this.data.editRules[type] && this.data.editRules[type][ci];
    var item = cat && cat.items[ii];
    if (!item) return;
    var raw = deepClone(this._rawItemFromDraft(type, item));
    raw.id = this._newRuleId(type);
    raw.label = (String(raw.label || '未命名规则') + ' 副本').slice(0, RULE_LIMITS.label);
    raw.aliases = [];
    cat.items.splice(ii + 1, 0, editableItemFromRaw(raw, type));
    this._refreshRuleDraft();
    this._markRulesDirty('copy-item:' + type + ':' + raw.id);
    this.showToast('已复制规则');
  },

  moveRuleToCategory: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var ii = Number(e.currentTarget.dataset.ii);
    var targetCi = Number(e.detail.value);
    var categories = this.data.editRules[type];
    if (!categories || !categories[ci] || !categories[targetCi] || ci === targetCi) return;
    var moved = categories[ci].items.splice(ii, 1)[0];
    if (!moved) return;
    categories[targetCi].items.push(moved);
    this._refreshRuleDraft({ expandedRuleCategory: type + '_cat_' + categories[targetCi].id });
    this._markRulesDirty('move-item:' + type + ':' + moved.id + ':' + targetCi);
    this.showToast('已移动到「' + categories[targetCi].category + '」');
  },

  moveRule: function(e) {
    if (this._ruleMutationBlocked()) return;
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var ii = Number(e.currentTarget.dataset.ii);
    var direction = Number(e.currentTarget.dataset.direction);
    var cat = this.data.editRules[type] && this.data.editRules[type][ci];
    var target = ii + direction;
    if (!cat || target < 0 || target >= cat.items.length) return;
    var moved = cat.items.splice(ii, 1)[0];
    cat.items.splice(target, 0, moved);
    this._refreshRuleDraft();
    this._markRulesDirty('sort-item:' + type + ':' + moved.id + ':' + target);
  },

  onRuleEditorInput: function(e) {
    if (this._ruleMutationBlocked()) return;
    var field = e.currentTarget.dataset.field;
    if (['id', 'editLabel', 'editDefault', 'editUnit', 'editHint', 'editMin', 'editMax'].indexOf(field) < 0) return;
    this.setData({
      ['ruleEditor.' + field]: e.detail.value,
      ['ruleEditor.errors.' + field]: '',
      ruleEditorDirty: true
    });
    this._enableRuleUnloadAlert();
  },

  onRuleScoreQuick: function(e) {
    if (this._ruleMutationBlocked()) return;
    var value = Number(e.currentTarget.dataset.value);
    var min = integerValue(this.data.ruleEditor && this.data.ruleEditor.editMin);
    var max = integerValue(this.data.ruleEditor && this.data.ruleEditor.editMax);
    var update = {
      'ruleEditor.editDefault': value,
      'ruleEditor.errors.editDefault': '',
      ruleEditorDirty: true
    };
    if (min !== null && value < min) update['ruleEditor.editMin'] = value;
    if (max !== null && value > max) update['ruleEditor.editMax'] = value;
    this.setData(update);
    this._enableRuleUnloadAlert();
  },

  toggleRuleEditorAdvanced: function() {
    this.setData({ ruleEditorAdvanced: !this.data.ruleEditorAdvanced });
  },

  _ruleIdExists: function(id, editingType, editingCi, editingIi) {
    var found = false;
    ['reward', 'punish'].forEach(function(type) {
      (this.data.editRules[type] || []).forEach(function(cat, ci) {
        if (String(cat.id || '').trim() === id) found = true;
        (cat.items || []).forEach(function(item, ii) {
          if (type === editingType && ci === editingCi && ii === editingIi) return;
          if (String(item.id || '').trim() === id) found = true;
        });
      });
    }, this);
    return found;
  },

  _validateRuleEditor: function(editor) {
    var errors = {};
    var label = String(editor.editLabel || '').trim();
    var unit = String(editor.editUnit || '');
    var hint = String(editor.editHint || '');
    var id = String(editor.id || '').trim();
    var min = integerValue(editor.editMin);
    var max = integerValue(editor.editMax);
    var defaultValue = integerValue(editor.editDefault);
    var upper = editor.type === 'punish' ? 500 : 1000;
    var lower = editor.type === 'punish' ? 1 : 0;

    if (!label) errors.editLabel = '请填写规则名称';
    else if (label.length > RULE_LIMITS.label) errors.editLabel = '规则名称最多 ' + RULE_LIMITS.label + ' 个字';
    if (unit.length > RULE_LIMITS.unit) errors.editUnit = '计算方式最多 ' + RULE_LIMITS.unit + ' 个字';
    if (hint.length > RULE_LIMITS.hint) errors.editHint = '规则说明最多 ' + RULE_LIMITS.hint + ' 个字';
    if (!id) errors.id = '规则 ID 不能为空';
    else if (!RULE_ID_PATTERN.test(id)) errors.id = '规则 ID 需为 2～64 位字母、数字、下划线或短横线';
    else if (this._ruleIdExists(id, editor.type, editor.ci, editor.ii)) errors.id = '规则 ID 必须唯一';

    if (defaultValue === null) errors.editDefault = '通常分值必须是整数';
    else if (defaultValue < lower || defaultValue > upper) {
      errors.editDefault = editor.type === 'punish' ? '扣分须为 1～500' : '加分须为 0～1000';
    }
    if (min === null) errors.editMin = '最低分必须是整数';
    else if (min < lower || min > upper) errors.editMin = editor.type === 'punish' ? '最低扣分须为 1～500' : '最低分须为 0～1000';
    if (max === null) errors.editMax = '最高分必须是整数';
    else if (max < lower || max > upper) errors.editMax = editor.type === 'punish' ? '最高扣分须为 1～500' : '最高分须为 0～1000';
    if (min !== null && max !== null && min > max) errors.editMax = '最高分不能小于最低分';
    if (min !== null && max !== null && defaultValue !== null && (defaultValue < min || defaultValue > max)) {
      errors.editDefault = '通常分值必须在最低分和最高分之间';
    }

    var first = ['editLabel', 'editDefault', 'editUnit', 'editHint', 'editMin', 'editMax', 'id'].find(function(field) {
      return !!errors[field];
    });
    return {
      valid: !first,
      errors: errors,
      message: first ? errors[first] : '',
      values: { label: label, unit: unit.trim(), hint: hint.trim(), id: id, min: min, max: max, defaultValue: defaultValue }
    };
  },

  completeRuleEditor: function() {
    if (this._ruleMutationBlocked()) return;
    var editor = this.data.ruleEditor;
    if (!editor) return;
    var validation = this._validateRuleEditor(editor);
    if (!validation.valid) {
      this.setData({
        'ruleEditor.errors': validation.errors,
        ruleEditorAdvanced: !!(validation.errors.editMin || validation.errors.editMax || validation.errors.id),
        ruleValidationMessage: validation.message
      });
      return;
    }

    var currentCategory = this.data.editRules[editor.type] && this.data.editRules[editor.type][editor.ci];
    var currentItem = currentCategory && currentCategory.items[editor.ii];
    var previousLabel = currentItem ? String(currentItem.editLabel || currentItem.label || '').trim() : '';
    if (!editor.isNew && previousLabel && previousLabel !== validation.values.label) {
      var that = this;
      wx.showModal({
        title: '确认规则改名',
        content: '“' + previousLabel + '”将改为“' + validation.values.label + '”。旧名称会保留为兼容别名，历史记录不会被改写。',
        confirmText: '确认改名',
        cancelText: '继续编辑',
        success: function(res) {
          if (res.confirm) that._applyRuleEditorCompletion(editor, validation, previousLabel);
        }
      });
      return;
    }
    this._applyRuleEditorCompletion(editor, validation, '');
  },

  _applyRuleEditorCompletion: function(editor, validation, previousLabel) {

    var type = editor.type;
    var category = this.data.editRules[type][editor.ci];
    if (!category) return;
    var isPunish = type === 'punish';
    var values = validation.values;
    var base = editor.isNew ? { _source: {} } : category.items[editor.ii];
    var updated = Object.assign({}, base, {
      id: values.id,
      label: values.label,
      min: isPunish ? -values.max : values.min,
      max: isPunish ? -values.min : values.max,
      default: isPunish ? -values.defaultValue : values.defaultValue,
      unit: values.unit,
      hint: values.hint,
      editLabel: values.label,
      editMin: values.min,
      editMax: values.max,
      editDefault: values.defaultValue,
      editUnit: values.unit,
      editHint: values.hint
    });
    if (previousLabel) {
      updated.aliases = aliasesWithPreviousName(updated.aliases, previousLabel, values.label, RULE_LIMITS.label);
    }
    if (editor.isNew) category.items.push(updated);
    else category.items.splice(editor.ii, 1, updated);

    this._refreshRuleDraft({
      ruleEditorVisible: false,
      ruleEditorDirty: false,
      ruleEditorAdvanced: false,
      ruleEditor: null
    });
    this._markRulesDirty((editor.isNew ? 'add-item:' : 'edit-item:') + type + ':' + values.id);
  },

  closeRuleEditor: function() {
    if (this._ruleMutationBlocked()) return;
    var that = this;
    var close = function() {
      that.setData({ ruleEditorVisible: false, ruleEditorDirty: false, ruleEditorAdvanced: false, ruleEditor: null });
      if (!that.data.ruleDirty) that._disableRuleUnloadAlert();
    };
    if (!this.data.ruleEditorDirty) { close(); return; }
    wx.showModal({
      title: '放弃本次编辑？',
      content: '尚未点“完成”的内容不会加入规则草稿。',
      confirmText: '放弃',
      confirmColor: '#D96262',
      success: function(res) { if (res.confirm) close(); }
    });
  },

  deleteRuleFromEditor: function() {
    if (this._ruleMutationBlocked()) return;
    var editor = this.data.ruleEditor;
    if (!editor) return;
    if (editor.isNew) { this.closeRuleEditor(); return; }
    var category = this.data.editRules[editor.type][editor.ci];
    var removed = category && category.items.splice(editor.ii, 1)[0];
    if (!removed) return;
    var that = this;
    var categoryId = category.id;
    this._refreshRuleDraft({ ruleEditorVisible: false, ruleEditorDirty: false, ruleEditor: null });
    this._markRulesDirty('delete-item:' + editor.type + ':' + Date.now());
    this._setRuleUndo('已删除“' + (removed.editLabel || removed.label || '未命名规则') + '”', function() {
      var target = (that.data.editRules[editor.type] || []).find(function(cat) { return cat.id === categoryId; });
      if (!target) return;
      target.items.splice(Math.min(editor.ii, target.items.length), 0, removed);
      that._refreshRuleDraft({ expandedRuleCategory: target._uiKey });
      that._markRulesDirty('undo-delete-item:' + editor.type + ':' + Date.now());
    });
  },

  onSpecial: function(e) {
    if (this._ruleMutationBlocked()) return;
    var si = Number(e.currentTarget.dataset.si);
    this.setData({ ['editRules.special[' + si + ']']: e.detail.value });
    this._markRulesDirty('special:' + si);
  },

  addSpecial: function() {
    if (this._ruleMutationBlocked()) return;
    var specials = this.data.editRules.special.slice();
    specials.push('');
    this.setData({ 'editRules.special': specials });
    this._markRulesDirty('add-special:' + Date.now());
  },

  delSpecial: function(e) {
    if (this._ruleMutationBlocked()) return;
    var si = Number(e.currentTarget.dataset.si);
    var specials = this.data.editRules.special.slice();
    var removed = specials.splice(si, 1)[0];
    this.setData({ 'editRules.special': specials, ruleStats: Object.assign({}, this.data.ruleStats, { special: specials.filter(function(text) { return String(text || '').trim(); }).length }) });
    this._markRulesDirty('delete-special:' + Date.now());
    var that = this;
    this._setRuleUndo('已删除第 ' + (si + 1) + ' 条家庭约定', function() {
      var current = that.data.editRules.special.slice();
      current.splice(Math.min(si, current.length), 0, removed);
      that.setData({ 'editRules.special': current, ruleStats: that._countRules(Object.assign({}, that.data.editRules, { special: current })) });
      that._markRulesDirty('undo-delete-special:' + Date.now());
    });
  },

  _setRuleUndo: function(message, action) {
    var that = this;
    clearTimeout(this._undoTimer);
    this._pendingRuleUndo = action;
    this.setData({ undoVisible: true, undoMessage: message });
    this._undoTimer = setTimeout(function() {
      that._pendingRuleUndo = null;
      that.setData({ undoVisible: false, undoMessage: '' });
    }, 6000);
  },

  undoRuleDelete: function() {
    if (this._ruleMutationBlocked()) return;
    var action = this._pendingRuleUndo;
    clearTimeout(this._undoTimer);
    this._pendingRuleUndo = null;
    this.setData({ undoVisible: false, undoMessage: '' });
    if (action) action();
  },

  _validateAllRules: function() {
    var rules = this.data.editRules;
    var categoryIds = {};
    var rootHint = this._ruleSourceRoot && this._ruleSourceRoot.hint;
    if (rootHint !== undefined && rootHint !== null && String(rootHint).length > RULE_LIMITS.hint) {
      return { valid: false, message: '规则总说明最多 ' + RULE_LIMITS.hint + ' 个字' };
    }
    for (var ti = 0; ti < 2; ti++) {
      var type = ['reward', 'punish'][ti];
      for (var ci = 0; ci < rules[type].length; ci++) {
        var cat = rules[type][ci];
        var categoryName = String(cat.category || '').trim();
        var categoryId = String(cat.id || '').trim();
        if (!categoryId) return { valid: false, type: type, ci: ci, message: '分类 ID 不能为空' };
        if (!RULE_ID_PATTERN.test(categoryId)) return { valid: false, type: type, ci: ci, message: '分类 ID 格式无效' };
        if (categoryIds[categoryId]) return { valid: false, type: type, ci: ci, message: '分类 ID 必须唯一' };
        categoryIds[categoryId] = true;
        if (!categoryName) return { valid: false, type: type, ci: ci, message: '请填写分类名称' };
        if (categoryName.length > RULE_LIMITS.category) return { valid: false, type: type, ci: ci, message: '分类名称最多 ' + RULE_LIMITS.category + ' 个字' };
        if (cat.hint !== undefined && cat.hint !== null && String(cat.hint).length > RULE_LIMITS.hint) {
          return { valid: false, type: type, ci: ci, message: '分类说明最多 ' + RULE_LIMITS.hint + ' 个字' };
        }
        for (var ii = 0; ii < cat.items.length; ii++) {
          var validation = this._validateRuleEditor(this._editorFromItem(type, ci, ii, cat.items[ii]));
          if (!validation.valid) {
            return {
              valid: false,
              type: type,
              ci: ci,
              ii: ii,
              errors: validation.errors,
              message: (categoryName || '未命名分类') + '：' + validation.message
            };
          }
        }
      }
    }
    for (var si = 0; si < rules.special.length; si++) {
      var special = rules.special[si];
      if (special !== '' && typeof special !== 'string') return { valid: false, type: 'special', message: '家庭约定必须是文字' };
      if (String(special || '').length > RULE_LIMITS.special) {
        return { valid: false, type: 'special', message: '第 ' + (si + 1) + ' 条家庭约定最多 ' + RULE_LIMITS.special + ' 个字' };
      }
    }
    return { valid: true };
  },

  _serializeRules: function() {
    var draft = this.data.editRules;
    var that = this;
    // 根节点从原始模型 Object.assign，确保未在 UI 展示的未来字段原样保留。
    var output = Object.assign({}, cloneRules(this._ruleSourceRoot || {}));
    output.special = draft.special.map(function(text) { return String(text || '').trim(); }).filter(Boolean);
    ['reward', 'punish'].forEach(function(type) {
      output[type] = draft[type].map(function(cat) {
        return that._rawCategoryFromDraft(type, cat);
      });
    });
    output.revision = this._rulesBaseRevision;
    return output;
  },

  discardRuleChanges: function() {
    if (this._ruleMutationBlocked()) return;
    var that = this;
    if (!this.data.ruleDirty) return;
    wx.showModal({
      title: '放弃全部修改？',
      content: '规则会恢复为最近一次保存成功的内容。',
      confirmText: '放弃修改',
      confirmColor: '#D96262',
      success: function(res) {
        if (!res.confirm) return;
        that._clearRuleDraft();
        that._rulesDirtyKeys = {};
        that.setData({ ruleDirty: false, ruleChangeCount: 0 });
        that._disableRuleUnloadAlert();
        that.loadData({ skipDraftPrompt: true });
      }
    });
  },

  saveRules: function() {
    var that = this;
    if (this.data.rulesSaving) return;
    if (this.data.ruleConflict) {
      this.showToast('请先加载服务端最新规则，再重新应用草稿修改');
      return;
    }
    var validation = this._validateAllRules();
    if (!validation.valid) {
      var update = { ruleValidationMessage: validation.message };
      if (validation.type) update.ruleType = validation.type;
      if (validation.type === 'reward' || validation.type === 'punish') {
        var category = this.data.editRules[validation.type][validation.ci];
        update.expandedRuleCategory = category ? category._uiKey : '';
        if (validation.ii !== undefined) {
          var editor = this._editorFromItem(validation.type, validation.ci, validation.ii, category.items[validation.ii]);
          editor.errors = validation.errors || {};
          update.ruleEditor = editor;
          update.ruleEditorVisible = true;
          update.ruleEditorAdvanced = !!(editor.errors.editMin || editor.errors.editMax || editor.errors.id);
          update.ruleEditorDirty = false;
        }
      }
      this.setData(update);
      this.showToast(validation.message);
      return;
    }

    var rules = this._serializeRules();
    var diff = diffRuleSets(this._ruleServerSnapshot || {}, rules);
    wx.showModal({
      title: '保存前确认修改',
      content: '新增 ' + diff.added + ' 项 · 修改 ' + diff.modified + ' 项 · 删除 ' + diff.removed + ' 项\n保存后将同步给全家使用。',
      confirmText: '确认保存',
      cancelText: '继续检查',
      success: function(res) {
        if (res.confirm) that._commitRules(rules);
      }
    });
  },

  _commitRules: function(rules) {
    var that = this;
    this._saveRuleDraftNow();
    this.setData({ rulesSaving: true, ruleValidationMessage: '' });
    app.fetchAPI('/api/config/rules', {
      method: 'POST',
      body: JSON.stringify({ token: app.globalData.token, rules: rules, revision: this._rulesBaseRevision })
    }).then(function(res) {
      that.setData({ rulesSaving: false });
      if (res.success) {
        that._clearRuleDraft();
        that._rulesDirtyKeys = {};
        that.setData({ ruleDirty: false, ruleChangeCount: 0, ruleConflict: false, conflictRevision: null });
        that._disableRuleUnloadAlert();
        app.globalData.rules = cloneRules(res.rules || rules);
        // 保存后重新读取服务端，避免本机视图与真正持久化结果发生偏差。
        app.fetchAPI('/api/config').then(function(configRes) {
          if (configRes && configRes.success && configRes.rules) {
            app.globalData.rules = cloneRules(configRes.rules);
            if (configRes.users) app.globalData.allUsers = configRes.users;
          }
          that.loadData({ skipDraftPrompt: true });
          that.showToast('整套规则已保存');
        });
      } else if (res.code === 'RULES_REVISION_CONFLICT') {
        that._handleRevisionConflict(res);
      } else {
        var location = res.field ? '（' + res.field + '）' : '';
        that.setData({ ruleValidationMessage: (res.message || '保存失败') + location });
        that.showToast((res.message || '保存失败') + location);
      }
    }).catch(function() {
      that.setData({ rulesSaving: false });
      that.showToast('保存失败，请稍后重试');
    });
  },

  _handleRevisionConflict: function(res) {
    var that = this;
    this._conflictRules = res.rules ? cloneRules(res.rules) : null;
    this._conflictDraft = this._serializeRules();
    var latestRevision = res.currentRevision === undefined ? res.revision : res.currentRevision;
    this.setData({
      ruleConflict: true,
      conflictRevision: latestRevision,
      ruleValidationMessage: '规则已被其他管理员更新，请先加载最新版本。当前草稿仍安全保存在本机。'
    });
    this._saveRuleDraftNow();
    wx.showModal({
      title: '发现更新冲突',
      content: '另一位管理员已保存新规则。你的草稿没有丢失，可加载最新规则后重新核对修改。',
      confirmText: '加载最新',
      cancelText: '保留草稿',
      success: function(modalRes) {
        if (modalRes.confirm) that.loadLatestRules();
        else that.showToast('草稿已保留，未覆盖服务端');
      }
    });
  },

  loadLatestRules: function() {
    var that = this;
    var oldDraftKey = this._ruleDraftKey();
    var conflictDraft = this._conflictDraft || (this.data.ruleDirty ? this._serializeRules() : null);
    var applyLatest = function(rules) {
      if (!rules) { that.showToast('暂时无法加载最新规则'); return; }
      that._rulesDirtyKeys = {};
      that.setData({ ruleDirty: false, ruleChangeCount: 0, ruleConflict: false, conflictRevision: null });
      that._disableRuleUnloadAlert();
      app.globalData.rules = cloneRules(rules);
      that._conflictRules = null;
      that.loadData({ skipDraftPrompt: true });

      if (!conflictDraft) {
        that.showToast('已加载服务端最新规则');
        return;
      }

      // 先把冲突草稿迁移到最新 revision 的隔离 key，成功后才移除旧 key。
      var migratedRules = cloneRules(conflictDraft);
      migratedRules.revision = that._rulesBaseRevision;
      var savedAt = Date.now();
      var migratedDraft = {
        familyId: that._ruleFamilyId(),
        baseRevision: that._rulesBaseRevision,
        savedAt: savedAt,
        rules: migratedRules
      };
      var newDraftKey = that._ruleDraftKey();
      try {
        wx.setStorageSync(newDraftKey, migratedDraft);
        if (oldDraftKey !== newDraftKey) wx.removeStorageSync(oldDraftKey);
      } catch (error) {
        that.showToast('最新版已加载，但草稿迁移失败，请勿退出并重新检查修改');
        that._restoreRuleDraftPayload(migratedDraft);
        return;
      }
      that._conflictDraft = null;
      wx.showModal({
        title: '最新版已加载',
        content: '原草稿已安全迁移到新版本。可立即恢复并逐项核对，也可以先查看服务端最新版，稍后回来恢复。',
        confirmText: '恢复草稿',
        cancelText: '查看最新',
        success: function(modalRes) {
          if (modalRes.confirm) that._restoreRuleDraftPayload(migratedDraft);
          else that.showToast('已保留草稿，未覆盖服务端');
        }
      });
    };
    if (this._conflictRules) { applyLatest(this._conflictRules); return; }
    app.fetchAPI('/api/config').then(function(res) {
      if (res && res.success) applyLatest(res.rules);
      else that.showToast((res && res.message) || '加载最新规则失败');
    });
  },

  // ========== 数据清理 ==========
  onCleanupKid: function(e) {
    this.setData({ cleanupKidIdx: parseInt(e.detail.value), cleanupPreviewCount: -1 });
  },
  onCleanupBefore: function(e) {
    this.setData({ cleanupBefore: e.detail.value, cleanupPreviewCount: -1 });
  },
  onCleanupAfter: function(e) {
    this.setData({ cleanupAfter: e.detail.value, cleanupPreviewCount: -1 });
  },

  onCleanupPreview: function() {
    var that = this;
    app.fetchAPI('/api/history').then(function(data) {
      var history = data.history || [];
      var kid = that.data.cleanupKidOptions[that.data.cleanupKidIdx];
      var kidId = kid && kid.id !== 'all' ? kid.id : '';
      var before = that.data.cleanupBefore;
      var after = that.data.cleanupAfter;
      var count = 0;
      history.forEach(function(r) {
        if (kidId && r.kid !== kidId) return;
        var rDate = r.time ? r.time.split(' ')[0].replace(/\//g, '-') : '';
        if (before && rDate > before) return;
        if (after && rDate < after) return;
        count++;
      });
      that.setData({ cleanupPreviewCount: count });
    });
  },

  onCleanupExec: function() {
    var that = this;
    var kid = this.data.cleanupKidOptions[this.data.cleanupKidIdx];
    var kidId = kid && kid.id !== 'all' ? kid.id : '';
    var kidName = kid ? kid.name : '所有孩子';

    wx.showModal({
      title: '确认清理',
      content: '确定要清理「' + kidName + '」在指定时间范围内的 ' + (this.data.cleanupPreviewCount >= 0 ? this.data.cleanupPreviewCount + ' 条' : '') + '记录吗？此操作不可撤销！',
      success: function(res) {
        if (!res.confirm) return;
        app.fetchAPI('/api/history/cleanup', {
          method: 'POST',
          body: JSON.stringify({
            token: app.globalData.token,
            kid: kidId || undefined,
            beforeDate: that.data.cleanupBefore || undefined,
            afterDate: that.data.cleanupAfter || undefined
          })
        }).then(function(result) {
          that.showToast(result.message || '清理完成');
          that.setData({ cleanupPreviewCount: -1 });
        });
      }
    });
  },

  goBack: function() {
    wx.navigateBack();
  },

  noop: function() {},

  // ========== Toast ==========
  showToast: function(msg) {
    var that = this;
    this.setData({ toastMessage: msg, toastVisible: true });
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function() {
      that.setData({ toastVisible: false });
    }, 2000);
  }
});
