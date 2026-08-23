const crypto = require('crypto');

const features = require('../config/features');
const { inReadTransaction, inTransaction } = require('../db/connection');
const repositories = require('../db/repositories');
const { ApiError } = require('../lib/api-error');
const { isPlainObject } = require('../lib/validation');
const credentials = require('../lib/device-credentials');

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const RULE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const STATUSES = new Set(['pending', 'needs_info', 'approved', 'rejected', 'cancelled']);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_VERSION = 1;

function fail(status, code, message, field) {
  throw new ApiError({ status, code, message, field });
}

function assertEnabled() {
  if (!features.isHarmonyChildEnabled() || !features.isPointRequestsEnabled()) {
    fail(403, 'FEATURE_DISABLED', '积分申报审批当前未开放');
  }
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

function requireObject(body) {
  if (!isPlainObject(body)) fail(400, 'VALIDATION_ERROR', '请求体必须是对象');
  return body;
}

function exactKeys(body, allowed) {
  const unknown = Object.keys(body).find(key => !allowed.has(key));
  if (unknown) fail(400, 'VALIDATION_ERROR', '请求字段不受支持', unknown);
}

function requireText(value, { field, min = 1, max = 300, pattern } = {}) {
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max || CONTROL_CHARACTERS.test(normalized)) {
    fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  }
  if (pattern && !pattern.test(normalized)) {
    fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  }
  return normalized;
}

function optionalNote(value, field = 'note') {
  if (value === undefined || value === null) return null;
  return requireText(value, { field, max: 300 });
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(400, 'REVISION_REQUIRED', 'expectedRevision 必须是非负整数', 'expectedRevision');
  }
  return value;
}

function requirePositivePoints(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1000) {
    fail(400, 'VALIDATION_ERROR', `${field}必须是 1 至 1000 的整数`, field);
  }
  return value;
}

function optionalOccurredAt(value, now) {
  if (value === undefined) return null;
  const match = typeof value === 'string' ? RFC3339_INSTANT.exec(value) : null;
  if (!match) {
    fail(400, 'VALIDATION_ERROR', 'occurredAt 必须是 RFC 3339 时间', 'occurredAt');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year
      || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59
      || (offsetHour === 14 && offsetMinute !== 0)) {
    fail(400, 'VALIDATION_ERROR', 'occurredAt 必须是有效时间', 'occurredAt');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail(400, 'VALIDATION_ERROR', 'occurredAt 必须是有效时间', 'occurredAt');
  }
  const normalized = new Date(parsed).toISOString();
  if (normalized > now.toISOString()) {
    fail(400, 'VALIDATION_ERROR', 'occurredAt 不能晚于提交时间', 'occurredAt');
  }
  if (periodKey(new Date(normalized)) !== periodKey(now)) {
    fail(400, 'OCCURRED_AT_OUT_OF_WINDOW', 'occurredAt 当前只允许提交上海自然日内的发生时间', 'occurredAt');
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    fail(400, 'IDEMPOTENCY_REQUIRED', '请提供有效的 Idempotency-Key', 'Idempotency-Key');
  }
  return sha256(value);
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value)) {
    fail(400, 'VALIDATION_ERROR', 'limit 必须是 1 至 50 的整数', 'limit');
  }
  const limit = Number(value);
  if (limit > MAX_LIMIT) fail(400, 'VALIDATION_ERROR', 'limit 必须是 1 至 50 的整数', 'limit');
  return limit;
}

function parseStatus(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !STATUSES.has(value)) {
    fail(400, 'VALIDATION_ERROR', 'status 无效', 'status');
  }
  return value;
}

function validateQuery(query, allowed) {
  if (!isPlainObject(query)) fail(400, 'VALIDATION_ERROR', '查询参数格式错误');
  const unknown = Object.keys(query).find(key => !allowed.has(key));
  if (unknown) fail(400, 'VALIDATION_ERROR', '查询参数不受支持', unknown);
}

function validateEmptyBody(body) {
  if (body === undefined) return;
  if (!isPlainObject(body)) fail(400, 'VALIDATION_ERROR', '请求体格式错误');
  const key = Object.keys(body)[0];
  if (key) fail(400, 'VALIDATION_ERROR', '只读接口不接受请求体', key);
}

