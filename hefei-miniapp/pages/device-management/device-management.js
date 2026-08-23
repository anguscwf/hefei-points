var app = getApp();
var viewModel = require('../../utils/guardian-page.js');
var PAIRING_STATUSES = {
  pending: true, claimed: true, confirmed: true, completed: true,
  expired: true, locked: true, cancelled: true
};
var RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var SHA256 = /^[a-f0-9]{64}$/;
var SHORT_CODE = /^\d{6}$/;
var CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function validClaimedDevice(device) {
  return !!device && typeof device.id === 'string' && RESOURCE_ID.test(device.id)
    && typeof device.alias === 'string' && device.alias.trim()
    && device.alias.length <= 100 && !/[\u0000-\u001f\u007f]/.test(device.alias)
    && device.publicKey && device.publicKey.algorithm === 'ECDSA_P256_SHA256'
    && typeof device.publicKey.sha256 === 'string' && SHA256.test(device.publicKey.sha256);
}

function validPairingDto(pairing, expectedChildId, expectedPairingId) {
  return !!pairing && typeof pairing.id === 'string' && RESOURCE_ID.test(pairing.id)
    && (!expectedPairingId || pairing.id === expectedPairingId)
    && pairing.childId === expectedChildId && PAIRING_STATUSES[pairing.status] === true
    && Number.isSafeInteger(pairing.revision) && pairing.revision >= 0
    && Number.isFinite(Date.parse(pairing.expiresAt || ''))
    && (pairing.status !== 'claimed' || validClaimedDevice(pairing.claimedDevice));
}

function validRecoverySecrets(body) {
  return !!body && SHORT_CODE.test(body.shortCode || '')
    && CHALLENGE.test(body.pairingChallenge || '');
}

function validRevokedDevice(device, expectedId, expectedRevision) {
  return !!device && device.id === expectedId && RESOURCE_ID.test(device.id)
    && typeof device.childId === 'string' && RESOURCE_ID.test(device.childId)
    && typeof device.publicId === 'string' && device.publicId.length > 0
    && typeof device.alias === 'string' && device.alias.length > 0
    && device.publicKey && device.publicKey.algorithm === 'ECDSA_P256_SHA256'
    && typeof device.publicKey.sha256 === 'string' && SHA256.test(device.publicKey.sha256)
    && device.status === 'revoked'
    && device.revision === expectedRevision + 1
    && Number.isFinite(Date.parse(device.claimedAt || ''))
    && Number.isFinite(Date.parse(device.revokedAt || ''));
}

function validRevokedSession(session, expectedId, expectedRevision) {
  return !!session && session.id === expectedId && RESOURCE_ID.test(session.id)
    && session.status === 'revoked' && session.revision === expectedRevision + 1;
}

function pairingView(pairing) {
  pairing = pairing || {};
  var device = pairing.claimedDevice || null;
  return Object.assign({}, pairing, {
    expiresText: viewModel.dateTime(pairing.expiresAt),
    statusLabel: {
      pending: '等待孩子端输入',
      claimed: '等待家长确认',
      confirmed: '家长已确认，等待设备完成',
      completed: '配对已完成',
      expired: '配对已过期',
      locked: '配对已锁定',
      cancelled: '配对已取消'
    }[pairing.status] || '状态待确认',
    deviceFingerprint: viewModel.formatSha256Fingerprint(
      device && device.publicKey && device.publicKey.sha256
    )
  });
}

function pairingNeedsGuardian(pairing) {
  return !!pairing && (pairing.status === 'pending' || pairing.status === 'claimed');
}

