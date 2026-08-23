const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-device-pairing-migration-'));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const through005 = [
  '001_init.sql',
  '002_token_revocation.sql',
  '003_transaction_soft_delete.sql',
  '004_family_rules_history.sql',
  '005_transaction_rule_ids.sql'
];
const migration006 = '006_guardian_consent_enrollment.sql';
const migration007 = '007_device_pairing_sessions.sql';
let databaseSequence = 0;
const databaseFiles = new WeakMap();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function openDatabase(label) {
  const filename = `${String(++databaseSequence).padStart(2, '0')}-${label}.sqlite`;
  const db = new DatabaseSync(path.join(tempDir, filename));
  databaseFiles.set(db, path.join(tempDir, filename));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return db;
}

function reopenDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
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

function seedBusinessRows(db) {
  const createdAt = '2026-08-23T08:00:00.000Z';
  const insertFamily = db.prepare(`
    INSERT INTO families(id, name, invite_code, invite_json, created_at)
    VALUES (?, ?, NULL, NULL, ?)
  `);
  insertFamily.run('family_a', '合成家庭 A', createdAt);
  insertFamily.run('family_b', '合成家庭 B', createdAt);

  const insertUser = db.prepare(`
    INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
    VALUES (?, ?, ?, '', ?, 0)
  `);
  insertUser.run('guardian_a', '合成监护人 A', 'admin', 'family_a');
  insertUser.run('child_a', '合成孩子 A', 'child', 'family_a');
  insertUser.run('guardian_b', '合成监护人 B', 'admin', 'family_b');
  insertUser.run('child_b', '合成孩子 B', 'child', 'family_b');

  db.prepare('INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)')
    .run('family_a', 'child_a', 23);
  db.prepare('INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)')
    .run('family_b', 'child_b', 9);
  db.prepare(`
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'synthetic-device-migration-tx', 'family_a', createdAt, 'child_a',
    '合成孩子 A', 23, '合成迁移验证', '合成监护人 A', ''
  );
}

function seedLegalTexts(db) {
  const textRows = [
    ['privacy_policy', 'privacy-v1', sha256('privacy-v1'), 'https://example.invalid/privacy'],
    [
      'child_personal_information_rules', 'child-rules-v1', sha256('child-rules-v1'),
      'https://example.invalid/child-rules'
    ],
    [
      'child_user_agreement', 'child-agreement-v1', sha256('child-agreement-v1'),
      'https://example.invalid/child-agreement'
    ],
    [
      'sensitive_information_notice', 'sensitive-v1', sha256('sensitive-v1'),
      'https://example.invalid/sensitive'
    ]
  ];
  const insert = db.prepare(`
    INSERT INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  textRows.forEach((row, index) => {
    const timestamp = `2026-08-23T08:0${index + 1}:00.000Z`;
    insert.run(...row, timestamp, timestamp);
  });
  return Object.fromEntries(textRows.map(row => [row[0], { version: row[1], hash: row[2] }]));
}

function seedActiveConsent(db, legal, suffix) {
  const familyId = `family_${suffix}`;
  const childId = `child_${suffix}`;
  const guardianId = `guardian_${suffix}`;
  const reauthId = `reauth_${suffix}`;
  const consentId = `consent_${suffix}`;
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, 'child_consent', ?, 'password_reauth', ?, ?, ?)
  `).run(
    reauthId,
    familyId,
    guardianId,
    sha256(`reauth-token-${suffix}`),
    '2026-08-23T08:10:00.000Z',
    '2026-08-23T08:15:00.000Z',
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
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      'legal_guardian', 'guardian-relation-v1', ?,
      ?, 'password_reauth', ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    consentId,
    familyId,
    childId,
    guardianId,
    legal.privacy_policy.version,
    legal.privacy_policy.hash,
    legal.child_personal_information_rules.version,
    legal.child_personal_information_rules.hash,
    legal.child_user_agreement.version,
    legal.child_user_agreement.hash,
    legal.sensitive_information_notice.version,
    legal.sensitive_information_notice.hash,
    sha256('guardian-relation-v1'),
    reauthId,
    '2026-08-23T08:11:00.000Z',
    JSON.stringify({ childProfile: true, pointsLedger: true }),
    JSON.stringify({ guardian: 'full', childDevice: 'self_only' }),
    '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z',
    JSON.stringify({ fixture: 'device-pairing-migration' }),
    '2026-08-23T08:12:00.000Z',
    '2026-08-23T08:12:00.000Z'
  );
  db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active',
        revision = revision + 1,
        reason_code = 'synthetic_guardian_consent',
        activated_at = '2026-08-23T08:13:00.000Z',
        updated_at = '2026-08-23T08:13:00.000Z'
    WHERE family_id = ? AND child_id = ? AND revision = 0
  `).run(familyId, childId);
  return { familyId, childId, guardianId, consentId };
}