function periodKey(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function cursorKey() {
  return Buffer.from(credentials.hmac(
    'point-request-cursor-aead-key', `v${CURSOR_VERSION}`
  ), 'hex');
}

function cursorAad(scope) {
  return Buffer.from(JSON.stringify([
    `tangguan-point-request-cursor-v${CURSOR_VERSION}`,
    scope.audience,
    scope.familyId,
    scope.actorId,
    scope.childId || '',
    scope.status
  ]), 'utf8');
}

function encodeCursor(request, scope) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cursorKey(), nonce);
  cipher.setAAD(cursorAad(scope));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify([request.submittedAt, request.id]), 'utf8'),
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
  if (packet.toString('base64url') !== value
      || packet.length < 30 || packet[0] !== CURSOR_VERSION) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  let decoded;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', cursorKey(), packet.subarray(1, 13)
    );
    decipher.setAAD(cursorAad(scope));
    decipher.setAuthTag(packet.subarray(13, 29));
    const plaintext = Buffer.concat([
      decipher.update(packet.subarray(29)), decipher.final()
    ]).toString('utf8');
    decoded = JSON.parse(plaintext);
  } catch (_) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || !Number.isFinite(Date.parse(decoded[0]))
      || typeof decoded[1] !== 'string' || decoded[1].length < 1 || decoded[1].length > 128
      || CONTROL_CHARACTERS.test(decoded[1])) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  return { submittedAt: decoded[0], id: decoded[1] };
}

function nextTimestamp(now, previous) {
  const candidate = now.toISOString();
  if (!previous || candidate > previous) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString();
}

function assertDeviceActor(actor) {
  if (!actor || actor.role !== 'device'
      || typeof actor.familyId !== 'string' || !actor.familyId
      || typeof actor.childId !== 'string' || !actor.childId
      || typeof actor.deviceBindingId !== 'string' || !actor.deviceBindingId
      || typeof actor.sessionId !== 'string' || !actor.sessionId
      || typeof actor.tokenFamilyId !== 'string' || !actor.tokenFamilyId
      || !Number.isSafeInteger(actor.rotationCounter) || actor.rotationCounter < 0) {
    fail(401, 'SESSION_REVOKED', '设备会话已失效');
  }
  return actor;
}

function deviceScope(db, actor, now) {
  const scope = repositories.pointRequests.inspectDeviceScope({
    familyId: actor.familyId,
    childId: actor.childId,
    deviceBindingId: actor.deviceBindingId,
    sessionId: actor.sessionId,
    tokenFamilyId: actor.tokenFamilyId,
    rotationCounter: actor.rotationCounter,
    now: now.toISOString()
  }, db);
  if (scope.ok) return scope;
  if (scope.reason === 'privacy') {
    fail(409, 'CHILD_PROCESSING_BLOCKED', '儿童档案当前不允许积分申报处理');
  }
  if (scope.reason === 'consent') {
    fail(403, 'CONSENT_REQUIRED', '当前监护授权不包含积分申报范围');
  }
  if (scope.reason === 'account') {
    fail(409, 'CHILD_DATA_INCOMPLETE', '儿童积分账户不完整');
  }
  fail(401, 'SESSION_REVOKED', '设备会话已失效');
}

function adultRequestScope(db, actor, requestId, { accountError = false } = {}) {
  const request = repositories.pointRequests.findById({ id: requestId, familyId: actor.familyId }, db);
  if (!request) fail(404, 'POINT_REQUEST_NOT_FOUND', '积分申请不存在');
  const scope = repositories.pointRequests.inspectAdultChildScope({
    familyId: actor.familyId,
    childId: request.childId,
    actorUserId: actor.id
  }, db);
  if (!scope.ok) {
    if (accountError && scope.reason === 'account') {
      fail(409, 'CHILD_DATA_INCOMPLETE', '儿童积分账户不完整');
    }
    fail(404, 'POINT_REQUEST_NOT_FOUND', '积分申请不存在');
  }
  return { request, scope };
}

function ensureRevisionAndState(request, expectedRevision, allowedStatuses) {
  if (request.revision !== expectedRevision) {
    fail(409, 'REVISION_CONFLICT', '积分申请版本已变化');
  }
  if (!allowedStatuses.has(request.status)) {
    fail(409, 'POINT_REQUEST_STATE_CONFLICT', '积分申请当前状态不允许此操作');
  }
}

