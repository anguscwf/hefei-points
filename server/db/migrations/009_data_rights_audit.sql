-- Stage 1 / S5: child data-rights workflow and minimum immutable audit.
--
-- This migration is forward-only. Rights requests, identity-verification
-- evidence, receipts, and audit events must survive an application rollback.
-- Formal per-class retention decisions are not approved yet: delete and
-- terminate requests therefore stop processing and create a blocked job, but
-- cannot claim completion, deidentification, or physical deletion.

CREATE UNIQUE INDEX uq_reauth_assertions_scope_id
  ON reauth_assertions(family_id, user_id, id);

-- 007 creates this parent key. Reassert it here so the four-column consent
-- evidence FK below remains explicit if migration validation starts at 009.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guardian_consents_scope_id
  ON guardian_consents(family_id, child_id, guardian_id, id);

CREATE TABLE data_rights_requests (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  guardian_id TEXT NOT NULL,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('access', 'export', 'correct', 'withdraw', 'delete', 'terminate')),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'verified', 'processing', 'completed', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),

  source_consent_id TEXT NOT NULL,
  reauth_assertion_id TEXT NOT NULL UNIQUE,
  verification_method TEXT NOT NULL
    CHECK (length(trim(verification_method)) BETWEEN 1 AND 64),
  verified_at TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  request_payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(request_payload_json) AND json_type(request_payload_json) = 'object'),

  retention_decision TEXT
    CHECK (retention_decision IS NULL OR retention_decision IN (
      'not_applicable',
      'policy_pending',
      'retained_per_policy',
      'deidentified_per_policy',
      'deleted_per_policy'
    )),
  result_receipt_code TEXT
    CHECK (
      result_receipt_code IS NULL
      OR length(trim(result_receipt_code)) BETWEEN 1 AND 64
    ),
  result_receipt_message TEXT
    CHECK (
      result_receipt_message IS NULL
      OR length(trim(result_receipt_message)) BETWEEN 1 AND 300
    ),

  requested_at TEXT NOT NULL,
  processing_started_at TEXT,
  completed_at TEXT,
  rejected_at TEXT,
  updated_at TEXT NOT NULL,

  UNIQUE (family_id, child_id, id),
  UNIQUE (family_id, child_id, guardian_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (family_id, guardian_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, guardian_id, source_consent_id
  ) REFERENCES guardian_consents(family_id, child_id, guardian_id, id),
  FOREIGN KEY (
    family_id, guardian_id, reauth_assertion_id
  ) REFERENCES reauth_assertions(family_id, user_id, id),
  CHECK (guardian_id <> child_id),
  CHECK (updated_at >= requested_at),
  CHECK (
    (status IN ('requested', 'verified')
      AND retention_decision IS NULL
      AND result_receipt_code IS NULL
      AND result_receipt_message IS NULL
      AND processing_started_at IS NULL
      AND completed_at IS NULL
      AND rejected_at IS NULL)
    OR (status = 'processing'
      AND request_type IN ('delete', 'terminate')
      AND retention_decision = 'policy_pending'
      AND result_receipt_code IS NOT NULL
      AND result_receipt_message IS NOT NULL
      AND processing_started_at IS NOT NULL
      AND completed_at IS NULL
      AND rejected_at IS NULL)
    OR (status = 'completed'
      AND retention_decision IS NOT NULL
      AND retention_decision <> 'policy_pending'
      AND result_receipt_code IS NOT NULL
      AND result_receipt_message IS NOT NULL
      AND completed_at IS NOT NULL
      AND rejected_at IS NULL)
    OR (status = 'rejected'
      AND retention_decision IS NULL
      AND result_receipt_code IS NOT NULL
      AND result_receipt_message IS NOT NULL
      AND processing_started_at IS NULL
      AND completed_at IS NULL
      AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX idx_data_rights_guardian_list
  ON data_rights_requests(family_id, guardian_id, requested_at DESC, id DESC);

CREATE INDEX idx_data_rights_child_status
  ON data_rights_requests(family_id, child_id, status, requested_at DESC, id DESC);

-- A child can have at most one unresolved deletion/termination workflow even
-- when different guardians or different idempotency keys race.
CREATE UNIQUE INDEX uq_data_rights_live_deletion
  ON data_rights_requests(family_id, child_id)
  WHERE request_type IN ('delete', 'terminate')
    AND status IN ('requested', 'verified', 'processing');

-- Field-whitelisted audit events. The payload may contain only primitive,
-- server-generated routing/result metadata; credentials, export bodies, task
-- descriptions, notes, and arbitrary nested objects are forbidden.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  resource_type TEXT NOT NULL
    CHECK (resource_type = 'data_rights_request'),
  resource_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'data_rights_requested',
      'data_rights_verified',
      'data_rights_processing',
      'data_rights_completed',
      'data_rights_rejected'
    )),
  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN ('requested', 'verified', 'processing')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('requested', 'verified', 'processing', 'completed', 'rejected')),
  result_revision INTEGER NOT NULL
    CHECK (result_revision >= 0),
  event_data_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(event_data_json) AND json_type(event_data_json) = 'object'),
  created_at TEXT NOT NULL,

  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (family_id, actor_user_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, actor_user_id, resource_id
  ) REFERENCES data_rights_requests(family_id, child_id, guardian_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (resource_type, resource_id, result_revision),
  CHECK (
    (event_type = 'data_rights_requested'
      AND from_status IS NULL AND to_status = 'requested' AND result_revision = 0)
    OR (event_type = 'data_rights_verified'
      AND from_status = 'requested' AND to_status = 'verified')
    OR (event_type = 'data_rights_processing'
      AND from_status = 'verified' AND to_status = 'processing')
    OR (event_type = 'data_rights_completed'
      AND from_status IN ('verified', 'processing') AND to_status = 'completed')
    OR (event_type = 'data_rights_rejected'
      AND from_status IN ('requested', 'verified', 'processing') AND to_status = 'rejected')
  )
);

