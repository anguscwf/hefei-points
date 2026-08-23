const crypto = require('crypto');

const features = require('../config/features');
const { inReadTransaction, inTransaction } = require('../db/connection');
const repositories = require('../db/repositories');
const { ApiError } = require('../lib/api-error');
const credentials = require('../lib/device-credentials');
const { isPlainObject } = require('../lib/validation');
const devicePairingSessions = require('./device-pairing-sessions');

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const REQUEST_ID = /^data_rights_[a-f0-9]{32}$/;
const CHILD_ID = /^[A-Za-z0-9_-]{2,64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PUBLIC_REQUEST_TYPES = new Set(['access', 'export', 'correct', 'delete', 'terminate']);
const STORED_REQUEST_TYPES = new Set([...PUBLIC_REQUEST_TYPES, 'withdraw']);
const REQUEST_STATUSES = new Set(['requested', 'verified', 'processing', 'completed', 'rejected']);
const DESTRUCTIVE_TYPES = new Set(['delete', 'terminate']);
const REAUTH_PURPOSES = Object.freeze({
  access: 'child_data_access',
  export: 'child_data_export',
  correct: 'child_data_correct',
  delete: 'child_data_delete',
  terminate: 'child_service_terminate',
  withdraw: 'child_consent_withdraw'
});
const RECEIPTS = Object.freeze({
  access: {
    code: 'ACCESS_REQUEST_COMPLETED',
    message: '查阅请求已核验，可在授权时限内获取儿童数据副本'
  },
  export: {
    code: 'EXPORT_REQUEST_AUTHORIZED',
    message: '导出请求已核验，可在授权时限内获取儿童数据副本'
  },
  correct: {
    code: 'CORRECTION_APPLIED',
    message: '儿童当前别名已更正；历史账本与审批快照保持不变'
  },
  withdraw: {
    code: 'CONSENT_WITHDRAWN',
    message: '监护授权已撤回，相关处理与设备会话已阻断'
  },
  delete: {
    code: 'RETENTION_DECISION_REQUIRED',
    message: '删除请求已受理并阻断处理；留存规则获批前不会执行或宣称完成删除'
  },
  terminate: {
    code: 'RETENTION_DECISION_REQUIRED',
    message: '儿童服务终止请求已受理并阻断处理；留存规则获批前不会执行或宣称完成删除'
  }
});
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_VERSION = 1;
const EXPORT_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const EXPORT_CLOCK_SKEW_MS = 5 * 1000;

function fail(status, code, message, field) {
  throw new ApiError({ status, code, message, field });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return sha256(JSON.stringify(stable(value)));
}

function exactKeys(value, allowed, fieldPrefix = '') {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) {
    fail(400, 'VALIDATION_ERROR', '请求字段不受支持', fieldPrefix ? `${fieldPrefix}.${unknown}` : unknown);
  }
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    fail(400, 'VALIDATION_ERROR', `${field || '请求体'}必须是对象`, field);
  }
  return value;
}

function requireText(value, { field, min = 1, max = 300, pattern } = {}) {
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max || CONTROL_CHARACTERS.test(normalized)
      || (pattern && !pattern.test(normalized))) {
    fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  }
  return normalized;
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(400, 'REVISION_REQUIRED', 'expectedRevision 必须是非负整数', 'expectedRevision');
  }
  return value;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    fail(400, 'IDEMPOTENCY_REQUIRED', '请提供有效的 Idempotency-Key', 'Idempotency-Key');
  }
  return sha256(value);
}

function nextTimestamp(now, previous) {
  const candidate = now.toISOString();
  if (!previous || candidate > previous) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString();
}

