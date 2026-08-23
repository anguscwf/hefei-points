var PRIVACY_LABELS = {
  suspended_pending_consent: '等待监护授权',
  active: '授权有效',
  processing_blocked: '已阻断处理',
  deletion_pending: '删除政策处理中',
  deidentified: '已去标识化',
  deleted: '已删除'
};

var CONSENT_LABELS = {
  active: '有效',
  withdrawn: '已撤回',
  superseded: '已更新'
};

var POINT_STATUS_LABELS = {
  pending: '待确认',
  needs_info: '待孩子补充',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已取消'
};

var RIGHTS_TYPE_LABELS = {
  access: '查阅儿童资料',
  export: '导出儿童资料',
  correct: '更正儿童别名',
  delete: '申请删除儿童资料',
  terminate: '终止儿童服务',
  withdraw: '撤回监护授权'
};

var RIGHTS_STATUS_LABELS = {
  requested: '已提交',
  verified: '已验证',
  processing: '处理中',
  completed: '已完成',
  rejected: '未受理'
};

var ERROR_MESSAGES = {
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
  FORBIDDEN_SCOPE: '当前账号不能执行这项操作',
  FEATURE_DISABLED: '此功能仍在封闭预发布，暂未开放',
  PROCESSING_BLOCKED: '儿童资料处理已被阻断',
  CHILD_PROCESSING_BLOCKED: '儿童资料处理已被阻断',
  CONSENT_REQUIRED: '当前监护授权无效，请先完成授权',
  REAUTH_REQUIRED: '账号验证已失效，请重新输入密码',
  REVISION_CONFLICT: '状态已变化，已为你刷新',
  LEGAL_TEXT_VERSION_MISMATCH: '法律文本已有新版本，请重新阅读并确认',
  LEGAL_TEXTS_UNAVAILABLE: '公开法律文本尚未配置完整',
  PAIRING_EXPIRED: '配对码已过期，请重新生成',
  PAIRING_LOCKED: '配对已锁定，请稍后重新生成',
  PAIRING_CHALLENGE_INVALID: '本次家长确认已失效，请重新生成配对码',
  PAIRING_NOT_FOUND: '配对记录不存在或不可见',
  POINT_REQUEST_NOT_FOUND: '申请不存在或不可见',
  POINT_REQUEST_STATE_CONFLICT: '申请状态已变化，已为你刷新',
  RULE_AMOUNT_OUT_OF_RANGE: '调整后的分值超出规则范围',
  CORRECTION_CONFLICT: '儿童别名或状态已变化，请刷新后重试',
  DESTRUCTIVE_REQUEST_IN_PROGRESS: '已有删除或终止服务请求正在处理',
  DATA_EXPORT_NOT_READY: '本次请求尚不能查阅或导出',
  DATA_EXPORT_EXPIRED: '本次查阅授权已过期，请重新申请',
  NETWORK_ERROR: '网络连接失败，请检查后重试',
  REQUEST_TIMEOUT: '请求超时，请稍后重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  STALE_SESSION_RESPONSE: '登录账号已变化，旧请求结果已丢弃'
};

function text(value) {
  return typeof value === 'string' ? value : '';
}

function dateTime(value) {
  var parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) return '';
  var date = new Date(parsed);
  function pad(number) { return String(number).padStart(2, '0'); }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function tone(status) {
  if (status === 'active' || status === 'approved' || status === 'completed') return 'success';
  if (status === 'withdrawn' || status === 'rejected' || status === 'revoked') return 'danger';
  if (status === 'pending' || status === 'requested' || status === 'verified'
      || status === 'processing' || status === 'needs_info'
      || status === 'processing_blocked' || status === 'deletion_pending'
      || status === 'suspended_pending_consent') return 'warning';
  return 'neutral';
}

function errorMessage(result, fallback) {
  if (result && ERROR_MESSAGES[result.code]) return ERROR_MESSAGES[result.code];
  if (result && typeof result.message === 'string' && result.message.length <= 120) {
    return result.message;
  }
  return fallback || '操作未完成，请稍后重试';
}

function isOutcomeUnknown(result) {
  return !!(result && (result.outcomeUnknown
    || result.code === 'NETWORK_ERROR'
    || result.code === 'REQUEST_TIMEOUT'));
}

