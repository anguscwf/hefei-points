// pages/index/index.js
var app = getApp();

Page({
  data: {
    isLoggedIn: false,
    isAdmin: false,
    isChild: false,
    isParent: false,
    loginStatusText: '未登录',
    currentUserName: '',

    // 登录
    userOptions: [],
    selectedUserIdx: 0,
    selectedUserName: '',
    password: '',

    // 积分卡片
    childCards: [],

    // Tab
    activeTab: 'history',

    // 历史记录
    historyList: [],

    // 规则
    rulesData: null,

    // 操作弹窗
    sheetVisible: false,
    sheetKidId: '',
    sheetKidName: '',
    sheetKidPoints: 0,

    // 数字弹窗
    numModalVisible: false,
    numTitle: '',
    numDesc: '',
    numValue: 0,
    numItem: null,

    // Toast
    toastMessage: '',
    toastVisible: false,

    // 加载状态
    loadingUsers: true,
    loadError: false
  },

  onLoad: function() {
    this.refreshState();
  },

  onShow: function() {
    this.refreshState();

  onLoad: function() {
    this.refreshState();
  },

  // ========== 状态刷新 ==========
  refreshState: function() {
    var that = this;
    var g = app.globalData;

    // 未登录时显示加载状态
    if (!(g.token && g.user)) {
      this.setData({ loadingUsers: true, loadError: false });
    }

    // 如果数据还没加载，等待 onLaunch 的 dataReady promise
    var allUsers = g.allUsers;
    if ((!allUsers || allUsers.length === 0) && g.dataReady && !this._waitingData) {
      this._waitingData = true;
      console.log('[index] 等待 dataReady...');
      // 额外 3 秒兜底超时，防止 dataReady 永不 resolve
      var timeout = new Promise(function(resolve) {
        setTimeout(function() { resolve('timeout'); }, 3000);
      });
      Promise.race([g.dataReady, timeout]).then(function(result) {
        that._waitingData = false;
        if (result === 'timeout') {
          console.warn('[index] dataReady 超时，主动拉取');
          that._fetchConfigFallback();
        } else if (result === true) {
          console.log('[index] dataReady 成功，刷新界面');
          that._doRefreshState();
        } else {
          console.warn('[index] dataReady 失败，主动拉取');
          that._fetchConfigFallback();
        }
      });
      return;  // 先渲染空壳，等数据回来再刷新
    }

    this._doRefreshState();
  },

  // 兜底：主动请求 /api/config（当 onLaunch 失败或超时时）
  _fetchConfigFallback: function() {
    var that = this;
    if (this._loadingUsers) return;
    this._loadingUsers = true;
    console.log('[index] 兜底请求 /api/config...');
    app.fetchAPI('/api/config', { timeout: 15000 }).then(function(res) {
      that._loadingUsers = false;
      if (res && res.success) {
        app.globalData.allUsers = res.users;
        app.globalData.rules = res.rules;
        that._doRefreshState();
      } else {
        that.showToast('加载用户列表失败：' + ((res && res.message) || '网络超时，请下拉刷新'));
        that._doRefreshState();  // 即使失败也要渲染（空壳）
      }
    });
  },

  // 手动重试加载
  onRetryLoad: function() {
    this.setData({ loadingUsers: true, loadError: false });
    var that = this;
    app.fetchAPI('/api/config', { timeout: 15000 }).then(function(res) {
      if (res && res.success) {
        app.globalData.allUsers = res.users;
        app.globalData.rules = res.rules;
        that._doRefreshState();
      } else {
        that.setData({ loadingUsers: false, loadError: true });
        that.showToast('加载失败，请检查网络连接');
      }
    });
  },

  // 实际执行 setData（从 refreshState 和兜底逻辑中抽离）
  _doRefreshState: function() {
    var that = this;
    var g = app.globalData;
    var isLoggedIn = !!(g.token && g.user);
    var isAdmin = isLoggedIn && g.user && g.user.role === 'admin';
    var isChild = isLoggedIn && g.user && g.user.role === 'child';
    var isParent = isLoggedIn && (g.user && (g.user.role === 'admin' || g.user.role === 'parent'));
    var loginStatusText = isLoggedIn ? ('欢迎 ' + g.user.name) : '未登录';

    // 用户选项（allUsers 由 onLaunch→dataReady 或 _fetchConfigFallback 保证已加载）
    var allUsers = g.allUsers || [];
    var userOptions = allUsers.map(function(u) { return { id: u.id, name: u.name }; });

    // 孩子卡片：child 角色只看自己的卡片
    var kids = allUsers.filter(function(u) { return u.role === 'child'; });
    if (isChild && g.user) {
      kids = kids.filter(function(k) { return k.id === g.user.id; });
    }
    var childCards = kids.map(function(k, i) {
      var c = app.kidColors[i % app.kidColors.length];
      var emoji = app.getKidEmoji(k.id);
      var val = (g.points && g.points[k.id]) ? g.points[k.id] : 0;
      var absScore = Math.abs(val);
      return {
        id: k.id,
        name: k.name,
        emoji: emoji,
        sign: val >= 0 ? '+' : '-',
        absScore: absScore > 9999 ? '9999+' : absScore,
        borderColor: c.border,
        score: val
      };
    });

    // 规则（必须检查 rules.reward 是否为数组，因为 {} 是 truthy 不会触发 fallback）
    var rulesData = (g.rules && Array.isArray(g.rules.reward)) ? g.rules : { reward: [], punish: [], special: [] };

    this.setData({
      isLoggedIn: isLoggedIn,
      isAdmin: isAdmin,
      isChild: isChild,
      isParent: isParent,
      loadingUsers: false,
      loginStatusText: loginStatusText,
      currentUserName: g.user ? g.user.name : '',
      userOptions: userOptions,
      selectedUserName: userOptions.length > 0 ? userOptions[0].name : '',
      childCards: childCards,
      rulesData: rulesData
    });

    if (isLoggedIn) {
      this.loadHistory();
    }
  },

  // ========== 登录 ==========
  onSelectUser: function(e) {
    var idx = parseInt(e.detail.value);
    var opts = this.data.userOptions;
    if (!opts || !opts[idx]) return;
    var name = opts[idx].name;
    this.setData({ selectedUserIdx: idx, selectedUserName: name });
  },

  onPwdInput: function(e) {
    this.setData({ password: e.detail.value });
  },

  onLogin: function() {
    var that = this;
    var opts = this.data.userOptions;
    if (!opts || opts.length === 0) {
      this.showToast('用户列表加载中，请稍后再试');
      return;
    }
    var selected = opts[this.data.selectedUserIdx];
    if (!selected) {
      this.showToast('请选择用户');
      return;
    }
    var uid = selected.id;
    var pwd = this.data.password;
    if (!pwd) {
      this.showToast('请输入密码');
      return;
    }
    app.login(uid, pwd).then(function(res) {
      if (res.success) {
        that.showToast('欢迎，' + res.user.name);
        app.loadData().then(function() {
          that.refreshState();
        });
      } else {
        that.showToast(res.message || '登录失败');
      }
    });
  },

  onLogout: function() {
    app.logout();
    this.setData({ isLoggedIn: false, isAdmin: false, isChild: false, isParent: false, loginStatusText: '未登录', childCards: [], historyList: [], password: '' });
    this.showToast('已退出');
  },

  onRefresh: function() {
    if (this.data.isLoggedIn) {
      var that = this;
      app.loadData().then(function() {
        that.refreshState();
        that.showToast('已刷新');
      });
    }
  },

  // ========== 积分卡片点击 → 打开操作弹窗 ==========
  onCardTap: function(e) {
    if (!app.canOperate()) {
      this.showToast(this.data.isChild ? '请家长操作积分' : '无操作权限');
      return;
    }
    var kid = e.currentTarget.dataset.kid;
    var name = e.currentTarget.dataset.name;
    var card = this.data.childCards.find(function(c) { return c.id === kid; });
    var points = card ? card.score : 0;

    this.setData({
      sheetVisible: true,
      sheetKidId: kid,
      sheetKidName: name,
      sheetKidPoints: points
    });
  },

  // ========== 操作弹窗回调 ==========
  onSheetClose: function() {
    this.setData({ sheetVisible: false });
  },

  onRuleSelect: function(e) {
    // 选择了规则，打开数字弹窗
    var item = e.detail;
    this.setData({
      sheetVisible: false,
      numModalVisible: true,
      numTitle: item.label,
      numDesc: (item.min >= 0 ? '+' + item.min : item.min) + ' ~ ' + (item.max >= 0 ? '+' + item.max : item.max) + ' 分' + (item.unit ? ' · ' + item.unit : ''),
      numValue: item.default,
      numItem: {
        id: item.id,
        label: item.label,
        min: item.min,
        max: item.max
      }
    });
  },

  onManualInput: function(e) {
    // 手动输入
    var detail = e.detail;
    var that = this;
    this.setData({ sheetVisible: false });
    app.doChange(this.data.sheetKidId, detail.amount, detail.reason, detail.note).then(function(res) {
      if (res.success) {
        that.showToast((that.data.sheetKidName || '') + ' ' + (detail.amount > 0 ? '+' : '') + detail.amount + '分');
        app.loadData().then(function() { that.refreshState(); });
      } else {
        that.showToast(res.message || '操作失败');
      }
    });
  },

  // ========== 数字弹窗回调 ==========
  onNumModalClose: function() {
    this.setData({ numModalVisible: false, numItem: null });
  },

  onNumChange: function(e) {
    this.setData({ numValue: e.detail.value });
  },

  onNumConfirm: function(e) {
    var that = this;
    var value = this.data.numValue;
    var label = this.data.numItem ? this.data.numItem.label : '';
    var note = e.detail ? e.detail.note : '';
    this.setData({ numModalVisible: false, numItem: null });
    app.doChange(this.data.sheetKidId, value, label, note).then(function(res) {
      if (res.success) {
        that.showToast((that.data.sheetKidName || '') + ' ' + (value > 0 ? '+' : '') + value + '分');
        app.loadData().then(function() { that.refreshState(); });
      } else {
        that.showToast(res.message || '操作失败');
      }
    });
  },

  // ========== 切换 Tab ==========
  switchTab: function(e) {
    var tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
  },

  // ========== 加载历史 ==========
  loadHistory: function() {
    var that = this;
    var allUsers = app.globalData.allUsers || [];
    var selfKid = (this.data.isChild && app.globalData.user) ? app.globalData.user.id : null;
    app.fetchAPI('/api/history?token=' + (app.globalData.token || '')).then(function(data) {
      if (!data || !data.history || data.history.length === 0) {
        that.setData({ historyList: [] });
        return;
      }
      var list = data.history.map(function(r) {
        var user = allUsers.find(function(u) { return u.id === r.kid; });
        var kidColor = app.getKidColor(r.kid);
        return {
          id: r.id,
          kid: r.kid,
          kidName: user ? user.name : r.kid,
          kidColor: kidColor.border || '#ccc',
          amount: r.amount,
          amountText: (r.amount >= 0 ? '+' : '') + r.amount,
          isPlus: r.amount >= 0,
          reason: r.reason,
          note: r.note || '',
          operator: r.operator,
          time: r.time
        };
      });
      // 孩子角色仅显示自己的记录
      if (selfKid) {
        list = list.filter(function(r) { return r.kid === selfKid; });
      }
      that.setData({ historyList: list });
    });
  },

  // ========== 历史记录点击 → 详情 ==========
  onRecordTap: function(e) {
    var idx = e.currentTarget.dataset.index;
    var record = this.data.historyList[idx];
    if (record) {
      wx.navigateTo({
        url: '/pages/records/records?detail=' + encodeURIComponent(JSON.stringify(record))
      });
    }
  },

  // ========== 跳转 ==========
  goAdmin: function() {
    wx.navigateTo({ url: '/pages/admin/admin' });
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
