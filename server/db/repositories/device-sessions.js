const { getDb } = require('../connection');

function toPairing(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    issuedByGuardianId: row.issued_by_guardian_id,
    guardianConsentId: row.guardian_consent_id,
    parentChallengeHash: row.parent_challenge_hash,
    shortCodeHmac: row.short_code_hmac,
    status: row.status,
    revision: Number(row.revision),
    attemptCount: Number(row.attempt_count),
    attemptLimit: Number(row.attempt_limit),
    claimTokenHash: row.claim_token_hash || null,
    claimIdempotencyKeyHash: row.claim_idempotency_key_hash || null,
    claimRequestFingerprint: row.claim_request_fingerprint || null,
    claimedDeviceBindingId: row.claimed_device_binding_id || null,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at || null,
    confirmedAt: row.confirmed_at || null,
    completedAt: row.completed_at || null,
    lockedAt: row.locked_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toAttemptWindow(row) {
  if (!row) return null;
  return {
    scope: row.scope,
    subjectHmac: row.subject_hmac,
    windowStartedAt: row.window_started_at,
    attemptCount: Number(row.attempt_count),
    lockedUntil: row.locked_until || null,
    lastIdempotencyKeyHash: row.last_idempotency_key_hash || null,
    lastRequestFingerprint: row.last_request_fingerprint || null,
    revision: Number(row.revision),
    updatedAt: row.updated_at
  };
}

function toBinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    authorizedByConsentId: row.authorized_by_consent_id,
    pairingChallengeId: row.pairing_challenge_id,
    createdByGuardianId: row.created_by_guardian_id,
    devicePublicId: row.device_public_id,
    publicKeyAlgorithm: row.public_key_algorithm,
    devicePublicKeySpki: row.device_public_key_spki,
    publicKeySha256: row.public_key_sha256,
    deviceAlias: row.device_alias,
    status: row.status,
    revision: Number(row.revision),
    claimedAt: row.claimed_at,
    activatedAt: row.activated_at || null,
    lastSeenAt: row.last_seen_at || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    deviceBindingId: row.device_binding_id,
    tokenFamilyId: row.token_family_id,
    rotationCounter: Number(row.rotation_counter),
    accessTokenHash: row.access_token_hash,
    refreshTokenHash: row.refresh_token_hash,
    status: row.status,
    revision: Number(row.revision),
    issuedAt: row.issued_at,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    lastUsedAt: row.last_used_at || null,
    rotatedAt: row.rotated_at || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toChallenge(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    deviceBindingId: row.device_binding_id,
    pairingChallengeId: row.pairing_challenge_id || null,
    deviceSessionId: row.device_session_id || null,
    purpose: row.purpose,
    challengeHash: row.challenge_hash,
    issueIdempotencyKeyHash: row.issue_idempotency_key_hash,
    issueRequestFingerprint: row.issue_request_fingerprint,
    status: row.status,
    revision: Number(row.revision),
    attemptCount: Number(row.attempt_count),
    attemptLimit: Number(row.attempt_limit),
    lastFailureIdempotencyKeyHash: row.last_failure_idempotency_key_hash || null,
    lastFailureRequestFingerprint: row.last_failure_request_fingerprint || null,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    lockedAt: row.locked_at || null,
    revokedAt: row.revoked_at || null,
    completionIdempotencyKeyHash: row.completion_idempotency_key_hash || null,
    completionRequestFingerprint: row.completion_request_fingerprint || null,
    resultSessionId: row.result_session_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createPairing(input, db = getDb()) {
  db.prepare(`
    INSERT INTO pairing_challenges(
      id, family_id, child_id, issued_by_guardian_id, guardian_consent_id,
      parent_challenge_hash, short_code_hmac, status, revision,
      attempt_count, attempt_limit, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?)
  `).run(
    input.id, input.familyId, input.childId, input.issuedByGuardianId,
    input.guardianConsentId, input.parentChallengeHash, input.shortCodeHmac,
    input.attemptLimit, input.expiresAt, input.createdAt, input.updatedAt
  );
  return findPairingById({ pairingId: input.id }, db);
}

function findPairingById(input, db = getDb()) {
  const row = input.familyId
    ? db.prepare('SELECT * FROM pairing_challenges WHERE id = ? AND family_id = ?')
      .get(input.pairingId, input.familyId)
    : db.prepare('SELECT * FROM pairing_challenges WHERE id = ?').get(input.pairingId);
  return toPairing(row);
}

function findPairingByCodeHash(input, db = getDb()) {
  return toPairing(db.prepare(`
    SELECT * FROM pairing_challenges
    WHERE short_code_hmac = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(input.shortCodeHmac));
}

function findPairingByClaimHash(input, db = getDb()) {
  return toPairing(db.prepare(`
    SELECT * FROM pairing_challenges WHERE claim_token_hash = ?
  `).get(input.claimTokenHash));
}

function claimPairing(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE pairing_challenges
    SET status = 'claimed', revision = revision + 1,
        claim_token_hash = ?, claim_idempotency_key_hash = ?,
        claim_request_fingerprint = ?, claimed_device_binding_id = ?,
        claimed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ?
  `).run(
    input.claimTokenHash, input.claimIdempotencyKeyHash,
    input.claimRequestFingerprint, input.claimedDeviceBindingId,
    input.claimedAt, input.updatedAt, input.pairingId,
    input.expectedRevision, input.claimedAt
  );
  return result.changes === 1 ? findPairingById({ pairingId: input.pairingId }, db) : null;
}

function confirmPairing(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE pairing_challenges
    SET status = 'confirmed', revision = revision + 1,
        confirmed_at = ?, updated_at = ?
    WHERE id = ? AND family_id = ? AND issued_by_guardian_id = ?
      AND status = 'claimed' AND revision = ? AND expires_at > ?
  `).run(
    input.confirmedAt, input.updatedAt, input.pairingId, input.familyId,
    input.guardianId, input.expectedRevision, input.confirmedAt
  );
  return result.changes === 1
    ? findPairingById({ pairingId: input.pairingId, familyId: input.familyId }, db)
    : null;
}

function completePairing(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE pairing_challenges
    SET status = 'completed', revision = revision + 1,
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'confirmed' AND revision = ? AND expires_at > ?
  `).run(
    input.completedAt, input.updatedAt, input.pairingId,
    input.expectedRevision, input.completedAt
  );
  return result.changes === 1 ? findPairingById({ pairingId: input.pairingId }, db) : null;
}

function expirePairing(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE pairing_challenges
    SET status = 'expired', revision = revision + 1, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'claimed', 'confirmed') AND expires_at <= ?
  `).run(input.updatedAt, input.pairingId, input.updatedAt);
  return result.changes === 1 ? findPairingById({ pairingId: input.pairingId }, db) : null;
}

function getAttemptWindow(input, db = getDb()) {
  return toAttemptWindow(db.prepare(`
    SELECT * FROM pairing_claim_attempt_windows WHERE scope = ? AND subject_hmac = ?
  `).get(input.scope, input.subjectHmac));
}

function pruneAttemptWindows(input, db = getDb()) {
  db.prepare(`
    DELETE FROM pairing_claim_attempt_windows
    WHERE updated_at < ? AND (locked_until IS NULL OR locked_until <= ?)
  `).run(input.staleBefore, input.now);
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM pairing_claim_attempt_windows
  `).get().count);
  const removeCount = Math.max(0, count - input.maxRows + input.reserveRows);
  if (removeCount > 0) {
    db.prepare(`
      DELETE FROM pairing_claim_attempt_windows
      WHERE rowid IN (
        SELECT rowid FROM pairing_claim_attempt_windows
        WHERE subject_hmac NOT IN (?, ?)
        ORDER BY
          CASE WHEN locked_until IS NULL OR locked_until <= ? THEN 0 ELSE 1 END,
          updated_at ASC
        LIMIT ?
      )
    `).run(
      input.preserveSubjectHmac[0],
      input.preserveSubjectHmac[1],
      input.now,
      removeCount
    );
  }
}

