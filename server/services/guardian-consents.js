const crypto = require('crypto');

const features = require('../config/features');
const consentConfig = require('../config/guardian-consent');
const { getDb, inTransaction } = require('../db/connection');
const repositories = require('../db/repositories');
const devicePairingSessions = require('./device-pairing-sessions');
const { ApiError } = require('../lib/api-error');
const { verifyPwd } = require('../lib/token');
const { isPlainObject } = require('../lib/validation');

const REAUTH_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const CHILD_ALIAS_CONTROL = /[\u0000-\u001f\u007f]/;

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

function iso(date) {
  return date.toISOString();
}

function fail(status, code, message, field) {
  throw new ApiError({ status, code, message, field });
}

function assertEnrollmentEnabled() {
  if (!features.isHarmonyChildEnabled() || !features.isChildEnrollmentEnabled()) {
    fail(403, 'FEATURE_DISABLED', '监护授权与儿童建档当前未开放');
  }
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    fail(400, 'IDEMPOTENCY_REQUIRED', '请提供有效的 Idempotency-Key', 'Idempotency-Key');
  }
  return sha256(value);
}

function requireText(value, { field, min = 1, max = 128 }) {
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    fail(400, 'VALIDATION_ERROR', `${field}长度必须为${min}-${max}个字符`, field);
  }
  return normalized;
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(400, 'REVISION_REQUIRED', 'expectedRevision 必须是非负整数', 'expectedRevision');
  }
  return value;
}

function parseLegalAcceptance(body, { requireAlias = false } = {}) {
  if (!isPlainObject(body)) fail(400, 'VALIDATION_ERROR', '请求体必须是对象');
  const alias = requireAlias
    ? requireText(body.alias, { field: 'alias', min: 1, max: 30 }).normalize('NFC')
    : undefined;
  if (alias && CHILD_ALIAS_CONTROL.test(alias)) {
    fail(400, 'VALIDATION_ERROR', 'alias 包含不允许的控制字符', 'alias');
  }
  const reauthAssertion = requireText(body.reauthAssertion, {
    field: 'reauthAssertion', min: 32, max: 256
  });
  if (!consentConfig.GUARDIAN_RELATIONS.has(body.guardianRelation)) {
    fail(400, 'VALIDATION_ERROR', 'guardianRelation 无效', 'guardianRelation');
  }
  if (!isPlainObject(body.relationDeclaration) || body.relationDeclaration.accepted !== true) {
    fail(400, 'CONSENT_REQUIRED', '必须明确作出法定监护关系声明', 'relationDeclaration.accepted');
  }
  const relationDeclaration = {
    version: requireText(body.relationDeclaration.version, {
      field: 'relationDeclaration.version', max: 64
    }),
    sha256: requireText(body.relationDeclaration.sha256, {
      field: 'relationDeclaration.sha256', min: 64, max: 64
    })
  };
  if (!consentConfig.SHA256.test(relationDeclaration.sha256)) {
    fail(400, 'VALIDATION_ERROR', '关系声明摘要格式无效', 'relationDeclaration.sha256');
  }
  if (!isPlainObject(body.consents)) {
    fail(400, 'CONSENT_REQUIRED', '缺少法律文本同意', 'consents');
  }
  const consents = {};
  for (const type of consentConfig.LEGAL_TEXT_TYPES) {
    const field = consentConfig.LEGAL_TEXT_FIELDS[type];
    const input = body.consents[field];
    if (!isPlainObject(input) || input.accepted !== true) {
      fail(400, 'CONSENT_REQUIRED', `必须明确同意 ${field}`, `consents.${field}.accepted`);
    }
    const version = requireText(input.version, { field: `consents.${field}.version`, max: 64 });
    const contentSha256 = requireText(input.sha256, {
      field: `consents.${field}.sha256`, min: 64, max: 64
    });
    if (!consentConfig.SHA256.test(contentSha256)) {
      fail(400, 'VALIDATION_ERROR', `${field} 摘要格式无效`, `consents.${field}.sha256`);
    }
    consents[type] = { version, sha256: contentSha256 };
  }
  return {
    ...(requireAlias ? { alias } : {}),
    reauthAssertion,
    guardianRelation: body.guardianRelation,
    relationDeclaration,
    consents
  };
}

