const crypto = require('crypto');

const { getDb } = require('../connection');

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function toRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    guardianId: row.guardian_id,
    requestType: row.request_type,
    status: row.status,
    revision: Number(row.revision),
    sourceConsentId: row.source_consent_id,
    reauthAssertionId: row.reauth_assertion_id,
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at,
    requestFingerprint: row.request_fingerprint,
    requestPayload: parseJson(row.request_payload_json),
    retentionDecision: row.retention_decision || null,
    resultReceiptCode: row.result_receipt_code || null,
    resultReceiptMessage: row.result_receipt_message || null,
    requestedAt: row.requested_at,
    processingStartedAt: row.processing_started_at || null,
    completedAt: row.completed_at || null,
    rejectedAt: row.rejected_at || null,
    updatedAt: row.updated_at
  };
}

function toAuditEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    actorUserId: row.actor_user_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    eventType: row.event_type,
    fromStatus: row.from_status || null,
    toStatus: row.to_status,
    resultRevision: Number(row.result_revision),
    eventData: parseJson(row.event_data_json),
    createdAt: row.created_at
  };
}

function toDeletionJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    requestId: row.request_id,
    status: row.status,
    revision: Number(row.revision),
    retentionDecision: row.retention_decision,
    blockedReason: row.blocked_reason,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at
  };
}