function recordAttemptFailure(input, db = getDb()) {
  const current = getAttemptWindow(input, db);
  if (current
      && current.lastIdempotencyKeyHash === input.idempotencyKeyHash
      && current.lastRequestFingerprint === input.requestFingerprint) return current;

  const nowMs = Date.parse(input.now);
  const windowExpired = !current || Date.parse(current.windowStartedAt) + input.windowMs <= nowMs;
  const count = windowExpired ? 1 : current.attemptCount + 1;
  const lockedUntil = count >= input.attemptLimit
    ? new Date(nowMs + input.lockMs).toISOString()
    : null;
  if (!current) {
    db.prepare(`
      INSERT INTO pairing_claim_attempt_windows(
        scope, subject_hmac, window_started_at, attempt_count, locked_until,
        last_idempotency_key_hash, last_request_fingerprint, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.scope, input.subjectHmac, input.now, count, lockedUntil,
      input.idempotencyKeyHash, input.requestFingerprint, input.now
    );
  } else {
    db.prepare(`
      UPDATE pairing_claim_attempt_windows
      SET window_started_at = ?, attempt_count = ?, locked_until = ?,
          last_idempotency_key_hash = ?, last_request_fingerprint = ?,
          revision = revision + 1, updated_at = ?
      WHERE scope = ? AND subject_hmac = ? AND revision = ?
    `).run(
      windowExpired ? input.now : current.windowStartedAt,
      count, lockedUntil, input.idempotencyKeyHash, input.requestFingerprint,
      input.now, input.scope, input.subjectHmac, current.revision
    );
  }
  return getAttemptWindow(input, db);
}

function createBinding(input, db = getDb()) {
  db.prepare(`
    INSERT INTO device_bindings(
      id, family_id, child_id, authorized_by_consent_id,
      pairing_challenge_id, created_by_guardian_id, device_public_id,
      public_key_algorithm, device_public_key_spki, public_key_sha256,
      device_alias, status, revision, claimed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    input.id, input.familyId, input.childId, input.authorizedByConsentId,
    input.pairingChallengeId, input.createdByGuardianId, input.devicePublicId,
    input.publicKeyAlgorithm, input.devicePublicKeySpki, input.publicKeySha256,
    input.deviceAlias, input.claimedAt, input.createdAt, input.updatedAt
  );
  return findBindingById({ bindingId: input.id }, db);
}

function findBindingById(input, db = getDb()) {
  const row = input.familyId
    ? db.prepare('SELECT * FROM device_bindings WHERE id = ? AND family_id = ?')
      .get(input.bindingId, input.familyId)
    : db.prepare('SELECT * FROM device_bindings WHERE id = ?').get(input.bindingId);
  return toBinding(row);
}

function findBindingByPairingId(input, db = getDb()) {
  return toBinding(db.prepare(`
    SELECT * FROM device_bindings WHERE pairing_challenge_id = ?
  `).get(input.pairingId));
}

function findActiveBindingByIdentity(input, db = getDb()) {
  return toBinding(db.prepare(`
    SELECT * FROM device_bindings
    WHERE status = 'active' AND id <> ?
      AND (device_public_id = ? OR public_key_sha256 = ?)
    LIMIT 1
  `).get(input.excludeBindingId, input.devicePublicId, input.publicKeySha256));
}

function activateBinding(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE device_bindings
    SET status = 'active', revision = revision + 1,
        activated_at = ?, last_seen_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND revision = ?
  `).run(
    input.activatedAt, input.activatedAt, input.updatedAt,
    input.bindingId, input.expectedRevision
  );
  return result.changes === 1 ? findBindingById({ bindingId: input.bindingId }, db) : null;
}

function listBindingsForGuardian(input, db = getDb()) {
  return db.prepare(`
    SELECT DISTINCT binding.*
    FROM device_bindings AS binding
    JOIN child_privacy_states AS state
      ON state.family_id = binding.family_id AND state.child_id = binding.child_id
    JOIN guardian_consents AS consent
      ON consent.family_id = binding.family_id
      AND consent.child_id = binding.child_id
      AND consent.guardian_id = ?
      AND consent.status = 'active'
    WHERE binding.family_id = ? AND state.status = 'active'
    ORDER BY binding.created_at DESC
  `).all(input.guardianId, input.familyId).map(toBinding);
}

function revokeBinding(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE device_bindings
    SET status = 'revoked', revision = revision + 1,
        revoked_at = MAX(?, updated_at), revoke_reason = ?,
        updated_at = MAX(?, updated_at)
    WHERE id = ? AND family_id = ? AND status IN ('pending', 'active') AND revision = ?
  `).run(
    input.revokedAt, input.revokeReason, input.updatedAt,
    input.bindingId, input.familyId, input.expectedRevision
  );
  return result.changes === 1
    ? findBindingById({ bindingId: input.bindingId, familyId: input.familyId }, db)
    : null;
}

function createSession(input, db = getDb()) {
  db.prepare(`
    INSERT INTO device_sessions(
      id, family_id, child_id, device_binding_id, token_family_id,
      rotation_counter, access_token_hash, refresh_token_hash, status,
      revision, issued_at, access_expires_at, refresh_expires_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.familyId, input.childId, input.deviceBindingId,
    input.tokenFamilyId, input.rotationCounter, input.accessTokenHash,
    input.refreshTokenHash, input.issuedAt, input.accessExpiresAt,
    input.refreshExpiresAt, input.createdAt, input.updatedAt
  );
  return findSessionById({ sessionId: input.id }, db);
}

function findSessionById(input, db = getDb()) {
  const row = input.familyId
    ? db.prepare('SELECT * FROM device_sessions WHERE id = ? AND family_id = ?')
      .get(input.sessionId, input.familyId)
    : db.prepare('SELECT * FROM device_sessions WHERE id = ?').get(input.sessionId);
  return toSession(row);
}

function findSessionByAccessHash(input, db = getDb()) {
  return toSession(db.prepare(`
    SELECT * FROM device_sessions WHERE access_token_hash = ?
  `).get(input.accessTokenHash));
}

function findSessionByRefreshHash(input, db = getDb()) {
  return toSession(db.prepare(`
    SELECT * FROM device_sessions WHERE refresh_token_hash = ?
  `).get(input.refreshTokenHash));
}

function findSessionGeneration(input, db = getDb()) {
  return toSession(db.prepare(`
    SELECT * FROM device_sessions
    WHERE token_family_id = ? AND rotation_counter = ?
  `).get(input.tokenFamilyId, input.rotationCounter));
}

function listSessionsForBinding(input, db = getDb()) {
  return db.prepare(`
    SELECT * FROM device_sessions
    WHERE device_binding_id = ?
    ORDER BY issued_at DESC, rotation_counter DESC
  `).all(input.bindingId).map(toSession);
}

function rotateSession(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE device_sessions
    SET status = 'rotated', revision = revision + 1,
        rotated_at = ?, last_used_at = ?, updated_at = ?
    WHERE id = ? AND status = 'active' AND revision = ?
  `).run(
    input.rotatedAt, input.rotatedAt, input.updatedAt,
    input.sessionId, input.expectedRevision
  );
  return result.changes === 1 ? findSessionById({ sessionId: input.sessionId }, db) : null;
}

function revokeTokenFamily(input, db = getDb()) {
  db.prepare(`
    UPDATE device_sessions
    SET status = 'revoked', revision = revision + 1,
      revoked_at = MAX(?, updated_at), revoke_reason = ?,
      updated_at = MAX(?, updated_at)
    WHERE token_family_id = ? AND status IN ('active', 'rotated')
  `).run(input.revokedAt, input.revokeReason, input.updatedAt, input.tokenFamilyId);
  db.prepare(`
    UPDATE device_session_challenges
    SET status = 'revoked', revision = revision + 1,
        revoked_at = MAX(?, updated_at), updated_at = MAX(?, updated_at)
    WHERE status = 'pending' AND device_session_id IN (
      SELECT id FROM device_sessions WHERE token_family_id = ?
    )
  `).run(input.revokedAt, input.updatedAt, input.tokenFamilyId);
  return db.prepare(`
    SELECT COUNT(*) AS count FROM device_sessions
    WHERE token_family_id = ? AND status = 'revoked'
  `).get(input.tokenFamilyId).count;
}

function createChallenge(input, db = getDb()) {
  db.prepare(`
    INSERT INTO device_session_challenges(
      id, family_id, child_id, device_binding_id, pairing_challenge_id,
      device_session_id, purpose, challenge_hash,
      issue_idempotency_key_hash, issue_request_fingerprint,
      status, revision, attempt_count, attempt_limit,
      issued_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.familyId, input.childId, input.deviceBindingId,
    input.pairingChallengeId || null, input.deviceSessionId || null,
    input.purpose, input.challengeHash, input.issueIdempotencyKeyHash,
    input.issueRequestFingerprint, input.attemptLimit, input.issuedAt,
    input.expiresAt, input.createdAt, input.updatedAt
  );
  return findChallengeById({ challengeId: input.id }, db);
}

function findChallengeById(input, db = getDb()) {
  return toChallenge(db.prepare(`
    SELECT * FROM device_session_challenges WHERE id = ?
  `).get(input.challengeId));
}

function findPairingChallenge(input, db = getDb()) {
  return toChallenge(db.prepare(`
    SELECT * FROM device_session_challenges
    WHERE pairing_challenge_id = ? AND purpose = 'pairing_completion'
    ORDER BY created_at DESC LIMIT 1
  `).get(input.pairingId));
}

function findIssuedSessionChallenge(input, db = getDb()) {
  return toChallenge(db.prepare(`
    SELECT * FROM device_session_challenges
    WHERE device_binding_id = ? AND purpose = 'session_refresh'
      AND issue_idempotency_key_hash = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(input.bindingId, input.idempotencyKeyHash));
}

function findPendingSessionChallenge(input, db = getDb()) {
  return toChallenge(db.prepare(`
    SELECT * FROM device_session_challenges
    WHERE device_session_id = ? AND purpose = 'session_refresh'
      AND status = 'pending'
    ORDER BY issued_at DESC LIMIT 1
  `).get(input.sessionId));
}

function findCompletedChallengeByKey(input, db = getDb()) {
  return toChallenge(db.prepare(`
    SELECT * FROM device_session_challenges
    WHERE device_binding_id = ? AND purpose = ?
      AND completion_idempotency_key_hash = ?
    ORDER BY consumed_at DESC LIMIT 1
  `).get(input.bindingId, input.purpose, input.idempotencyKeyHash));
}

function failChallenge(input, db = getDb()) {
  const row = findChallengeById({ challengeId: input.challengeId }, db);
  if (!row || row.status !== 'pending') return row;
  if (row.lastFailureIdempotencyKeyHash === input.idempotencyKeyHash
      && row.lastFailureRequestFingerprint === input.requestFingerprint) return row;
  const nextCount = row.attemptCount + 1;
  const locked = nextCount >= row.attemptLimit;
  db.prepare(`
    UPDATE device_session_challenges
    SET status = ?, revision = revision + 1, attempt_count = ?,
        locked_at = ?, last_failure_idempotency_key_hash = ?,
        last_failure_request_fingerprint = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND revision = ?
  `).run(
    locked ? 'locked' : 'pending', nextCount,
    locked ? input.updatedAt : null, input.idempotencyKeyHash,
    input.requestFingerprint, input.updatedAt,
    input.challengeId, row.revision
  );
  return findChallengeById({ challengeId: input.challengeId }, db);
}

function expireChallenge(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE device_session_challenges
    SET status = 'expired', revision = revision + 1, updated_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at <= ?
  `).run(input.updatedAt, input.challengeId, input.updatedAt);
  return result.changes === 1 ? findChallengeById({ challengeId: input.challengeId }, db) : null;
}

function consumeChallenge(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE device_session_challenges
    SET status = 'consumed', revision = revision + 1,
        consumed_at = ?, completion_idempotency_key_hash = ?,
        completion_request_fingerprint = ?, result_session_id = ?,
        updated_at = ?
    WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ?
  `).run(
    input.consumedAt, input.completionIdempotencyKeyHash,
    input.completionRequestFingerprint, input.resultSessionId,
    input.updatedAt, input.challengeId, input.expectedRevision,
    input.consumedAt
  );
  return result.changes === 1 ? findChallengeById({ challengeId: input.challengeId }, db) : null;
}

