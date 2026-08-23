const crypto = require('crypto');

const config = require('../config/device-sessions');
const features = require('../config/features');
const { getDb, inTransaction } = require('../db/connection');
const repositories = require('../db/repositories');
const { ApiError } = require('../lib/api-error');
const credentials = require('../lib/device-credentials');
const { isPlainObject } = require('../lib/validation');

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const CHILD_ID = /^[A-Za-z0-9_-]{2,64}$/;
const DEVICE_PUBLIC_ID = /^[A-Za-z0-9_-]{22,86}$/;
const SHORT_CODE = /^\d{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function iso(date) {
  return date.toISOString();
}

function fail(status, code, message, field) {
  throw new ApiError({ status, code, message, field });
}

function outcomeError(outcome) {
  if (outcome && outcome.error) fail(
    outcome.error.status,
    outcome.error.code,
    outcome.error.message,
    outcome.error.field
  );
  return outcome;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return credentials.sha256(Buffer.from(JSON.stringify(stable(value)), 'utf8'));
}

function requireObject(body) {
  if (!isPlainObject(body)) fail(400, 'VALIDATION_ERROR', '请求体必须是对象');
  return body;
}

function requireText(value, { field, min = 1, max = 128, pattern }) {
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', `${field}格式无效`, field);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max
      || CONTROL_CHARACTERS.test(normalized) || (pattern && !pattern.test(normalized))) {
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
  return credentials.sha256(Buffer.from(value, 'utf8'));
}

function assertPairingEnabled() {
  if (!features.isHarmonyChildEnabled() || !features.isDevicePairingEnabled()) {
    fail(403, 'FEATURE_DISABLED', '儿童设备配对当前未开放');
  }
}

function activeGuardianChild(db, actor, childId) {
  const child = repositories.guardianConsents.findChildInFamily({
    familyId: actor.familyId,
    childId
  }, db);
  if (!child) fail(404, 'CHILD_NOT_FOUND', '儿童档案不存在');
  const state = repositories.guardianConsents.getPrivacyState({
    familyId: actor.familyId,
    childId
  }, db);
  if (!state || state.status !== 'active') {
    fail(403, 'CONSENT_REQUIRED', '儿童处理授权当前无效');
  }
  const consent = repositories.guardianConsents.findActiveConsent({
    familyId: actor.familyId,
    childId,
    guardianId: actor.id
  }, db);
  if (!consent) fail(403, 'CONSENT_REQUIRED', '当前账号没有该儿童的有效监护授权');
  return { child, state, consent };
}

function parentIdempotencyReplay(db, {
  actor, operation, keyHash, requestFingerprint
}) {
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

function startParentIdempotency(db, {
  actor, operation, keyHash, requestFingerprint, now
}) {
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

function completeParentIdempotency(db, {
  id, resourceType, resourceId, resultRevision, responseStatus, now
}) {
  const completed = repositories.guardianConsents.completeIdempotency({
    id,
    resourceType,
    resourceId,
    resultRevision,
    responseStatus,
    completedAt: iso(now)
  }, db);
  if (!completed) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等请求状态已变化');
}

function serializePairing(pairing, binding) {
  const result = {
    id: pairing.id,
    childId: pairing.childId,
    status: pairing.status,
    revision: pairing.revision,
    expiresAt: pairing.expiresAt,
    createdAt: pairing.createdAt
  };
  if (pairing.claimedAt) result.claimedAt = pairing.claimedAt;
  if (pairing.confirmedAt) result.confirmedAt = pairing.confirmedAt;
  if (pairing.completedAt) result.completedAt = pairing.completedAt;
  if (binding) {
    result.claimedDevice = {
      id: binding.id,
      publicId: binding.devicePublicId,
      alias: binding.deviceAlias,
      publicKey: {
        algorithm: binding.publicKeyAlgorithm,
        sha256: binding.publicKeySha256
      },
      status: binding.status,
      revision: binding.revision
    };
  }
  return result;
}

function parentPairingResult(pairing, { includeSecrets = false } = {}) {
  const binding = pairing.claimedDeviceBindingId
    ? repositories.deviceSessions.findBindingById({ bindingId: pairing.claimedDeviceBindingId })
    : null;
  const result = { success: true, pairing: serializePairing(pairing, binding) };
  if (includeSecrets) {
    result.shortCode = credentials.deriveShortCode(pairing.id);
    result.pairingChallenge = credentials.deriveParentChallenge(pairing.id);
  }
  return result;
}

function createPairing({ actor, body, idempotencyKey, now = new Date() }) {
  assertPairingEnabled();
  requireObject(body);
  const childId = requireText(body.childId, { field: 'childId', pattern: CHILD_ID, max: 64 });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({ operation: 'device_pairing_create', childId });
  return inTransaction(db => {
    const replay = parentIdempotencyReplay(db, {
      actor, operation: 'device_pairing_create', keyHash, requestFingerprint
    });
    if (replay) {
      const pairing = repositories.deviceSessions.findPairingById({
        pairingId: replay.resourceId,
        familyId: actor.familyId
      }, db);
      if (!pairing || pairing.revision !== replay.resultRevision) {
        fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的配对状态已经变化');
      }
      return { status: 200, body: parentPairingResult(pairing, { includeSecrets: true }) };
    }
    const { consent } = activeGuardianChild(db, actor, childId);
    const idempotencyId = startParentIdempotency(db, {
      actor, operation: 'device_pairing_create', keyHash, requestFingerprint, now
    });
    let pairing;
    for (let attempt = 0; attempt < 32 && !pairing; attempt += 1) {
      const id = `pair_${crypto.randomUUID().replace(/-/g, '')}`;
      const shortCode = credentials.deriveShortCode(id);
      const existing = repositories.deviceSessions.findPairingByCodeHash({
        shortCodeHmac: credentials.shortCodeHmac(shortCode)
      }, db);
      if (existing && ['pending', 'claimed', 'confirmed'].includes(existing.status)) continue;
      pairing = repositories.deviceSessions.createPairing({
        id,
        familyId: actor.familyId,
        childId,
        issuedByGuardianId: actor.id,
        guardianConsentId: consent.id,
        parentChallengeHash: credentials.sha256(
          Buffer.from(credentials.deriveParentChallenge(id), 'utf8')
        ),
        shortCodeHmac: credentials.shortCodeHmac(shortCode),
        attemptLimit: config.deviceAttemptLimit,
        expiresAt: iso(new Date(now.getTime() + config.pairingTtlMs)),
        createdAt: iso(now),
        updatedAt: iso(now)
      }, db);
    }
    if (!pairing) fail(503, 'PAIRING_CODE_UNAVAILABLE', '暂时无法生成配对码，请稍后重试');
    completeParentIdempotency(db, {
      id: idempotencyId,
      resourceType: 'pairing_challenge',
      resourceId: pairing.id,
      resultRevision: pairing.revision,
      responseStatus: 201,
      now
    });
    return { status: 201, body: parentPairingResult(pairing, { includeSecrets: true }) };
  });
}

function getPairing({ actor, pairingId }) {
  const id = requireText(pairingId, { field: 'pairingId', pattern: RESOURCE_ID, max: 128 });
  const db = getDb();
  const pairing = repositories.deviceSessions.findPairingById({
    pairingId: id,
    familyId: actor.familyId
  }, db);
  if (!pairing || pairing.issuedByGuardianId !== actor.id) {
    fail(404, 'PAIRING_NOT_FOUND', '设备配对不存在');
  }
  activeGuardianChild(db, actor, pairing.childId);
  const binding = pairing.claimedDeviceBindingId
    ? repositories.deviceSessions.findBindingById({ bindingId: pairing.claimedDeviceBindingId }, db)
    : null;
  return { success: true, pairing: serializePairing(pairing, binding) };
}

function proofResult(challenge, binding, claimToken) {
  const rawChallenge = credentials.deriveProofChallenge(challenge.id);
  const payload = credentials.signingPayload({
    purpose: challenge.purpose,
    challengeId: challenge.id,
    challenge: rawChallenge,
    deviceBindingId: binding.id,
    sessionId: challenge.deviceSessionId || ''
  });
  return {
    success: true,
    ...(claimToken ? { claimId: claimToken } : {}),
    proof: {
      algorithm: credentials.DEVICE_KEY_ALGORITHM,
      challengeId: challenge.id,
      challenge: rawChallenge,
      signingPayload: payload.toString('base64url'),
      expiresAt: challenge.expiresAt
    }
  };
}

function proofFailureReplay(challenge, keyHash, requestFingerprint) {
  if (!['pending', 'locked'].includes(challenge.status)
      || challenge.lastFailureIdempotencyKeyHash !== keyHash) return null;
  if (challenge.lastFailureRequestFingerprint !== requestFingerprint) {
    return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: '该幂等键已用于不同请求' };
  }
  return challenge.status === 'locked'
    ? { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' }
    : { status: 403, code: 'DEVICE_PROOF_INVALID', message: '设备签名验证失败' };
}

function attemptSubjects({ networkKey, devicePublicId, publicKeySha256 }) {
  return [
    {
      scope: 'network',
      subjectHmac: credentials.hmac('pairing-attempt-network', networkKey || 'unknown'),
      attemptLimit: config.networkAttemptLimit
    },
    {
      scope: 'device',
      subjectHmac: credentials.hmac(
        'pairing-attempt-device',
        `${devicePublicId}:${publicKeySha256}`
      ),
      attemptLimit: config.deviceAttemptLimit
    }
  ];
}

function lockedAttempt(db, subjects, nowIso) {
  return subjects.some(subject => {
    const row = repositories.deviceSessions.getAttemptWindow(subject, db);
    return row && row.lockedUntil && row.lockedUntil > nowIso;
  });
}

function recordClaimFailure(db, {
  subjects, keyHash, requestFingerprint, now
}) {
  const nowIso = iso(now);
  return subjects.map(subject => repositories.deviceSessions.recordAttemptFailure({
    ...subject,
    idempotencyKeyHash: keyHash,
    requestFingerprint,
    now: nowIso,
    windowMs: config.pairingAttemptWindowMs,
    lockMs: config.pairingAttemptLockMs
  }, db));
}

function claimPairing({ body, idempotencyKey, networkKey, now = new Date() }) {
  assertPairingEnabled();
  requireObject(body);
  const shortCode = requireText(body.shortCode, {
    field: 'shortCode', min: 6, max: 6, pattern: SHORT_CODE
  });
  const devicePublicId = requireText(body.devicePublicId, {
    field: 'devicePublicId', min: 22, max: 86, pattern: DEVICE_PUBLIC_ID
  });
  const deviceAlias = requireText(body.deviceAlias, {
    field: 'deviceAlias', min: 1, max: 40
  });
  let publicKey;
  try {
    publicKey = credentials.parseDevicePublicKey(body.publicKey);
  } catch (_) {
    fail(400, 'DEVICE_KEY_INVALID', '设备公钥格式无效', 'publicKey');
  }
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const codeHmac = credentials.shortCodeHmac(shortCode);
  const requestFingerprint = fingerprint({
    operation: 'device_pairing_claim',
    codeHmac,
    devicePublicId,
    deviceAlias,
    publicKeyAlgorithm: publicKey.algorithm,
    publicKeySha256: publicKey.sha256
  });
  const subjects = attemptSubjects({
    networkKey,
    devicePublicId,
    publicKeySha256: publicKey.sha256
  });
  const outcome = inTransaction(db => {
    const nowIso = iso(now);
    repositories.deviceSessions.pruneAttemptWindows({
      staleBefore: iso(new Date(
        now.getTime() - config.pairingAttemptWindowMs - config.pairingAttemptLockMs
      )),
      now: nowIso,
      maxRows: config.pairingAttemptMaxRows,
      reserveRows: subjects.length,
      preserveSubjectHmac: subjects.map(subject => subject.subjectHmac)
    }, db);
    if (lockedAttempt(db, subjects, nowIso)) {
      return { error: { status: 423, code: 'PAIRING_LOCKED', message: '配对尝试已锁定，请稍后重试' } };
    }
    const pairing = repositories.deviceSessions.findPairingByCodeHash({ shortCodeHmac: codeHmac }, db);
    if (!pairing) {
      const windows = recordClaimFailure(db, { subjects, keyHash, requestFingerprint, now });
      const locked = windows.some(row => row.lockedUntil && row.lockedUntil > nowIso);
      return { error: locked
        ? { status: 423, code: 'PAIRING_LOCKED', message: '配对尝试已锁定，请稍后重试' }
        : { status: 404, code: 'PAIRING_CODE_INVALID', message: '配对码无效或不可用' } };
    }
    if (pairing.expiresAt <= nowIso && ['pending', 'claimed', 'confirmed'].includes(pairing.status)) {
      repositories.deviceSessions.expirePairing({ pairingId: pairing.id, updatedAt: nowIso }, db);
      return { error: { status: 410, code: 'PAIRING_EXPIRED', message: '配对码已过期' } };
    }
    if (pairing.status === 'expired') {
      return { error: { status: 410, code: 'PAIRING_EXPIRED', message: '配对码已过期' } };
    }
    if (pairing.status === 'locked') {
      return { error: { status: 423, code: 'PAIRING_LOCKED', message: '配对码已锁定' } };
    }
    const exactClaim = pairing.claimIdempotencyKeyHash === keyHash
      && pairing.claimRequestFingerprint === requestFingerprint;
    if (pairing.status === 'cancelled' && exactClaim) {
      const terminalChallenge = repositories.deviceSessions.findPairingChallenge({
        pairingId: pairing.id
      }, db);
      if (terminalChallenge && terminalChallenge.status === 'expired') {
        return { error: { status: 410, code: 'CHALLENGE_EXPIRED', message: '设备签名挑战已过期' } };
      }
      if (terminalChallenge && terminalChallenge.status === 'locked') {
        return { error: { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' } };
      }
      return { error: { status: 409, code: 'PAIRING_STATE_CONFLICT', message: '设备配对状态已变化' } };
    }
    if (pairing.status === 'claimed' || pairing.status === 'confirmed') {
      if (!exactClaim) {
        recordClaimFailure(db, { subjects, keyHash, requestFingerprint, now });
        return { error: { status: 404, code: 'PAIRING_CODE_INVALID', message: '配对码无效或不可用' } };
      }
      const binding = repositories.deviceSessions.findBindingById({
        bindingId: pairing.claimedDeviceBindingId
      }, db);
      const challenge = repositories.deviceSessions.findPairingChallenge({ pairingId: pairing.id }, db);
      if (!binding || !challenge) {
        return { error: { status: 409, code: 'IDEMPOTENCY_RESULT_UNAVAILABLE', message: '配对申领结果暂不可用' } };
      }
      if (challenge.expiresAt <= nowIso || challenge.status === 'expired') {
        if (challenge.status === 'pending') {
          repositories.deviceSessions.expireChallenge({
            challengeId: challenge.id,
            updatedAt: nowIso
          }, db);
        }
        return { error: { status: 410, code: 'CHALLENGE_EXPIRED', message: '设备签名挑战已过期' } };
      }
      if (challenge.status === 'locked') {
        return { error: { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' } };
      }
      if (challenge.status !== 'pending' || binding.status !== 'pending') {
        return { error: { status: 409, code: 'PAIRING_STATE_CONFLICT', message: '设备配对状态已变化' } };
      }
      return {
        status: 200,
        body: proofResult(
          challenge,
          binding,
          credentials.deriveClaimToken(pairing.id, keyHash)
        )
      };
    }
    if (pairing.status !== 'pending') {
      return { error: { status: 404, code: 'PAIRING_CODE_INVALID', message: '配对码无效或不可用' } };
    }
    const state = repositories.guardianConsents.getPrivacyState({
      familyId: pairing.familyId,
      childId: pairing.childId
    }, db);
    const consent = repositories.guardianConsents.findConsentById({
      familyId: pairing.familyId,
      consentId: pairing.guardianConsentId
    }, db);
    if (!state || state.status !== 'active' || !consent || consent.status !== 'active') {
      return { error: { status: 404, code: 'PAIRING_CODE_INVALID', message: '配对码无效或不可用' } };
    }
    const bindingId = `device_${crypto.randomUUID().replace(/-/g, '')}`;
    const claimToken = credentials.deriveClaimToken(pairing.id, keyHash);
    const claimed = repositories.deviceSessions.claimPairing({
      pairingId: pairing.id,
      claimTokenHash: credentials.digestCredential(claimToken),
      claimIdempotencyKeyHash: keyHash,
      claimRequestFingerprint: requestFingerprint,
      claimedDeviceBindingId: bindingId,
      claimedAt: nowIso,
      updatedAt: nowIso,
      expectedRevision: pairing.revision
    }, db);
    if (!claimed) {
      return { error: { status: 409, code: 'PAIRING_STATE_CONFLICT', message: '配对状态已变化' } };
    }
    const binding = repositories.deviceSessions.createBinding({
      id: bindingId,
      familyId: pairing.familyId,
      childId: pairing.childId,
      authorizedByConsentId: pairing.guardianConsentId,
      pairingChallengeId: pairing.id,
      createdByGuardianId: pairing.issuedByGuardianId,
      devicePublicId,
      publicKeyAlgorithm: publicKey.algorithm,
      devicePublicKeySpki: publicKey.spkiBase64url,
      publicKeySha256: publicKey.sha256,
      deviceAlias,
      claimedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso
    }, db);
    const challengeId = `proof_${crypto.randomUUID().replace(/-/g, '')}`;
    const rawChallenge = credentials.deriveProofChallenge(challengeId);
    const challenge = repositories.deviceSessions.createChallenge({
      id: challengeId,
      familyId: pairing.familyId,
      childId: pairing.childId,
      deviceBindingId: binding.id,
      pairingChallengeId: pairing.id,
      purpose: 'pairing_completion',
      challengeHash: credentials.sha256(Buffer.from(rawChallenge, 'utf8')),
      issueIdempotencyKeyHash: keyHash,
      issueRequestFingerprint: requestFingerprint,
      attemptLimit: config.proofAttemptLimit,
      issuedAt: nowIso,
      expiresAt: iso(new Date(now.getTime() + config.pairingProofTtlMs)),
      createdAt: nowIso,
      updatedAt: nowIso
    }, db);
    return { status: 202, body: proofResult(challenge, binding, claimToken) };
  });
  return outcomeError(outcome);
}

function confirmPairing({ actor, pairingId, body, idempotencyKey, now = new Date() }) {
  assertPairingEnabled();
  requireObject(body);
  const id = requireText(pairingId, { field: 'pairingId', pattern: RESOURCE_ID, max: 128 });
  const expectedRevision = requireRevision(body.expectedRevision);
  const parentChallenge = requireText(body.pairingChallenge, {
    field: 'pairingChallenge', min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/
  });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'device_pairing_confirm',
    pairingId: id,
    expectedRevision,
    parentChallengeHash: credentials.sha256(Buffer.from(parentChallenge, 'utf8'))
  });
  const outcome = inTransaction(db => {
    const replay = parentIdempotencyReplay(db, {
      actor, operation: 'device_pairing_confirm', keyHash, requestFingerprint
    });
    if (replay) {
      const pairing = repositories.deviceSessions.findPairingById({
        pairingId: replay.resourceId,
        familyId: actor.familyId
      }, db);
      if (!pairing || pairing.revision !== replay.resultRevision) {
        fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的配对状态已经变化');
      }
      const binding = repositories.deviceSessions.findBindingByPairingId({ pairingId: pairing.id }, db);
      return { status: 200, body: { success: true, pairing: serializePairing(pairing, binding) } };
    }
    const pairing = repositories.deviceSessions.findPairingById({
      pairingId: id,
      familyId: actor.familyId
    }, db);
    if (!pairing || pairing.issuedByGuardianId !== actor.id) {
      fail(404, 'PAIRING_NOT_FOUND', '设备配对不存在');
    }
    activeGuardianChild(db, actor, pairing.childId);
    if (pairing.expiresAt <= iso(now)) {
      repositories.deviceSessions.expirePairing({ pairingId: id, updatedAt: iso(now) }, db);
      return { error: { status: 410, code: 'PAIRING_EXPIRED', message: '配对码已过期' } };
    }
    const suppliedHash = credentials.sha256(Buffer.from(parentChallenge, 'utf8'));
    if (!credentials.timingSafeHexEqual(suppliedHash, pairing.parentChallengeHash)) {
      fail(403, 'PAIRING_CHALLENGE_INVALID', '家长配对确认凭据无效');
    }
    if (pairing.status !== 'claimed' || pairing.revision !== expectedRevision) {
      fail(409, 'REVISION_CONFLICT', '配对状态已变化');
    }
    const idempotencyId = startParentIdempotency(db, {
      actor, operation: 'device_pairing_confirm', keyHash, requestFingerprint, now
    });
    const confirmed = repositories.deviceSessions.confirmPairing({
      pairingId: id,
      familyId: actor.familyId,
      guardianId: actor.id,
      expectedRevision,
      confirmedAt: iso(now),
      updatedAt: iso(now)
    }, db);
    if (!confirmed) fail(409, 'REVISION_CONFLICT', '配对状态已变化');
    completeParentIdempotency(db, {
      id: idempotencyId,
      resourceType: 'pairing_challenge',
      resourceId: confirmed.id,
      resultRevision: confirmed.revision,
      responseStatus: 200,
      now
    });
    const binding = repositories.deviceSessions.findBindingByPairingId({ pairingId: id }, db);
    return { status: 200, body: { success: true, pairing: serializePairing(confirmed, binding) } };
  });
  return outcomeError(outcome);
}

function sessionCredentials(session) {
  return {
    id: session.id,
    accessToken: credentials.deriveAccessToken(session.id),
    accessExpiresAt: session.accessExpiresAt,
    refreshToken: credentials.deriveRefreshToken(session.id),
    refreshExpiresAt: session.refreshExpiresAt,
    rotationCounter: session.rotationCounter
  };
}

function serializeDevice(binding) {
  return {
    id: binding.id,
    childId: binding.childId,
    publicId: binding.devicePublicId,
    alias: binding.deviceAlias,
    publicKey: {
      algorithm: binding.publicKeyAlgorithm,
      sha256: binding.publicKeySha256
    },
    status: binding.status,
    revision: binding.revision,
    claimedAt: binding.claimedAt,
    ...(binding.activatedAt ? { activatedAt: binding.activatedAt } : {}),
    ...(binding.revokedAt ? { revokedAt: binding.revokedAt } : {})
  };
}

function completionResult(binding, session) {
  return {
    success: true,
    device: serializeDevice(binding),
    session: sessionCredentials(session)
  };
}

function completePairing({ claimToken, body, idempotencyKey, now = new Date() }) {
  assertPairingEnabled();
  requireObject(body);
  const signatureBase64url = requireText(body.signatureBase64url, {
    field: 'signatureBase64url', min: 80, max: 120, pattern: /^[A-Za-z0-9_-]+$/
  });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const claimTokenHash = credentials.digestCredential(claimToken);
  const requestFingerprint = fingerprint({
    operation: 'device_pairing_complete',
    claimTokenHash,
    signatureHash: credentials.sha256(Buffer.from(signatureBase64url, 'utf8'))
  });
  const outcome = inTransaction(db => {
    const nowIso = iso(now);
    const pairing = repositories.deviceSessions.findPairingByClaimHash({ claimTokenHash }, db);
    if (!pairing) {
      return { error: { status: 401, code: 'PAIRING_CLAIM_INVALID', message: '设备配对申领凭据无效' } };
    }
    const binding = repositories.deviceSessions.findBindingById({
      bindingId: pairing.claimedDeviceBindingId
    }, db);
    const challenge = repositories.deviceSessions.findPairingChallenge({ pairingId: pairing.id }, db);
    if (!binding || !challenge) {
      return { error: { status: 409, code: 'PAIRING_STATE_CONFLICT', message: '设备配对状态不完整' } };
    }
    if (challenge.status === 'consumed') {
      if (challenge.completionIdempotencyKeyHash !== keyHash
          || challenge.completionRequestFingerprint !== requestFingerprint) {
        return { error: { status: 409, code: 'CHALLENGE_REPLAYED', message: '设备签名挑战已使用' } };
      }
      if (Date.parse(challenge.consumedAt) + config.idempotencyReplayTtlMs <= now.getTime()) {
        return { error: { status: 409, code: 'IDEMPOTENCY_REPLAY_STALE', message: '设备配对幂等重试窗口已结束' } };
      }
      const session = repositories.deviceSessions.findSessionById({
        sessionId: challenge.resultSessionId
      }, db);
      if (!session || session.status !== 'active') {
        return { error: { status: 409, code: 'IDEMPOTENCY_REPLAY_STALE', message: '幂等结果对应的设备会话已经变化' } };
      }
      return { status: 200, body: completionResult(binding, session) };
    }
    const failureReplay = proofFailureReplay(challenge, keyHash, requestFingerprint);
    if (failureReplay) return { error: failureReplay };
    if (challenge.status === 'locked') {
      return { error: { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' } };
    }
    if (pairing.expiresAt <= nowIso || challenge.expiresAt <= nowIso) {
      if (pairing.expiresAt <= nowIso) {
        repositories.deviceSessions.expirePairing({ pairingId: pairing.id, updatedAt: nowIso }, db);
      }
      if (challenge.expiresAt <= nowIso) {
        repositories.deviceSessions.expireChallenge({ challengeId: challenge.id, updatedAt: nowIso }, db);
      }
      return { error: { status: 410, code: 'CHALLENGE_EXPIRED', message: '设备签名挑战已过期' } };
    }
    if (pairing.status !== 'confirmed' || binding.status !== 'pending') {
      return { error: { status: 409, code: 'PAIRING_STATE_CONFLICT', message: '配对尚未获得家长确认' } };
    }
    const state = repositories.guardianConsents.getPrivacyState({
      familyId: pairing.familyId,
      childId: pairing.childId
    }, db);
    const consent = repositories.guardianConsents.findActiveConsent({
      familyId: pairing.familyId,
      childId: pairing.childId,
      guardianId: pairing.issuedByGuardianId
    }, db);
    if (!state || state.status !== 'active' || !consent) {
      return { error: { status: 403, code: 'CONSENT_REQUIRED', message: '儿童处理授权当前无效' } };
    }
    const rawChallenge = credentials.deriveProofChallenge(challenge.id);
    const payload = credentials.signingPayload({
      purpose: challenge.purpose,
      challengeId: challenge.id,
      challenge: rawChallenge,
      deviceBindingId: binding.id
    });
    if (!credentials.verifyDeviceSignature({
      publicKeySpki: binding.devicePublicKeySpki,
      payload,
      signatureBase64url
    })) {
      const failed = repositories.deviceSessions.failChallenge({
        challengeId: challenge.id,
        idempotencyKeyHash: keyHash,
        requestFingerprint,
        updatedAt: nowIso
      }, db);
      return { error: failed && failed.status === 'locked'
        ? { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' }
        : { status: 403, code: 'DEVICE_PROOF_INVALID', message: '设备签名验证失败' } };
    }
    const alreadyBound = repositories.deviceSessions.findActiveBindingByIdentity({
      excludeBindingId: binding.id,
      devicePublicId: binding.devicePublicId,
      publicKeySha256: binding.publicKeySha256
    }, db);
    if (alreadyBound) {
      return { error: { status: 409, code: 'DEVICE_ALREADY_BOUND', message: '该设备已存在有效绑定' } };
    }
    let activated;
    try {
      activated = repositories.deviceSessions.activateBinding({
        bindingId: binding.id,
        expectedRevision: binding.revision,
        activatedAt: nowIso,
        updatedAt: nowIso
      }, db);
    } catch (error) {
      if (error && (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067)
          && /device_bindings\.(device_public_id|public_key_sha256)/.test(error.message)) {
        return { error: { status: 409, code: 'DEVICE_ALREADY_BOUND', message: '该设备已存在有效绑定' } };
      }
      throw error;
    }
    if (!activated) fail(409, 'REVISION_CONFLICT', '设备绑定状态已变化');
    const completed = repositories.deviceSessions.completePairing({
      pairingId: pairing.id,
      expectedRevision: pairing.revision,
      completedAt: nowIso,
      updatedAt: nowIso
    }, db);
    if (!completed) fail(409, 'REVISION_CONFLICT', '配对状态已变化');
    const sessionId = `session_${crypto.randomUUID().replace(/-/g, '')}`;
    const accessToken = credentials.deriveAccessToken(sessionId);
    const refreshToken = credentials.deriveRefreshToken(sessionId);
    const session = repositories.deviceSessions.createSession({
      id: sessionId,
      familyId: pairing.familyId,
      childId: pairing.childId,
      deviceBindingId: binding.id,
      tokenFamilyId: `token_family_${crypto.randomUUID().replace(/-/g, '')}`,
      rotationCounter: 0,
      accessTokenHash: credentials.digestCredential(accessToken),
      refreshTokenHash: credentials.digestCredential(refreshToken),
      issuedAt: nowIso,
      accessExpiresAt: iso(new Date(now.getTime() + config.accessTokenTtlMs)),
      refreshExpiresAt: iso(new Date(now.getTime() + config.refreshTokenTtlMs)),
      createdAt: nowIso,
      updatedAt: nowIso
    }, db);
    const consumed = repositories.deviceSessions.consumeChallenge({
      challengeId: challenge.id,
      expectedRevision: challenge.revision,
      consumedAt: nowIso,
      completionIdempotencyKeyHash: keyHash,
      completionRequestFingerprint: requestFingerprint,
      resultSessionId: session.id,
      updatedAt: nowIso
    }, db);
    if (!consumed) fail(409, 'CHALLENGE_REPLAYED', '设备签名挑战已使用');
    return { status: 201, body: completionResult(activated, session) };
  });
  return outcomeError(outcome);
}

function listDevices({ actor }) {
  const db = getDb();
  const bindings = repositories.deviceSessions.listBindingsForGuardian({
    familyId: actor.familyId,
    guardianId: actor.id
  }, db);
  return {
    success: true,
    devices: bindings.map(binding => ({
      ...serializeDevice(binding),
      sessions: repositories.deviceSessions.listSessionsForBinding({ bindingId: binding.id }, db)
        .map(session => ({
          id: session.id,
          status: session.status,
          revision: session.revision,
          rotationCounter: session.rotationCounter,
          issuedAt: session.issuedAt,
          accessExpiresAt: session.accessExpiresAt,
          refreshExpiresAt: session.refreshExpiresAt
        }))
    }))
  };
}

function revokeDevice({ actor, bindingId, body, idempotencyKey, now = new Date() }) {
  requireObject(body);
  const id = requireText(bindingId, { field: 'deviceId', pattern: RESOURCE_ID, max: 128 });
  const expectedRevision = requireRevision(body.expectedRevision);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'device_binding_revoke', bindingId: id, expectedRevision
  });
  return inTransaction(db => {
    const replay = parentIdempotencyReplay(db, {
      actor, operation: 'device_binding_revoke', keyHash, requestFingerprint
    });
    if (replay) {
      const binding = repositories.deviceSessions.findBindingById({
        bindingId: replay.resourceId,
        familyId: actor.familyId
      }, db);
      if (!binding || binding.revision !== replay.resultRevision) {
        fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的设备状态已经变化');
      }
      return { status: 200, body: { success: true, device: serializeDevice(binding) } };
    }
    const binding = repositories.deviceSessions.findBindingById({
      bindingId: id,
      familyId: actor.familyId
    }, db);
    if (!binding) fail(404, 'DEVICE_NOT_FOUND', '设备不存在');
    activeGuardianChild(db, actor, binding.childId);
    if (binding.status === 'revoked' || binding.revision !== expectedRevision) {
      fail(409, 'REVISION_CONFLICT', '设备状态已变化');
    }
    const idempotencyId = startParentIdempotency(db, {
      actor, operation: 'device_binding_revoke', keyHash, requestFingerprint, now
    });
    const revoked = repositories.deviceSessions.revokeBinding({
      bindingId: id,
      familyId: actor.familyId,
      expectedRevision,
      revokedAt: iso(now),
      updatedAt: iso(now),
      revokeReason: 'guardian_device_revoked'
    }, db);
    if (!revoked) fail(409, 'REVISION_CONFLICT', '设备状态已变化');
    completeParentIdempotency(db, {
      id: idempotencyId,
      resourceType: 'device_binding',
      resourceId: revoked.id,
      resultRevision: revoked.revision,
      responseStatus: 200,
      now
    });
    return { status: 200, body: { success: true, device: serializeDevice(revoked) } };
  });
}

function validSessionContext(db, session) {
  const context = repositories.deviceSessions.activeDeviceContext({ sessionId: session.id }, db);
  if (!context || context.bindingStatus !== 'active' || context.privacyStatus !== 'active') return null;
  const consent = repositories.guardianConsents.findActiveConsent({
    familyId: session.familyId,
    childId: session.childId,
    guardianId: context.createdByGuardianId
  }, db);
  return consent ? context : null;
}

function issueSessionChallenge({
  refreshToken, bindingId, idempotencyKey, now = new Date()
}) {
  assertPairingEnabled();
  const id = requireText(bindingId, { field: 'deviceId', pattern: RESOURCE_ID, max: 128 });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const refreshTokenHash = credentials.digestCredential(refreshToken);
  const requestFingerprint = fingerprint({
    operation: 'device_session_challenge', bindingId: id, refreshTokenHash
  });
  const outcome = inTransaction(db => {
    const nowIso = iso(now);
    const session = repositories.deviceSessions.findSessionByRefreshHash({ refreshTokenHash }, db);
    if (!session || session.deviceBindingId !== id) {
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    const existing = repositories.deviceSessions.findIssuedSessionChallenge({
      bindingId: session.deviceBindingId,
      idempotencyKeyHash: keyHash
    }, db);
    if (existing && existing.issueRequestFingerprint !== requestFingerprint) {
      return { error: { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: '该幂等键已用于不同请求' } };
    }
    if (existing && session.status === 'rotated') {
      const resultSession = repositories.deviceSessions.findSessionGeneration({
        tokenFamilyId: session.tokenFamilyId,
        rotationCounter: session.rotationCounter + 1
      }, db);
      if (resultSession && resultSession.status === 'active'
          && validSessionContext(db, resultSession)) {
        return { error: { status: 409, code: 'IDEMPOTENCY_REPLAY_STALE', message: '设备会话挑战已完成' } };
      }
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    if (existing && session.status === 'revoked') {
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    if (session.status !== 'active') {
      repositories.deviceSessions.revokeTokenFamily({
        tokenFamilyId: session.tokenFamilyId,
        revokedAt: nowIso,
        updatedAt: nowIso,
        revokeReason: 'refresh_token_reuse'
      }, db);
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '检测到旧刷新凭据重用，会话组已撤销' } };
    }
    if (session.refreshExpiresAt <= nowIso || !validSessionContext(db, session)) {
      repositories.deviceSessions.revokeTokenFamily({
        tokenFamilyId: session.tokenFamilyId,
        revokedAt: nowIso,
        updatedAt: nowIso,
        revokeReason: 'session_context_invalid'
      }, db);
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    if (Date.parse(session.accessExpiresAt) - now.getTime() > config.refreshEligibilityWindowMs) {
      return { error: { status: 409, code: 'REFRESH_TOO_EARLY', message: '设备访问凭据尚未进入刷新窗口' } };
    }
    const binding = repositories.deviceSessions.findBindingById({ bindingId: id }, db);
    if (existing) {
      if (existing.status === 'locked') {
        return { error: { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' } };
      }
      if (existing.expiresAt <= nowIso || existing.status === 'expired') {
        if (existing.status === 'pending') {
          repositories.deviceSessions.expireChallenge({
            challengeId: existing.id,
            updatedAt: nowIso
          }, db);
        }
        return { error: { status: 410, code: 'CHALLENGE_EXPIRED', message: '设备会话挑战已过期' } };
      }
      if (existing.status !== 'pending') {
        return { error: { status: 409, code: 'CHALLENGE_REPLAYED', message: '设备会话挑战不可重放' } };
      }
      return { status: 200, body: proofResult(existing, binding) };
    }
    const pending = repositories.deviceSessions.findPendingSessionChallenge({
      sessionId: session.id
    }, db);
    if (pending && pending.expiresAt <= nowIso) {
      repositories.deviceSessions.expireChallenge({
        challengeId: pending.id,
        updatedAt: nowIso
      }, db);
    } else if (pending) {
      return { error: { status: 409, code: 'CHALLENGE_ALREADY_PENDING', message: '设备会话已有待完成挑战' } };
    }
    const challengeId = `refresh_proof_${crypto.randomUUID().replace(/-/g, '')}`;
    const rawChallenge = credentials.deriveProofChallenge(challengeId);
    const challenge = repositories.deviceSessions.createChallenge({
      id: challengeId,
      familyId: session.familyId,
      childId: session.childId,
      deviceBindingId: session.deviceBindingId,
      deviceSessionId: session.id,
      purpose: 'session_refresh',
      challengeHash: credentials.sha256(Buffer.from(rawChallenge, 'utf8')),
      issueIdempotencyKeyHash: keyHash,
      issueRequestFingerprint: requestFingerprint,
      attemptLimit: config.proofAttemptLimit,
      issuedAt: nowIso,
      expiresAt: iso(new Date(now.getTime() + config.sessionChallengeTtlMs)),
      createdAt: nowIso,
      updatedAt: nowIso
    }, db);
    return { status: 201, body: proofResult(challenge, binding) };
  });
  return outcomeError(outcome);
}

function refreshSession({ refreshToken, body, idempotencyKey, now = new Date() }) {
  assertPairingEnabled();
  requireObject(body);
  const challengeId = requireText(body.challengeId, {
    field: 'challengeId', pattern: RESOURCE_ID, max: 128
  });
  const signatureBase64url = requireText(body.signatureBase64url, {
    field: 'signatureBase64url', min: 80, max: 120, pattern: /^[A-Za-z0-9_-]+$/
  });
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const refreshTokenHash = credentials.digestCredential(refreshToken);
  const requestFingerprint = fingerprint({
    operation: 'device_session_refresh',
    refreshTokenHash,
    challengeId,
    signatureHash: credentials.sha256(Buffer.from(signatureBase64url, 'utf8'))
  });
  const outcome = inTransaction(db => {
    const nowIso = iso(now);
    const session = repositories.deviceSessions.findSessionByRefreshHash({ refreshTokenHash }, db);
    if (!session) {
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    const challenge = repositories.deviceSessions.findChallengeById({ challengeId }, db);
    const challengeMatches = challenge
      && challenge.deviceSessionId === session.id
      && challenge.deviceBindingId === session.deviceBindingId
      && challenge.purpose === 'session_refresh';
    if (challengeMatches && challenge.status === 'consumed') {
      if (challenge.completionIdempotencyKeyHash === keyHash
          && challenge.completionRequestFingerprint === requestFingerprint) {
        if (Date.parse(challenge.consumedAt) + config.idempotencyReplayTtlMs <= now.getTime()) {
          repositories.deviceSessions.revokeTokenFamily({
            tokenFamilyId: session.tokenFamilyId,
            revokedAt: nowIso,
            updatedAt: nowIso,
            revokeReason: 'refresh_token_reuse'
          }, db);
          return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话幂等重试窗口已结束' } };
        }
        const replay = repositories.deviceSessions.findSessionById({
          sessionId: challenge.resultSessionId
        }, db);
        if (replay && replay.status === 'active') {
          return { status: 200, body: { success: true, session: sessionCredentials(replay) } };
        }
        return { error: { status: 409, code: 'IDEMPOTENCY_REPLAY_STALE', message: '幂等结果对应的设备会话已经变化' } };
      }
      repositories.deviceSessions.revokeTokenFamily({
        tokenFamilyId: session.tokenFamilyId,
        revokedAt: nowIso,
        updatedAt: nowIso,
        revokeReason: 'refresh_token_reuse'
      }, db);
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '检测到旧刷新凭据重用，会话组已撤销' } };
    }
    const failureReplay = challengeMatches
      ? proofFailureReplay(challenge, keyHash, requestFingerprint)
      : null;
    if (failureReplay) return { error: failureReplay };
    if (session.status !== 'active') {
      repositories.deviceSessions.revokeTokenFamily({
        tokenFamilyId: session.tokenFamilyId,
        revokedAt: nowIso,
        updatedAt: nowIso,
        revokeReason: 'refresh_token_reuse'
      }, db);
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '检测到旧刷新凭据重用，会话组已撤销' } };
    }
    if (!challengeMatches) {
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话挑战无效' } };
    }
    const priorCompletion = repositories.deviceSessions.findCompletedChallengeByKey({
      bindingId: session.deviceBindingId,
      purpose: 'session_refresh',
      idempotencyKeyHash: keyHash
    }, db);
    if (priorCompletion && priorCompletion.id !== challenge.id) {
      return { error: { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: '该幂等键已用于不同请求' } };
    }
    if (challenge.status === 'locked') {
      return { error: { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' } };
    }
    if (challenge.expiresAt <= nowIso) {
      repositories.deviceSessions.expireChallenge({ challengeId, updatedAt: nowIso }, db);
      return { error: { status: 410, code: 'CHALLENGE_EXPIRED', message: '设备会话挑战已过期' } };
    }
    if (session.refreshExpiresAt <= nowIso || !validSessionContext(db, session)) {
      repositories.deviceSessions.revokeTokenFamily({
        tokenFamilyId: session.tokenFamilyId,
        revokedAt: nowIso,
        updatedAt: nowIso,
        revokeReason: 'session_context_invalid'
      }, db);
      return { error: { status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' } };
    }
    const binding = repositories.deviceSessions.findBindingById({
      bindingId: session.deviceBindingId
    }, db);
    const rawChallenge = credentials.deriveProofChallenge(challenge.id);
    const payload = credentials.signingPayload({
      purpose: challenge.purpose,
      challengeId: challenge.id,
      challenge: rawChallenge,
      deviceBindingId: binding.id,
      sessionId: session.id
    });
    if (!credentials.verifyDeviceSignature({
      publicKeySpki: binding.devicePublicKeySpki,
      payload,
      signatureBase64url
    })) {
      const failed = repositories.deviceSessions.failChallenge({
        challengeId,
        idempotencyKeyHash: keyHash,
        requestFingerprint,
        updatedAt: nowIso
      }, db);
      if (failed && failed.status === 'locked') {
        repositories.deviceSessions.revokeTokenFamily({
          tokenFamilyId: session.tokenFamilyId,
          revokedAt: nowIso,
          updatedAt: nowIso,
          revokeReason: 'device_proof_locked'
        }, db);
      }
      return { error: failed && failed.status === 'locked'
        ? { status: 423, code: 'PAIRING_LOCKED', message: '设备签名验证已锁定' }
        : { status: 403, code: 'DEVICE_PROOF_INVALID', message: '设备签名验证失败' } };
    }
    const rotated = repositories.deviceSessions.rotateSession({
      sessionId: session.id,
      expectedRevision: session.revision,
      rotatedAt: nowIso,
      updatedAt: nowIso
    }, db);
    if (!rotated) {
      return { error: { status: 409, code: 'REVISION_CONFLICT', message: '设备会话状态已变化' } };
    }
    const nextSessionId = `session_${crypto.randomUUID().replace(/-/g, '')}`;
    const nextAccess = credentials.deriveAccessToken(nextSessionId);
    const nextRefresh = credentials.deriveRefreshToken(nextSessionId);
    const next = repositories.deviceSessions.createSession({
      id: nextSessionId,
      familyId: session.familyId,
      childId: session.childId,
      deviceBindingId: session.deviceBindingId,
      tokenFamilyId: session.tokenFamilyId,
      rotationCounter: session.rotationCounter + 1,
      accessTokenHash: credentials.digestCredential(nextAccess),
      refreshTokenHash: credentials.digestCredential(nextRefresh),
      issuedAt: nowIso,
      accessExpiresAt: iso(new Date(now.getTime() + config.accessTokenTtlMs)),
      refreshExpiresAt: session.refreshExpiresAt,
      createdAt: nowIso,
      updatedAt: nowIso
    }, db);
    const consumed = repositories.deviceSessions.consumeChallenge({
      challengeId,
      expectedRevision: challenge.revision,
      consumedAt: nowIso,
      completionIdempotencyKeyHash: keyHash,
      completionRequestFingerprint: requestFingerprint,
      resultSessionId: next.id,
      updatedAt: nowIso
    }, db);
    if (!consumed) fail(409, 'CHALLENGE_REPLAYED', '设备会话挑战已使用');
    return { status: 201, body: { success: true, session: sessionCredentials(next) } };
  });
  return outcomeError(outcome);
}

function revokeSession({ actor, sessionId, body, idempotencyKey, now = new Date() }) {
  requireObject(body);
  const id = requireText(sessionId, { field: 'sessionId', pattern: RESOURCE_ID, max: 128 });
  const expectedRevision = requireRevision(body.expectedRevision);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({
    operation: 'device_session_revoke', sessionId: id, expectedRevision
  });
  return inTransaction(db => {
    const replay = parentIdempotencyReplay(db, {
      actor, operation: 'device_session_revoke', keyHash, requestFingerprint
    });
    if (replay) {
      const session = repositories.deviceSessions.findSessionById({
        sessionId: replay.resourceId,
        familyId: actor.familyId
      }, db);
      if (!session || session.revision !== replay.resultRevision) {
        fail(409, 'IDEMPOTENCY_REPLAY_STALE', '幂等结果对应的设备会话已经变化');
      }
      return { status: 200, body: { success: true, session: {
        id: session.id, status: session.status, revision: session.revision
      } } };
    }
    const session = repositories.deviceSessions.findSessionById({
      sessionId: id,
      familyId: actor.familyId
    }, db);
    if (!session) fail(404, 'DEVICE_NOT_FOUND', '设备会话不存在');
    activeGuardianChild(db, actor, session.childId);
    if (session.revision !== expectedRevision || session.status === 'revoked') {
      fail(409, 'REVISION_CONFLICT', '设备会话状态已变化');
    }
    const idempotencyId = startParentIdempotency(db, {
      actor, operation: 'device_session_revoke', keyHash, requestFingerprint, now
    });
    repositories.deviceSessions.revokeTokenFamily({
      tokenFamilyId: session.tokenFamilyId,
      revokedAt: iso(now),
      updatedAt: iso(now),
      revokeReason: 'guardian_session_revoked'
    }, db);
    const revoked = repositories.deviceSessions.findSessionById({ sessionId: id }, db);
    completeParentIdempotency(db, {
      id: idempotencyId,
      resourceType: 'device_session',
      resourceId: revoked.id,
      resultRevision: revoked.revision,
      responseStatus: 200,
      now
    });
    return { status: 200, body: { success: true, session: {
      id: revoked.id, status: revoked.status, revision: revoked.revision
    } } };
  });
}

function revokeForChild(db, { familyId, childId, revokedAt, reason }) {
  repositories.deviceSessions.revokeChildSecurityArtifacts({
    familyId,
    childId,
    revokedAt,
    revokeReason: reason
  }, db);
}

module.exports = {
  createPairing,
  getPairing,
  claimPairing,
  confirmPairing,
  completePairing,
  listDevices,
  revokeDevice,
  issueSessionChallenge,
  refreshSession,
  revokeSession,
  revokeForChild,
  serializePairing,
  serializeDevice,
  sessionCredentials,
  normalizeIdempotencyKey,
  fingerprint
};