function toPrivacyState(row) {
  if (!row) return null;
  return {
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

function findPrivacyState(input, db = getDb()) {
  return toPrivacyState(db.prepare(`
    SELECT * FROM child_privacy_states
    WHERE family_id = ? AND child_id = ?
  `).get(input.familyId, input.childId));
}

function findHistoricalGuardianScope(input, db = getDb()) {
  const row = db.prepare(`
    SELECT guardian.id AS guardian_id,
           guardian.name AS guardian_name,
           guardian.role AS guardian_role,
           child.id AS child_id,
           child.name AS child_alias,
           child.tokens_valid_after,
           privacy.status AS privacy_status,
           privacy.revision AS privacy_revision,
           privacy.reason_code AS privacy_reason_code,
           privacy.created_at AS privacy_created_at,
           privacy.updated_at AS privacy_updated_at,
           privacy.activated_at AS privacy_activated_at,
           privacy.blocked_at AS privacy_blocked_at,
           privacy.deletion_requested_at,
           privacy.deleted_at AS privacy_deleted_at,
           consent.id AS consent_id,
           consent.consent_version,
           consent.status AS consent_status,
           consent.guardian_relation,
           consent.consent_scope_json,
           consent.visibility_scope_json,
           consent.verification_method AS consent_verification_method,
           consent.verified_at AS consent_verified_at,
           consent.created_at AS consent_created_at
    FROM users AS guardian
    JOIN users AS child
      ON child.family_id = guardian.family_id
     AND child.id = ?
     AND child.role = 'child'
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = child.family_id
     AND privacy.child_id = child.id
    JOIN guardian_consents AS consent
      ON consent.family_id = child.family_id
     AND consent.child_id = child.id
     AND consent.guardian_id = guardian.id
     AND consent.consent_version = (
       SELECT MAX(latest.consent_version)
       FROM guardian_consents AS latest
       WHERE latest.family_id = consent.family_id
         AND latest.child_id = consent.child_id
         AND latest.guardian_id = consent.guardian_id
     )
    WHERE guardian.id = ?
      AND guardian.family_id = ?
      AND guardian.role IN ('admin', 'parent')
      AND json_extract(consent.consent_scope_json, '$.childProfile') = 1
      AND json_extract(consent.visibility_scope_json, '$.guardian') = 'full'
    LIMIT 1
  `).get(input.childId, input.guardianId, input.familyId);
  if (!row) return null;
  return {
    guardian: {
      id: row.guardian_id,
      name: row.guardian_name,
      role: row.guardian_role
    },
    child: {
      id: row.child_id,
      name: row.child_alias,
      tokensValidAfter: Number(row.tokens_valid_after || 0)
    },
    privacyState: {
      status: row.privacy_status,
      revision: Number(row.privacy_revision),
      reasonCode: row.privacy_reason_code,
      createdAt: row.privacy_created_at,
      updatedAt: row.privacy_updated_at,
      activatedAt: row.privacy_activated_at || null,
      blockedAt: row.privacy_blocked_at || null,
      deletionRequestedAt: row.deletion_requested_at || null,
      deletedAt: row.privacy_deleted_at || null
    },
    consent: {
      id: row.consent_id,
      version: Number(row.consent_version),
      status: row.consent_status,
      guardianRelation: row.guardian_relation,
      consentScope: parseJson(row.consent_scope_json),
      visibilityScope: parseJson(row.visibility_scope_json),
      verificationMethod: row.consent_verification_method,
      verifiedAt: row.consent_verified_at,
      createdAt: row.consent_created_at
    }
  };
}

function insertAuditEvent(input, db = getDb()) {
  db.prepare(`
    INSERT INTO audit_events(
      id, family_id, child_id, actor_user_id,
      resource_type, resource_id, event_type,
      from_status, to_status, result_revision,
      event_data_json, created_at
    ) VALUES (?, ?, ?, ?, 'data_rights_request', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.actorUserId,
    input.requestId,
    input.eventType,
    input.fromStatus || null,
    input.toStatus,
    input.resultRevision,
    JSON.stringify(input.eventData || {}),
    input.createdAt
  );
  return toAuditEvent(db.prepare(`
    SELECT * FROM audit_events
    WHERE id = ? AND family_id = ? AND child_id = ? AND actor_user_id = ?
  `).get(input.id, input.familyId, input.childId, input.actorUserId));
}

function insertRequest(input, db = getDb()) {
  db.prepare(`
    INSERT INTO data_rights_requests(
      id, family_id, child_id, guardian_id, request_type,
      source_consent_id, reauth_assertion_id, verification_method,
      verified_at, request_fingerprint, request_payload_json,
      requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.guardianId,
    input.requestType,
    input.sourceConsentId,
    input.reauthAssertionId,
    input.verificationMethod,
    input.verifiedAt,
    input.requestFingerprint,
    JSON.stringify(input.requestPayload || {}),
    input.requestedAt,
    input.requestedAt
  );
  return findRequestById({ familyId: input.familyId, requestId: input.id }, db);
}

function findRequestById(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE id = ? AND family_id = ?
  `).get(input.requestId, input.familyId));
}

function findOwnRequest(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE id = ? AND family_id = ? AND guardian_id = ?
  `).get(input.requestId, input.familyId, input.guardianId));
}

function findRequestByReauthAssertion(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE family_id = ? AND guardian_id = ? AND reauth_assertion_id = ?
  `).get(input.familyId, input.guardianId, input.reauthAssertionId));
}

function findLiveDeletionRequest(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE family_id = ? AND child_id = ?
      AND request_type IN ('delete', 'terminate')
      AND status IN ('requested', 'verified', 'processing')
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `).get(input.familyId, input.childId));
}

