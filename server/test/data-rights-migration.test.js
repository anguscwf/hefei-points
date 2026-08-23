const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-data-rights-migration-'));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const migrationsThrough008 = [
  '001_init.sql',
  '002_token_revocation.sql',
  '003_transaction_soft_delete.sql',
  '004_family_rules_history.sql',
  '005_transaction_rule_ids.sql',
  '006_guardian_consent_enrollment.sql',
  '007_device_pairing_sessions.sql',
  '008_point_requests_transaction_sources.sql'
];
const migration009 = '009_data_rights_audit.sql';
let sequence = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function openDatabase(label) {
  const db = new DatabaseSync(path.join(
    tempDir, `${String(++sequence).padStart(2, '0')}-${label}.sqlite`
  ));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return db;
}

function applyMigration(db, filename) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(filename)) return false;
  const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(filename, '2026-08-23T00:00:00.000Z');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rows(db, sql) {
  return db.prepare(sql).all().map(row => ({ ...row }));
}

function assertHealthy(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
}

function insertLegalTexts(db) {
  const legal = [
    ['privacy_policy', 'privacy-v1', 'a'.repeat(64), 'https://example.invalid/privacy'],
    [
      'child_personal_information_rules', 'child-rules-v1', 'b'.repeat(64),
      'https://example.invalid/child-rules'
    ],
    [
      'child_user_agreement', 'child-agreement-v1', 'c'.repeat(64),
      'https://example.invalid/child-agreement'
    ],
    [
      'sensitive_information_notice', 'sensitive-v1', 'd'.repeat(64),
      'https://example.invalid/sensitive'
    ]
  ];
  const insertText = db.prepare(`
    INSERT INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  legal.forEach((row, index) => {
    const timestamp = `2026-08-23T08:0${index + 1}:00.000Z`;
    insertText.run(...row, timestamp, timestamp);
  });
}

function insertConsent(db, {
  suffix,
  guardianId = `guardian_${suffix}`,
  consentId = `consent_${suffix}`,
  reauthId = `reauth_consent_${guardianId}`,
  childProfile = true,
  guardianVisibility = 'full'
}) {
  const familyId = `family_${suffix}`;
  const childId = `child_${suffix}`;
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, 'child_consent', ?, 'password_reauth', ?, ?, ?)
  `).run(
    reauthId, familyId, guardianId, sha256(`token-${reauthId}`),
    '2026-08-23T08:10:00.000Z', '2026-08-23T08:15:00.000Z',
    '2026-08-23T08:11:00.000Z'
  );
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
      audit_data_json, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 1,
      'privacy-v1', ?, 'child-rules-v1', ?,
      'child-agreement-v1', ?, 'sensitive-v1', ?,
      'legal_guardian', 'guardian-relation-v1', ?,
      ?, 'password_reauth', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?
    )
  `).run(
    consentId, familyId, childId, guardianId,
    'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64),
    reauthId, '2026-08-23T08:11:00.000Z',
    JSON.stringify({ childProfile, pointsLedger: true, pointRequests: true }),
    JSON.stringify({ guardian: guardianVisibility, childDevice: 'self_only' }),
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z'
  );
}

function activateChild(db, suffix) {
  db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active', revision = revision + 1,
        reason_code = 'synthetic_consent', activated_at = ?, updated_at = ?
    WHERE family_id = ? AND child_id = ? AND revision = 0
  `).run(
    '2026-08-23T08:13:00.000Z', '2026-08-23T08:13:00.000Z',
    `family_${suffix}`, `child_${suffix}`
  );
}

function p256Spki() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { encoded: der.toString('base64url'), hash: sha256(der) };
}

