// pages/mine/mine.js
var app = getApp();

Page({
  data: {
    isLoggedIn: false,
    isAdmin: false,
    isChild: false,
    userName: '未登录',
    userEmoji: '👤',
    roleText: '',
    totalPoints: 0,
    pointsLabel: '家庭总分',
    recordCount: 0,
    rulesData: {},
    toastMessage: '',
    toastVisible: false
  },

  onShow: function() {
    var that = this;
    var g = app.globalData;

    // 等待初始数据加载
    var allUsers = g.allUsers;
    if ((!allUsers || allUsers.length === 0) && g.dataReady && !this._waitingData) {
      this._waitingData = true;
      var timeout = new Promise(function(resolve) {
        setTimeout(function() { resolve('timeout'); }, 3000);
      });
      Promise.race([g.dataReady, timeout]).then(function(result) {
        that._waitingData = false;
        if (result === 'timeout' || result === false) {
          // 超时或失败，主动拉取一次
          app.fetchAPI('/api/config', { timeout: 15000 }).then(function(res) {
            if (res && res.success) {
              app.globalData.allUsers = res.users;
              app.globalData.rules = res.rules;
            }
            that._doRefreshMine();
          });
        } else {
          that._doRefreshMine();
        }
      });
      return;
    }

    this._doRefreshMine();
  },

  _doRefreshMine: function() {
    var g = app.globalData;
    var isLoggedIn = !!(g.token && g.user);
    var isAdmin = isLoggedIn && g.user && g.user.role === 'admin';
    var isChild = isLoggedIn && g.user && g.user.role === 'child';
    var userName = isLoggedIn ? g.user.name : '未登录';
    var roleMap = { admin: '管理员', parent: '家长', child: '孩子' };
    var roleText = isLoggedIn ? roleMap[g.user.role] || '' : '';
    var emojiMap = { admin: '👑', parent: '👨‍👩‍👧', child: '👶' };
    var userEmoji = isLoggedIn ? emojiMap[g.user.role] || '👤' : '👤';

    // 计算积分：孩子显示个人积分，家长显示家庭总分
    var totalPoints = 0;
    var pointsLabel = '家庭总分';
    if (g.points) {
      if (isChild && g.user) {
        totalPoints = g.points[g.user.id] || 0;
        pointsLabel = '我的积分';
      } else {
        Object.values(g.points).forEach(function(v) { totalPoints += v; });
      }
    }

    this.setData({
      isLoggedIn: isLoggedIn,
      isAdmin: isAdmin,
      isChild: isChild,
      userName: userName,
      userEmoji: userEmoji,
      roleText: roleText,
      totalPoints: totalPoints,
      pointsLabel: pointsLabel,
      rulesData: (g.rules && Array.isArray(g.rules.reward)) ? g.rules : { reward: [], punish: [], special: [] }
    });

    // 加载记录数
    if (isLoggedIn) {
      var that = this;
      app.fetchAPI('/api/history?token=' + (app.globalData.token || '')).then(function(data) {
        that.setData({ recordCount: (data.history || []).length });
      });
    }
  },

  goIndex: function() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goAdmin: function() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  showToast: function(msg) {
    var that = this;
    this.setData({ toastMessage: msg, toastVisible: true });
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function() {
      that.setData({ toastVisible: false });
    }, 2000);
  }
});