function transitionRequest(input, db = getDb()) {
  let update;
  if (input.toStatus === 'verified') {
    update = db.prepare(`
      UPDATE data_rights_requests
      SET status = 'verified', revision = revision + 1, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ? AND guardian_id = ?
        AND status = ? AND revision = ?
    `).run(
      input.updatedAt, input.id, input.familyId, input.childId,
      input.guardianId, input.fromStatus, input.expectedRevision
    );
  } else if (input.toStatus === 'processing') {
    update = db.prepare(`
      UPDATE data_rights_requests
      SET status = 'processing', revision = revision + 1,
          retention_decision = ?, result_receipt_code = ?,
          result_receipt_message = ?, processing_started_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ? AND guardian_id = ?
        AND status = ? AND revision = ?
    `).run(
      input.retentionDecision,
      input.resultReceiptCode,
      input.resultReceiptMessage,
      input.updatedAt,
      input.updatedAt,
      input.id,
      input.familyId,
      input.childId,
      input.guardianId,
      input.fromStatus,
      input.expectedRevision
    );
  } else if (input.toStatus === 'completed') {
    update = db.prepare(`
      UPDATE data_rights_requests
      SET status = 'completed', revision = revision + 1,
          retention_decision = ?, result_receipt_code = ?,
          result_receipt_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ? AND guardian_id = ?
        AND status = ? AND revision = ?
    `).run(
      input.retentionDecision,
      input.resultReceiptCode,
      input.resultReceiptMessage,
      input.updatedAt,
      input.updatedAt,
      input.id,
      input.familyId,
      input.childId,
      input.guardianId,
      input.fromStatus,
      input.expectedRevision
    );
  } else if (input.toStatus === 'rejected') {
    update = db.prepare(`
      UPDATE data_rights_requests
      SET status = 'rejected', revision = revision + 1,
          retention_decision = NULL,
          result_receipt_code = ?, result_receipt_message = ?,
          rejected_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ? AND guardian_id = ?
        AND status = ? AND revision = ?
    `).run(
      input.resultReceiptCode,
      input.resultReceiptMessage,
      input.updatedAt,
      input.updatedAt,
      input.id,
      input.familyId,
      input.childId,
      input.guardianId,
      input.fromStatus,
      input.expectedRevision
    );
  } else {
    throw new Error('unsupported data-rights request transition');
  }
  if (update.changes !== 1) return null;
  return findRequestById({ familyId: input.familyId, requestId: input.id }, db);
}

function listOwnRequests(input, db = getDb()) {
  const clauses = ['family_id = ?', 'guardian_id = ?'];
  const params = [input.familyId, input.guardianId];
  if (input.childId) {
    clauses.push('child_id = ?');
    params.push(input.childId);
  }
  if (input.requestType) {
    clauses.push('request_type = ?');
    params.push(input.requestType);
  }
  if (input.status) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  if (input.cursor) {
    clauses.push('(requested_at < ? OR (requested_at = ? AND id < ?))');
    params.push(input.cursor.requestedAt, input.cursor.requestedAt, input.cursor.id);
  }
  params.push(input.limit);
  return db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE ${clauses.join(' AND ')}
    ORDER BY requested_at DESC, id DESC
    LIMIT ?
  `).all(...params).map(toRequest);
}

function listAuditEvents(input, db = getDb()) {
  return db.prepare(`
    SELECT event.*
    FROM audit_events AS event
    JOIN data_rights_requests AS request
      ON request.id = event.resource_id
     AND request.family_id = event.family_id
     AND request.child_id = event.child_id
     AND request.guardian_id = event.actor_user_id
    WHERE event.family_id = ?
      AND event.child_id = ?
      AND event.actor_user_id = ?
      AND event.resource_type = 'data_rights_request'
      AND event.resource_id = ?
    ORDER BY event.result_revision ASC, event.created_at ASC, event.id ASC
  `).all(
    input.familyId, input.childId, input.guardianId, input.requestId
  ).map(toAuditEvent);
}

function insertBlockedDeletionJob(input, db = getDb()) {
  db.prepare(`
    INSERT INTO data_deletion_jobs(
      id, family_id, child_id, request_id, status, revision,
      retention_decision, blocked_reason, requested_at, updated_at
    ) VALUES (?, ?, ?, ?, 'blocked_policy', 0,
      'policy_pending', 'retention_policy_unapproved', ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.requestId,
    input.requestedAt,
    input.requestedAt
  );
  return findDeletionJobByRequest({
    familyId: input.familyId,
    childId: input.childId,
    requestId: input.requestId
  }, db);
}

function findDeletionJobByRequest(input, db = getDb()) {
  return toDeletionJob(db.prepare(`
    SELECT * FROM data_deletion_jobs
    WHERE family_id = ? AND child_id = ? AND request_id = ?
  `).get(input.familyId, input.childId, input.requestId));
}

