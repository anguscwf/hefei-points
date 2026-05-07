// pages/admin/admin.js
var app = getApp();

Page({
  data: {
    adminTab: 'users',

    // 用户管理
    userList: [],
    roleOptions: ['管理员', '家长', '孩子'],
    newUid: '',
    newName: '',
    newPwd: '',
    newRoleIdx: 2,
    newRoleName: '孩子',

    // 规则管理
    editRules: { reward: [], punish: [], special: [] },
    newRCatName: '',
    newPCatName: '',

    toastMessage: '',
    toastVisible: false,

    // 数据清理
    cleanupKidOptions: [{ id: 'all', name: '所有孩子' }],
    cleanupKidIdx: 0,
    cleanupBefore: '',
    cleanupAfter: '',
    cleanupPreviewCount: -1
  },

  onLoad: function() {
    this.loadData();
  },

  // ========== 加载数据 ==========
  loadData: function() {
    var g = app.globalData;
    var allUsers = g.allUsers || [];
    var roles = ['管理员', '家长', '孩子'];
    var roleMap = { admin: 0, parent: 1, child: 2 };
    var userList = allUsers.map(function(u) {
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        roleIdx: roleMap[u.role] || 2,
        roleName: roles[roleMap[u.role] || 2],
        editName: u.name,
        editPwd: '',
        password: u.password
      };
    });

    // 深拷贝规则用于编辑
    var rules = JSON.parse(JSON.stringify(g.rules || { reward: [], punish: [], special: [] }));
    // 为每个规则项添加编辑字段和唯一键
    var editRules = { reward: [], punish: [], special: rules.special || [] };
    ['reward', 'punish'].forEach(function(type) {
      (rules[type] || []).forEach(function(cat, ci) {
        var catCopy = {
          category: cat.category,
          cid: type + '_cat_' + ci,
          items: (cat.items || []).map(function(item, ii) {
            var isPunish = type === 'punish';
            return {
              id: item.id,
              label: item.label,
              min: item.min,
              max: item.max,
              default: item.default,
              unit: item.unit || '',
              iid: type + '_item_' + ci + '_' + ii,
              editLabel: item.label,
              editMin: isPunish ? Math.abs(item.max) : item.min,
              editMax: isPunish ? Math.abs(item.min) : item.max,
              editDefault: isPunish ? Math.abs(item.default) : item.default,
              editUnit: item.unit || ''
            };
          })
        };
        editRules[type].push(catCopy);
      });
    });

    this.setData({
      userList: userList,
      editRules: editRules,
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
      ['userList[' + idx + '].roleName']: roles[ri]
    });
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
  onRCatName: function(e) {
    var ci = parseInt(e.currentTarget.dataset.ci);
    this.setData({ ['editRules.reward[' + ci + '].category']: e.detail.value });
  },
  onPCatName: function(e) {
    var ci = parseInt(e.currentTarget.dataset.ci);
    this.setData({ ['editRules.punish[' + ci + '].category']: e.detail.value });
  },

  onRLabel: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    this.setData({ ['editRules.' + type + '[' + ci + '].items[' + ii + '].editLabel']: e.detail.value });
  },
  onRMin: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    this.setData({ ['editRules.' + type + '[' + ci + '].items[' + ii + '].editMin']: parseInt(e.detail.value) || 0 });
  },
  onRMax: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    this.setData({ ['editRules.' + type + '[' + ci + '].items[' + ii + '].editMax']: parseInt(e.detail.value) || 0 });
  },
  onRDefault: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    this.setData({ ['editRules.' + type + '[' + ci + '].items[' + ii + '].editDefault']: parseInt(e.detail.value) || 0 });
  },
  onRUnit: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    this.setData({ ['editRules.' + type + '[' + ci + '].items[' + ii + '].editUnit']: e.detail.value });
  },

  onNewRCat: function(e) { this.setData({ newRCatName: e.detail.value }); },
  onNewPCat: function(e) { this.setData({ newPCatName: e.detail.value }); },

  addRCategory: function(e) {
    var type = e.currentTarget.dataset.type;
    var name = type === 'reward' ? this.data.newRCatName.trim() : this.data.newPCatName.trim();
    if (!name) { this.showToast('请输入大类名'); return; }
    var newCat = { category: name, cid: type + '_cat_' + Date.now(), items: [] };
    var key = 'editRules.' + type;
    var arr = this.data.editRules[type].slice();
    arr.push(newCat);
    this.setData({ [key]: arr, newRCatName: '', newPCatName: '' });
  },

  delRCategory: function(e) {
    var that = this;
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var cat = this.data.editRules[type][ci];
    wx.showModal({
      title: '确认删除',
      content: '确定删除大类「' + cat.category + '」及其所有子项吗？',
      success: function(res) {
        if (res.confirm) {
          var arr = that.data.editRules[type].filter(function(_, i) { return i !== ci; });
          that.setData({ ['editRules.' + type]: arr });
        }
      }
    });
  },

  addRItem: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var isP = type === 'punish';
    var newItem = {
      id: 'new_' + Date.now(),
      label: '新项目',
      min: isP ? -10 : 0,
      max: isP ? -1 : 10,
      default: isP ? -5 : 5,
      unit: '',
      iid: type + '_item_' + ci + '_' + Date.now(),
      editLabel: '新项目',
      editMin: isP ? 10 : 0,
      editMax: isP ? 1 : 10,
      editDefault: isP ? 5 : 5,
      editUnit: ''
    };
    var key = 'editRules.' + type + '[' + ci + '].items';
    var items = this.data.editRules[type][ci].items.slice();
    items.push(newItem);
    this.setData({ [key]: items });
  },

  delRItem: function(e) {
    var type = e.currentTarget.dataset.type;
    var ci = parseInt(e.currentTarget.dataset.ci);
    var ii = parseInt(e.currentTarget.dataset.ii);
    var key = 'editRules.' + type + '[' + ci + '].items';
    var items = this.data.editRules[type][ci].items.filter(function(_, i) { return i !== ii; });
    this.setData({ [key]: items });
  },

  onSpecial: function(e) {
    var si = parseInt(e.currentTarget.dataset.si);
    this.setData({ ['editRules.special[' + si + ']']: e.detail.value });
  },
  addSpecial: function() {
    var specials = this.data.editRules.special.slice();
    specials.push('');
    this.setData({ ['editRules.special']: specials });
  },
  delSpecial: function(e) {
    var si = parseInt(e.currentTarget.dataset.si);
    var specials = this.data.editRules.special.filter(function(_, i) { return i !== si; });
    this.setData({ ['editRules.special']: specials });
  },

  saveRules: function() {
    var that = this;
    var editRules = this.data.editRules;

    // 转换成后端格式
    var rules = { special: editRules.special.filter(function(s) { return s.trim() !== ''; }) };
    ['reward', 'punish'].forEach(function(type) {
      rules[type] = editRules[type].map(function(cat) {
        var isP = type === 'punish';
        return {
          category: cat.category,
          items: cat.items.map(function(item) {
            return {
              id: item.id,
              label: item.editLabel,
              min: isP ? -Math.abs(item.editMax || 10) : (item.editMin || 0),
              max: isP ? -Math.abs(item.editMin || 1) : (item.editMax || 10),
              default: isP ? -Math.abs(item.editDefault || 5) : (item.editDefault || 5),
              unit: item.editUnit || ''
            };
          })
        };
      });
    });

    app.fetchAPI('/api/config/rules', {
      method: 'POST',
      body: JSON.stringify({ token: app.globalData.token, rules: rules })
    }).then(function(res) {
      if (res.success) {
        app.globalData.rules = res.rules;
        that.showToast('规则已保存');
      } else {
        that.showToast(res.message || '保存失败');
      }
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
    app.fetchAPI('/api/history?token=' + (app.globalData.token || '')).then(function(data) {
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
      title: '⚠️ 确认清理',
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