CREATE INDEX idx_audit_events_child_time
  ON audit_events(family_id, child_id, created_at DESC, id DESC);

CREATE INDEX idx_audit_events_resource
  ON audit_events(resource_type, resource_id, result_revision);

-- No deletion engine is enabled until a reviewed retention policy exists.
-- The immutable blocked job is an explicit, queryable production hard gate;
-- a later migration must replace this guard with a policy-bound job lifecycle.
CREATE TABLE data_deletion_jobs (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status = 'blocked_policy'),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision = 0),
  retention_decision TEXT NOT NULL
    CHECK (retention_decision = 'policy_pending'),
  blocked_reason TEXT NOT NULL
    CHECK (blocked_reason = 'retention_policy_unapproved'),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE (family_id, child_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, request_id
  ) REFERENCES data_rights_requests(family_id, child_id, id),
  CHECK (updated_at = requested_at)
);

CREATE INDEX idx_data_deletion_jobs_child_status
  ON data_deletion_jobs(family_id, child_id, status, requested_at DESC);

CREATE TRIGGER trg_audit_events_field_whitelist
BEFORE INSERT ON audit_events
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.event_data_json)
  WHERE key NOT IN (
    'requestType',
    'resultCode',
    'privacyRevision',
    'deletionJobId',
    'changedField',
    'retentionDecision'
  )
    OR type IN ('array', 'object', 'null')
)
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENT_FIELD_NOT_ALLOWED');
END;

CREATE TRIGGER trg_audit_events_insert_guard
BEFORE INSERT ON audit_events
WHEN
  NOT EXISTS (
    SELECT 1 FROM users AS actor
    JOIN users AS child
      ON child.family_id = actor.family_id
     AND child.id = NEW.child_id
     AND child.role = 'child'
    WHERE actor.id = NEW.actor_user_id
      AND actor.family_id = NEW.family_id
      AND actor.role IN ('admin', 'parent')
  )
  OR (
    NEW.event_type = 'data_rights_requested'
    AND EXISTS (
      SELECT 1 FROM data_rights_requests AS request
      WHERE request.id = NEW.resource_id
        AND (
          request.family_id <> NEW.family_id
          OR request.child_id <> NEW.child_id
          OR request.guardian_id <> NEW.actor_user_id
          OR request.status <> 'requested'
          OR request.revision <> 0
        )
    )
  )
  OR (
    NEW.event_type <> 'data_rights_requested'
    AND NOT EXISTS (
      SELECT 1 FROM data_rights_requests AS request
      WHERE request.id = NEW.resource_id
        AND request.family_id = NEW.family_id
        AND request.child_id = NEW.child_id
        AND request.guardian_id = NEW.actor_user_id
        AND request.status = NEW.from_status
        AND request.revision = NEW.result_revision - 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENT_SCOPE_INVALID');
END;

CREATE TRIGGER trg_audit_events_no_replace
BEFORE INSERT ON audit_events
WHEN EXISTS (
  SELECT 1 FROM audit_events AS existing
  WHERE existing.id = NEW.id
     OR (
       existing.resource_type = NEW.resource_type
       AND existing.resource_id = NEW.resource_id
       AND existing.result_revision = NEW.result_revision
     )
)
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENT_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENT_IMMUTABLE');
END;

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENT_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_data_rights_payload_guard
BEFORE INSERT ON data_rights_requests
WHEN
  (
    NEW.request_type = 'correct'
    AND (
      json_extract(NEW.request_payload_json, '$.field') IS NOT 'alias'
      OR length(json_extract(NEW.request_payload_json, '$.expectedValueSha256')) <> 64
      OR json_extract(NEW.request_payload_json, '$.expectedValueSha256') GLOB '*[^0-9a-f]*'
      OR length(json_extract(NEW.request_payload_json, '$.newValueSha256')) <> 64
      OR json_extract(NEW.request_payload_json, '$.newValueSha256') GLOB '*[^0-9a-f]*'
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.request_payload_json)
        WHERE key NOT IN ('field', 'expectedValueSha256', 'newValueSha256')
          OR type <> 'text'
      )
      OR (SELECT COUNT(*) FROM json_each(NEW.request_payload_json)) <> 3
    )
  )
  OR (
    NEW.request_type <> 'correct'
    AND EXISTS (SELECT 1 FROM json_each(NEW.request_payload_json))
  )
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_PAYLOAD_INVALID');
END;