function decorateChild(item) {
  item = item || {};
  var child = item.child || item;
  var state = item.privacyState || {};
  var consent = item.latestConsent || item.consent || {};
  return {
    id: text(child.id),
    alias: text(child.alias) || '未命名儿童',
    privacyState: state,
    privacyLabel: PRIVACY_LABELS[state.status] || '状态待确认',
    privacyTone: tone(state.status),
    revision: Number(state.revision) || 0,
    consent: consent,
    consentLabel: CONSENT_LABELS[consent.status] || '无有效授权',
    canReconsent: ['active', 'suspended_pending_consent', 'processing_blocked']
      .indexOf(state.status) >= 0,
    updatedText: dateTime(state.updatedAt || consent.createdAt)
  };
}

function decorateDevice(item) {
  item = item || {};
  var sessions = Array.isArray(item.sessions) ? item.sessions.map(function(session) {
    var sessionLabels = {
      active: '会话有效', rotated: '会话已轮换', revoked: '会话已撤销'
    };
    return Object.assign({}, session, {
      statusLabel: sessionLabels[session.status] || '会话状态待确认',
      tone: tone(session.status),
      expiresText: dateTime(session.refreshExpiresAt || session.accessExpiresAt)
    });
  }) : [];
  return Object.assign({}, item, {
    statusLabel: item.status === 'active' ? '设备有效'
      : (item.status === 'pending' ? '等待家长确认' : '设备已撤销'),
    tone: tone(item.status),
    fingerprint: item.publicKey && text(item.publicKey.sha256)
      ? text(item.publicKey.sha256).slice(0, 12) + '…' : '未提供',
    sessions: sessions
  });
}

function decoratePointRequest(item) {
  item = item || {};
  var rule = item.rule || {};
  return Object.assign({}, item, {
    statusLabel: POINT_STATUS_LABELS[item.status] || '状态待确认',
    tone: tone(item.status),
    submittedText: dateTime(item.submittedAt),
    ruleRange: String(rule.minPoints || 1) + '～' + String(rule.maxPoints || 1000),
    canDecide: item.status === 'pending' || item.status === 'needs_info',
    canApprove: item.status === 'pending',
    canRequestInfo: item.status === 'pending',
    canReject: item.status === 'pending' || item.status === 'needs_info'
  });
}

function validPointRequestDto(item, expectedId) {
  var rule = item && item.rule;
  var child = item && item.child;
  return !!item && nonEmptyText(item.id) && (!expectedId || item.id === expectedId)
    && Object.prototype.hasOwnProperty.call(POINT_STATUS_LABELS, item.status)
    && Number.isSafeInteger(item.revision) && item.revision >= 0
    && !!child && nonEmptyText(child.id) && typeof child.alias === 'string'
    && !!rule && nonEmptyText(rule.id) && nonEmptyText(rule.categoryId)
    && typeof rule.label === 'string' && typeof rule.categoryLabel === 'string'
    && typeof rule.unit === 'string' && Number.isSafeInteger(rule.revision) && rule.revision >= 0
    && Number.isFinite(rule.minPoints) && Number.isFinite(rule.defaultPoints)
    && Number.isFinite(rule.maxPoints) && rule.minPoints <= rule.defaultPoints
    && rule.defaultPoints <= rule.maxPoints
    && Number.isFinite(item.requestedPoints) && typeof item.description === 'string'
    && validTime(item.occurredAt) && validTime(item.submittedAt) && validTime(item.updatedAt);
}

function validTaskSummary(summary) {
  return !!summary && Number.isSafeInteger(summary.pending) && summary.pending >= 0
    && Number.isSafeInteger(summary.needsInfo) && summary.needsInfo >= 0
    && Number.isSafeInteger(summary.total) && summary.total >= 0
    && summary.total === summary.pending + summary.needsInfo;
}

function validPointMutationDto(item, options) {
  options = options || {};
  var expectedStatus = {
    approve: 'approved',
    reject: 'rejected',
    request_info: 'needs_info'
  }[options.action];
  return !!expectedStatus
    && validPointRequestDto(item, options.requestId)
    && item.status === expectedStatus
    && Number.isSafeInteger(options.expectedRevision)
    && item.revision === options.expectedRevision + 1
    && (options.action !== 'approve'
      || item.approvedPoints === options.approvedPoints);
}

