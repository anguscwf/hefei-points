// 糖罐积分 小程序 v2.5.0
// 全局状态 · API · 认证
var VERSION = '2.5.0';
var API_BASE = 'https://hefeijifen.cn';

App({
  globalData: {
    token: '',
    user: null,
    points: null,
    rules: null,
    allUsers: null,
    theme: 'mint',
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
    that.setTheme(wx.getStorageSync('hefei_theme') || 'mint', false);

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
    // 不再在 onLaunch 预加载（网络模块未就绪会导致 timeout）
    // 配置加载交由 index 页面 onLoad 处理
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
          that.globalData.rules = that.normalizeRules(res.rules);
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
      var headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (that.globalData.token || '')
      };
      if (opts && opts.headers) {
        Object.keys(opts.headers).forEach(function(key) { headers[key] = opts.headers[key]; });
      }
      wx.request({
        url: API_BASE + url,
        method: (opts && opts.method) || 'GET',
        data: (opts && opts.body) ? JSON.parse(opts.body) : undefined,
        header: headers,
        timeout: (opts && opts.timeout) || 15000,
        success: function(res) {
          var routePath = url.split('?')[0];
          var isLoginRequest = routePath === '/api/auth' || routePath === '/api/wx-login' || routePath === '/api/wx-bind';
          var protectedRead = routePath === '/api/points' || routePath === '/api/history' || routePath === '/api/config';
          var sessionExpired = res.statusCode === 401 || (res.statusCode === 403 && protectedRead);
          if (sessionExpired && that.globalData.token && !isLoginRequest) {
            that.logout();
            wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
          }
          resolve(res.data);
        },
        fail: function(err) {
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
  normalizeRules: function(rules) {
    if (!rules || typeof rules !== 'object') return rules;
    var normalized = JSON.parse(JSON.stringify(rules));
    (normalized.punish || []).forEach(function(category) {
      (category.items || []).forEach(function(item) {
        if (item.id === 'punish' || item.label === '惩罚') {
          item.min = -500;
          item.max = -1;
          if (!Number.isInteger(item.default) || item.default < item.min || item.default > item.max) {
            item.default = -10;
          }
        }
      });
    });
    return normalized;
  },

  loadPoints: function() {
    var that = this;
    return that.fetchAPI('/api/points', {
      timeout: 15000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    }).then(function(pointsRes) {
      if (pointsRes && pointsRes.success) {
        that.globalData.points = pointsRes.points || {};
        that.globalData.rules = pointsRes.rules
          ? that.normalizeRules(pointsRes.rules)
          : that.globalData.rules;
        if (pointsRes.user) {
          that.globalData.user = pointsRes.user;
          wx.setStorageSync('hefei_user', JSON.stringify(pointsRes.user));
        }
      }
      return pointsRes;
    });
  },

  loadData: function() {
    var that = this;
    return Promise.all([
      that.loadPoints(),
      that.fetchAPI('/api/config')
    ]).then(function(results) {
      var pointsRes = results[0];
      var configRes = results[1];
      if (configRes && configRes.success) {
        that.globalData.allUsers = configRes.users || [];
        if (configRes.rules) that.globalData.rules = that.normalizeRules(configRes.rules);
      }
      return { points: pointsRes, config: configRes };
    });
  },

  // ========== 积分变动 ==========
  doChange: function(kid, amount, reason, note, ruleRef) {
    var that = this;
    var payload = {
      token: that.globalData.token,
      kid: kid,
      amount: amount,
      reason: reason,
      note: note || ''
    };
    var ruleId = ruleRef && String(ruleRef.ruleId || '').trim();
    var categoryId = ruleRef && String(ruleRef.categoryId || '').trim();
    // ruleId 是关联入口；旧分类缺稳定 ID 时由服务端尝试补全，不能静默降级成手动流水。
    if (ruleId) {
      payload.ruleId = ruleId;
      if (categoryId) payload.categoryId = categoryId;
    }
    return that.fetchAPI('/api/points/change', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  // ========== 帮助函数 ==========
  getKidColor: function(kid) {
    var kids = (this.globalData.allUsers || []).filter(function(u) { return u.role === 'child'; });
    var idx = kids.findIndex(function(u) { return u.id === kid; });
    return (idx >= 0 ? this.kidColors[idx % this.kidColors.length] : this.kidColors[0]) || this.kidColors[0];
  },

  getKidIcon: function(kid) {
    var kids = (this.globalData.allUsers || []).filter(function(user) { return user.role === 'child'; });
    var index = kids.findIndex(function(user) { return user.id === kid; });
    return index === 0 ? 'kid-a' : (index === 1 ? 'kid-b' : 'person');
  },

  // 获取用户主题色（孩子用专属色，成人用琥珀色）
  getUserColor: function(userId) {
    var adultColor = this.globalData.theme === 'mint' ? '#2D9B7A' : '#B86932';
    if (!userId) return { bg: adultColor, text: '#fff', border: adultColor };
    var kids = (this.globalData.allUsers || []).filter(function(u) { return u.role === 'child'; });
    var idx = kids.findIndex(function(u) { return u.id === userId; });
    if (idx >= 0) {
      var c = this.kidColors[idx % this.kidColors.length];
      return { bg: c.border, text: '#fff', border: c.border };
    }
    // adult users → amber
    return { bg: adultColor, text: '#fff', border: adultColor };
  },

  getThemePageStyle: function() {
    if (this.globalData.theme === 'mint') {
      return '--amber:#2D9B7A;--amber-dark:#176A53;--honey:#75CDB1;--amber-light:#E4F6F0;--bg:#F0F8F5;--card:rgba(251,255,253,.91);--border:rgba(45,155,122,.16);--accent-start:#42B491;--accent-end:#237A61;--accent-shadow:rgba(45,155,122,.24);--surface-soft:rgba(228,246,240,.78);';
    }
    return '--amber:#B86932;--amber-dark:#8F4924;--honey:#F3B85B;--amber-light:#FFF1DF;--bg:#FBF5EC;--card:rgba(255,253,249,.9);--border:rgba(184,105,50,.14);--accent-start:#CB7A3D;--accent-end:#A85A2B;--accent-shadow:rgba(184,105,50,.24);--surface-soft:rgba(255,241,223,.72);';
  },

  setTheme: function(theme, persist) {
    var nextTheme = theme === 'mint' ? 'mint' : 'amber';
    var tabIcons = ['home', 'records', 'chart', 'user'];
    this.globalData.theme = nextTheme;
    if (persist !== false) wx.setStorageSync('hefei_theme', nextTheme);
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: nextTheme === 'mint' ? '#2D9B7A' : '#B86932',
      animation: { duration: 220, timingFunc: 'easeIn' }
    });
    wx.setTabBarStyle({
      selectedColor: nextTheme === 'mint' ? '#2D9B7A' : '#B86932',
      backgroundColor: '#FFFDFC',
      borderStyle: 'white'
    });
    if (wx.setTabBarItem) {
      tabIcons.forEach(function(icon, index) {
        wx.setTabBarItem({
          index: index,
          iconPath: 'images/' + icon + '_inactive.png',
          selectedIconPath: 'images/' + icon + (nextTheme === 'mint' ? '_active_mint.png' : '_active.png')
        });
      });
    }
    return this.getThemePageStyle();
  },

  getKidSkin: function(kidId) {
    var skins = wx.getStorageSync('hefei_kid_skins_' + this.getPreferenceScope()) || {};
    return skins[kidId] === 'star' ? 'star' : 'classic';
  },

  setKidSkin: function(kidId, skin) {
    var storageKey = 'hefei_kid_skins_' + this.getPreferenceScope();
    var skins = wx.getStorageSync(storageKey) || {};
    skins[kidId] = skin === 'star' ? 'star' : 'classic';
    wx.setStorageSync(storageKey, skins);
  },

  getLocalAvatar: function(userId) {
    return userId ? (wx.getStorageSync(this.getAvatarStorageKey(userId)) || '') : '';
  },

  getPreferenceScope: function() {
    return (this.globalData.user && this.globalData.user.familyId) || 'default';
  },

  getAvatarStorageKey: function(userId) {
    return 'hefei_avatar_' + this.getPreferenceScope() + '_' + userId;
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