function parseCreateBody(body) {
  requireObject(body);
  exactKeys(body, new Set(['requestType', 'expectedRevision', 'reauthAssertion', 'correction']));
  if (typeof body.requestType !== 'string' || !PUBLIC_REQUEST_TYPES.has(body.requestType)) {
    fail(400, 'DATA_RIGHTS_TYPE_UNSUPPORTED', '请求的数据权利类型暂不支持', 'requestType');
  }
  const input = {
    requestType: body.requestType,
    expectedRevision: requireRevision(body.expectedRevision),
    reauthAssertion: requireText(body.reauthAssertion, {
      field: 'reauthAssertion', min: 32, max: 256
    }),
    correction: null
  };
  if (input.requestType !== 'correct') {
    if (body.correction !== undefined) {
      fail(400, 'VALIDATION_ERROR', '当前请求类型不接受 correction', 'correction');
    }
    return input;
  }
  const correction = requireObject(body.correction, 'correction');
  exactKeys(correction, new Set(['target', 'field', 'expectedValue', 'value']), 'correction');
  if (correction.target !== 'child_profile' || correction.field !== 'alias') {
    fail(400, 'CORRECTION_TARGET_UNSUPPORTED', '首批仅支持更正儿童当前别名', 'correction');
  }
  const expectedValue = requireText(correction.expectedValue, {
    field: 'correction.expectedValue', max: 30
  });
  const value = requireText(correction.value, { field: 'correction.value', max: 30 });
  if (value === expectedValue) {
    fail(400, 'VALIDATION_ERROR', '更正后的别名必须发生变化', 'correction.value');
  }
  input.correction = { target: 'child_profile', field: 'alias', expectedValue, value };
  return input;
}

function assertCreationEnabled(requestType) {
  if (!DESTRUCTIVE_TYPES.has(requestType) && !features.isChildDataRightsEnabled()) {
    fail(403, 'FEATURE_DISABLED', '儿童数据查阅、导出与更正当前未开放');
  }
}

function validateEmptyBody(body) {
  if (body === undefined) return;
  requireObject(body);
  const key = Object.keys(body)[0];
  if (key) fail(400, 'VALIDATION_ERROR', '只读接口不接受请求体', key);
}

function validateQuery(query, allowed) {
  requireObject(query || {}, 'query');
  const unknown = Object.keys(query || {}).find(key => !allowed.has(key));
  if (unknown) fail(400, 'VALIDATION_ERROR', '查询参数不受支持', unknown);
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value) || Number(value) > MAX_LIMIT) {
    fail(400, 'VALIDATION_ERROR', 'limit 必须是 1 至 50 的整数', 'limit');
  }
  return Number(value);
}

function optionalFilter(value, { field, accepted, pattern }) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || (accepted && !accepted.has(value)) || (pattern && !pattern.test(value))) {
    fail(400, 'VALIDATION_ERROR', `${field}无效`, field);
  }
  return value;
}

function cursorKey() {
  return Buffer.from(credentials.hmac('data-rights-cursor-aead-key', `v${CURSOR_VERSION}`), 'hex');
}

function cursorAad(scope) {
  return Buffer.from(JSON.stringify([
    `tangguan-data-rights-cursor-v${CURSOR_VERSION}`,
    scope.familyId,
    scope.guardianId,
    scope.childId || '',
    scope.requestType || '',
    scope.status || ''
  ]), 'utf8');
}

function encodeCursor(request, scope) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cursorKey(), nonce);
  cipher.setAAD(cursorAad(scope));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify([request.requestedAt, request.id]), 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([
    Buffer.from([CURSOR_VERSION]), nonce, cipher.getAuthTag(), ciphertext
  ]).toString('base64url');
}

function decodeCursor(value, scope) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 40 || value.length > 400
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  const packet = Buffer.from(value, 'base64url');
  if (packet.toString('base64url') !== value || packet.length < 30 || packet[0] !== CURSOR_VERSION) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  let decoded;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cursorKey(), packet.subarray(1, 13));
    decipher.setAAD(cursorAad(scope));
    decipher.setAuthTag(packet.subarray(13, 29));
    decoded = JSON.parse(Buffer.concat([
      decipher.update(packet.subarray(29)), decipher.final()
    ]).toString('utf8'));
  } catch (_) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || !Number.isFinite(Date.parse(decoded[0]))
      || typeof decoded[1] !== 'string' || !REQUEST_ID.test(decoded[1])) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  return { requestedAt: decoded[0], id: decoded[1] };
}