CREATE TRIGGER trg_data_rights_requests_insert_guard
BEFORE INSERT ON data_rights_requests
WHEN
  NEW.status <> 'requested'
  OR NEW.revision <> 0
  OR NEW.retention_decision IS NOT NULL
  OR NEW.result_receipt_code IS NOT NULL
  OR NEW.result_receipt_message IS NOT NULL
  OR NEW.processing_started_at IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NEW.rejected_at IS NOT NULL
  OR NEW.requested_at <> NEW.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM users AS actor
    JOIN guardian_consents AS consent
      ON consent.family_id = actor.family_id
     AND consent.child_id = NEW.child_id
     AND consent.guardian_id = actor.id
     AND consent.id = NEW.source_consent_id
    JOIN reauth_assertions AS reauth
      ON reauth.family_id = actor.family_id
     AND reauth.user_id = actor.id
     AND reauth.id = NEW.reauth_assertion_id
    WHERE actor.id = NEW.guardian_id
      AND actor.family_id = NEW.family_id
      AND actor.role IN ('admin', 'parent')
      AND json_extract(consent.consent_scope_json, '$.childProfile') = 1
      AND json_extract(consent.visibility_scope_json, '$.guardian') = 'full'
      AND consent.status IN ('active', 'withdrawn', 'superseded')
      AND (NEW.request_type <> 'withdraw' OR consent.status = 'active')
      AND NOT EXISTS (
        SELECT 1 FROM guardian_consents AS later
        WHERE later.family_id = consent.family_id
          AND later.child_id = consent.child_id
          AND later.guardian_id = consent.guardian_id
          AND later.consent_version > consent.consent_version
      )
      AND reauth.consumed_at IS NOT NULL
      AND reauth.revoked_at IS NULL
      AND reauth.consumed_at >= reauth.issued_at
      AND reauth.consumed_at < reauth.expires_at
      AND reauth.consumed_at = NEW.verified_at
      AND reauth.verification_method = NEW.verification_method
      AND reauth.purpose = CASE NEW.request_type
        WHEN 'access' THEN 'child_data_access'
        WHEN 'export' THEN 'child_data_export'
        WHEN 'correct' THEN 'child_data_correct'
        WHEN 'withdraw' THEN 'child_consent_withdraw'
        WHEN 'delete' THEN 'child_data_delete'
        WHEN 'terminate' THEN 'child_service_terminate'
      END
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events AS event
    WHERE event.resource_type = 'data_rights_request'
      AND event.resource_id = NEW.id
      AND event.family_id = NEW.family_id
      AND event.child_id = NEW.child_id
      AND event.actor_user_id = NEW.guardian_id
      AND event.event_type = 'data_rights_requested'
      AND event.result_revision = 0
      AND json_extract(event.event_data_json, '$.requestType') = NEW.request_type
  )
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_REQUEST_INSERT_INVALID');
END;