function currentLegalEvidence(nowIso, db = getDb()) {
  const rows = repositories.guardianConsents.currentLegalTexts(nowIso, db);
  const byType = new Map(rows.map(row => [row.textType, row]));
  const declaration = consentConfig.guardianRelationDeclaration();
  if (!declaration || consentConfig.LEGAL_TEXT_TYPES.some(type => !byType.has(type))) {
    fail(503, 'LEGAL_TEXTS_UNAVAILABLE', '当前法律文本尚未完整发布');
  }
  return { byType, declaration };
}

function publicLegalTexts(now = new Date()) {
  const { byType, declaration } = currentLegalEvidence(iso(now));
  const texts = {};
  for (const type of consentConfig.LEGAL_TEXT_TYPES) {
    const row = byType.get(type);
    texts[consentConfig.LEGAL_TEXT_FIELDS[type]] = {
      type,
      version: row.version,
      sha256: row.contentSha256,
      publicUrl: row.publicUrl,
      effectiveAt: row.effectiveAt
    };
  }
  return { success: true, texts, guardianRelationDeclaration: declaration };
}

function assertCurrentAcceptance(accepted, current) {
  if (accepted.relationDeclaration.version !== current.declaration.version
      || accepted.relationDeclaration.sha256 !== current.declaration.sha256) {
    fail(409, 'LEGAL_TEXT_VERSION_MISMATCH', '监护关系声明版本已更新，请重新确认');
  }
  for (const type of consentConfig.LEGAL_TEXT_TYPES) {
    const expected = current.byType.get(type);
    const supplied = accepted.consents[type];
    if (supplied.version !== expected.version || supplied.sha256 !== expected.contentSha256) {
      fail(409, 'LEGAL_TEXT_VERSION_MISMATCH', '法律文本版本已更新，请重新阅读并确认');
    }
  }
}

function issueReauthAssertion({ actor, body, now = new Date() }) {
  if (!isPlainObject(body) || !consentConfig.REAUTH_PURPOSES.has(body.purpose)) {
    fail(400, 'REAUTH_PURPOSE_INVALID', '重新认证用途无效', 'purpose');
  }
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128
      || !verifyPwd(body.password, actor.password || '')) {
    fail(403, 'REAUTH_REQUIRED', '重新认证失败');
  }
  const assertionToken = crypto.randomBytes(32).toString('base64url');
  const issuedAt = iso(now);
  const expiresAt = iso(new Date(now.getTime() + REAUTH_TTL_MS));
  repositories.guardianConsents.createReauth({
    id: crypto.randomUUID(),
    familyId: actor.familyId,
    userId: actor.id,
    purpose: body.purpose,
    tokenHash: sha256(assertionToken),
    verificationMethod: 'password_reauth',
    issuedAt,
    expiresAt
  });
  return { success: true, reauthAssertion: assertionToken, expiresAt };
}

