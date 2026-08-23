const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-point-request-migration-'));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const migrationsThrough007 = [
  '001_init.sql',
  '002_token_revocation.sql',
  '003_transaction_soft_delete.sql',
  '004_family_rules_history.sql',
  '005_transaction_rule_ids.sql',
  '006_guardian_consent_enrollment.sql',
  '007_device_pairing_sessions.sql'
];
const migration008 = '008_point_requests_transaction_sources.sql';
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

function seedThrough007(db) {
  for (const filename of migrationsThrough007.slice(0, 5)) applyMigration(db, filename);
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
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note
    ) VALUES ('legacy-tx-a', 'family_a', ?, 'child_a', '合成孩子 A', 12,
              '008 前合成流水', '合成监护人 A', '')
  `).run(at);
  applyMigration(db, migrationsThrough007[5]);

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
  for (const suffix of ['a', 'b']) seedConsent(db, suffix);
  applyMigration(db, migrationsThrough007[6]);
  seedDevice(db, 'a');
  seedDevice(db, 'b');
}

function seedConsent(db, suffix) {
  const familyId = `family_${suffix}`;
  const childId = `child_${suffix}`;
  const guardianId = `guardian_${suffix}`;
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, 'child_consent', ?, 'password_reauth', ?, ?, ?)
  `).run(
    `reauth_${suffix}`, familyId, guardianId, sha256(`reauth-${suffix}`),
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
    `consent_${suffix}`, familyId, childId, guardianId,
    'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64),
    `reauth_${suffix}`, '2026-08-23T08:11:00.000Z',
    JSON.stringify({ childProfile: true, pointsLedger: true, pointRequests: true }),
    JSON.stringify({ guardian: 'full', childDevice: 'self_only' }),
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z', '2026-08-23T08:12:00.000Z'
  );
  db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active', revision = revision + 1,
        reason_code = 'synthetic_consent', activated_at = ?, updated_at = ?
    WHERE family_id = ? AND child_id = ? AND revision = 0
  `).run('2026-08-23T08:13:00.000Z', '2026-08-23T08:13:00.000Z', familyId, childId);
}

function p256Spki() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { encoded: der.toString('base64url'), hash: sha256(der) };
}

function seedDevice(db, suffix) {
  const familyId = `family_${suffix}`;
  const childId = `child_${suffix}`;
  const guardianId = `guardian_${suffix}`;
  const pairingId = `pairing_${suffix}`;
  const bindingId = `binding_${suffix}`;
  const key = p256Spki();
  db.prepare(`
    INSERT INTO pairing_challenges(
      id, family_id, child_id, issued_by_guardian_id, guardian_consent_id,
      parent_challenge_hash, short_code_hmac, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pairingId, familyId, childId, guardianId, `consent_${suffix}`,
    sha256(`parent-${suffix}`), sha256(`short-${suffix}`),
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
      sha256(`claim-${suffix}`), sha256(`claim-key-${suffix}`),
      sha256(`claim-fp-${suffix}`), bindingId,
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
      `synthetic_device_public_${suffix}`, key.encoded, key.hash, `合成设备 ${suffix}`,
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
    `session_${suffix}`, familyId, childId, bindingId, `token_family_synthetic_${suffix}`,
    sha256(`access-${suffix}`), sha256(`refresh-${suffix}`),
    '2026-08-23T09:04:00.000Z', '2026-08-23T10:04:00.000Z',
    '2026-09-23T09:04:00.000Z', '2026-08-23T09:04:00.000Z',
    '2026-08-23T09:04:00.000Z'
  );
}

function insertCreateEvent(db, {
  requestId = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  suffix = 'a',
  clientRequestId = 'client-migration-0001',
  fingerprint = 'f'.repeat(64),
  keyHash = '1'.repeat(64),
  at = '2026-08-23T09:05:00.000Z'
} = {}) {
  db.prepare(`
    INSERT INTO point_request_events(
      id, family_id, child_id, point_request_id, actor_device_binding_id,
      action, idempotency_key_hash, request_fingerprint,
      from_status, to_status, result_revision, response_status,
      event_data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 'create', ?, ?, NULL, 'pending', 0, 201, ?, ?)
  `).run(
    `event_${crypto.randomUUID()}`, `family_${suffix}`, `child_${suffix}`, requestId,
    `binding_${suffix}`, keyHash, fingerprint,
    JSON.stringify({ clientRequestId }), at
  );
}