function decorateRightsRequest(item) {
  item = item || {};
  var deletion = item.deletion || {};
  var isPolicyPending = item.retentionDecision === 'policy_pending'
    || deletion.status === 'blocked_policy';
  return Object.assign({}, item, {
    typeLabel: RIGHTS_TYPE_LABELS[item.requestType] || '儿童资料请求',
    statusLabel: isPolicyPending ? '已受理，留存政策待确认'
      : (RIGHTS_STATUS_LABELS[item.status] || '状态待确认'),
    tone: isPolicyPending ? 'warning' : tone(item.status),
    requestedText: dateTime(item.requestedAt),
    canReadExport: ['access', 'export'].indexOf(item.requestType) >= 0
      && item.status === 'completed',
    readActionLabel: item.requestType === 'export'
      ? '查看本次导出快照（暂不外发）' : '本次查阅'
  });
}

function exportSummary(dataExport) {
  dataExport = dataExport || {};
  var account = dataExport.pointAccount || {};
  return {
    generatedText: dateTime(dataExport.generatedAt),
    childAlias: dataExport.child && text(dataExport.child.alias),
    privacyLabel: PRIVACY_LABELS[dataExport.privacyState && dataExport.privacyState.status]
      || '状态待确认',
    balance: dataExport.pointAccount === null ? '无积分账户' : (Number(account.balance) || 0),
    transactionCount: Array.isArray(dataExport.transactions) ? dataExport.transactions.length : 0,
    requestCount: Array.isArray(dataExport.pointRequests) ? dataExport.pointRequests.length : 0,
    deviceCount: Array.isArray(dataExport.deviceBindings) ? dataExport.deviceBindings.length : 0,
    consentCount: Array.isArray(dataExport.guardianConsents) ? dataExport.guardianConsents.length : 0
  };
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

function validTime(value) {
  return nonEmptyText(value) && Number.isFinite(Date.parse(value));
}

function plainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validLegalEvidence(evidence) {
  return !!evidence && nonEmptyText(evidence.version)
    && typeof evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256);
}

function validPrivacyStateDto(state, minimumRevision, maximumRevision, allowedStatuses) {
  return !!state && Object.prototype.hasOwnProperty.call(PRIVACY_LABELS, state.status)
    && (!allowedStatuses || allowedStatuses.indexOf(state.status) >= 0)
    && Number.isSafeInteger(state.revision) && state.revision >= 0
    && (minimumRevision === undefined || state.revision >= minimumRevision)
    && (maximumRevision === undefined || state.revision <= maximumRevision)
    && validTime(state.updatedAt);
}

function validConsentDto(consent, expectedChildId, expectedStatus) {
  var legalKeys = [
    'privacyPolicy', 'childPersonalInformationRules',
    'childUserAgreement', 'sensitiveInformationNotice'
  ];
  var consentedAtKeys = [
    'privacy', 'childRules', 'childUserAgreement', 'sensitiveInformation'
  ];
  return !!consent && nonEmptyText(consent.id) && consent.childId === expectedChildId
    && Number.isSafeInteger(consent.version) && consent.version > 0
    && consent.status === expectedStatus
    && Number.isSafeInteger(consent.lifecycleRevision) && consent.lifecycleRevision >= 0
    && nonEmptyText(consent.guardianRelation)
    && validLegalEvidence(consent.relationDeclaration)
    && plainObject(consent.legalTexts)
    && legalKeys.every(function(key) { return validLegalEvidence(consent.legalTexts[key]); })
    && plainObject(consent.consentScope)
    && consent.consentScope.childProfile === true
    && consent.consentScope.pointsLedger === true
    && consent.consentScope.pointRequests === true
    && consent.consentScope.sensitiveInformationNotice === true
    && typeof consent.consentScope.optionalPhoto === 'boolean'
    && plainObject(consent.visibilityScope)
    && consent.visibilityScope.guardian === 'full'
    && consent.visibilityScope.familyAdults === 'none'
    && consent.visibilityScope.childDevice === 'self_only'
    && plainObject(consent.consentedAt)
    && consentedAtKeys.every(function(key) { return validTime(consent.consentedAt[key]); })
    && validTime(consent.verifiedAt) && validTime(consent.createdAt)
    && (expectedStatus !== 'withdrawn' || validTime(consent.withdrawnAt));
}