function findDeletionJobById(input, db = getDb()) {
  return toDeletionJob(db.prepare(`
    SELECT * FROM data_deletion_jobs
    WHERE id = ? AND family_id = ? AND child_id = ?
  `).get(input.id, input.familyId, input.childId));
}

function childProfile(input, db = getDb()) {
  const row = db.prepare(`
    SELECT child.id, child.name,
           privacy.status, privacy.revision, privacy.reason_code,
           privacy.created_at, privacy.updated_at, privacy.activated_at,
           privacy.blocked_at, privacy.deletion_requested_at, privacy.deleted_at
    FROM users AS child
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = child.family_id AND privacy.child_id = child.id
    WHERE child.id = ? AND child.family_id = ? AND child.role = 'child'
  `).get(input.childId, input.familyId);
  if (!row) return null;
  return {
    id: row.id,
    alias: row.name,
    privacyState: toPrivacyState(row)
  };
}

function conditionalCorrectAlias(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE users AS child
    SET name = ?
    WHERE child.id = ?
      AND child.family_id = ?
      AND child.role = 'child'
      AND child.name = ?
      AND EXISTS (
        SELECT 1
        FROM child_privacy_states AS privacy
        JOIN data_rights_requests AS request
          ON request.family_id = privacy.family_id
         AND request.child_id = privacy.child_id
        WHERE privacy.family_id = child.family_id
          AND privacy.child_id = child.id
          AND privacy.revision = ?
          AND privacy.status IN (
            'suspended_pending_consent', 'active', 'processing_blocked'
          )
          AND request.id = ?
          AND request.guardian_id = ?
          AND request.request_type = 'correct'
          AND request.status = 'verified'
          AND json_extract(request.request_payload_json, '$.field') = 'alias'
          AND json_extract(
            request.request_payload_json, '$.expectedValueSha256'
          ) = ?
          AND json_extract(
            request.request_payload_json, '$.newValueSha256'
          ) = ?
      )
  `).run(
    input.newAlias,
    input.childId,
    input.familyId,
    input.expectedAlias,
    input.expectedPrivacyRevision,
    input.requestId,
    input.guardianId,
    sha256(input.expectedAlias),
    sha256(input.newAlias)
  );
  return result.changes === 1
    ? childProfile({ familyId: input.familyId, childId: input.childId }, db)
    : null;
}

function markPrivacyDeletionPending(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE child_privacy_states AS privacy
    SET status = 'deletion_pending',
        revision = revision + 1,
        reason_code = ?,
        updated_at = ?,
        blocked_at = CASE
          WHEN status = 'processing_blocked' THEN blocked_at
          ELSE ?
        END,
        deletion_requested_at = ?
    WHERE privacy.family_id = ?
      AND privacy.child_id = ?
      AND privacy.revision = ?
      AND privacy.status IN (
        'suspended_pending_consent', 'active', 'processing_blocked'
      )
      AND EXISTS (
        SELECT 1
        FROM data_rights_requests AS request
        JOIN data_deletion_jobs AS job
          ON job.request_id = request.id
         AND job.family_id = request.family_id
         AND job.child_id = request.child_id
        JOIN audit_events AS event
          ON event.resource_type = 'data_rights_request'
         AND event.resource_id = request.id
         AND event.family_id = request.family_id
         AND event.child_id = request.child_id
         AND event.actor_user_id = request.guardian_id
        WHERE request.id = ?
          AND request.family_id = privacy.family_id
          AND request.child_id = privacy.child_id
          AND request.guardian_id = ?
          AND request.request_type IN ('delete', 'terminate')
          AND request.status = 'verified'
          AND (
            (request.request_type = 'delete'
              AND ? = 'data_rights_delete_requested')
            OR (request.request_type = 'terminate'
              AND ? = 'data_rights_terminate_requested')
          )
          AND job.status = 'blocked_policy'
          AND job.retention_decision = 'policy_pending'
          AND job.blocked_reason = 'retention_policy_unapproved'
          AND job.requested_at = ?
          AND job.updated_at = ?
          AND event.event_type = 'data_rights_processing'
          AND event.from_status = 'verified'
          AND event.to_status = 'processing'
          AND event.result_revision = request.revision + 1
          AND event.created_at = ?
          AND json_extract(event.event_data_json, '$.requestType') = request.request_type
          AND json_extract(event.event_data_json, '$.privacyRevision') = privacy.revision + 1
          AND json_extract(event.event_data_json, '$.deletionJobId') = job.id
          AND json_extract(event.event_data_json, '$.retentionDecision') = 'policy_pending'
      )
  `).run(
    input.reasonCode,
    input.requestedAt,
    input.requestedAt,
    input.requestedAt,
    input.familyId,
    input.childId,
    input.expectedRevision,
    input.requestId,
    input.guardianId,
    input.reasonCode,
    input.reasonCode,
    input.requestedAt,
    input.requestedAt,
    input.requestedAt
  );
  return result.changes === 1
    ? findPrivacyState({ familyId: input.familyId, childId: input.childId }, db)
    : null;
}

