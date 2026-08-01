// pages/report/report.js
var app = getApp();

var CANVAS_FONT_TOKENS = { xs: 22, sm: 26, md: 30, lg: 36, xl: 48 };
function canvasFont(token, weight, scale) {
  var size = CANVAS_FONT_TOKENS[token] || CANVAS_FONT_TOKENS.md;
  var prefix = weight ? weight + ' ' : '';
  return prefix + Math.round(size * (scale || 1)) + 'px sans-serif';
}

function recordDate(record) {
  var raw = record && record.time;
  if (typeof raw === 'number') {
    var timestampDate = new Date(raw);
    return isNaN(timestampDate.getTime()) ? null : timestampDate;
  }
  var text = String(raw || '').trim();
  var match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    var localDate = new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)
    );
    return isNaN(localDate.getTime()) ? null : localDate;
  }
  var date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function localDateFromYmd(text, endOfDay) {
  var parts = String(text || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(function(part) { return !Number.isFinite(part); })) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
}

function reportDayKey(record) {
  var date = recordDate(record);
  if (!date) return '';
  var pad = function(value) { return value < 10 ? '0' + value : String(value); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function netPoints(records) {
  return records.reduce(function(sum, record) { return sum + Number(record.amount || 0); }, 0);
}

// 规则改名后，历史流水仍保存当时的 reason；用 aliases 将旧名称归回当前规则。
function ruleReasonMatches(item, reason) {
  if (!item || typeof item !== 'object') return false;
  var target = String(reason || '').trim();
  if (!target) return false;
  var names = [item.label].concat(Array.isArray(item.aliases) ? item.aliases : []);
  return names.some(function(name) { return String(name || '').trim() === target; });
}

function longestHabitStreak(records) {
  var dayMap = {};
  records.forEach(function(record) {
    if (record.amount <= 0 || !/(全勤|打卡|坚持)/.test(record.reason || '')) return;
    var date = recordDate(record);
    if (date) dayMap[date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate()] = date;
  });
  var days = Object.keys(dayMap).map(function(key) { return dayMap[key]; }).sort(function(a, b) { return a - b; });
  var best = 0, current = 0, previous = null;
  days.forEach(function(day) {
    var normalized = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    current = previous && normalized - previous === 86400000 ? current + 1 : 1;
    if (current > best) best = current;
    previous = normalized;
  });
  return best;
}

function signedPoints(value) {
  var number = Number(value || 0);
  return (number >= 0 ? '+' : '') + number;
}

function uniqueDayCount(records) {
  var days = {};
  records.forEach(function(record) {
    var key = reportDayKey(record);
    if (key) days[key] = true;
  });
  return Object.keys(days).length;
}

function positiveStreakStats(records) {
  var dayMap = {};
  records.forEach(function(record) {
    if (Number(record.amount || 0) <= 0) return;
    var key = reportDayKey(record);
    if (key) dayMap[key] = true;
  });
  var days = Object.keys(dayMap).sort();
  if (!days.length) return { current: 0, best: 0, activeDays: 0 };

  var best = 1;
  var running = 1;
  for (var i = 1; i < days.length; i++) {
    var previous = localDateFromYmd(days[i - 1], false);
    var current = localDateFromYmd(days[i], false);
    running = current - previous === 86400000 ? running + 1 : 1;
    if (running > best) best = running;
  }

  var recent = 1;
  for (var j = days.length - 1; j > 0; j--) {
    var latest = localDateFromYmd(days[j], false);
    var before = localDateFromYmd(days[j - 1], false);
    if (latest - before !== 86400000) break;
    recent++;
  }
  return { current: recent, best: best, activeDays: days.length };
}

function growthStageFor(records, streak) {
  var positiveRecords = records.filter(function(record) { return Number(record.amount || 0) > 0; });
  var positiveCount = positiveRecords.length;
  var distinctReasons = {};
  positiveRecords.forEach(function(record) {
    if (record.reason) distinctReasons[record.reason] = true;
  });

  var stages = [
    { min: 0, next: 5, title: '糖罐萌芽', nextTitle: '习惯新星', rank: 1 },
    { min: 5, next: 15, title: '习惯新星', nextTitle: '坚持达人', rank: 2 },
    { min: 15, next: 30, title: '坚持达人', nextTitle: '成长闪耀', rank: 3 },
    { min: 30, next: 0, title: '成长闪耀', nextTitle: '', rank: 3 }
  ];
  var stage = stages[0];
  stages.forEach(function(candidate) {
    if (positiveCount >= candidate.min) stage = candidate;
  });
  var progress = stage.next
    ? Math.max(0, Math.min(100, Math.round((positiveCount - stage.min) / (stage.next - stage.min) * 100)))
    : 100;
  var nextText = stage.next
    ? ('再记录 ' + (stage.next - positiveCount) + ' 次正向成长，解锁“' + stage.nextTitle + '”')
    : '已解锁当前最高成长阶段';

  var badges = [];
  if (positiveCount >= 1) badges.push('点亮糖罐');
  if (positiveCount >= 10) badges.push('好习惯×10');
  if (streak.activeDays >= 3) badges.push('成长三日');
  if (streak.best >= 3) badges.push('坚持之星');
  if (Object.keys(distinctReasons).length >= 3) badges.push('多元探索');
  if (!badges.length) badges.push('勇敢再出发');

  return {
    title: stage.title,
    rank: stage.rank,
    progress: progress,
    nextText: nextText,
    positiveCount: positiveCount,
    badges: badges.slice(0, 3),
    badgeText: badges.slice(0, 3).join(' · ')
  };
}

function topHabitFor(records, previousRecords, compareEnabled) {
  var stats = {};
  records.forEach(function(record) {
    if (Number(record.amount || 0) <= 0) return;
    var reason = String(record.reason || '其他成长');
    if (!stats[reason]) stats[reason] = { reason: reason, count: 0, points: 0 };
    stats[reason].count++;
    stats[reason].points += Number(record.amount || 0);
  });
  var list = Object.keys(stats).map(function(key) { return stats[key]; }).sort(function(a, b) {
    return b.count - a.count || b.points - a.points;
  });
  if (!list.length) {
    return { reason: '正在积累成长亮点', count: 0, points: 0, trendText: '从一个容易完成的小目标开始' };
  }

  var top = list[0];
  var previousCount = previousRecords.filter(function(record) {
    return Number(record.amount || 0) > 0 && String(record.reason || '其他成长') === top.reason;
  }).length;
  var trendText;
  if (!compareEnabled) trendText = '累计记录 ' + top.count + ' 次';
  else if (!previousCount) trendText = '本期新亮点';
  else if (top.count > previousCount) trendText = '比上期多 ' + (top.count - previousCount) + ' 次';
  else if (top.count < previousCount) trendText = '比上期少 ' + (previousCount - top.count) + ' 次';
  else trendText = '与上期保持稳定';
  return { reason: top.reason, count: top.count, points: top.points, trendText: trendText };
}

function reportRangeLabel(range, from, to) {
  if (range === 'week') return '近7天';
  if (range === 'month') return '近30天';
  if (range === 'all') return '全部时间';
  if (range === 'custom' && from && to) return from.replace(/-/g, '.') + ' - ' + to.replace(/-/g, '.');
  return '自定义时段';
}

function canvasRoundedPath(ctx, x, y, width, height, radius) {
  var r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillCanvasRoundRect(ctx, x, y, width, height, radius, color) {
  canvasRoundedPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function canvasEllipsis(ctx, text, maxWidth) {
  var value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(value + '…').width > maxWidth) value = value.slice(0, -1);
  return value + '…';
}

function canvasWrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  var source = String(text || '');
  var lines = [];
  var current = '';
  for (var i = 0; i < source.length; i++) {
    var next = current + source.charAt(i);
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = source.charAt(i);
      if (lines.length === maxLines - 1) break;
    } else {
      current = next;
    }
  }
  var consumed = lines.join('').length + current.length;
  if (current && lines.length < maxLines) lines.push(current);
  if (consumed < source.length && lines.length) {
    lines[lines.length - 1] = canvasEllipsis(ctx, lines[lines.length - 1] + source.slice(consumed), maxWidth);
  }
  lines.forEach(function(line, index) { ctx.fillText(line, x, y + index * lineHeight); });
  return lines.length;
}

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
    rankingList: [],
    monthCompare: { current: 0, previous: 0, change: 0, direction: 'flat', icon: '→', text: '与上月持平' },
    insightText: '',
    growthStats: [],
    streakCards: [],
    habitHighlights: [],
    growthStages: [],
    encouragementTitle: '',
    encouragementText: '',
    rangeDisplayText: '近7天',
    shareSubjectText: '孩子们',
    themePageStyle: '',
    themeClass: '',
    iconTheme: 'mint',
    isLoggedIn: false,
    isChild: false,
    reportLoading: false,
    shareGenerating: false,
    shareCanvasVisible: false,
    shareImagePath: '',
    sharePreviewVisible: false
  },

  onShow: function() {
    var g = app.globalData;
    var isLoggedIn = !!(g.token && g.user);
    var selfKid = (g.user && g.user.role === 'child') ? g.user.id : null;
    this.setData({
      isLoggedIn: isLoggedIn,
      isChild: !!selfKid,
      reportKid: selfKid || 'all',
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      iconTheme: app.globalData.theme === 'amber' ? 'amber' : 'mint'
    });
    if (isLoggedIn) {
      this.prepareOptions();
      this.loadAndRender();
    }
  },

  goLogin: function() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onHide: function() {
    clearTimeout(this._drawTimer);
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
    that.setData({ reportLoading: true });
    return app.fetchAPI('/api/history').then(function(data) {
      var history = data && Array.isArray(data.history) ? data.history : (Array.isArray(data) ? data : []);

      // 兼容服务端配置尚未加载完成的情况：从流水补齐孩子选项，避免有数据却没有统计维度。
      var knownUsers = app.globalData.allUsers || [];
      var knownIds = {};
      knownUsers.forEach(function(user) { knownIds[user.id] = true; });
      history.forEach(function(record) {
        if (!record.kid || knownIds[record.kid]) return;
        knownUsers.push({ id: record.kid, name: record.kidName || record.kid, role: 'child' });
        knownIds[record.kid] = true;
      });
      app.globalData.allUsers = knownUsers;
      that.prepareOptions();

      // 孩子角色：仅保留自己的记录
      if (selfKid) {
        history = history.filter(function(r) { return r.kid === selfKid; });
        that.setData({ reportKid: selfKid, allData: history, reportLoading: false });
      } else {
        that.setData({ allData: history, reportLoading: false });
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
    if (!this.data.dateFrom || !this.data.dateTo) {
      wx.showToast({ title: '请选择完整日期范围', icon: 'none' });
      return;
    }
    if (this.data.dateFrom > this.data.dateTo) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
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
      rangeStart = localDateFromYmd(this.data.dateFrom, false);
      rangeEnd = localDateFromYmd(this.data.dateTo || this.data.dateFrom, true);
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
      var d = recordDate(r);
      if (!d) return false;
      if (d < rangeStart) return false;
      if (reportRange !== 'all' && d > rangeEnd) return false;
      if (reportKid !== 'all' && r.kid !== reportKid) return false;
      if (reportCat !== 'all') {
        var cat = allCats.find(function(c) { return c.category === reportCat; });
        if (!cat) return false;
        if (!cat.items.some(function(item) { return ruleReasonMatches(item, r.reason); })) return false;
      }
      return true;
    });

    // 总结数据
    var allUsers = app.globalData.allUsers || [];
    var kids = allUsers.filter(function(u) { return u.role === 'child'; });
    var targetKids = reportKid === 'all' ? kids : kids.filter(function(k) { return k.id === reportKid; });

    var summaryData = targetKids.map(function(k) {
      var kData = filtered.filter(function(r) { return r.kid === k.id; });
      var add = kData.filter(function(r) { return Number(r.amount || 0) > 0; }).reduce(function(s, r) { return s + Number(r.amount || 0); }, 0);
      var sub = kData.filter(function(r) { return Number(r.amount || 0) < 0; }).reduce(function(s, r) { return s + Math.abs(Number(r.amount || 0)); }, 0);
      return { kid: k.id, kidName: k.name, add: add, sub: sub, net: add - sub };
    });
    var rankingList = summaryData.filter(function(item) { return item.add > 0; }).sort(function(a, b) { return b.add - a.add; }).slice(0, 3).map(function(item, index) {
      return {
        kid: item.kid,
        kidName: item.kidName,
        add: item.add,
        rank: index + 1
      };
    });

    // Top 10
    var sorted = filtered.slice().sort(function(a, b) { return Math.abs(b.amount) - Math.abs(a.amount); }).slice(0, 10);
    var top10List = sorted.map(function(r) {
      var u = allUsers.find(function(x) { return x.id === r.kid; });
      return {
        amount: Number(r.amount || 0),
        reason: r.reason,
        kidName: u ? u.name : r.kid,
        operator: r.operator
      };
    });

    // 本月 vs 上月（跟随孩子筛选，不受时间范围限制）。
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    var previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var dimensionMatch = function(record) {
      if (reportKid !== 'all' && record.kid !== reportKid) return false;
      return true;
    };
    var currentMonthNet = netPoints(allData.filter(function(record) {
      var date = recordDate(record);
      return date && date >= monthStart && date < nextMonthStart && dimensionMatch(record);
    }));
    var previousMonthNet = netPoints(allData.filter(function(record) {
      var date = recordDate(record);
      return date && date >= previousMonthStart && date < monthStart && dimensionMatch(record);
    }));
    var monthChange = currentMonthNet - previousMonthNet;
    var monthCompare = {
      current: currentMonthNet,
      previous: previousMonthNet,
      change: monthChange,
      direction: monthChange > 0 ? 'up' : (monthChange < 0 ? 'down' : 'flat'),
      icon: monthChange > 0 ? '↗' : (monthChange < 0 ? '↘' : '→'),
      text: monthChange > 0 ? ('比上月上升 ' + monthChange + ' 分') : (monthChange < 0 ? ('比上月下降 ' + Math.abs(monthChange) + ' 分') : '与上月持平')
    };

    // 本地规则引擎：比较当前筛选周期与前一等长周期，不上传任何数据。
    var previousFiltered = [];
    if (reportRange !== 'all') {
      var duration = rangeEnd.getTime() - rangeStart.getTime();
      var previousEnd = new Date(rangeStart.getTime() - 1);
      var previousStart = new Date(previousEnd.getTime() - duration);
      previousFiltered = allData.filter(function(record) {
        var date = recordDate(record);
        if (!date || date < previousStart || date > previousEnd) return false;
        if (reportKid !== 'all' && record.kid !== reportKid) return false;
        if (reportCat !== 'all') {
          var category = allCats.find(function(cat) { return cat.category === reportCat; });
          if (!category || !category.items.some(function(item) { return ruleReasonMatches(item, record.reason); })) return false;
        }
        return true;
      });
    }

    // 成长数据快照：全部由当前筛选后的流水在本机计算。
    var positiveRecords = filtered.filter(function(record) { return Number(record.amount || 0) > 0; });
    var negativeRecords = filtered.filter(function(record) { return Number(record.amount || 0) < 0; });
    var activeDays = uniqueDayCount(filtered);
    var periodNet = netPoints(filtered);
    var scoredCount = positiveRecords.length + negativeRecords.length;
    var positiveRate = scoredCount ? Math.round(positiveRecords.length / scoredCount * 100) : 0;
    var rangeDisplayText = reportRangeLabel(reportRange, this.data.dateFrom, this.data.dateTo);
    var growthStats = [
      { key: 'records', label: '成长记录', valueText: String(filtered.length), unit: '次', tone: 'accent' },
      { key: 'days', label: '活跃天数', valueText: String(activeDays), unit: '天', tone: 'blue' },
      { key: 'rate', label: '正向占比', valueText: String(positiveRate), unit: '%', tone: 'positive' },
      { key: 'net', label: '净成长值', valueText: signedPoints(periodNet), unit: '分', tone: periodNet >= 0 ? 'positive' : 'negative' }
    ];

    var compareEnabled = reportRange !== 'all';
    var streakCards = targetKids.map(function(kid) {
      var kidCurrent = filtered.filter(function(record) { return record.kid === kid.id; });
      var streak = positiveStreakStats(kidCurrent);
      return {
        kid: kid.id,
        kidName: kid.name,
        current: streak.current,
        best: streak.best,
        activeDays: streak.activeDays,
        positiveCount: kidCurrent.filter(function(record) { return Number(record.amount || 0) > 0; }).length
      };
    });
    var habitHighlights = targetKids.map(function(kid) {
      var kidCurrent = filtered.filter(function(record) { return record.kid === kid.id; });
      var kidPrevious = previousFiltered.filter(function(record) { return record.kid === kid.id; });
      var highlight = topHabitFor(kidCurrent, kidPrevious, compareEnabled);
      highlight.kid = kid.id;
      highlight.kidName = kid.name;
      return highlight;
    });
    var growthStages = targetKids.map(function(kid) {
      // 成长阶段使用当前账号可见的累计流水，避免切换筛选后徽章倒退。
      var kidLifetime = allData.filter(function(record) { return record.kid === kid.id; });
      var streak = positiveStreakStats(kidLifetime);
      var stage = growthStageFor(kidLifetime, streak);
      stage.kid = kid.id;
      stage.kidName = kid.name;
      return stage;
    });

    var shareSubjectText = targetKids.length
      ? targetKids.map(function(kid) { return kid.name; }).join('、')
      : '孩子们';
    var bestRecentStreak = streakCards.reduce(function(best, item) { return Math.max(best, item.current); }, 0);
    var bestOverallStreak = streakCards.reduce(function(best, item) { return Math.max(best, item.best); }, 0);
    var encouragementTitle = '给' + shareSubjectText + '的成长寄语';
    var encouragementText;
    if (bestRecentStreak >= 7) {
      encouragementText = '连续 ' + bestRecentStreak + ' 天的坚持已经成为一份闪闪发光的能力，请为这份自律好好鼓掌。';
    } else if (positiveRate >= 80 && positiveRecords.length >= 3) {
      encouragementText = '这一阶段的正向记录占比达到 ' + positiveRate + '%，被看见的努力，正在悄悄变成好习惯。';
    } else if (bestOverallStreak >= 3) {
      encouragementText = '最长连续 ' + bestOverallStreak + ' 天的成长足迹说明：小小的坚持，也能积累成看得见的进步。';
    } else if (periodNet < 0) {
      encouragementText = '暂时的起伏不代表退步，从今天最容易完成的一件小事开始，就是新的成长。';
    } else {
      encouragementText = '每一次认真记录，都是在告诉孩子：你的努力值得被看见，也值得被肯定。';
    }

    var advice = [];
    targetKids.forEach(function(kid) {
      if (advice.length >= 2) return;
      var kidCurrent = filtered.filter(function(record) { return record.kid === kid.id; });
      var kidPrevious = previousFiltered.filter(function(record) { return record.kid === kid.id; });
      var streak = longestHabitStreak(kidCurrent);
      var homeworkCurrent = kidCurrent.filter(function(record) { return record.amount > 0 && /(作业|学习|阅读)/.test(record.reason || ''); }).length;
      var homeworkPrevious = kidPrevious.filter(function(record) { return record.amount > 0 && /(作业|学习|阅读)/.test(record.reason || ''); }).length;
      if (streak >= 7) {
        advice.push(kid.name + '已连续 ' + streak + ' 天留下全勤或打卡记录，值得具体地表扬这份坚持。');
      } else if (homeworkPrevious >= 3 && homeworkCurrent <= homeworkPrevious * 0.7) {
        var decline = Math.round((1 - homeworkCurrent / homeworkPrevious) * 100);
        advice.push(kid.name + '的作业/学习正向记录较上一周期减少约 ' + decline + '%，建议先了解最近是否遇到困难。');
      } else if (kidCurrent.length) {
        var kidNet = netPoints(kidCurrent);
        advice.push(kid.name + (kidNet >= 0
          ? '本期净增长 ' + kidNet + ' 分，可以及时肯定最稳定的那个好习惯。'
          : '本期净变化为 ' + kidNet + ' 分，建议把提醒改成一个清晰、容易完成的小目标。'));
      }
    });
    var insightText = advice.length ? advice.join(' ') : '当前范围内记录还不够多，继续记录几天后会生成更有针对性的家庭教育建议。';

    this.setData({
      filteredData: filtered,
      summaryData: summaryData,
      rankingList: rankingList,
      top10List: top10List,
      monthCompare: monthCompare,
      insightText: insightText,
      growthStats: growthStats,
      streakCards: streakCards,
      habitHighlights: habitHighlights,
      growthStages: growthStages,
      encouragementTitle: encouragementTitle,
      encouragementText: encouragementText,
      rangeDisplayText: rangeDisplayText,
      shareSubjectText: shareSubjectText,
      _allCats: allCats,
      _targetKids: targetKids,
      _filtered: filtered,
      _reportMode: reportMode
    });

    // 合并快速筛选产生的连续重绘，等 DOM 更新后只画最后一次。
    clearTimeout(this._drawTimer);
    this._drawTimer = setTimeout(function() {
      that.drawTrendChart();
      that.drawPieChart();
    }, 100);
  },

  // ========== 趋势柱状图 ==========
  drawTrendChart: function() {
    var that = this;
    var query = wx.createSelectorQuery().in(this);
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
        var day = reportDayKey(r);
        if (!day) return;
        if (!dailyMap[day]) dailyMap[day] = {};
        if (!dailyMap[day][r.kid]) dailyMap[day][r.kid] = 0;
        dailyMap[day][r.kid] += reportMode === 'count' ? 1 : Number(r.amount || 0);
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
      ctx.font = canvasFont('xs', '', 0.5);
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
            ctx.font = canvasFont('xs', '', 0.5);
            ctx.textAlign = 'center';
            var lY = val >= 0 ? (by - 5) : (by + bh + 13);
            ctx.fillText(label, bX + bW / 2, lY);
          }
        });

        if (di % Math.max(1, Math.ceil(days.length / 8)) === 0) {
          var mX = bx + (bW * numKids + (numKids - 1) * 2) / 2;
          ctx.fillStyle = '#999';
          ctx.font = canvasFont('xs', '', 0.5);
          ctx.textAlign = 'center';
          ctx.fillText(d.slice(5), mX, h - 8);
        }
      });
    });
  },

  // ========== 饼图 ==========
  drawPieChart: function() {
    var that = this;
    var query = wx.createSelectorQuery().in(this);
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

      var catTotals = {};
      filtered.forEach(function(r) {
        var cat = allCats.find(function(c) { return c.items.some(function(item) { return ruleReasonMatches(item, r.reason); }); });
        var catName = cat ? cat.category : '其他';
        if (!catTotals[catName]) catTotals[catName] = { total: 0, count: 0 };
        catTotals[catName].total += Math.abs(Number(r.amount || 0));
        catTotals[catName].count += 1;
      });
      var catEntries = Object.entries(catTotals);
      var grandTotal = catEntries.reduce(function(s, e) { return s + (reportMode === 'count' ? e[1].count : e[1].total); }, 0);

      if (catEntries.length === 0 || grandTotal === 0) return;

      var themeAccent = app.globalData.theme === 'mint' ? '#2D9B7A' : '#B86932';
      var pieColors = ['#4A90D9', '#E87DA8', '#5C9919', '#E24B4A', themeAccent, '#8B5CF6', '#F59E0B', '#06B6D4'];
      var legendCols = 2;
      var legendRowH = 17;
      var legendRows = Math.ceil(catEntries.length / legendCols);
      var legendHeight = legendRows * legendRowH + 8;
      var pieAreaH = h - legendHeight;
      var pCX = w / 2, pCY = pieAreaH / 2, pR = Math.max(28, Math.min(w / 2 - 20, pieAreaH / 2 - 10));
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
          ctx.font = canvasFont('xs', 'bold', 0.5);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pct + '%', lx, ly);
        }
        angle = endAngle;
      });

      // 图例
      var legendStartY = h - Math.ceil(catEntries.length / legendCols) * legendRowH + 5;
      ctx.textBaseline = 'alphabetic';
      catEntries.forEach(function(entry, ei) {
        var val = reportMode === 'count' ? entry[1].count : entry[1].total;
        var col = ei % legendCols;
        var row = Math.floor(ei / legendCols);
        var legendX = 10 + col * (w / legendCols);
        var legendY = legendStartY + row * legendRowH;
        ctx.fillStyle = pieColors[ei % pieColors.length];
        ctx.fillRect(legendX, legendY - 8, 8, 8);
        ctx.fillStyle = '#555';
        ctx.font = canvasFont('xs', '', 0.5);
        ctx.textAlign = 'left';
        var shortName = entry[0].length > 6 ? entry[0].substring(0, 6) + '…' : entry[0];
        ctx.fillText(shortName + ' ' + val, legendX + 12, legendY);
      });
    });
  },

  // ========== 分享卡片 ==========
  onMakeShare: function() {
    if (this.data.shareGenerating) return;
    if (!this.data.filteredData.length) {
      wx.showToast({ title: '当前没有可分享的成长数据', icon: 'none' });
      return;
    }
    var that = this;
    wx.showLoading({ title: '生成分享图...', mask: true });
    this.setData({ shareGenerating: true, shareCanvasVisible: true, sharePreviewVisible: false }, function() {
      wx.nextTick(function() { that._drawSharePoster(); });
    });
  },

  _drawSharePoster: function() {
    var that = this;
    var query = wx.createSelectorQuery().in(this);
    query.select('#shareCanvas').fields({ node: true, size: true }).exec(function(result) {
      if (!result || !result[0] || !result[0].node) {
        that._finishSharePoster('画布初始化失败');
        return;
      }

      var canvas = result[0].node;
      var ctx = canvas.getContext('2d');
      var dpr = wx.getSystemInfoSync().pixelRatio;
      var W = 750, H = 1380;
      var cssWidth = result[0].width;
      var scale = cssWidth / W;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(result[0].height * dpr);
      ctx.scale(dpr * scale, dpr * scale);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      var g = app.globalData;
      var isMint = g.theme === 'mint';
      var colors = isMint ? {
        bg: '#F0F8F5', card: '#FFFFFF', ink: '#213B33', muted: '#71857E',
        accent: '#2D9B7A', accentDark: '#176A53', accentStart: '#48B996', accentEnd: '#20785F',
        soft: '#E4F6F0', green: '#4D921C', red: '#DC5654', honey: '#F3B85B', blue: '#4A90D9'
      } : {
        bg: '#FBF5EC', card: '#FFFFFF', ink: '#3D302A', muted: '#8F8178',
        accent: '#B86932', accentDark: '#8F4924', accentStart: '#D3884B', accentEnd: '#A35428',
        soft: '#FFF1DF', green: '#5C9919', red: '#E24B4A', honey: '#F3B85B', blue: '#4A90D9'
      };

      // 完整不透明底色，避免导出图本身携带透明像素。
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);
      var heroGradient = ctx.createLinearGradient(0, 0, W, 235);
      heroGradient.addColorStop(0, colors.accentStart);
      heroGradient.addColorStop(1, colors.accentEnd);
      ctx.fillStyle = heroGradient;
      ctx.fillRect(0, 0, W, 235);
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.arc(690, 30, 130, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(35, 225, 95, 0, Math.PI * 2); ctx.fill();

      fillCanvasRoundRect(ctx, 42, 36, 76, 76, 24, 'rgba(255,255,255,.20)');
      ctx.fillStyle = '#FFFFFF';
      ctx.font = canvasFont('lg', 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('糖', 80, 74);
      ctx.textAlign = 'left';
      ctx.fillText('糖罐成长报告', 138, 62);
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.font = canvasFont('xs');
      var posterTargetCount = (that.data._targetKids || []).length;
      var posterSubject = posterTargetCount > 3 ? ('全家 ' + posterTargetCount + ' 位孩子') : that.data.shareSubjectText;
      ctx.fillText(canvasEllipsis(ctx, posterSubject + ' · ' + that.data.rangeDisplayText, 390), 140, 101);
      fillCanvasRoundRect(ctx, 560, 53, 146, 48, 24, 'rgba(255,255,255,.16)');
      ctx.fillStyle = '#FFFFFF';
      ctx.font = canvasFont('xs', 'bold');
      ctx.textAlign = 'center';
      ctx.fillText('成长闪光时刻', 633, 77);
      ctx.textBaseline = 'alphabetic';

      function posterCard(x, y, width, height, fill) {
        ctx.save();
        ctx.shadowColor = 'rgba(22,61,49,.12)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 10;
        fillCanvasRoundRect(ctx, x, y, width, height, 30, fill || colors.card);
        ctx.restore();
      }

      // 当前糖罐余额。
      posterCard(40, 150, 670, 190);
      var kids = (g.allUsers || []).filter(function(user) { return user.role === 'child'; });
      if (that.data.reportKid !== 'all') kids = kids.filter(function(kid) { return kid.id === that.data.reportKid; });
      var allKids = (g.allUsers || []).filter(function(user) { return user.role === 'child'; });
      if (kids.length > 3) {
        var familyBalance = kids.reduce(function(sum, kid) { return sum + Number((g.points && g.points[kid.id]) || 0); }, 0);
        ctx.fillStyle = colors.accent;
        ctx.font = canvasFont('md', 'bold');
        ctx.textAlign = 'left';
        ctx.fillText(canvasEllipsis(ctx, '家庭成长糖罐 · 共 ' + kids.length + ' 位孩子', 560), 76, 212);
        ctx.fillStyle = familyBalance >= 0 ? colors.green : colors.red;
        ctx.font = canvasFont('xl', 'bold', 1.25);
        ctx.fillText(signedPoints(familyBalance) + ' 分', 76, 285, 560);
      } else {
        var columnWidth = 610 / Math.max(1, kids.length);
        kids.forEach(function(kid, index) {
          var kidIndex = allKids.findIndex(function(user) { return user.id === kid.id; });
          var kidColor = app.kidColors[(kidIndex >= 0 ? kidIndex : index) % app.kidColors.length];
          var centerX = 70 + columnWidth * index + columnWidth / 2;
          ctx.fillStyle = kidColor.border;
          ctx.beginPath(); ctx.arc(centerX, 202, 25, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = colors.ink;
          ctx.font = canvasFont('sm', 'bold');
          ctx.textAlign = 'center';
          ctx.fillText(canvasEllipsis(ctx, kid.name, columnWidth - 28), centerX, 249);
          var balance = Number((g.points && g.points[kid.id]) || 0);
          ctx.fillStyle = balance >= 0 ? colors.green : colors.red;
          ctx.font = canvasFont('xl', 'bold');
          ctx.fillText(signedPoints(balance), centerX, 306, columnWidth - 20);
        });
      }

      // 2x2 成长快照。
      posterCard(40, 370, 670, 205);
      ctx.fillStyle = colors.ink;
      ctx.font = canvasFont('md', 'bold');
      ctx.textAlign = 'left';
      ctx.fillText('成长数据快照', 70, 418);
      ctx.fillStyle = colors.muted;
      ctx.font = canvasFont('xs');
      ctx.textAlign = 'right';
      ctx.fillText(that.data.rangeDisplayText, 680, 418);
      var statColors = [colors.accent, colors.blue, colors.green, Number(that.data.growthStats[3] && that.data.growthStats[3].valueText) >= 0 ? colors.green : colors.red];
      (that.data.growthStats || []).slice(0, 4).forEach(function(stat, index) {
        var cellX = 65 + index * 160;
        ctx.fillStyle = statColors[index];
        ctx.font = canvasFont('lg', 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(stat.valueText + stat.unit, cellX + 70, 493);
        ctx.fillStyle = colors.muted;
        ctx.font = canvasFont('xs');
        ctx.fillText(stat.label, cellX + 70, 535);
      });

      // 每个孩子最亮眼的好习惯。
      posterCard(40, 605, 670, 235);
      ctx.fillStyle = colors.ink;
      ctx.font = canvasFont('md', 'bold');
      ctx.textAlign = 'left';
      ctx.fillText('好习惯亮点', 70, 653);
      var highlights = (that.data.habitHighlights || []).slice(0, 2);
      if (!highlights.length) highlights = [{ kidName: that.data.shareSubjectText, reason: '正在积累成长亮点', count: 0, points: 0, trendText: '从一个小目标开始' }];
      highlights.forEach(function(item, index) {
        var rowY = 704 + index * 67;
        fillCanvasRoundRect(ctx, 70, rowY - 31, 50, 50, 18, colors.soft);
        ctx.fillStyle = colors.accent;
        ctx.font = canvasFont('xs', 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(String(index + 1), 95, rowY + 2);
        ctx.textAlign = 'left';
        ctx.fillStyle = colors.ink;
        ctx.font = canvasFont('sm', 'bold');
        ctx.fillText(canvasEllipsis(ctx, item.kidName + ' · ' + item.reason, 360), 138, rowY);
        ctx.fillStyle = colors.muted;
        ctx.font = canvasFont('xs');
        ctx.fillText(canvasEllipsis(ctx, item.trendText, 350), 138, rowY + 28);
        ctx.fillStyle = colors.green;
        ctx.font = canvasFont('sm', 'bold');
        ctx.textAlign = 'right';
        ctx.fillText(item.count + '次  +' + item.points + '分', 676, rowY + 6, 180);
      });

      // 成长阶段与连续记录。
      posterCard(40, 870, 670, 225);
      ctx.fillStyle = colors.ink;
      ctx.font = canvasFont('md', 'bold');
      ctx.textAlign = 'left';
      ctx.fillText('成长徽章 · 连续记录', 70, 918);
      (that.data.growthStages || []).slice(0, 2).forEach(function(stage, index) {
        var streak = (that.data.streakCards || []).find(function(item) { return item.kid === stage.kid; }) || { current: 0, best: 0 };
        var rowY = 970 + index * 60;
        ctx.fillStyle = index ? colors.blue : colors.honey;
        ctx.beginPath(); ctx.arc(91, rowY - 7, 22, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = colors.ink;
        ctx.font = canvasFont('sm', 'bold');
        ctx.textAlign = 'left';
        ctx.fillText(canvasEllipsis(ctx, stage.kidName + ' · ' + stage.title, 290), 128, rowY);
        ctx.fillStyle = colors.accent;
        ctx.font = canvasFont('xs');
        ctx.fillText(canvasEllipsis(ctx, stage.badgeText, 300), 128, rowY + 27);
        ctx.fillStyle = colors.muted;
        ctx.textAlign = 'right';
        ctx.fillText('最近连续 ' + streak.current + '天 · 最长 ' + streak.best + '天', 676, rowY + 4);
      });

      // 鼓励语。
      var quoteGradient = ctx.createLinearGradient(40, 1125, 710, 1320);
      quoteGradient.addColorStop(0, colors.soft);
      quoteGradient.addColorStop(1, '#FFFFFF');
      posterCard(40, 1125, 670, 190, quoteGradient);
      ctx.fillStyle = colors.accent;
      ctx.font = canvasFont('xs', 'bold');
      ctx.textAlign = 'left';
      ctx.fillText('今日成长寄语', 70, 1170);
      ctx.fillStyle = colors.ink;
      ctx.font = canvasFont('sm', 'bold');
      canvasWrapText(ctx, '“' + that.data.encouragementText + '”', 70, 1215, 610, 40, 3);

      ctx.fillStyle = colors.muted;
      ctx.font = canvasFont('xs');
      ctx.textAlign = 'center';
      ctx.fillText('糖罐育儿积分 · 记录成长每一步', W / 2, 1352);

      var exportPoster = function() {
        wx.canvasToTempFilePath({
          canvas: canvas,
          fileType: 'png',
          destWidth: W,
          destHeight: H,
          success: function(res) {
            wx.hideLoading();
            that.setData({
              shareImagePath: res.tempFilePath,
              sharePreviewVisible: true,
              shareCanvasVisible: false,
              shareGenerating: false
            });
          },
          fail: function() { that._finishSharePoster('生成失败，请重试'); }
        }, that);
      };
      var exportStarted = false;
      var exportOnce = function() {
        if (exportStarted) return;
        exportStarted = true;
        exportPoster();
      };
      if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(exportOnce);
      setTimeout(exportOnce, 100);
    });
  },

  _finishSharePoster: function(message) {
    wx.hideLoading();
    this.setData({ shareGenerating: false, shareCanvasVisible: false });
    if (message) wx.showToast({ title: message, icon: 'none' });
  },

  onSaveToAlbum: function() {
    var that = this;
    if (!that.data.shareImagePath) return;
    wx.saveImageToPhotosAlbum({
      filePath: that.data.shareImagePath,
      success: function() {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
        that.onCloseSharePreview();
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
    var that = this;
    this.setData({ sharePreviewVisible: false }, function() {
      wx.nextTick(function() {
        clearTimeout(that._drawTimer);
        that._drawTimer = setTimeout(function() {
          that.drawTrendChart();
          that.drawPieChart();
        }, 80);
      });
    });
  },

  noop: function() {
  }
});
