// pages/mine/mine.js
var app = getApp();
var rulesViewModel = require('../../utils/rules-view-model.js');

Page({
  data: {
    isLoggedIn: false,
    isAdmin: false,
    isChild: false,
    isAdult: false,
    guardianPreviewEnabled: false,
    guardianTaskCount: 0,
    userName: '未登录',
    userIcon: 'person',
    userAvatar: '',
    roleText: '',
    totalPoints: 0,
    pointsLabel: '家庭总分',
    recordCount: 0,
    rulesData: {},
    ruleSummary: {
      categoryCount: 0,
      ruleCount: 0,
      rewardCount: 0,
      punishCount: 0,
      specialCount: 0,
      isEmpty: true
    },
    ruleSummaryTitle: '家庭积分规则',
    ruleSummaryIntro: '规则讲清楚，鼓励才更有力量',
    toastMessage: '',
    toastVisible: false,
    theme: 'amber',
    themePageStyle: '',
    themeClass: '',
    cropVisible: false,
    cropSource: '',
    version: '2.6.0'
  },

  onShow: function() {
    var that = this;
    var g = app.globalData;
    this.setData({
      theme: g.theme || 'amber',
      themePageStyle: app.getThemePageStyle(),
      themeClass: g.theme === 'mint' ? 'theme-mint' : ''
    });

    if (!g.token || !g.user) {
      this._doRefreshMine();
      return;
    }

    // 已登录时等待初始数据加载
    var allUsers = g.allUsers;
    if ((!allUsers || allUsers.length === 0) && g.dataReady && !this._waitingData) {
      this._waitingData = true;
      var timeout = new Promise(function(resolve) {
        setTimeout(function() { resolve('timeout'); }, 3000);
      });
      Promise.race([g.dataReady, timeout]).then(function(result) {
        that._waitingData = false;
        if (result === 'timeout' || result === false) {
          // 超时或失败，使用当前登录态主动拉取一次
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
    var isAdult = isLoggedIn && !isChild;
    var userName = isLoggedIn ? g.user.name : '未登录';
    var roleMap = { admin: '管理员', parent: '家长', child: '孩子' };
    var roleText = isLoggedIn ? roleMap[g.user.role] || '' : '';
    var iconMap = { admin: 'brand', parent: 'family' };
    var userIcon = isLoggedIn
      ? (g.user.role === 'child' ? app.getKidIcon(g.user.id) : (iconMap[g.user.role] || 'person'))
      : 'person';
    var rulesData = rulesViewModel.cloneRules(
      (g.rules && Array.isArray(g.rules.reward)) ? g.rules : { reward: [], punish: [], special: [] }
    );
    var ruleSummary = rulesViewModel.summarizeRules(rulesData);

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
      isAdult: isAdult,
      guardianPreviewEnabled: g.guardianPreviewEnabled === true,
      guardianTaskCount: 0,
      userName: userName,
      userIcon: userIcon,
      userAvatar: isLoggedIn ? app.getLocalAvatar(g.user.id) : '',
      roleText: roleText,
      totalPoints: totalPoints,
      pointsLabel: pointsLabel,
      rulesData: rulesData,
      ruleSummary: ruleSummary,
      ruleSummaryTitle: isChild ? '我的成长约定' : '家庭积分规则',
      ruleSummaryIntro: isChild
        ? '看看怎样赚糖、怎样护住糖，有疑问就和家长一起读'
        : '用简单清楚的约定，帮助孩子理解努力与边界',
      version: g.version || '2.6.0'
    });

    // 加载记录数
    if (isLoggedIn) {
      var that = this;
      app.fetchAPI('/api/history').then(function(data) {
        that.setData({ recordCount: (data.history || []).length });
      });
    }

    if (isAdult && g.guardianPreviewEnabled === true && app.guardianApi) {
      var summaryGeneration = (this._guardianSummaryGeneration || 0) + 1;
      this._guardianSummaryGeneration = summaryGeneration;
      app.guardianApi.taskSummary().then(function(result) {
        if (summaryGeneration !== that._guardianSummaryGeneration || !result.ok) return;
        var summary = result.data && result.data.pointRequests;
        that.setData({ guardianTaskCount: summary ? Number(summary.total) || 0 : 0 });
      });
    }
  },

  goIndex: function() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goRulesCenter: function() {
    app.globalData.openRulesCenter = true;
    wx.switchTab({
      url: '/pages/index/index',
      fail: function() { app.globalData.openRulesCenter = false; }
    });
  },

  goAdmin: function() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  goFamilyPrivacy: function() {
    wx.navigateTo({ url: '/pages/family-privacy/family-privacy' });
  },

  goFamilyTasks: function() {
    if (!this.data.guardianPreviewEnabled) return;
    wx.navigateTo({ url: '/pages/family-tasks/family-tasks' });
  },

  goDeviceManagement: function() {
    if (!this.data.guardianPreviewEnabled) return;
    wx.navigateTo({ url: '/pages/device-management/device-management' });
  },

  openLegal: function(event) {
    var type = event.currentTarget.dataset.type;
    var allowed = [
      'privacyPolicy', 'childPersonalInformationRules', 'childUserAgreement',
      'sensitiveInformationNotice', 'guardianRelationDeclaration'
    ];
    if (allowed.indexOf(type) < 0) return;
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=' + encodeURIComponent(type) });
  },

  onHide: function() {
    this._guardianSummaryGeneration = (this._guardianSummaryGeneration || 0) + 1;
  },

  onUnload: function() {
    this._guardianSummaryGeneration = (this._guardianSummaryGeneration || 0) + 1;
  },

  onChooseAvatar: function() {
    var that = this;
    var user = app.globalData.user;
    if (!user) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        var sourcePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!sourcePath) return;
        that.setData({ cropVisible: true, cropSource: sourcePath });
      }
    });
  },

  onCropCancel: function() {
    this.setData({ cropVisible: false, cropSource: '' });
  },

  onCropApply: function(e) {
    var user = app.globalData.user;
    var filePath = e.detail && e.detail.filePath;
    if (!user || !filePath) return;
    this.setData({ cropVisible: false, cropSource: '' });
    wx.showLoading({ title: '正在保存...' });
    this.saveAvatarBase64(filePath, user.id);
  },

  saveAvatarBase64: function(filePath, userId) {
    var that = this;
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function(res) {
        wx.hideLoading();
        if (!res.data || res.data.length > 1800000) {
          wx.showToast({ title: '图片太大，请换一张', icon: 'none' });
          return;
        }
        var lowerPath = filePath.toLowerCase();
        var mime = lowerPath.indexOf('.png') >= 0 ? 'image/png' : 'image/jpeg';
        var avatar = 'data:' + mime + ';base64,' + res.data;
        try {
          wx.setStorageSync(app.getAvatarStorageKey(userId), avatar);
          that.setData({ userAvatar: avatar });
          that.showToast('头像已保存在本机');
        } catch (err) {
          wx.showToast({ title: '本地空间不足', icon: 'none' });
        }
      },
      fail: function() {
        wx.hideLoading();
        wx.showToast({ title: '读取图片失败', icon: 'none' });
      }
    });
  },

  onResetAvatar: function() {
    var user = app.globalData.user;
    if (!user) return;
    wx.removeStorageSync(app.getAvatarStorageKey(user.id));
    this.setData({ userAvatar: '' });
    this.showToast('已恢复默认头像');
  },

  onThemeChange: function(e) {
    var theme = e.currentTarget.dataset.theme;
    var pageStyle = app.setTheme(theme);
    this.setData({
      theme: app.globalData.theme,
      themePageStyle: pageStyle,
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : ''
    });
    this.showToast(theme === 'mint' ? '已换成薄荷绿' : '已换成琥珀暖色');
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