function raiseLegacyTokenFloor(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE users AS child
    SET tokens_valid_after = MAX(tokens_valid_after, ?)
    WHERE child.id = ?
      AND child.family_id = ?
      AND child.role = 'child'
      AND EXISTS (
        SELECT 1 FROM data_rights_requests AS request
        WHERE request.id = ?
          AND request.family_id = child.family_id
          AND request.child_id = child.id
          AND request.guardian_id = ?
          AND request.request_type IN ('delete', 'terminate')
          AND request.status = 'processing'
      )
  `).run(
    input.tokensValidAfter,
    input.childId,
    input.familyId,
    input.requestId,
    input.guardianId
  );
  if (result.changes !== 1) return null;
  const row = db.prepare(`
    SELECT id, tokens_valid_after FROM users
    WHERE id = ? AND family_id = ? AND role = 'child'
  `).get(input.childId, input.familyId);
  return row ? { id: row.id, tokensValidAfter: Number(row.tokens_valid_after) } : null;
}

function raiseLegacyTokenFloorForWithdrawal(input, db = getDb()) {
  const result = db.prepare(`
    UPDATE users AS child
    SET tokens_valid_after = MAX(tokens_valid_after, ?)
    WHERE child.id = ?
      AND child.family_id = ?
      AND child.role = 'child'
      AND EXISTS (
        SELECT 1 FROM data_rights_requests AS request
        WHERE request.id = ?
          AND request.family_id = child.family_id
          AND request.child_id = child.id
          AND request.guardian_id = ?
          AND request.request_type = 'withdraw'
          AND request.status = 'completed'
      )
  `).run(
    input.tokensValidAfter,
    input.childId,
    input.familyId,
    input.requestId,
    input.guardianId
  );
  if (result.changes !== 1) return null;
  const row = db.prepare(`
    SELECT id, tokens_valid_after FROM users
    WHERE id = ? AND family_id = ? AND role = 'child'
  `).get(input.childId, input.familyId);
  return row ? { id: row.id, tokensValidAfter: Number(row.tokens_valid_after) } : null;
}

function exportGuardianConsents(input, db) {
  return db.prepare(`
    SELECT id, consent_version, status, guardian_relation,
           privacy_version, privacy_sha256,
           child_rules_version, child_rules_sha256,
           child_user_agreement_version, child_user_agreement_sha256,
           sensitive_notice_version, sensitive_notice_sha256,
           consent_scope_json, visibility_scope_json, verified_at,
           privacy_consented_at, child_rules_consented_at,
           child_user_agreement_accepted_at, sensitive_consented_at,
           withdrawn_at, superseded_at, created_at
    FROM guardian_consents
    WHERE family_id = ? AND child_id = ? AND guardian_id = ?
    ORDER BY consent_version DESC, created_at DESC, id DESC
  `).all(input.familyId, input.childId, input.guardianId).map(row => ({
    id: row.id,
    version: Number(row.consent_version),
    status: row.status,
    guardianRelation: row.guardian_relation,
    legalTexts: {
      privacyPolicy: { version: row.privacy_version, sha256: row.privacy_sha256 },
      childPersonalInformationRules: {
        version: row.child_rules_version, sha256: row.child_rules_sha256
      },
      childUserAgreement: {
        version: row.child_user_agreement_version,
        sha256: row.child_user_agreement_sha256
      },
      sensitiveInformationNotice: {
        version: row.sensitive_notice_version,
        sha256: row.sensitive_notice_sha256
      }
    },
    consentScope: parseJson(row.consent_scope_json),
    visibilityScope: parseJson(row.visibility_scope_json),
    verifiedAt: row.verified_at,
    consentedAt: {
      privacy: row.privacy_consented_at,
      childRules: row.child_rules_consented_at,
      childUserAgreement: row.child_user_agreement_accepted_at,
      sensitiveInformation: row.sensitive_consented_at
    },
    withdrawnAt: row.withdrawn_at || null,
    supersededAt: row.superseded_at || null,
    createdAt: row.created_at
  }));
}

function exportDeviceBindings(input, db) {
  return db.prepare(`
    SELECT id, device_alias, status, created_at, activated_at,
           revoked_at, revoke_reason
    FROM device_bindings
    WHERE family_id = ? AND child_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(input.familyId, input.childId).map(row => ({
    id: row.id,
    label: row.device_alias,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at || null,
    revokedAt: row.revoked_at || null,
    reason: row.revoke_reason || null
  }));
}

