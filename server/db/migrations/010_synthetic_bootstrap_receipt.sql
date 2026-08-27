-- Stage 1 / S14: immutable receipt for the one-time synthetic bootstrap.
--
-- The table is present in every schema but may only be populated by the
-- offline synthetic bootstrap command. Production and ordinary runtime paths
-- never create a receipt. The bootstrap command inserts this row last, in the
-- same transaction as the initial synthetic administrator and legal evidence.

CREATE TABLE synthetic_bootstrap_receipts (
  singleton_id INTEGER PRIMARY KEY
    CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  status TEXT NOT NULL
    CHECK (status = 'completed'),
  request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(request_id_sha256) = 64
      AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_fingerprint_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(request_fingerprint_sha256) = 64
      AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  source_commit TEXT NOT NULL
    CHECK (
      length(source_commit) IN (40, 64)
      AND source_commit NOT GLOB '*[^0-9a-f]*'
    ),
  implementation_tree_sha256 TEXT NOT NULL
    CHECK (
      length(implementation_tree_sha256) = 64
      AND implementation_tree_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  preflight_configuration_sha256 TEXT NOT NULL
    CHECK (
      length(preflight_configuration_sha256) = 64
      AND preflight_configuration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  deployment_fingerprint_sha256 TEXT NOT NULL
    CHECK (
      length(deployment_fingerprint_sha256) = 64
      AND deployment_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  marker_sha256 TEXT NOT NULL
    CHECK (
      length(marker_sha256) = 64
      AND marker_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  schema_fingerprint_sha256 TEXT NOT NULL
    CHECK (
      length(schema_fingerprint_sha256) = 64
      AND schema_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  dataset_id_sha256 TEXT NOT NULL
    CHECK (
      length(dataset_id_sha256) = 64
      AND dataset_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approval_reference_sha256 TEXT NOT NULL
    CHECK (
      length(approval_reference_sha256) = 64
      AND approval_reference_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  family_id TEXT NOT NULL
    CHECK (family_id = 'default'),
  administrator_id TEXT NOT NULL,
  administrator_id_sha256 TEXT NOT NULL
    CHECK (
      length(administrator_id_sha256) = 64
      AND administrator_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  credential_method TEXT NOT NULL
    CHECK (credential_method = 'scrypt-v1'),
  legal_text_count INTEGER NOT NULL
    CHECK (legal_text_count = 4),
  legal_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(legal_evidence_sha256) = 64
      AND legal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  relation_declaration_version TEXT NOT NULL
    CHECK (length(trim(relation_declaration_version)) BETWEEN 1 AND 64),
  relation_declaration_sha256 TEXT NOT NULL
    CHECK (
      length(relation_declaration_sha256) = 64
      AND relation_declaration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  relation_declaration_public_url TEXT NOT NULL
    CHECK (relation_declaration_public_url LIKE 'https://%'),
  completed_at TEXT NOT NULL,
  FOREIGN KEY (family_id, administrator_id)
    REFERENCES users(family_id, id)
);

-- A second insert is rejected before conflict resolution can turn INSERT OR
-- REPLACE into an implicit delete-and-insert sequence.
CREATE TRIGGER trg_synthetic_bootstrap_receipt_once
BEFORE INSERT ON synthetic_bootstrap_receipts
WHEN EXISTS (SELECT 1 FROM synthetic_bootstrap_receipts)
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_BOOTSTRAP_ALREADY_COMPLETED');
END;

-- The completion receipt may only be committed alongside the exact minimum
-- synthetic seed. Later runtime data does not rewrite this historical proof.
CREATE TRIGGER trg_synthetic_bootstrap_receipt_seed_guard
BEFORE INSERT ON synthetic_bootstrap_receipts
WHEN
  (SELECT COUNT(*) FROM families) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM families
    WHERE id = 'default'
      AND name = '合成默认家庭'
      AND invite_code IS NULL
      AND invite_json IS NULL
  )
  OR (SELECT COUNT(*) FROM users) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.administrator_id
      AND family_id = 'default'
      AND role = 'admin'
      AND name = '合成管理员'
      AND openid IS NULL
      AND bound_at IS NULL
      AND tokens_valid_after = 0
      AND length(password) = 161
      AND substr(password, 33, 1) = ':'
      AND substr(password, 1, 32) NOT GLOB '*[^0-9a-f]*'
      AND substr(password, 34, 128) NOT GLOB '*[^0-9a-f]*'
  )
  OR (SELECT COUNT(*) FROM legal_text_versions) <> 4
  OR EXISTS (
    SELECT required.text_type
    FROM (
      SELECT 'privacy_policy' AS text_type
      UNION ALL SELECT 'child_personal_information_rules'
      UNION ALL SELECT 'child_user_agreement'
      UNION ALL SELECT 'sensitive_information_notice'
    ) AS required
    WHERE NOT EXISTS (
      SELECT 1 FROM legal_text_versions AS actual
      WHERE actual.text_type = required.text_type
    )
  )
  OR EXISTS (SELECT 1 FROM rules)
  OR EXISTS (SELECT 1 FROM rule_versions)
  OR EXISTS (SELECT 1 FROM rules_v25_archive)
  OR EXISTS (SELECT 1 FROM rule_versions_v25_archive)
  OR EXISTS (SELECT 1 FROM transaction_rule_links_v25_archive)
  OR EXISTS (SELECT 1 FROM point_accounts)
  OR EXISTS (SELECT 1 FROM transactions)
  OR EXISTS (SELECT 1 FROM reauth_assertions)
  OR EXISTS (SELECT 1 FROM child_privacy_states)
  OR EXISTS (SELECT 1 FROM guardian_consents)
  OR EXISTS (SELECT 1 FROM v2_idempotency_records)
  OR EXISTS (SELECT 1 FROM pairing_claim_attempt_windows)
  OR EXISTS (SELECT 1 FROM pairing_challenges)
  OR EXISTS (SELECT 1 FROM device_bindings)
  OR EXISTS (SELECT 1 FROM device_sessions)
  OR EXISTS (SELECT 1 FROM device_session_challenges)
  OR EXISTS (SELECT 1 FROM point_requests)
  OR EXISTS (SELECT 1 FROM point_request_events)
  OR EXISTS (SELECT 1 FROM data_rights_requests)
  OR EXISTS (SELECT 1 FROM audit_events)
  OR EXISTS (SELECT 1 FROM data_deletion_jobs)
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_BOOTSTRAP_SEED_INVALID');
END;

CREATE TRIGGER trg_synthetic_bootstrap_receipt_no_update
BEFORE UPDATE ON synthetic_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_BOOTSTRAP_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_synthetic_bootstrap_receipt_no_delete
BEFORE DELETE ON synthetic_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_BOOTSTRAP_RECEIPT_DELETE_FORBIDDEN');
END;
