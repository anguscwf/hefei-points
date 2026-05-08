// pages/report/report.js
var app = getApp();

Page({
  data: {
    reportRange: 'week',
    reportKid: 'all',
    reportCat: 'all',
    reportMode: 'score',
    dateFrom: '',
    dateTo: '',
    kidOptions: [],
    catOptions: [],
    allData: [],
    filteredData: [],
    summaryData: [],
    top10List: [],
    isChild: false,
    shareImagePath: '',
    sharePreviewVisible: false
  },

  onShow: function() {
    var g = app.globalData;
    var selfKid = (g.user && g.user.role === 'child') ? g.user.id : null;
    this.setData({ isChild: !!selfKid, reportKid: selfKid || 'all' });
    this.prepareOptions();
    this.loadAndRender();
  },

  // ========== 准备选项 ==========
  prepareOptions: function() {
    var allUsers = app.globalData.allUsers || [];
    var kids = allUsers.filter(function(u) { return u.role === 'child'; });
    var kidOptions = kids.map(function(k, i) {
      var c = app.kidColors[i % app.kidColors.length];
      return { id: k.id, name: k.name, color: c.border };
    });

    var rules = app.globalData.rules || {};
    var catOptions = [];
    if (rules.reward) {
      rules.reward.forEach(function(c) { catOptions.push({ name: c.category, type: 'reward' }); });
    }
    if (rules.punish) {
      rules.punish.forEach(function(c) { catOptions.push({ name: c.category, type: 'punish' }); });
    }

    this.setData({ kidOptions: kidOptions, catOptions: catOptions });
  },

  // ========== 加载和渲染 ==========
  loadAndRender: function() {
    var that = this;
    var g = app.globalData;
    var selfKid = (g.user && g.user.role === 'child') ? g.user.id : null;
    app.fetchAPI('/api/history?token=' + (g.token || '')).then(function(data) {
      if (!data.history) data.history = [];
      // 孩子角色：仅保留自己的记录
      if (selfKid) {
        data.history = data.history.filter(function(r) { return r.kid === selfKid; });
        that.setData({ reportKid: selfKid, allData: data.history });
      } else {
        that.setData({ allData: data.history });
      }
      that.applyFilters();
    });
  },

  // ========== 筛选 ==========
  onRange: function(e) {
    this.setData({ reportRange: e.currentTarget.dataset.range });
    this.applyFilters();
  },
  onKid: function(e) {
    this.setData({ reportKid: e.currentTarget.dataset.kid });
    this.applyFilters();
  },
  onCat: function(e) {
    this.setData({ reportCat: e.currentTarget.dataset.cat });
    this.applyFilters();
  },
  onMode: function(e) {
    this.setData({ reportMode: e.currentTarget.dataset.mode });
    this.applyFilters();
  },
  onDateFrom: function(e) { this.setData({ dateFrom: e.detail.value }); },
  onDateTo: function(e) { this.setData({ dateTo: e.detail.value }); },
  onCustomQuery: function() {
    this.applyFilters();
  },

  applyFilters: function() {
    var that = this;
    var allData = this.data.allData;
    var reportRange = this.data.reportRange;
    var reportKid = this.data.reportKid;
    var reportCat = this.data.reportCat;
    var reportMode = this.data.reportMode;

    var now = new Date();
    var rangeStart, rangeEnd;
    if (reportRange === 'custom' && this.data.dateFrom) {
      rangeStart = new Date(this.data.dateFrom + 'T00:00:00');
      rangeEnd = new Date((this.data.dateTo || this.data.dateFrom) + 'T23:59:59');
    } else if (reportRange === 'week') {
      rangeStart = new Date(now - 7 * 24 * 3600 * 1000);
      rangeEnd = now;
    } else if (reportRange === 'month') {
      rangeStart = new Date(now - 30 * 24 * 3600 * 1000);
      rangeEnd = now;
    } else {
      rangeStart = new Date(0);
      rangeEnd = now;
    }

    var rules = app.globalData.rules || {};
    var allCats = [];
    if (rules.reward) rules.reward.forEach(function(c) { allCats.push(c); });
    if (rules.punish) rules.punish.forEach(function(c) { allCats.push(c); });

    var filtered = allData.filter(function(r) {
      var d = new Date(r.time.replace(/\//g, '-'));
      if (d < rangeStart) return false;
      if (reportRange !== 'all' && d > rangeEnd) return false;
      if (reportKid !== 'all' && r.kid !== reportKid) return false;
      if (reportCat !== 'all') {
        var cat = allCats.find(function(c) { return c.category === reportCat; });
        if (!cat) return false;
        if (!cat.items.some(function(item) { return r.reason === item.label; })) return false;
      }
      return true;
    });

    // 总结数据
    var allUsers = app.globalData.allUsers || [];
    var kids = allUsers.filter(function(u) { return u.role === 'child'; });
    var targetKids = reportKid === 'all' ? kids : kids.filter(function(k) { return k.id === reportKid; });

    var summaryData = targetKids.map(function(k) {
      var kData = filtered.filter(function(r) { return r.kid === k.id; });
      var add = kData.filter(function(r) { return r.amount > 0; }).reduce(function(s, r) { return s + r.amount; }, 0);
      var sub = kData.filter(function(r) { return r.amount < 0; }).reduce(function(s, r) { return s + Math.abs(r.amount); }, 0);
      return { kid: k.id, kidName: k.name, add: add, sub: sub, net: add - sub };
    });

    // Top 10
    var sorted = filtered.slice().sort(function(a, b) { return Math.abs(b.amount) - Math.abs(a.amount); }).slice(0, 10);
    var top10List = sorted.map(function(r) {
      var u = allUsers.find(function(x) { return x.id === r.kid; });
      return {
        amount: r.amount,
        reason: r.reason,
        kidName: u ? u.name : r.kid,
        operator: r.operator
      };
    });

    this.setData({
      filteredData: filtered,
      summaryData: summaryData,
      top10List: top10List,
      _allCats: allCats,
      _targetKids: targetKids,
      _filtered: filtered,
      _reportMode: reportMode
    });

    // 延迟绘制Canvas（等DOM渲染完）
    setTimeout(function() {
      that.drawTrendChart();
      that.drawPieChart();
    }, 300);
  },

  // ========== 趋势柱状图 ==========
  drawTrendChart: function() {
    var that = this;
    var query = wx.createSelectorQuery();
    query.select('#trendCanvas').fields({ node: true, size: true }).exec(function(res) {
      if (!res || !res[0]) return;
      var canvas = res[0].node;
      var ctx = canvas.getContext('2d');
      var dpr = wx.getSystemInfoSync().pixelRatio;
      var w = res[0].width;
      var h = res[0].height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      var filtered = that.data._filtered || [];
      var targetKids = that.data._targetKids || [];
      var reportMode = that.data._reportMode || 'score';

      // 按日聚合
      var dailyMap = {};
      filtered.forEach(function(r) {
        var day = r.time.split(' ')[0].slice(5);
        if (!dailyMap[day]) dailyMap[day] = {};
        if (!dailyMap[day][r.kid]) dailyMap[day][r.kid] = 0;
        dailyMap[day][r.kid] += reportMode === 'count' ? 1 : r.amount;
      });
      var days = Object.keys(dailyMap).sort();

      if (days.length === 0) return;

      var allVals = [];
      days.forEach(function(d) {
        targetKids.forEach(function(k) { allVals.push(dailyMap[d][k.id] || 0); });
      });
      var maxAbs = Math.max.apply(null, allVals.map(Math.abs)) || 1;
      var maxVal = Math.ceil(maxAbs * 1.2);

      var pL = 50, pR = 20, pT = 10, pB = 25;
      var aW = w - pL - pR;
      var aH = h - pT - pB;
      var zY = pT + aH / 2;

      // 零线
      ctx.strokeStyle = '#ddd';
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(pL, zY); ctx.lineTo(w - pR, zY);
      ctx.stroke();
      ctx.setLineDash([]);

      // 刻度
      ctx.fillStyle = '#999';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('0', pL - 4, zY + 4);

      var bG = aW / days.length;
      var kidColors = app.kidColors;
      var numKids = targetKids.length;
      var bW = Math.min(14, bG * 0.55);

      days.forEach(function(d, di) {
        var bx = pL + bG * di + (bG - bW * numKids - (numKids - 1) * 2) / 2;
        targetKids.forEach(function(k, ki) {
          var val = dailyMap[d][k.id] || 0;
          var bh = Math.abs(val) / maxVal * (aH / 2);
          if (bh < 1 && val !== 0) bh = 1;
          var kiO = targetKids.indexOf(k);
          var c = kidColors[kiO >= 0 ? kiO % kidColors.length : 0];
          var by = val >= 0 ? (zY - bh) : zY;
          var bX = bx + ki * (bW + 2);

          ctx.fillStyle = c.border;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(bX, by, bW, Math.max(bh, 1));
          ctx.globalAlpha = 1;

          if (Math.abs(val) > 0) {
            var label = reportMode === 'count' ? val : (val >= 0 ? '+' : '') + val;
            ctx.fillStyle = c.border;
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            var lY = val >= 0 ? (by - 5) : (by + bh + 13);
            ctx.fillText(label, bX + bW / 2, lY);
          }
        });

        if (di % Math.max(1, Math.ceil(days.length / 8)) === 0) {
          var mX = bx + (bW * numKids + (numKids - 1) * 2) / 2;
          ctx.fillStyle = '#999';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(d, mX, h - 8);
        }
      });
    });
  },

  // ========== 饼图 ==========
  drawPieChart: function() {
    var that = this;
    var query = wx.createSelectorQuery();
    query.select('#pieCanvas').fields({ node: true, size: true }).exec(function(res) {
      if (!res || !res[0]) return;
      var canvas = res[0].node;
      var ctx = canvas.getContext('2d');
      var dpr = wx.getSystemInfoSync().pixelRatio;
      var w = res[0].width;
      var h = res[0].height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      var filtered = that.data._filtered || [];
      var allCats = that.data._allCats || [];
      var reportMode = that.data._reportMode || 'score';

      var rules = app.globalData.rules || {};
      var catTotals = {};
      filtered.forEach(function(r) {
        var cat = allCats.find(function(c) { return c.items.some(function(item) { return r.reason === item.label; }); });
        var catName = cat ? cat.category : '其他';
        if (!catTotals[catName]) catTotals[catName] = { total: 0, count: 0 };
        catTotals[catName].total += Math.abs(r.amount);
        catTotals[catName].count += 1;
      });
      var catEntries = Object.entries(catTotals);
      var grandTotal = catEntries.reduce(function(s, e) { return s + (reportMode === 'count' ? e[1].count : e[1].total); }, 0);

      if (catEntries.length === 0 || grandTotal === 0) return;

      var pieColors = ['#4A90D9', '#E87DA8', '#5C9919', '#E24B4A', '#B86932', '#8B5CF6', '#F59E0B', '#06B6D4'];
      var pCX = w / 2, pCY = h / 2 - 10, pR = Math.min(w, h) / 2 - 30;
      var angle = -Math.PI / 2;

      catEntries.forEach(function(entry, ei) {
        var val = reportMode === 'count' ? entry[1].count : entry[1].total;
        var sliceAngle = val / grandTotal * 2 * Math.PI;
        var endAngle = angle + sliceAngle;

        ctx.beginPath();
        ctx.moveTo(pCX, pCY);
        ctx.arc(pCX, pCY, pR, angle, endAngle);
        ctx.closePath();
        ctx.fillStyle = pieColors[ei % pieColors.length];
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        var pct = (val / grandTotal * 100).toFixed(0);
        if (parseInt(pct) >= 5) {
          var midAngle = angle + sliceAngle / 2;
          var lr = pR * 0.6;
          var lx = pCX + lr * Math.cos(midAngle);
          var ly = pCY + lr * Math.sin(midAngle);
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pct + '%', lx, ly);
        }
        angle = endAngle;
      });

      // 图例
      var legendY = h - 18;
      ctx.textBaseline = 'alphabetic';
      catEntries.forEach(function(entry, ei) {
        var val = reportMode === 'count' ? entry[1].count : entry[1].total;
        ctx.fillStyle = pieColors[ei % pieColors.length];
        ctx.fillRect(10 + ei * 80, legendY - 8, 8, 8);
        ctx.fillStyle = '#555';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        var shortName = entry[0].length > 4 ? entry[0].substring(0, 4) + '..' : entry[0];
        ctx.fillText(shortName + ' ' + val, 22 + ei * 80, legendY);
      });
    });
  },

  // ========== 分享卡片 ==========
  onMakeShare: function() {
    var that = this;
    wx.showLoading({ title: '生成分享图...' });

    var ctx = wx.createCanvasContext('shareCanvas', this);
    var W = 750, H = 1000;
    var g = app.globalData;
    var allUsers = g.allUsers || [];

    // 背景
    ctx.setFillStyle('#F9F6F1');
    ctx.fillRect(0, 0, W, H);

    // 顶部装饰条
    ctx.setFillStyle('#B86932');
    ctx.fillRect(0, 0, W, 8);

    // 标题
    ctx.setFillStyle('#B86932');
    ctx.setFontSize(44);
    ctx.setTextAlign('center');
    ctx.fillText('恩霖积分', W / 2, 80);

    // 副标题
    ctx.setFillStyle('#999');
    ctx.setFontSize(24);
    ctx.fillText('恩霖润物育儿积分 · 成长每一步都值得记录', W / 2, 120);

    // 白色卡片背景
    ctx.setFillStyle('#FFFFFF');
    ctx.setShadow(0, 4, 20, 'rgba(0,0,0,0.08)');
    ctx.fillRect(40, 160, W - 80, 340);
    ctx.setShadow(0, 0, 0, 'transparent');

    // 孩子头像和名字
    var kids = (g.allUsers || []).filter(function(u) { return u.role === 'child'; });
    if (that.data.reportKid !== 'all') {
      kids = kids.filter(function(k) { return k.id === that.data.reportKid; });
    }

    kids.forEach(function(k, i) {
      var yBase = 200 + i * 150;
      var c = app.kidColors[i % app.kidColors.length];

      // 头像圈
      ctx.setFillStyle(c.border);
      ctx.beginPath();
      ctx.arc(80, yBase + 25, 30, 0, 2 * Math.PI);
      ctx.fill();

      // 名字
      ctx.setFillStyle(c.border);
      ctx.setFontSize(32);
      ctx.setTextAlign('left');
      ctx.fillText(k.name, 130, yBase + 35);

      // 积分
      var val = g.points && g.points[k.id] ? g.points[k.id] : 0;
      var sign = val >= 0 ? '+' : '';
      ctx.setFillStyle(val >= 0 ? '#5C9919' : '#E24B4A');
      ctx.setFontSize(52);
      ctx.fillText(sign + val + ' 分', 130, yBase + 100);
    });

    // 底部总结
    var summaryY = 540;
    var addTotal = that.data.summaryData.reduce(function(s, r) { return s + r.add; }, 0);
    var subTotal = that.data.summaryData.reduce(function(s, r) { return s + r.sub; }, 0);

    ctx.setFillStyle('#FFFFFF');
    ctx.setShadow(0, 4, 20, 'rgba(0,0,0,0.08)');
    ctx.fillRect(40, summaryY, W - 80, 180);
    ctx.setShadow(0, 0, 0, 'transparent');

    ctx.setFillStyle('#333');
    ctx.setFontSize(28);
    ctx.setTextAlign('center');
    ctx.fillText('本周总结', W / 2, summaryY + 50);

    ctx.setFillStyle('#5C9919');
    ctx.setFontSize(36);
    ctx.fillText('获得 +' + addTotal, W / 2 - 100, summaryY + 110);

    ctx.setFillStyle('#E24B4A');
    ctx.fillText('扣减 -' + subTotal, W / 2 + 100, summaryY + 110);

    // 底部文字
    ctx.setFillStyle('#999');
    ctx.setFontSize(22);
    ctx.setTextAlign('center');
    ctx.fillText('恩霖润物育儿积分 · 记录成长每一步', W / 2, H - 60);

    ctx.draw(false, function() {
      setTimeout(function() {
        wx.canvasToTempFilePath({
          canvasId: 'shareCanvas',
          success: function(res) {
            wx.hideLoading();
            that.setData({ shareImagePath: res.tempFilePath, sharePreviewVisible: true });
          },
          fail: function(err) {
            wx.hideLoading();
            wx.showToast({ title: '生成失败', icon: 'none' });
          }
        }, that);
      }, 500);
    });
  },

  onSaveToAlbum: function() {
    var that = this;
    if (!that.data.shareImagePath) return;
    wx.saveImageToPhotosAlbum({
      filePath: that.data.shareImagePath,
      success: function() {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
        that.setData({ sharePreviewVisible: false });
      },
      fail: function(err) {
        if (err.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请允许保存图片到相册',
            confirmText: '去设置',
            success: function(mr) { if (mr.confirm) wx.openSetting(); }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  onCloseSharePreview: function() {
    this.setData({ sharePreviewVisible: false });
  }
});