CREATE TRIGGER trg_data_rights_requests_no_replace
BEFORE INSERT ON data_rights_requests
WHEN EXISTS (
  SELECT 1 FROM data_rights_requests AS existing
  WHERE existing.id = NEW.id
     OR existing.reauth_assertion_id = NEW.reauth_assertion_id
)
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_REQUEST_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_data_rights_requests_core_immutable
BEFORE UPDATE ON data_rights_requests
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.guardian_id IS NOT OLD.guardian_id
  OR NEW.request_type IS NOT OLD.request_type
  OR NEW.source_consent_id IS NOT OLD.source_consent_id
  OR NEW.reauth_assertion_id IS NOT OLD.reauth_assertion_id
  OR NEW.verification_method IS NOT OLD.verification_method
  OR NEW.verified_at IS NOT OLD.verified_at
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.request_payload_json IS NOT OLD.request_payload_json
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_REQUEST_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_data_rights_requests_lifecycle_guard
BEFORE UPDATE ON data_rights_requests
WHEN
  NEW.id IS OLD.id
  AND NEW.family_id IS OLD.family_id
  AND NEW.child_id IS OLD.child_id
  AND NEW.guardian_id IS OLD.guardian_id
  AND NEW.request_type IS OLD.request_type
  AND NEW.source_consent_id IS OLD.source_consent_id
  AND NEW.reauth_assertion_id IS OLD.reauth_assertion_id
  AND NEW.verification_method IS OLD.verification_method
  AND NEW.verified_at IS OLD.verified_at
  AND NEW.request_fingerprint IS OLD.request_fingerprint
  AND NEW.request_payload_json IS OLD.request_payload_json
  AND NEW.requested_at IS OLD.requested_at
  AND (
  NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('verified', 'rejected'))
    OR (OLD.status = 'verified' AND NEW.status IN ('processing', 'completed', 'rejected'))
    OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'rejected'))
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events AS event
    WHERE event.resource_type = 'data_rights_request'
      AND event.resource_id = OLD.id
      AND event.family_id = OLD.family_id
      AND event.child_id = OLD.child_id
      AND event.actor_user_id = OLD.guardian_id
      AND event.from_status = OLD.status
      AND event.to_status = NEW.status
      AND event.result_revision = NEW.revision
      AND event.created_at = NEW.updated_at
  )
  OR (
    NEW.status = 'processing'
    AND (
      NOT EXISTS (
        SELECT 1 FROM data_deletion_jobs AS job
        WHERE job.request_id = OLD.id
          AND job.family_id = OLD.family_id
          AND job.child_id = OLD.child_id
          AND job.status = 'blocked_policy'
          AND job.retention_decision = 'policy_pending'
          AND job.blocked_reason = 'retention_policy_unapproved'
          AND job.requested_at = NEW.updated_at
      )
      OR NOT EXISTS (
        SELECT 1 FROM child_privacy_states AS privacy
        WHERE privacy.family_id = OLD.family_id
          AND privacy.child_id = OLD.child_id
          AND privacy.status = 'deletion_pending'
          AND privacy.deletion_requested_at = NEW.updated_at
          AND privacy.reason_code = CASE OLD.request_type
            WHEN 'delete' THEN 'data_rights_delete_requested'
            WHEN 'terminate' THEN 'data_rights_terminate_requested'
          END
      )
    )
  )
  OR (
    OLD.status = 'processing'
    AND OLD.request_type IN ('delete', 'terminate')
    AND NEW.status = 'rejected'
  )
  OR (
    NEW.status = 'completed'
    AND NEW.request_type IN ('delete', 'terminate')
    AND NOT EXISTS (
      SELECT 1 FROM data_deletion_jobs AS job
      WHERE job.request_id = OLD.id
        AND job.family_id = OLD.family_id
        AND job.child_id = OLD.child_id
        AND job.status = 'completed'
        AND job.retention_decision <> 'policy_pending'
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_REQUEST_LIFECYCLE_INVALID');
END;

CREATE TRIGGER trg_data_rights_requests_no_delete
BEFORE DELETE ON data_rights_requests
BEGIN
  SELECT RAISE(ABORT, 'DATA_RIGHTS_REQUEST_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_data_deletion_jobs_insert_guard
BEFORE INSERT ON data_deletion_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM data_rights_requests AS request
  WHERE request.id = NEW.request_id
    AND request.family_id = NEW.family_id
    AND request.child_id = NEW.child_id
    AND request.request_type IN ('delete', 'terminate')
    AND request.status = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'DATA_DELETION_JOB_SCOPE_INVALID');
END;

CREATE TRIGGER trg_data_deletion_jobs_no_replace
BEFORE INSERT ON data_deletion_jobs
WHEN EXISTS (
  SELECT 1 FROM data_deletion_jobs AS existing
  WHERE existing.id = NEW.id OR existing.request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'DATA_DELETION_JOB_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_data_deletion_jobs_no_update
BEFORE UPDATE ON data_deletion_jobs
BEGIN
  SELECT RAISE(ABORT, 'DATA_DELETION_JOB_POLICY_BLOCKED');
END;

CREATE TRIGGER trg_data_deletion_jobs_no_delete
BEFORE DELETE ON data_deletion_jobs
BEGIN
  SELECT RAISE(ABORT, 'DATA_DELETION_JOB_DELETE_FORBIDDEN');
END;

-- Tighten the broad 006 privacy-state revision guard into a fail-closed state
-- machine. Re-consent remains possible only before a deletion workflow starts;
-- deletion/deidentification terminal states require a future successful policy-
-- bound job and are unreachable while 009's blocked-job guard is installed.
CREATE TRIGGER trg_child_privacy_states_lifecycle_009
BEFORE UPDATE ON child_privacy_states
WHEN NOT (
  (OLD.status = 'suspended_pending_consent'
    AND NEW.status = 'active'
    AND NEW.reason_code = 'guardian_consent_recorded'
    AND NEW.activated_at = NEW.updated_at
    AND NEW.blocked_at IS NULL
    AND NEW.deletion_requested_at IS NULL
    AND NEW.deleted_at IS NULL)
  OR (OLD.status = 'active'
    AND NEW.status = 'active'
    AND NEW.reason_code = 'guardian_consent_recorded'
    AND NEW.activated_at = NEW.updated_at
    AND NEW.blocked_at IS NULL
    AND NEW.deletion_requested_at IS NULL
    AND NEW.deleted_at IS NULL)
  OR (OLD.status = 'processing_blocked'
    AND NEW.status = 'active'
    AND NEW.reason_code = 'guardian_consent_recorded'
    AND NEW.activated_at = NEW.updated_at
    AND NEW.blocked_at IS NULL
    AND NEW.deletion_requested_at IS NULL
    AND NEW.deleted_at IS NULL)
  OR (OLD.status = 'active'
    AND NEW.status = 'processing_blocked'
    AND NEW.reason_code = 'guardian_consent_withdrawn'
    AND NEW.activated_at IS OLD.activated_at
    AND NEW.blocked_at = NEW.updated_at
    AND NEW.deletion_requested_at IS NULL
    AND NEW.deleted_at IS NULL)
  OR (OLD.status = 'processing_blocked'
    AND NEW.status = 'processing_blocked'
    AND NEW.reason_code = 'guardian_consent_withdrawn'
    AND NEW.activated_at IS OLD.activated_at
    AND NEW.blocked_at = NEW.updated_at
    AND NEW.deletion_requested_at IS NULL
    AND NEW.deleted_at IS NULL)
  OR (OLD.status IN ('suspended_pending_consent', 'active', 'processing_blocked')
    AND NEW.status = 'deletion_pending'
    AND NEW.reason_code IN ('data_rights_delete_requested', 'data_rights_terminate_requested')
    AND (
      (OLD.status IN ('suspended_pending_consent', 'active')
        AND NEW.blocked_at = NEW.updated_at)
      OR (OLD.status = 'processing_blocked'
        AND NEW.blocked_at IS OLD.blocked_at
        AND NEW.blocked_at IS NOT NULL)
    )
    AND NEW.deletion_requested_at = NEW.updated_at
    AND NEW.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM data_rights_requests AS request
      JOIN data_deletion_jobs AS job
        ON job.request_id = request.id
       AND job.family_id = request.family_id
       AND job.child_id = request.child_id
      WHERE request.family_id = NEW.family_id
        AND request.child_id = NEW.child_id
        AND request.status = 'verified'
        AND request.request_type IN ('delete', 'terminate')
        AND (
          (request.request_type = 'delete'
            AND NEW.reason_code = 'data_rights_delete_requested')
          OR (request.request_type = 'terminate'
            AND NEW.reason_code = 'data_rights_terminate_requested')
        )
        AND job.status = 'blocked_policy'
        AND job.retention_decision = 'policy_pending'
        AND job.blocked_reason = 'retention_policy_unapproved'
        AND job.requested_at = NEW.updated_at
        AND job.updated_at = NEW.updated_at
    ))
  OR (OLD.status = 'deletion_pending'
    AND NEW.status IN ('deidentified', 'deleted')
    AND NEW.deleted_at = NEW.updated_at
    AND EXISTS (
      SELECT 1 FROM data_rights_requests AS request
      JOIN data_deletion_jobs AS job
        ON job.request_id = request.id
       AND job.family_id = request.family_id
       AND job.child_id = request.child_id
      WHERE request.family_id = NEW.family_id
        AND request.child_id = NEW.child_id
        AND request.status = 'completed'
        AND request.request_type IN ('delete', 'terminate')
        AND request.retention_decision <> 'policy_pending'
        AND job.status = 'completed'
        AND job.retention_decision <> 'policy_pending'
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'CHILD_PRIVACY_STATE_LIFECYCLE_INVALID');
END;

-- Activation always requires current consent evidence and no latest withdrawal
-- hold from any guardian. This closes the broad 006 update surface without
-- preventing an active consent from being safely versioned in place.
CREATE TRIGGER trg_child_privacy_active_consent_guard_009
BEFORE UPDATE ON child_privacy_states
WHEN NEW.status = 'active'
  AND (
    NOT EXISTS (
      SELECT 1 FROM guardian_consents AS consent
      WHERE consent.family_id = NEW.family_id
        AND consent.child_id = NEW.child_id
        AND consent.status = 'active'
        AND consent.created_at = NEW.updated_at
    )
    OR EXISTS (
      SELECT 1 FROM guardian_consents AS withdrawn
      WHERE withdrawn.family_id = NEW.family_id
        AND withdrawn.child_id = NEW.child_id
        AND withdrawn.status = 'withdrawn'
        AND withdrawn.consent_version = (
          SELECT MAX(latest.consent_version)
          FROM guardian_consents AS latest
          WHERE latest.family_id = withdrawn.family_id
            AND latest.child_id = withdrawn.child_id
            AND latest.guardian_id = withdrawn.guardian_id
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'CHILD_PRIVACY_ACTIVE_CONSENT_INVALID');
END;

-- A processing hold is evidence of an actual consent withdrawal committed in
-- the same transaction, not a free-form privacy-state switch.
CREATE TRIGGER trg_child_privacy_blocked_consent_guard_009
BEFORE UPDATE ON child_privacy_states
WHEN NEW.status = 'processing_blocked'
  AND NEW.reason_code = 'guardian_consent_withdrawn'
  AND NOT EXISTS (
    SELECT 1 FROM guardian_consents AS consent
    WHERE consent.family_id = NEW.family_id
      AND consent.child_id = NEW.child_id
      AND consent.status = 'withdrawn'
      AND consent.withdrawn_at = NEW.updated_at
      AND consent.consent_version = (
        SELECT MAX(latest.consent_version)
        FROM guardian_consents AS latest
        WHERE latest.family_id = consent.family_id
          AND latest.child_id = consent.child_id
          AND latest.guardian_id = consent.guardian_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'CHILD_PRIVACY_BLOCKED_CONSENT_INVALID');
END;

-- A deletion/termination request immediately revokes all child credentials at
-- the database layer, including bindings created by another guardian.
CREATE TRIGGER trg_child_privacy_deletion_revoke_devices
AFTER UPDATE OF status ON child_privacy_states
WHEN OLD.status <> 'deletion_pending' AND NEW.status = 'deletion_pending'
BEGIN
  UPDATE device_bindings
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.deletion_requested_at, updated_at),
      revoke_reason = NEW.reason_code,
      updated_at = MAX(NEW.deletion_requested_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('pending', 'active');

  UPDATE pairing_challenges
  SET status = 'cancelled',
      revision = revision + 1,
      cancelled_at = MAX(NEW.deletion_requested_at, updated_at),
      updated_at = MAX(NEW.deletion_requested_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('pending', 'claimed', 'confirmed');

  UPDATE device_session_challenges
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.deletion_requested_at, updated_at),
      updated_at = MAX(NEW.deletion_requested_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status = 'pending';

  UPDATE device_sessions
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.deletion_requested_at, updated_at),
      revoke_reason = NEW.reason_code,
      updated_at = MAX(NEW.deletion_requested_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('active', 'rotated');

  -- Defense in depth for any legacy child bearer issued before the protected
  -- flow was enabled. New child processing remains blocked by privacy state.
  UPDATE users
  SET tokens_valid_after = MAX(
    tokens_valid_after,
    CAST(strftime('%s', NEW.deletion_requested_at) AS INTEGER) * 1000 + 999
  )
  WHERE family_id = NEW.family_id
    AND id = NEW.child_id
    AND role = 'child';
END;