function seedDevice(db, suffix, label) {
  const familyId = `family_${suffix}`;
  const childId = `child_${suffix}`;
  const guardianId = `guardian_${suffix}`;
  const pairingId = `pairing_${label}`;
  const bindingId = `binding_${label}`;
  const sessionId = `session_${label}`;
  const challengeId = `refresh_challenge_${label}`;
  const key = p256Spki();
  db.prepare(`
    INSERT INTO pairing_challenges(
      id, family_id, child_id, issued_by_guardian_id, guardian_consent_id,
      parent_challenge_hash, short_code_hmac, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pairingId, familyId, childId, guardianId, `consent_${suffix}`,
    sha256(`parent-${label}`), sha256(`short-${label}`),
    '2026-08-23T09:10:00.000Z', '2026-08-23T09:00:00.000Z',
    '2026-08-23T09:00:00.000Z'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE pairing_challenges
      SET status = 'claimed', revision = 1,
          claim_token_hash = ?, claim_idempotency_key_hash = ?,
          claim_request_fingerprint = ?, claimed_device_binding_id = ?,
          claimed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      sha256(`claim-${label}`), sha256(`claim-key-${label}`),
      sha256(`claim-fingerprint-${label}`), bindingId,
      '2026-08-23T09:01:00.000Z', '2026-08-23T09:01:00.000Z', pairingId
    );
    db.prepare(`
      INSERT INTO device_bindings(
        id, family_id, child_id, authorized_by_consent_id, pairing_challenge_id,
        created_by_guardian_id, device_public_id, public_key_algorithm,
        device_public_key_spki, public_key_sha256, device_alias,
        claimed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ECDSA_P256_SHA256', ?, ?, ?, ?, ?, ?)
    `).run(
      bindingId, familyId, childId, `consent_${suffix}`, pairingId, guardianId,
      `synthetic_device_public_${label}`, key.encoded, key.hash, `合成设备 ${label}`,
      '2026-08-23T09:01:00.000Z', '2026-08-23T09:01:00.000Z',
      '2026-08-23T09:01:00.000Z'
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.prepare(`
    UPDATE pairing_challenges
    SET status = 'confirmed', revision = 2, confirmed_at = ?, updated_at = ?
    WHERE id = ?
  `).run('2026-08-23T09:02:00.000Z', '2026-08-23T09:02:00.000Z', pairingId);
  db.prepare(`
    UPDATE device_bindings
    SET status = 'active', revision = 1, activated_at = ?, updated_at = ?
    WHERE id = ?
  `).run('2026-08-23T09:03:00.000Z', '2026-08-23T09:03:00.000Z', bindingId);
  db.prepare(`
    INSERT INTO device_sessions(
      id, family_id, child_id, device_binding_id, token_family_id, rotation_counter,
      access_token_hash, refresh_token_hash, issued_at, access_expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, familyId, childId, bindingId, `token_family_synthetic_${label}`,
    sha256(`access-${label}`), sha256(`refresh-${label}`),
    '2026-08-23T09:04:00.000Z', '2026-08-23T10:04:00.000Z',
    '2026-09-23T09:04:00.000Z', '2026-08-23T09:04:00.000Z',
    '2026-08-23T09:04:00.000Z'
  );
  db.prepare(`
    INSERT INTO device_session_challenges(
      id, family_id, child_id, device_binding_id, device_session_id, purpose,
      challenge_hash, issue_idempotency_key_hash, issue_request_fingerprint,
      issued_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'session_refresh', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    challengeId, familyId, childId, bindingId, sessionId,
    sha256(`challenge-${label}`), sha256(`challenge-key-${label}`),
    sha256(`challenge-fingerprint-${label}`),
    '2026-08-23T09:05:00.000Z', '2026-08-23T09:07:00.000Z',
    '2026-08-23T09:05:00.000Z', '2026-08-23T09:05:00.000Z'
  );
}

function seedApprovedPointRequest(db) {
  const requestId = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const transactionId = 'approved-source-transaction-a';
  const submittedAt = '2026-08-23T09:10:00.000Z';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO point_request_events(
        id, family_id, child_id, point_request_id, actor_device_binding_id,
        action, idempotency_key_hash, request_fingerprint,
        from_status, to_status, result_revision, response_status,
        event_data_json, created_at
      ) VALUES (
        'point-event-create-a', 'family_a', 'child_a', ?, 'binding_a1',
        'create', ?, ?, NULL, 'pending', 0, 201, ?, ?
      )
    `).run(
      requestId, '1'.repeat(64), '2'.repeat(64),
      JSON.stringify({ clientRequestId: 'client-migration-rights-001' }), submittedAt
    );
    db.prepare(`
      INSERT INTO point_requests(
        id, family_id, child_id, device_binding_id,
        client_request_id, request_fingerprint,
        rule_id, category_id, rule_revision,
        rule_label_snapshot, category_label_snapshot, rule_unit_snapshot,
        rule_min_points, rule_default_points, rule_max_points,
        child_alias_snapshot, requested_points, description, occurred_at,
        period_key, duplicate_suspected, submitted_at, updated_at
      ) VALUES (
        ?, 'family_a', 'child_a', 'binding_a1',
        'client-migration-rights-001', ?, 'reward_rule', 'reward_category', 4,
        '提交时规则名称', '提交时分类名称', '每次', 2, 4, 10,
        '合成孩子 A', 8, '合成迁移申请说明', ?, '2026-08-23', 0, ?, ?
      )
    `).run(requestId, '2'.repeat(64), submittedAt, submittedAt, submittedAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const approvedAt = '2026-08-23T09:11:00.000Z';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO point_request_events(
        id, family_id, child_id, point_request_id, actor_user_id,
        action, idempotency_key_hash, request_fingerprint,
        from_status, to_status, result_revision, response_status,
        transaction_id, event_data_json, created_at
      ) VALUES (
        'point-event-approve-a', 'family_a', 'child_a', ?, 'guardian_a',
        'approve', ?, ?, 'pending', 'approved', 1, 200, ?, ?, ?
      )
    `).run(
      requestId, '3'.repeat(64), '4'.repeat(64), transactionId,
      JSON.stringify({ approvedPoints: 8 }), approvedAt
    );
    db.prepare(`
      UPDATE point_requests
      SET status = 'approved', revision = 1, approved_points = 8,
          reviewer_user_id = 'guardian_a', reviewed_at = ?,
          transaction_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND revision = 0
    `).run(approvedAt, transactionId, approvedAt, requestId);
    db.prepare(`
      INSERT INTO transactions(
        id, family_id, occurred_at, kid_id, kid_name, amount,
        reason, operator, note, rule_id, category_id, source_type, source_id
      ) VALUES (?, 'family_a', ?, 'child_a', '合成孩子 A', 8,
                '提交时规则名称', '合成监护人 A', '',
                'reward_rule', 'reward_category', 'point_request', ?)
    `).run(transactionId, submittedAt, requestId);
    db.prepare(`
      UPDATE point_accounts SET balance = balance + 8
      WHERE family_id = 'family_a' AND kid_id = 'child_a'
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedThrough008(db) {
  for (const filename of migrationsThrough008.slice(0, 5)) applyMigration(db, filename);
  const at = '2026-08-23T08:00:00.000Z';
  for (const suffix of ['a', 'b']) {
    db.prepare(`
      INSERT INTO families(id, name, created_at) VALUES (?, ?, ?)
    `).run(`family_${suffix}`, `合成家庭 ${suffix.toUpperCase()}`, at);
    db.prepare(`
      INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
      VALUES (?, ?, 'admin', '', ?, 0)
    `).run(`guardian_${suffix}`, `合成监护人 ${suffix.toUpperCase()}`, `family_${suffix}`);
    db.prepare(`
      INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
      VALUES (?, ?, 'child', '', ?, 0)
    `).run(`child_${suffix}`, `合成孩子 ${suffix.toUpperCase()}`, `family_${suffix}`);
    db.prepare(`
      INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)
    `).run(`family_${suffix}`, `child_${suffix}`, suffix === 'a' ? 12 : 4);
  }
  db.prepare(`
    INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
    VALUES ('outsider_a', '合成无授权成人', 'parent', '', 'family_a', 0)
  `).run();
  db.prepare(`
    INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
    VALUES ('limited_a', '合成受限监护人', 'parent', '', 'family_a', 0)
  `).run();
  db.prepare(`
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount,
      reason, operator, note, deleted_at, rule_id, category_id
    ) VALUES (
      'legacy-tx-a', 'family_a', ?, 'child_a', '合成孩子 A', 12,
      '009 前合成旧流水', '合成监护人 A', '普通旧流水', ?, NULL, NULL
    )
  `).run(at, '2026-08-23T08:30:00.000Z');

  applyMigration(db, migrationsThrough008[5]);
  insertLegalTexts(db);
  insertConsent(db, { suffix: 'a' });
  insertConsent(db, { suffix: 'b' });
  insertConsent(db, {
    suffix: 'a',
    guardianId: 'limited_a',
    consentId: 'consent_limited_a',
    childProfile: false,
    guardianVisibility: 'none'
  });
  activateChild(db, 'a');
  activateChild(db, 'b');

  applyMigration(db, migrationsThrough008[6]);
  seedDevice(db, 'a', 'a1');
  seedDevice(db, 'a', 'a2');
  seedDevice(db, 'b', 'b1');

  applyMigration(db, migrationsThrough008[7]);
  seedApprovedPointRequest(db);
}

function seedRightsReauth(db, {
  id,
  suffix = 'a',
  guardianId = `guardian_${suffix}`,
  requestType = 'access',
  purpose = ({
    access: 'child_data_access',
    export: 'child_data_export',
    correct: 'child_data_correct',
    withdraw: 'child_consent_withdraw',
    delete: 'child_data_delete',
    terminate: 'child_service_terminate'
  })[requestType],
  consumed = true,
  revoked = false,
  verificationMethod = 'password_reauth',
  issuedAt = '2026-08-23T10:00:00.000Z',
  expiresAt = '2026-08-23T10:05:00.000Z',
  consumedAt = '2026-08-23T10:01:00.000Z'
}) {
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `family_${suffix}`, guardianId, purpose, sha256(`rights-${id}`),
    verificationMethod, issuedAt, expiresAt,
    consumed ? consumedAt : null, revoked ? consumedAt : null
  );
}

function validCorrectionPayload() {
  return JSON.stringify({
    field: 'alias',
    expectedValueSha256: '7'.repeat(64),
    newValueSha256: '8'.repeat(64)
  });
}

function insertRequestedRight(db, {
  requestId,
  requestType = 'access',
  familyId = 'family_a',
  childId = 'child_a',
  guardianId = 'guardian_a',
  consentId = 'consent_a',
  reauthId,
  payload = requestType === 'correct' ? validCorrectionPayload() : '{}',
  verificationMethod = 'password_reauth',
  verifiedAt = '2026-08-23T10:01:00.000Z',
  at = '2026-08-23T10:02:00.000Z'
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO audit_events(
        id, family_id, child_id, actor_user_id, resource_type, resource_id,
        event_type, from_status, to_status, result_revision,
        event_data_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'data_rights_request', ?,
        'data_rights_requested', NULL, 'requested', 0, ?, ?
      )
    `).run(
      `audit-${requestId}-0`, familyId, childId, guardianId, requestId,
      JSON.stringify({ requestType }), at
    );
    db.prepare(`
      INSERT INTO data_rights_requests(
        id, family_id, child_id, guardian_id, request_type,
        source_consent_id, reauth_assertion_id, verification_method, verified_at,
        request_fingerprint, request_payload_json, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, familyId, childId, guardianId, requestType,
      consentId, reauthId, verificationMethod, verifiedAt,
      sha256(`${requestId}:${requestType}`), payload, at, at
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function verifyRight(db, requestId, at = '2026-08-23T10:03:00.000Z') {
  const request = db.prepare(`
    SELECT family_id, child_id, guardian_id FROM data_rights_requests WHERE id = ?
  `).get(requestId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO audit_events(
        id, family_id, child_id, actor_user_id, resource_type, resource_id,
        event_type, from_status, to_status, result_revision,
        event_data_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'data_rights_request', ?,
        'data_rights_verified', 'requested', 'verified', 1, ?, ?
      )
    `).run(
      `audit-${requestId}-1`, request.family_id, request.child_id, request.guardian_id,
      requestId, JSON.stringify({ resultCode: 'identity_verified' }), at
    );
    db.prepare(`
      UPDATE data_rights_requests
      SET status = 'verified', revision = 1, updated_at = ?
      WHERE id = ? AND status = 'requested' AND revision = 0
    `).run(at, requestId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function startBlockedDeletion(db, requestId, at = '2026-08-23T10:04:00.000Z') {
  const request = db.prepare(`
    SELECT family_id, child_id, guardian_id, request_type
    FROM data_rights_requests WHERE id = ?
  `).get(requestId);
  const jobId = `job-${requestId}`;
  const reasonCode = request.request_type === 'terminate'
    ? 'data_rights_terminate_requested'
    : 'data_rights_delete_requested';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO data_deletion_jobs(
        id, family_id, child_id, request_id, status, retention_decision,
        blocked_reason, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, 'blocked_policy', 'policy_pending',
                'retention_policy_unapproved', ?, ?)
    `).run(jobId, request.family_id, request.child_id, requestId, at, at);
    db.prepare(`
      INSERT INTO audit_events(
        id, family_id, child_id, actor_user_id, resource_type, resource_id,
        event_type, from_status, to_status, result_revision,
        event_data_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'data_rights_request', ?,
        'data_rights_processing', 'verified', 'processing', 2, ?, ?
      )
    `).run(
      `audit-${requestId}-2`, request.family_id, request.child_id, request.guardian_id,
      requestId, JSON.stringify({ deletionJobId: jobId, retentionDecision: 'policy_pending' }), at
    );
    db.prepare(`
      UPDATE child_privacy_states
      SET status = 'deletion_pending', revision = revision + 1,
          reason_code = ?, blocked_at = ?, deletion_requested_at = ?, updated_at = ?
      WHERE family_id = ? AND child_id = ?
        AND status IN ('suspended_pending_consent', 'active', 'processing_blocked')
    `).run(reasonCode, at, at, at, request.family_id, request.child_id);
    db.prepare(`
      UPDATE data_rights_requests
      SET status = 'processing', revision = 2,
          retention_decision = 'policy_pending',
          result_receipt_code = 'RETENTION_POLICY_PENDING',
          result_receipt_message = '逐类保留策略尚未批准，删除作业保持阻断',
          processing_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'verified' AND revision = 1
    `).run(at, at, requestId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return jobId;
}

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('009 从 008 前滚保留 007/008 数据且不伪造行权、审计或删除作业', () => {
  const db = openDatabase('preservation');
  try {
    seedThrough008(db);
    const before = {
      families: rows(db, 'SELECT * FROM families ORDER BY id'),
      users: rows(db, 'SELECT * FROM users ORDER BY id'),
      accounts: rows(db, 'SELECT * FROM point_accounts ORDER BY family_id, kid_id'),
      transactions: rows(db, 'SELECT * FROM transactions ORDER BY id'),
      consents: rows(db, 'SELECT * FROM guardian_consents ORDER BY id'),
      privacy: rows(db, 'SELECT * FROM child_privacy_states ORDER BY family_id, child_id'),
      pairings: rows(db, 'SELECT * FROM pairing_challenges ORDER BY id'),
      bindings: rows(db, 'SELECT * FROM device_bindings ORDER BY id'),
      sessions: rows(db, 'SELECT * FROM device_sessions ORDER BY id'),
      sessionChallenges: rows(db, 'SELECT * FROM device_session_challenges ORDER BY id'),
      pointRequests: rows(db, 'SELECT * FROM point_requests ORDER BY id'),
      pointEvents: rows(db, 'SELECT * FROM point_request_events ORDER BY id')
    };

    assert.equal(applyMigration(db, migration009), true);

    assert.deepEqual({
      families: rows(db, 'SELECT * FROM families ORDER BY id'),
      users: rows(db, 'SELECT * FROM users ORDER BY id'),
      accounts: rows(db, 'SELECT * FROM point_accounts ORDER BY family_id, kid_id'),
      transactions: rows(db, 'SELECT * FROM transactions ORDER BY id'),
      consents: rows(db, 'SELECT * FROM guardian_consents ORDER BY id'),
      privacy: rows(db, 'SELECT * FROM child_privacy_states ORDER BY family_id, child_id'),
      pairings: rows(db, 'SELECT * FROM pairing_challenges ORDER BY id'),
      bindings: rows(db, 'SELECT * FROM device_bindings ORDER BY id'),
      sessions: rows(db, 'SELECT * FROM device_sessions ORDER BY id'),
      sessionChallenges: rows(db, 'SELECT * FROM device_session_challenges ORDER BY id'),
      pointRequests: rows(db, 'SELECT * FROM point_requests ORDER BY id'),
      pointEvents: rows(db, 'SELECT * FROM point_request_events ORDER BY id')
    }, before);
    assert.deepEqual({ ...db.prepare(`
      SELECT source_type, source_id, deleted_at
      FROM transactions WHERE id = 'legacy-tx-a'
    `).get() }, { source_type: null, source_id: null, deleted_at: '2026-08-23T08:30:00.000Z' });
    assert.deepEqual({ ...db.prepare(`
      SELECT source_type, source_id, deleted_at
      FROM transactions WHERE id = 'approved-source-transaction-a'
    `).get() }, {
      source_type: 'point_request',
      source_id: 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deleted_at: null
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_rights_requests').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_deletion_jobs').get().count, 0);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('009 请求必须绑定同家庭有范围的监护证据与已消费的正确用途重新认证', () => {
  const db = openDatabase('scope-reauth');
  try {
    seedThrough008(db);
    applyMigration(db, migration009);

    for (const requestType of ['access', 'export', 'correct', 'withdraw', 'delete']) {
      const reauthId = `reauth-rights-valid-${requestType}-a`;
      const requestId = requestType === 'access'
        ? 'rights-access-valid-a'
        : `rights-${requestType}-valid-a`;
      seedRightsReauth(db, { id: reauthId, requestType });
      insertRequestedRight(db, { requestId, requestType, reauthId });
    }
    seedRightsReauth(db, {
      id: 'reauth-rights-valid-terminate-b', suffix: 'b', requestType: 'terminate'
    });
    insertRequestedRight(db, {
      requestId: 'rights-terminate-valid-b', requestType: 'terminate',
      familyId: 'family_b', childId: 'child_b', guardianId: 'guardian_b',
      consentId: 'consent_b', reauthId: 'reauth-rights-valid-terminate-b'
    });

    seedRightsReauth(db, {
      id: 'reauth-rights-wrong-purpose-a', purpose: 'child_enrollment'
    });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-wrong-purpose-a',
      reauthId: 'reauth-rights-wrong-purpose-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, { id: 'reauth-rights-unconsumed-a', consumed: false });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-unconsumed-a',
      reauthId: 'reauth-rights-unconsumed-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, { id: 'reauth-rights-revoked-a', consumed: false, revoked: true });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-revoked-a',
      reauthId: 'reauth-rights-revoked-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, { id: 'reauth-rights-verified-at-mismatch-a' });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-verified-at-mismatch-a',
      reauthId: 'reauth-rights-verified-at-mismatch-a',
      verifiedAt: '2026-08-23T10:01:01.000Z'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, {
      id: 'reauth-rights-expired-a',
      expiresAt: '2026-08-23T10:01:00.000Z'
    });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-expired-a',
      reauthId: 'reauth-rights-expired-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, { id: 'reauth-rights-method-mismatch-a' });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-method-mismatch-a',
      reauthId: 'reauth-rights-method-mismatch-a',
      verificationMethod: 'passkey_reauth'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, {
      id: 'reauth-rights-outsider-a', guardianId: 'outsider_a'
    });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-outsider-a', guardianId: 'outsider_a',
      reauthId: 'reauth-rights-outsider-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID|FOREIGN KEY constraint failed/);

    seedRightsReauth(db, {
      id: 'reauth-rights-limited-a', guardianId: 'limited_a'
    });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-limited-a', guardianId: 'limited_a',
      consentId: 'consent_limited_a', reauthId: 'reauth-rights-limited-a'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID/);

    seedRightsReauth(db, { id: 'reauth-rights-cross-b', suffix: 'b' });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-cross-family',
      consentId: 'consent_b', reauthId: 'reauth-rights-cross-b'
    }), /DATA_RIGHTS_REQUEST_INSERT_INVALID|FOREIGN KEY constraint failed/);

    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-reused-reauth-a',
      reauthId: 'reauth-rights-valid-access-a'
    }), /DATA_RIGHTS_REQUEST_REPLACE_FORBIDDEN|UNIQUE constraint failed/);

    seedRightsReauth(db, {
      id: 'reauth-rights-raw-payload-a', requestType: 'correct'
    });
    assert.throws(() => insertRequestedRight(db, {
      requestId: 'rights-raw-payload-a', requestType: 'correct',
      reauthId: 'reauth-rights-raw-payload-a',
      payload: JSON.stringify({ field: 'alias', expectedValue: '旧别名', newValue: '新别名' })
    }), /DATA_RIGHTS_PAYLOAD_INVALID/);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_rights_requests').get().count, 6);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 6);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE resource_id NOT IN (
        'rights-access-valid-a', 'rights-export-valid-a', 'rights-correct-valid-a',
        'rights-withdraw-valid-a', 'rights-delete-valid-a', 'rights-terminate-valid-b'
      )
    `).get().count, 0);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('009 行权请求、白名单审计和策略阻断删除作业不可改写、替换或删除', () => {
  const db = openDatabase('immutable-evidence');
  try {
    seedThrough008(db);
    applyMigration(db, migration009);
    seedRightsReauth(db, { id: 'reauth-rights-immutable-access' });
    insertRequestedRight(db, {
      requestId: 'rights-immutable-access',
      reauthId: 'reauth-rights-immutable-access'
    });

    assert.throws(() => db.prepare(`
      UPDATE data_rights_requests
      SET request_type = 'export', revision = 1,
          updated_at = '2026-08-23T10:03:00.000Z'
      WHERE id = 'rights-immutable-access'
    `).run(), /DATA_RIGHTS_REQUEST_CORE_IMMUTABLE|DATA_RIGHTS_REQUEST_LIFECYCLE_INVALID/);
    assert.throws(() => db.prepare(`
      UPDATE data_rights_requests
      SET status = 'verified', revision = 1,
          updated_at = '2026-08-23T10:03:00.000Z'
      WHERE id = 'rights-immutable-access'
    `).run(), /DATA_RIGHTS_REQUEST_LIFECYCLE_INVALID/);
    assert.throws(() => db.prepare(`
      DELETE FROM data_rights_requests WHERE id = 'rights-immutable-access'
    `).run(), /DATA_RIGHTS_REQUEST_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO data_rights_requests
      SELECT * FROM data_rights_requests WHERE id = 'rights-immutable-access'
    `).run(), /DATA_RIGHTS_REQUEST_REPLACE_FORBIDDEN|DATA_RIGHTS_REQUEST_DELETE_FORBIDDEN/);

    assert.throws(() => db.prepare(`
      UPDATE audit_events SET event_data_json = '{"requestType":"export"}'
      WHERE id = 'audit-rights-immutable-access-0'
    `).run(), /AUDIT_EVENT_IMMUTABLE/);
    assert.throws(() => db.prepare(`
      DELETE FROM audit_events WHERE id = 'audit-rights-immutable-access-0'
    `).run(), /AUDIT_EVENT_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO audit_events
      SELECT * FROM audit_events WHERE id = 'audit-rights-immutable-access-0'
    `).run(), /AUDIT_EVENT_REPLACE_FORBIDDEN|AUDIT_EVENT_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT INTO audit_events(
        id, family_id, child_id, actor_user_id, resource_type, resource_id,
        event_type, from_status, to_status, result_revision,
        event_data_json, created_at
      ) VALUES (
        'audit-forbidden-secret', 'family_a', 'child_a', 'guardian_a',
        'data_rights_request', 'rights-forbidden-secret',
        'data_rights_requested', NULL, 'requested', 0,
        '{"requestType":"access","token":"synthetic-secret"}',
        '2026-08-23T10:03:00.000Z'
      )
    `).run(), /AUDIT_EVENT_FIELD_NOT_ALLOWED/);

    seedRightsReauth(db, {
      id: 'reauth-rights-immutable-delete', requestType: 'delete'
    });
    insertRequestedRight(db, {
      requestId: 'rights-immutable-delete', requestType: 'delete',
      reauthId: 'reauth-rights-immutable-delete'
    });
    verifyRight(db, 'rights-immutable-delete');
    const jobId = startBlockedDeletion(db, 'rights-immutable-delete');

    assert.throws(() => db.prepare(`
      UPDATE data_deletion_jobs SET updated_at = '2026-08-23T10:05:00.000Z'
      WHERE id = ?
    `).run(jobId), /DATA_DELETION_JOB_POLICY_BLOCKED/);
    assert.throws(() => db.prepare(`
      DELETE FROM data_deletion_jobs WHERE id = ?
    `).run(jobId), /DATA_DELETION_JOB_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO data_deletion_jobs
      SELECT * FROM data_deletion_jobs WHERE id = ?
    `).run(jobId), /DATA_DELETION_JOB_SCOPE_INVALID|DATA_DELETION_JOB_REPLACE_FORBIDDEN|DATA_DELETION_JOB_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      DELETE FROM data_rights_requests WHERE id = 'rights-immutable-delete'
    `).run(), /DATA_RIGHTS_REQUEST_DELETE_FORBIDDEN/);

    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, retention_decision, blocked_reason
      FROM data_deletion_jobs WHERE id = ?
    `).get(jobId) }, {
      status: 'blocked_policy',
      revision: 0,
      retention_decision: 'policy_pending',
      blocked_reason: 'retention_policy_unapproved'
    });
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('009 privacy 状态机拒绝非法跳转且 deletion_pending 原子撤销目标孩子全部设备产物', () => {
  const db = openDatabase('privacy-cascade');
  try {
    seedThrough008(db);
    applyMigration(db, migration009);

    assert.throws(() => db.prepare(`
      UPDATE child_privacy_states
      SET status = 'deleted', revision = revision + 1,
          reason_code = 'forged_delete', deleted_at = ?, updated_at = ?
      WHERE family_id = 'family_a' AND child_id = 'child_a'
    `).run(
      '2026-08-23T10:02:00.000Z', '2026-08-23T10:02:00.000Z'
    ), /CHILD_PRIVACY_STATE_LIFECYCLE_INVALID/);
    assert.throws(() => db.prepare(`
      UPDATE child_privacy_states
      SET status = 'deletion_pending', revision = revision + 1,
          reason_code = 'data_rights_delete_requested', blocked_at = ?,
          deletion_requested_at = ?, updated_at = ?
      WHERE family_id = 'family_a' AND child_id = 'child_a'
    `).run(
      '2026-08-23T10:02:00.000Z', '2026-08-23T10:02:00.000Z',
      '2026-08-23T10:02:00.000Z'
    ), /CHILD_PRIVACY_STATE_LIFECYCLE_INVALID/);

    seedRightsReauth(db, {
      id: 'reauth-rights-cascade-delete', requestType: 'delete'
    });
    insertRequestedRight(db, {
      requestId: 'rights-cascade-delete', requestType: 'delete',
      reauthId: 'reauth-rights-cascade-delete'
    });
    verifyRight(db, 'rights-cascade-delete');
    const deletionAt = '2026-08-23T10:05:00.000Z';
    startBlockedDeletion(db, 'rights-cascade-delete', deletionAt);

    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, reason_code, blocked_at, deletion_requested_at
      FROM child_privacy_states
      WHERE family_id = 'family_a' AND child_id = 'child_a'
    `).get() }, {
      status: 'deletion_pending',
      revision: 2,
      reason_code: 'data_rights_delete_requested',
      blocked_at: deletionAt,
      deletion_requested_at: deletionAt
    });
    assert.deepEqual(rows(db, `
      SELECT id, status, revision, revoke_reason, revoked_at
      FROM device_bindings WHERE family_id = 'family_a' ORDER BY id
    `), [
      {
        id: 'binding_a1', status: 'revoked', revision: 2,
        revoke_reason: 'data_rights_delete_requested', revoked_at: deletionAt
      },
      {
        id: 'binding_a2', status: 'revoked', revision: 2,
        revoke_reason: 'data_rights_delete_requested', revoked_at: deletionAt
      }
    ]);
    assert.deepEqual(rows(db, `
      SELECT id, status, revision, cancelled_at
      FROM pairing_challenges WHERE family_id = 'family_a' ORDER BY id
    `), [
      { id: 'pairing_a1', status: 'cancelled', revision: 3, cancelled_at: deletionAt },
      { id: 'pairing_a2', status: 'cancelled', revision: 3, cancelled_at: deletionAt }
    ]);
    assert.deepEqual(rows(db, `
      SELECT id, status, revision, revoke_reason, revoked_at
      FROM device_sessions WHERE family_id = 'family_a' ORDER BY id
    `), [
      {
        id: 'session_a1', status: 'revoked', revision: 1,
        revoke_reason: 'data_rights_delete_requested', revoked_at: deletionAt
      },
      {
        id: 'session_a2', status: 'revoked', revision: 1,
        revoke_reason: 'data_rights_delete_requested', revoked_at: deletionAt
      }
    ]);
    assert.deepEqual(rows(db, `
      SELECT id, status, revision, revoked_at
      FROM device_session_challenges WHERE family_id = 'family_a' ORDER BY id
    `), [
      { id: 'refresh_challenge_a1', status: 'revoked', revision: 1, revoked_at: deletionAt },
      { id: 'refresh_challenge_a2', status: 'revoked', revision: 1, revoked_at: deletionAt }
    ]);

    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM device_bindings WHERE id = 'binding_b1'
    `).get() }, { status: 'active', revision: 1 });
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM device_sessions WHERE id = 'session_b1'
    `).get() }, { status: 'active', revision: 0 });
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM device_session_challenges
      WHERE id = 'refresh_challenge_b1'
    `).get() }, { status: 'pending', revision: 0 });
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision FROM child_privacy_states
      WHERE family_id = 'family_b' AND child_id = 'child_b'
    `).get() }, { status: 'active', revision: 1 });

    assert.throws(() => db.prepare(`
      UPDATE child_privacy_states
      SET status = 'deleted', revision = revision + 1,
          reason_code = 'forged_completion', deleted_at = ?, updated_at = ?
      WHERE family_id = 'family_a' AND child_id = 'child_a'
    `).run(
      '2026-08-23T10:06:00.000Z', '2026-08-23T10:06:00.000Z'
    ), /CHILD_PRIVACY_STATE_LIFECYCLE_INVALID/);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('009 迁移台账重复执行并保留请求、事件、删除作业与既有来源证据', () => {
  const db = openDatabase('reapply');
  try {
    seedThrough008(db);
    assert.equal(applyMigration(db, migration009), true);
    seedRightsReauth(db, {
      id: 'reauth-rights-repeat-delete', requestType: 'terminate'
    });
    insertRequestedRight(db, {
      requestId: 'rights-repeat-delete', requestType: 'terminate',
      reauthId: 'reauth-rights-repeat-delete'
    });
    verifyRight(db, 'rights-repeat-delete');
    startBlockedDeletion(db, 'rights-repeat-delete');

    const before = {
      requests: rows(db, 'SELECT * FROM data_rights_requests ORDER BY id'),
      events: rows(db, 'SELECT * FROM audit_events ORDER BY id'),
      jobs: rows(db, 'SELECT * FROM data_deletion_jobs ORDER BY id'),
      pointRequests: rows(db, 'SELECT * FROM point_requests ORDER BY id'),
      pointEvents: rows(db, 'SELECT * FROM point_request_events ORDER BY id'),
      sourced: rows(db, `
        SELECT id, family_id, source_type, source_id, amount, deleted_at
        FROM transactions WHERE source_type IS NOT NULL ORDER BY id
      `)
    };
    assert.equal(applyMigration(db, migration009), false);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?
    `).get(migration009).count, 1);
    assert.deepEqual({
      requests: rows(db, 'SELECT * FROM data_rights_requests ORDER BY id'),
      events: rows(db, 'SELECT * FROM audit_events ORDER BY id'),
      jobs: rows(db, 'SELECT * FROM data_deletion_jobs ORDER BY id'),
      pointRequests: rows(db, 'SELECT * FROM point_requests ORDER BY id'),
      pointEvents: rows(db, 'SELECT * FROM point_request_events ORDER BY id'),
      sourced: rows(db, `
        SELECT id, family_id, source_type, source_id, amount, deleted_at
        FROM transactions WHERE source_type IS NOT NULL ORDER BY id
      `)
    }, before);
    assertHealthy(db);
  } finally {
    db.close();
  }
});