Page({
  data: {
    themePageStyle: '',
    themeClass: '',
    isAdult: false,
    previewEnabled: false,
    loading: false,
    operating: false,
    errorText: '',
    children: [],
    childIndex: 0,
    devices: [],
    pairing: null,
    shortCode: '',
    canRetryCreate: false,
    canRetryMutation: false,
    pairingRecoveryUnavailable: false
  },

  onLoad: function() {
    this._alive = true;
    this._visible = true;
    this._epoch = 0;
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
    this._loaded = true;
    if (this.data.isAdult && this.data.previewEnabled) this.loadPage();
  },

  onShow: function() {
    this._visible = true;
    if (this._sessionGeneration !== (app._sessionGeneration || 0)) {
      this.onGuardianSessionChanged();
      return;
    }
    if (this._loaded && this._needsReload && this.data.isAdult && this.data.previewEnabled) {
      this._needsReload = false;
      this.loadPage();
    }
  },

  onHide: function() {
    this._visible = false;
    this._epoch += 1;
    this.clearPageData();
    this._needsReload = true;
  },

  onUnload: function() {
    this._alive = false;
    this._visible = false;
    this._epoch += 1;
    this.clearPageData(false);
    if (this._sessionUnsubscribe) this._sessionUnsubscribe();
    this._sessionUnsubscribe = null;
  },

  onGuardianSessionChanged: function() {
    this._sessionGeneration = app._sessionGeneration || 0;
    this._epoch = (this._epoch || 0) + 1;
    this.clearPageData();
    var isAdult = !!(app.globalData.token && app.globalData.user
      && app.globalData.user.role !== 'child');
    this.setData({
      isAdult: isAdult,
      pairingRecoveryUnavailable: false,
      errorText: isAdult ? '' : '登录状态已变化，请重新使用成人账号登录'
    });
    if (this._alive && this._visible && isAdult && this.data.previewEnabled) {
      if (typeof app._restoreDevicePairingIntent === 'function') {
        app._restoreDevicePairingIntent();
      }
      this._needsReload = false;
      this.loadPage();
    } else {
      this._needsReload = true;
    }
  },

  clearPageData: function(updateView) {
    this._generation = (this._generation || 0) + 1;
    this._pairingChallenge = '';
    this._pairingCreateIntent = null;
    if (this._mutationIntent && this._mutationIntent.body) {
      this._mutationIntent.body.pairingChallenge = '';
    }
    this._mutationIntent = null;
    if (this.data) {
      var cleared = {
        shortCode: '', pairing: null, canRetryCreate: false, canRetryMutation: false,
        devices: [], children: [], childIndex: 0, operating: false, loading: false,
        pairingRecoveryUnavailable: false
      };
      if (updateView === false) Object.assign(this.data, cleared);
      else this.setData(cleared);
    }
  },

  loadPage: function() {
    var that = this;
    var generation = (this._generation || 0) + 1;
    this._generation = generation;
    this.setData({ loading: true, errorText: '' });
    Promise.all([app.guardianApi.listChildren(), app.guardianApi.listDevices()]).then(function(results) {
      if (!that._alive || !that._visible || generation !== that._generation) return;
      var childResult = results[0];
      var deviceResult = results[1];
      if (!childResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(childResult, '儿童列表加载失败') });
        return;
      }
      if (!deviceResult.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(deviceResult, '设备列表加载失败') });
        return;
      }
      var children = ((childResult.data && childResult.data.children) || [])
        .map(viewModel.decorateChild)
        .filter(function(child) {
          return child.privacyState.status === 'active' && child.consent.status === 'active';
        });
      var devices = ((deviceResult.data && deviceResult.data.devices) || [])
        .map(viewModel.decorateDevice);
      var savedIntent = app.globalData.guardianDeviceCreateIntent;
      var recoveryUnavailable = !!(savedIntent && savedIntent.storageUnavailable);
      var retryIndex = !recoveryUnavailable && savedIntent && savedIntent.body
        ? children.findIndex(function(child) { return child.id === savedIntent.body.childId; })
        : -1;
      if (retryIndex >= 0 && typeof savedIntent.key === 'string') {
        that._pairingCreateIntent = {
          key: savedIntent.key,
          body: { childId: savedIntent.body.childId },
          epoch: that._epoch
        };
      } else if (savedIntent && !recoveryUnavailable) {
        if (typeof app.clearDevicePairingRecovery !== 'function'
            || !app.clearDevicePairingRecovery(savedIntent.key)) {
          var current = app.globalData.guardianDeviceCreateIntent;
          recoveryUnavailable = !!current;
        }
        that._pairingCreateIntent = null;
      }
      that.setData({
        loading: false,
        children: children,
        devices: devices,
        childIndex: retryIndex >= 0 ? retryIndex : 0,
        canRetryCreate: retryIndex >= 0,
        pairingRecoveryUnavailable: recoveryUnavailable,
        errorText: recoveryUnavailable
          ? '本机安全恢复存储不可用，不能创建新的设备配对'
          : (retryIndex >= 0 ? '上次生成请求结果未确认，请使用同一次请求重试' : '')
      });
    });
  },

  onChildChange: function(event) {
    if (this.data.operating || this.data.canRetryCreate || this.data.canRetryMutation
        || this.data.pairingRecoveryUnavailable || pairingNeedsGuardian(this.data.pairing)
        || this._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent) return;
    this._epoch += 1;
    this._pairingCreateIntent = null;
    this._pairingChallenge = '';
    if (this._mutationIntent && this._mutationIntent.body) {
      this._mutationIntent.body.pairingChallenge = '';
    }
    this._mutationIntent = null;
    this.setData({
      childIndex: Number(event.detail.value) || 0,
      pairing: null,
      shortCode: '',
      canRetryCreate: false,
      canRetryMutation: false,
      operating: false,
      errorText: ''
    });
  },

  createPairing: function() {
    if (this.data.operating || this.data.pairingRecoveryUnavailable
        || pairingNeedsGuardian(this.data.pairing)) return;
    var child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: '没有可配对的已授权儿童', icon: 'none' });
      return;
    }
    if (!this._pairingCreateIntent) {
      var page = this;
      var epoch = this._epoch;
      this._pairingChallenge = '';
      this.setData({
        operating: true,
        pairing: null,
        shortCode: '',
        canRetryMutation: false,
        errorText: ''
      });
      app.guardianApi.createIdempotencyKey().then(function(key) {
        if (!page._alive || !page._visible || epoch !== page._epoch) return;
        try {
          if (typeof app.beginDevicePairingRecovery !== 'function') {
            throw new Error('device pairing recovery is unavailable');
          }
          app.beginDevicePairingRecovery(child.id, key);
        } catch (error) {
          page.setData({
            operating: false,
            pairingRecoveryUnavailable: true,
            errorText: '本机安全恢复存储不可用，本次配对请求未提交'
          });
          return;
        }
        page._pairingCreateIntent = { key: key, body: { childId: child.id }, epoch: epoch };
        page.setData({ operating: false });
        page.createPairing();
      }).catch(function() {
        if (!page._alive || !page._visible || epoch !== page._epoch) return;
        page.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
      });
      return;
    }
    var that = this;
    var intent = this._pairingCreateIntent;
    this.setData({ operating: true, canRetryCreate: false, errorText: '' });
    app.guardianApi.createPairing(intent.body, intent.key).then(function(result) {
      if (!that._alive || !that._visible || intent.epoch !== that._epoch) return;
      if (!result.ok) {
        var ambiguous = viewModel.isOutcomeUnknown(result);
        if (!ambiguous) {
          that.clearPairingRecovery(intent.key);
        }
        that.setData({
          operating: false,
          canRetryCreate: ambiguous,
          errorText: viewModel.errorMessage(result, '无法生成配对码')
        });
        return;
      }
      var body = result.data || {};
      if (!validPairingDto(body.pairing, intent.body.childId)
          || (pairingNeedsGuardian(body.pairing) && !validRecoverySecrets(body))) {
        that._pairingChallenge = '';
        that.setData({
          operating: false,
          pairing: null,
          shortCode: '',
          canRetryCreate: true,
          errorText: '配对响应不完整，结果暂无法确认；请按原生成请求重试'
        });
        return;
      }
      var nextPairing = pairingView(body.pairing);
      var recoverable = pairingNeedsGuardian(nextPairing);
      if (!recoverable) that.clearPairingRecovery(intent.key);
      that._pairingChallenge = recoverable ? (body.pairingChallenge || '') : '';
      that.setData({
        operating: false,
        canRetryCreate: false,
        pairing: nextPairing,
        shortCode: nextPairing.status === 'pending' ? (body.shortCode || '') : ''
      });
    });
  },

  clearPairingRecovery: function(expectedKey) {
    if (typeof app.clearDevicePairingRecovery !== 'function') {
      this.setData({ pairingRecoveryUnavailable: true });
      return false;
    }
    app.clearDevicePairingRecovery(expectedKey);
    var remaining = app.globalData.guardianDeviceCreateIntent;
    if (remaining && (remaining.storageUnavailable || remaining.key === expectedKey)) {
      this.setData({ pairingRecoveryUnavailable: true });
      return false;
    }
    if (this._pairingCreateIntent && this._pairingCreateIntent.key === expectedKey) {
      this._pairingCreateIntent = null;
    }
    return true;
  },

  refreshPairing: function() {
    var that = this;
    var pairing = this.data.pairing;
    var epoch = this._epoch;
    if (!pairing || this.data.operating) return;
    this.setData({ operating: true, errorText: '' });
    app.guardianApi.getPairing(pairing.id).then(function(result) {
      if (!that._alive || !that._visible || epoch !== that._epoch) return;
      if (!result.ok) {
        var terminalCodes = [
          'PAIRING_NOT_FOUND', 'PAIRING_EXPIRED', 'PAIRING_LOCKED',
          'CONSENT_REQUIRED', 'PROCESSING_BLOCKED', 'CHILD_PROCESSING_BLOCKED'
        ];
        if (terminalCodes.indexOf(result.code) >= 0) {
          var terminalMarker = that._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent;
          if (terminalMarker && terminalMarker.key) that.clearPairingRecovery(terminalMarker.key);
          that._pairingChallenge = '';
          that.setData({
            operating: false, pairing: null, shortCode: '', canRetryCreate: false,
            errorText: viewModel.errorMessage(result, '配对已不可继续')
          });
          return;
        }
        that.setData({ operating: false, errorText: viewModel.errorMessage(result, '配对状态刷新失败') });
        return;
      }
      var rawPairing = result.data && result.data.pairing;
      if (!validPairingDto(rawPairing, pairing.childId, pairing.id)) {
        that.setData({
          operating: false,
          errorText: '配对状态响应不完整，已保留原恢复请求，请稍后重试'
        });
        return;
      }
      var nextPairing = pairingView(rawPairing);
      var keepSecrets = nextPairing.status === 'pending' || nextPairing.status === 'claimed';
      if (!keepSecrets) {
        that._pairingChallenge = '';
        var marker = that._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent;
        if (marker && marker.key) that.clearPairingRecovery(marker.key);
      }
      that.setData({
        operating: false,
        pairing: nextPairing,
        shortCode: nextPairing.status === 'pending' ? that.data.shortCode : ''
      });
    });
  },

  confirmPairing: function() {
    var pairing = this.data.pairing;
    if (!pairing || pairing.status !== 'claimed' || this.data.operating) return;
    if (!this._pairingChallenge) {
      this.setData({ errorText: '家长确认凭据已从内存清除，请重新生成配对码' });
      return;
    }
    var that = this;
    var epoch = this._epoch;
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: '确认绑定这台设备？',
      content: '请与孩子当面核对设备别名和公钥指纹。确认后设备才能申请自己的会话凭据。',
      confirmText: '确认绑定',
      success: function(choice) {
        if (!that._alive || !that._visible || epoch !== that._epoch) return;
        if (!choice.confirm) {
          that.setData({ operating: false });
          return;
        }
        app.guardianApi.createIdempotencyKey().then(function(key) {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.performMutation({
            type: 'confirm',
            id: pairing.id,
            key: key,
            epoch: epoch,
            body: {
              expectedRevision: pairing.revision,
              pairingChallenge: that._pairingChallenge
            }
          });
        }).catch(function() {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
        });
      },
      fail: function() {
        if (that._alive && that._visible && epoch === that._epoch) that.setData({ operating: false });
      }
    });
  },

  loadDevicesOnly: function() {
    var that = this;
    var epoch = this._epoch;
    app.guardianApi.listDevices().then(function(result) {
      if (!that._alive || !that._visible || epoch !== that._epoch || !result.ok) return;
      that.setData({ devices: ((result.data && result.data.devices) || []).map(viewModel.decorateDevice) });
    });
  },

  revokeDevice: function(event) {
    var id = event.currentTarget.dataset.id;
    var revision = Number(event.currentTarget.dataset.revision);
    var that = this;
    var epoch = this._epoch;
    if (!id || !Number.isSafeInteger(revision) || revision < 0 || this.data.operating) return;
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: '撤销设备绑定？',
      content: '设备及其全部会话会立即失效。需要再次使用时必须重新配对。',
      confirmColor: '#E24B4A',
      confirmText: '立即撤销',
      success: function(choice) {
        if (!that._alive || !that._visible || epoch !== that._epoch) return;
        if (!choice.confirm) {
          that.setData({ operating: false });
          return;
        }
        app.guardianApi.createIdempotencyKey().then(function(key) {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.performMutation({
            type: 'device', id: id, key: key, epoch: epoch,
            body: { expectedRevision: revision }
          });
        }).catch(function() {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
        });
      },
      fail: function() {
        if (that._alive && that._visible && epoch === that._epoch) that.setData({ operating: false });
      }
    });
  },

  revokeSession: function(event) {
    var id = event.currentTarget.dataset.id;
    var revision = Number(event.currentTarget.dataset.revision);
    var that = this;
    var epoch = this._epoch;
    if (!id || !Number.isSafeInteger(revision) || revision < 0 || this.data.operating) return;
    this.setData({ operating: true, errorText: '' });
    wx.showModal({
      title: '撤销设备会话？',
      content: '该会话组的访问与刷新凭据会立即失效。',
      confirmColor: '#E24B4A',
      confirmText: '撤销会话',
      success: function(choice) {
        if (!that._alive || !that._visible || epoch !== that._epoch) return;
        if (!choice.confirm) {
          that.setData({ operating: false });
          return;
        }
        app.guardianApi.createIdempotencyKey().then(function(key) {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.performMutation({
            type: 'session', id: id, key: key, epoch: epoch,
            body: { expectedRevision: revision }
          });
        }).catch(function() {
          if (!that._alive || !that._visible || epoch !== that._epoch) return;
          that.setData({ operating: false, errorText: '安全随机数不可用，本次操作未提交' });
        });
      },
      fail: function() {
        if (that._alive && that._visible && epoch === that._epoch) that.setData({ operating: false });
      }
    });
  },

  retryMutation: function() {
    if (this._mutationIntent && this.data.canRetryMutation && !this.data.operating) {
      this.performMutation(this._mutationIntent);
    }
  },

  performMutation: function(intent) {
    var that = this;
    this._mutationIntent = intent;
    this.setData({ operating: true, canRetryMutation: false, errorText: '' });
    var promise = intent.type === 'confirm'
      ? app.guardianApi.confirmPairing(intent.id, intent.body, intent.key)
      : (intent.type === 'device'
        ? app.guardianApi.revokeDevice(intent.id, intent.body, intent.key)
        : app.guardianApi.revokeDeviceSession(intent.id, intent.body, intent.key));
    promise.then(function(result) {
      if (!that._alive || !that._visible || intent.epoch !== that._epoch) return;
      if (!result.ok) {
        var ambiguous = viewModel.isOutcomeUnknown(result);
        if (!ambiguous) {
          if (intent.body) intent.body.pairingChallenge = '';
          that._mutationIntent = null;
        }
        var challengeInvalid = intent.type === 'confirm'
          && result.code === 'PAIRING_CHALLENGE_INVALID';
        var terminalConfirm = intent.type === 'confirm' && [
          'PAIRING_EXPIRED', 'PAIRING_LOCKED', 'PAIRING_NOT_FOUND',
          'CONSENT_REQUIRED', 'PROCESSING_BLOCKED', 'CHILD_PROCESSING_BLOCKED'
        ].indexOf(result.code) >= 0;
        if (challengeInvalid) {
          that._pairingChallenge = '';
          that.setData({ pairing: null, shortCode: '', canRetryCreate: true });
        } else if (terminalConfirm) {
          var failedMarker = that._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent;
          if (failedMarker && failedMarker.key) that.clearPairingRecovery(failedMarker.key);
          that._pairingChallenge = '';
          that.setData({ pairing: null, shortCode: '', canRetryCreate: false });
        }
        that.setData({
          operating: false,
          canRetryMutation: ambiguous && !challengeInvalid,
          errorText: challengeInvalid
            ? '家长确认凭据已失效，请按原生成请求恢复配对状态'
            : viewModel.errorMessage(result, '设备操作失败')
        });
        if (!ambiguous && result.code === 'REVISION_CONFLICT') {
          if (intent.type === 'confirm') that.refreshPairing();
          else that.loadDevicesOnly();
        }
        return;
      }
      if (intent.type === 'confirm') {
        var confirmedPairing = result.data && result.data.pairing;
        var currentChildId = that.data.pairing && that.data.pairing.childId;
        if (!validPairingDto(confirmedPairing, currentChildId, intent.id)
            || ['confirmed', 'completed'].indexOf(confirmedPairing.status) < 0) {
          that.setData({
            operating: false,
            canRetryMutation: true,
            errorText: '确认响应不完整，结果暂无法确认；请重试同一次设备操作'
          });
          return;
        }
      } else if (intent.type === 'device') {
        if (!validRevokedDevice(
          result.data && result.data.device, intent.id, intent.body.expectedRevision
        )) {
          that.setData({
            operating: false,
            canRetryMutation: true,
            errorText: '设备撤销响应不完整，结果暂无法确认；请重试同一次设备操作'
          });
          return;
        }
      } else if (!validRevokedSession(
        result.data && result.data.session, intent.id, intent.body.expectedRevision
      )) {
        that.setData({
          operating: false,
          canRetryMutation: true,
          errorText: '会话撤销响应不完整，结果暂无法确认；请重试同一次设备操作'
        });
        return;
      }
      if (intent.body) intent.body.pairingChallenge = '';
      that._mutationIntent = null;
      if (intent.type === 'confirm') {
        that._pairingChallenge = '';
        var marker = that._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent;
        if (marker && marker.key) that.clearPairingRecovery(marker.key);
      } else if (intent.type === 'device' && that.data.pairing
          && that.data.pairing.claimedDevice
          && that.data.pairing.claimedDevice.id === intent.id) {
        var deviceMarker = that._pairingCreateIntent || app.globalData.guardianDeviceCreateIntent;
        if (deviceMarker && deviceMarker.key) that.clearPairingRecovery(deviceMarker.key);
        that._pairingChallenge = '';
        that.setData({ pairing: null, shortCode: '' });
      }
      that.setData({
        operating: false,
        canRetryMutation: false,
        shortCode: intent.type === 'confirm' ? '' : that.data.shortCode,
        pairing: intent.type === 'confirm'
          ? pairingView(result.data && result.data.pairing) : that.data.pairing
      });
      that.loadDevicesOnly();
    });
  }
});
