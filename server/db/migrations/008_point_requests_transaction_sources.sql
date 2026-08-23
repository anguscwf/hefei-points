-- Stage 1 / S4: child point requests and immutable ledger provenance.
--
-- This migration is forward-only. Point-request decisions and their sourced
-- ledger entries are audit evidence and must survive an application rollback.

ALTER TABLE transactions ADD COLUMN source_type TEXT
  CHECK (source_type IS NULL OR source_type = 'point_request');
ALTER TABLE transactions ADD COLUMN source_id TEXT;

CREATE TRIGGER trg_transactions_source_pair_insert
BEFORE INSERT ON transactions
WHEN (NEW.source_type IS NULL) <> (NEW.source_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'TRANSACTION_SOURCE_PAIR_INVALID');
END;

CREATE TRIGGER trg_transactions_source_pair_update
BEFORE UPDATE OF source_type, source_id ON transactions
WHEN
  (NEW.source_type IS NULL) <> (NEW.source_id IS NULL)
  OR NEW.source_type IS NOT OLD.source_type
  OR NEW.source_id IS NOT OLD.source_id
BEGIN
  SELECT RAISE(ABORT, 'TRANSACTION_SOURCE_IMMUTABLE');
END;

CREATE UNIQUE INDEX uq_transactions_family_child_id
  ON transactions(family_id, kid_id, id);

CREATE UNIQUE INDEX uq_transactions_point_request_link
  ON transactions(family_id, kid_id, source_id, id);

CREATE UNIQUE INDEX uq_transactions_source
  ON transactions(family_id, source_type, source_id)
  WHERE source_type IS NOT NULL;

CREATE TABLE point_requests (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  device_binding_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL
    CHECK (length(trim(client_request_id)) BETWEEN 8 AND 128),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),

  rule_id TEXT NOT NULL
    CHECK (length(trim(rule_id)) BETWEEN 1 AND 128),
  category_id TEXT NOT NULL
    CHECK (length(trim(category_id)) BETWEEN 1 AND 128),
  rule_revision INTEGER NOT NULL
    CHECK (rule_revision >= 0),
  rule_label_snapshot TEXT NOT NULL
    CHECK (length(trim(rule_label_snapshot)) BETWEEN 1 AND 200),
  category_label_snapshot TEXT NOT NULL
    CHECK (length(trim(category_label_snapshot)) BETWEEN 1 AND 200),
  rule_unit_snapshot TEXT NOT NULL DEFAULT ''
    CHECK (length(rule_unit_snapshot) <= 50),
  rule_min_points INTEGER NOT NULL
    CHECK (rule_min_points >= 0),
  rule_default_points INTEGER NOT NULL,
  rule_max_points INTEGER NOT NULL,
  child_alias_snapshot TEXT NOT NULL
    CHECK (length(trim(child_alias_snapshot)) BETWEEN 1 AND 100),

  requested_points INTEGER NOT NULL,
  approved_points INTEGER,
  description TEXT NOT NULL
    CHECK (length(trim(description)) BETWEEN 1 AND 300),
  occurred_at TEXT NOT NULL,
  period_key TEXT NOT NULL
    CHECK (period_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  duplicate_suspected INTEGER NOT NULL DEFAULT 0
    CHECK (duplicate_suspected IN (0, 1)),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'needs_info', 'approved', 'rejected', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision >= 0),
  request_info_note TEXT
    CHECK (
      request_info_note IS NULL
      OR length(trim(request_info_note)) BETWEEN 1 AND 300
    ),
  request_info_at TEXT,
  resubmitted_at TEXT,
  decision_note TEXT
    CHECK (
      decision_note IS NULL
      OR length(trim(decision_note)) BETWEEN 1 AND 300
    ),
  reviewer_user_id TEXT,
  reviewed_at TEXT,
  transaction_id TEXT UNIQUE,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE (device_binding_id, client_request_id),
  UNIQUE (family_id, child_id, id),
  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, device_binding_id
  ) REFERENCES device_bindings(family_id, child_id, id),
  FOREIGN KEY (
    family_id, reviewer_user_id
  ) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, id, transaction_id
  ) REFERENCES transactions(family_id, kid_id, source_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (rule_min_points >= 0),
  CHECK (rule_min_points <= rule_default_points),
  CHECK (rule_default_points <= rule_max_points),
  CHECK (requested_points > 0),
  CHECK (requested_points BETWEEN rule_min_points AND rule_max_points),
  CHECK (
    approved_points IS NULL
    OR (
      approved_points > 0
      AND approved_points BETWEEN rule_min_points AND rule_max_points
    )
  ),
  CHECK (occurred_at <= submitted_at),
  CHECK (updated_at >= submitted_at),
  CHECK (
    (request_info_note IS NULL AND request_info_at IS NULL)
    OR (request_info_note IS NOT NULL AND request_info_at IS NOT NULL)
  ),
  CHECK (resubmitted_at IS NULL OR request_info_at IS NOT NULL),
  CHECK (
    (status = 'pending'
      AND approved_points IS NULL
      AND reviewer_user_id IS NULL
      AND reviewed_at IS NULL
      AND transaction_id IS NULL
      AND decision_note IS NULL)
    OR (status = 'needs_info'
      AND request_info_note IS NOT NULL
      AND request_info_at IS NOT NULL
      AND approved_points IS NULL
      AND reviewer_user_id IS NULL
      AND reviewed_at IS NULL
      AND transaction_id IS NULL
      AND decision_note IS NULL)
    OR (status = 'approved'
      AND approved_points IS NOT NULL
      AND reviewer_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND transaction_id IS NOT NULL)
    OR (status = 'rejected'
      AND approved_points IS NULL
      AND reviewer_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND transaction_id IS NULL
      AND decision_note IS NOT NULL)
    OR (status = 'cancelled'
      AND approved_points IS NULL
      AND reviewer_user_id IS NULL
      AND reviewed_at IS NULL
      AND transaction_id IS NULL
      AND decision_note IS NULL)
  )
);