function ensureReplay(event, requestFingerprint, request) {
  if (event.requestFingerprint !== requestFingerprint
      || event.pointRequestId !== request.id) {
    fail(409, 'IDEMPOTENCY_CONFLICT', '该幂等键已用于不同请求');
  }
  if (request.revision !== event.resultRevision || request.status !== event.toStatus) {
    fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的积分申请已经变化');
  }
}

function serializeRequest(request, { audience, actorDeviceBindingId = null }) {
  const result = {
    id: request.id,
    status: request.status,
    revision: request.revision,
    rule: {
      id: request.ruleId,
      categoryId: request.categoryId,
      label: request.ruleLabel,
      categoryLabel: request.categoryLabel,
      unit: request.ruleUnit,
      minPoints: request.ruleMinPoints,
      defaultPoints: request.ruleDefaultPoints,
      maxPoints: request.ruleMaxPoints,
      revision: request.ruleRevision
    },
    requestedPoints: request.requestedPoints,
    approvedPoints: request.approvedPoints,
    description: request.description,
    occurredAt: request.occurredAt,
    duplicateSuspected: request.duplicateSuspected,
    requestInfo: request.requestInfoNote ? {
      note: request.requestInfoNote,
      requestedAt: request.requestInfoAt,
      resubmittedAt: request.resubmittedAt
    } : null,
    decision: ['approved', 'rejected'].includes(request.status) ? {
      note: request.decisionNote,
      reviewedAt: request.reviewedAt,
      transactionId: request.transactionId
    } : null,
    submittedAt: request.submittedAt,
    updatedAt: request.updatedAt
  };
  if (audience === 'device' && request.deviceBindingId === actorDeviceBindingId) {
    result.clientRequestId = request.clientRequestId;
  }
  if (audience === 'adult') {
    result.child = { id: request.childId, alias: request.childAlias };
  }
  return result;
}

function result(request, { status = 200, audience, actorDeviceBindingId = null }) {
  return {
    status,
    body: {
      success: true,
      pointRequest: serializeRequest(request, { audience, actorDeviceBindingId })
    }
  };
}

function parseCreateBody(body, now) {
  requireObject(body);
  exactKeys(body, new Set([
    'clientRequestId', 'ruleId', 'requestedPoints', 'description', 'occurredAt'
  ]));
  return {
    clientRequestId: requireText(body.clientRequestId, {
      field: 'clientRequestId', min: 8, max: 128, pattern: CLIENT_REQUEST_ID
    }),
    ruleId: requireText(body.ruleId, { field: 'ruleId', max: 128, pattern: RULE_ID }),
    requestedPoints: body.requestedPoints === undefined
      ? null
      : requirePositivePoints(body.requestedPoints, 'requestedPoints'),
    description: requireText(body.description, { field: 'description', max: 300 }),
    occurredAt: optionalOccurredAt(body.occurredAt, now)
  };
}