function validConsentMutationResponse(payload, options) {
  options = options || {};
  var consent = payload && payload.consent;
  var state = payload && payload.privacyState;
  var kind = options.kind;
  var childId = kind === 'enroll'
    ? payload && payload.child && payload.child.id : options.childId;
  if (!nonEmptyText(childId)) return false;
  if (!validConsentDto(consent, childId, kind === 'withdraw' ? 'withdrawn' : 'active')) {
    return false;
  }
  if (kind === 'enroll') {
    return payload.child.alias === options.alias
      && payload.child.privacyStatus === 'active'
      && validTime(payload.child.createdAt)
      && validPrivacyStateDto(state, 1, 1, ['active']);
  }
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) return false;
  if (kind === 'withdraw') {
    if (options.previousPrivacyStatus === 'active') {
      return validPrivacyStateDto(
        state,
        options.expectedRevision + 1,
        options.expectedRevision + 1,
        ['processing_blocked']
      );
    }
    if (['processing_blocked', 'deletion_pending'].indexOf(options.previousPrivacyStatus) >= 0) {
      return validPrivacyStateDto(
        state,
        options.expectedRevision,
        options.expectedRevision,
        [options.previousPrivacyStatus]
      );
    }
    return false;
  }
  if (kind !== 'reconsent') return false;
  if (options.previousPrivacyStatus === 'active'
      || options.previousPrivacyStatus === 'suspended_pending_consent') {
    return validPrivacyStateDto(
      state,
      options.expectedRevision + 1,
      options.expectedRevision + 1,
      ['active']
    );
  }
  if (options.previousPrivacyStatus === 'processing_blocked') {
    return (state.status === 'processing_blocked' && state.revision === options.expectedRevision
        || state.status === 'active' && state.revision === options.expectedRevision + 1)
      && validPrivacyStateDto(state);
  }
  return false;
}

function validRightsMutationDto(request, options) {
  options = options || {};
  var destructive = options.requestType === 'delete' || options.requestType === 'terminate';
  var expectedStatus = destructive ? 'processing' : 'completed';
  var valid = !!request && nonEmptyText(request.id) && request.childId === options.childId
    && request.requestType === options.requestType && request.status === expectedStatus
    && Number.isSafeInteger(request.revision) && request.revision >= 0
    && validTime(request.requestedAt) && validTime(request.updatedAt)
    && request.receipt && nonEmptyText(request.receipt.code)
    && typeof request.receipt.message === 'string';
  if (!valid) return false;
  if (!destructive) {
    return request.retentionDecision === 'not_applicable' && validTime(request.completedAt);
  }
  return request.retentionDecision === 'policy_pending'
    && validTime(request.processingStartedAt)
    && request.deletion && request.deletion.status === 'blocked_policy'
    && request.deletion.retentionDecision === 'policy_pending'
    && nonEmptyText(request.deletion.blockedReason)
    && validTime(request.deletion.requestedAt) && validTime(request.deletion.updatedAt);
}