function revokeChildSecurityArtifacts(input, db = getDb()) {
  db.prepare(`
    UPDATE pairing_challenges
    SET status = 'cancelled', revision = revision + 1,
        cancelled_at = MAX(?, updated_at), updated_at = MAX(?, updated_at)
    WHERE family_id = ? AND child_id = ?
      AND status IN ('pending', 'claimed', 'confirmed')
  `).run(input.revokedAt, input.revokedAt, input.familyId, input.childId);
  db.prepare(`
    UPDATE device_bindings
    SET status = 'revoked', revision = revision + 1,
        revoked_at = MAX(?, updated_at), revoke_reason = ?,
        updated_at = MAX(?, updated_at)
    WHERE family_id = ? AND child_id = ? AND status IN ('pending', 'active')
  `).run(
    input.revokedAt, input.revokeReason, input.revokedAt,
    input.familyId, input.childId
  );
  db.prepare(`
    UPDATE device_sessions
    SET status = 'revoked', revision = revision + 1,
        revoked_at = MAX(?, updated_at), revoke_reason = ?,
        updated_at = MAX(?, updated_at)
    WHERE family_id = ? AND child_id = ? AND status IN ('active', 'rotated')
  `).run(
    input.revokedAt, input.revokeReason, input.revokedAt,
    input.familyId, input.childId
  );
  db.prepare(`
    UPDATE device_session_challenges
    SET status = 'revoked', revision = revision + 1,
        revoked_at = MAX(?, updated_at), updated_at = MAX(?, updated_at)
    WHERE family_id = ? AND child_id = ? AND status = 'pending'
  `).run(input.revokedAt, input.revokedAt, input.familyId, input.childId);
}