function createRequest({ actor, body, idempotencyKey, now = new Date() }) {
  assertEnabled();
  const device = assertDeviceActor(actor);
  const input = parseCreateBody(body, now);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({ operation: 'point_request_create', ...input });
  return inTransaction(db => {
    const scope = deviceScope(db, device, now);
    const keyedReplay = repositories.pointRequests.findDeviceEvent({
      deviceBindingId: device.deviceBindingId,
      action: 'create',
      idempotencyKeyHash: keyHash
    }, db);
    if (keyedReplay) {
      const request = repositories.pointRequests.findById({
        id: keyedReplay.pointRequestId, familyId: device.familyId
      }, db);
      if (!request || request.childId !== device.childId) {
        fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '积分申请幂等结果不可用');
      }
      ensureReplay(keyedReplay, requestFingerprint, request);
      return result(request, {
        audience: 'device', actorDeviceBindingId: device.deviceBindingId
      });
    }

    const existing = repositories.pointRequests.findByDeviceClientRequest({
      deviceBindingId: device.deviceBindingId,
      clientRequestId: input.clientRequestId
    }, db);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'clientRequestId 已用于不同申请');
      }
      if (existing.status !== 'pending' || existing.revision !== 0) {
        fail(409, 'IDEMPOTENCY_REPLAY_STALE', '原积分申请已经进入后续处理');
      }
      repositories.pointRequests.insertEvent({
        id: crypto.randomUUID(),
        familyId: device.familyId,
        childId: device.childId,
        pointRequestId: existing.id,
        actorDeviceBindingId: device.deviceBindingId,
        action: 'create',
        idempotencyKeyHash: keyHash,
        requestFingerprint,
        fromStatus: null,
        toStatus: 'pending',
        resultRevision: 0,
        responseStatus: 200,
        eventData: { clientRequestId: input.clientRequestId },
        createdAt: now.toISOString()
      }, db);
      return result(existing, {
        audience: 'device', actorDeviceBindingId: device.deviceBindingId
      });
    }

    const rule = repositories.pointRequests.currentRewardRule({
      familyId: device.familyId, ruleId: input.ruleId
    }, db);
    if (!rule || typeof rule.categoryId !== 'string' || !rule.categoryId
        || typeof rule.ruleLabel !== 'string' || !rule.ruleLabel
        || typeof rule.categoryLabel !== 'string' || !rule.categoryLabel
        || !Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.default)
        || !Number.isSafeInteger(rule.max)
        || rule.min < 0 || rule.min > rule.default || rule.default > rule.max) {
      fail(400, 'RULE_REFERENCE_INVALID', '规则不存在、不是鼓励规则或快照无效', 'ruleId');
    }
    const requestedPoints = input.requestedPoints === null ? rule.default : input.requestedPoints;
    if (requestedPoints <= 0 || requestedPoints < rule.min || requestedPoints > rule.max) {
      fail(400, 'RULE_AMOUNT_OUT_OF_RANGE', `申报分值必须在 ${rule.min}~${rule.max} 之间`, 'requestedPoints');
    }
    const submittedAt = now.toISOString();
    const occurredAt = input.occurredAt || submittedAt;
    const requestId = `point_request_${crypto.randomUUID().replace(/-/g, '')}`;
    const duplicateSuspected = repositories.pointRequests.hasDuplicateSignal({
      familyId: device.familyId,
      childId: device.childId,
      ruleId: rule.ruleId,
      periodKey: periodKey(new Date(occurredAt))
    }, db);
    repositories.pointRequests.insertEvent({
      id: crypto.randomUUID(),
      familyId: device.familyId,
      childId: device.childId,
      pointRequestId: requestId,
      actorDeviceBindingId: device.deviceBindingId,
      action: 'create',
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      fromStatus: null,
      toStatus: 'pending',
      resultRevision: 0,
      responseStatus: 201,
      eventData: { clientRequestId: input.clientRequestId, occurredAt },
      createdAt: submittedAt
    }, db);
    const created = repositories.pointRequests.insertRequest({
      id: requestId,
      familyId: device.familyId,
      childId: device.childId,
      deviceBindingId: device.deviceBindingId,
      clientRequestId: input.clientRequestId,
      requestFingerprint,
      ruleId: rule.ruleId,
      categoryId: rule.categoryId,
      ruleRevision: rule.ruleRevision,
      ruleLabel: rule.ruleLabel,
      categoryLabel: rule.categoryLabel,
      ruleUnit: rule.ruleUnit,
      ruleMinPoints: rule.min,
      ruleDefaultPoints: rule.default,
      ruleMaxPoints: rule.max,
      childAlias: scope.child.name,
      requestedPoints,
      description: input.description,
      occurredAt,
      periodKey: periodKey(new Date(occurredAt)),
      duplicateSuspected,
      submittedAt
    }, db);
    return result(created, {
      status: 201,
      audience: 'device',
      actorDeviceBindingId: device.deviceBindingId
    });
  });
}

function listMine({ actor, query, body, now = new Date() }) {
  assertEnabled();
  const device = assertDeviceActor(actor);
  validateEmptyBody(body);
  validateQuery(query, new Set(['status', 'limit', 'cursor']));
  const status = parseStatus(query.status);
  const limit = parseLimit(query.limit);
  const cursorScope = {
    audience: 'device',
    familyId: device.familyId,
    actorId: device.deviceBindingId,
    childId: device.childId,
    status: status || 'all'
  };
  const cursor = decodeCursor(query.cursor, cursorScope);
  return inReadTransaction(db => {
    deviceScope(db, device, now);
    const rows = repositories.pointRequests.listForDevice({
      familyId: device.familyId,
      childId: device.childId,
      status,
      cursor,
      limit: limit + 1
    }, db);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      success: true,
      pointRequests: visibleRows.map(request => serializeRequest(request, {
        audience: 'device', actorDeviceBindingId: device.deviceBindingId
      })),
      nextCursor: hasMore ? encodeCursor(visibleRows[visibleRows.length - 1], cursorScope) : null
    };
  });
}