function validExportSnapshot(dataExport, childId, requestId) {
  var arrays = [
    'guardianConsents', 'deviceBindings', 'deviceSessions', 'transactions',
    'pointRequests', 'dataRightsRequests', 'auditEvents'
  ];
  var legalKeys = [
    'privacyPolicy', 'childPersonalInformationRules',
    'childUserAgreement', 'sensitiveInformationNotice'
  ];
  var valid = !!dataExport && dataExport.schemaVersion === '1.0'
    && dataExport.authorizedByRequestId === requestId
    && validTime(dataExport.generatedAt)
    && dataExport.child && dataExport.child.id === childId
    && typeof dataExport.child.alias === 'string'
    && dataExport.privacyState
    && Object.prototype.hasOwnProperty.call(PRIVACY_LABELS, dataExport.privacyState.status)
    && Number.isSafeInteger(dataExport.privacyState.revision)
    && (dataExport.pointAccount === null
      || (dataExport.pointAccount && Number.isFinite(dataExport.pointAccount.balance)))
    && arrays.every(function(key) { return Array.isArray(dataExport[key]); })
    && dataExport.retentionNotice
    && typeof dataExport.retentionNotice.deletionExecutionEnabled === 'boolean'
    && typeof dataExport.retentionNotice.immutableEvidenceRetained === 'boolean'
    && typeof dataExport.retentionNotice.reason === 'string';
  if (!valid) return false;
  return dataExport.guardianConsents.every(function(item) {
    return !!item && nonEmptyText(item.id) && Number.isSafeInteger(item.version) && item.version > 0
      && Object.prototype.hasOwnProperty.call(CONSENT_LABELS, item.status)
      && nonEmptyText(item.guardianRelation) && validTime(item.verifiedAt)
      && validTime(item.createdAt) && item.legalTexts
      && legalKeys.every(function(key) {
        var evidence = item.legalTexts[key];
        return !!evidence && nonEmptyText(evidence.version)
          && typeof evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256);
      }) && item.consentScope && item.visibilityScope && item.consentedAt;
  }) && dataExport.deviceBindings.every(function(item) {
    return !!item && nonEmptyText(item.id) && typeof item.label === 'string'
      && ['pending', 'active', 'revoked'].indexOf(item.status) >= 0
      && validTime(item.createdAt);
  }) && dataExport.deviceSessions.every(function(item) {
    return !!item && nonEmptyText(item.id) && nonEmptyText(item.deviceBindingId)
      && ['active', 'rotated', 'revoked'].indexOf(item.status) >= 0
      && validTime(item.issuedAt) && validTime(item.accessExpiresAt)
      && validTime(item.refreshExpiresAt);
  }) && dataExport.transactions.every(function(item) {
    return !!item && nonEmptyText(item.id) && validTime(item.occurredAt)
      && typeof item.childAliasSnapshot === 'string' && Number.isFinite(item.amount)
      && typeof item.reason === 'string' && typeof item.note === 'string';
  }) && dataExport.pointRequests.every(function(item) {
    return !!item && nonEmptyText(item.id)
      && Object.prototype.hasOwnProperty.call(POINT_STATUS_LABELS, item.status)
      && Number.isSafeInteger(item.revision) && item.revision >= 0
      && Number.isFinite(item.requestedPoints) && typeof item.description === 'string'
      && validTime(item.submittedAt) && item.rule && nonEmptyText(item.rule.id)
      && nonEmptyText(item.rule.categoryId) && Number.isSafeInteger(item.rule.revision)
      && Number.isFinite(item.rule.minPoints) && Number.isFinite(item.rule.defaultPoints)
      && Number.isFinite(item.rule.maxPoints);
  }) && dataExport.dataRightsRequests.every(function(item) {
    return !!item && nonEmptyText(item.id)
      && Object.prototype.hasOwnProperty.call(RIGHTS_TYPE_LABELS, item.requestType)
      && Object.prototype.hasOwnProperty.call(RIGHTS_STATUS_LABELS, item.status)
      && Number.isSafeInteger(item.revision) && item.revision >= 0
      && validTime(item.requestedAt);
  }) && dataExport.auditEvents.every(function(item) {
    return !!item && nonEmptyText(item.id) && nonEmptyText(item.resourceType)
      && nonEmptyText(item.resourceId) && nonEmptyText(item.eventType)
      && Number.isSafeInteger(item.resultRevision) && item.resultRevision >= 0
      && validTime(item.createdAt) && item.eventData
      && Object.prototype.toString.call(item.eventData) === '[object Object]';
  });
}

function validRightsDetail(item, requestId) {
  return !!item && item.id === requestId && typeof item.childId === 'string' && item.childId
    && Object.prototype.hasOwnProperty.call(RIGHTS_TYPE_LABELS, item.requestType)
    && Object.prototype.hasOwnProperty.call(RIGHTS_STATUS_LABELS, item.status)
    && Number.isSafeInteger(item.revision) && item.revision >= 0
    && Array.isArray(item.auditTrail);
}

function scalarFields(source, fields) {
  source = source || {};
  var output = {};
  fields.forEach(function(key) {
    var value = source[key];
    if (value === null || typeof value === 'string'
        || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    }
  });
  return output;
}