function exportDeviceSessions(input, db) {
  return db.prepare(`
    SELECT id, device_binding_id, status, issued_at,
           access_expires_at, refresh_expires_at, last_used_at,
           rotated_at, revoked_at, revoke_reason
    FROM device_sessions
    WHERE family_id = ? AND child_id = ?
    ORDER BY issued_at ASC, id ASC
  `).all(input.familyId, input.childId).map(row => ({
    id: row.id,
    deviceBindingId: row.device_binding_id,
    status: row.status,
    issuedAt: row.issued_at,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    lastUsedAt: row.last_used_at || null,
    rotatedAt: row.rotated_at || null,
    revokedAt: row.revoked_at || null,
    reason: row.revoke_reason || null
  }));
}

function exportTransactions(input, db) {
  return db.prepare(`
    SELECT id, occurred_at, kid_name, amount, reason, note, rule_id, category_id,
           deleted_at, source_type, source_id
    FROM transactions
    WHERE family_id = ? AND kid_id = ?
    ORDER BY rowid ASC
  `).all(input.familyId, input.childId).map(row => ({
    id: row.id,
    occurredAt: row.occurred_at,
    childAliasSnapshot: row.kid_name,
    amount: Number(row.amount),
    reason: row.reason,
    note: row.note || '',
    ruleId: row.rule_id || null,
    categoryId: row.category_id || null,
    deletedAt: row.deleted_at || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null
  }));
}

function exportPointRequests(input, db) {
  return db.prepare(`
    SELECT id, rule_id, category_id, rule_revision,
           rule_label_snapshot, category_label_snapshot, rule_unit_snapshot,
           rule_min_points, rule_default_points, rule_max_points,
           child_alias_snapshot,
           requested_points, approved_points, description, occurred_at,
           duplicate_suspected, status, revision,
           request_info_note, request_info_at, resubmitted_at,
           decision_note, reviewed_at, transaction_id,
           submitted_at, updated_at
    FROM point_requests
    WHERE family_id = ? AND child_id = ?
    ORDER BY submitted_at ASC, id ASC
  `).all(input.familyId, input.childId).map(row => ({
    id: row.id,
    status: row.status,
    revision: Number(row.revision),
    childAliasSnapshot: row.child_alias_snapshot,
    rule: {
      id: row.rule_id,
      categoryId: row.category_id,
      revision: Number(row.rule_revision),
      label: row.rule_label_snapshot,
      categoryLabel: row.category_label_snapshot,
      unit: row.rule_unit_snapshot || '',
      minPoints: Number(row.rule_min_points),
      defaultPoints: Number(row.rule_default_points),
      maxPoints: Number(row.rule_max_points)
    },
    requestedPoints: Number(row.requested_points),
    approvedPoints: row.approved_points === null ? null : Number(row.approved_points),
    description: row.description,
    occurredAt: row.occurred_at,
    duplicateSuspected: Boolean(row.duplicate_suspected),
    requestInfo: row.request_info_note ? {
      note: row.request_info_note,
      requestedAt: row.request_info_at,
      resubmittedAt: row.resubmitted_at || null
    } : null,
    decision: ['approved', 'rejected'].includes(row.status) ? {
      note: row.decision_note || null,
      reviewedAt: row.reviewed_at,
      transactionId: row.transaction_id || null
    } : null,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  }));
}

