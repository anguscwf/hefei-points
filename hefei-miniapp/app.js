// 糖罐积分 小程序 v2.6.0
// 全局状态 · API · 认证
var VERSION = '2.6.0';
var API_BASE = 'https://hefeijifen.cn';
var sessionUtils = require('./utils/session.js');
var v2Request = require('./utils/v2-request.js');
var guardianApiFactory = require('./utils/guardian-api.js');
var guardianRecovery = require('./utils/guardian-operation-recovery.js');
var pairingRecovery = require('./utils/device-pairing-recovery.js');

App({
  guardianApi: null,

  globalData: {
    token: '',
    user: null,
    points: null,
    rules: null,
    allUsers: null,
    theme: 'mint',
    version: VERSION,
    dataReady: null,      // Promise，页面可 await 等待初始数据加载完毕
    dataReadyResolve: null,
    guardianPreviewEnabled: false,
    guardianRouteContext: null,
    guardianEnrollmentReviewRequired: null,
    guardianDeviceCreateIntent: null,
    sessionStorageUnavailable: false
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
    try {
      var accountInfo = wx.getAccountInfoSync && wx.getAccountInfoSync();
      var envVersion = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
      // 正式版永远关闭可发现的新儿童入口；开发版/体验版仍受服务端全套功能门约束。
      that.globalData.guardianPreviewEnabled = envVersion === 'develop' || envVersion === 'trial';
    } catch (error) {
      that.globalData.guardianPreviewEnabled = false;
    }

    that._sessionStore = sessionUtils.createSessionStore({ storage: wx });
    var restored;
    try {
      restored = that._sessionStore.restore();
    } catch (error) {
      restored = { token: '', user: null };
      that.globalData.sessionStorageUnavailable = true;
    }
    that.globalData.token = restored.token;
    that.globalData.user = restored.user;
    that._sessionGeneration = 1;
    that._initGuardianRecovery();
    that._restoreGuardianConsentReview();
    that._initPairingRecovery();
    that._restoreDevicePairingIntent();
    that._initV2Foundation();
    // 不再在 onLaunch 预加载（网络模块未就绪会导致 timeout）
    // 配置加载交由 index 页面 onLoad 处理
  },

  _initV2Foundation: function() {
    var that = this;
    if (!that._sessionStore) that._sessionStore = sessionUtils.createSessionStore({ storage: wx });
    if (!that._v2Client) {
      that._v2Client = v2Request.createV2Client({
        wxApi: wx,
        baseUrl: API_BASE,
        getAdultToken: function() {
          return that._sessionStore.getAdultBearer({
            token: that.globalData.token,
            user: that.globalData.user
          });
        },
        onAuthInvalid: function(tokenSnapshot) {
          that._invalidateV2Session(tokenSnapshot);
        }
      });
    }
    if (!that.guardianApi) {
      that.guardianApi = guardianApiFactory.createGuardianApi({
        request: function(options) { return that.requestV2(options); },
        createIdempotencyKey: function(scope) {
          return that._v2Client.createIdempotencyKey(scope);
        }
      });
    }
  },

  _initGuardianRecovery: function() {
    var that = this;
    if (!that._guardianRecovery) {
      that._guardianRecovery = guardianRecovery.createRecoveryStore({
        storage: wx,
        getUser: function() { return that.globalData.user; }
      });
    }
  },

  _restoreGuardianConsentReview: function() {
    this._initGuardianRecovery();
    try {
      this.globalData.guardianEnrollmentReviewRequired = this._guardianRecovery.current();
    } catch (error) {
      this.globalData.guardianEnrollmentReviewRequired = {
        operation: 'storage-unavailable',
        idempotencyKey: '',
        createdAt: 0,
        storageUnavailable: true
      };
    }
    return this.globalData.guardianEnrollmentReviewRequired;
  },

  beginGuardianConsentReview: function(operation, idempotencyKey) {
    this._initGuardianRecovery();
    var marker = this._guardianRecovery.begin(operation, idempotencyKey);
    if (!marker || marker.operation !== operation || marker.idempotencyKey !== idempotencyKey) {
      throw new Error('guardian operation recovery marker was not persisted');
    }
    this.globalData.guardianEnrollmentReviewRequired = marker;
    return marker;
  },

  clearGuardianConsentReview: function(expectedKey) {
    this._initGuardianRecovery();
    try {
      var cleared = this._guardianRecovery.clear(expectedKey);
      var current = this._guardianRecovery.current();
      this.globalData.guardianEnrollmentReviewRequired = current;
      return cleared;
    } catch (error) {
      return false;
    }
  },

  _initPairingRecovery: function() {
    var that = this;
    if (!that._pairingRecovery) {
      that._pairingRecovery = pairingRecovery.createRecoveryStore({
        storage: wx,
        getUser: function() { return that.globalData.user; }
      });
    }
  },

  _restoreDevicePairingIntent: function() {
    this._initPairingRecovery();
    try {
      var marker = this._pairingRecovery.current();
      this.globalData.guardianDeviceCreateIntent = marker ? {
        key: marker.idempotencyKey,
        body: { childId: marker.childId }
      } : null;
    } catch (error) {
      this.globalData.guardianDeviceCreateIntent = { storageUnavailable: true };
    }
    return this.globalData.guardianDeviceCreateIntent;
  },

  beginDevicePairingRecovery: function(childId, idempotencyKey) {
    this._initPairingRecovery();
    var marker = this._pairingRecovery.begin(childId, idempotencyKey);
    if (!marker || marker.childId !== childId || marker.idempotencyKey !== idempotencyKey) {
      throw new Error('device pairing recovery marker was not persisted');
    }
    this.globalData.guardianDeviceCreateIntent = {
      key: marker.idempotencyKey,
      body: { childId: marker.childId }
    };
    return this.globalData.guardianDeviceCreateIntent;
  },

  clearDevicePairingRecovery: function(expectedKey) {
    this._initPairingRecovery();
    try {
      var cleared = this._pairingRecovery.clear(expectedKey);
      this._restoreDevicePairingIntent();
      return cleared;
    } catch (error) {
      return false;
    }
  },

  _invalidateV2Session: function(tokenSnapshot) {
    if (!tokenSnapshot || this.globalData.token !== tokenSnapshot) return false;
    this.clearSession();
    if (typeof wx.showToast === 'function') {
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
    }
    return true;
  },

  commitSession: function(token, user) {
    this._initV2Foundation();
    var committed = this._sessionStore.commit(token, user);
    var previousUser = this.globalData.user || {};
    var sessionChanged = this.globalData.token !== committed.token
      || previousUser.id !== committed.user.id
      || previousUser.familyId !== committed.user.familyId
      || previousUser.role !== committed.user.role;
    if (sessionChanged) {
      this.globalData.points = null;
      this.globalData.rules = null;
      this.globalData.allUsers = [];
      this.globalData.guardianRouteContext = null;
      this.globalData.guardianEnrollmentReviewRequired = null;
      this.globalData.guardianDeviceCreateIntent = null;
      this._sessionGeneration = (this._sessionGeneration || 0) + 1;
    }
    this.globalData.token = committed.token;
    this.globalData.user = committed.user;
    this.globalData.sessionStorageUnavailable = false;
    if (sessionChanged) {
      this._initGuardianRecovery();
      this._restoreGuardianConsentReview();
      this._initPairingRecovery();
      this._restoreDevicePairingIntent();
      this._notifyGuardianSessionChanged();
    }
    return committed;
  },

  clearSession: function() {
    this._initV2Foundation();
    var storageCleared = true;
    try {
      this._sessionStore.clear();
    } catch (error) {
      storageCleared = false;
    }
    this.globalData.token = '';
    this.globalData.user = null;
    this.globalData.points = null;
    this.globalData.rules = null;
    this.globalData.allUsers = [];
    this.globalData.guardianRouteContext = null;
    this.globalData.guardianEnrollmentReviewRequired = null;
    this.globalData.guardianDeviceCreateIntent = null;
    this.globalData.sessionStorageUnavailable = !storageCleared;
    this._sessionGeneration = (this._sessionGeneration || 0) + 1;
    this._notifyGuardianSessionChanged();
    if (!storageCleared && typeof wx.showToast === 'function') {
      wx.showToast({ title: '本机登录凭据清理失败，请清理小程序缓存', icon: 'none' });
    }
    return storageCleared;
  },

  subscribeGuardianSession: function(listener) {
    var that = this;
    if (typeof listener !== 'function') return function() {};
    if (!Array.isArray(that._guardianSessionListeners)) that._guardianSessionListeners = [];
    that._guardianSessionListeners.push(listener);
    var active = true;
    return function() {
      if (!active) return;
      active = false;
      that._guardianSessionListeners = that._guardianSessionListeners.filter(function(item) {
        return item !== listener;
      });
    };
  },

  _notifyGuardianSessionChanged: function() {
    var listeners = Array.isArray(this._guardianSessionListeners)
      ? this._guardianSessionListeners.slice() : [];
    listeners.forEach(function(listener) {
      try { listener(); } catch (error) {}
    });
  },

  _captureSessionSnapshot: function() {
    var user = this.globalData.user || {};
    return {
      token: this.globalData.token,
      generation: this._sessionGeneration || 0,
      actorId: user.id || '',
      familyId: user.familyId || '',
      role: user.role || ''
    };
  },

  _isSessionSnapshotCurrent: function(snapshot) {
    var user = this.globalData.user || {};
    return !!snapshot && snapshot.token === this.globalData.token
      && snapshot.generation === (this._sessionGeneration || 0)
      && snapshot.actorId === (user.id || '')
      && snapshot.familyId === (user.familyId || '')
      && snapshot.role === (user.role || '');
  },

  requestV2: function(options) {
    this._initV2Foundation();
    var that = this;
    var protectedRequest = !!options
      && (options.auth === undefined || options.auth === 'adult');
    var snapshot = protectedRequest ? that._captureSessionSnapshot() : null;
    return this._v2Client.request(options).then(function(result) {
      if (!protectedRequest || that._isSessionSnapshotCurrent(snapshot)) return result;
      if (result && result.status === 401 && result.code === 'AUTH_REQUIRED'
          && !that.globalData.token) return result;
      return {
        ok: false,
        success: false,
        status: 0,
        code: 'STALE_SESSION_RESPONSE',
        message: '登录状态已变化，旧请求结果已丢弃',
        requestId: result && result.requestId || '',
        headers: result && result.headers || {},
        retryable: false,
        outcomeUnknown: String(options.method || 'GET').toUpperCase() !== 'GET'
      };
    });
  },

  // 带重试的配置加载（最多 maxRetries 次）
  _loadConfigWithRetry: function(maxRetries) {
    var that = this;
    if (!that.globalData.token) {
      that.globalData.allUsers = [];
      if (that.globalData.dataReadyResolve) that.globalData.dataReadyResolve(true);
      return;
    }
    var sessionSnapshot = that._captureSessionSnapshot();
    var attempt = 0;
    function tryLoad() {
      if (!that._isSessionSnapshotCurrent(sessionSnapshot)) return;
      attempt++;
      console.log('[app] 加载 /api/config 第 ' + attempt + ' 次尝试...');
      that.fetchAPI('/api/config', { timeout: 5000 }).then(function(res) {
        if (!that._isSessionSnapshotCurrent(sessionSnapshot)) return;
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
    var sessionSnapshot = that._captureSessionSnapshot();
    var routePath = url.split('?')[0];
    var isLoginRequest = routePath === '/api/auth' || routePath === '/api/wx-login' || routePath === '/api/wx-bind';
    return new Promise(function(resolve) {
      var headers = {
        'Content-Type': 'application/json'
      };
      if (sessionSnapshot.token) headers.Authorization = 'Bearer ' + sessionSnapshot.token;
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
          if (sessionSnapshot.token && !isLoginRequest
              && !that._isSessionSnapshotCurrent(sessionSnapshot)) {
            resolve({ success: false, code: 'STALE_SESSION_RESPONSE', message: '登录状态已变化' });
            return;
          }
          var protectedRead = routePath === '/api/points' || routePath === '/api/history' || routePath === '/api/config';
          var sessionExpired = res.statusCode === 401 || (res.statusCode === 403 && protectedRead);
          if (sessionExpired && sessionSnapshot.token && !isLoginRequest
              && that._isSessionSnapshotCurrent(sessionSnapshot)) {
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
        that.commitSession(res.token, res.user);
      }
      return res;
    });
  },

  logout: function() {
    this.clearSession();
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
    var sessionSnapshot = that._captureSessionSnapshot();
    return that.fetchAPI('/api/points', {
      timeout: 15000,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    }).then(function(pointsRes) {
      if (!that._isSessionSnapshotCurrent(sessionSnapshot)) {
        return { success: false, code: 'STALE_SESSION_RESPONSE', message: '登录状态已变化' };
      }
      if (pointsRes && pointsRes.success) {
        that.globalData.points = pointsRes.points || {};
        that.globalData.rules = pointsRes.rules
          ? that.normalizeRules(pointsRes.rules)
          : that.globalData.rules;
        if (pointsRes.user) {
          that.commitSession(that.globalData.token, pointsRes.user);
        }
      }
      return pointsRes;
    });
  },

  loadData: function() {
    var that = this;
    if (!that.globalData.token) {
      that.globalData.points = null;
      that.globalData.rules = null;
      that.globalData.allUsers = [];
      return Promise.resolve({
        points: { success: false, code: 'AUTH_REQUIRED', message: '请先登录' },
        config: { success: true, public: true, users: [] }
      });
    }
    var sessionSnapshot = that._captureSessionSnapshot();
    return Promise.all([
      that.loadPoints(),
      that.fetchAPI('/api/config')
    ]).then(function(results) {
      if (!that._isSessionSnapshotCurrent(sessionSnapshot)) {
        var stale = { success: false, code: 'STALE_SESSION_RESPONSE', message: '登录状态已变化' };
        return { points: stale, config: stale };
      }
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