function safeExportSnapshot(dataExport) {
  dataExport = dataExport || {};
  var legalKeys = [
    'privacyPolicy', 'childPersonalInformationRules',
    'childUserAgreement', 'sensitiveInformationNotice'
  ];
  var consents = Array.isArray(dataExport.guardianConsents)
    ? dataExport.guardianConsents.map(function(item) {
        var output = scalarFields(item, [
          'id', 'version', 'status', 'guardianRelation', 'verifiedAt',
          'withdrawnAt', 'supersededAt', 'createdAt'
        ]);
        output.legalTexts = {};
        legalKeys.forEach(function(key) {
          output.legalTexts[key] = scalarFields(item.legalTexts && item.legalTexts[key], [
            'version', 'sha256'
          ]);
        });
        output.consentScope = scalarFields(item.consentScope, [
          'childProfile', 'pointsLedger', 'pointRequests',
          'sensitiveInformationNotice', 'optionalPhoto'
        ]);
        output.visibilityScope = scalarFields(item.visibilityScope, [
          'guardian', 'familyAdults', 'childDevice'
        ]);
        output.consentedAt = scalarFields(item.consentedAt, [
          'privacy', 'childRules', 'childUserAgreement', 'sensitiveInformation'
        ]);
        return output;
      }) : [];
  var pointRequests = Array.isArray(dataExport.pointRequests)
    ? dataExport.pointRequests.map(function(item) {
        var output = scalarFields(item, [
          'id', 'status', 'revision', 'childAliasSnapshot', 'requestedPoints',
          'approvedPoints', 'description', 'occurredAt', 'duplicateSuspected',
          'submittedAt', 'updatedAt'
        ]);
        output.rule = scalarFields(item.rule, [
          'id', 'categoryId', 'revision', 'label', 'categoryLabel', 'unit',
          'minPoints', 'defaultPoints', 'maxPoints'
        ]);
        output.requestInfo = item.requestInfo ? scalarFields(item.requestInfo, [
          'note', 'requestedAt', 'resubmittedAt'
        ]) : null;
        output.decision = item.decision ? scalarFields(item.decision, [
          'note', 'reviewedAt', 'transactionId'
        ]) : null;
        return output;
      }) : [];
  var result = scalarFields(dataExport, [
    'schemaVersion', 'generatedAt', 'authorizedByRequestId'
  ]);
  result.child = scalarFields(dataExport.child, ['id', 'alias']);
  result.privacyState = scalarFields(dataExport.privacyState, [
    'status', 'revision', 'reasonCode', 'createdAt', 'updatedAt', 'activatedAt',
    'blockedAt', 'deletionRequestedAt', 'deletedAt'
  ]);
  result.pointAccount = dataExport.pointAccount
    ? scalarFields(dataExport.pointAccount, ['balance']) : null;
  result.guardianConsents = consents;
  result.deviceBindings = Array.isArray(dataExport.deviceBindings)
    ? dataExport.deviceBindings.map(function(item) {
        return scalarFields(item, [
          'id', 'label', 'status', 'createdAt', 'activatedAt', 'revokedAt', 'reason'
        ]);
      }) : [];
  result.deviceSessions = Array.isArray(dataExport.deviceSessions)
    ? dataExport.deviceSessions.map(function(item) {
        return scalarFields(item, [
          'id', 'deviceBindingId', 'status', 'issuedAt', 'accessExpiresAt',
          'refreshExpiresAt', 'lastUsedAt', 'rotatedAt', 'revokedAt', 'reason'
        ]);
      }) : [];
  result.transactions = Array.isArray(dataExport.transactions)
    ? dataExport.transactions.map(function(item) {
        return scalarFields(item, [
          'id', 'occurredAt', 'childAliasSnapshot', 'amount', 'reason', 'note',
          'ruleId', 'categoryId', 'deletedAt', 'sourceType', 'sourceId'
        ]);
      }) : [];
  result.pointRequests = pointRequests;
  result.dataRightsRequests = Array.isArray(dataExport.dataRightsRequests)
    ? dataExport.dataRightsRequests.map(function(item) {
        return scalarFields(item, [
          'id', 'requestType', 'status', 'revision', 'retentionDecision',
          'resultReceiptCode', 'resultReceiptMessage', 'requestedAt',
          'processingStartedAt', 'completedAt', 'rejectedAt', 'updatedAt'
        ]);
      }) : [];
  result.auditEvents = Array.isArray(dataExport.auditEvents)
    ? dataExport.auditEvents.map(function(item) {
        var output = scalarFields(item, [
          'id', 'resourceType', 'resourceId', 'eventType', 'fromStatus',
          'toStatus', 'resultRevision', 'createdAt'
        ]);
        output.eventData = scalarFields(item.eventData, [
          'requestType', 'resultCode', 'privacyRevision', 'changedField',
          'deletionJobId', 'retentionDecision'
        ]);
        return output;
      }) : [];
  result.retentionNotice = scalarFields(dataExport.retentionNotice, [
    'deletionExecutionEnabled', 'immutableEvidenceRetained', 'reason'
  ]);
  return result;
}

