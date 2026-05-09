// 恩霖积分 小程序 v1.0 (从HTTP版v4.2迁移)
// 全局状态 · API · 认证

var VERSION = '1.0.0';
var API_BASE = 'http://159.75.102.145:3002';  // 开发环境（独立于生产3001）

App({
  globalData: {
    token: '',
    user: null,
    points: null,
    rules: null,
    allUsers: null,
    version: VERSION,
    dataReady: null,      // Promise，页面可 await 等待初始数据加载完毕
    dataReadyResolve: null
  },

  // 初始化 dataReady promise
  _initDataReady: function() {
    var that = this;
    that.globalData.dataReady = new Promise(function(resolve) {
      that.globalData.dataReadyResolve = resolve;
    });
  },

  kidColors: [
    { name: 'enhe', bg: '#E8F2FC', border: '#4A90D9', color: '#2E6EB5' },
    { name: 'enfei', bg: '#FDE8F0', border: '#E87DA8', color: '#C55078' }
  ],

  onLaunch: function() {
    var that = this;
    that._initDataReady();

    // 恢复登录态
    var token = wx.getStorageSync('hefei_token');
    var userStr = wx.getStorageSync('hefei_user');
    if (token && token.indexOf('hefei.') === 0 && userStr) {
      try {
        that.globalData.token = token;
        that.globalData.user = JSON.parse(userStr);
      } catch(e) {
        wx.removeStorageSync('hefei_token');
        wx.removeStorageSync('hefei_user');
      }
    }
    // 预加载用户列表 + 规则（带重试，解决超时问题）
    that._loadConfigWithRetry(3);
  },

  // 带重试的配置加载（最多 maxRetries 次）
  _loadConfigWithRetry: function(maxRetries) {
    var that = this;
    var attempt = 0;
    function tryLoad() {
      attempt++;
      console.log('[app] 加载 /api/config 第 ' + attempt + ' 次尝试...');
      that.fetchAPI('/api/config', { timeout: 5000 }).then(function(res) {
        if (res && res.success) {
          console.log('[app] /api/config 加载成功，用户数=' + (res.users || []).length);
          that.globalData.allUsers = res.users;
          that.globalData.rules = res.rules;
          if (that.globalData.dataReadyResolve) {
            that.globalData.dataReadyResolve(true);
          }
        } else {
          console.warn('[app] /api/config 返回失败: ' + ((res && res.message) || '未知错误'));
          if (attempt < maxRetries) {
            setTimeout(tryLoad, 500);  // 500ms 快速重试
          } else {
            console.error('[app] /api/config 重试 ' + maxRetries + ' 次后仍失败');
            if (that.globalData.dataReadyResolve) {
              that.globalData.dataReadyResolve(false);
            }
          }
        }
      });
    }
    tryLoad();
  },

  // ========== API 封装 ==========
  fetchAPI: function(url, opts) {
    var that = this;
    return new Promise(function(resolve) {
      wx.request({
        url: API_BASE + url,
        method: (opts && opts.method) || 'GET',
        data: (opts && opts.body) ? JSON.parse(opts.body) : undefined,
        header: (opts && opts.headers) || { 'Content-Type': 'application/json' },
        timeout: (opts && opts.timeout) || 15000,
        success: function(res) {
          resolve(res.data);
        },
        fail: function(err) {
          console.error('[fetchAPI] 请求失败:', url, err.errMsg || err);
          resolve({ success: false, message: '网络错误: ' + (err.errMsg || 'timeout') });
        }
      });
    });
  },

  // ========== 认证 ==========
  login: function(uid, pwd) {
    var that = this;
    return that.fetchAPI('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ userId: uid, password: pwd })
    }).then(function(res) {
      if (res.success) {
        that.globalData.token = res.token;
        that.globalData.user = res.user;
        wx.setStorageSync('hefei_token', res.token);
        wx.setStorageSync('hefei_user', JSON.stringify(res.user));
      }
      return res;
    });
  },

  logout: function() {
    this.globalData.token = '';
    this.globalData.user = null;
    this.globalData.points = null;
    wx.removeStorageSync('hefei_token');
    wx.removeStorageSync('hefei_user');
  },

  // ========== 数据加载 ==========
  loadData: function() {
    var that = this;
    var token = that.globalData.token || '';
    return Promise.all([
      that.fetchAPI('/api/points?token=' + token),
      that.fetchAPI('/api/config')
    ]).then(function(results) {
      var pointsRes = results[0];
      var configRes = results[1];
      if (pointsRes.success) {
        that.globalData.points = pointsRes.points;
        that.globalData.rules = pointsRes.rules;
      }
      if (configRes.success) {
        that.globalData.allUsers = configRes.users;
      }
      return { points: pointsRes, config: configRes };
    });
  },

  // ========== 积分变动 ==========
  doChange: function(kid, amount, reason, note) {
    var that = this;
    return that.fetchAPI('/api/points/change', {
      method: 'POST',
      body: JSON.stringify({
        token: that.globalData.token,
        kid: kid,
        amount: amount,
        reason: reason,
        note: note || ''
      })
    });
  },

  // ========== 帮助函数 ==========
  getKidColor: function(kid) {
    var kids = (this.globalData.allUsers || []).filter(function(u) { return u.role === 'child'; });
    var idx = kids.findIndex(function(u) { return u.id === kid; });
    return (idx >= 0 ? this.kidColors[idx % this.kidColors.length] : this.kidColors[0]) || this.kidColors[0];
  },

  getKidEmoji: function(kid) {
    var kids = (this.globalData.allUsers || []).filter(function(u) { return u.role === 'child'; });
    var idx = kids.findIndex(function(u) { return u.id === kid; });
    return idx === 0 ? '👦' : (idx === 1 ? '👧' : '👶');
  },

  canOperate: function() {
    var user = this.globalData.user;
    return user && (user.role === 'admin' || user.role === 'parent');
  },

  showToast: function(msg) {
    var pages = getCurrentPages();
    var page = pages[pages.length - 1];
    if (page && page.showToastMsg) {
      page.showToastMsg(msg);
    }
  }
});
