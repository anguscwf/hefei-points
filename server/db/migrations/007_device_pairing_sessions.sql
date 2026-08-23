-- Stage 1 / S2: child-device pairing and revocable device sessions.
--
-- This migration is forward-only. Pairing, binding, and session evidence is
-- retained across an application rollback; rollback means disabling the
-- feature and reverting compatible code, not dropping security records.
-- Every secret accepted or issued by this slice is persisted only as a
-- SHA-256 digest or a keyed HMAC. P-256 public keys are public material and are
-- stored as canonical base64-encoded DER SubjectPublicKeyInfo values.

CREATE UNIQUE INDEX uq_guardian_consents_scope_id
  ON guardian_consents(family_id, child_id, guardian_id, id);

CREATE TABLE pairing_claim_attempt_windows (
  scope TEXT NOT NULL
    CHECK (scope IN ('device', 'network')),
  subject_hmac TEXT NOT NULL
    CHECK (
      length(subject_hmac) = 64
      AND subject_hmac NOT GLOB '*[^0-9a-f]*'
    ),
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  locked_until TEXT,
  last_idempotency_key_hash TEXT NOT NULL
    CHECK (
      length(last_idempotency_key_hash) = 64
      AND last_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
  last_request_fingerprint TEXT NOT NULL
    CHECK (
      length(last_request_fingerprint) = 64
      AND last_request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hmac),
  CHECK (locked_until IS NULL OR locked_until >= window_started_at),
  CHECK (updated_at >= window_started_at)
);

CREATE INDEX idx_pairing_claim_attempt_subject
  ON pairing_claim_attempt_windows(scope, subject_hmac, window_started_at DESC);

CREATE INDEX idx_pairing_claim_attempt_lock
  ON pairing_claim_attempt_windows(locked_until)
  WHERE locked_until IS NOT NULL;

CREATE TRIGGER trg_pairing_claim_attempt_windows_update_guard
BEFORE UPDATE ON pairing_claim_attempt_windows
WHEN
  NEW.scope IS NOT OLD.scope
  OR NEW.subject_hmac IS NOT OLD.subject_hmac
  OR NEW.revision <> OLD.revision + 1
  OR NOT (
    (
      NEW.window_started_at IS OLD.window_started_at
      AND NEW.attempt_count = OLD.attempt_count + 1
    )
    OR (
      NEW.window_started_at > OLD.window_started_at
      AND NEW.attempt_count = 1
    )
  )
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'PAIRING_ATTEMPT_WINDOW_UPDATE_INVALID');
END;