function activeDeviceContext(input, db = getDb()) {
  const row = db.prepare(`
    SELECT session.*, binding.created_by_guardian_id, binding.status AS binding_status,
           state.status AS privacy_status
    FROM device_sessions AS session
    JOIN device_bindings AS binding
      ON binding.id = session.device_binding_id
      AND binding.family_id = session.family_id
      AND binding.child_id = session.child_id
    JOIN child_privacy_states AS state
      ON state.family_id = session.family_id AND state.child_id = session.child_id
    WHERE session.id = ?
  `).get(input.sessionId);
  if (!row) return null;
  return {
    session: toSession(row),
    bindingStatus: row.binding_status,
    privacyStatus: row.privacy_status,
    createdByGuardianId: row.created_by_guardian_id
  };
}

module.exports = {
  toPairing,
  toAttemptWindow,
  toBinding,
  toSession,
  toChallenge,
  createPairing,
  findPairingById,
  findPairingByCodeHash,
  findPairingByClaimHash,
  claimPairing,
  confirmPairing,
  completePairing,
  expirePairing,
  getAttemptWindow,
  pruneAttemptWindows,
  recordAttemptFailure,
  createBinding,
  findBindingById,
  findBindingByPairingId,
  findActiveBindingByIdentity,
  activateBinding,
  listBindingsForGuardian,
  revokeBinding,
  createSession,
  findSessionById,
  findSessionByAccessHash,
  findSessionByRefreshHash,
  findSessionGeneration,
  listSessionsForBinding,
  rotateSession,
  revokeTokenFamily,
  createChallenge,
  findChallengeById,
  findPairingChallenge,
  findIssuedSessionChallenge,
  findPendingSessionChallenge,
  findCompletedChallengeByKey,
  failChallenge,
  expireChallenge,
  consumeChallenge,
  revokeChildSecurityArtifacts,
  activeDeviceContext
};