function insertRequest(db, {
  requestId = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  suffix = 'a',
  clientRequestId = 'client-migration-0001',
  fingerprint = 'f'.repeat(64),
  at = '2026-08-23T09:05:00.000Z'
} = {}) {
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
      ?, ?, ?, ?, ?, ?, 'reward_rule', 'reward_category', 4,
      '提交时规则名称', '提交时分类名称', '每次', 2, 4, 10,
      ?, 8, '合成迁移申请说明', ?, '2026-08-23', 0, ?, ?
    )
  `).run(
    requestId, `family_${suffix}`, `child_${suffix}`, `binding_${suffix}`,
    clientRequestId, fingerprint, `合成孩子 ${suffix.toUpperCase()}`, at, at, at
  );
}

function seedPendingRequest(db, input = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    insertCreateEvent(db, input);
    insertRequest(db, input);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertHealthy(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row })), []);
}

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('008 从 007 前滚保留业务数据，旧流水来源为空且新表不伪造申请', () => {
  const db = openDatabase('preservation');
  try {
    seedThrough007(db);
    const before = {
      families: db.prepare('SELECT COUNT(*) AS count FROM families').get().count,
      users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
      accounts: db.prepare('SELECT COUNT(*) AS count FROM point_accounts').get().count,
      transactions: db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      devices: db.prepare('SELECT COUNT(*) AS count FROM device_bindings').get().count,
      sessions: db.prepare('SELECT COUNT(*) AS count FROM device_sessions').get().count
    };
    assert.equal(applyMigration(db, migration008), true);
    assert.deepEqual({
      families: db.prepare('SELECT COUNT(*) AS count FROM families').get().count,
      users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
      accounts: db.prepare('SELECT COUNT(*) AS count FROM point_accounts').get().count,
      transactions: db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      devices: db.prepare('SELECT COUNT(*) AS count FROM device_bindings').get().count,
      sessions: db.prepare('SELECT COUNT(*) AS count FROM device_sessions').get().count
    }, before);
    assert.deepEqual({ ...db.prepare(`
      SELECT source_type, source_id FROM transactions WHERE id = 'legacy-tx-a'
    `).get() }, { source_type: null, source_id: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM point_requests').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM point_request_events').get().count, 0);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('008 在数据库层绑定设备 clientRequestId、家庭儿童作用域和 revision 状态机', () => {
  const db = openDatabase('scope-lifecycle');
  try {
    seedThrough007(db);
    applyMigration(db, migration008);
    seedPendingRequest(db);
    assert.throws(() => seedPendingRequest(db, {
      requestId: 'point_request_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      clientRequestId: 'client-migration-0001',
      fingerprint: '2'.repeat(64), keyHash: '2'.repeat(64)
    }), /POINT_REQUEST_REPLACE_FORBIDDEN|UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`
      INSERT INTO point_request_events(
        id, family_id, child_id, point_request_id, actor_device_binding_id,
        action, idempotency_key_hash, request_fingerprint,
        from_status, to_status, result_revision, response_status,
        event_data_json, created_at
      ) VALUES (
        'cross-family-event', 'family_a', 'child_a',
        'point_request_cccccccccccccccccccccccccccccccc', 'binding_b',
        'create', ?, ?, NULL, 'pending', 0, 201, '{}', ?
      )
    `).run(
      '3'.repeat(64), '3'.repeat(64), '2026-08-23T09:05:00.000Z'
    ), /POINT_REQUEST_EVENT_SCOPE_INVALID|FOREIGN KEY constraint failed/);
    assert.throws(() => db.prepare(`
      UPDATE point_requests
      SET rule_label_snapshot = '篡改规则名称', revision = 1,
          status = 'cancelled', updated_at = '2026-08-23T09:06:00.000Z'
      WHERE id = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    `).run(), /POINT_REQUEST_CORE_IMMUTABLE|POINT_REQUEST_LIFECYCLE_INVALID/);
    assert.throws(() => db.prepare(`
      UPDATE point_requests
      SET status = 'cancelled', revision = 1,
          updated_at = '2026-08-23T09:06:00.000Z'
      WHERE id = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    `).run(), /POINT_REQUEST_LIFECYCLE_INVALID/);
    assert.throws(() => db.prepare(`
      DELETE FROM point_requests
      WHERE id = 'point_request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    `).run(), /POINT_REQUEST_DELETE_FORBIDDEN/);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('008 审批来源只能匹配同申请快照且来源流水不可软删、改写或硬删', () => {
  const db = openDatabase('source-integrity');
  try {
    seedThrough007(db);
    applyMigration(db, migration008);
    const requestId = 'point_request_dddddddddddddddddddddddddddddddd';
    seedPendingRequest(db, {
      requestId,
      clientRequestId: 'client-source-integrity-01',
      fingerprint: '4'.repeat(64), keyHash: '4'.repeat(64)
    });
    const transactionId = 'approved-source-transaction';
    const at = '2026-08-23T09:06:00.000Z';
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO point_request_events(
          id, family_id, child_id, point_request_id, actor_user_id,
          action, idempotency_key_hash, request_fingerprint,
          from_status, to_status, result_revision, response_status,
          transaction_id, event_data_json, created_at
        ) VALUES (
          'approve-event', 'family_a', 'child_a', ?, 'guardian_a',
          'approve', ?, ?, 'pending', 'approved', 1, 200, ?, ?, ?
        )
      `).run(
        requestId, '5'.repeat(64), '6'.repeat(64), transactionId,
        JSON.stringify({ approvedPoints: 8 }), at
      );
      db.prepare(`
        UPDATE point_requests
        SET status = 'approved', revision = 1, approved_points = 8,
            reviewer_user_id = 'guardian_a', reviewed_at = ?,
            transaction_id = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND revision = 0
      `).run(at, transactionId, at, requestId);
      db.prepare(`
        INSERT INTO transactions(
          id, family_id, occurred_at, kid_id, kid_name, amount,
          reason, operator, note, rule_id, category_id, source_type, source_id
        ) VALUES (?, 'family_a', ?, 'child_a', '合成孩子 A', 8,
                  '提交时规则名称', '合成监护人 A', '',
                  'reward_rule', 'reward_category', 'point_request', ?)
      `).run(transactionId, '2026-08-23T09:05:00.000Z', requestId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    assert.throws(() => db.prepare(`
      UPDATE transactions SET deleted_at = ? WHERE id = ?
    `).run('2026-08-23T10:00:00.000Z', transactionId), /SOURCED_TRANSACTION_IMMUTABLE/);
    assert.throws(() => db.prepare(`
      UPDATE transactions SET source_id = 'other' WHERE id = ?
    `).run(transactionId), /TRANSACTION_SOURCE_IMMUTABLE|SOURCED_TRANSACTION_IMMUTABLE/);
    assert.throws(
      () => db.prepare('DELETE FROM transactions WHERE id = ?').run(transactionId),
      /SOURCED_TRANSACTION_DELETE_FORBIDDEN/
    );
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO transactions
      SELECT * FROM transactions WHERE id = ?
    `).run(transactionId), /SOURCED_TRANSACTION_REPLACE_FORBIDDEN|SOURCED_TRANSACTION_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO point_requests
      SELECT * FROM point_requests WHERE id = ?
    `).run(requestId), /POINT_REQUEST_REPLACE_FORBIDDEN|POINT_REQUEST_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO point_request_events
      SELECT * FROM point_request_events WHERE id = 'approve-event'
    `).run(), /POINT_REQUEST_EVENT_REPLACE_FORBIDDEN|POINT_REQUEST_EVENT_DELETE_FORBIDDEN/);
    assert.throws(() => db.prepare(`
      INSERT INTO transactions(
        id, family_id, occurred_at, kid_id, kid_name, amount,
        reason, operator, note, rule_id, category_id, source_type, source_id
      ) VALUES ('forged-source', 'family_a', ?, 'child_a', '合成孩子 A', 7,
                '伪造规则', '合成监护人 A', '',
                'reward_rule', 'reward_category', 'point_request', ?)
    `).run(at, requestId), /POINT_REQUEST_LEDGER_SCOPE_INVALID|UNIQUE constraint failed/);
    db.prepare(`
      UPDATE transactions SET note = '普通流水仍兼容' WHERE id = 'legacy-tx-a'
    `).run();
    assert.equal(db.prepare(`
      SELECT note FROM transactions WHERE id = 'legacy-tx-a'
    `).get().note, '普通流水仍兼容');

    const legacyLinkRequest = 'point_request_ffffffffffffffffffffffffffffffff';
    seedPendingRequest(db, {
      requestId: legacyLinkRequest,
      clientRequestId: 'client-legacy-link-0001',
      fingerprint: '8'.repeat(64), keyHash: '8'.repeat(64)
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO point_request_events(
          id, family_id, child_id, point_request_id, actor_user_id,
          action, idempotency_key_hash, request_fingerprint,
          from_status, to_status, result_revision, response_status,
          transaction_id, event_data_json, created_at
        ) VALUES (
          'legacy-link-event', 'family_a', 'child_a', ?, 'guardian_a',
          'approve', ?, ?, 'pending', 'approved', 1, 200,
          'legacy-tx-a', ?, '2026-08-23T09:07:00.000Z'
        )
      `).run(
        legacyLinkRequest, '9'.repeat(64), 'a'.repeat(64),
        JSON.stringify({ approvedPoints: 8 })
      );
      assert.throws(() => db.prepare(`
        UPDATE point_requests
        SET status = 'approved', revision = 1, approved_points = 8,
            reviewer_user_id = 'guardian_a', reviewed_at = ?,
            transaction_id = 'legacy-tx-a', updated_at = ?
        WHERE id = ? AND status = 'pending' AND revision = 0
      `).run(
        '2026-08-23T09:07:00.000Z', '2026-08-23T09:07:00.000Z', legacyLinkRequest
      ), /POINT_REQUEST_LIFECYCLE_INVALID/);
    } finally {
      db.exec('ROLLBACK');
    }

    const deletedAtRequest = 'point_request_11111111111111111111111111111111';
    seedPendingRequest(db, {
      requestId: deletedAtRequest,
      clientRequestId: 'client-born-deleted-001',
      fingerprint: 'b'.repeat(64), keyHash: 'b'.repeat(64),
      at: '2026-08-23T09:08:00.000Z'
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO point_request_events(
          id, family_id, child_id, point_request_id, actor_user_id,
          action, idempotency_key_hash, request_fingerprint,
          from_status, to_status, result_revision, response_status,
          transaction_id, event_data_json, created_at
        ) VALUES (
          'born-deleted-event', 'family_a', 'child_a', ?, 'guardian_a',
          'approve', ?, ?, 'pending', 'approved', 1, 200,
          'born-deleted-tx', ?, '2026-08-23T09:09:00.000Z'
        )
      `).run(
        deletedAtRequest, 'c'.repeat(64), 'd'.repeat(64),
        JSON.stringify({ approvedPoints: 8 })
      );
      db.prepare(`
        UPDATE point_requests
        SET status = 'approved', revision = 1, approved_points = 8,
            reviewer_user_id = 'guardian_a', reviewed_at = ?,
            transaction_id = 'born-deleted-tx', updated_at = ?
        WHERE id = ? AND status = 'pending' AND revision = 0
      `).run(
        '2026-08-23T09:09:00.000Z', '2026-08-23T09:09:00.000Z', deletedAtRequest
      );
      assert.throws(() => db.prepare(`
        INSERT INTO transactions(
          id, family_id, occurred_at, kid_id, kid_name, amount,
          reason, operator, note, deleted_at,
          rule_id, category_id, source_type, source_id
        ) VALUES (
          'born-deleted-tx', 'family_a', '2026-08-23T09:08:00.000Z',
          'child_a', '合成孩子 A', 8, '提交时规则名称', '合成监护人 A', '',
          '2026-08-23T09:09:00.000Z', 'reward_rule', 'reward_category',
          'point_request', ?
        )
      `).run(deletedAtRequest), /POINT_REQUEST_LEDGER_SCOPE_INVALID/);
    } finally {
      db.exec('ROLLBACK');
    }
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('008 迁移台账重复执行保持申请、事件和来源证据', () => {
  const db = openDatabase('repeat');
  try {
    seedThrough007(db);
    assert.equal(applyMigration(db, migration008), true);
    seedPendingRequest(db, {
      requestId: 'point_request_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      clientRequestId: 'client-repeat-migration-01',
      fingerprint: '7'.repeat(64), keyHash: '7'.repeat(64)
    });
    assert.equal(applyMigration(db, migration008), false);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?
    `).get(migration008).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM point_requests').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM point_request_events').get().count, 1);
    assertHealthy(db);
  } finally {
    db.close();
  }
});