function parseDeviceMutation(action, body) {
  requireObject(body);
  if (action === 'resubmit') {
    exactKeys(body, new Set(['expectedRevision', 'description']));
    return {
      expectedRevision: requireRevision(body.expectedRevision),
      description: requireText(body.description, { field: 'description', max: 300 })
    };
  }
  exactKeys(body, new Set(['expectedRevision']));
  return { expectedRevision: requireRevision(body.expectedRevision) };
}

function mutateByDevice({ actor, requestId, action, body, idempotencyKey, now = new Date() }) {
  assertEnabled();
  const device = assertDeviceActor(actor);
  const input = parseDeviceMutation(action, body);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: `point_request_${action}`, requestId, ...input
  });
  return inTransaction(db => {
    deviceScope(db, device, now);
    const request = repositories.pointRequests.findById({ id: requestId, familyId: device.familyId }, db);
    if (!request || request.childId !== device.childId) {
      fail(404, 'POINT_REQUEST_NOT_FOUND', '积分申请不存在');
    }
    const replay = repositories.pointRequests.findDeviceEvent({
      deviceBindingId: device.deviceBindingId,
      action,
      idempotencyKeyHash: keyHash
    }, db);
    if (replay) {
      ensureReplay(replay, requestFingerprint, request);
      return result(request, {
        audience: 'device', actorDeviceBindingId: device.deviceBindingId
      });
    }
    const allowed = action === 'resubmit'
      ? new Set(['needs_info'])
      : new Set(['pending', 'needs_info']);
    ensureRevisionAndState(request, input.expectedRevision, allowed);
    const updatedAt = nextTimestamp(now, request.updatedAt);
    repositories.pointRequests.insertEvent({
      id: crypto.randomUUID(),
      familyId: device.familyId,
      childId: device.childId,
      pointRequestId: request.id,
      actorDeviceBindingId: device.deviceBindingId,
      action,
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      fromStatus: request.status,
      toStatus: action === 'resubmit' ? 'pending' : 'cancelled',
      resultRevision: request.revision + 1,
      responseStatus: 200,
      eventData: action === 'resubmit' ? { description: input.description } : {},
      createdAt: updatedAt
    }, db);
    const updated = repositories.pointRequests.updateRequest({
      action,
      id: request.id,
      familyId: device.familyId,
      childId: device.childId,
      expectedRevision: input.expectedRevision,
      description: input.description,
      updatedAt
    }, db);
    if (!updated) fail(409, 'REVISION_CONFLICT', '积分申请版本已变化');
    return result(updated, {
      audience: 'device', actorDeviceBindingId: device.deviceBindingId
    });
  });
}