function historicalScope(db, actor, childId) {
  const scope = repositories.dataRights.findHistoricalGuardianScope({
    familyId: actor.familyId,
    childId,
    guardianId: actor.id
  }, db);
  if (!scope) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
  return scope;
}

function consumeAssertion(db, { actor, rawToken, requestType, now }) {
  const assertion = repositories.guardianConsents.consumeReauth({
    familyId: actor.familyId,
    userId: actor.id,
    purpose: REAUTH_PURPOSES[requestType],
    tokenHash: sha256(rawToken),
    consumedAt: now.toISOString()
  }, db);
  if (!assertion) fail(403, 'REAUTH_REQUIRED', '重新认证凭据无效、用途不符或已过期');
  return assertion;
}

function findIdempotencyReplay(db, { actor, keyHash, requestFingerprint }) {
  const record = repositories.guardianConsents.findIdempotency({
    familyId: actor.familyId,
    actorUserId: actor.id,
    operation: 'data_rights_request_create',
    idempotencyKey: keyHash
  }, db);
  if (!record) return null;
  if (record.requestFingerprint !== requestFingerprint) {
    fail(409, 'IDEMPOTENCY_CONFLICT', '该幂等键已用于不同请求');
  }
  if (record.status !== 'completed') {
    fail(409, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理中');
  }
  if (record.resourceType !== 'data_rights_request') {
    fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '数据权利请求幂等结果不可用');
  }
  const request = repositories.dataRights.findOwnRequest({
    familyId: actor.familyId,
    guardianId: actor.id,
    requestId: record.resourceId
  }, db);
  if (!request) fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '数据权利请求幂等结果不可用');
  return request;
}

function startIdempotency(db, { actor, keyHash, requestFingerprint, now }) {
  const id = crypto.randomUUID();
  repositories.guardianConsents.startIdempotency({
    id,
    familyId: actor.familyId,
    actorUserId: actor.id,
    operation: 'data_rights_request_create',
    idempotencyKey: keyHash,
    requestFingerprint,
    createdAt: now.toISOString()
  }, db);
  return id;
}

function completeIdempotency(db, { id, request, responseStatus, now }) {
  const completed = repositories.guardianConsents.completeIdempotency({
    id,
    resourceType: 'data_rights_request',
    resourceId: request.id,
    resultRevision: request.revision,
    responseStatus,
    completedAt: nextTimestamp(now, request.updatedAt)
  }, db);
  if (!completed) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等请求状态已变化');
}

function auditEvent(db, request, {
  eventType, fromStatus, toStatus, resultRevision, eventData, createdAt
}) {
  return repositories.dataRights.insertAuditEvent({
    id: crypto.randomUUID(),
    familyId: request.familyId,
    childId: request.childId,
    actorUserId: request.guardianId,
    requestId: request.id,
    eventType,
    fromStatus,
    toStatus,
    resultRevision,
    eventData,
    createdAt
  }, db);
}