function idempotencyReplay(db, { actor, operation, keyHash, requestFingerprint }) {
  const record = repositories.guardianConsents.findIdempotency({
    familyId: actor.familyId,
    actorUserId: actor.id,
    operation,
    idempotencyKey: keyHash
  }, db);
  if (!record) return null;
  if (record.requestFingerprint !== requestFingerprint) {
    fail(409, 'IDEMPOTENCY_CONFLICT', '该幂等键已用于不同请求');
  }
  if (record.status !== 'completed') {
    fail(409, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理中');
  }
  return record;
}

function startIdempotency(db, { actor, operation, keyHash, requestFingerprint, now }) {
  const id = crypto.randomUUID();
  repositories.guardianConsents.startIdempotency({
    id,
    familyId: actor.familyId,
    actorUserId: actor.id,
    operation,
    idempotencyKey: keyHash,
    requestFingerprint,
    createdAt: iso(now)
  }, db);
  return id;
}

function completeIdempotency(db, { id, resourceId, resultRevision, responseStatus, now }) {
  const completed = repositories.guardianConsents.completeIdempotency({
    id,
    resourceType: 'guardian_consent',
    resourceId,
    resultRevision,
    responseStatus,
    completedAt: iso(now)
  }, db);
  if (!completed) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等请求状态已变化');
}

function consumeAssertion(db, { actor, rawToken, purpose, now }) {
  const assertion = repositories.guardianConsents.consumeReauth({
    familyId: actor.familyId,
    userId: actor.id,
    purpose,
    tokenHash: sha256(rawToken),
    consumedAt: iso(now)
  }, db);
  if (!assertion) fail(403, 'REAUTH_REQUIRED', '重新认证凭据无效或已过期');
  return assertion;
}

function consentEvidence(accepted, current, {
  actor, childId, assertion, consentVersion, supersedesConsentId, now, requestId
}) {
  const row = type => current.byType.get(type);
  const at = iso(now);
  return {
    id: crypto.randomUUID(),
    familyId: actor.familyId,
    childId,
    guardianId: actor.id,
    consentVersion,
    privacyVersion: row('privacy_policy').version,
    privacySha256: row('privacy_policy').contentSha256,
    childRulesVersion: row('child_personal_information_rules').version,
    childRulesSha256: row('child_personal_information_rules').contentSha256,
    childUserAgreementVersion: row('child_user_agreement').version,
    childUserAgreementSha256: row('child_user_agreement').contentSha256,
    sensitiveNoticeVersion: row('sensitive_information_notice').version,
    sensitiveNoticeSha256: row('sensitive_information_notice').contentSha256,
    guardianRelation: accepted.guardianRelation,
    relationDeclarationVersion: current.declaration.version,
    relationDeclarationSha256: current.declaration.sha256,
    reauthAssertionId: assertion.id,
    verificationMethod: assertion.verificationMethod,
    verifiedAt: assertion.consumedAt,
    consentScopeJson: JSON.stringify({
      childProfile: true,
      pointsLedger: true,
      pointRequests: true,
      sensitiveInformationNotice: true,
      optionalPhoto: false
    }),
    visibilityScopeJson: JSON.stringify({
      guardian: 'full',
      familyAdults: 'none',
      childDevice: 'self_only'
    }),
    privacyConsentedAt: at,
    childRulesConsentedAt: at,
    childUserAgreementAcceptedAt: at,
    sensitiveConsentedAt: at,
    auditDataJson: JSON.stringify(requestId ? { requestId } : {}),
    supersedesConsentId: supersedesConsentId || null,
    createdAt: at,
    updatedAt: at
  };
}

function serializeConsent(row) {
  return {
    id: row.id,
    childId: row.childId,
    version: row.consentVersion,
    status: row.status,
    lifecycleRevision: row.lifecycleRevision,
    guardianRelation: row.guardianRelation,
    relationDeclaration: {
      version: row.relationDeclarationVersion,
      sha256: row.relationDeclarationSha256
    },
    legalTexts: {
      privacyPolicy: { version: row.privacyVersion, sha256: row.privacySha256 },
      childPersonalInformationRules: { version: row.childRulesVersion, sha256: row.childRulesSha256 },
      childUserAgreement: { version: row.childUserAgreementVersion, sha256: row.childUserAgreementSha256 },
      sensitiveInformationNotice: { version: row.sensitiveNoticeVersion, sha256: row.sensitiveNoticeSha256 }
    },
    consentScope: row.consentScope,
    visibilityScope: row.visibilityScope,
    consentedAt: {
      privacy: row.privacyConsentedAt,
      childRules: row.childRulesConsentedAt,
      childUserAgreement: row.childUserAgreementAcceptedAt,
      sensitiveInformation: row.sensitiveConsentedAt
    },
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt } : {}),
    ...(row.supersededAt ? { supersededAt: row.supersededAt } : {})
  };
}

function serializePrivacyState(row) {
  return { status: row.status, revision: row.revision, updatedAt: row.updatedAt };
}

function buildConsentResult(db, familyId, consentId, {
  includeChild = false,
  expectedStateRevision
} = {}) {
  const consent = repositories.guardianConsents.findConsentById({ familyId, consentId }, db);
  if (!consent) fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '幂等结果暂不可用');
  const state = repositories.guardianConsents.getPrivacyState({
    familyId, childId: consent.childId
  }, db);
  if (!state) fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '儿童隐私状态不可用');
  if (expectedStateRevision !== undefined && state.revision !== expectedStateRevision) {
    fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的儿童状态已经变化');
  }
  const result = {
    success: true,
    consent: serializeConsent(consent),
    privacyState: serializePrivacyState(state)
  };
  if (includeChild) {
    const child = repositories.guardianConsents.findChildInFamily({
      familyId, childId: consent.childId
    }, db);
    if (!child) fail(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', '儿童档案不可用');
    result.child = {
      id: child.id,
      alias: child.name,
      privacyStatus: state.status,
      createdAt: consent.createdAt
    };
  }
  return result;
}

