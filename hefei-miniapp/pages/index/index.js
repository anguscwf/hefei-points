// pages/index/index.js
var app = getApp();
var rulesViewModel = require('../../utils/rules-view-model.js');

var RULE_CENTER_PREF_KEY = 'hefei_rule_center_pref_v1';

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
    manualUserId: '',
    password: '',
    wxOpenid: '',
    wxLoginLoading: false,
    showLoginGuide: false,

    // 积分卡片
    childCards: [],
    kidSwitcher: [],
    activeKidView: 'all',
    themePageStyle: '',
    themeClass: '',
    iconTheme: 'mint',

    // Tab
    activeTab: 'history',

    // 历史记录
    historyList: [],

    // 规则
    rulesData: null,
    ruleSummary: {
      categoryCount: 0,
      ruleCount: 0,
      rewardCount: 0,
      punishCount: 0,
      specialCount: 0,
      isEmpty: true
    },
    ruleBrowser: { categories: [], specials: [], resultCount: 0 },
    ruleFilter: 'all',
    ruleQuery: '',
    ruleExpandedKey: '',
    ruleFilterOptions: [],
    ruleCenterTitle: '我们家的成长约定',
    ruleCenterIntro: '先讲清规则，再一起认真做到',
    frequentRules: [],
    ruleDetailVisible: false,
    ruleDetail: null,

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
    loadError: false,
    headerBg: '#B86932',
    pickerKey: 1,   // 登出时递增，强制重建 picker
    version: '2.4.0'
  },

  onLoad: function() {
    var savedPreference = wx.getStorageSync(RULE_CENTER_PREF_KEY) || {};
    var savedFilter = ['all', 'reward', 'punish', 'special'].indexOf(savedPreference.filter) >= 0
      ? savedPreference.filter
      : 'all';
    this.setData({
      showLoginGuide: !app.globalData.token && !wx.getStorageSync('hefei_login_guide_v2'),
      ruleFilter: savedFilter,
      ruleExpandedKey: String(savedPreference.expandedKey || '')
    });
    // 页面加载时直接请求配置（不再依赖 onLaunch）
    this._loadConfigAndRefresh();
  },

  onShow: function() {
    var that = this;
    var g = app.globalData;
    var themeHeader = g.theme === 'mint' ? '#2D9B7A' : '#B86932';
    var shouldOpenRules = !!g.openRulesCenter;
    if (shouldOpenRules) g.openRulesCenter = false;
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: g.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: g.theme === 'amber' ? 'amber' : 'mint',
      headerBg: themeHeader,
      activeTab: shouldOpenRules ? 'rules' : this.data.activeTab
    });
    if (g.token && g.user) {
      // 每次回到首页都从服务端重新请求 /api/points，loadPoints 已显式禁用缓存。
      app.loadData().then(function(result) {
        that._doRefreshState();
        if (!result.points || !result.points.success) {
          that.showToast((result.points && result.points.message) || '积分数据刷新失败');
        }
      });
    }
  },

  // ========== 配置加载（带重试 · 页面级） ==========
  _loadConfigAndRefresh: function() {
    var that = this;
    if (this._loadingUsers) return;
    this._loadingUsers = true;
    this.setData({ loadingUsers: true, loadError: false });
    console.log('[index] 加载 /api/config...');

    app.fetchAPI('/api/config', { timeout: 10000 }).then(function(res) {
      that._loadingUsers = false;
      if (res && res.success) {
        console.log('[index] /api/config 成功, 用户数=' + (res.users || []).length);
        app.globalData.allUsers = res.users;
        app.globalData.rules = app.normalizeRules(res.rules);
        // resolve dataReady 让其他等待者也能继续
        if (app.globalData.dataReadyResolve) {
          app.globalData.dataReadyResolve(true);
        }
        that._doRefreshState();
      } else {
        that.setData({ loadingUsers: false, loadError: true });
        if (app.globalData.dataReadyResolve) {
          app.globalData.dataReadyResolve(false);
        }
        that._doRefreshState();  // 渲染空壳
      }
    });
  },

  // ========== 状态刷新 ==========
  refreshState: function() {
    var g = app.globalData;
    // 已登录时直接刷新界面
    if (g.token && g.user) {
      this._doRefreshState();
      return;
    }
    // 未登录且数据已有则刷新
    if (g.allUsers && g.allUsers.length > 0) {
      this._doRefreshState();
      return;
    }
    // 数据还没加载，UI 保持在 loadingUsers 状态
  },

  // 手动重试加载
  onRetryLoad: function() {
    this._loadConfigAndRefresh();
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

    // 用户主题色（header + 卡片的颜色）
    var themeHeader = g.theme === 'mint' ? '#2D9B7A' : '#B86932';
    var headerBg = themeHeader;

    // 用户选项（allUsers 由 onLaunch→dataReady 或 _fetchConfigFallback 保证已加载）
    var allUsers = g.allUsers || [];
    var userOptions = allUsers.map(function(u) { return { id: u.id, name: u.name }; });

    // 孩子卡片：所有用户都能看到所有孩子卡片
    var kids = allUsers.filter(function(u) { return u.role === 'child'; });
    var activeKidView = isChild && g.user ? g.user.id : (this.data.activeKidView || 'all');
    if (!isChild && activeKidView !== 'all' && !kids.some(function(k) { return k.id === activeKidView; })) {
      activeKidView = 'all';
    }
    var allKidCards = kids.map(function(k, i) {
      var c = isChild ? app.getKidColor(k.id) : app.kidColors[i % app.kidColors.length];
      var icon = app.getKidIcon(k.id);
      var val = (g.points && g.points[k.id]) ? g.points[k.id] : 0;
      var absScore = Math.abs(val);
      return {
        id: k.id,
        name: k.name,
        icon: icon,
        jarIcon: i % 2 === 0 ? 'jar-blue' : 'jar-pink',
        avatar: app.getLocalAvatar(k.id),
        skin: app.getKidSkin(k.id),
        sign: val >= 0 ? '+' : '-',
        absScore: absScore,
        scoreSize: absScore >= 100000000
          ? 'score-num-ultralong'
          : (absScore >= 1000000
            ? 'score-num-xxlong'
            : (absScore >= 100000
              ? 'score-num-xlong'
              : (absScore >= 10000
                ? 'score-num-long'
                : (absScore >= 1000 ? 'score-num-medium' : '')))),
        softColor: c.bg,
        borderColor: c.border,
        score: val
      };
    });
    var childCards = activeKidView === 'all'
      ? allKidCards
      : allKidCards.filter(function(k) { return k.id === activeKidView; });
    var kidSwitcher = (isChild ? [] : [{ id: 'all', name: '全部', icon: 'family', avatar: '' }]).concat(
      allKidCards
        .filter(function(k) { return !isChild || k.id === activeKidView; })
        .map(function(k) { return { id: k.id, name: k.name, icon: k.icon, avatar: k.avatar, borderColor: k.borderColor }; })
    ).map(function(k) {
      k.selected = k.id === activeKidView;
      return k;
    });

    // 规则（必须检查 rules.reward 是否为数组，因为 {} 是 truthy 不会触发 fallback）
    var rulesData = rulesViewModel.cloneRules(
      (g.rules && Array.isArray(g.rules.reward)) ? g.rules : { reward: [], punish: [], special: [] }
    );
    var ruleSummary = rulesViewModel.summarizeRules(rulesData);
    var ruleCopy = isChild ? {
      title: '我的成长糖果地图',
      intro: '看看怎样赚糖、怎样护住糖，遇到不明白的可以和家长一起读',
      reward: '怎么赚糖',
      punish: '护糖提醒',
      special: '家庭约定'
    } : {
      title: '我们家的成长约定',
      intro: '和孩子一起看懂通常分值、调整范围和每条规则的原因',
      reward: '鼓励加分',
      punish: '改进提醒',
      special: '家庭约定'
    };
    var ruleBrowserState = this._makeRuleBrowser(
      rulesData,
      isChild,
      this.data.ruleQuery,
      this.data.ruleFilter,
      this.data.ruleExpandedKey
    );
    var frequent = this._buildFrequentRules(rulesData, this.data.historyList);

    this.setData({
      isLoggedIn: isLoggedIn,
      isAdmin: isAdmin,
      isChild: isChild,
      isParent: isParent,
      loadingUsers: false,
      loginStatusText: loginStatusText,
      headerBg: headerBg,
      currentUserName: g.user ? g.user.name : '',
      userOptions: userOptions,
      selectedUserName: userOptions.length > 0 ? userOptions[0].name : '',
      childCards: childCards,
      kidSwitcher: kidSwitcher,
      activeKidView: activeKidView,
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: app.globalData.theme === 'amber' ? 'amber' : 'mint',
      rulesData: rulesData,
      ruleSummary: ruleSummary,
      ruleBrowser: ruleBrowserState.browser,
      ruleExpandedKey: ruleBrowserState.expandedKey,
      ruleFilterOptions: [
        { value: 'all', label: '全部' },
        { value: 'reward', label: ruleCopy.reward },
        { value: 'punish', label: ruleCopy.punish },
        { value: 'special', label: ruleCopy.special }
      ],
      ruleCenterTitle: ruleCopy.title,
      ruleCenterIntro: ruleCopy.intro,
      frequentRules: frequent,
      version: g.version || '2.4.0'
    });

    if (isLoggedIn) {
      this.loadHistory();
    }
  },

  _makeRuleBrowser: function(rulesData, isChild, query, filter, expandedKey) {
    var browser = rulesViewModel.buildBrowserData(rulesData, {
      isChild: isChild,
      query: query,
      filter: filter
    });
    var normalizedQuery = String(query || '').trim();
    var explicitlyCollapsed = expandedKey === '__none__';
    var activeExpandedKey = explicitlyCollapsed ? '' : String(expandedKey || '');
    var hasExpanded = browser.categories.some(function(category) {
      return category.key === activeExpandedKey;
    });
    if (!normalizedQuery && !hasExpanded && !explicitlyCollapsed && browser.categories.length) {
      activeExpandedKey = browser.categories[0].key;
    }
    browser.categories = browser.categories.map(function(category) {
      category.expanded = normalizedQuery ? true : category.key === activeExpandedKey;
      category.items = category.items.map(function(item) {
        item.key = category.key + '-' + item.itemIndex;
        item.categoryId = category.id || '';
        item.categoryKey = category.key;
        return item;
      });
      return category;
    });
    browser.specials = browser.specials.map(function(item, index) {
      item.numberText = index < 9 ? '0' + (index + 1) : String(index + 1);
      return item;
    });
    return { browser: browser, expandedKey: activeExpandedKey };
  },

  _buildFrequentRules: function(rulesData, history) {
    var rules = rulesData || { reward: [], punish: [] };
    return rulesViewModel.frequentRules(rules, history, 4).map(function(item) {
      var categories = Array.isArray(rules[item.type]) ? rules[item.type] : [];
      var category = categories[item.categoryIndex] || categories.find(function(candidate) {
        return candidate && candidate.category === item.category;
      }) || {};
      var categoryId = String(category.id || '');
      item.categoryId = categoryId;
      item.categoryKey = item.type + '-' + (categoryId || item.categoryIndex);
      return item;
    });
  },

  _refreshRuleBrowser: function(options) {
    var opts = options || {};
    var query = opts.query !== undefined ? opts.query : this.data.ruleQuery;
    var filter = opts.filter || this.data.ruleFilter;
    var expandedKey = opts.expandedKey !== undefined ? opts.expandedKey : this.data.ruleExpandedKey;
    var state = this._makeRuleBrowser(
      this.data.rulesData || { reward: [], punish: [], special: [] },
      this.data.isChild,
      query,
      filter,
      expandedKey
    );
    this.setData({
      ruleQuery: query,
      ruleFilter: filter,
      ruleExpandedKey: state.expandedKey,
      ruleBrowser: state.browser
    });
  },

  _saveRuleBrowserPreference: function() {
    wx.setStorageSync(RULE_CENTER_PREF_KEY, {
      filter: this.data.ruleFilter,
      expandedKey: this.data.ruleExpandedKey
    });
  },

  // ========== 登录 ==========
  onWxLogin: function() {
    if (this.data.wxLoginLoading) return;
    var that = this;
    this.setData({ wxLoginLoading: true });
    wx.login({
      success: function(loginRes) {
        if (!loginRes.code) {
          that.setData({ wxLoginLoading: false });
          wx.showToast({ title: '微信登录失败', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '登录中...' });
        app.fetchAPI('/api/wx-login', {
          method: 'POST',
          body: JSON.stringify({ code: loginRes.code })
        }).then(function(res) {
          wx.hideLoading();
          that.setData({ wxLoginLoading: false });
          if (res && res.success && res.token && res.user) {
            // 已绑定 → 直接登录
            app.globalData.token = res.token;
            app.globalData.user = res.user;
            wx.setStorageSync('hefei_token', res.token);
            wx.setStorageSync('hefei_user', JSON.stringify(res.user));
            that.setData({ wxOpenid: '' });
            that.showToast('欢迎，' + res.user.name);
            app.loadData().then(function() { that._doRefreshState(); });
          } else if (res && res.success && res.isNew) {
            // 首次登录 → 引导选择用户绑定
            wx.showToast({ title: '首次使用，请选择用户并输入密码完成绑定', icon: 'none', duration: 3000 });
            that.setData({ wxOpenid: res.openid, showBind: true, loadingUsers: false });
          } else {
            wx.showToast({ title: (res && res.message) || '登录失败', icon: 'none' });
          }
        }).catch(function() {
          wx.hideLoading();
          that.setData({ wxLoginLoading: false });
          wx.showToast({ title: '网络错误', icon: 'none' });
        });
      },
      fail: function() {
        that.setData({ wxLoginLoading: false });
        wx.showToast({ title: 'wx.login 调用失败', icon: 'none' });
      }
    });
  },

  onOpenLoginGuide: function() {
    this.setData({ showLoginGuide: true });
  },

  onCloseLoginGuide: function() {
    wx.setStorageSync('hefei_login_guide_v2', true);
    this.setData({ showLoginGuide: false });
  },

  stopBubble: function() {
  },

  onSelectUser: function(e) {
    var val = (e && e.detail) ? e.detail.value : -1;
    var idx = Number(val);
    if (!Number.isInteger(idx) || idx < 0) return;
    var opts = this.data.userOptions;
    if (!opts || !opts.length || idx >= opts.length) return;
    var name = opts[idx].name;
    this.setData({ selectedUserIdx: idx, selectedUserName: name });
  },

  onPwdInput: function(e) {
    this.setData({ password: e.detail.value });
  },

  onUserIdInput: function(e) {
    this.setData({ manualUserId: String(e.detail.value || '').trim() });
  },

  onLogin: function() {
    var that = this;
    var opts = this.data.userOptions;
    var selected = opts && opts[this.data.selectedUserIdx];
    var uid = selected ? selected.id : this.data.manualUserId;
    if (!uid) {
      wx.showToast({ title: '请选择用户或输入用户ID', icon: 'none' });
      return;
    }
    var pwd = this.data.password;
    if (!pwd) {
      wx.showToast({ title: '请输入密码', icon: 'none' });
      return;
    }
    var loginFn = this.data.wxOpenid
      ? app.fetchAPI('/api/wx-bind', { method: 'POST', body: JSON.stringify({ openid: this.data.wxOpenid, userId: uid, password: pwd }) })
      : app.login(uid, pwd);
    loginFn.then(function(res) {
      if (res && res.success && res.token) {
        // 保存登录态
        app.globalData.token = res.token;
        app.globalData.user = res.user;
        wx.setStorageSync('hefei_token', res.token);
        wx.setStorageSync('hefei_user', JSON.stringify(res.user));
        that.showToast('欢迎，' + res.user.name);
        that.setData({ wxOpenid: '' }); // 清除绑定状态
        app.loadData().then(function() {
          that._doRefreshState();
        });
      } else {
        var msg = (res && res.message) ? res.message : '登录失败';
        wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      }
    }).catch(function() {
      wx.showToast({ title: '登录异常，请重试', icon: 'none' });
    });
  },

  onLogout: function() {
    app.logout();
    var that = this;
    this.setData({
      pickerKey: 0,
      isLoggedIn: false, isAdmin: false, isChild: false, isParent: false,
      loginStatusText: '未登录', childCards: [], historyList: [],
      password: '', selectedUserIdx: 0, selectedUserName: ''
    });
    // 短暂延迟后重建 picker，解决微信 picker 缓存旧索引的 bug
    setTimeout(function() {
      that.setData({ pickerKey: Date.now() });
    }, 80);
    this.showToast('已退出');
  },

  onRefresh: function() {
    if (this.data.isLoggedIn) {
      var that = this;
      app.loadData().then(function() {
        that._doRefreshState();
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
    var kidHistory = (this.data.historyList || []).filter(function(record) { return record.kid === kid; });

    this.setData({
      sheetVisible: true,
      sheetKidId: kid,
      sheetKidName: name,
      sheetKidPoints: points,
      frequentRules: this._buildFrequentRules(this.data.rulesData, kidHistory)
    });
  },

  // ========== 操作弹窗回调 ==========
  onSheetClose: function() {
    this.setData({ sheetVisible: false });
  },

  onRuleSelect: function(e) {
    // 长按规则时进入数字微调。
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

  onKidViewTap: function(e) {
    if (this.data.isChild) return;
    var kidId = e.currentTarget.dataset.kid;
    if (!kidId || kidId === this.data.activeKidView) return;
    this.setData({ activeKidView: kidId });
    this._doRefreshState();
  },

  onRuleQuick: function(e) {
    if (this._quickChanging) return;
    var that = this;
    var item = e.detail || {};
    var amount = Number(item.default);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) {
      this.showToast('规则默认分数无效，请长按调整');
      return;
    }
    this._quickChanging = true;
    this.setData({ sheetVisible: false });
    wx.showToast({
      title: '确认 ' + (amount > 0 ? '+' : '') + amount + ' · ' + (item.label || '积分'),
      icon: 'none',
      duration: 900
    });
    app.doChange(this.data.sheetKidId, amount, item.label || '规则积分', '').then(function(res) {
      that._quickChanging = false;
      if (res.success) {
        that.showToast((that.data.sheetKidName || '') + ' ' + (amount > 0 ? '+' : '') + amount + '分');
        app.loadData().then(function() { that._doRefreshState(); });
      } else {
        that.showToast(res.message || '操作失败');
      }
    }).catch(function() {
      that._quickChanging = false;
      that.showToast('网络异常，请重试');
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
        app.loadData().then(function() { that._doRefreshState(); });
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
    var value = e.detail.value;
    var updates = { numValue: value };
    if (this.data.numItem && this.data.numItem.source === 'rule-detail') {
      updates.numDesc = this._buildRuleScoreDescription(this.data.numItem, value);
    }
    this.setData(updates);
  },

  onNumConfirm: function(e) {
    if (this._scoreSubmitting) return;
    var value = e.detail && Number.isFinite(e.detail.value) ? e.detail.value : this.data.numValue;
    var item = this.data.numItem || {};
    var label = item.label || '';
    var note = e.detail ? e.detail.note : '';
    var kidId = item.kidId || this.data.sheetKidId;
    var kidName = item.kidName || this.data.sheetKidName;
    if (!Number.isInteger(value) || value === 0 || value < item.min || value > item.max) {
      this.showToast('分值不在规则允许范围内');
      return;
    }
    this.setData({ numModalVisible: false, numItem: null });
    this._submitRuleScore(kidId, kidName, value, label, note);
  },

  _submitRuleScore: function(kidId, kidName, value, label, note) {
    if (this._scoreSubmitting) return;
    var that = this;
    this._scoreSubmitting = true;
    app.doChange(kidId, value, label, note).then(function(res) {
      that._scoreSubmitting = false;
      if (res.success) {
        that.showToast((kidName || '') + ' ' + (value > 0 ? '+' : '') + value + '分');
        app.loadData().then(function() { that._doRefreshState(); });
      } else {
        that.showToast(res.message || '操作失败');
      }
    }).catch(function() {
      that._scoreSubmitting = false;
      that.showToast('网络异常，请重试');
    });
  },

  // ========== 切换 Tab ==========
  switchTab: function(e) {
    var tab = e.currentTarget.dataset.tab;
    if (tab === 'report') {
      wx.showModal({
        title: '打开成长报表',
        content: '去成长页查看趋势、分类分布和家庭成长小结。',
        confirmText: '去看看',
        cancelText: '留在首页',
        success: function(res) {
          if (res.confirm) wx.switchTab({ url: '/pages/report/report' });
        }
      });
      return;
    }
    this.setData({ activeTab: tab });
  },

  // ========== 规则中心 ==========
  onRuleQueryInput: function(e) {
    this._refreshRuleBrowser({ query: String((e.detail && e.detail.value) || '') });
  },

  onRuleQueryClear: function() {
    this._refreshRuleBrowser({ query: '' });
  },

  onRuleFilterTap: function(e) {
    var filter = e.currentTarget.dataset.filter;
    if (['all', 'reward', 'punish', 'special'].indexOf(filter) < 0 || filter === this.data.ruleFilter) return;
    this._refreshRuleBrowser({ filter: filter, expandedKey: '' });
    this._saveRuleBrowserPreference();
  },

  onRuleCategoryTap: function(e) {
    if (String(this.data.ruleQuery || '').trim()) return;
    var key = String(e.currentTarget.dataset.key || '');
    var expandedKey = key === this.data.ruleExpandedKey ? '__none__' : key;
    this._refreshRuleBrowser({ expandedKey: expandedKey });
    this._saveRuleBrowserPreference();
  },

  onRuleItemTap: function(e) {
    this._openRuleDetail(e.currentTarget.dataset.item);
  },

  onFrequentRuleTap: function(e) {
    this._openRuleDetail(e.currentTarget.dataset.item);
  },

  onSpecialRuleTap: function(e) {
    var item = e.currentTarget.dataset.item || {};
    this.setData({
      ruleDetailVisible: true,
      ruleDetail: {
        isSpecial: true,
        label: '我们家的约定',
        typeText: this.data.isChild ? '和家人一起遵守' : '全家共同遵守',
        hintText: String(item.text || ''),
        toneClass: 'special'
      }
    });
  },

  _openRuleDetail: function(item) {
    if (!item) return;
    var isReward = item.type === 'reward' || item.isReward;
    var isChild = this.data.isChild;
    var raw = item.raw && typeof item.raw === 'object' ? item.raw : item;
    var defaultValue = item.defaultValue === null || item.defaultValue === undefined
      ? Number(raw.default)
      : Number(item.defaultValue);
    var minValue = item.min === null || item.min === undefined ? Number(raw.min) : Number(item.min);
    var maxValue = item.max === null || item.max === undefined ? Number(raw.max) : Number(item.max);
    var fallbackHint = isReward
      ? (isChild
        ? '做到这件事，就是在给自己的成长糖罐添糖。'
        : '看到孩子做到这件事时，及时说出具体的努力并给予鼓励。')
      : (isChild
        ? '一次提醒不代表失败，知道原因、下次做好，就能继续护住糖果。'
        : '先说明发生了什么，再和孩子约定下一次可以怎样做。');
    this.setData({
      ruleDetailVisible: true,
      ruleDetail: {
        isSpecial: false,
        label: item.label || '未命名规则',
        typeText: isReward
          ? (isChild ? '怎么赚糖' : '鼓励加分')
          : (isChild ? '护糖提醒' : '改进提醒'),
        defaultCaption: isChild
          ? (isReward ? '通常会得到' : '通常会扣掉')
          : '通常分值',
        defaultText: item.defaultValue === null || item.defaultValue === undefined
          ? (item.defaultText || '分值待设置')
          : (rulesViewModel.signedNumber(item.defaultValue) + ' 分'),
        rangeCaption: isChild ? '一次大约是' : '可调整范围',
        rangeText: item.min === null || item.max === null
          ? (item.rangeText || '范围待设置')
          : (item.rangeText + ' 分'),
        unitText: item.unit || '按每次记录',
        hintCaption: isChild ? '为什么这样做' : '给孩子这样解释',
        hintText: item.hint || fallbackHint,
        toneClass: isReward ? 'reward' : 'punish',
        canScore: !!this.data.isParent && !isChild,
        scoreRule: {
          raw: raw,
          id: String(item.id || raw.id || ''),
          label: String(item.label || raw.label || '未命名规则'),
          aliases: Array.isArray(item.aliases) ? item.aliases.slice() : (Array.isArray(raw.aliases) ? raw.aliases.slice() : []),
          type: isReward ? 'reward' : 'punish',
          category: String(item.category || ''),
          categoryId: String(item.categoryId || raw.categoryId || ''),
          categoryKey: String(item.categoryKey || ''),
          min: minValue,
          max: maxValue,
          default: defaultValue,
          unit: String(item.unit || raw.unit || '')
        }
      }
    });
  },

  onRuleDetailScore: function() {
    if (this._detailScoreOpening || this._scoreSubmitting) return;
    var detail = this.data.ruleDetail;
    if (this.data.isChild || !this.data.isParent || !detail || detail.isSpecial || !detail.scoreRule) return;
    if (!app.canOperate()) {
      this.showToast('当前账号没有记分权限');
      return;
    }

    var user = app.globalData.user || {};
    var kids = (app.globalData.allUsers || []).filter(function(candidate) {
      return candidate.role === 'child' && (!user.familyId || !candidate.familyId || candidate.familyId === user.familyId);
    });
    if (!kids.length) {
      this.showToast('当前家庭还没有可记分的孩子');
      return;
    }

    var activeKidId = this.data.activeKidView;
    var activeKid = activeKidId && activeKidId !== 'all'
      ? kids.find(function(kid) { return kid.id === activeKidId; })
      : null;
    if (activeKid) {
      this._openRuleScoreModal(activeKid, detail.scoreRule);
      return;
    }

    var that = this;
    this._detailScoreOpening = true;
    wx.showActionSheet({
      itemList: kids.map(function(kid) { return '给 ' + kid.name + ' 记分'; }),
      success: function(result) {
        that._detailScoreOpening = false;
        var kid = kids[result.tapIndex];
        if (kid) that._openRuleScoreModal(kid, detail.scoreRule);
      },
      fail: function() {
        that._detailScoreOpening = false;
      }
    });
  },

  _openRuleScoreModal: function(kid, rule) {
    if (!kid || !rule || this.data.isChild || !this.data.isParent) return;
    var type = rule.type === 'punish' ? 'punish' : 'reward';
    var min = Number(rule.min);
    var max = Number(rule.max);
    var value = Number(rule.default);
    var validRange = Number.isInteger(min) && Number.isInteger(max) && min <= max && (
      type === 'punish'
        ? min >= -500 && max <= -1
        : min >= 0 && max <= 1000
    );
    if (!validRange) {
      this.showToast('规则分值范围异常，请管理员先修正');
      return;
    }
    var validDefault = Number.isInteger(value) && value !== 0 && value >= min && value <= max;
    if (!validDefault) {
      if (type === 'punish') {
        value = max;
      } else {
        value = min > 0 ? min : (max >= 1 ? 1 : 0);
      }
      if (!Number.isInteger(value) || value === 0 || value < min || value > max) {
        this.showToast('该规则暂无可记录的非零分值，请管理员先修正');
        return;
      }
      this.showToast('默认分值异常，请调整后确认');
    }

    var points = Number((app.globalData.points && app.globalData.points[kid.id]) || 0);
    var modalItem = {
      source: 'rule-detail',
      raw: rule.raw,
      id: rule.id,
      label: rule.label || '规则积分',
      aliases: rule.aliases || [],
      type: type,
      category: rule.category || '',
      categoryId: rule.categoryId || '',
      min: min,
      max: max,
      kidId: kid.id,
      kidName: kid.name,
      unit: rule.unit || ''
    };
    this.setData({
      ruleDetailVisible: false,
      sheetKidId: kid.id,
      sheetKidName: kid.name,
      sheetKidPoints: points,
      numModalVisible: true,
      numTitle: kid.name + ' · ' + modalItem.label,
      numDesc: this._buildRuleScoreDescription(modalItem, value),
      numValue: value,
      numItem: modalItem
    });
  },

  _buildRuleScoreDescription: function(item, value) {
    var signed = (value > 0 ? '+' : '') + value;
    var minText = (item.min > 0 ? '+' : '') + item.min;
    var maxText = (item.max > 0 ? '+' : '') + item.max;
    return '确认 ' + item.kidName + ' 按「' + item.label + '」' + signed + ' 分 · 可调 ' + minText + '～' + maxText + ' 分' + (item.unit ? ' · ' + item.unit : '');
  },

  onRuleDetailClose: function() {
    this.setData({ ruleDetailVisible: false, ruleDetail: null });
  },

  // ========== 加载历史 ==========
  loadHistory: function() {
    var that = this;
    var allUsers = app.globalData.allUsers || [];
    var selfKid = (this.data.isChild && app.globalData.user)
      ? app.globalData.user.id
      : (this.data.activeKidView !== 'all' ? this.data.activeKidView : null);
    app.fetchAPI('/api/history').then(function(data) {
      if (!data || !data.history || data.history.length === 0) {
        that.setData({
          historyList: [],
          frequentRules: that._buildFrequentRules(that.data.rulesData, [])
        });
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
      that.setData({
        historyList: list,
        frequentRules: that._buildFrequentRules(that.data.rulesData, list)
      });
    });
  },

  // ========== 历史记录点击 → 详情 ==========
  onRecordTap: function(e) {
    var idx = e.currentTarget.dataset.index;
    var record = this.data.historyList[idx];
    if (record) {
      app.globalData.pendingRecordId = record.id;
      wx.switchTab({ url: '/pages/records/records' });
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
