var app = getApp();
var viewModel = require('../../utils/guardian-page.js');

var RIGHTS_TYPES = [
  { value: 'access', label: '查阅儿童资料', purpose: 'child_data_access' },
  { value: 'export', label: '生成导出快照（暂不支持文件外发）', purpose: 'child_data_export' },
  { value: 'correct', label: '更正儿童别名', purpose: 'child_data_correct' },
  { value: 'delete', label: '申请删除儿童资料', purpose: 'child_data_delete' },
  { value: 'terminate', label: '终止儿童服务', purpose: 'child_service_terminate' }
];

function consentView(consent) {
  consent = consent || {};
  var labels = { active: '有效', withdrawn: '已撤回', superseded: '已更新' };
  return Object.assign({}, consent, {
    statusLabel: labels[consent.status] || '状态待确认',
    tone: consent.status === 'active' ? 'success'
      : (consent.status === 'withdrawn' ? 'danger' : 'neutral'),
    verifiedText: viewModel.dateTime(consent.verifiedAt || consent.createdAt)
  });
}

function determinateDataRightsFailure(result) {
  var code = result && result.code;
  var ok = result && result.ok;
  var outcomeUnknown = result && result.outcomeUnknown;
  if (code === 'STALE_SESSION_RESPONSE') {
    code = result.staleOriginalCode;
    ok = result.staleOriginalOk;
    outcomeUnknown = result.staleOriginalOutcomeUnknown;
  }
  return ok === false && !outcomeUnknown && [
    'IDEMPOTENCY_IN_PROGRESS',
    'IDEMPOTENCY_RESULT_UNAVAILABLE',
    'IDEMPOTENCY_CONFLICT'
  ].indexOf(code) < 0;
}

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
    canAbandonAction: false,
    reconcilingRights: false,
    enrollmentReviewRequired: false,
    reviewText: '',
    rightsReviewRequired: false,
    rightsReviewText: '',
    errorText: '',
    successText: '',
    children: [],
    childIndex: 0,
    selectedChild: null,
    consents: [],
    rightsTypes: RIGHTS_TYPES,
    rightsTypeIndex: 0,
    currentRightsType: 'access',
    withdrawPassword: '',
    rightsPassword: '',
    correctionAlias: '',
    rightsRequests: [],
    nextCursor: null,
    exportSummary: null,
    exportSections: [],
    rightsDetail: null
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
    if (this.data.isAdult) this.loadChildren();
  },

  onShow: function() {
    this._visible = true;
    if (this._sessionGeneration !== (app._sessionGeneration || 0)) {
      this.onGuardianSessionChanged();
      return;
    }
    if (this._needsReload && this.data.isAdult) {
      this._needsReload = false;
      this.loadChildren();
    }
  },

  onHide: function() {
    this._visible = false;
    this.clearSensitive();
    this.setData({
      children: [], selectedChild: null, consents: [], rightsRequests: [], nextCursor: null
    });
    this._needsReload = true;
  },

  onUnload: function() {
    this._alive = false;
    this._visible = false;
    this.clearSensitive(false);
    if (this._sessionUnsubscribe) this._sessionUnsubscribe();
    this._sessionUnsubscribe = null;
  },

  onGuardianSessionChanged: function() {
    this._sessionGeneration = app._sessionGeneration || 0;
    this.clearSensitive();
    var isAdult = !!(app.globalData.token && app.globalData.user
      && app.globalData.user.role !== 'child');
    this.setData({
      isAdult: isAdult,
      children: [],
      selectedChild: null,
      consents: [],
      rightsRequests: [],
      nextCursor: null,
      enrollmentReviewRequired: false,
      reviewText: '',
      rightsReviewRequired: false,
      rightsReviewText: '',
      errorText: isAdult ? '' : '登录状态已变化，请重新使用成人账号登录'
    });
    if (this._alive && this._visible && isAdult) {
      this._needsReload = false;
      this.loadChildren();
    } else {
      this._needsReload = true;
    }
  },

  onReachBottom: function() {
    this.loadMoreRights();
  },

  clearSensitive: function(updateView) {
    if (this._pendingIntent && this._pendingIntent.body) {
      this._pendingIntent.body.reauthAssertion = '';
    }
    this._pendingIntent = null;
    this._dataExport = null;
    this._generation = (this._generation || 0) + 1;
    if (this.data) {
      var cleared = {
        withdrawPassword: '',
        rightsPassword: '',
        correctionAlias: '',
        canRetryAction: false,
        canAbandonAction: false,
        reconcilingRights: false,
        exportSummary: null,
        exportSections: [],
        rightsDetail: null,
        operating: false,
        loading: false,
        loadingMore: false
      };
      if (updateView === false) Object.assign(this.data, cleared);
      else this.setData(cleared);
    }
  },

  loadChildren: function() {
    if (this.data.operating) {
      this._needsReload = true;
      return;
    }
    if (this.data.canRetryAction || this._rightsReconcileInFlight) return;
    this._needsReload = false;
    var that = this;
    var generation = (this._generation || 0) + 1;
    this._generation = generation;
    this.setData({
      loading: true,
      loadingMore: false,
      errorText: '',
      reviewText: '',
      rightsReviewText: '',
      children: [],
      selectedChild: null,
      consents: [],
      rightsRequests: [],
      nextCursor: null,
      exportSummary: null,
      exportSections: [],
      rightsDetail: null
    });
    app.guardianApi.listChildren().then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      if (!result.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(result, '家庭与隐私信息加载失败') });
        return;
      }
      var children = ((result.data && result.data.children) || []).map(viewModel.decorateChild);
      var review = app.globalData.guardianEnrollmentReviewRequired;
      var rightsReview = app.globalData.guardianDataRightsReviewRequired;
      var index = Math.min(that.data.childIndex, Math.max(children.length - 1, 0));
      that.setData({
        loading: false,
        children: children,
        childIndex: index,
        selectedChild: children[index] || null,
        enrollmentReviewRequired: !!review,
        reviewText: review
          ? '正在按原幂等请求核对上次授权结果，确认前不要重复建档或更新授权。'
          : '',
        rightsReviewRequired: !!rightsReview,
        rightsReviewText: rightsReview
          ? '正在按原幂等请求核对上次资料权利操作，确认前不能提交新的资料权利请求。'
          : '',
        successText: that.data.successText
      });
      if (review && review.storageUnavailable) {
        that.setData({
          reviewText: '本机安全恢复存储不可用。为防止重复儿童档案，当前不能提交新的监护授权。'
        });
      } else if (review) {
        that.reconcileConsentOperation(review, generation);
      }
      if (rightsReview && rightsReview.storageUnavailable) {
        that.setData({
          rightsReviewText: '本机安全恢复存储不可用。为防止重复处理证据，当前不能提交新的资料权利请求。'
        });
      } else if (rightsReview) {
        that.reconcileDataRightsOperation(rightsReview, generation);
      }
      if (children[index]) that.loadChildDetails(children[index], generation);
    });
  },

  reconcileDataRightsOperation: function(marker, generation) {
    if (this.data.canRetryAction || this._rightsReconcileInFlight) return;
    this._rightsReconcileInFlight = true;
    this.setData({ reconcilingRights: true });
    var that = this;
    app.guardianApi.getDataRightsOperation(marker.idempotencyKey).then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) {
        that._rightsReconcileInFlight = false;
        return;
      }
      var operation = result.data && result.data.dataRightsOperation;
      var exactOperation = result.ok && operation
        && operation.operation === 'request-create'
        && ['not_found', 'pending', 'completed'].indexOf(operation.status) >= 0;
      if (!exactOperation || operation.status !== 'completed') {
        that._rightsReconcileInFlight = false;
        that.setData({
          reconcilingRights: false,
          rightsReviewRequired: true,
          rightsReviewText: exactOperation && operation.status === 'not_found'
            ? '服务端暂未找到上次资料权利请求。为防止迟到提交造成重复处理，请稍后再次核对。'
            : (exactOperation && operation.status === 'pending'
              ? '上次资料权利请求仍在服务端处理中，请稍后再次核对。'
              : viewModel.errorMessage(result, '上次资料权利请求结果仍在核对，请稍后刷新'))
        });
        return;
      }
      if (!operation.dataRightsRequestId
          || !Number.isFinite(Date.parse(operation.completedAt || ''))) {
        that._rightsReconcileInFlight = false;
        that.setData({
          reconcilingRights: false,
          rightsReviewRequired: true,
          rightsReviewText: '服务端对账响应不完整。为防止重复处理，请稍后再次核对。'
        });
        return;
      }
      app.guardianApi.getDataRightsRequest(operation.dataRightsRequestId).then(function(detailResult) {
        that._rightsReconcileInFlight = false;
        if (!that._alive || !that._visible || generation !== that._generation) return;
        var request = detailResult.data && detailResult.data.dataRightsRequest;
        var exactRequest = detailResult.ok
          && viewModel.validRightsDetail(request, operation.dataRightsRequestId)
          && request.childId === marker.childId
          && request.requestType === marker.requestType;
        if (!exactRequest) {
          that.setData({
            reconcilingRights: false,
            rightsReviewRequired: true,
            rightsReviewText: '服务端处理回执与本机恢复范围不一致。当前继续阻断新请求，请稍后再次核对。'
          });
          return;
        }
        if (!app.clearDataRightsRecovery(marker.idempotencyKey)) {
          that.setData({
            reconcilingRights: false,
            rightsReviewRequired: true,
            rightsReviewText: '服务端已确认请求提交完成，但本机恢复标记清理失败。请勿重复提交并稍后重试。'
          });
          return;
        }
        that.setData({
          reconcilingRights: false,
          rightsReviewRequired: false,
          rightsReviewText: '',
          successText: '已按原幂等请求从服务端确认上次资料权利请求提交完成'
        });
        if (that.data.operating) {
          that._needsReload = true;
          return;
        }
        that.loadChildren();
      });
    });
  },

  reconcileConsentOperation: function(marker, generation) {
    var that = this;
    app.guardianApi.getConsentOperation(marker.operation, marker.idempotencyKey)
      .then(function(result) {
        if (!that._alive || !that._visible || generation !== that._generation) return;
        var operation = result.data && result.data.guardianConsentOperation;
        var exactOperation = result.ok && operation
          && operation.operation === marker.operation
          && ['not_found', 'pending', 'completed'].indexOf(operation.status) >= 0;
        var completed = exactOperation && operation.status === 'completed'
          && Number.isFinite(Date.parse(operation.completedAt || ''));
        if (completed) {
          if (!app.clearGuardianConsentReview(marker.idempotencyKey)) {
            that.setData({
              enrollmentReviewRequired: true,
              reviewText: '服务端已确认提交完成，但本机恢复标记清理失败。请勿重复提交并稍后重试。'
            });
            return;
          }
          that.setData({
            enrollmentReviewRequired: false,
            reviewText: '',
            successText: '已按原幂等请求从服务端确认上次授权提交完成'
          });
          that.loadChildren();
          return;
        }
        that.setData({
          enrollmentReviewRequired: true,
          reviewText: exactOperation && operation.status === 'not_found'
            ? '服务端暂未找到上次授权请求。为防止迟到提交造成重复档案，请稍后再次核对。'
            : viewModel.errorMessage(result, '上次授权结果仍在核对，请稍后刷新')
        });
      });
  },

  loadChildDetails: function(child, parentGeneration) {
    var that = this;
    var generation = parentGeneration || this._generation;
    this._dataExport = null;
    this.setData({
      loading: true, consents: [], rightsRequests: [], nextCursor: null,
      exportSummary: null, exportSections: [], rightsDetail: null, errorText: ''
    });
    Promise.all([
      app.guardianApi.listConsents(child.id),
      app.guardianApi.listDataRightsRequests({ childId: child.id, limit: 20 })
    ]).then(function(results) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      var consentResult = results[0];
      var rightsResult = results[1];
      if (!consentResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(consentResult, '授权记录加载失败') });
        return;
      }
      if (!rightsResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(rightsResult, '处理回执加载失败') });
        return;
      }
      var body = rightsResult.data || {};
      that.setData({
        loading: false,
        consents: (((consentResult.data || {}).consents) || []).map(consentView),
        rightsRequests: (body.dataRightsRequests || []).map(viewModel.decorateRightsRequest),
        nextCursor: body.nextCursor || null
      });
    });
  },

  onChildChange: function(event) {
    if (this.data.operating || this.data.canRetryAction) return;
    var index = Number(event.detail.value) || 0;
    var child = this.data.children[index];
    this.clearSensitive();
    this.setData({ childIndex: index, selectedChild: child || null, errorText: '', successText: '' });
    if (child) this.loadChildDetails(child, this._generation);
  },

  onRightsTypeChange: function(event) {
    if (this.data.operating || this.data.canRetryAction || this.data.rightsReviewRequired) return;
    var index = Number(event.detail.value) || 0;
    this._pendingIntent = null;
    this.setData({
      rightsTypeIndex: index,
      currentRightsType: RIGHTS_TYPES[index].value,
      correctionAlias: '',
      rightsPassword: '',
      canRetryAction: false,
      canAbandonAction: false,
      exportSummary: null,
      exportSections: [],
      rightsDetail: null,
      errorText: ''
    });
  },

  onWithdrawPasswordInput: function(event) {
    if (this.data.operating || (this.data.canRetryAction
        && this._pendingIntent && this._pendingIntent.kind === 'withdraw')) return;
    if (this._pendingIntent && this._pendingIntent.kind === 'rights') {
      if (this._pendingIntent.body) this._pendingIntent.body.reauthAssertion = '';
      this._pendingIntent = null;
    }
    this.setData({
      withdrawPassword: event.detail.value,
      canRetryAction: false,
      canAbandonAction: false
    });
  },

  onRightsPasswordInput: function(event) {
    if (this.data.operating || this.data.canRetryAction || this.data.rightsReviewRequired) return;
    this._pendingIntent = null;
    this.setData({
      rightsPassword: event.detail.value,
      canRetryAction: false,
      canAbandonAction: false
    });
  },

  onCorrectionInput: function(event) {
    if (this.data.operating || this.data.canRetryAction || this.data.rightsReviewRequired) return;
    this._pendingIntent = null;
    this.setData({ correctionAlias: event.detail.value.slice(0, 30), canRetryAction: false });
  },

  goNewEnrollment: function() {
    if (!this.data.previewEnabled || this.data.operating || this.data.canRetryAction
        || this.data.enrollmentReviewRequired) return;
    app.globalData.guardianRouteContext = { kind: 'enroll' };
    wx.navigateTo({ url: '/pages/guardian-consent/guardian-consent' });
  },

  goReconsent: function() {
    var child = this.data.selectedChild;
    if (!child || !this.data.previewEnabled || this.data.operating || this.data.canRetryAction
        || this.data.enrollmentReviewRequired || !child.canReconsent) return;
    app.globalData.guardianRouteContext = {
      kind: 'reconsent',
      child: {
        id: child.id,
        alias: child.alias,
        revision: child.revision,
        privacyStatus: child.privacyState && child.privacyState.status
      }
    };
    wx.navigateTo({ url: '/pages/guardian-consent/guardian-consent' });
  },

  goDevices: function() {
    if (!this.data.previewEnabled || this.data.operating || this.data.canRetryAction) return;
    wx.navigateTo({ url: '/pages/device-management/device-management' });
  },

  openLegal: function(event) {
    if (this.data.operating || this.data.canRetryAction) return;
    var type = event.currentTarget.dataset.type;
    var allowed = [
      'privacyPolicy', 'childPersonalInformationRules', 'childUserAgreement',
      'sensitiveInformationNotice', 'guardianRelationDeclaration'
    ];
    if (allowed.indexOf(type) < 0) return;
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=' + encodeURIComponent(type) });
  },

  startWithdrawal: function() {
    var child = this.data.selectedChild;
    if (!child || !child.consent || child.consent.status !== 'active' || this.data.operating) return;
    var that = this;
    var generation = this._generation;
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: '撤回监护授权？',
      content: '撤回会立即阻断相关儿童资料处理，并撤销相关设备会话。之后仍可依法查阅或申请删除。',
      confirmColor: '#E24B4A',
      confirmText: '确认撤回',
      success: function(choice) {
        if (!that._alive || !that._visible || generation !== that._generation) return;
        that.setData({ operating: false });
        if (choice.confirm) that.beginProtectedAction('withdraw');
      },
      fail: function() {
        if (that._alive && that._visible && generation === that._generation) {
          that.setData({ operating: false });
        }
      }
    });
  },

  startRightsRequest: function() {
    var type = RIGHTS_TYPES[this.data.rightsTypeIndex];
    var child = this.data.selectedChild;
    if (!type || !child || this.data.operating || this.data.rightsReviewRequired) return;
    if (type.value === 'correct') {
      var alias = this.data.correctionAlias.trim();
      if (!alias || alias === child.alias) {
        wx.showToast({ title: '请输入不同的新别名', icon: 'none' });
        return;
      }
    }
    var that = this;
    var generation = this._generation;
    var destructive = type.value === 'delete' || type.value === 'terminate';
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: type.label + '？',
      content: destructive
        ? '当前仅提交处理请求并等待正式留存政策裁决，不代表资料已经删除。'
        : '账号验证通过后，服务端会记录本次儿童资料权利请求。',
      confirmColor: destructive ? '#E24B4A' : '#2D9B7A',
      confirmText: destructive ? '提交请求' : '继续',
      success: function(choice) {
        if (!that._alive || !that._visible || generation !== that._generation) return;
        that.setData({ operating: false });
        if (choice.confirm) that.beginProtectedAction('rights');
      },
      fail: function() {
        if (that._alive && that._visible && generation === that._generation) {
          that.setData({ operating: false });
        }
      }
    });
  },

  beginProtectedAction: function(kind) {
    if (this.data.operating) return;
    if (this._pendingIntent && this.data.canRetryAction) {
      if (this._pendingIntent.kind === kind) {
        this.performProtectedAction(this._pendingIntent);
        return;
      }
      if (kind !== 'withdraw') return;
      if (this._pendingIntent.body) this._pendingIntent.body.reauthAssertion = '';
      this._pendingIntent = null;
      this.setData({ canRetryAction: false, canAbandonAction: false });
    }
    if (kind === 'rights' && this.data.rightsReviewRequired) return;
    var child = this.data.selectedChild;
    var password = kind === 'withdraw' ? this.data.withdrawPassword : this.data.rightsPassword;
    if (!child || !password) {
      wx.showToast({ title: '请先输入当前成人账号密码', icon: 'none' });
      return;
    }
    var type = RIGHTS_TYPES[this.data.rightsTypeIndex];
    var correctionAlias = type && type.value === 'correct'
      ? this.data.correctionAlias.trim()
      : '';
    if (kind === 'rights' && type && type.value === 'correct'
        && (!correctionAlias || correctionAlias === child.alias)) {
      password = '';
      wx.showToast({ title: '请输入不同的新别名', icon: 'none' });
      return;
    }
    var purpose = kind === 'withdraw' ? 'child_consent_withdraw' : type.purpose;
    var that = this;
    var generation = this._generation;
    this.setData({
      operating: true,
      withdrawPassword: '',
      rightsPassword: '',
      canRetryAction: false,
      canAbandonAction: false,
      errorText: '',
      successText: ''
    });
    app.guardianApi.createReauth({ purpose: purpose, password: password }).then(function(result) {
      password = '';
      if (!that._alive || !that._visible || generation !== that._generation) {
        if (result && result.data) result.data.reauthAssertion = '';
        return;
      }
      if (!result.ok || !result.data || !result.data.reauthAssertion) {
        that.setData({ operating: false, errorText: viewModel.errorMessage(result, '账号验证失败') });
        return;
      }
      var body = {
        expectedRevision: child.revision,
        reauthAssertion: result.data.reauthAssertion
      };
      if (kind === 'rights') {
        body.requestType = type.value;
        if (type.value === 'correct') {
          body.correction = {
            target: 'child_profile',
            field: 'alias',
            expectedValue: child.alias,
            value: correctionAlias
          };
        }
      }
      app.guardianApi.createIdempotencyKey().then(function(key) {
        if (!that._alive || !that._visible || generation !== that._generation) {
          body.reauthAssertion = '';
          return;
        }
        var intent = {
          kind: kind,
          childId: child.id,
          previousPrivacyStatus: child.privacyState && child.privacyState.status,
          body: body,
          key: key,
          generation: generation,
          recoveryActorId: app.globalData.user && app.globalData.user.id || '',
          recoveryFamilyId: app.globalData.user && app.globalData.user.familyId || ''
        };
        if (kind === 'rights') {
          try {
            app.beginDataRightsRecovery(child.id, type.value, key);
          } catch (error) {
            body.reauthAssertion = '';
            that._pendingIntent = null;
            that.setData({
              operating: false,
              rightsReviewRequired: true,
              rightsReviewText: '本机安全恢复标记无法持久化，本次资料权利请求未提交。请清理小程序缓存后重新登录。',
              errorText: '安全恢复存储不可用，本次操作未提交'
            });
            return;
          }
          that.setData({
            rightsReviewRequired: true,
            rightsReviewText: '已保存本次资料权利请求的安全恢复句柄，正在等待服务端确认。'
          });
        }
        that._pendingIntent = intent;
        that.performProtectedAction(intent);
      }).catch(function() {
        body.reauthAssertion = '';
        if (!that._alive || !that._visible || generation !== that._generation) return;
        that.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
      });
    });
  },

  retryProtectedAction: function() {
    if (!this._rightsReconcileInFlight
        && this._pendingIntent && this.data.canRetryAction) {
      this.performProtectedAction(this._pendingIntent);
    }
  },

  abandonProtectedRetry: function() {
    if (!this.data.canRetryAction || !this._pendingIntent
        || this._pendingIntent.kind !== 'withdraw') return;
    if (this._pendingIntent && this._pendingIntent.body) {
      this._pendingIntent.body.reauthAssertion = '';
    }
    this._pendingIntent = null;
    this.setData({ canRetryAction: false, canAbandonAction: false, errorText: '' });
    this.loadChildren();
  },

  performProtectedAction: function(intent) {
    if (intent.kind === 'rights' && this._rightsReconcileInFlight) return;
    var that = this;
    var recoveringUnknownOutcome = intent.kind === 'rights'
      && intent.recoveryRequired === true;
    this.setData({
      operating: true,
      canRetryAction: false,
      canAbandonAction: false,
      errorText: ''
    });
    var promise = intent.kind === 'withdraw'
      ? app.guardianApi.withdrawConsent(intent.childId, intent.body, intent.key)
      : app.guardianApi.createDataRightsRequest(intent.childId, intent.body, intent.key);
    promise.then(function(result) {
      if (!that._alive || !that._visible || intent.generation !== that._generation) {
        if (intent.kind === 'rights' && !intent.recoveryRequired
            && determinateDataRightsFailure(result)
            && typeof app.clearDataRightsRecoveryScope === 'function') {
          app.clearDataRightsRecoveryScope(
            intent.recoveryActorId,
            intent.recoveryFamilyId,
            intent.key
          );
        }
        if (intent.body) intent.body.reauthAssertion = '';
        return;
      }
      if (!result.ok) {
        var ambiguous = viewModel.isOutcomeUnknown(result)
          || recoveringUnknownOutcome
          || (intent.kind === 'rights' && [
            'IDEMPOTENCY_IN_PROGRESS',
            'IDEMPOTENCY_RESULT_UNAVAILABLE',
            'IDEMPOTENCY_CONFLICT'
          ].indexOf(result.code) >= 0);
        if (intent.kind === 'rights' && ambiguous) intent.recoveryRequired = true;
        if (!ambiguous) {
          intent.body.reauthAssertion = '';
          that._pendingIntent = null;
        }
        var recoveryCleared = true;
        if (intent.kind === 'rights' && !ambiguous) {
          recoveryCleared = app.clearDataRightsRecovery(intent.key);
        }
        that.setData({
          operating: false,
          canRetryAction: ambiguous,
          canAbandonAction: ambiguous && intent.kind === 'withdraw',
          rightsReviewRequired: intent.kind === 'rights'
            ? (ambiguous || !recoveryCleared) : that.data.rightsReviewRequired,
          rightsReviewText: intent.kind === 'rights'
            ? (ambiguous
              ? '本次资料权利请求结果未知，已保留原幂等句柄；可重试同一次操作或稍后自动核对。'
              : (!recoveryCleared
                ? '服务端已明确拒绝本次请求，但本机恢复标记清理失败。请勿提交新请求并稍后核对。'
                : ''))
            : that.data.rightsReviewText,
          errorText: viewModel.errorMessage(result, '操作未完成')
        });
        if (!ambiguous && result.code === 'REVISION_CONFLICT') that.loadChildren();
        return;
      }
      var validResponse = intent.kind === 'withdraw'
        ? viewModel.validConsentMutationResponse(result.data, {
            kind: 'withdraw',
            childId: intent.childId,
            expectedRevision: intent.body.expectedRevision,
            previousPrivacyStatus: intent.previousPrivacyStatus
          })
        : viewModel.validRightsMutationDto(
            result.data && result.data.dataRightsRequest,
            { childId: intent.childId, requestType: intent.body.requestType }
          );
      if (!validResponse) {
        if (intent.kind === 'rights') intent.recoveryRequired = true;
        that.setData({
          operating: false,
          canRetryAction: true,
          canAbandonAction: intent.kind === 'withdraw',
          rightsReviewRequired: intent.kind === 'rights'
            ? true : that.data.rightsReviewRequired,
          rightsReviewText: intent.kind === 'rights'
            ? '服务端响应不完整，已保留原幂等句柄；请重试同一次操作或稍后自动核对。'
            : that.data.rightsReviewText,
          errorText: '服务端响应不完整，结果暂无法确认；请重试同一次操作',
          successText: ''
        });
        return;
      }
      intent.body.reauthAssertion = '';
      that._pendingIntent = null;
      var recoveryCleared = intent.kind !== 'rights'
        || app.clearDataRightsRecovery(intent.key);
      if (!recoveryCleared) {
        that.setData({
          operating: false,
          canRetryAction: false,
          canAbandonAction: false,
          rightsReviewRequired: true,
          rightsReviewText: '服务端已确认请求提交完成，但本机恢复标记清理失败。请勿重复提交并稍后核对。',
          errorText: '本机恢复标记清理失败，仍按结果未知处理',
          successText: ''
        });
        return;
      }
      var request = result.data && result.data.dataRightsRequest;
      var policyPending = request && (request.retentionDecision === 'policy_pending'
        || (request.deletion && request.deletion.status === 'blocked_policy'));
      that.setData({
        operating: false,
        canRetryAction: false,
        canAbandonAction: false,
        rightsReviewRequired: intent.kind === 'rights'
          ? false : that.data.rightsReviewRequired,
        rightsReviewText: intent.kind === 'rights'
          ? '' : that.data.rightsReviewText,
        correctionAlias: '',
        successText: intent.kind === 'withdraw'
          ? '授权已撤回，相关处理与设备会话应已被服务端阻断'
          : (policyPending ? '请求已受理，正式留存政策仍待确认' : '儿童资料请求已记录')
      });
      that.loadChildren();
    });
  },

  loadMoreRights: function() {
    var that = this;
    var child = this.data.selectedChild;
    var cursor = this.data.nextCursor;
    if (!child || !cursor || this.data.loading || this.data.loadingMore || this.data.operating) return;
    var generation = this._generation;
    this.setData({ loadingMore: true });
    app.guardianApi.listDataRightsRequests({ childId: child.id, limit: 20, cursor: cursor })
      .then(function(result) {
        if (!that._alive || !that._visible || generation !== that._generation) return;
        if (!result.ok) {
          that.setData({ loadingMore: false, errorText: viewModel.errorMessage(result, '更多处理回执加载失败') });
          return;
        }
        var body = result.data || {};
        that.setData({
          loadingMore: false,
          rightsRequests: that.data.rightsRequests.concat(
            (body.dataRightsRequests || []).map(viewModel.decorateRightsRequest)
          ),
          nextCursor: body.nextCursor || null
        });
      });
  },

  readExport: function(event) {
    var requestId = event.currentTarget.dataset.requestId;
    var childId = event.currentTarget.dataset.childId;
    var that = this;
    var generation = this._generation;
    if (!requestId || !childId || this.data.operating) return;
    this._dataExport = null;
    this.setData({
      operating: true, exportSummary: null, exportSections: [], errorText: ''
    });
    app.guardianApi.exportChildData(childId, requestId).then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      if (!result.ok) {
        that.setData({ operating: false, errorText: viewModel.errorMessage(result, '儿童资料读取失败') });
        return;
      }
      var snapshot = result.data && result.data.dataExport;
      if (!viewModel.validExportSnapshot(snapshot, childId, requestId)) {
        that.setData({
          operating: false,
          exportSummary: null,
          exportSections: [],
          errorText: '服务端资料快照响应不完整，本次内容未展示'
        });
        return;
      }
      var safeSnapshot = viewModel.safeExportSnapshot(snapshot);
      that._dataExport = safeSnapshot;
      that.setData({
        operating: false,
        exportSummary: viewModel.exportSummary(safeSnapshot),
        exportSections: viewModel.exportSections(safeSnapshot),
        successText: '资料快照仅在本页内存中用于本次查阅，离开页面即清除'
      });
    });
  },

  openRightsDetail: function(event) {
    var requestId = event.currentTarget.dataset.requestId;
    if (!requestId || this.data.operating) return;
    var that = this;
    var generation = this._generation;
    this.setData({ operating: true, rightsDetail: null, errorText: '' });
    app.guardianApi.getDataRightsRequest(requestId).then(function(result) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      if (!result.ok || !result.data
          || !viewModel.validRightsDetail(result.data.dataRightsRequest, requestId)) {
        that.setData({
          operating: false,
          errorText: viewModel.errorMessage(result, '处理详情加载失败')
        });
        return;
      }
      that.setData({
        operating: false,
        rightsDetail: viewModel.decorateRightsDetail(result.data.dataRightsRequest)
      });
    });
  },

  closeRightsDetail: function() {
    if (this.data.operating) return;
    this.setData({ rightsDetail: null });
  }
});
