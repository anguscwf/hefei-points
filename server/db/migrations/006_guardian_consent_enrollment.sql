-- Stage 1 / S1: guardian consent and atomic child enrollment foundations.
--
-- This migration is intentionally forward-only. Authorization evidence must
-- survive a code rollback, so production rollback means disabling the feature
-- and reverting compatible application code, not dropping these tables.
-- Legal texts are registered separately after their public versions, hashes,
-- and HTTPS URLs have been approved; this migration never seeds placeholders.

-- Composite parent keys let every child/guardian reference prove that both the
-- user ID and the family ID belong to the same users row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_family_user
  ON users(family_id, id);

CREATE TABLE legal_text_versions (
  text_type TEXT NOT NULL
    CHECK (text_type IN (
      'privacy_policy',
      'child_personal_information_rules',
      'child_user_agreement',
      'sensitive_information_notice'
    )),
  version TEXT NOT NULL
    CHECK (length(trim(version)) BETWEEN 1 AND 64),
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  public_url TEXT NOT NULL
    CHECK (public_url LIKE 'https://%'),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (text_type, version),
  UNIQUE (text_type, effective_at)
);

CREATE INDEX idx_legal_text_versions_current
  ON legal_text_versions(text_type, effective_at DESC);

-- Published evidence is append-only. A correction is always a new version.
CREATE TRIGGER trg_legal_text_versions_no_update
BEFORE UPDATE ON legal_text_versions
BEGIN
  SELECT RAISE(ABORT, 'LEGAL_TEXT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER trg_legal_text_versions_no_delete
BEFORE DELETE ON legal_text_versions
BEGIN
  SELECT RAISE(ABORT, 'LEGAL_TEXT_VERSION_DELETE_FORBIDDEN');
END;

CREATE TABLE reauth_assertions (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL
    CHECK (length(trim(purpose)) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(token_hash) = 64
      AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  verification_method TEXT NOT NULL
    CHECK (length(trim(verification_method)) BETWEEN 1 AND 64),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX idx_reauth_assertions_subject
  ON reauth_assertions(family_id, user_id, purpose, expires_at DESC);

CREATE INDEX idx_reauth_assertions_expiry
  ON reauth_assertions(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- An assertion is issued only to an adult who currently belongs to the stated
-- family. Later family changes do not rewrite this historical assertion.
CREATE TRIGGER trg_reauth_assertions_actor_scope
BEFORE INSERT ON reauth_assertions
WHEN NOT EXISTS (
  SELECT 1
  FROM users
  WHERE id = NEW.user_id
    AND family_id = NEW.family_id
    AND role IN ('admin', 'parent')
)
BEGIN
  SELECT RAISE(ABORT, 'REAUTH_ACTOR_SCOPE_INVALID');
END;

-- Identity, scope, digest, and validity evidence cannot be rewritten. Only the
-- one-way consumed/revoked lifecycle timestamps may change.
CREATE TRIGGER trg_reauth_assertions_core_immutable
BEFORE UPDATE ON reauth_assertions
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.verification_method IS NOT OLD.verification_method
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'REAUTH_ASSERTION_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_reauth_assertions_lifecycle_once
BEFORE UPDATE ON reauth_assertions
WHEN
  (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'REAUTH_ASSERTION_LIFECYCLE_IMMUTABLE');
END;

-- Unused assertions may be purged after expiry. Consumed or revoked assertions
-- are retained as minimum security evidence.
CREATE TRIGGER trg_reauth_assertions_evidence_no_delete
BEFORE DELETE ON reauth_assertions
WHEN OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REAUTH_ASSERTION_EVIDENCE_DELETE_FORBIDDEN');
END;

CREATE TABLE child_privacy_states (
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'suspended_pending_consent',
      'active',
      'processing_blocked',
      'deletion_pending',
      'deidentified',
      'deleted'
    )),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  reason_code TEXT NOT NULL
    CHECK (length(trim(reason_code)) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  blocked_at TEXT,
  deletion_requested_at TEXT,
  deleted_at TEXT,
  PRIMARY KEY (family_id, child_id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CHECK (status <> 'processing_blocked' OR blocked_at IS NOT NULL),
  CHECK (status <> 'deletion_pending' OR deletion_requested_at IS NOT NULL),
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE INDEX idx_child_privacy_states_family_status
  ON child_privacy_states(family_id, status);

-- Privacy state identity and creation evidence never change. Every lifecycle
-- write must use revision-based conditional update and advance by exactly one.
CREATE TRIGGER trg_child_privacy_states_update_guard
BEFORE UPDATE ON child_privacy_states
WHEN
  NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'CHILD_PRIVACY_STATE_UPDATE_INVALID');
END;

CREATE TABLE guardian_consents (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  guardian_id TEXT NOT NULL,
  consent_version INTEGER NOT NULL
    CHECK (consent_version > 0),

  privacy_version TEXT NOT NULL,
  privacy_sha256 TEXT NOT NULL
    CHECK (
      length(privacy_sha256) = 64
      AND privacy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  child_rules_version TEXT NOT NULL,
  child_rules_sha256 TEXT NOT NULL
    CHECK (
      length(child_rules_sha256) = 64
      AND child_rules_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  child_user_agreement_version TEXT NOT NULL,
  child_user_agreement_sha256 TEXT NOT NULL
    CHECK (
      length(child_user_agreement_sha256) = 64
      AND child_user_agreement_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  sensitive_notice_version TEXT NOT NULL,
  sensitive_notice_sha256 TEXT NOT NULL
    CHECK (
      length(sensitive_notice_sha256) = 64
      AND sensitive_notice_sha256 NOT GLOB '*[^0-9a-f]*'
    ),

  guardian_relation TEXT NOT NULL
    CHECK (guardian_relation IN ('father', 'mother', 'legal_guardian', 'other_guardian')),
  relation_declaration_version TEXT NOT NULL
    CHECK (length(trim(relation_declaration_version)) BETWEEN 1 AND 64),
  relation_declaration_sha256 TEXT NOT NULL
    CHECK (
      length(relation_declaration_sha256) = 64
      AND relation_declaration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reauth_assertion_id TEXT NOT NULL UNIQUE,
  verification_method TEXT NOT NULL
    CHECK (length(trim(verification_method)) BETWEEN 1 AND 64),
  verified_at TEXT NOT NULL,
  consent_scope_json TEXT NOT NULL
    CHECK (json_valid(consent_scope_json) AND json_type(consent_scope_json) = 'object'),
  visibility_scope_json TEXT NOT NULL
    CHECK (json_valid(visibility_scope_json) AND json_type(visibility_scope_json) = 'object'),
  privacy_consented_at TEXT NOT NULL,
  child_rules_consented_at TEXT NOT NULL,
  child_user_agreement_accepted_at TEXT NOT NULL,
  sensitive_consented_at TEXT NOT NULL,
  audit_data_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(audit_data_json) AND json_type(audit_data_json) = 'object'),

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'withdrawn', 'superseded')),
  lifecycle_revision INTEGER NOT NULL DEFAULT 0
    CHECK (lifecycle_revision >= 0),
  withdrawn_at TEXT,
  superseded_at TEXT,
  supersedes_consent_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (family_id, guardian_id) REFERENCES users(family_id, id),
  FOREIGN KEY (reauth_assertion_id) REFERENCES reauth_assertions(id),
  FOREIGN KEY (supersedes_consent_id) REFERENCES guardian_consents(id),
  UNIQUE (family_id, child_id, guardian_id, consent_version),
  CHECK (guardian_id <> child_id),
  CHECK (
    (status = 'active' AND withdrawn_at IS NULL AND superseded_at IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND withdrawn_at IS NULL AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_guardian_consents_active_guardian_child
  ON guardian_consents(family_id, child_id, guardian_id)
  WHERE status = 'active';

CREATE INDEX idx_guardian_consents_child_history
  ON guardian_consents(family_id, child_id, created_at DESC);

CREATE INDEX idx_guardian_consents_guardian_status
  ON guardian_consents(family_id, guardian_id, status);

-- The four consent snapshots must match published, immutable server records;
-- version and digest values supplied by a client are never authoritative.
CREATE TRIGGER trg_guardian_consents_legal_evidence
BEFORE INSERT ON guardian_consents
WHEN
  NOT EXISTS (
    SELECT 1 FROM legal_text_versions
    WHERE text_type = 'privacy_policy'
      AND version = NEW.privacy_version
      AND content_sha256 = NEW.privacy_sha256
  )
  OR NOT EXISTS (
    SELECT 1 FROM legal_text_versions
    WHERE text_type = 'child_personal_information_rules'
      AND version = NEW.child_rules_version
      AND content_sha256 = NEW.child_rules_sha256
  )
  OR NOT EXISTS (
    SELECT 1 FROM legal_text_versions
    WHERE text_type = 'child_user_agreement'
      AND version = NEW.child_user_agreement_version
      AND content_sha256 = NEW.child_user_agreement_sha256
  )
  OR NOT EXISTS (
    SELECT 1 FROM legal_text_versions
    WHERE text_type = 'sensitive_information_notice'
      AND version = NEW.sensitive_notice_version
      AND content_sha256 = NEW.sensitive_notice_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'CONSENT_LEGAL_EVIDENCE_INVALID');
END;

CREATE TRIGGER trg_guardian_consents_actor_scope
BEFORE INSERT ON guardian_consents
WHEN
  NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.child_id
      AND family_id = NEW.family_id
      AND role = 'child'
  )
  OR NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.guardian_id
      AND family_id = NEW.family_id
      AND role IN ('admin', 'parent')
  )
  OR NOT EXISTS (
    SELECT 1 FROM reauth_assertions
    WHERE id = NEW.reauth_assertion_id
      AND family_id = NEW.family_id
      AND user_id = NEW.guardian_id
      AND purpose IN ('child_enrollment', 'child_consent')
      AND consumed_at IS NOT NULL
      AND revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'CONSENT_ACTOR_SCOPE_INVALID');
END;

-- A replacement is an explicit version chain for the same relationship. The
-- old row is first moved to superseded in the surrounding transaction, then
-- the next active version is inserted.
CREATE TRIGGER trg_guardian_consents_version_chain
BEFORE INSERT ON guardian_consents
WHEN
  NEW.status <> 'active'
  OR NEW.lifecycle_revision <> 0
  OR (
    NEW.supersedes_consent_id IS NULL
    AND NEW.consent_version <> 1
  )
  OR (
    NEW.supersedes_consent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM guardian_consents AS previous
      WHERE previous.id = NEW.supersedes_consent_id
        AND previous.family_id = NEW.family_id
        AND previous.child_id = NEW.child_id
        AND previous.guardian_id = NEW.guardian_id
        AND previous.status IN ('superseded', 'withdrawn')
        AND NEW.consent_version = previous.consent_version + 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'CONSENT_VERSION_CHAIN_INVALID');
END;

-- Consent evidence is immutable. Only the lifecycle columns listed below can
-- change, and the next trigger restricts those changes to one-way transitions.
CREATE TRIGGER trg_guardian_consents_core_immutable
BEFORE UPDATE ON guardian_consents
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.guardian_id IS NOT OLD.guardian_id
  OR NEW.consent_version IS NOT OLD.consent_version
  OR NEW.privacy_version IS NOT OLD.privacy_version
  OR NEW.privacy_sha256 IS NOT OLD.privacy_sha256
  OR NEW.child_rules_version IS NOT OLD.child_rules_version
  OR NEW.child_rules_sha256 IS NOT OLD.child_rules_sha256
  OR NEW.child_user_agreement_version IS NOT OLD.child_user_agreement_version
  OR NEW.child_user_agreement_sha256 IS NOT OLD.child_user_agreement_sha256
  OR NEW.sensitive_notice_version IS NOT OLD.sensitive_notice_version
  OR NEW.sensitive_notice_sha256 IS NOT OLD.sensitive_notice_sha256
  OR NEW.guardian_relation IS NOT OLD.guardian_relation
  OR NEW.relation_declaration_version IS NOT OLD.relation_declaration_version
  OR NEW.relation_declaration_sha256 IS NOT OLD.relation_declaration_sha256
  OR NEW.reauth_assertion_id IS NOT OLD.reauth_assertion_id
  OR NEW.verification_method IS NOT OLD.verification_method
  OR NEW.verified_at IS NOT OLD.verified_at
  OR NEW.consent_scope_json IS NOT OLD.consent_scope_json
  OR NEW.visibility_scope_json IS NOT OLD.visibility_scope_json
  OR NEW.privacy_consented_at IS NOT OLD.privacy_consented_at
  OR NEW.child_rules_consented_at IS NOT OLD.child_rules_consented_at
  OR NEW.child_user_agreement_accepted_at IS NOT OLD.child_user_agreement_accepted_at
  OR NEW.sensitive_consented_at IS NOT OLD.sensitive_consented_at
  OR NEW.audit_data_json IS NOT OLD.audit_data_json
  OR NEW.supersedes_consent_id IS NOT OLD.supersedes_consent_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_CONSENT_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER trg_guardian_consents_lifecycle_guard
BEFORE UPDATE ON guardian_consents
WHEN
  OLD.status <> 'active'
  OR NEW.status NOT IN ('withdrawn', 'superseded')
  OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
  OR NEW.updated_at IS OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_CONSENT_LIFECYCLE_INVALID');
END;

CREATE TRIGGER trg_guardian_consents_no_delete
BEFORE DELETE ON guardian_consents
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_CONSENT_DELETE_FORBIDDEN');
END;

-- A privacy state may be removed with an unconsented legacy child for backward
-- compatible synthetic-test cleanup. Once any consent exists, the state is
-- retained and child deletion is independently blocked by consent foreign keys.
CREATE TRIGGER trg_child_privacy_states_consented_no_delete
BEFORE DELETE ON child_privacy_states
WHEN EXISTS (
  SELECT 1 FROM guardian_consents
  WHERE family_id = OLD.family_id AND child_id = OLD.child_id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSENTED_CHILD_PRIVACY_STATE_DELETE_FORBIDDEN');
END;

CREATE TABLE v2_idempotency_records (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation TEXT NOT NULL
    CHECK (length(trim(operation)) BETWEEN 1 AND 64),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  resource_type TEXT,
  resource_id TEXT,
  result_revision INTEGER
    CHECK (result_revision IS NULL OR result_revision >= 0),
  response_status INTEGER
    CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (family_id, actor_user_id, operation, idempotency_key),
  CHECK (
    (status = 'pending'
      AND completed_at IS NULL
      AND resource_type IS NULL
      AND resource_id IS NULL
      AND response_status IS NULL)
    OR (status = 'completed'
      AND completed_at IS NOT NULL
      AND resource_type IS NOT NULL
      AND resource_id IS NOT NULL
      AND response_status IS NOT NULL)
  )
);

CREATE INDEX idx_v2_idempotency_records_resource
  ON v2_idempotency_records(family_id, resource_type, resource_id);

CREATE TRIGGER trg_v2_idempotency_records_actor_scope
BEFORE INSERT ON v2_idempotency_records
WHEN NOT EXISTS (
  SELECT 1 FROM users
  WHERE id = NEW.actor_user_id AND family_id = NEW.family_id
)
BEGIN
  SELECT RAISE(ABORT, 'IDEMPOTENCY_ACTOR_SCOPE_INVALID');
END;

CREATE TRIGGER trg_v2_idempotency_records_core_immutable
BEFORE UPDATE ON v2_idempotency_records
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.operation IS NOT OLD.operation
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'IDEMPOTENCY_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_v2_idempotency_records_lifecycle_guard
BEFORE UPDATE ON v2_idempotency_records
WHEN OLD.status <> 'pending' OR NEW.status <> 'completed'
BEGIN
  SELECT RAISE(ABORT, 'IDEMPOTENCY_LIFECYCLE_INVALID');
END;

-- Existing children are not evidence of consent. They always start suspended.
INSERT OR IGNORE INTO child_privacy_states(
  family_id,
  child_id,
  status,
  revision,
  reason_code,
  created_at,
  updated_at
)
SELECT
  family_id,
  id,
  'suspended_pending_consent',
  0,
  'legacy_child_pending_consent',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users
WHERE role = 'child';

-- Every later legacy/direct child insert is also fail-closed. Atomic enrollment
-- starts from this row and advances it to active only after consent is written.
CREATE TRIGGER trg_users_child_privacy_after_insert
AFTER INSERT ON users
WHEN NEW.role = 'child'
BEGIN
  INSERT OR IGNORE INTO child_privacy_states(
    family_id, child_id, status, revision, reason_code, created_at, updated_at
  ) VALUES (
    NEW.family_id,
    NEW.id,
    'suspended_pending_consent',
    0,
    'child_created_pending_consent',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER trg_users_child_privacy_after_role_change
AFTER UPDATE OF role ON users
WHEN OLD.role <> 'child' AND NEW.role = 'child'
BEGIN
  INSERT OR IGNORE INTO child_privacy_states(
    family_id, child_id, status, revision, reason_code, created_at, updated_at
  ) VALUES (
    NEW.family_id,
    NEW.id,
    'suspended_pending_consent',
    0,
    'role_changed_pending_consent',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

-- Reverting an unconsented synthetic/legacy child to an adult removes only its
-- privacy-state extension. Consent evidence prevents this path once authorized.
CREATE TRIGGER trg_users_child_privacy_before_role_exit
BEFORE UPDATE OF role ON users
WHEN OLD.role = 'child' AND NEW.role <> 'child'
BEGIN
  DELETE FROM child_privacy_states
  WHERE family_id = OLD.family_id AND child_id = OLD.id;
END;

-- An adult who signed consent evidence cannot be silently converted into a
-- child account. Switching between admin and parent remains compatible.
CREATE TRIGGER trg_users_guardian_role_change_guard
BEFORE UPDATE OF role ON users
WHEN NEW.role = 'child' AND EXISTS (
  SELECT 1 FROM guardian_consents
  WHERE family_id = OLD.family_id AND guardian_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'CONSENT_GUARDIAN_ROLE_CHANGE_FORBIDDEN');
END;