function setupThrough006(label) {
  const db = openDatabase(label);
  for (const filename of through005) applyMigration(db, filename);
  seedBusinessRows(db);
  applyMigration(db, migration006);
  const legal = seedLegalTexts(db);
  const familyA = seedActiveConsent(db, legal, 'a');
  const familyB = seedActiveConsent(db, legal, 'b');
  return { db, familyA, familyB };
}

function setupThrough007(label) {
  const fixture = setupThrough006(label);
  applyMigration(fixture.db, migration007);
  return fixture;
}

function businessCounts(db) {
  const names = [
    'families', 'users', 'point_accounts', 'transactions',
    'legal_text_versions', 'reauth_assertions', 'guardian_consents', 'child_privacy_states'
  ];
  return Object.fromEntries(names.map(name => [
    name,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)
  ]));
}

function assertHealthy(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row })), []);
}

function insertPendingPairing(
  db,
  fixture,
  id,
  createdAt = '2026-08-23T09:00:00.000Z',
  shortCodeHmac = sha256(`short-code-hmac-${id}`)
) {
  db.prepare(`
    INSERT INTO pairing_challenges(
      id, family_id, child_id, issued_by_guardian_id, guardian_consent_id,
      parent_challenge_hash, short_code_hmac, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fixture.familyId,
    fixture.childId,
    fixture.guardianId,
    fixture.consentId,
    sha256(`parent-challenge-${id}`),
    shortCodeHmac,
    '2026-08-23T09:10:00.000Z',
    createdAt,
    createdAt
  );
  return id;
}

function p256Spki() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { encoded: der.toString('base64url'), hash: sha256(der) };
}

function claimPairing(db, fixture, pairingId, bindingId) {
  const key = p256Spki();
  const claimedAt = '2026-08-23T09:01:00.000Z';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE pairing_challenges
      SET status = 'claimed',
          revision = revision + 1,
          claim_token_hash = ?,
          claim_idempotency_key_hash = ?,
          claim_request_fingerprint = ?,
          claimed_device_binding_id = ?,
          claimed_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'pending' AND revision = 0
    `).run(
      sha256(`claim-token-${pairingId}`),
      sha256(`claim-idempotency-${pairingId}`),
      sha256(`claim-fingerprint-${pairingId}`),
      bindingId,
      claimedAt,
      claimedAt,
      pairingId
    );
    db.prepare(`
      INSERT INTO device_bindings(
        id, family_id, child_id, authorized_by_consent_id, pairing_challenge_id,
        created_by_guardian_id, device_public_id, public_key_algorithm,
        device_public_key_spki, public_key_sha256, device_alias,
        claimed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ECDSA_P256_SHA256', ?, ?, ?, ?, ?, ?)
    `).run(
      bindingId,
      fixture.familyId,
      fixture.childId,
      fixture.consentId,
      pairingId,
      fixture.guardianId,
      `device_public_${bindingId}`,
      key.encoded,
      key.hash,
      `合成设备 ${bindingId}`,
      claimedAt,
      claimedAt,
      claimedAt
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return bindingId;
}

function confirmPairing(db, pairingId) {
  db.prepare(`
    UPDATE pairing_challenges
    SET status = 'confirmed',
        revision = revision + 1,
        confirmed_at = '2026-08-23T09:02:00.000Z',
        updated_at = '2026-08-23T09:02:00.000Z'
    WHERE id = ? AND status = 'claimed'
  `).run(pairingId);
}

function activateBinding(db, bindingId) {
  db.prepare(`
    UPDATE device_bindings
    SET status = 'active',
        revision = revision + 1,
        activated_at = '2026-08-23T09:03:00.000Z',
        updated_at = '2026-08-23T09:03:00.000Z'
    WHERE id = ? AND status = 'pending'
  `).run(bindingId);
}

function insertSession(db, fixture, bindingId, sessionId, rotationCounter = 0) {
  db.prepare(`
    INSERT INTO device_sessions(
      id, family_id, child_id, device_binding_id, token_family_id, rotation_counter,
      access_token_hash, refresh_token_hash, issued_at, access_expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    fixture.familyId,
    fixture.childId,
    bindingId,
    `token_family_${bindingId}`,
    rotationCounter,
    sha256(`access-token-${sessionId}`),
    sha256(`refresh-token-${sessionId}`),
    '2026-08-23T09:04:00.000Z',
    '2026-08-23T09:14:00.000Z',
    '2026-09-22T09:04:00.000Z',
    '2026-08-23T09:04:00.000Z',
    '2026-08-23T09:04:00.000Z'
  );
  return sessionId;
}

function insertNextSession(db, fixture, bindingId, sourceSessionId, nextSessionId, issuedAt) {
  const source = db.prepare(`
    SELECT token_family_id, rotation_counter, refresh_expires_at
    FROM device_sessions WHERE id = ?
  `).get(sourceSessionId);
  db.prepare(`
    INSERT INTO device_sessions(
      id, family_id, child_id, device_binding_id, token_family_id, rotation_counter,
      access_token_hash, refresh_token_hash, issued_at, access_expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nextSessionId,
    fixture.familyId,
    fixture.childId,
    bindingId,
    source.token_family_id,
    Number(source.rotation_counter) + 1,
    sha256(`access-token-${nextSessionId}`),
    sha256(`refresh-token-${nextSessionId}`),
    issuedAt,
    new Date(Date.parse(issuedAt) + 10 * 60_000).toISOString(),
    source.refresh_expires_at,
    issuedAt,
    issuedAt
  );
  return nextSessionId;
}

function insertRefreshChallenge(
  db,
  fixture,
  bindingId,
  sessionId,
  challengeId,
  issuedAt = '2026-08-23T09:05:00.000Z'
) {
  const expiresAt = new Date(Date.parse(issuedAt) + 2 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO device_session_challenges(
      id, family_id, child_id, device_binding_id, device_session_id, purpose,
      challenge_hash, issue_idempotency_key_hash, issue_request_fingerprint,
      issued_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'session_refresh', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    challengeId,
    fixture.familyId,
    fixture.childId,
    bindingId,
    sessionId,
    sha256(`session-challenge-${challengeId}`),
    sha256(`challenge-issue-key-${challengeId}`),
    sha256(`challenge-issue-fingerprint-${challengeId}`),
    issuedAt,
    expiresAt,
    issuedAt,
    issuedAt
  );
  return challengeId;
}

function insertPairingCompletionChallenge(db, fixture, pairingId, bindingId, challengeId) {
  db.prepare(`
    INSERT INTO device_session_challenges(
      id, family_id, child_id, device_binding_id, pairing_challenge_id, purpose,
      challenge_hash, issue_idempotency_key_hash, issue_request_fingerprint,
      issued_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pairing_completion', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    challengeId,
    fixture.familyId,
    fixture.childId,
    bindingId,
    pairingId,
    sha256(`pairing-challenge-${challengeId}`),
    sha256(`pairing-issue-key-${challengeId}`),
    sha256(`pairing-issue-fingerprint-${challengeId}`),
    '2026-08-23T09:02:10.000Z',
    '2026-08-23T09:07:10.000Z',
    '2026-08-23T09:02:10.000Z',
    '2026-08-23T09:02:10.000Z'
  );
  return challengeId;
}

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('007 从 006 前滚时保留业务与授权数据并创建空设备安全表', () => {
  const { db } = setupThrough006('preservation');
  try {
    const before = businessCounts(db);
    assert.equal(applyMigration(db, migration007), true);
    assert.deepEqual(businessCounts(db), before);
    for (const table of [
      'pairing_claim_attempt_windows',
      'pairing_challenges',
      'device_bindings',
      'device_sessions',
      'device_session_challenges'
    ]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0);
    }
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('007 不创建配对码、挑战或设备令牌的明文字段', () => {
  const { db } = setupThrough007('hashed-columns');
  try {
    const expectedProtectedColumns = new Map([
      ['pairing_claim_attempt_windows', [
        'subject_hmac', 'last_idempotency_key_hash', 'last_request_fingerprint'
      ]],
      ['pairing_challenges', [
        'parent_challenge_hash', 'short_code_hmac', 'claim_token_hash',
        'claim_idempotency_key_hash', 'claim_request_fingerprint'
      ]],
      ['device_sessions', ['access_token_hash', 'refresh_token_hash']],
      ['device_session_challenges', [
        'challenge_hash', 'issue_idempotency_key_hash', 'issue_request_fingerprint',
        'completion_idempotency_key_hash', 'completion_request_fingerprint'
      ]]
    ]);
    const forbiddenPlaintextColumns = new Set([
      'subject', 'parent_challenge', 'short_code', 'claim_token',
      'access_token', 'refresh_token', 'challenge', 'credential'
    ]);
    for (const [table, expected] of expectedProtectedColumns) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
      expected.forEach(column => assert.ok(columns.includes(column), `${table}.${column} missing`));
      columns.forEach(column => assert.equal(
        forbiddenPlaintextColumns.has(column),
        false,
        `${table}.${column} would persist a raw credential`
      ));
    }
    const bindingColumns = db.prepare('PRAGMA table_info("device_bindings")').all()
      .map(row => row.name);
    assert.ok(bindingColumns.includes('device_public_key_spki'));
    assert.ok(bindingColumns.includes('public_key_sha256'));
    assert.equal(bindingColumns.includes('private_key'), false);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('007 的复合外键和触发器拒绝跨家庭配对、绑定与会话', () => {
  const { db, familyA, familyB } = setupThrough007('family-scope');
  try {
    assert.throws(() => db.prepare(`
      INSERT INTO pairing_challenges(
        id, family_id, child_id, issued_by_guardian_id, guardian_consent_id,
        parent_challenge_hash, short_code_hmac, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'pairing_cross_child', familyA.familyId, familyB.childId,
      familyA.guardianId, familyA.consentId,
      sha256('cross-parent'), sha256('cross-code'),
      '2026-08-23T09:10:00.000Z',
      '2026-08-23T09:00:00.000Z',
      '2026-08-23T09:00:00.000Z'
    ), /PAIRING_CHALLENGE_SCOPE_INVALID|FOREIGN KEY constraint failed/);

    insertPendingPairing(db, familyA, 'pairing_scope_a');
    const key = p256Spki();
    assert.throws(() => db.prepare(`
      INSERT INTO device_bindings(
        id, family_id, child_id, authorized_by_consent_id, pairing_challenge_id,
        created_by_guardian_id, device_public_id, public_key_algorithm,
        device_public_key_spki, public_key_sha256, device_alias,
        claimed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ECDSA_P256_SHA256', ?, ?, ?, ?, ?, ?)
    `).run(
      'binding_cross_pairing', familyB.familyId, familyB.childId, familyB.consentId,
      'pairing_scope_a', familyB.guardianId, 'device_public_cross_pairing',
      key.encoded, key.hash, '跨家庭合成设备',
      '2026-08-23T09:01:00.000Z',
      '2026-08-23T09:01:00.000Z',
      '2026-08-23T09:01:00.000Z'
    ), /DEVICE_BINDING_SCOPE_INVALID|FOREIGN KEY constraint failed/);

    claimPairing(db, familyA, 'pairing_scope_a', 'binding_scope_a');
    confirmPairing(db, 'pairing_scope_a');
    activateBinding(db, 'binding_scope_a');
    assert.throws(() => db.prepare(`
      INSERT INTO device_sessions(
        id, family_id, child_id, device_binding_id, token_family_id, rotation_counter,
        access_token_hash, refresh_token_hash, issued_at, access_expires_at,
        refresh_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'session_cross_binding', familyB.familyId, familyB.childId, 'binding_scope_a',
      'token_family_cross_binding', sha256('cross-access'), sha256('cross-refresh'),
      '2026-08-23T09:04:00.000Z', '2026-08-23T09:14:00.000Z',
      '2026-09-22T09:04:00.000Z', '2026-08-23T09:04:00.000Z',
      '2026-08-23T09:04:00.000Z'
    ), /DEVICE_SESSION_SCOPE_INVALID|FOREIGN KEY constraint failed/);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('007 拒绝跳过 revision、逆向生命周期和会话摘要改写', () => {
  const { db, familyA } = setupThrough007('lifecycle');
  try {
    insertPendingPairing(db, familyA, 'pairing_revision_guard');
    assert.throws(() => db.prepare(`
      UPDATE pairing_challenges SET attempt_count = attempt_count + 1
      WHERE id = 'pairing_revision_guard'
    `).run(), /PAIRING_CHALLENGE_LIFECYCLE_INVALID/);
    db.prepare(`
      UPDATE pairing_challenges
      SET attempt_count = attempt_count + 1,
          revision = revision + 1,
          updated_at = '2026-08-23T09:00:30.000Z'
      WHERE id = 'pairing_revision_guard'
    `).run();

    insertPendingPairing(db, familyA, 'pairing_lifecycle');
    claimPairing(db, familyA, 'pairing_lifecycle', 'binding_lifecycle');
    assert.throws(() => insertPendingPairing(
      db,
      familyA,
      'pairing_live_code_collision',
      '2026-08-23T09:00:10.000Z',
      sha256('short-code-hmac-pairing_lifecycle')
    ), /UNIQUE constraint failed/);
    confirmPairing(db, 'pairing_lifecycle');
    activateBinding(db, 'binding_lifecycle');
    assert.throws(() => db.prepare(`
      UPDATE device_bindings
      SET status = 'pending', revision = revision + 1,
          activated_at = NULL, updated_at = '2026-08-23T09:04:00.000Z'
      WHERE id = 'binding_lifecycle'
    `).run(), /DEVICE_BINDING_CORE_IMMUTABLE|DEVICE_BINDING_LIFECYCLE_INVALID/);

    insertSession(db, familyA, 'binding_lifecycle', 'session_lifecycle');
    assert.throws(() => db.prepare(`
      UPDATE device_sessions
      SET access_token_hash = ?, revision = revision + 1,
          last_used_at = '2026-08-23T09:06:00.000Z',
          updated_at = '2026-08-23T09:06:00.000Z'
      WHERE id = 'session_lifecycle'
    `).run(sha256('rewritten-access-token')), /DEVICE_SESSION_CORE_IMMUTABLE/);

    insertRefreshChallenge(
      db, familyA, 'binding_lifecycle', 'session_lifecycle', 'challenge_lifecycle'
    );
    assert.throws(() => db.prepare(`
      UPDATE device_session_challenges
      SET status = 'consumed', revision = revision + 1,
          consumed_at = '2026-08-23T09:05:30.000Z',
          updated_at = '2026-08-23T09:05:30.000Z'
      WHERE id = 'challenge_lifecycle'
    `).run(), /CHECK constraint failed|DEVICE_SESSION_CHALLENGE_RESULT_INVALID/);

    const rotationAt = '2026-08-23T09:06:00.000Z';
    assert.throws(() => insertNextSession(
      db,
      familyA,
      'binding_lifecycle',
      'session_lifecycle',
      'session_lifecycle_early_next',
      rotationAt
    ), /DEVICE_SESSION_SCOPE_INVALID/);
    db.prepare(`
      UPDATE device_sessions
      SET status = 'rotated', revision = revision + 1,
          rotated_at = ?, last_used_at = ?, updated_at = ?
      WHERE id = 'session_lifecycle' AND status = 'active'
    `).run(rotationAt, rotationAt, rotationAt);
    insertNextSession(
      db,
      familyA,
      'binding_lifecycle',
      'session_lifecycle',
      'session_lifecycle_next',
      rotationAt
    );
    const completeChallenge = db.prepare(`
      UPDATE device_session_challenges
      SET status = 'consumed', revision = revision + 1,
          consumed_at = ?, completion_idempotency_key_hash = ?,
          completion_request_fingerprint = ?, result_session_id = ?,
          updated_at = ?
      WHERE id = 'challenge_lifecycle' AND status = 'pending'
    `);
    assert.throws(() => completeChallenge.run(
      '2026-08-23T09:06:01.000Z',
      sha256('lifecycle-completion-key'),
      sha256('lifecycle-completion-request'),
      'session_lifecycle_next',
      '2026-08-23T09:06:01.000Z'
    ), /DEVICE_SESSION_CHALLENGE_RESULT_INVALID/);
    completeChallenge.run(
      rotationAt,
      sha256('lifecycle-completion-key'),
      sha256('lifecycle-completion-request'),
      'session_lifecycle_next',
      rotationAt
    );
    assert.equal(db.prepare(`
      SELECT status FROM device_session_challenges WHERE id = 'challenge_lifecycle'
    `).get().status, 'consumed');
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('任一监护授权撤回会在时钟回拨时仍原子撤销孩子全部设备产物', () => {
  const { db, familyA } = setupThrough007('withdrawal-cascade');
  try {
    insertPendingPairing(db, familyA, 'pairing_completed');
    claimPairing(db, familyA, 'pairing_completed', 'binding_active');
    confirmPairing(db, 'pairing_completed');
    activateBinding(db, 'binding_active');
    insertSession(db, familyA, 'binding_active', 'session_active');
    insertRefreshChallenge(
      db, familyA, 'binding_active', 'session_active', 'challenge_refresh_consumed'
    );
    const rotationAt = '2026-08-23T09:06:00.000Z';
    db.prepare(`
      UPDATE device_sessions
      SET status = 'rotated', revision = revision + 1,
          rotated_at = ?, last_used_at = ?, updated_at = ?
      WHERE id = 'session_active' AND status = 'active'
    `).run(rotationAt, rotationAt, rotationAt);
    insertNextSession(
      db,
      familyA,
      'binding_active',
      'session_active',
      'session_active_next',
      rotationAt
    );
    db.prepare(`
      UPDATE device_session_challenges
      SET status = 'consumed', revision = revision + 1,
          consumed_at = ?, completion_idempotency_key_hash = ?,
          completion_request_fingerprint = ?, result_session_id = ?,
          updated_at = ?
      WHERE id = 'challenge_refresh_consumed' AND status = 'pending'
    `).run(
      rotationAt,
      sha256('withdraw-refresh-completion-key'),
      sha256('withdraw-refresh-completion-request'),
      'session_active_next',
      rotationAt
    );
    insertRefreshChallenge(
      db,
      familyA,
      'binding_active',
      'session_active_next',
      'challenge_refresh_pending',
      '2026-08-23T09:07:00.000Z'
    );
    db.prepare(`
      UPDATE pairing_challenges
      SET status = 'completed', revision = revision + 1,
          completed_at = '2026-08-23T09:06:00.000Z',
          updated_at = '2026-08-23T09:06:00.000Z'
      WHERE id = 'pairing_completed'
    `).run();

    insertPendingPairing(db, familyA, 'pairing_pending');
    insertPendingPairing(db, familyA, 'pairing_confirmed');
    claimPairing(db, familyA, 'pairing_confirmed', 'binding_pending');
    confirmPairing(db, 'pairing_confirmed');
    insertPairingCompletionChallenge(
      db, familyA, 'pairing_confirmed', 'binding_pending', 'challenge_pairing_pending'
    );

    db.prepare(`
      UPDATE guardian_consents
      SET status = 'withdrawn',
          lifecycle_revision = lifecycle_revision + 1,
          withdrawn_at = '2026-08-23T08:59:00.000Z',
          updated_at = '2026-08-23T08:59:00.000Z'
      WHERE id = ? AND status = 'active'
    `).run(familyA.consentId);

    assert.deepEqual(db.prepare(`
      SELECT id, status FROM pairing_challenges ORDER BY id
    `).all().map(row => ({ ...row })), [
      { id: 'pairing_completed', status: 'completed' },
      { id: 'pairing_confirmed', status: 'cancelled' },
      { id: 'pairing_pending', status: 'cancelled' }
    ]);
    assert.deepEqual(db.prepare(`
      SELECT id, status, revoke_reason FROM device_bindings ORDER BY id
    `).all().map(row => ({ ...row })), [
      {
        id: 'binding_active', status: 'revoked',
        revoke_reason: 'guardian_consent_withdrawn'
      },
      {
        id: 'binding_pending', status: 'revoked',
        revoke_reason: 'guardian_consent_withdrawn'
      }
    ]);
    assert.deepEqual(db.prepare(`
      SELECT id, status, revoke_reason FROM device_sessions ORDER BY id
    `).all().map(row => ({ ...row })), [
      {
        id: 'session_active', status: 'revoked',
        revoke_reason: 'guardian_consent_withdrawn'
      },
      {
        id: 'session_active_next', status: 'revoked',
        revoke_reason: 'guardian_consent_withdrawn'
      }
    ]);
    assert.deepEqual(db.prepare(`
      SELECT id, status FROM device_session_challenges ORDER BY id
    `).all().map(row => ({ ...row })), [
      { id: 'challenge_pairing_pending', status: 'revoked' },
      { id: 'challenge_refresh_consumed', status: 'consumed' },
      { id: 'challenge_refresh_pending', status: 'revoked' }
    ]);
    assertHealthy(db);
  } finally {
    db.close();
  }
});

test('007 依赖迁移台账只执行一次并在重启后保留安全状态', () => {
  const { db, familyA } = setupThrough007('repeat-ledger');
  const filename = databaseFiles.get(db);
  let reopened = db;
  try {
    insertPendingPairing(reopened, familyA, 'pairing_retained');
    assert.equal(applyMigration(reopened, migration007), false);
    reopened.close();

    reopened = reopenDatabase(filename);
    assert.equal(applyMigration(reopened, migration007), false);
    assert.equal(reopened.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?
    `).get(migration007).count, 1);
    assert.deepEqual({ ...reopened.prepare(`
      SELECT status, revision FROM pairing_challenges WHERE id = 'pairing_retained'
    `).get() }, { status: 'pending', revision: 0 });
    assertHealthy(reopened);
  } finally {
    try { reopened.close(); } catch (_) {}
  }
});