CREATE INDEX idx_point_requests_family_status
  ON point_requests(family_id, status, submitted_at DESC, id DESC);

CREATE INDEX idx_point_requests_child_status
  ON point_requests(family_id, child_id, status, submitted_at DESC, id DESC);

CREATE INDEX idx_point_requests_duplicate_signal
  ON point_requests(family_id, child_id, rule_id, period_key, status);

-- Each row is both immutable transition evidence and the durable replay record
-- for one successful write request. Only SHA-256 digests of idempotency keys
-- are persisted.
CREATE TABLE point_request_events (
  id TEXT PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 1 AND 128),
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  point_request_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_device_binding_id TEXT,
  action TEXT NOT NULL
    CHECK (action IN ('create', 'resubmit', 'request_info', 'approve', 'reject', 'cancel')),
  idempotency_key_hash TEXT NOT NULL
    CHECK (
      length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN ('pending', 'needs_info')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('pending', 'needs_info', 'approved', 'rejected', 'cancelled')),
  result_revision INTEGER NOT NULL
    CHECK (result_revision >= 0),
  response_status INTEGER NOT NULL
    CHECK (response_status BETWEEN 200 AND 299),
  transaction_id TEXT,
  event_data_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(event_data_json) AND json_type(event_data_json) = 'object'),
  created_at TEXT NOT NULL,

  FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (family_id, child_id) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, point_request_id
  ) REFERENCES point_requests(family_id, child_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    family_id, actor_user_id
  ) REFERENCES users(family_id, id),
  FOREIGN KEY (
    family_id, child_id, actor_device_binding_id
  ) REFERENCES device_bindings(family_id, child_id, id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (actor_user_id IS NOT NULL AND actor_device_binding_id IS NULL)
    OR (actor_user_id IS NULL AND actor_device_binding_id IS NOT NULL)
  ),
  CHECK (
    (action = 'create'
      AND actor_device_binding_id IS NOT NULL
      AND from_status IS NULL
      AND to_status = 'pending'
      AND result_revision = 0
      AND transaction_id IS NULL)
    OR (action = 'resubmit'
      AND actor_device_binding_id IS NOT NULL
      AND from_status = 'needs_info'
      AND to_status = 'pending'
      AND transaction_id IS NULL)
    OR (action = 'cancel'
      AND actor_device_binding_id IS NOT NULL
      AND from_status IN ('pending', 'needs_info')
      AND to_status = 'cancelled'
      AND transaction_id IS NULL)
    OR (action = 'request_info'
      AND actor_user_id IS NOT NULL
      AND from_status = 'pending'
      AND to_status = 'needs_info'
      AND transaction_id IS NULL)
    OR (action = 'approve'
      AND actor_user_id IS NOT NULL
      AND from_status = 'pending'
      AND to_status = 'approved'
      AND transaction_id IS NOT NULL)
    OR (action = 'reject'
      AND actor_user_id IS NOT NULL
      AND from_status IN ('pending', 'needs_info')
      AND to_status = 'rejected'
      AND transaction_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_point_request_events_device_key
  ON point_request_events(actor_device_binding_id, action, idempotency_key_hash)
  WHERE actor_device_binding_id IS NOT NULL;

CREATE UNIQUE INDEX uq_point_request_events_user_key
  ON point_request_events(family_id, actor_user_id, action, idempotency_key_hash)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX idx_point_request_events_request
  ON point_request_events(family_id, child_id, point_request_id, result_revision);

CREATE TRIGGER trg_point_request_events_insert_guard
BEFORE INSERT ON point_request_events
WHEN
  (
    NEW.actor_device_binding_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM device_bindings AS binding
      JOIN device_sessions AS session
        ON session.family_id = binding.family_id
       AND session.child_id = binding.child_id
       AND session.device_binding_id = binding.id
      JOIN users AS child
        ON child.family_id = binding.family_id
       AND child.id = binding.child_id
       AND child.role = 'child'
      JOIN child_privacy_states AS privacy
        ON privacy.family_id = binding.family_id
       AND privacy.child_id = binding.child_id
       AND privacy.status = 'active'
      JOIN guardian_consents AS consent
        ON consent.family_id = binding.family_id
       AND consent.child_id = binding.child_id
       AND consent.guardian_id = binding.created_by_guardian_id
       AND consent.status = 'active'
      JOIN point_accounts AS account
        ON account.family_id = binding.family_id
       AND account.kid_id = binding.child_id
      WHERE binding.id = NEW.actor_device_binding_id
        AND binding.family_id = NEW.family_id
        AND binding.child_id = NEW.child_id
        AND binding.status = 'active'
        AND session.status = 'active'
        AND json_extract(consent.consent_scope_json, '$.pointsLedger') = 1
        AND json_extract(consent.consent_scope_json, '$.pointRequests') = 1
        AND json_extract(consent.visibility_scope_json, '$.childDevice') = 'self_only'
    )
  )
  OR (
    NEW.actor_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM users AS adult
      JOIN users AS child
        ON child.family_id = adult.family_id
       AND child.id = NEW.child_id
       AND child.role = 'child'
      JOIN child_privacy_states AS privacy
        ON privacy.family_id = child.family_id
       AND privacy.child_id = child.id
       AND privacy.status = 'active'
      JOIN guardian_consents AS consent
        ON consent.family_id = child.family_id
       AND consent.child_id = child.id
       AND consent.guardian_id = adult.id
       AND consent.status = 'active'
      JOIN point_accounts AS account
        ON account.family_id = child.family_id
       AND account.kid_id = child.id
      WHERE adult.id = NEW.actor_user_id
        AND adult.family_id = NEW.family_id
        AND adult.role IN ('admin', 'parent')
        AND json_extract(consent.consent_scope_json, '$.pointsLedger') = 1
        AND json_extract(consent.consent_scope_json, '$.pointRequests') = 1
        AND json_extract(consent.visibility_scope_json, '$.guardian') = 'full'
    )
  )
  OR (
    NEW.action <> 'create'
    AND NOT EXISTS (
      SELECT 1 FROM point_requests AS request
      WHERE request.id = NEW.point_request_id
        AND request.family_id = NEW.family_id
        AND request.child_id = NEW.child_id
        AND request.status = NEW.from_status
        AND request.revision = NEW.result_revision - 1
    )
  )
  OR (
    NEW.action = 'create'
    AND EXISTS (
      SELECT 1 FROM point_requests AS request
      WHERE request.id = NEW.point_request_id
        AND (
          request.family_id <> NEW.family_id
          OR request.child_id <> NEW.child_id
          OR request.device_binding_id <> NEW.actor_device_binding_id
          OR request.status <> 'pending'
          OR request.revision <> 0
          OR request.request_fingerprint <> NEW.request_fingerprint
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_EVENT_SCOPE_INVALID');
END;

CREATE TRIGGER trg_point_request_events_no_replace
BEFORE INSERT ON point_request_events
WHEN
  EXISTS (
    SELECT 1 FROM point_request_events AS existing
    WHERE existing.id = NEW.id
  )
  OR (
    NEW.actor_device_binding_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM point_request_events AS existing
      WHERE existing.actor_device_binding_id = NEW.actor_device_binding_id
        AND existing.action = NEW.action
        AND existing.idempotency_key_hash = NEW.idempotency_key_hash
    )
  )
  OR (
    NEW.actor_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM point_request_events AS existing
      WHERE existing.family_id = NEW.family_id
        AND existing.actor_user_id = NEW.actor_user_id
        AND existing.action = NEW.action
        AND existing.idempotency_key_hash = NEW.idempotency_key_hash
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_EVENT_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_point_request_events_no_update
BEFORE UPDATE ON point_request_events
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_EVENT_IMMUTABLE');
END;

CREATE TRIGGER trg_point_request_events_no_delete
BEFORE DELETE ON point_request_events
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_EVENT_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_point_requests_insert_guard
BEFORE INSERT ON point_requests
WHEN
  NEW.status <> 'pending'
  OR NEW.revision <> 0
  OR NEW.approved_points IS NOT NULL
  OR NEW.request_info_note IS NOT NULL
  OR NEW.request_info_at IS NOT NULL
  OR NEW.resubmitted_at IS NOT NULL
  OR NEW.decision_note IS NOT NULL
  OR NEW.reviewer_user_id IS NOT NULL
  OR NEW.reviewed_at IS NOT NULL
  OR NEW.transaction_id IS NOT NULL
  OR NEW.submitted_at <> NEW.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM point_request_events AS event
    WHERE event.point_request_id = NEW.id
      AND event.family_id = NEW.family_id
      AND event.child_id = NEW.child_id
      AND event.actor_device_binding_id = NEW.device_binding_id
      AND event.action = 'create'
      AND event.request_fingerprint = NEW.request_fingerprint
      AND event.result_revision = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_INSERT_INVALID');
END;

CREATE TRIGGER trg_point_requests_no_replace
BEFORE INSERT ON point_requests
WHEN
  EXISTS (
    SELECT 1 FROM point_requests AS existing
    WHERE existing.id = NEW.id
       OR (
         existing.device_binding_id = NEW.device_binding_id
         AND existing.client_request_id = NEW.client_request_id
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_point_requests_core_immutable
BEFORE UPDATE ON point_requests
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.device_binding_id IS NOT OLD.device_binding_id
  OR NEW.client_request_id IS NOT OLD.client_request_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.rule_id IS NOT OLD.rule_id
  OR NEW.category_id IS NOT OLD.category_id
  OR NEW.rule_revision IS NOT OLD.rule_revision
  OR NEW.rule_label_snapshot IS NOT OLD.rule_label_snapshot
  OR NEW.category_label_snapshot IS NOT OLD.category_label_snapshot
  OR NEW.rule_unit_snapshot IS NOT OLD.rule_unit_snapshot
  OR NEW.rule_min_points IS NOT OLD.rule_min_points
  OR NEW.rule_default_points IS NOT OLD.rule_default_points
  OR NEW.rule_max_points IS NOT OLD.rule_max_points
  OR NEW.child_alias_snapshot IS NOT OLD.child_alias_snapshot
  OR NEW.requested_points IS NOT OLD.requested_points
  OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.period_key IS NOT OLD.period_key
  OR NEW.duplicate_suspected IS NOT OLD.duplicate_suspected
  OR NEW.submitted_at IS NOT OLD.submitted_at
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_CORE_IMMUTABLE');
END;

CREATE TRIGGER trg_point_requests_lifecycle_guard
BEFORE UPDATE ON point_requests
WHEN
  NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('needs_info', 'approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'needs_info' AND NEW.status IN ('pending', 'rejected', 'cancelled'))
  )
  OR (
    NOT (OLD.status = 'needs_info' AND NEW.status = 'pending')
    AND NEW.description IS NOT OLD.description
  )
  OR (
    OLD.status = 'pending' AND NEW.status = 'needs_info'
    AND (
      NEW.request_info_note IS NULL
      OR NEW.request_info_at <> NEW.updated_at
      OR NEW.resubmitted_at IS NOT NULL
    )
  )
  OR (
    OLD.status = 'needs_info' AND NEW.status = 'pending'
    AND NEW.resubmitted_at <> NEW.updated_at
  )
  OR (
    NOT (OLD.status = 'pending' AND NEW.status = 'needs_info')
    AND (
      NEW.request_info_note IS NOT OLD.request_info_note
      OR NEW.request_info_at IS NOT OLD.request_info_at
    )
  )
  OR (
    NOT (
      (OLD.status = 'needs_info' AND NEW.status = 'pending')
      OR (OLD.status = 'pending' AND NEW.status = 'needs_info')
    )
    AND NEW.resubmitted_at IS NOT OLD.resubmitted_at
  )
  OR (
    NEW.status = 'approved'
    AND (
      NEW.approved_points IS NULL
      OR NEW.reviewer_user_id IS NULL
      OR NEW.reviewed_at <> NEW.updated_at
      OR NEW.transaction_id IS NULL
      OR EXISTS (
        SELECT 1 FROM transactions AS existing
        WHERE existing.id = NEW.transaction_id
      )
    )
  )
  OR (
    NEW.status = 'rejected'
    AND (
      NEW.approved_points IS NOT NULL
      OR NEW.reviewer_user_id IS NULL
      OR NEW.reviewed_at <> NEW.updated_at
      OR NEW.transaction_id IS NOT NULL
      OR NEW.decision_note IS NULL
    )
  )
  OR (
    NEW.status = 'cancelled'
    AND (
      NEW.approved_points IS NOT NULL
      OR NEW.reviewer_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL
      OR NEW.transaction_id IS NOT NULL
      OR NEW.decision_note IS NOT NULL
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM point_request_events AS event
    WHERE event.point_request_id = OLD.id
      AND event.family_id = OLD.family_id
      AND event.child_id = OLD.child_id
      AND event.from_status = OLD.status
      AND event.to_status = NEW.status
      AND event.result_revision = NEW.revision
      AND event.created_at = NEW.updated_at
      AND (
        (NEW.status = 'pending'
          AND event.action = 'resubmit'
          AND json_extract(event.event_data_json, '$.description') IS NEW.description)
        OR (NEW.status = 'needs_info'
          AND event.action = 'request_info'
          AND json_extract(event.event_data_json, '$.note') IS NEW.request_info_note)
        OR (NEW.status = 'approved'
          AND event.action = 'approve'
          AND event.actor_user_id = NEW.reviewer_user_id
          AND event.transaction_id = NEW.transaction_id
          AND json_extract(event.event_data_json, '$.approvedPoints') IS NEW.approved_points
          AND json_extract(event.event_data_json, '$.note') IS NEW.decision_note)
        OR (NEW.status = 'rejected'
          AND event.action = 'reject'
          AND event.actor_user_id = NEW.reviewer_user_id
          AND json_extract(event.event_data_json, '$.note') IS NEW.decision_note)
        OR (NEW.status = 'cancelled' AND event.action = 'cancel')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_LIFECYCLE_INVALID');
END;

CREATE TRIGGER trg_point_requests_no_delete
BEFORE DELETE ON point_requests
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_DELETE_FORBIDDEN');
END;

-- Approval updates the request first using a deferred transaction FK, then
-- inserts the source ledger entry. This guard verifies the complete snapshot.
CREATE TRIGGER trg_transactions_point_request_source_guard
BEFORE INSERT ON transactions
WHEN NEW.source_type = 'point_request'
  AND (
    NEW.deleted_at IS NOT NULL
    OR NOT EXISTS (
    SELECT 1 FROM point_requests AS request
    JOIN users AS reviewer
      ON reviewer.family_id = request.family_id
     AND reviewer.id = request.reviewer_user_id
    WHERE request.id = NEW.source_id
      AND request.family_id = NEW.family_id
      AND request.child_id = NEW.kid_id
      AND request.status = 'approved'
      AND request.transaction_id = NEW.id
      AND request.approved_points = NEW.amount
      AND request.rule_id = NEW.rule_id
      AND request.category_id = NEW.category_id
      AND request.rule_label_snapshot = NEW.reason
      AND request.child_alias_snapshot = NEW.kid_name
      AND request.occurred_at = NEW.occurred_at
      AND reviewer.name = NEW.operator
      AND COALESCE(request.decision_note, '') = NEW.note
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_LEDGER_SCOPE_INVALID');
END;

-- A deferred request FK permits the service to approve the request before it
-- inserts the ledger row. Never let that slot be satisfied by a legacy,
-- source-less transaction with a chosen ID.
CREATE TRIGGER trg_transactions_point_request_requires_source
BEFORE INSERT ON transactions
WHEN NEW.source_type IS NULL
  AND EXISTS (
    SELECT 1 FROM point_requests AS request
    WHERE request.transaction_id = NEW.id
      AND request.status = 'approved'
  )
BEGIN
  SELECT RAISE(ABORT, 'POINT_REQUEST_LEDGER_SOURCE_REQUIRED');
END;

CREATE TRIGGER trg_transactions_sourced_immutable
BEFORE UPDATE ON transactions
WHEN OLD.source_type IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SOURCED_TRANSACTION_IMMUTABLE');
END;

CREATE TRIGGER trg_transactions_sourced_no_replace
BEFORE INSERT ON transactions
WHEN EXISTS (
  SELECT 1 FROM transactions AS existing
  WHERE existing.id = NEW.id AND existing.source_type IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'SOURCED_TRANSACTION_REPLACE_FORBIDDEN');
END;

CREATE TRIGGER trg_transactions_sourced_no_delete
BEFORE DELETE ON transactions
WHEN OLD.source_type IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SOURCED_TRANSACTION_DELETE_FORBIDDEN');
END;
