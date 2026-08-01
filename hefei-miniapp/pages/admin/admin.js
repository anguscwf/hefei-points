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
  id: 64
};

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

  // ========== 加载数据 ==========
  loadData: function() {
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

    // cloneRules 会保留根节点、分类和规则项上的全部未知字段；编辑字段只作为临时视图数据。
    var sourceRules = cloneRules(g.rules || { reward: [], punish: [], special: [] });
    var editRules = cloneRules(sourceRules);
    this._ruleSourceRoot = sourceRules;
    ['reward', 'punish'].forEach(function(type) {
      editRules[type].forEach(function(cat, ci) {
        var sourceCat = sourceRules[type][ci] || {};
        var sourceItems = Array.isArray(sourceCat.items) ? sourceCat.items : [];
        cat._source = sourceCat;
        cat.items = Array.isArray(cat.items) ? cat.items : [];
        cat._uiKey = type + '_cat_' + ci;
        cat.items.forEach(function(item, ii) {
          var isPunish = type === 'punish';
          var storedMin = integerValue(item.min);
          var storedMax = integerValue(item.max);
          var storedDefault = integerValue(item.default);
          item._source = sourceItems[ii] || {};
          item._uiKey = type + '_item_' + ci + '_' + ii;
          item.editLabel = item.label === undefined || item.label === null ? '' : String(item.label);
          // 扣分编辑器只呈现正数绝对值：最低扣分=abs(stored max)，最高扣分=abs(stored min)。
          item.editMin = isPunish ? (storedMax === null ? '' : Math.abs(storedMax)) : (storedMin === null ? '' : storedMin);
          item.editMax = isPunish ? (storedMin === null ? '' : Math.abs(storedMin)) : (storedMax === null ? '' : storedMax);
          item.editDefault = storedDefault === null ? '' : (isPunish ? Math.abs(storedDefault) : storedDefault);
          item.editUnit = item.unit === undefined || item.unit === null ? '' : String(item.unit);
          item.editHint = item.hint === undefined || item.hint === null ? '' : String(item.hint);
          item._uiScoreText = scoreText(type, item.editDefault);
        });
      });
    });

    this._rulesDirtyKeys = {};
    this._decorateRuleDraft(editRules);
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
      cleanupKidOptions: [{ id: 'all', name: '所有孩子' }].concat(
        allUsers.filter(function(u) { return u.role === 'child'; }).map(function(u) { return { id: u.id, name: u.name }; })
      )
    });
  },

  // ========== Tab 切换 ==========
  switchTab: function(e) {
    this.setData({ adminTab: e.currentTarget.dataset.tab });
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
        cat._uiKey = type + '_cat_' + ci;
        cat.items = Array.isArray(cat.items) ? cat.items : [];
        cat._uiItemCount = cat.items.length;
        cat._uiPreview = cat.items.slice(0, 3).map(function(item) {
          return String(item.editLabel || item.label || '').trim();
        }).filter(Boolean).join('、');
        cat.items.forEach(function(item, ii) {
          item._uiKey = type + '_item_' + ci + '_' + ii;
          item._uiScoreText = scoreText(type, item.editDefault);
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
  },

  _refreshRuleDraft: function(extra) {
    var rules = this.data.editRules;
    this._decorateRuleDraft(rules);
    this.setData(Object.assign({
      editRules: rules,
      ruleStats: this._countRules(rules)
    }, extra || {}));
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
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    var value = e.detail.value;
    if (!this.data.editRules[type] || !this.data.editRules[type][ci]) return;
    this.setData({ ['editRules.' + type + '[' + ci + '].category']: value });
    this._markRulesDirty('category:' + type + ':' + ci);
  },

  onNewRCat: function(e) { this.setData({ newRCatName: e.detail.value }); },
  onNewPCat: function(e) { this.setData({ newPCatName: e.detail.value }); },

  addRCategory: function(e) {
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
      category: name,
      items: []
    };
    arr.push(newCat);
    this.data.editRules[type] = arr;
    this._refreshRuleDraft({
      expandedRuleCategory: type + '_cat_' + (arr.length - 1),
      newRCatName: type === 'reward' ? '' : this.data.newRCatName,
      newPCatName: type === 'punish' ? '' : this.data.newPCatName
    });
    this._markRulesDirty('add-category:' + type + ':' + Date.now());
  },

  delRCategory: function(e) {
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

  _newRuleId: function(type) {
    var prefix = type === 'punish' ? 'p_' : 'r_';
    var base = prefix + Date.now().toString(36);
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
    var type = e.currentTarget.dataset.type;
    var ci = Number(e.currentTarget.dataset.ci);
    if (!this.data.editRules[type] || !this.data.editRules[type][ci]) return;
    var isPunish = type === 'punish';
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
        editLabel: '',
        editDefault: 5,
        editUnit: '',
        editHint: '',
        // 扣分新增项统一用 1～10 的正数绝对值语义。
        editMin: isPunish ? 1 : 0,
        editMax: 10,
        errors: {}
      },
      ruleEditorVisible: true,
      ruleEditorAdvanced: false,
      ruleEditorDirty: false
    });
  },

  onRuleEditorInput: function(e) {
    var field = e.currentTarget.dataset.field;
    if (['id', 'editLabel', 'editDefault', 'editUnit', 'editHint', 'editMin', 'editMax'].indexOf(field) < 0) return;
    this.setData({
      ['ruleEditor.' + field]: e.detail.value,
      ['ruleEditor.errors.' + field]: '',
      ruleEditorDirty: true
    });
  },

  onRuleScoreQuick: function(e) {
    this.setData({
      'ruleEditor.editDefault': Number(e.currentTarget.dataset.value),
      'ruleEditor.errors.editDefault': '',
      ruleEditorDirty: true
    });
  },

  toggleRuleEditorAdvanced: function() {
    this.setData({ ruleEditorAdvanced: !this.data.ruleEditorAdvanced });
  },

  _ruleIdExists: function(id, editingType, editingCi, editingIi) {
    var found = false;
    ['reward', 'punish'].forEach(function(type) {
      (this.data.editRules[type] || []).forEach(function(cat, ci) {
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
    else if (id.length > RULE_LIMITS.id) errors.id = '规则 ID 过长';
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
    var that = this;
    var close = function() {
      that.setData({ ruleEditorVisible: false, ruleEditorDirty: false, ruleEditorAdvanced: false, ruleEditor: null });
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
    var that = this;
    var editor = this.data.ruleEditor;
    if (!editor) return;
    if (editor.isNew) { this.closeRuleEditor(); return; }
    wx.showModal({
      title: '删除这条规则？',
      content: '删除后需点击底部“保存整套规则”才会生效。',
      confirmColor: '#D96262',
      success: function(res) {
        if (!res.confirm) return;
        var category = that.data.editRules[editor.type][editor.ci];
        category.items = category.items.filter(function(_, index) { return index !== editor.ii; });
        that._refreshRuleDraft({ ruleEditorVisible: false, ruleEditorDirty: false, ruleEditor: null });
        that._markRulesDirty('delete-item:' + editor.type + ':' + Date.now());
      }
    });
  },

  onSpecial: function(e) {
    var si = Number(e.currentTarget.dataset.si);
    this.setData({ ['editRules.special[' + si + ']']: e.detail.value });
    this._markRulesDirty('special:' + si);
  },

  addSpecial: function() {
    var specials = this.data.editRules.special.slice();
    specials.push('');
    this.setData({ 'editRules.special': specials });
    this._markRulesDirty('add-special:' + Date.now());
  },

  delSpecial: function(e) {
    var si = Number(e.currentTarget.dataset.si);
    var specials = this.data.editRules.special.filter(function(_, index) { return index !== si; });
    this.setData({ 'editRules.special': specials, ruleStats: Object.assign({}, this.data.ruleStats, { special: specials.filter(function(text) { return String(text || '').trim(); }).length }) });
    this._markRulesDirty('delete-special:' + Date.now());
  },

  _validateAllRules: function() {
    var rules = this.data.editRules;
    var rootHint = this._ruleSourceRoot && this._ruleSourceRoot.hint;
    if (rootHint !== undefined && rootHint !== null && String(rootHint).length > RULE_LIMITS.hint) {
      return { valid: false, message: '规则总说明最多 ' + RULE_LIMITS.hint + ' 个字' };
    }
    for (var ti = 0; ti < 2; ti++) {
      var type = ['reward', 'punish'][ti];
      for (var ci = 0; ci < rules[type].length; ci++) {
        var cat = rules[type][ci];
        var categoryName = String(cat.category || '').trim();
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
    // 根节点从原始模型 Object.assign，确保未在 UI 展示的未来字段原样保留。
    var output = Object.assign({}, cloneRules(this._ruleSourceRoot || {}));
    output.special = draft.special.map(function(text) { return String(text || '').trim(); }).filter(Boolean);
    ['reward', 'punish'].forEach(function(type) {
      output[type] = draft[type].map(function(cat) {
        var category = Object.assign({}, cat._source || {}, {
          category: String(cat.category || '').trim(),
          items: cat.items.map(function(item) {
            var min = integerValue(item.editMin);
            var max = integerValue(item.editMax);
            var defaultValue = integerValue(item.editDefault);
            var isPunish = type === 'punish';
            // 分类/规则项同样从原始对象覆盖已编辑字段，不重建、不丢 hint 或未知字段。
            return Object.assign({}, item._source || {}, {
              id: String(item.id || '').trim(),
              label: String(item.editLabel || '').trim(),
              min: isPunish ? -max : min,
              max: isPunish ? -min : max,
              default: isPunish ? -defaultValue : defaultValue,
              unit: String(item.editUnit || '').trim(),
              hint: String(item.editHint || '').trim()
            });
          })
        });
        return category;
      });
    });
    return output;
  },

  discardRuleChanges: function() {
    var that = this;
    if (!this.data.ruleDirty) return;
    wx.showModal({
      title: '放弃全部修改？',
      content: '规则会恢复为最近一次保存成功的内容。',
      confirmText: '放弃修改',
      confirmColor: '#D96262',
      success: function(res) {
        if (res.confirm) that.loadData();
      }
    });
  },

  saveRules: function() {
    var that = this;
    if (this.data.rulesSaving) return;
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
    this.setData({ rulesSaving: true, ruleValidationMessage: '' });
    app.fetchAPI('/api/config/rules', {
      method: 'POST',
      body: JSON.stringify({ token: app.globalData.token, rules: rules })
    }).then(function(res) {
      that.setData({ rulesSaving: false });
      if (res.success) {
        app.globalData.rules = cloneRules(res.rules || rules);
        that.loadData();
        that.showToast('整套规则已保存');
      } else {
        that.showToast(res.message || '保存失败');
      }
    }).catch(function() {
      that.setData({ rulesSaving: false });
      that.showToast('保存失败，请稍后重试');
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
