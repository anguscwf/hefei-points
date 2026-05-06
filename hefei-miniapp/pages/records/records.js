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
    toastMessage: '',
    toastVisible: false
  },

  onShow: function() {
    this.loadRecords();
  },

  // ========== 加载记录 ==========
  loadRecords: function() {
    var that = this;
    var allUsers = app.globalData.allUsers || [];
    app.fetchAPI('/api/history?token=' + (app.globalData.token || '')).then(function(data) {
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
      that.setData({ allRecords: records });
      that.applyFilter();
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
    var id = e.currentTarget.dataset.id;
    var record = this.data.allRecords.find(function(r) { return r.recordId === id; });
    if (record) {
      this.setData({ detailVisible: true, detailRecord: record });
    }
  },

  onDetailClose: function() {
    this.setData({ detailVisible: false });
  },

  onSaveNote: function(e) {
    var that = this;
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
        that.setData({ detailVisible: false });
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