function exportSections(dataExport) {
  var safe = safeExportSnapshot(dataExport);
  var sections = [
    { key: 'metadata', title: '快照信息', value: scalarFields(safe, [
      'schemaVersion', 'generatedAt', 'authorizedByRequestId'
    ]) },
    { key: 'child', title: '儿童档案', value: safe.child },
    { key: 'privacyState', title: '隐私状态', value: safe.privacyState },
    { key: 'pointAccount', title: '积分账户', value: safe.pointAccount },
    { key: 'guardianConsents', title: '本人监护授权', value: safe.guardianConsents },
    { key: 'deviceBindings', title: '设备绑定', value: safe.deviceBindings },
    { key: 'deviceSessions', title: '设备会话', value: safe.deviceSessions },
    { key: 'transactions', title: '积分流水', value: safe.transactions },
    { key: 'pointRequests', title: '积分申请', value: safe.pointRequests },
    { key: 'dataRightsRequests', title: '资料权利请求', value: safe.dataRightsRequests },
    { key: 'auditEvents', title: '处理审计事件', value: safe.auditEvents },
    { key: 'retentionNotice', title: '留存说明', value: safe.retentionNotice }
  ];
  return sections.map(function(section) {
    return { key: section.key, title: section.title, json: JSON.stringify(section.value, null, 2) };
  });
}

function decorateRightsDetail(item) {
  var safe = scalarFields(item, [
    'id', 'childId', 'requestType', 'status', 'revision', 'retentionDecision',
    'requestedAt', 'processingStartedAt', 'completedAt', 'rejectedAt', 'updatedAt'
  ]);
  var decorated = decorateRightsRequest(safe);
  var retentionLabels = {
    not_applicable: '不适用额外留存裁决',
    policy_pending: '正式留存政策待确认'
  };
  decorated.retentionLabel = retentionLabels[item && item.retentionDecision] || '尚无留存决定';
  decorated.receipt = item && item.receipt ? scalarFields(item.receipt, ['code', 'message']) : null;
  decorated.deletion = item && item.deletion ? scalarFields(item.deletion, [
    'status', 'retentionDecision', 'blockedReason', 'requestedAt', 'updatedAt'
  ]) : null;
  decorated.completedText = dateTime(item && (item.completedAt || item.updatedAt));
  decorated.auditTrail = Array.isArray(item && item.auditTrail)
    ? item.auditTrail.map(function(event) {
        return {
          eventType: text(event.eventType) || '状态事件',
          statusText: (text(event.fromStatus) || '开始') + ' → ' + (text(event.toStatus) || '未标记'),
          revision: Number(event.revision) || 0,
          createdText: dateTime(event.createdAt),
          resultText: JSON.stringify(scalarFields(event.result, [
            'requestType', 'resultCode', 'privacyRevision', 'changedField',
            'deletionJobId', 'retentionDecision'
          ]))
        };
      }) : [];
  return decorated;
}

module.exports = {
  ERROR_MESSAGES: ERROR_MESSAGES,
  RIGHTS_TYPE_LABELS: RIGHTS_TYPE_LABELS,
  dateTime: dateTime,
  errorMessage: errorMessage,
  isOutcomeUnknown: isOutcomeUnknown,
  decorateChild: decorateChild,
  decorateDevice: decorateDevice,
  decoratePointRequest: decoratePointRequest,
  validPointRequestDto: validPointRequestDto,
  validPointMutationDto: validPointMutationDto,
  validTaskSummary: validTaskSummary,
  validConsentMutationResponse: validConsentMutationResponse,
  validRightsMutationDto: validRightsMutationDto,
  decorateRightsRequest: decorateRightsRequest,
  decorateRightsDetail: decorateRightsDetail,
  exportSummary: exportSummary,
  validExportSnapshot: validExportSnapshot,
  validRightsDetail: validRightsDetail,
  safeExportSnapshot: safeExportSnapshot,
  exportSections: exportSections
};