function beginRecordedRequest(db, {
  actor, childId, requestType, consent, assertion, requestFingerprint,
  requestPayload = {}, now, dataRightsRequestId
}) {
  const requestedAt = now.toISOString();
  const draft = {
    id: dataRightsRequestId || `data_rights_${crypto.randomUUID().replace(/-/g, '')}`,
    familyId: actor.familyId,
    childId,
    guardianId: actor.id,
    requestType
  };
  auditEvent(db, draft, {
    eventType: 'data_rights_requested',
    fromStatus: null,
    toStatus: 'requested',
    resultRevision: 0,
    eventData: { requestType },
    createdAt: requestedAt
  });
  let request = repositories.dataRights.insertRequest({
    ...draft,
    sourceConsentId: consent.id,
    reauthAssertionId: assertion.id,
    verificationMethod: assertion.verificationMethod,
    verifiedAt: assertion.consumedAt,
    requestFingerprint,
    requestPayload,
    requestedAt
  }, db);
  const verifiedAt = nextTimestamp(now, request.updatedAt);
  auditEvent(db, request, {
    eventType: 'data_rights_verified',
    fromStatus: 'requested',
    toStatus: 'verified',
    resultRevision: 1,
    eventData: { requestType, resultCode: 'REAUTH_VERIFIED' },
    createdAt: verifiedAt
  });
  request = repositories.dataRights.transitionRequest({
    id: request.id,
    familyId: request.familyId,
    childId: request.childId,
    guardianId: request.guardianId,
    fromStatus: 'requested',
    toStatus: 'verified',
    expectedRevision: 0,
    updatedAt: verifiedAt
  }, db);
  if (!request) fail(409, 'DATA_RIGHTS_STATE_CONFLICT', '数据权利请求状态已变化');
  return request;
}

function completeRecordedRequest(db, request, {
  now, receipt, privacyRevision, changedField
}) {
  const completedAt = nextTimestamp(now, request.updatedAt);
  const eventData = {
    requestType: request.requestType,
    resultCode: receipt.code
  };
  if (privacyRevision !== undefined) eventData.privacyRevision = privacyRevision;
  if (changedField) eventData.changedField = changedField;
  auditEvent(db, request, {
    eventType: 'data_rights_completed',
    fromStatus: request.status,
    toStatus: 'completed',
    resultRevision: request.revision + 1,
    eventData,
    createdAt: completedAt
  });
  const completed = repositories.dataRights.transitionRequest({
    id: request.id,
    familyId: request.familyId,
    childId: request.childId,
    guardianId: request.guardianId,
    fromStatus: request.status,
    toStatus: 'completed',
    expectedRevision: request.revision,
    retentionDecision: 'not_applicable',
    resultReceiptCode: receipt.code,
    resultReceiptMessage: receipt.message,
    updatedAt: completedAt
  }, db);
  if (!completed) fail(409, 'DATA_RIGHTS_STATE_CONFLICT', '数据权利请求状态已变化');
  return completed;
}

function processDeletionRequest(db, { actor, scope, request, now }) {
  const receipt = RECEIPTS[request.requestType];
  const processingAt = nextTimestamp(now, request.updatedAt);
  const deletionJob = repositories.dataRights.insertBlockedDeletionJob({
    id: `data_deletion_${crypto.randomUUID().replace(/-/g, '')}`,
    familyId: request.familyId,
    childId: request.childId,
    requestId: request.id,
    requestedAt: processingAt
  }, db);
  const resultingPrivacyRevision = scope.privacyState.revision + 1;
  auditEvent(db, request, {
    eventType: 'data_rights_processing',
    fromStatus: 'verified',
    toStatus: 'processing',
    resultRevision: request.revision + 1,
    eventData: {
      requestType: request.requestType,
      resultCode: receipt.code,
      privacyRevision: resultingPrivacyRevision,
      deletionJobId: deletionJob.id,
      retentionDecision: 'policy_pending'
    },
    createdAt: processingAt
  });
  const privacyState = repositories.dataRights.markPrivacyDeletionPending({
    familyId: request.familyId,
    childId: request.childId,
    guardianId: actor.id,
    requestId: request.id,
    expectedRevision: scope.privacyState.revision,
    reasonCode: request.requestType === 'delete'
      ? 'data_rights_delete_requested'
      : 'data_rights_terminate_requested',
    requestedAt: processingAt
  }, db);
  if (!privacyState) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
  const processing = repositories.dataRights.transitionRequest({
    id: request.id,
    familyId: request.familyId,
    childId: request.childId,
    guardianId: request.guardianId,
    fromStatus: 'verified',
    toStatus: 'processing',
    expectedRevision: request.revision,
    retentionDecision: 'policy_pending',
    resultReceiptCode: receipt.code,
    resultReceiptMessage: receipt.message,
    updatedAt: processingAt
  }, db);
  if (!processing) fail(409, 'DATA_RIGHTS_STATE_CONFLICT', '数据权利请求状态已变化');
  const tokenFloor = repositories.dataRights.raiseLegacyTokenFloor({
    familyId: request.familyId,
    childId: request.childId,
    guardianId: actor.id,
    requestId: request.id,
    tokensValidAfter: Math.max(now.getTime(), Date.parse(processingAt))
  }, db);
  if (!tokenFloor) fail(409, 'DATA_RIGHTS_STATE_CONFLICT', '儿童凭据撤销状态已变化');
  devicePairingSessions.revokeForChild(db, {
    familyId: request.familyId,
    childId: request.childId,
    revokedAt: processingAt,
    reason: request.requestType === 'delete'
      ? 'data_rights_delete_requested'
      : 'data_rights_terminate_requested'
  });
  return processing;
}

