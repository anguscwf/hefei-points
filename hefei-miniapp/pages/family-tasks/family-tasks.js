var app = getApp();
var viewModel = require('../../utils/guardian-page.js');

var FILTERS = [
  { value: 'pending', label: '待确认' },
  { value: 'needs_info', label: '待补充' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
  { value: 'cancelled', label: '已取消' }
];

Page({
  data: {
    themePageStyle: '',
    themeClass: '',
    isAdult: false,
    previewEnabled: false,
    loading: false,
    loadingMore: false,
    operating: false,
    canRetryAction: false,
    errorText: '',
    filters: FILTERS,
    activeStatus: 'pending',
    summary: { pending: 0, needsInfo: 0, total: 0 },
    requests: [],
    nextCursor: null,
    selected: null,
    approvedPoints: '',
    actionNote: ''
  },

  onLoad: function() {
    this._alive = true;
    this._visible = true;
    this._sessionGeneration = app._sessionGeneration || 0;
    var that = this;
    if (typeof app.subscribeGuardianSession === 'function') {
      this._sessionUnsubscribe = app.subscribeGuardianSession(function() {
        that.onGuardianSessionChanged();
      });
    }
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      isAdult: !!(app.globalData.token && app.globalData.user
        && app.globalData.user.role !== 'child'),
      previewEnabled: app.globalData.guardianPreviewEnabled === true
    });
    if (this.data.isAdult && this.data.previewEnabled) this.loadFirstPage();
  },

  onShow: function() {
    this._visible = true;
    if (this._sessionGeneration !== (app._sessionGeneration || 0)) {
      this.onGuardianSessionChanged();
      return;
    }
    if (this._needsReload && this.data.isAdult && this.data.previewEnabled) {
      this._needsReload = false;
      this.loadFirstPage();
    }
  },

  onHide: function() {
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.clearTransient();
    this._needsReload = true;
  },

  onUnload: function() {
    this._alive = false;
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.clearTransient(false);
    if (this._sessionUnsubscribe) this._sessionUnsubscribe();
    this._sessionUnsubscribe = null;
  },

  onGuardianSessionChanged: function() {
    this._sessionGeneration = app._sessionGeneration || 0;
    this._generation = (this._generation || 0) + 1;
    this.clearTransient();
    var isAdult = !!(app.globalData.token && app.globalData.user
      && app.globalData.user.role !== 'child');
    this.setData({
      isAdult: isAdult,
      errorText: isAdult ? '' : '登录状态已变化，请重新使用成人账号登录'
    });
    if (this._alive && this._visible && isAdult && this.data.previewEnabled) {
      this._needsReload = false;
      this.loadFirstPage();
    } else {
      this._needsReload = true;
    }
  },

  onReachBottom: function() {
    this.loadMore();
  },

  noop: function() {},

  clearTransient: function(updateView) {
    this._actionIntent = null;
    if (this.data) {
    var cleared = {
      selected: null,
      approvedPoints: '',
      actionNote: '',
      canRetryAction: false,
      operating: false,
      loading: false,
      loadingMore: false,
      requests: [],
      nextCursor: null,
      summary: { pending: 0, needsInfo: 0, total: 0 }
      };
      if (updateView === false) Object.assign(this.data, cleared);
      else this.setData(cleared);
    }
  },

  loadFirstPage: function() {
    var that = this;
    var generation = (this._generation || 0) + 1;
    this._generation = generation;
    this._actionIntent = null;
    this.setData({
      loading: true,
      loadingMore: false,
      operating: false,
      errorText: '',
      requests: [],
      nextCursor: null,
      selected: null,
      approvedPoints: '',
      actionNote: '',
      canRetryAction: false
    });
    Promise.all([
      app.guardianApi.taskSummary(),
      app.guardianApi.listPointRequests({ status: this.data.activeStatus, limit: 20 })
    ]).then(function(results) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      var summaryResult = results[0];
      var listResult = results[1];
      if (!summaryResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(summaryResult, '家庭待办汇总加载失败') });
        return;
      }
      if (!listResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(listResult, '申请列表加载失败') });
        return;
      }
      var summary = summaryResult.data && summaryResult.data.pointRequests;
      var pointRequests = listResult.data && listResult.data.pointRequests;
      if (!viewModel.validTaskSummary(summary) || !Array.isArray(pointRequests)
          || !pointRequests.every(function(item) { return viewModel.validPointRequestDto(item); })) {
        that.setData({
          loading: false,
          errorText: '家庭待办响应不完整，本次列表未展示'
        });
        return;
      }
      that.setData({
        loading: false,
        summary: summary,
        requests: pointRequests.map(viewModel.decoratePointRequest),
        nextCursor: (listResult.data && listResult.data.nextCursor) || null
      });
    });
  },

  loadMore: function() {
    var that = this;
    var cursor = this.data.nextCursor;
    if (!cursor || this.data.loading || this.data.loadingMore) return;
    var generation = this._generation;
    this.setData({ loadingMore: true });
    app.guardianApi.listPointRequests({
      status: this.data.activeStatus,
      limit: 20,
      cursor: cursor
    }).then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      if (!result.ok) {
        that.setData({ loadingMore: false, errorText: viewModel.errorMessage(result, '更多申请加载失败') });
        return;
      }
      var body = result.data || {};
      if (!Array.isArray(body.pointRequests)
          || !body.pointRequests.every(function(item) { return viewModel.validPointRequestDto(item); })) {
        that.setData({ loadingMore: false, errorText: '更多申请响应不完整，本次内容未追加' });
        return;
      }
      that.setData({
        loadingMore: false,
        requests: that.data.requests.concat(body.pointRequests.map(viewModel.decoratePointRequest)),
        nextCursor: body.nextCursor || null
      });
    });
  },

  changeFilter: function(event) {
    var status = event.currentTarget.dataset.status;
    if (!FILTERS.some(function(item) { return item.value === status; })
        || status === this.data.activeStatus) return;
    this.setData({ activeStatus: status, nextCursor: null });
    this.loadFirstPage();
  },

  openRequest: function(event) {
    var id = event.currentTarget.dataset.id;
    var that = this;
    var generation = this._generation;
    if (!id || this.data.operating) return;
    this._actionIntent = null;
    this.setData({ operating: true, canRetryAction: false, errorText: '' });
    app.guardianApi.getPointRequest(id).then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      if (!result.ok) {
        that.setData({ operating: false, errorText: viewModel.errorMessage(result, '申请详情加载失败') });
        return;
      }
      var pointRequest = result.data && result.data.pointRequest;
      if (!viewModel.validPointRequestDto(pointRequest, id)) {
        that.setData({ operating: false, errorText: '申请详情响应不完整，本次内容未打开' });
        return;
      }
      var selected = viewModel.decoratePointRequest(pointRequest);
      that.setData({
        operating: false,
        selected: selected,
        approvedPoints: String(selected.requestedPoints || selected.rule.defaultPoints || ''),
        actionNote: ''
      });
    });
  },

  closeRequest: function() {
    if (this.data.canRetryAction) return;
    this._actionIntent = null;
    this.setData({ selected: null, actionNote: '', approvedPoints: '', canRetryAction: false });
  },

  onPointsInput: function(event) {
    if (this.data.operating || this.data.canRetryAction) return;
    this._actionIntent = null;
    this.setData({ approvedPoints: event.detail.value, canRetryAction: false });
  },

  onNoteInput: function(event) {
    if (this.data.operating || this.data.canRetryAction) return;
    this._actionIntent = null;
    this.setData({ actionNote: event.detail.value.slice(0, 300), canRetryAction: false });
  },

  retryAction: function() {
    if (this.data.operating || !this.data.canRetryAction || !this._actionIntent) return;
    this.performAction(this._actionIntent);
  },

  abandonActionRetry: function() {
    if (!this.data.canRetryAction) return;
    this._actionIntent = null;
    this.setData({ canRetryAction: false, selected: null, actionNote: '', approvedPoints: '' });
    this.loadFirstPage();
  },

  decide: function(event) {
    var action = event.currentTarget.dataset.action;
    if (this.data.operating || !this.data.selected) return;
    if (this._actionIntent && this.data.canRetryAction) {
      this.performAction(this._actionIntent);
      return;
    }
    if (['approve', 'request_info', 'reject'].indexOf(action) < 0) return;
    var selected = this.data.selected;
    var note = this.data.actionNote.trim();
    var body = { expectedRevision: selected.revision };
    if (action === 'approve') {
      var points = Number(this.data.approvedPoints);
      if (!Number.isInteger(points) || points < 1) {
        wx.showToast({ title: '请输入有效的通过分值', icon: 'none' });
        return;
      }
      body.approvedPoints = points;
      if (note) body.note = note;
    } else {
      if (!note) {
        wx.showToast({ title: action === 'reject' ? '请填写驳回原因' : '请填写需要补充的内容', icon: 'none' });
        return;
      }
      body.note = note;
    }
    var labels = { approve: '确认通过这条申请？', request_info: '退回给孩子补充？', reject: '确认驳回这条申请？' };
    var that = this;
    var generation = this._generation;
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: labels[action],
      content: '最终状态和分值范围由服务端再次校验；状态变化时不会覆盖其他家长的处理。',
      confirmText: action === 'approve' ? '确认通过' : (action === 'reject' ? '确认驳回' : '退回补充'),
      confirmColor: action === 'reject' ? '#E24B4A' : '#2D9B7A',
      success: function(choice) {
        if (!that._alive || !that._visible || generation !== that._generation) return;
        if (!choice.confirm) {
          that.setData({ operating: false });
          return;
        }
        app.guardianApi.createIdempotencyKey().then(function(key) {
          if (!that._alive || !that._visible || generation !== that._generation) return;
          var intent = {
            action: action,
            requestId: selected.id,
            body: body,
            key: key,
            generation: generation
          };
          that._actionIntent = intent;
          that.performAction(intent);
        }).catch(function() {
          if (!that._alive || !that._visible || generation !== that._generation) return;
          that.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
        });
      },
      fail: function() {
        if (that._alive && that._visible && generation === that._generation) {
          that.setData({ operating: false });
        }
      }
    });
  },

  performAction: function(intent) {
    var that = this;
    this.setData({ operating: true, canRetryAction: false, errorText: '' });
    var call = intent.action === 'approve'
      ? app.guardianApi.approvePointRequest
      : (intent.action === 'reject'
        ? app.guardianApi.rejectPointRequest
        : app.guardianApi.requestPointInfo);
    call(intent.requestId, intent.body, intent.key).then(function(result) {
      if (!that._alive || !that._visible || intent.generation !== that._generation) return;
      if (!result.ok) {
        var ambiguous = viewModel.isOutcomeUnknown(result);
        if (!ambiguous) that._actionIntent = null;
        that.setData({
          operating: false,
          canRetryAction: ambiguous,
          errorText: viewModel.errorMessage(result, '申请处理失败')
        });
        if (!ambiguous && (result.code === 'REVISION_CONFLICT'
            || result.code === 'POINT_REQUEST_STATE_CONFLICT')) {
          that.openRequest({ currentTarget: { dataset: { id: intent.requestId } } });
        }
        return;
      }
      if (!viewModel.validPointMutationDto(result.data && result.data.pointRequest, {
        action: intent.action,
        requestId: intent.requestId,
        expectedRevision: intent.body.expectedRevision,
        approvedPoints: intent.body.approvedPoints
      })) {
        that.setData({
          operating: false,
          canRetryAction: true,
          errorText: '申请处理响应不完整，结果暂无法确认；请重试同一次操作'
        });
        return;
      }
      that._actionIntent = null;
      that.setData({
        operating: false,
        canRetryAction: false,
        selected: null,
        actionNote: '',
        approvedPoints: ''
      });
      that.loadFirstPage();
    });
  }
});