function enrollChild({ actor, body, idempotencyKey, requestId, now = new Date() }) {
  assertEnrollmentEnabled();
  const accepted = parseLegalAcceptance(body, { requireAlias: true });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'child_enrollment',
    alias: accepted.alias,
    guardianRelation: accepted.guardianRelation,
    relationDeclaration: accepted.relationDeclaration,
    consents: accepted.consents,
    reauthAssertionHash: sha256(accepted.reauthAssertion)
  });
  return inTransaction(db => {
    const replay = idempotencyReplay(db, {
      actor, operation: 'child_enrollment', keyHash, requestFingerprint
    });
    if (replay) {
      return {
        status: 200,
        body: buildConsentResult(db, actor.familyId, replay.resourceId, {
          includeChild: true,
          expectedStateRevision: replay.resultRevision
        })
      };
    }
    const current = currentLegalEvidence(iso(now), db);
    assertCurrentAcceptance(accepted, current);
    const assertion = consumeAssertion(db, {
      actor, rawToken: accepted.reauthAssertion, purpose: 'child_enrollment', now
    });
    const idempotencyId = startIdempotency(db, {
      actor, operation: 'child_enrollment', keyHash, requestFingerprint, now
    });
    const childId = `child_${crypto.randomUUID().replace(/-/g, '')}`;
    const child = repositories.users.insert({
      id: childId,
      name: accepted.alias,
      role: 'child',
      password: '',
      familyId: actor.familyId
    }, db);
    repositories.points.setBalance(actor.familyId, child.id, 0, db);
    const consent = repositories.guardianConsents.insertConsent(
      consentEvidence(accepted, current, {
        actor, childId: child.id, assertion, consentVersion: 1, now, requestId
      }),
      db
    );
    const state = repositories.guardianConsents.activatePrivacyState({
      familyId: actor.familyId,
      childId: child.id,
      expectedRevision: 0,
      reasonCode: 'guardian_consent_recorded',
      updatedAt: iso(now),
      activatedAt: iso(now)
    }, db);
    if (!state) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    completeIdempotency(db, {
      id: idempotencyId,
      resourceId: consent.id,
      resultRevision: state.revision,
      responseStatus: 201,
      now
    });
    return {
      status: 201,
      body: buildConsentResult(db, actor.familyId, consent.id, { includeChild: true })
    };
  });
}

function childForConsent(db, actor, childId) {
  const child = repositories.guardianConsents.findChildInFamily({
    familyId: actor.familyId, childId
  }, db);
  if (!child) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
  const state = repositories.guardianConsents.getPrivacyState({
    familyId: actor.familyId, childId
  }, db);
  if (!state) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
  return { child, state };
}

function recordConsent({ actor, childId, body, idempotencyKey, requestId, now = new Date() }) {
  assertEnrollmentEnabled();
  const accepted = parseLegalAcceptance(body);
  const expectedRevision = requireRevision(body.expectedRevision);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'child_consent',
    childId,
    expectedRevision,
    guardianRelation: accepted.guardianRelation,
    relationDeclaration: accepted.relationDeclaration,
    consents: accepted.consents,
    reauthAssertionHash: sha256(accepted.reauthAssertion)
  });
  return inTransaction(db => {
    const replay = idempotencyReplay(db, {
      actor, operation: 'child_consent', keyHash, requestFingerprint
    });
    if (replay) {
      return {
        status: 200,
        body: buildConsentResult(db, actor.familyId, replay.resourceId, {
          expectedStateRevision: replay.resultRevision
        })
      };
    }
    const { state } = childForConsent(db, actor, childId);
    if (['deletion_pending', 'deidentified', 'deleted'].includes(state.status)) {
      fail(409, 'CHILD_PROCESSING_BLOCKED', '当前儿童档案不能重新激活');
    }
    if (state.revision !== expectedRevision) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    const current = currentLegalEvidence(iso(now), db);
    assertCurrentAcceptance(accepted, current);
    const assertion = consumeAssertion(db, {
      actor, rawToken: accepted.reauthAssertion, purpose: 'child_consent', now
    });
    const idempotencyId = startIdempotency(db, {
      actor, operation: 'child_consent', keyHash, requestFingerprint, now
    });
    const history = repositories.guardianConsents.listGuardianConsents({
      familyId: actor.familyId, childId, guardianId: actor.id
    }, db);
    const previous = history[0] || null;
    if (previous && previous.status === 'active') {
      const changed = repositories.guardianConsents.supersedeConsent({
        familyId: actor.familyId,
        consentId: previous.id,
        expectedLifecycleRevision: previous.lifecycleRevision,
        supersededAt: iso(now),
        updatedAt: iso(now)
      }, db);
      if (!changed) fail(409, 'REVISION_CONFLICT', '授权状态已变化');
    }
    const consent = repositories.guardianConsents.insertConsent(
      consentEvidence(accepted, current, {
        actor,
        childId,
        assertion,
        consentVersion: previous ? previous.consentVersion + 1 : 1,
        supersedesConsentId: previous && previous.id,
        now,
        requestId
      }),
      db
    );
    const hasWithdrawalHold = repositories.guardianConsents.hasOutstandingWithdrawalHold({
      familyId: actor.familyId,
      childId
    }, db);
    const resultingState = hasWithdrawalHold
      ? repositories.guardianConsents.getPrivacyState({ familyId: actor.familyId, childId }, db)
      : repositories.guardianConsents.activatePrivacyState({
          familyId: actor.familyId,
          childId,
          expectedRevision,
          reasonCode: 'guardian_consent_recorded',
          updatedAt: iso(now),
          activatedAt: iso(now)
        }, db);
    if (!resultingState) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    completeIdempotency(db, {
      id: idempotencyId,
      resourceId: consent.id,
      resultRevision: resultingState.revision,
      responseStatus: 201,
      now
    });
    return { status: 201, body: buildConsentResult(db, actor.familyId, consent.id) };
  });
}

