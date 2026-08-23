const { getDb } = require('../connection');

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function toLegalText(row) {
  if (!row) return null;
  return {
    textType: row.text_type,
    version: row.version,
    contentSha256: row.content_sha256,
    publicUrl: row.public_url,
    effectiveAt: row.effective_at,
    createdAt: row.created_at
  };
}

function toReauth(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    purpose: row.purpose,
    verificationMethod: row.verification_method,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    revokedAt: row.revoked_at || null
  };
}

function toIdempotency(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    actorUserId: row.actor_user_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    resourceType: row.resource_type || null,
    resourceId: row.resource_id || null,
    resultRevision: row.result_revision === null ? null : Number(row.result_revision),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    createdAt: row.created_at,
    completedAt: row.completed_at || null
  };
}

function toPrivacyState(row) {
  if (!row) return null;
  return {
    familyId: row.family_id,
    childId: row.child_id,
    status: row.status,
    revision: Number(row.revision),
    reasonCode: row.reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at || null,
    blockedAt: row.blocked_at || null,
    deletionRequestedAt: row.deletion_requested_at || null,
    deletedAt: row.deleted_at || null
  };
}

function toConsent(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    guardianId: row.guardian_id,
    consentVersion: Number(row.consent_version),
    privacyVersion: row.privacy_version,
    privacySha256: row.privacy_sha256,
    childRulesVersion: row.child_rules_version,
    childRulesSha256: row.child_rules_sha256,
    childUserAgreementVersion: row.child_user_agreement_version,
    childUserAgreementSha256: row.child_user_agreement_sha256,
    sensitiveNoticeVersion: row.sensitive_notice_version,
    sensitiveNoticeSha256: row.sensitive_notice_sha256,
    guardianRelation: row.guardian_relation,
    relationDeclarationVersion: row.relation_declaration_version,
    relationDeclarationSha256: row.relation_declaration_sha256,
    reauthAssertionId: row.reauth_assertion_id,
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at,
    consentScope: parseJson(row.consent_scope_json),
    visibilityScope: parseJson(row.visibility_scope_json),
    privacyConsentedAt: row.privacy_consented_at,
    childRulesConsentedAt: row.child_rules_consented_at,
    childUserAgreementAcceptedAt: row.child_user_agreement_accepted_at,
    sensitiveConsentedAt: row.sensitive_consented_at,
    auditData: parseJson(row.audit_data_json),
    status: row.status,
    lifecycleRevision: Number(row.lifecycle_revision),
    withdrawnAt: row.withdrawn_at || null,
    supersededAt: row.superseded_at || null,
    supersedesConsentId: row.supersedes_consent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toChild(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, role: row.role, familyId: row.family_id };
}

function currentLegalTexts(now, db = getDb()) {
  const rows = db.prepare(`
    SELECT current.*
    FROM legal_text_versions AS current
    WHERE current.effective_at = (
      SELECT MAX(candidate.effective_at)
      FROM legal_text_versions AS candidate
      WHERE candidate.text_type = current.text_type
        AND candidate.effective_at <= ?
    )
    ORDER BY current.text_type
  `).all(now);
  return rows.map(toLegalText);
}

function createReauth(input, db = getDb()) {
  // SQL params: id, familyId, userId, purpose, tokenHash,
  // verificationMethod, issuedAt, expiresAt.
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash,
      verification_method, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.userId,
    input.purpose,
    input.tokenHash,
    input.verificationMethod,
    input.issuedAt,
    input.expiresAt
  );
  return toReauth(db.prepare('SELECT * FROM reauth_assertions WHERE id = ?').get(input.id));
}

function consumeReauth(input, db = getDb()) {
  // SQL params: consumedAt, tokenHash, familyId, userId, purpose,
  // consumedAt (issued upper bound), consumedAt (expiry lower bound).
  const result = db.prepare(`
    UPDATE reauth_assertions
    SET consumed_at = ?
    WHERE token_hash = ?
      AND family_id = ?
      AND user_id = ?
      AND purpose = ?
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND issued_at <= ?
      AND expires_at > ?
  `).run(
    input.consumedAt,
    input.tokenHash,
    input.familyId,
    input.userId,
    input.purpose,
    input.consumedAt,
    input.consumedAt
  );
  if (result.changes !== 1) return null;
  return toReauth(db.prepare('SELECT * FROM reauth_assertions WHERE token_hash = ?').get(input.tokenHash));
}

function findIdempotency(input, db = getDb()) {
  // SQL params: familyId, actorUserId, operation, idempotencyKey.
  return toIdempotency(db.prepare(`
    SELECT *
    FROM v2_idempotency_records
    WHERE family_id = ?
      AND actor_user_id = ?
      AND operation = ?
      AND idempotency_key = ?
  `).get(input.familyId, input.actorUserId, input.operation, input.idempotencyKey));
}

