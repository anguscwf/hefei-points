const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-stage1-migrations-'));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const baseMigrations = [
  '001_init.sql',
  '002_token_revocation.sql',
  '003_transaction_soft_delete.sql',
  '004_family_rules_history.sql',
  '005_transaction_rule_ids.sql'
];
const migration006 = '006_guardian_consent_enrollment.sql';
let databaseSequence = 0;

const legalTexts = Object.freeze([
  ['privacy_policy', 'privacy-v1', 'a'.repeat(64), 'https://example.invalid/privacy'],
  ['child_personal_information_rules', 'child-rules-v1', 'b'.repeat(64), 'https://example.invalid/child-rules'],
  ['child_user_agreement', 'child-agreement-v1', 'c'.repeat(64), 'https://example.invalid/child-agreement'],
  ['sensitive_information_notice', 'sensitive-notice-v1', 'd'.repeat(64), 'https://example.invalid/sensitive-notice']
]);

function openDatabase(label) {
  const filename = `${String(++databaseSequence).padStart(2, '0')}-${label}.sqlite`;
  const db = new DatabaseSync(path.join(tempDir, filename));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return db;
}

function applyMigration(db, filename) {
  const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(filename);
  if (alreadyApplied) return false;
  const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(filename, new Date().toISOString());
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function applyBaseMigrations(db) {
  for (const filename of baseMigrations) applyMigration(db, filename);
}

function seedLegacyFixture(db) {
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
  insertUser.run('admin_a', '合成管理员 A', 'admin', 'family_a');
  insertUser.run('adult_a', '合成人员 A', 'parent', 'family_a');
  insertUser.run('child_a', '合成孩子 A', 'child', 'family_a');
  insertUser.run('admin_b', '合成管理员 B', 'admin', 'family_b');
  insertUser.run('child_b', '合成孩子 B', 'child', 'family_b');

  db.prepare('INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)')
    .run('family_a', 'child_a', 17);
  db.prepare(`
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'synthetic-transaction', 'family_a', createdAt, 'child_a', '合成孩子 A', 17,
    '合成迁移验证', '合成管理员 A', ''
  );
}

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params).map(row => ({ ...row }));
}

function seedLegalTexts(db) {
  const insert = db.prepare(`
    INSERT INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  legalTexts.forEach((text, index) => {
    const timestamp = `2026-08-23T08:0${index}:00.000Z`;
    insert.run(...text, timestamp, timestamp);
  });
}

function insertConsumedReauth(db, {
  id = 'reauth-a', familyId = 'family_a', userId = 'admin_a', tokenHash = '1'.repeat(64)
} = {}) {
  db.prepare(`
    INSERT INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, 'child_enrollment', ?, 'password', ?, ?, ?)
  `).run(
    id, familyId, userId, tokenHash,
    '2026-08-23T08:00:00.000Z',
    '2026-08-23T08:05:00.000Z',
    '2026-08-23T08:01:00.000Z'
  );
}

function insertConsent(db, overrides = {}) {
  const record = {
    id: 'consent-a-v1',
    familyId: 'family_a',
    childId: 'child_a',
    guardianId: 'admin_a',
    consentVersion: 1,
    privacyVersion: 'privacy-v1',
    privacySha256: 'a'.repeat(64),
    childRulesVersion: 'child-rules-v1',
    childRulesSha256: 'b'.repeat(64),
    childAgreementVersion: 'child-agreement-v1',
    childAgreementSha256: 'c'.repeat(64),
    sensitiveVersion: 'sensitive-notice-v1',
    sensitiveSha256: 'd'.repeat(64),
    guardianRelation: 'father',
    relationVersion: 'guardian-relation-v1',
    relationSha256: 'e'.repeat(64),
    reauthId: 'reauth-a',
    verificationMethod: 'password',
    verifiedAt: '2026-08-23T08:01:00.000Z',
    consentScope: JSON.stringify({ childCoreData: true, sensitiveInformation: true }),
    visibilityScope: JSON.stringify({ childId: 'child_a' }),
    privacyConsentedAt: '2026-08-23T08:02:00.000Z',
    childRulesConsentedAt: '2026-08-23T08:02:01.000Z',
    childAgreementAcceptedAt: '2026-08-23T08:02:02.000Z',
    sensitiveConsentedAt: '2026-08-23T08:02:03.000Z',
    auditData: JSON.stringify({ source: 'synthetic-test' }),
    createdAt: '2026-08-23T08:02:04.000Z',
    updatedAt: '2026-08-23T08:02:04.000Z',
    ...overrides
  };
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
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    record.id, record.familyId, record.childId, record.guardianId, record.consentVersion,
    record.privacyVersion, record.privacySha256, record.childRulesVersion, record.childRulesSha256,
    record.childAgreementVersion, record.childAgreementSha256,
    record.sensitiveVersion, record.sensitiveSha256,
    record.guardianRelation, record.relationVersion, record.relationSha256,
    record.reauthId, record.verificationMethod, record.verifiedAt,
    record.consentScope, record.visibilityScope,
    record.privacyConsentedAt, record.childRulesConsentedAt,
    record.childAgreementAcceptedAt, record.sensitiveConsentedAt,
    record.auditData, record.createdAt, record.updatedAt
  );
  return record;
}

function assertDatabaseHealthy(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
}

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('006 从 005 回填全部存量儿童为暂停态，不伪造法律文本或授权', () => {
  const db = openDatabase('backfill');
  try {
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    const before = {
      families: rows(db, 'SELECT id, name, created_at FROM families ORDER BY id'),
      users: rows(db, 'SELECT id, name, role, family_id FROM users ORDER BY id'),
      points: rows(db, 'SELECT family_id, kid_id, balance FROM point_accounts ORDER BY family_id, kid_id'),
      transactions: rows(db, 'SELECT id, family_id, kid_id, amount, reason FROM transactions ORDER BY id')
    };

    assert.equal(applyMigration(db, migration006), true);

    assert.deepEqual(rows(db, `
      SELECT family_id, child_id, status, revision, reason_code
      FROM child_privacy_states
      ORDER BY family_id, child_id
    `), [
      {
        family_id: 'family_a', child_id: 'child_a', status: 'suspended_pending_consent',
        revision: 0, reason_code: 'legacy_child_pending_consent'
      },
      {
        family_id: 'family_b', child_id: 'child_b', status: 'suspended_pending_consent',
        revision: 0, reason_code: 'legacy_child_pending_consent'
      }
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM child_privacy_states').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legal_text_versions').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_consents').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reauth_assertions').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM v2_idempotency_records').get().count, 0);

    assert.deepEqual(rows(db, 'SELECT id, name, created_at FROM families ORDER BY id'), before.families);
    assert.deepEqual(rows(db, 'SELECT id, name, role, family_id FROM users ORDER BY id'), before.users);
    assert.deepEqual(rows(db, 'SELECT family_id, kid_id, balance FROM point_accounts ORDER BY family_id, kid_id'), before.points);
    assert.deepEqual(
      rows(db, 'SELECT id, family_id, kid_id, amount, reason FROM transactions ORDER BY id'),
      before.transactions
    );
    assertDatabaseHealthy(db);
  } finally {
    db.close();
  }
});

test('006 对后续 child 插入和成人转 child 均自动建立默认暂停态', () => {
  const db = openDatabase('child-triggers');
  try {
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    applyMigration(db, migration006);

    db.prepare(`
      INSERT INTO users(id, name, role, password, family_id, tokens_valid_after)
      VALUES ('child_new', '新合成孩子', 'child', '', 'family_a', 0)
    `).run();
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, reason_code
      FROM child_privacy_states
      WHERE family_id = 'family_a' AND child_id = 'child_new'
    `).get() }, {
      status: 'suspended_pending_consent', revision: 0, reason_code: 'child_created_pending_consent'
    });

    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM child_privacy_states
      WHERE family_id = 'family_a' AND child_id = 'adult_a'
    `).get().count, 0);
    db.prepare("UPDATE users SET role = 'child' WHERE id = 'adult_a'").run();
    assert.deepEqual({ ...db.prepare(`
      SELECT status, revision, reason_code
      FROM child_privacy_states
      WHERE family_id = 'family_a' AND child_id = 'adult_a'
    `).get() }, {
      status: 'suspended_pending_consent', revision: 0, reason_code: 'role_changed_pending_consent'
    });

    db.prepare("UPDATE users SET role = 'parent' WHERE id = 'adult_a'").run();
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM child_privacy_states
      WHERE family_id = 'family_a' AND child_id = 'adult_a'
    `).get().count, 0);
    assertDatabaseHealthy(db);
  } finally {
    db.close();
  }
});

test('006 在数据库层拒绝跨家庭儿童、监护人和断言组合', () => {
  const db = openDatabase('family-scope');
  try {
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    applyMigration(db, migration006);
    seedLegalTexts(db);
    insertConsumedReauth(db);

    assert.throws(() => db.prepare(`
      INSERT INTO child_privacy_states(
        family_id, child_id, status, revision, reason_code, created_at, updated_at
      ) VALUES (
        'family_a', 'child_b', 'suspended_pending_consent', 0,
        'cross_family_attempt', '2026-08-23T08:03:00.000Z', '2026-08-23T08:03:00.000Z'
      )
    `).run(), /FOREIGN KEY constraint failed/);

    assert.throws(() => insertConsumedReauth(db, {
      id: 'reauth-cross', familyId: 'family_a', userId: 'admin_b', tokenHash: '2'.repeat(64)
    }), /REAUTH_ACTOR_SCOPE_INVALID/);

    assert.throws(() => insertConsent(db, {
      id: 'consent-cross-child', childId: 'child_b'
    }), /CONSENT_ACTOR_SCOPE_INVALID|FOREIGN KEY constraint failed/);

    insertConsumedReauth(db, {
      id: 'reauth-b', familyId: 'family_b', userId: 'admin_b', tokenHash: '3'.repeat(64)
    });
    assert.throws(() => insertConsent(db, {
      id: 'consent-cross-guardian', guardianId: 'admin_b', reauthId: 'reauth-b'
    }), /CONSENT_ACTOR_SCOPE_INVALID|FOREIGN KEY constraint failed/);

    const consentForeignKeys = rows(db, "PRAGMA foreign_key_list('guardian_consents')");
    const grouped = Map.groupBy(consentForeignKeys, row => row.id);
    assert.ok([...grouped.values()].some(group => {
      const pairs = new Set(group.map(row => `${row.from}->${row.to}`));
      return pairs.has('family_id->family_id') && pairs.has('child_id->id');
    }));
    assert.ok([...grouped.values()].some(group => {
      const pairs = new Set(group.map(row => `${row.from}->${row.to}`));
      return pairs.has('family_id->family_id') && pairs.has('guardian_id->id');
    }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_consents').get().count, 0);
    assertDatabaseHealthy(db);
  } finally {
    db.close();
  }
});

test('006 约束法律文本格式并禁止修改或删除已发布版本', () => {
  const db = openDatabase('legal-texts');
  try {
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    applyMigration(db, migration006);
    seedLegalTexts(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legal_text_versions').get().count, 4);

    const insert = db.prepare(`
      INSERT INTO legal_text_versions(
        text_type, version, content_sha256, public_url, effective_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    assert.throws(() => insert.run(
      'unknown_text', 'v1', 'f'.repeat(64), 'https://example.invalid/unknown',
      '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:00.000Z'
    ), /CHECK constraint failed/);
    assert.throws(() => insert.run(
      'privacy_policy', 'bad-hash', 'F'.repeat(64), 'https://example.invalid/privacy-2',
      '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:00.000Z'
    ), /CHECK constraint failed/);
    assert.throws(() => insert.run(
      'privacy_policy', 'insecure-url', 'f'.repeat(64), 'http://example.invalid/privacy-2',
      '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:00.000Z'
    ), /CHECK constraint failed/);
    assert.throws(() => insert.run(
      'privacy_policy', 'same-effective-time', 'f'.repeat(64), 'https://example.invalid/privacy-2',
      '2026-08-23T08:00:00.000Z', '2026-08-23T09:00:00.000Z'
    ), /UNIQUE constraint failed/);

    assert.throws(() => db.prepare(`
      UPDATE legal_text_versions SET public_url = 'https://example.invalid/changed'
      WHERE text_type = 'privacy_policy' AND version = 'privacy-v1'
    `).run(), /LEGAL_TEXT_VERSION_IMMUTABLE/);
    assert.throws(() => db.prepare(`
      DELETE FROM legal_text_versions
      WHERE text_type = 'privacy_policy' AND version = 'privacy-v1'
    `).run(), /LEGAL_TEXT_VERSION_DELETE_FORBIDDEN/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legal_text_versions').get().count, 4);
    assertDatabaseHealthy(db);
  } finally {
    db.close();
  }
});

test('006 的 consent 核心证据不可变，仅允许受控的一次性生命周期推进', () => {
  const db = openDatabase('consent-immutability');
  try {
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    applyMigration(db, migration006);
    seedLegalTexts(db);
    insertConsumedReauth(db);

    assert.throws(() => insertConsent(db, {
      id: 'consent-bad-legal-evidence', privacySha256: 'f'.repeat(64)
    }), /CONSENT_LEGAL_EVIDENCE_INVALID/);
    const inserted = insertConsent(db);
    const coreBefore = { ...db.prepare(`
      SELECT family_id, child_id, guardian_id, consent_version,
             privacy_version, privacy_sha256, consent_scope_json, audit_data_json, created_at
      FROM guardian_consents WHERE id = ?
    `).get(inserted.id) };

    for (const statement of [
      "UPDATE guardian_consents SET privacy_version = 'privacy-v2' WHERE id = 'consent-a-v1'",
      "UPDATE guardian_consents SET guardian_id = 'adult_a' WHERE id = 'consent-a-v1'",
      "UPDATE guardian_consents SET consent_scope_json = '{\"forged\":true}' WHERE id = 'consent-a-v1'",
      "UPDATE guardian_consents SET audit_data_json = '{\"rewritten\":true}' WHERE id = 'consent-a-v1'",
      "UPDATE guardian_consents SET created_at = '2026-08-24T00:00:00.000Z' WHERE id = 'consent-a-v1'"
    ]) {
      assert.throws(
        () => db.prepare(statement).run(),
        /GUARDIAN_CONSENT_EVIDENCE_IMMUTABLE|GUARDIAN_CONSENT_LIFECYCLE_INVALID/
      );
    }

    db.prepare(`
      UPDATE guardian_consents
      SET status = 'withdrawn', lifecycle_revision = 1,
          withdrawn_at = ?, updated_at = ?
      WHERE id = ?
    `).run('2026-08-23T09:00:00.000Z', '2026-08-23T09:00:00.000Z', inserted.id);
    const withdrawn = { ...db.prepare(`
      SELECT status, lifecycle_revision, withdrawn_at
      FROM guardian_consents WHERE id = ?
    `).get(inserted.id) };
    assert.deepEqual(withdrawn, {
      status: 'withdrawn', lifecycle_revision: 1, withdrawn_at: '2026-08-23T09:00:00.000Z'
    });
    assert.deepEqual({ ...db.prepare(`
      SELECT family_id, child_id, guardian_id, consent_version,
             privacy_version, privacy_sha256, consent_scope_json, audit_data_json, created_at
      FROM guardian_consents WHERE id = ?
    `).get(inserted.id) }, coreBefore);

    assert.throws(() => db.prepare(`
      UPDATE guardian_consents
      SET status = 'superseded', lifecycle_revision = 2,
          withdrawn_at = NULL, superseded_at = ?, updated_at = ?
      WHERE id = ?
    `).run('2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', inserted.id),
    /GUARDIAN_CONSENT_LIFECYCLE_INVALID/);
    assert.throws(
      () => db.prepare('DELETE FROM guardian_consents WHERE id = ?').run(inserted.id),
      /GUARDIAN_CONSENT_DELETE_FORBIDDEN/
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_consents').get().count, 1);
    assertDatabaseHealthy(db);
  } finally {
    db.close();
  }
});

test('006 依赖迁移台账实现重复启动兼容并保留新增表数据', () => {
  const dbPath = path.join(tempDir, `${String(++databaseSequence).padStart(2, '0')}-repeat.sqlite`);
  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    applyBaseMigrations(db);
    seedLegacyFixture(db);
    assert.equal(applyMigration(db, migration006), true);
    seedLegalTexts(db);
    const schemaBefore = rows(db, `
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `);
    db.close();

    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(applyMigration(db, migration006), false);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?
    `).get(migration006).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legal_text_versions').get().count, 4);
    assert.deepEqual(rows(db, `
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `), schemaBefore);
    assertDatabaseHealthy(db);
  } finally {
    try { db.close(); } catch (_) {}
  }
});