function listConsents({ actor, childId }) {
  const db = getDb();
  childForConsent(db, actor, childId);
  const rows = repositories.guardianConsents.listGuardianConsents({
    familyId: actor.familyId, childId, guardianId: actor.id
  }, db);
  if (!rows.length) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
  return { success: true, consents: rows.map(serializeConsent) };
}

function withdrawConsent({ actor, childId, body, idempotencyKey, now = new Date() }) {
  if (!isPlainObject(body)) fail(400, 'VALIDATION_ERROR', '请求体必须是对象');
  const rawAssertion = requireText(body.reauthAssertion, {
    field: 'reauthAssertion', min: 32, max: 256
  });
  const expectedRevision = requireRevision(body.expectedRevision);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'child_consent_withdraw',
    childId,
    expectedRevision,
    reauthAssertionHash: sha256(rawAssertion)
  });
  return inTransaction(db => {
    const replay = idempotencyReplay(db, {
      actor, operation: 'child_consent_withdraw', keyHash, requestFingerprint
    });
    if (replay) {
      return {
        status: 200,
        body: buildConsentResult(db, actor.familyId, replay.resourceId, {
          expectedStateRevision: replay.resultRevision
        })
      };
    }
    const { state } = childForConsent(db, actor, childId);
    if (state.revision !== expectedRevision) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    const active = repositories.guardianConsents.findActiveConsent({
      familyId: actor.familyId, childId, guardianId: actor.id
    }, db);
    if (!active) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
    consumeAssertion(db, {
      actor, rawToken: rawAssertion, purpose: 'child_consent_withdraw', now
    });
    const idempotencyId = startIdempotency(db, {
      actor, operation: 'child_consent_withdraw', keyHash, requestFingerprint, now
    });
    const withdrawn = repositories.guardianConsents.withdrawConsent({
      familyId: actor.familyId,
      consentId: active.id,
      expectedLifecycleRevision: active.lifecycleRevision,
      withdrawnAt: iso(now),
      updatedAt: iso(now)
    }, db);
    if (!withdrawn) fail(409, 'REVISION_CONFLICT', '授权状态已变化');
    const blocked = repositories.guardianConsents.blockPrivacyState({
      familyId: actor.familyId,
      childId,
      expectedRevision,
      reasonCode: 'guardian_consent_withdrawn',
      updatedAt: iso(now),
      blockedAt: iso(now)
    }, db);
    if (!blocked) fail(409, 'REVISION_CONFLICT', '儿童隐私状态已变化');
    devicePairingSessions.revokeForChild(db, {
      familyId: actor.familyId,
      childId,
      revokedAt: iso(now),
      reason: 'guardian_consent_withdrawn'
    });
    completeIdempotency(db, {
      id: idempotencyId,
      resourceId: active.id,
      resultRevision: blocked.revision,
      responseStatus: 200,
      now
    });
    return { status: 200, body: buildConsentResult(db, actor.familyId, active.id) };
  });
}

module.exports = {
  publicLegalTexts,
  issueReauthAssertion,
  enrollChild,
  listConsents,
  recordConsent,
  withdrawConsent,
  serializeConsent,
  serializePrivacyState,
  normalizeIdempotencyKey
};