CREATE TABLE pairing_challenges (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  issued_by_guardian_id TEXT NOT NULL,
  guardian_consent_id TEXT NOT NULL,
  parent_challenge_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(parent_challenge_hash) = 64
      AND parent_challenge_hash NOT GLOB '*[^0-9a-f]*'
    ),
  short_code_hmac TEXT NOT NULL
    CHECK (
      length(short_code_hmac) = 64
      AND short_code_hmac NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'claimed', 'confirmed', 'completed',
      'expired', 'locked', 'cancelled'
    )),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL DEFAULT 5
    CHECK (attempt_limit BETWEEN 1 AND 20),
  claim_token_hash TEXT UNIQUE
    CHECK (
      claim_token_hash IS NULL
      OR (
        length(claim_token_hash) = 64
        AND claim_token_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  claim_idempotency_key_hash TEXT
    CHECK (
      claim_idempotency_key_hash IS NULL
      OR (
        length(claim_idempotency_key_hash) = 64
        AND claim_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  claim_request_fingerprint TEXT
    CHECK (
      claim_request_fingerprint IS NULL
      OR (
        length(claim_request_fingerprint) = 64
        AND claim_request_fingerprint NOT GLOB '*[^0-9a-f]*'
      )
    ),
  claimed_device_binding_id TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  confirmed_at TEXT,
  completed_at TEXT,
  locked_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (family_id, child_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (family_id, issued_by_guardian_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, issued_by_guardian_id, guardian_consent_id
  ) REFERENCES guardian_consents(family_id, child_id, guardian_id, id),
  FOREIGN KEY (
    family_id, child_id, claimed_device_binding_id
  ) REFERENCES device_bindings(family_id, child_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (attempt_count <= attempt_limit),
  CHECK (
    (
      claim_token_hash IS NULL
      AND claim_idempotency_key_hash IS NULL
      AND claim_request_fingerprint IS NULL
      AND claimed_device_binding_id IS NULL
      AND claimed_at IS NULL
    )
    OR (
      claim_token_hash IS NOT NULL
      AND claim_idempotency_key_hash IS NOT NULL
      AND claim_request_fingerprint IS NOT NULL
      AND claimed_device_binding_id IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  ),
  CHECK (confirmed_at IS NULL OR claimed_at IS NOT NULL),
  CHECK (completed_at IS NULL OR confirmed_at IS NOT NULL),
  CHECK (status <> 'pending' OR claim_token_hash IS NULL),
  CHECK (
    status <> 'claimed'
    OR (
      claim_token_hash IS NOT NULL
      AND confirmed_at IS NULL
      AND completed_at IS NULL
    )
  ),
  CHECK (
    status <> 'confirmed'
    OR (
      claim_token_hash IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND completed_at IS NULL
    )
  ),
  CHECK (
    status <> 'completed'
    OR (
      claim_token_hash IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    (status = 'locked' AND locked_at IS NOT NULL)
    OR (status <> 'locked' AND locked_at IS NULL)
  ),
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_pairing_challenges_live_short_code
  ON pairing_challenges(short_code_hmac)
  WHERE status IN ('pending', 'claimed', 'confirmed');

CREATE INDEX idx_pairing_challenges_guardian_status
  ON pairing_challenges(family_id, issued_by_guardian_id, status, created_at DESC);

CREATE INDEX idx_pairing_challenges_child_status
  ON pairing_challenges(family_id, child_id, status, expires_at);

CREATE TRIGGER trg_pairing_challenges_insert_guard
BEFORE INSERT ON pairing_challenges
WHEN
  NEW.status <> 'pending'
  OR NEW.revision <> 0
  OR NEW.attempt_count <> 0
  OR NEW.claim_token_hash IS NOT NULL
  OR NEW.claim_idempotency_key_hash IS NOT NULL
  OR NEW.claim_request_fingerprint IS NOT NULL
  OR NEW.claimed_device_binding_id IS NOT NULL
  OR NEW.claimed_at IS NOT NULL
  OR NEW.confirmed_at IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NEW.locked_at IS NOT NULL
  OR NEW.cancelled_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM guardian_consents AS consent
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = consent.family_id
     AND privacy.child_id = consent.child_id
    JOIN users AS guardian
      ON guardian.family_id = consent.family_id
     AND guardian.id = consent.guardian_id
    WHERE consent.id = NEW.guardian_consent_id
      AND consent.family_id = NEW.family_id
      AND consent.child_id = NEW.child_id
      AND consent.guardian_id = NEW.issued_by_guardian_id
      AND consent.status = 'active'
      AND privacy.status = 'active'
      AND guardian.role IN ('admin', 'parent')
  )
BEGIN
  SELECT RAISE(ABORT, 'PAIRING_CHALLENGE_SCOPE_INVALID');
END;

CREATE TRIGGER trg_pairing_challenges_core_immutable
BEFORE UPDATE ON pairing_challenges
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.issued_by_guardian_id IS NOT OLD.issued_by_guardian_id
  OR NEW.guardian_consent_id IS NOT OLD.guardian_consent_id
  OR NEW.parent_challenge_hash IS NOT OLD.parent_challenge_hash
  OR NEW.short_code_hmac IS NOT OLD.short_code_hmac
  OR NEW.attempt_limit IS NOT OLD.attempt_limit
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (
    OLD.claim_token_hash IS NOT NULL
    AND (
      NEW.claim_token_hash IS NOT OLD.claim_token_hash
      OR NEW.claim_idempotency_key_hash IS NOT OLD.claim_idempotency_key_hash
      OR NEW.claim_request_fingerprint IS NOT OLD.claim_request_fingerprint
      OR NEW.claimed_device_binding_id IS NOT OLD.claimed_device_binding_id
      OR NEW.claimed_at IS NOT OLD.claimed_at
    )
  )
  OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
  OR (OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT OLD.locked_at)
  OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at)
BEGIN
  SELECT RAISE(ABORT, 'PAIRING_CHALLENGE_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_pairing_challenges_lifecycle_guard
BEFORE UPDATE ON pairing_challenges
WHEN
  NEW.revision <> OLD.revision + 1
  OR NEW.attempt_count < OLD.attempt_count
  OR NEW.attempt_count > OLD.attempt_count + 1
  OR NOT (
    (
      NEW.status = OLD.status
      AND OLD.status IN ('pending', 'claimed', 'confirmed')
      AND NEW.attempt_count = OLD.attempt_count + 1
    )
    OR (OLD.status = 'pending' AND NEW.status IN ('claimed', 'expired', 'locked', 'cancelled'))
    OR (OLD.status = 'claimed' AND NEW.status IN ('confirmed', 'expired', 'locked', 'cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('completed', 'expired', 'locked', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'PAIRING_CHALLENGE_LIFECYCLE_INVALID');
END;

CREATE TABLE device_bindings (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  authorized_by_consent_id TEXT NOT NULL,
  pairing_challenge_id TEXT NOT NULL UNIQUE,
  created_by_guardian_id TEXT NOT NULL,
  device_public_id TEXT NOT NULL
    CHECK (
      length(device_public_id) BETWEEN 16 AND 128
      AND device_public_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  public_key_algorithm TEXT NOT NULL
    CHECK (public_key_algorithm = 'ECDSA_P256_SHA256'),
  device_public_key_spki TEXT NOT NULL
    CHECK (
      length(device_public_key_spki) BETWEEN 120 AND 214
      AND device_public_key_spki NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  public_key_sha256 TEXT NOT NULL
    CHECK (
      length(public_key_sha256) = 64
      AND public_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  device_alias TEXT NOT NULL
    CHECK (length(trim(device_alias)) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  claimed_at TEXT NOT NULL,
  activated_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
    CHECK (
      revoke_reason IS NULL
      OR length(trim(revoke_reason)) BETWEEN 1 AND 64
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (family_id, child_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, created_by_guardian_id, authorized_by_consent_id
  ) REFERENCES guardian_consents(family_id, child_id, guardian_id, id),
  FOREIGN KEY (
    family_id, child_id, pairing_challenge_id
  ) REFERENCES pairing_challenges(family_id, child_id, id),
  CHECK (claimed_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (last_seen_at IS NULL OR last_seen_at >= claimed_at),
  CHECK (
    (status = 'pending'
      AND activated_at IS NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL)
    OR (status = 'active'
      AND activated_at IS NOT NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL)
    OR (status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL)
  )
);

CREATE INDEX idx_device_bindings_child_status
  ON device_bindings(family_id, child_id, status, created_at DESC);

CREATE INDEX idx_device_bindings_guardian_status
  ON device_bindings(family_id, created_by_guardian_id, status);

-- A public claim cannot reserve an identity before proof succeeds. Only an
-- activated binding owns the device identifier/key, and revocation permits
-- the physical device to be paired again through a fresh guardian flow.
CREATE UNIQUE INDEX uq_device_bindings_active_public_id
  ON device_bindings(device_public_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX uq_device_bindings_active_public_key
  ON device_bindings(public_key_sha256)
  WHERE status = 'active';

CREATE TRIGGER trg_device_bindings_insert_guard
BEFORE INSERT ON device_bindings
WHEN
  NEW.status <> 'pending'
  OR NEW.revision <> 0
  OR NEW.activated_at IS NOT NULL
  OR NEW.last_seen_at IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
  OR NEW.revoke_reason IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM pairing_challenges AS pairing
    JOIN guardian_consents AS consent
      ON consent.id = pairing.guardian_consent_id
     AND consent.family_id = pairing.family_id
     AND consent.child_id = pairing.child_id
     AND consent.guardian_id = pairing.issued_by_guardian_id
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = pairing.family_id
     AND privacy.child_id = pairing.child_id
    WHERE pairing.id = NEW.pairing_challenge_id
      AND pairing.family_id = NEW.family_id
      AND pairing.child_id = NEW.child_id
      AND pairing.issued_by_guardian_id = NEW.created_by_guardian_id
      AND pairing.guardian_consent_id = NEW.authorized_by_consent_id
      AND (
        (pairing.status = 'pending' AND pairing.claimed_device_binding_id IS NULL)
        OR (
          pairing.status = 'claimed'
          AND pairing.claimed_device_binding_id = NEW.id
        )
      )
      AND consent.status = 'active'
      AND privacy.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_BINDING_SCOPE_INVALID');
END;

CREATE TRIGGER trg_device_bindings_core_immutable
BEFORE UPDATE ON device_bindings
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.authorized_by_consent_id IS NOT OLD.authorized_by_consent_id
  OR NEW.pairing_challenge_id IS NOT OLD.pairing_challenge_id
  OR NEW.created_by_guardian_id IS NOT OLD.created_by_guardian_id
  OR NEW.device_public_id IS NOT OLD.device_public_id
  OR NEW.public_key_algorithm IS NOT OLD.public_key_algorithm
  OR NEW.device_public_key_spki IS NOT OLD.device_public_key_spki
  OR NEW.public_key_sha256 IS NOT OLD.public_key_sha256
  OR NEW.device_alias IS NOT OLD.device_alias
  OR NEW.claimed_at IS NOT OLD.claimed_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.revoke_reason IS NOT NULL AND NEW.revoke_reason IS NOT OLD.revoke_reason)
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_BINDING_CORE_IMMUTABLE');
END;

-- A claimed key cannot become an authenticated binding until the issuing
-- guardian has performed the distinct confirmation transition.
CREATE TRIGGER trg_device_bindings_activation_guard
BEFORE UPDATE OF status ON device_bindings
WHEN
  OLD.status = 'pending'
  AND NEW.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM pairing_challenges AS pairing
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = pairing.family_id
     AND privacy.child_id = pairing.child_id
    WHERE pairing.id = OLD.pairing_challenge_id
      AND pairing.family_id = OLD.family_id
      AND pairing.child_id = OLD.child_id
      AND pairing.status = 'confirmed'
      AND pairing.claimed_device_binding_id = OLD.id
      AND privacy.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_BINDING_CONFIRMATION_REQUIRED');
END;

CREATE TRIGGER trg_device_bindings_lifecycle_guard
BEFORE UPDATE ON device_bindings
WHEN
  NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'active' AND NEW.status = 'revoked')
    OR (
      OLD.status = 'active'
      AND NEW.status = 'active'
      AND NEW.last_seen_at IS NOT OLD.last_seen_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_BINDING_LIFECYCLE_INVALID');
END;

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  device_binding_id TEXT NOT NULL,
  token_family_id TEXT NOT NULL
    CHECK (length(trim(token_family_id)) BETWEEN 16 AND 128),
  rotation_counter INTEGER NOT NULL
    CHECK (rotation_counter >= 0),
  access_token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(access_token_hash) = 64
      AND access_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  refresh_token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(refresh_token_hash) = 64
      AND refresh_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  issued_at TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  last_used_at TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
    CHECK (
      revoke_reason IS NULL
      OR length(trim(revoke_reason)) BETWEEN 1 AND 64
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (token_family_id, rotation_counter),
  UNIQUE (family_id, child_id, device_binding_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (
    family_id, child_id, device_binding_id
  ) REFERENCES device_bindings(family_id, child_id, id),
  CHECK (access_expires_at > issued_at),
  CHECK (refresh_expires_at > issued_at),
  CHECK (created_at = issued_at),
  CHECK (updated_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= issued_at),
  CHECK (
    (status = 'active'
      AND rotated_at IS NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL)
    OR (status = 'rotated'
      AND rotated_at IS NOT NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL)
    OR (status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_device_sessions_active_token_family
  ON device_sessions(token_family_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX uq_device_sessions_active_binding
  ON device_sessions(device_binding_id)
  WHERE status = 'active';

CREATE INDEX idx_device_sessions_binding_history
  ON device_sessions(family_id, child_id, device_binding_id, rotation_counter DESC);

CREATE INDEX idx_device_sessions_refresh_expiry
  ON device_sessions(refresh_expires_at)
  WHERE status = 'active';

CREATE TRIGGER trg_device_sessions_insert_guard
BEFORE INSERT ON device_sessions
WHEN
  NEW.status <> 'active'
  OR NEW.revision <> 0
  OR NEW.rotation_counter < 0
  OR NEW.last_used_at IS NOT NULL
  OR NEW.rotated_at IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
  OR NEW.revoke_reason IS NOT NULL
  OR NOT (
    (
      NEW.rotation_counter = 0
      AND NOT EXISTS (
        SELECT 1 FROM device_sessions AS existing
        WHERE existing.token_family_id = NEW.token_family_id
      )
    )
    OR (
      NEW.rotation_counter > 0
      AND EXISTS (
        SELECT 1 FROM device_sessions AS predecessor
        WHERE predecessor.family_id = NEW.family_id
          AND predecessor.child_id = NEW.child_id
          AND predecessor.device_binding_id = NEW.device_binding_id
          AND predecessor.token_family_id = NEW.token_family_id
          AND predecessor.rotation_counter = NEW.rotation_counter - 1
          AND predecessor.status = 'rotated'
          AND predecessor.rotated_at = NEW.issued_at
          AND predecessor.refresh_expires_at = NEW.refresh_expires_at
      )
    )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM device_bindings AS binding
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = binding.family_id
     AND privacy.child_id = binding.child_id
    WHERE binding.id = NEW.device_binding_id
      AND binding.family_id = NEW.family_id
      AND binding.child_id = NEW.child_id
      AND binding.status = 'active'
      AND privacy.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_SCOPE_INVALID');
END;

CREATE TRIGGER trg_device_sessions_core_immutable
BEFORE UPDATE ON device_sessions
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.device_binding_id IS NOT OLD.device_binding_id
  OR NEW.token_family_id IS NOT OLD.token_family_id
  OR NEW.rotation_counter IS NOT OLD.rotation_counter
  OR NEW.access_token_hash IS NOT OLD.access_token_hash
  OR NEW.refresh_token_hash IS NOT OLD.refresh_token_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.access_expires_at IS NOT OLD.access_expires_at
  OR NEW.refresh_expires_at IS NOT OLD.refresh_expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.rotated_at IS NOT NULL AND NEW.rotated_at IS NOT OLD.rotated_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.revoke_reason IS NOT NULL AND NEW.revoke_reason IS NOT OLD.revoke_reason)
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_device_sessions_lifecycle_guard
BEFORE UPDATE ON device_sessions
WHEN
  NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('rotated', 'revoked'))
    OR (
      OLD.status = 'active'
      AND NEW.status = 'active'
      AND NEW.last_used_at IS NOT OLD.last_used_at
    )
    OR (OLD.status = 'rotated' AND NEW.status = 'revoked')
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_LIFECYCLE_INVALID');
END;

CREATE TABLE device_session_challenges (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  device_binding_id TEXT NOT NULL,
  pairing_challenge_id TEXT,
  device_session_id TEXT,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('pairing_completion', 'session_refresh')),
  challenge_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(challenge_hash) = 64
      AND challenge_hash NOT GLOB '*[^0-9a-f]*'
    ),
  issue_idempotency_key_hash TEXT NOT NULL
    CHECK (
      length(issue_idempotency_key_hash) = 64
      AND issue_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
  issue_request_fingerprint TEXT NOT NULL
    CHECK (
      length(issue_request_fingerprint) = 64
      AND issue_request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'locked', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL DEFAULT 5
    CHECK (attempt_limit BETWEEN 1 AND 20),
  last_failure_idempotency_key_hash TEXT
    CHECK (
      last_failure_idempotency_key_hash IS NULL
      OR (
        length(last_failure_idempotency_key_hash) = 64
        AND last_failure_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  last_failure_request_fingerprint TEXT
    CHECK (
      last_failure_request_fingerprint IS NULL
      OR (
        length(last_failure_request_fingerprint) = 64
        AND last_failure_request_fingerprint NOT GLOB '*[^0-9a-f]*'
      )
    ),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  locked_at TEXT,
  revoked_at TEXT,
  completion_idempotency_key_hash TEXT
    CHECK (
      completion_idempotency_key_hash IS NULL
      OR (
        length(completion_idempotency_key_hash) = 64
        AND completion_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  completion_request_fingerprint TEXT
    CHECK (
      completion_request_fingerprint IS NULL
      OR (
        length(completion_request_fingerprint) = 64
        AND completion_request_fingerprint NOT GLOB '*[^0-9a-f]*'
      )
    ),
  result_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_binding_id, purpose, issue_idempotency_key_hash),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (
    family_id, child_id, device_binding_id
  ) REFERENCES device_bindings(family_id, child_id, id),
  FOREIGN KEY (
    family_id, child_id, pairing_challenge_id
  ) REFERENCES pairing_challenges(family_id, child_id, id),
  FOREIGN KEY (
    family_id, child_id, device_binding_id, device_session_id
  ) REFERENCES device_sessions(family_id, child_id, device_binding_id, id),
  FOREIGN KEY (
    family_id, child_id, device_binding_id, result_session_id
  ) REFERENCES device_sessions(family_id, child_id, device_binding_id, id),
  CHECK (expires_at > issued_at),
  CHECK (created_at = issued_at),
  CHECK (updated_at >= created_at),
  CHECK (attempt_count <= attempt_limit),
  CHECK (
    (last_failure_idempotency_key_hash IS NULL
      AND last_failure_request_fingerprint IS NULL)
    OR (last_failure_idempotency_key_hash IS NOT NULL
      AND last_failure_request_fingerprint IS NOT NULL)
  ),
  CHECK (
    (purpose = 'pairing_completion'
      AND pairing_challenge_id IS NOT NULL
      AND device_session_id IS NULL)
    OR (purpose = 'session_refresh'
      AND pairing_challenge_id IS NULL
      AND device_session_id IS NOT NULL)
  ),
  CHECK (
    (
      completion_idempotency_key_hash IS NULL
      AND completion_request_fingerprint IS NULL
      AND result_session_id IS NULL
      AND consumed_at IS NULL
    )
    OR (
      completion_idempotency_key_hash IS NOT NULL
      AND completion_request_fingerprint IS NOT NULL
      AND result_session_id IS NOT NULL
      AND consumed_at IS NOT NULL
    )
  ),
  CHECK (
    status <> 'consumed'
    OR (
      consumed_at IS NOT NULL
      AND result_session_id IS NOT NULL
    )
  ),
  CHECK (
    (status = 'locked' AND locked_at IS NOT NULL)
    OR (status <> 'locked' AND locked_at IS NULL)
  ),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_device_session_challenges_completion_idempotency
  ON device_session_challenges(
    device_binding_id, purpose, completion_idempotency_key_hash
  )
  WHERE completion_idempotency_key_hash IS NOT NULL;

CREATE INDEX idx_device_session_challenges_binding_status
  ON device_session_challenges(
    family_id, child_id, device_binding_id, status, expires_at
  );

CREATE UNIQUE INDEX uq_device_session_challenges_pending_refresh
  ON device_session_challenges(device_session_id)
  WHERE purpose = 'session_refresh' AND status = 'pending';

CREATE TRIGGER trg_device_session_challenges_insert_guard
BEFORE INSERT ON device_session_challenges
WHEN
  NEW.status <> 'pending'
  OR NEW.revision <> 0
  OR NEW.attempt_count <> 0
  OR NEW.consumed_at IS NOT NULL
  OR NEW.locked_at IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
  OR NEW.completion_idempotency_key_hash IS NOT NULL
  OR NEW.completion_request_fingerprint IS NOT NULL
  OR NEW.result_session_id IS NOT NULL
  OR (
    NEW.purpose = 'pairing_completion'
    AND NOT EXISTS (
      SELECT 1
      FROM device_bindings AS binding
      JOIN pairing_challenges AS pairing
        ON pairing.id = binding.pairing_challenge_id
       AND pairing.family_id = binding.family_id
       AND pairing.child_id = binding.child_id
      WHERE binding.id = NEW.device_binding_id
        AND binding.family_id = NEW.family_id
        AND binding.child_id = NEW.child_id
        AND binding.status = 'pending'
        AND pairing.id = NEW.pairing_challenge_id
        AND pairing.status IN ('claimed', 'confirmed')
        AND pairing.claimed_device_binding_id = binding.id
    )
  )
  OR (
    NEW.purpose = 'session_refresh'
    AND NOT EXISTS (
      SELECT 1
      FROM device_bindings AS binding
      JOIN device_sessions AS session
        ON session.device_binding_id = binding.id
       AND session.family_id = binding.family_id
       AND session.child_id = binding.child_id
      WHERE binding.id = NEW.device_binding_id
        AND binding.family_id = NEW.family_id
        AND binding.child_id = NEW.child_id
        AND binding.status = 'active'
        AND session.id = NEW.device_session_id
        AND session.status = 'active'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_CHALLENGE_SCOPE_INVALID');
END;

CREATE TRIGGER trg_device_session_challenges_core_immutable
BEFORE UPDATE ON device_session_challenges
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.device_binding_id IS NOT OLD.device_binding_id
  OR NEW.pairing_challenge_id IS NOT OLD.pairing_challenge_id
  OR NEW.device_session_id IS NOT OLD.device_session_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.challenge_hash IS NOT OLD.challenge_hash
  OR NEW.issue_idempotency_key_hash IS NOT OLD.issue_idempotency_key_hash
  OR NEW.issue_request_fingerprint IS NOT OLD.issue_request_fingerprint
  OR NEW.attempt_limit IS NOT OLD.attempt_limit
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (
    (
      NEW.last_failure_idempotency_key_hash IS NOT OLD.last_failure_idempotency_key_hash
      OR NEW.last_failure_request_fingerprint IS NOT OLD.last_failure_request_fingerprint
    )
    AND NEW.attempt_count <> OLD.attempt_count + 1
  )
  OR (
    OLD.completion_idempotency_key_hash IS NOT NULL
    AND NEW.completion_idempotency_key_hash IS NOT OLD.completion_idempotency_key_hash
  )
  OR (
    OLD.completion_request_fingerprint IS NOT NULL
    AND NEW.completion_request_fingerprint IS NOT OLD.completion_request_fingerprint
  )
  OR (OLD.result_session_id IS NOT NULL AND NEW.result_session_id IS NOT OLD.result_session_id)
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT OLD.locked_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_CHALLENGE_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_device_session_challenges_lifecycle_guard
BEFORE UPDATE ON device_session_challenges
WHEN
  NEW.revision <> OLD.revision + 1
  OR NEW.attempt_count < OLD.attempt_count
  OR NEW.attempt_count > OLD.attempt_count + 1
  OR NOT (
    (
      OLD.status = 'pending'
      AND NEW.status = 'pending'
      AND NEW.attempt_count = OLD.attempt_count + 1
    )
    OR (OLD.status = 'pending' AND NEW.status IN ('consumed', 'expired', 'locked', 'revoked'))
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_CHALLENGE_LIFECYCLE_INVALID');
END;

CREATE TRIGGER trg_device_session_challenges_consume_guard
BEFORE UPDATE OF status ON device_session_challenges
WHEN OLD.status = 'pending'
  AND NEW.status = 'consumed'
  AND NOT (
    (
      OLD.purpose = 'pairing_completion'
      AND EXISTS (
        SELECT 1 FROM device_sessions AS result
        WHERE result.id = NEW.result_session_id
          AND result.family_id = OLD.family_id
          AND result.child_id = OLD.child_id
          AND result.device_binding_id = OLD.device_binding_id
          AND result.rotation_counter = 0
          AND result.status = 'active'
          AND result.issued_at = NEW.consumed_at
      )
    )
    OR (
      OLD.purpose = 'session_refresh'
      AND EXISTS (
        SELECT 1
        FROM device_sessions AS source
        JOIN device_sessions AS result
          ON result.family_id = source.family_id
         AND result.child_id = source.child_id
         AND result.device_binding_id = source.device_binding_id
         AND result.token_family_id = source.token_family_id
         AND result.rotation_counter = source.rotation_counter + 1
        WHERE source.id = OLD.device_session_id
          AND result.id = NEW.result_session_id
          AND source.status = 'rotated'
          AND result.status = 'active'
          AND source.rotated_at = NEW.consumed_at
          AND result.issued_at = NEW.consumed_at
          AND result.refresh_expires_at = source.refresh_expires_at
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_SESSION_CHALLENGE_RESULT_INVALID');
END;

-- Revoking a binding cancels an unfinished pairing and revokes every token and
-- signing challenge for that binding in the same SQLite statement transaction.
CREATE TRIGGER trg_device_bindings_revoke_dependants
AFTER UPDATE OF status ON device_bindings
WHEN OLD.status <> 'revoked' AND NEW.status = 'revoked'
BEGIN
  UPDATE pairing_challenges
  SET status = 'cancelled',
      revision = revision + 1,
      cancelled_at = MAX(NEW.revoked_at, updated_at),
      updated_at = MAX(NEW.revoked_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND claimed_device_binding_id = NEW.id
    AND status IN ('claimed', 'confirmed');

  UPDATE device_session_challenges
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.revoked_at, updated_at),
      updated_at = MAX(NEW.revoked_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND device_binding_id = NEW.id
    AND status = 'pending';

  UPDATE device_sessions
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.revoked_at, updated_at),
      revoke_reason = NEW.revoke_reason,
      updated_at = MAX(NEW.revoked_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND device_binding_id = NEW.id
    AND status IN ('active', 'rotated');
END;

-- Terminal pairing/proof states must not leave an unauthenticated binding
-- indefinitely reusable. Revocation also cascades through the trigger above.
CREATE TRIGGER trg_pairing_challenges_terminal_revoke_binding
AFTER UPDATE OF status ON pairing_challenges
WHEN OLD.status IN ('pending', 'claimed', 'confirmed')
  AND NEW.status IN ('expired', 'locked', 'cancelled')
BEGIN
  UPDATE device_bindings
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.updated_at, updated_at),
      revoke_reason = CASE NEW.status
        WHEN 'expired' THEN 'pairing_expired'
        WHEN 'locked' THEN 'pairing_locked'
        ELSE 'pairing_cancelled'
      END,
      updated_at = MAX(NEW.updated_at, updated_at)
  WHERE pairing_challenge_id = NEW.id AND status = 'pending';
END;

CREATE TRIGGER trg_pairing_proof_terminal_revoke_binding
AFTER UPDATE OF status ON device_session_challenges
WHEN NEW.purpose = 'pairing_completion'
  AND OLD.status = 'pending'
  AND NEW.status IN ('expired', 'locked', 'revoked')
BEGIN
  UPDATE device_bindings
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.updated_at, updated_at),
      revoke_reason = CASE NEW.status
        WHEN 'expired' THEN 'pairing_proof_expired'
        WHEN 'locked' THEN 'pairing_proof_locked'
        ELSE 'pairing_proof_revoked'
      END,
      updated_at = MAX(NEW.updated_at, updated_at)
  WHERE id = NEW.device_binding_id AND status = 'pending';
END;

-- ADR-0004 makes any guardian withdrawal a global processing hold for the
-- child. Revoke every child device, including bindings authorized by another
-- guardian, and cancel in-flight pairings before the withdrawal commits.
CREATE TRIGGER trg_guardian_consent_withdraw_revoke_child_devices
AFTER UPDATE OF status ON guardian_consents
WHEN OLD.status = 'active' AND NEW.status = 'withdrawn'
BEGIN
  UPDATE device_bindings
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.withdrawn_at, updated_at),
      revoke_reason = 'guardian_consent_withdrawn',
      updated_at = MAX(NEW.withdrawn_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('pending', 'active');

  UPDATE pairing_challenges
  SET status = 'cancelled',
      revision = revision + 1,
      cancelled_at = MAX(NEW.withdrawn_at, updated_at),
      updated_at = MAX(NEW.withdrawn_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('pending', 'claimed', 'confirmed');

  UPDATE device_session_challenges
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.withdrawn_at, updated_at),
      updated_at = MAX(NEW.withdrawn_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status = 'pending';

  UPDATE device_sessions
  SET status = 'revoked',
      revision = revision + 1,
      revoked_at = MAX(NEW.withdrawn_at, updated_at),
      revoke_reason = 'guardian_consent_withdrawn',
      updated_at = MAX(NEW.withdrawn_at, updated_at)
  WHERE family_id = NEW.family_id
    AND child_id = NEW.child_id
    AND status IN ('active', 'rotated');

END;
