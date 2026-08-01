// pages/records/records.js
var app = getApp();

Page({
  data: {
    allRecords: [],
    filteredList: [],
    groupedList: [],
    activeFilter: 'all',
    detailVisible: false,
    detailRecord: {},
    detailNoteFocus: false,
    isLoggedIn: false,
    isChild: false,
    themePageStyle: '',
    themeClass: '',
    toastMessage: '',
    toastVisible: false
  },

  onShow: function() {
    var g = getApp().globalData;
    var isLoggedIn = !!(g.token && g.user);
    this.setData({
      isLoggedIn: isLoggedIn,
      isChild: !!(g.user && g.user.role === 'child'),
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : ''
    });
    if (isLoggedIn) {
      this.loadRecords();
    }
  },

  goLogin: function() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // ========== 加载记录 ==========
  loadRecords: function() {
    var that = this;
    var g = getApp().globalData;
    var allUsers = g.allUsers || [];
    var selfKid = (g.user && g.user.role === 'child') ? g.user.id : null;
    app.fetchAPI('/api/history').then(function(data) {
      if (!data.history) data.history = [];
      var records = data.history.map(function(r) {
        var user = allUsers.find(function(u) { return u.id === r.kid; });
        var kidColor = app.getKidColor(r.kid);
        return {
          recordId: r.id,
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
        records = records.filter(function(r) { return r.kid === selfKid; });
      }
      that.setData({ allRecords: records });
      that.applyFilter();
      if (app.globalData.pendingRecordId) {
        var pendingId = app.globalData.pendingRecordId;
        app.globalData.pendingRecordId = '';
        var pendingRecord = records.find(function(r) { return r.recordId === pendingId; });
        if (pendingRecord) {
          that.setData({ detailVisible: true, detailRecord: pendingRecord, detailNoteFocus: false });
        }
      }
    });
  },

  // ========== 筛选 ==========
  onFilter: function(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.filter });
    this.applyFilter();
  },

  applyFilter: function() {
    var filter = this.data.activeFilter;
    var records = this.data.allRecords;
    var filtered = records;
    if (filter === 'add') {
      filtered = records.filter(function(r) { return r.amount > 0; });
    } else if (filter === 'use') {
      filtered = records.filter(function(r) { return r.amount < 0; });
    }

    // 按月份分组
    var groups = {};
    filtered.forEach(function(r) {
      var month = (r.time || '').split(' ')[0];
      if (month.length > 7) month = month.substring(0, 7);
      if (!groups[month]) groups[month] = [];
      groups[month].push(r);
    });
    var groupedList = Object.keys(groups).sort().reverse().map(function(m) {
      return { month: m, items: groups[m] };
    });

    this.setData({
      filteredList: filtered,
      groupedList: groupedList
    });
  },

  // ========== 记录详情 ==========
  onRecordTap: function(e) {
    if (this._ignoreRecordTap) {
      this._ignoreRecordTap = false;
      clearTimeout(this._recordTapGuardTimer);
      return;
    }
    var id = e.currentTarget.dataset.id;
    this.openRecordDetail(id, false);
  },

  onRecordLongPress: function(e) {
    this._ignoreRecordTap = true;
    clearTimeout(this._recordTapGuardTimer);
    this.openRecordDetail(e.currentTarget.dataset.id, true);
  },

  onRecordTouchEnd: function() {
    if (!this._ignoreRecordTap) return;
    var that = this;
    clearTimeout(this._recordTapGuardTimer);
    this._recordTapGuardTimer = setTimeout(function() {
      that._ignoreRecordTap = false;
    }, 300);
  },

  openRecordDetail: function(id, focusNote) {
    var record = this.data.allRecords.find(function(r) { return r.recordId === id; });
    if (record) {
      this.setData({
        detailVisible: true,
        detailRecord: record,
        detailNoteFocus: !!focusNote
      });
    }
  },

  onDetailClose: function() {
    this.setData({ detailVisible: false, detailNoteFocus: false });
  },

  onSaveNote: function(e) {
    var that = this;
    if (this.data.isChild) {
      this.showToast('无操作权限');
      return;
    }
    var detail = e.detail;
    app.fetchAPI('/api/history/note', {
      method: 'POST',
      body: JSON.stringify({
        token: app.globalData.token,
        recordId: detail.recordId,
        note: detail.note
      })
    }).then(function(res) {
      if (res.success) {
        that.setData({ detailVisible: false, detailNoteFocus: false });
        that.showToast('备注已保存');
        that.loadRecords();
      } else {
        that.showToast(res.message || '保存失败');
      }
    });
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