function exportDataRightsRequests(input, db) {
  return db.prepare(`
    SELECT * FROM data_rights_requests
    WHERE family_id = ? AND child_id = ? AND guardian_id = ?
    ORDER BY requested_at ASC, id ASC
  `).all(input.familyId, input.childId, input.guardianId).map(row => {
    const request = toRequest(row);
    return {
      id: request.id,
      requestType: request.requestType,
      status: request.status,
      revision: request.revision,
      retentionDecision: request.retentionDecision,
      resultReceiptCode: request.resultReceiptCode,
      resultReceiptMessage: request.resultReceiptMessage,
      requestedAt: request.requestedAt,
      processingStartedAt: request.processingStartedAt,
      completedAt: request.completedAt,
      rejectedAt: request.rejectedAt,
      updatedAt: request.updatedAt
    };
  });
}

function exportAuditEvents(input, db) {
  return db.prepare(`
    SELECT event.*
    FROM audit_events AS event
    JOIN data_rights_requests AS request
      ON request.id = event.resource_id
     AND request.family_id = event.family_id
     AND request.child_id = event.child_id
     AND request.guardian_id = event.actor_user_id
    WHERE event.family_id = ?
      AND event.child_id = ?
      AND event.actor_user_id = ?
      AND event.resource_type = 'data_rights_request'
    ORDER BY event.created_at ASC, event.result_revision ASC, event.id ASC
  `).all(input.familyId, input.childId, input.guardianId).map(row => {
    const event = toAuditEvent(row);
    return {
      id: event.id,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      resultRevision: event.resultRevision,
      eventData: event.eventData,
      createdAt: event.createdAt
    };
  });
}

function readExportSnapshot(input, db = getDb()) {
  const scope = findHistoricalGuardianScope(input, db);
  if (!scope) return null;
  const account = db.prepare(`
    SELECT balance FROM point_accounts
    WHERE family_id = ? AND kid_id = ?
  `).get(input.familyId, input.childId);
  return {
    child: { id: scope.child.id, alias: scope.child.name },
    privacyState: scope.privacyState,
    pointAccount: account ? { balance: Number(account.balance) } : null,
    guardianConsents: exportGuardianConsents(input, db),
    deviceBindings: exportDeviceBindings(input, db),
    deviceSessions: exportDeviceSessions(input, db),
    transactions: exportTransactions(input, db),
    pointRequests: exportPointRequests(input, db),
    dataRightsRequests: exportDataRightsRequests(input, db),
    auditEvents: exportAuditEvents(input, db)
  };
}

module.exports = {
  toRequest,
  toAuditEvent,
  toDeletionJob,
  findHistoricalGuardianScope,
  insertAuditEvent,
  insertRequest,
  findRequestById,
  findOwnRequest,
  findRequestByReauthAssertion,
  findLiveDeletionRequest,
  transitionRequest,
  listOwnRequests,
  listAuditEvents,
  insertBlockedDeletionJob,
  findDeletionJobByRequest,
  findDeletionJobById,
  conditionalCorrectAlias,
  markPrivacyDeletionPending,
  raiseLegacyTokenFloor,
  raiseLegacyTokenFloorForWithdrawal,
  readExportSnapshot
};