function startIdempotency(input, db = getDb()) {
  // SQL params: id, familyId, actorUserId, operation, idempotencyKey,
  // requestFingerprint, createdAt.
  db.prepare(`
    INSERT INTO v2_idempotency_records(
      id, family_id, actor_user_id, operation, idempotency_key,
      request_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.actorUserId,
    input.operation,
    input.idempotencyKey,
    input.requestFingerprint,
    input.createdAt
  );
  return toIdempotency(db.prepare('SELECT * FROM v2_idempotency_records WHERE id = ?').get(input.id));
}

function completeIdempotency(input, db = getDb()) {
  // SQL params: resourceType, resourceId, resultRevision, responseStatus,
  // completedAt, id.
  const result = db.prepare(`
    UPDATE v2_idempotency_records
    SET status = 'completed',
        resource_type = ?,
        resource_id = ?,
        result_revision = ?,
        response_status = ?,
        completed_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(
    input.resourceType,
    input.resourceId,
    input.resultRevision === undefined ? null : input.resultRevision,
    input.responseStatus,
    input.completedAt,
    input.id
  );
  if (result.changes !== 1) return null;
  return toIdempotency(db.prepare('SELECT * FROM v2_idempotency_records WHERE id = ?').get(input.id));
}

function getPrivacyState(input, db = getDb()) {
  // SQL params: familyId, childId.
  return toPrivacyState(db.prepare(`
    SELECT * FROM child_privacy_states
    WHERE family_id = ? AND child_id = ?
  `).get(input.familyId, input.childId));
}

function activatePrivacyState(input, db = getDb()) {
  // SQL params: reasonCode, updatedAt, activatedAt, familyId, childId,
  // expectedRevision.
  const result = db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active',
        revision = revision + 1,
        reason_code = ?,
        updated_at = ?,
        activated_at = ?,
        blocked_at = NULL
    WHERE family_id = ? AND child_id = ? AND revision = ?
  `).run(
    input.reasonCode,
    input.updatedAt,
    input.activatedAt,
    input.familyId,
    input.childId,
    input.expectedRevision
  );
  if (result.changes !== 1) return null;
  return getPrivacyState({ familyId: input.familyId, childId: input.childId }, db);
}

function blockPrivacyState(input, db = getDb()) {
  // SQL params: reasonCode, updatedAt, blockedAt, familyId, childId,
  // expectedRevision.
  const result = db.prepare(`
    UPDATE child_privacy_states
    SET status = 'processing_blocked',
        revision = revision + 1,
        reason_code = ?,
        updated_at = ?,
        blocked_at = ?
    WHERE family_id = ? AND child_id = ? AND revision = ?
  `).run(
    input.reasonCode,
    input.updatedAt,
    input.blockedAt,
    input.familyId,
    input.childId,
    input.expectedRevision
  );
  if (result.changes !== 1) return null;
  return getPrivacyState({ familyId: input.familyId, childId: input.childId }, db);
}

function insertConsent(input, db = getDb()) {
  // SQL params follow the INSERT column list exactly, from id through updatedAt.
  db.prepare(`
    INSERT INTO guardian_consents(
      id, family_id, child_id, guardian_id, consent_version,
      privacy_version, privacy_sha256, child_rules_version, child_rules_sha256,
      child_user_agreement_version, child_user_agreement_sha256,
      sensitive_notice_version, sensitive_notice_sha256,
      guardian_relation, relation_declaration_version, relation_declaration_sha256,
      reauth_assertion_id, verification_method, verified_at,
      consent_scope_json, visibility_scope_json,
      privacy_consented_at, child_rules_consented_at,
      child_user_agreement_accepted_at, sensitive_consented_at,
      audit_data_json, supersedes_consent_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.guardianId,
    input.consentVersion,
    input.privacyVersion,
    input.privacySha256,
    input.childRulesVersion,
    input.childRulesSha256,
    input.childUserAgreementVersion,
    input.childUserAgreementSha256,
    input.sensitiveNoticeVersion,
    input.sensitiveNoticeSha256,
    input.guardianRelation,
    input.relationDeclarationVersion,
    input.relationDeclarationSha256,
    input.reauthAssertionId,
    input.verificationMethod,
    input.verifiedAt,
    input.consentScopeJson,
    input.visibilityScopeJson,
    input.privacyConsentedAt,
    input.childRulesConsentedAt,
    input.childUserAgreementAcceptedAt,
    input.sensitiveConsentedAt,
    input.auditDataJson === undefined ? '{}' : input.auditDataJson,
    input.supersedesConsentId || null,
    input.createdAt,
    input.updatedAt
  );
  return findConsentById({ familyId: input.familyId, consentId: input.id }, db);
}

function supersedeConsent(input, db = getDb()) {
  // SQL params: supersededAt, updatedAt, familyId, consentId,
  // expectedLifecycleRevision.
  const result = db.prepare(`
    UPDATE guardian_consents
    SET status = 'superseded',
        lifecycle_revision = lifecycle_revision + 1,
        superseded_at = ?,
        updated_at = ?
    WHERE family_id = ?
      AND id = ?
      AND status = 'active'
      AND lifecycle_revision = ?
  `).run(
    input.supersededAt,
    input.updatedAt,
    input.familyId,
    input.consentId,
    input.expectedLifecycleRevision
  );
  if (result.changes !== 1) return null;
  return findConsentById({ familyId: input.familyId, consentId: input.consentId }, db);
}

function withdrawConsent(input, db = getDb()) {
  // SQL params: withdrawnAt, updatedAt, familyId, consentId,
  // expectedLifecycleRevision.
  const result = db.prepare(`
    UPDATE guardian_consents
    SET status = 'withdrawn',
        lifecycle_revision = lifecycle_revision + 1,
        withdrawn_at = ?,
        updated_at = ?
    WHERE family_id = ?
      AND id = ?
      AND status = 'active'
      AND lifecycle_revision = ?
  `).run(
    input.withdrawnAt,
    input.updatedAt,
    input.familyId,
    input.consentId,
    input.expectedLifecycleRevision
  );
  if (result.changes !== 1) return null;
  return findConsentById({ familyId: input.familyId, consentId: input.consentId }, db);
}

function findConsentById(input, db = getDb()) {
  // SQL params: familyId, consentId.
  return toConsent(db.prepare(`
    SELECT * FROM guardian_consents
    WHERE family_id = ? AND id = ?
  `).get(input.familyId, input.consentId));
}

function findActiveConsent(input, db = getDb()) {
  // SQL params without guardianId: familyId, childId.
  // SQL params with guardianId: familyId, childId, guardianId.
  const row = input.guardianId
    ? db.prepare(`
        SELECT * FROM guardian_consents
        WHERE family_id = ? AND child_id = ? AND guardian_id = ? AND status = 'active'
        ORDER BY consent_version DESC
        LIMIT 1
      `).get(input.familyId, input.childId, input.guardianId)
    : db.prepare(`
        SELECT * FROM guardian_consents
        WHERE family_id = ? AND child_id = ? AND status = 'active'
        ORDER BY created_at DESC, consent_version DESC
        LIMIT 1
      `).get(input.familyId, input.childId);
  return toConsent(row);
}

function listGuardianConsents(input, db = getDb()) {
  // SQL params: familyId, childId, guardianId.
  return db.prepare(`
    SELECT * FROM guardian_consents
    WHERE family_id = ? AND child_id = ? AND guardian_id = ?
    ORDER BY consent_version DESC, created_at DESC
  `).all(input.familyId, input.childId, input.guardianId).map(toConsent);
}

function listActiveGuardianChildIds(input, db = getDb()) {
  return db.prepare(`
    SELECT DISTINCT gc.child_id
    FROM guardian_consents gc
    JOIN child_privacy_states cps
      ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
    JOIN users child
      ON child.family_id = gc.family_id AND child.id = gc.child_id AND child.role = 'child'
    WHERE gc.family_id = ?
      AND gc.guardian_id = ?
      AND gc.status = 'active'
      AND cps.status = 'active'
    ORDER BY gc.child_id
  `).all(input.familyId, input.guardianId).map(row => row.child_id);
}

function hasOutstandingWithdrawalHold(input, db = getDb()) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM guardian_consents gc
    WHERE gc.family_id = ?
      AND gc.child_id = ?
      AND gc.status = 'withdrawn'
      AND gc.consent_version = (
        SELECT MAX(latest.consent_version)
        FROM guardian_consents latest
        WHERE latest.family_id = gc.family_id
          AND latest.child_id = gc.child_id
          AND latest.guardian_id = gc.guardian_id
      )
    LIMIT 1
  `).get(input.familyId, input.childId));
}

function findChildInFamily(input, db = getDb()) {
  // SQL params: familyId, childId.
  return toChild(db.prepare(`
    SELECT id, name, role, family_id
    FROM users
    WHERE family_id = ? AND id = ? AND role = 'child'
  `).get(input.familyId, input.childId));
}

module.exports = {
  currentLegalTexts,
  createReauth,
  consumeReauth,
  findIdempotency,
  startIdempotency,
  completeIdempotency,
  getPrivacyState,
  activatePrivacyState,
  blockPrivacyState,
  insertConsent,
  supersedeConsent,
  withdrawConsent,
  findConsentById,
  findActiveConsent,
  listGuardianConsents,
  listActiveGuardianChildIds,
  hasOutstandingWithdrawalHold,
  findChildInFamily
};