function requestPayload(input) {
  if (!input.correction) return {};
  return {
    field: 'alias',
    expectedValueSha256: sha256(input.correction.expectedValue),
    newValueSha256: sha256(input.correction.value)
  };
}

function serializeDeletionJob(job) {
  if (!job) return null;
  return {
    status: job.status,
    retentionDecision: job.retentionDecision,
    blockedReason: job.blockedReason,
    requestedAt: job.requestedAt,
    updatedAt: job.updatedAt
  };
}

function serializeAuditEvent(event) {
  return {
    eventType: event.eventType,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    revision: event.resultRevision,
    result: event.eventData,
    createdAt: event.createdAt
  };
}

function serializeRequest(request, { deletionJob = null, events = null } = {}) {
  const output = {
    id: request.id,
    childId: request.childId,
    requestType: request.requestType,
    status: request.status,
    revision: request.revision,
    retentionDecision: request.retentionDecision,
    receipt: request.resultReceiptCode ? {
      code: request.resultReceiptCode,
      message: request.resultReceiptMessage
    } : null,
    requestedAt: request.requestedAt,
    processingStartedAt: request.processingStartedAt,
    completedAt: request.completedAt,
    rejectedAt: request.rejectedAt,
    updatedAt: request.updatedAt
  };
  if (request.requestType === 'correct') output.correction = { field: 'alias' };
  if (deletionJob) output.deletion = serializeDeletionJob(deletionJob);
  if (events) output.auditTrail = events.map(serializeAuditEvent);
  return output;
}

function resultForRequest(db, request, status) {
  const deletionJob = DESTRUCTIVE_TYPES.has(request.requestType)
    ? repositories.dataRights.findDeletionJobByRequest({
        familyId: request.familyId,
        childId: request.childId,
        requestId: request.id
      }, db)
    : null;
  return {
    status,
    body: {
      success: true,
      dataRightsRequest: serializeRequest(request, { deletionJob })
    }
  };
}

