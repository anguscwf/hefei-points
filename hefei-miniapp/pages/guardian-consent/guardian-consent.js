var app = getApp();
var viewModel = require('../../utils/guardian-page.js');

var LEGAL_ITEMS = [
  { key: 'privacyPolicy', title: '隐私政策' },
  { key: 'childPersonalInformationRules', title: '儿童个人信息保护规则' },
  { key: 'childUserAgreement', title: '儿童用户协议' },
  { key: 'sensitiveInformationNotice', title: '敏感个人信息单独告知' }
];

var RELATIONS = [
  { value: 'father', label: '父亲' },
  { value: 'mother', label: '母亲' },
  { value: 'legal_guardian', label: '其他法定监护人' },
  { value: 'other_guardian', label: '其他监护人' }
];

function initialLegalItems() {
  return LEGAL_ITEMS.map(function(item) {
    return { key: item.key, title: item.title, accepted: false, version: '', sha256: '' };
  });
}

Page({
  data: {
    themePageStyle: '',
    themeClass: '',
    loading: true,
    submitting: false,
    canRetry: false,
    reconcileRequired: false,
    isAdult: false,
    previewEnabled: false,
    mode: 'enroll',
    childAlias: '',
    alias: '',
    expectedRevision: 0,
    relations: RELATIONS,
    relationIndex: 0,
    relationAccepted: false,
    relationVersion: '',
    relationSha256: '',
    legalItems: initialLegalItems(),
    password: '',
    canSubmit: false,
    errorText: '',
    successText: ''
  },

  onLoad: function() {
    this._alive = true;
    this._visible = true;
    this._epoch = 0;
    this._needsLegalReload = false;
    this._sessionGeneration = app._sessionGeneration || 0;
    var that = this;
    if (typeof app.subscribeGuardianSession === 'function') {
      this._sessionUnsubscribe = app.subscribeGuardianSession(function() {
        that.onGuardianSessionChanged();
      });
    }
    var context = app.globalData.guardianRouteContext;
    app.globalData.guardianRouteContext = null;
    var reconsentStatuses = {
      active: true,
      suspended_pending_consent: true,
      processing_blocked: true
    };
    var isReconsent = !!(context && context.kind === 'reconsent' && context.child
      && typeof context.child.id === 'string' && context.child.id
      && Number.isInteger(Number(context.child.revision)) && Number(context.child.revision) >= 0
      && reconsentStatuses[context.child.privacyStatus] === true);
    this._childId = isReconsent ? context.child.id : '';
    this._previousPrivacyStatus = isReconsent ? context.child.privacyStatus : '';
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      isAdult: !!(app.globalData.token && app.globalData.user
        && app.globalData.user.role !== 'child'),
      previewEnabled: app.globalData.guardianPreviewEnabled === true,
      mode: isReconsent ? 'reconsent' : 'enroll',
      reconcileRequired: !!app.globalData.guardianEnrollmentReviewRequired,
      childAlias: isReconsent ? context.child.alias : '',
      expectedRevision: isReconsent ? Number(context.child.revision) || 0 : 0
    });
    this.loadLegalTexts();
  },

  onShow: function() {
    this._visible = true;
    if (!this._alive) return;
    if (this._sessionGeneration !== (app._sessionGeneration || 0)) {
      this.onGuardianSessionChanged();
      return;
    }
    var required = !!app.globalData.guardianEnrollmentReviewRequired;
    this.setData({
      reconcileRequired: required,
      errorText: required
        ? '上次授权提交结果尚需核对，请返回“家庭与隐私”刷新服务端状态，勿重复建档'
        : this.data.errorText
    });
    if (this._needsLegalReload) {
      this.loadLegalTexts();
      return;
    }
    this.syncCanSubmit();
  },

  onHide: function() {
    this._visible = false;
    this._epoch += 1;
    this._needsLegalReload = true;
    this.setData({
      relationAccepted: false,
      legalItems: this.data.legalItems.map(function(item) {
        return Object.assign({}, item, { accepted: false });
      }),
      canSubmit: false
    });
    this.clearSensitive();
  },

  onUnload: function() {
    this._alive = false;
    this._visible = false;
    this._epoch += 1;
    this.clearSensitive(false);
    if (this._sessionUnsubscribe) this._sessionUnsubscribe();
    this._sessionUnsubscribe = null;
  },

  onGuardianSessionChanged: function() {
    this._sessionGeneration = app._sessionGeneration || 0;
    this._epoch = (this._epoch || 0) + 1;
    this.clearSensitive();
    this._childId = '';
    this._previousPrivacyStatus = '';
    var isAdult = !!(app.globalData.token && app.globalData.user
      && app.globalData.user.role !== 'child');
    this.setData({
      isAdult: isAdult,
      mode: 'enroll',
      childAlias: '',
      alias: '',
      expectedRevision: 0,
      relationAccepted: false,
      legalItems: initialLegalItems(),
      reconcileRequired: !!app.globalData.guardianEnrollmentReviewRequired,
      errorText: isAdult ? '登录账号已变化，请重新确认全部授权内容' : '请先使用成人账号登录',
      successText: ''
    });
    if (this._alive && this._visible) {
      this.loadLegalTexts();
    } else {
      this._needsLegalReload = true;
    }
  },

  loadLegalTexts: function() {
    var that = this;
    var epoch = this._epoch;
    this._needsLegalReload = false;
    this.setData({ loading: true, errorText: '', successText: '' });
    app.guardianApi.currentLegalTexts().then(function(result) {
      if (!that._alive || epoch !== that._epoch) return;
      if (!result.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(result, '法律文本加载失败') });
        return;
      }
      var body = result.data || {};
      var texts = body.texts || {};
      var declaration = body.guardianRelationDeclaration || {};
      var items = LEGAL_ITEMS.map(function(item) {
        var evidence = texts[item.key] || {};
        return {
          key: item.key,
          title: item.title,
          accepted: false,
          version: evidence.version || '',
          sha256: evidence.sha256 || '',
          shaShort: evidence.sha256 ? evidence.sha256.slice(0, 12) + '…' : '待加载'
        };
      });
      that.setData({
        loading: false,
        legalItems: items,
        relationAccepted: false,
        relationVersion: declaration.version || '',
        relationSha256: declaration.sha256 || ''
      });
      that.syncCanSubmit();
    });
  },

  onAliasInput: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    this.setData({ alias: event.detail.value.slice(0, 30) });
    this.syncCanSubmit();
  },

  onPasswordInput: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    this.setData({ password: event.detail.value });
    this.syncCanSubmit();
  },

  onRelationChange: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    this.setData({ relationIndex: Number(event.detail.value) || 0 });
  },

  onRelationAccepted: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    this.setData({ relationAccepted: event.detail.value.length > 0 });
    this.syncCanSubmit();
  },

  onLegalAccepted: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    var key = event.currentTarget.dataset.key;
    var accepted = event.detail.value.length > 0;
    var items = this.data.legalItems.map(function(item) {
      return item.key === key ? Object.assign({}, item, { accepted: accepted }) : item;
    });
    this.setData({ legalItems: items });
    this.syncCanSubmit();
  },

  openLegal: function(event) {
    if (this.data.submitting || this.data.canRetry) return;
    var key = event.currentTarget.dataset.key;
    var allowed = LEGAL_ITEMS.some(function(item) { return item.key === key; })
      || key === 'guardianRelationDeclaration';
    if (!allowed) return;
    wx.navigateTo({ url: '/pages/legal-document/legal-document?type=' + encodeURIComponent(key) });
  },

  syncCanSubmit: function() {
    var aliasReady = this.data.mode === 'reconsent'
      || (this.data.alias.trim().length >= 1 && this.data.alias.trim().length <= 30);
    var allLegalAccepted = this.data.legalItems.length === LEGAL_ITEMS.length
      && this.data.legalItems.every(function(item) {
        return item.accepted && item.version && item.sha256;
      });
    var canSubmit = this.data.isAdult && this.data.previewEnabled && aliasReady
      && this.data.relationAccepted && this.data.relationVersion && this.data.relationSha256
      && allLegalAccepted && this.data.password.length > 0 && !this.data.submitting
      && !this.data.reconcileRequired;
    this.setData({ canSubmit: !!canSubmit });
  },

  buildAcceptance: function(reauthAssertion) {
    if (!this.data.relationAccepted || !this.data.relationVersion || !this.data.relationSha256
        || this.data.legalItems.length !== LEGAL_ITEMS.length
        || !this.data.legalItems.every(function(item) {
          return item.accepted && item.version && item.sha256;
        })) return null;
    var consents = {};
    this.data.legalItems.forEach(function(item) {
      consents[item.key] = {
        accepted: true,
        version: item.version,
        sha256: item.sha256
      };
    });
    var body = {
      reauthAssertion: reauthAssertion,
      guardianRelation: RELATIONS[this.data.relationIndex].value,
      relationDeclaration: {
        accepted: true,
        version: this.data.relationVersion,
        sha256: this.data.relationSha256
      },
      consents: consents
    };
    if (this.data.mode === 'enroll') body.alias = this.data.alias.trim();
    if (this.data.mode === 'reconsent') body.expectedRevision = this.data.expectedRevision;
    return body;
  },

  submit: function() {
    if (this.data.submitting) return;
    if (this._pendingWrite) {
      this.performConsentWrite(this._pendingWrite);
      return;
    }
    if (this.data.reconcileRequired || app.globalData.guardianEnrollmentReviewRequired) {
      wx.showToast({ title: '请先返回家庭与隐私核对上次结果', icon: 'none' });
      return;
    }
    this.syncCanSubmit();
    if (!this.data.canSubmit) {
      wx.showToast({ title: '请先完成阅读、确认与账号验证', icon: 'none' });
      return;
    }
    var that = this;
    var epoch = this._epoch;
    var password = this.data.password;
    var purpose = this.data.mode === 'enroll' ? 'child_enrollment' : 'child_consent';
    var acceptanceSnapshot = this.buildAcceptance('');
    if (!acceptanceSnapshot) {
      wx.showToast({ title: '授权证据不完整，请重新确认', icon: 'none' });
      return;
    }
    this.setData({ submitting: true, canSubmit: false, canRetry: false, password: '', errorText: '', successText: '' });
    app.guardianApi.createReauth({ purpose: purpose, password: password }).then(function(result) {
      password = '';
      if (!that._alive || epoch !== that._epoch) {
        if (result && result.data) result.data.reauthAssertion = '';
        return;
      }
      if (!result.ok || !result.data || !result.data.reauthAssertion) {
        that.setData({ submitting: false, canRetry: false, errorText: viewModel.errorMessage(result, '账号验证失败') });
        that.syncCanSubmit();
        return;
      }
      var acceptance = Object.assign({}, acceptanceSnapshot, {
        reauthAssertion: result.data.reauthAssertion
      });
      app.guardianApi.createIdempotencyKey().then(function(key) {
        if (!that._alive || epoch !== that._epoch) {
          acceptance.reauthAssertion = '';
          return;
        }
        var pending = { key: key, body: acceptance, epoch: epoch, reviewMarker: null };
        that._pendingWrite = pending;
        that.performConsentWrite(pending);
      }).catch(function() {
        acceptance.reauthAssertion = '';
        if (!that._alive || epoch !== that._epoch) return;
        that.setData({
          submitting: false,
          errorText: '安全随机数不可用，本次操作未提交'
        });
      });
    });
  },

  performConsentWrite: function(pending) {
    var that = this;
    this.setData({ submitting: true, canSubmit: false, errorText: '' });
    if (!pending.reviewMarker) {
      try {
        pending.reviewMarker = app.beginGuardianConsentReview(
          this.data.mode === 'enroll' ? 'child-enrollment' : 'child-consent',
          pending.key
        );
      } catch (error) {
        pending.body.reauthAssertion = '';
        this._pendingWrite = null;
        this.setData({
          submitting: false,
          canRetry: false,
          errorText: '本机无法建立安全恢复标记，本次授权未提交'
        });
        return;
      }
    }
    var promise = this.data.mode === 'enroll'
      ? app.guardianApi.enrollChild(pending.body, pending.key)
      : app.guardianApi.createConsent(this.data.childAlias ? this._routeChildId() : '', pending.body, pending.key);
    promise.then(function(result) {
      var ambiguous = !result.ok && viewModel.isOutcomeUnknown(result);
      var currentMarker = app.globalData.guardianEnrollmentReviewRequired
        && app.globalData.guardianEnrollmentReviewRequired.idempotencyKey === pending.key;
      if (!that._alive || pending.epoch !== that._epoch) {
        pending.body.reauthAssertion = '';
        that._pendingWrite = null;
        if (!result.ok && !ambiguous && currentMarker) app.clearGuardianConsentReview(pending.key);
        return;
      }
      if (!result.ok) {
        if (!ambiguous) {
          pending.body.reauthAssertion = '';
          that._pendingWrite = null;
          if (currentMarker) app.clearGuardianConsentReview(pending.key);
        }
        if (result.code === 'LEGAL_TEXT_VERSION_MISMATCH') {
          that._pendingWrite = null;
          that.loadLegalTexts();
        }
        that.setData({
          submitting: false,
          canRetry: ambiguous,
          errorText: viewModel.errorMessage(result),
          successText: ''
        });
        that.syncCanSubmit();
        return;
      }
      var responseKind = that.data.mode === 'enroll' ? 'enroll' : 'reconsent';
      var validResponse = viewModel.validConsentMutationResponse(result.data, {
        kind: responseKind,
        childId: responseKind === 'reconsent' ? that._routeChildId() : '',
        alias: responseKind === 'enroll' ? pending.body.alias : '',
        expectedRevision: responseKind === 'reconsent'
          ? pending.body.expectedRevision : undefined,
        previousPrivacyStatus: responseKind === 'reconsent'
          ? that._previousPrivacyStatus : undefined
      });
      if (!validResponse) {
        that.setData({
          submitting: false,
          canRetry: true,
          errorText: '授权响应不完整，结果暂无法确认；请重试同一次提交',
          successText: ''
        });
        return;
      }
      pending.body.reauthAssertion = '';
      that._pendingWrite = null;
      if (currentMarker) app.clearGuardianConsentReview(pending.key);
      var child = result.data && result.data.child;
      that.setData({
        submitting: false,
        canRetry: false,
        alias: '',
        relationAccepted: false,
        legalItems: that.data.legalItems.map(function(item) {
          return Object.assign({}, item, { accepted: false });
        }),
        successText: that.data.mode === 'enroll'
          ? '监护授权已记录，儿童档案已安全创建'
          : '新的监护授权已记录，请以服务端状态为准',
        childAlias: child && child.alias ? child.alias : that.data.childAlias
      });
      that.syncCanSubmit();
    });
  },

  _routeChildId: function() {
    return this._childId || '';
  },

  goReview: function() {
    wx.navigateBack({ delta: 1 });
  },

  clearSensitive: function(updateView) {
    if (this._pendingWrite && this._pendingWrite.body) {
      this._pendingWrite.body.reauthAssertion = '';
    }
    this._pendingWrite = null;
    if (this.data && (this.data.password || this.data.canRetry || this.data.submitting)) {
      var cleared = { password: '', canRetry: false, submitting: false, canSubmit: false };
      if (updateView === false) Object.assign(this.data, cleared);
      else this.setData(cleared);
    }
  }
});