function listForAdult({ actor, query, body }) {
  assertEnabled();
  validateEmptyBody(body);
  validateQuery(query, new Set(['childId', 'status', 'limit', 'cursor']));
  const childId = query.childId === undefined
    ? null
    : requireText(query.childId, { field: 'childId', min: 2, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
  const status = parseStatus(query.status);
  const limit = parseLimit(query.limit);
  const effectiveStatus = status || 'pending';
  const cursorScope = {
    audience: 'adult',
    familyId: actor.familyId,
    actorId: actor.id,
    childId: childId || '',
    status: effectiveStatus
  };
  const cursor = decodeCursor(query.cursor, cursorScope);
  return inReadTransaction(db => {
    const rows = repositories.pointRequests.listForAdult({
      familyId: actor.familyId,
      actorUserId: actor.id,
      childId,
      status: effectiveStatus,
      cursor,
      limit: limit + 1
    }, db);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      success: true,
      pointRequests: visibleRows.map(request => serializeRequest(request, { audience: 'adult' })),
      nextCursor: hasMore ? encodeCursor(visibleRows[visibleRows.length - 1], cursorScope) : null
    };
  });
}

function getForAdult({ actor, requestId, query, body }) {
  assertEnabled();
  validateEmptyBody(body);
  validateQuery(query, new Set());
  return inReadTransaction(db => {
    const { request } = adultRequestScope(db, actor, requestId);
    return { success: true, pointRequest: serializeRequest(request, { audience: 'adult' }) };
  });
}

function parseAdultMutation(action, body) {
  requireObject(body);
  if (action === 'request_info' || action === 'reject') {
    exactKeys(body, new Set(['expectedRevision', 'note']));
    return {
      expectedRevision: requireRevision(body.expectedRevision),
      note: requireText(body.note, { field: 'note', max: 300 })
    };
  }
  exactKeys(body, new Set(['expectedRevision', 'approvedPoints', 'note']));
  return {
    expectedRevision: requireRevision(body.expectedRevision),
    approvedPoints: requirePositivePoints(body.approvedPoints, 'approvedPoints'),
    note: optionalNote(body.note)
  };
}

function mutateByAdult({ actor, requestId, action, body, idempotencyKey, now = new Date() }) {
  assertEnabled();
  const input = parseAdultMutation(action, body);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: `point_request_${action}`, requestId, ...input
  });
  return inTransaction(db => {
    const { request, scope } = adultRequestScope(db, actor, requestId, { accountError: true });
    const replay = repositories.pointRequests.findAdultEvent({
      familyId: actor.familyId,
      actorUserId: actor.id,
      action,
      idempotencyKeyHash: keyHash
    }, db);
    if (replay) {
      ensureReplay(replay, requestFingerprint, request);
      return result(request, { audience: 'adult' });
    }
    const allowed = action === 'approve' || action === 'request_info'
      ? new Set(['pending'])
      : new Set(['pending', 'needs_info']);
    ensureRevisionAndState(request, input.expectedRevision, allowed);
    if (action === 'approve'
        && (input.approvedPoints < request.ruleMinPoints
          || input.approvedPoints > request.ruleMaxPoints)) {
      fail(
        400,
        'RULE_AMOUNT_OUT_OF_RANGE',
        `批准分值必须在申请时规则范围 ${request.ruleMinPoints}~${request.ruleMaxPoints} 之间`,
        'approvedPoints'
      );
    }
    const updatedAt = nextTimestamp(now, request.updatedAt);
    const transactionId = action === 'approve' ? crypto.randomUUID() : null;
    const toStatus = {
      request_info: 'needs_info', approve: 'approved', reject: 'rejected'
    }[action];
    repositories.pointRequests.insertEvent({
      id: crypto.randomUUID(),
      familyId: actor.familyId,
      childId: request.childId,
      pointRequestId: request.id,
      actorUserId: actor.id,
      action,
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      fromStatus: request.status,
      toStatus,
      resultRevision: request.revision + 1,
      responseStatus: 200,
      transactionId,
      eventData: {
        ...(input.note ? { note: input.note } : {}),
        ...(action === 'approve' ? { approvedPoints: input.approvedPoints } : {})
      },
      createdAt: updatedAt
    }, db);
    const updated = repositories.pointRequests.updateRequest({
      action,
      id: request.id,
      familyId: actor.familyId,
      childId: request.childId,
      actorUserId: actor.id,
      expectedRevision: input.expectedRevision,
      approvedPoints: input.approvedPoints,
      note: input.note,
      transactionId,
      updatedAt
    }, db);
    if (!updated) fail(409, 'REVISION_CONFLICT', '积分申请版本已变化');
    if (action === 'approve') {
      try {
        repositories.points.changePointsInTransaction(db, {
          familyId: actor.familyId,
          kid: request.childId,
          kidName: request.childAlias,
          amount: input.approvedPoints,
          reason: request.ruleLabel,
          operator: scope.adult.name,
          note: input.note || '',
          ruleId: request.ruleId,
          categoryId: request.categoryId,
          transactionId,
          occurredAt: request.occurredAt,
          sourceType: 'point_request',
          sourceId: request.id,
          requireExistingAccount: true
        });
      } catch (error) {
        if (error && error.code === 'CHILD_DATA_INCOMPLETE') {
          fail(409, 'CHILD_DATA_INCOMPLETE', '儿童积分账户不完整');
        }
        if (error && error.code === 'CHILD_PROCESSING_BLOCKED') {
          fail(409, 'CHILD_PROCESSING_BLOCKED', '儿童档案当前不允许积分处理');
        }
        throw error;
      }
    }
    return result(updated, { audience: 'adult' });
  });
}

function tasksSummary({ actor, query, body }) {
  assertEnabled();
  validateEmptyBody(body);
  validateQuery(query, new Set());
  return {
    success: true,
    pointRequests: repositories.pointRequests.taskSummary({
      familyId: actor.familyId, actorUserId: actor.id
    })
  };
}

module.exports = {
  assertEnabled,
  createRequest,
  listMine,
  mutateByDevice,
  listForAdult,
  getForAdult,
  mutateByAdult,
  tasksSummary,
  serializeRequest,
  normalizeIdempotencyKey
};