function createRequest({ actor, childId, body, idempotencyKey, now = new Date() }) {
  const input = parseCreateBody(body);
  assertCreationEnabled(input.requestType);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const payload = requestPayload(input);
  const requestFingerprint = fingerprint({
    operation: 'data_rights_request_create',
    childId,
    requestType: input.requestType,
    expectedRevision: input.expectedRevision,
    requestPayload: payload,
    reauthAssertionHash: sha256(input.reauthAssertion)
  });
  return inTransaction(db => {
    const replay = findIdempotencyReplay(db, {
      actor, keyHash, requestFingerprint
    });
    if (replay) return resultForRequest(db, replay, 200);

    const scope = historicalScope(db, actor, childId);
    if (scope.privacyState.revision !== input.expectedRevision) {
      fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    }
    if (input.requestType === 'correct') {
      if (['deletion_pending', 'deidentified', 'deleted'].includes(scope.privacyState.status)) {
        fail(409, 'CHILD_PROCESSING_BLOCKED', '儿童档案当前不允许更正');
      }
      if (scope.child.name !== input.correction.expectedValue) {
        fail(409, 'CORRECTION_CONFLICT', '儿童当前别名已变化');
      }
    }
    if (DESTRUCTIVE_TYPES.has(input.requestType)) {
      const existing = repositories.dataRights.findLiveDeletionRequest({
        familyId: actor.familyId,
        childId
      }, db);
      if (existing || ['deletion_pending', 'deidentified', 'deleted'].includes(scope.privacyState.status)) {
        fail(409, 'DESTRUCTIVE_REQUEST_IN_PROGRESS', '该儿童已有删除或服务终止请求正在处理');
      }
    }

    const assertion = consumeAssertion(db, {
      actor,
      rawToken: input.reauthAssertion,
      requestType: input.requestType,
      now
    });
    const idempotencyId = startIdempotency(db, {
      actor, keyHash, requestFingerprint, now
    });
    let request = beginRecordedRequest(db, {
      actor,
      childId,
      requestType: input.requestType,
      consent: scope.consent,
      assertion,
      requestFingerprint,
      requestPayload: payload,
      now
    });

    if (input.requestType === 'correct') {
      const corrected = repositories.dataRights.conditionalCorrectAlias({
        familyId: actor.familyId,
        childId,
        guardianId: actor.id,
        requestId: request.id,
        expectedAlias: input.correction.expectedValue,
        newAlias: input.correction.value,
        expectedPrivacyRevision: input.expectedRevision
      }, db);
      if (!corrected) fail(409, 'CORRECTION_CONFLICT', '儿童当前别名或隐私状态已变化');
    }

    request = DESTRUCTIVE_TYPES.has(input.requestType)
      ? processDeletionRequest(db, { actor, scope, request, now })
      : completeRecordedRequest(db, request, {
          now,
          receipt: RECEIPTS[input.requestType],
          privacyRevision: scope.privacyState.revision,
          changedField: input.requestType === 'correct' ? 'alias' : undefined
        });
    const responseStatus = DESTRUCTIVE_TYPES.has(input.requestType) ? 202 : 201;
    completeIdempotency(db, {
      id: idempotencyId, request, responseStatus, now
    });
    return resultForRequest(db, request, responseStatus);
  });
}

function listRequests({ actor, query, body }) {
  validateEmptyBody(body);
  validateQuery(query, new Set(['childId', 'requestType', 'status', 'limit', 'cursor']));
  const childId = optionalFilter(query.childId, { field: 'childId', pattern: CHILD_ID });
  const requestType = optionalFilter(query.requestType, {
    field: 'requestType', accepted: STORED_REQUEST_TYPES
  });
  const status = optionalFilter(query.status, { field: 'status', accepted: REQUEST_STATUSES });
  const limit = parseLimit(query.limit);
  const scope = { familyId: actor.familyId, guardianId: actor.id, childId, requestType, status };
  const cursor = decodeCursor(query.cursor, scope);
  return inReadTransaction(db => {
    const rows = repositories.dataRights.listOwnRequests({
      ...scope, cursor, limit: limit + 1
    }, db);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      success: true,
      dataRightsRequests: visibleRows.map(request => serializeRequest(request)),
      nextCursor: hasMore ? encodeCursor(visibleRows[visibleRows.length - 1], scope) : null
    };
  });
}

function getRequest({ actor, dataRightsRequestId, query, body }) {
  validateEmptyBody(body);
  validateQuery(query, new Set());
  return inReadTransaction(db => {
    const request = repositories.dataRights.findOwnRequest({
      familyId: actor.familyId,
      guardianId: actor.id,
      requestId: dataRightsRequestId
    }, db);
    if (!request) fail(404, 'DATA_RIGHTS_REQUEST_NOT_FOUND', '数据权利请求不存在');
    const events = repositories.dataRights.listAuditEvents({
      familyId: actor.familyId,
      childId: request.childId,
      guardianId: actor.id,
      requestId: request.id
    }, db);
    const deletionJob = DESTRUCTIVE_TYPES.has(request.requestType)
      ? repositories.dataRights.findDeletionJobByRequest({
          familyId: actor.familyId,
          childId: request.childId,
          requestId: request.id
        }, db)
      : null;
    return {
      success: true,
      dataRightsRequest: serializeRequest(request, { deletionJob, events })
    };
  });
}

function exportChildData({ actor, childId, query, body, now = new Date() }) {
  validateEmptyBody(body);
  validateQuery(query, new Set(['requestId']));
  const dataRightsRequestId = optionalFilter(query.requestId, {
    field: 'requestId', pattern: REQUEST_ID
  });
  if (!dataRightsRequestId) {
    fail(400, 'VALIDATION_ERROR', 'requestId 必填', 'requestId');
  }
  return inReadTransaction(db => {
    const request = repositories.dataRights.findOwnRequest({
      familyId: actor.familyId,
      guardianId: actor.id,
      requestId: dataRightsRequestId
    }, db);
    if (!request || request.childId !== childId) {
      fail(404, 'DATA_RIGHTS_REQUEST_NOT_FOUND', '数据权利请求不存在');
    }
    historicalScope(db, actor, childId);
    if (!['access', 'export'].includes(request.requestType) || request.status !== 'completed') {
      fail(409, 'DATA_EXPORT_NOT_READY', '该请求尚未授权数据导出');
    }
    const completedAt = Date.parse(request.completedAt || '');
    const elapsed = now.getTime() - completedAt;
    if (!Number.isFinite(completedAt)
        || elapsed < -EXPORT_CLOCK_SKEW_MS
        || elapsed > EXPORT_AUTHORIZATION_TTL_MS) {
      fail(410, 'DATA_EXPORT_EXPIRED', '本次导出授权已过期，请重新发起请求');
    }
    const snapshot = repositories.dataRights.readExportSnapshot({
      familyId: actor.familyId,
      childId,
      guardianId: actor.id
    }, db);
    if (!snapshot) fail(404, 'DATA_RIGHTS_REQUEST_NOT_FOUND', '数据权利请求不存在');
    return {
      success: true,
      dataExport: {
        schemaVersion: '1.0',
        generatedAt: now.toISOString(),
        authorizedByRequestId: request.id,
        ...snapshot,
        retentionNotice: {
          deletionExecutionEnabled: false,
          immutableEvidenceRetained: true,
          reason: 'retention_policy_unapproved'
        }
      }
    };
  });
}

function beginWithdrawalAudit(db, {
  actor, childId, consent, assertion, requestFingerprint, now = new Date()
}) {
  return beginRecordedRequest(db, {
    actor,
    childId,
    requestType: 'withdraw',
    consent,
    assertion,
    requestFingerprint,
    requestPayload: {},
    now
  });
}

function completeWithdrawalAudit(db, {
  request, privacyState, now = new Date()
}) {
  const completed = completeRecordedRequest(db, request, {
    now,
    receipt: RECEIPTS.withdraw,
    privacyRevision: privacyState.revision
  });
  const tokenFloor = repositories.dataRights.raiseLegacyTokenFloorForWithdrawal({
    familyId: completed.familyId,
    childId: completed.childId,
    guardianId: completed.guardianId,
    requestId: completed.id,
    tokensValidAfter: Math.max(now.getTime(), Date.parse(completed.updatedAt))
  }, db);
  if (!tokenFloor) fail(409, 'DATA_RIGHTS_STATE_CONFLICT', '儿童凭据撤销状态已变化');
  return completed;
}

module.exports = {
  createRequest,
  listRequests,
  getRequest,
  exportChildData,
  beginWithdrawalAudit,
  completeWithdrawalAudit,
  normalizeIdempotencyKey,
  fingerprint,
  serializeRequest
};
