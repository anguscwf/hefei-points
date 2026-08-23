const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-transaction-rule-test-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'transactions.sqlite');

const { getDb, inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

function ensureSyntheticConsent(db, { familyId, guardianId, childId, tag }) {
  const version = 'synthetic-s1-v1';
  const createdAt = '2026-08-20T00:00:00.000Z';
  const textEvidence = [
    ['privacy_policy', 'a'.repeat(64)],
    ['child_personal_information_rules', 'b'.repeat(64)],
    ['child_user_agreement', 'c'.repeat(64)],
    ['sensitive_information_notice', 'd'.repeat(64)]
  ];
  const insertLegalText = db.prepare(`
    INSERT OR IGNORE INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [textType, contentSha256] of textEvidence) {
    insertLegalText.run(
      textType,
      version,
      contentSha256,
      `https://example.test/legal/${textType}/${version}`,
      createdAt,
      createdAt
    );
  }

  const reauthId = `reauth_${tag}`;
  db.prepare(`
    INSERT OR IGNORE INTO reauth_assertions(
      id, family_id, user_id, purpose, token_hash, verification_method,
      issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, 'child_consent', ?, 'password', ?, ?, ?)
  `).run(
    reauthId,
    familyId,
    guardianId,
    crypto.createHash('sha256').update(`synthetic:${tag}`).digest('hex'),
    createdAt,
    '2099-01-01T00:00:00.000Z',
    createdAt
  );

  db.prepare(`
    INSERT OR IGNORE INTO guardian_consents(
      id, family_id, child_id, guardian_id, consent_version,
      privacy_version, privacy_sha256, child_rules_version, child_rules_sha256,
      child_user_agreement_version, child_user_agreement_sha256,
      sensitive_notice_version, sensitive_notice_sha256,
      guardian_relation, relation_declaration_version, relation_declaration_sha256,
      reauth_assertion_id, verification_method, verified_at,
      consent_scope_json, visibility_scope_json,
      privacy_consented_at, child_rules_consented_at,
      child_user_agreement_accepted_at, sensitive_consented_at,
      audit_data_json, supersedes_consent_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 1,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      'legal_guardian', 'synthetic-relation-v1', ?,
      ?, 'password', ?,
      '{"legacyPoints":true}', '{"familyAdults":true}',
      ?, ?, ?, ?,
      '{"fixture":"transaction-rule-ids"}', NULL, ?, ?
    )
  `).run(
    `consent_${tag}`,
    familyId,
    childId,
    guardianId,
    version,
    textEvidence[0][1],
    version,
    textEvidence[1][1],
    version,
    textEvidence[2][1],
    version,
    textEvidence[3][1],
    'e'.repeat(64),
    reauthId,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
    createdAt
  );
  return createdAt;
}

function rulesFor(prefix, label) {
  return {
    reward: [{
      id: `cat_${prefix}_reward`,
      category: `${label}鼓励`,
      items: [{
        id: `r_${prefix}_study`,
        label: `${label}按时学习`,
        min: 1,
        max: 10,
        default: 3,
        unit: '每次',
        hint: '规则关联自动化测试'
      }]
    }],
    punish: [{
      id: `cat_${prefix}_punish`,
      category: `${label}提醒`,
      items: [{
        id: `p_${prefix}_late`,
        label: `${label}没有按时完成`,
        min: -10,
        max: -1,
        default: -3,
        unit: '每次'
      }]
    }],
    special: []
  };
}

function resetDatabase() {
  inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM rule_versions').run();
    db.prepare('DELETE FROM rules').run();
  });
  const createdAt = new Date().toISOString();
  repositories.families.ensureDefault({ id: 'default', name: '默认家庭', createdAt });
  repositories.families.ensureDefault({ id: 'family_a', name: '家庭 A', createdAt });
  repositories.families.ensureDefault({ id: 'family_b', name: '家庭 B', createdAt });
  const password = token.hashPwd('test-password');
  const upsertUser = getDb().prepare(`
    INSERT INTO users(id, name, role, password, family_id, openid, bound_at, tokens_valid_after)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      password = excluded.password,
      family_id = excluded.family_id,
      openid = NULL,
      bound_at = NULL,
      tokens_valid_after = 0
  `);
  for (const user of [
    { id: 'admin_a', name: '管理员 A', role: 'admin', familyId: 'family_a' },
    { id: 'child_a', name: '孩子 A', role: 'child', familyId: 'family_a' },
    { id: 'admin_b', name: '管理员 B', role: 'admin', familyId: 'family_b' },
    { id: 'child_b', name: '孩子 B', role: 'child', familyId: 'family_b' }
  ]) upsertUser.run(user.id, user.name, user.role, password, user.familyId);
  inTransaction(db => {
    const activatedAt = ensureSyntheticConsent(db, {
      familyId: 'family_a',
      guardianId: 'admin_a',
      childId: 'child_a',
      tag: 'rules_admin_a_child_a'
    });
    ensureSyntheticConsent(db, {
      familyId: 'family_b',
      guardianId: 'admin_b',
      childId: 'child_b',
      tag: 'rules_admin_b_child_b'
    });
    db.prepare(`
      UPDATE child_privacy_states
      SET status = 'active',
          revision = revision + 1,
          reason_code = 'guardian_consent_recorded',
          updated_at = ?,
          activated_at = ?
      WHERE status = 'suspended_pending_consent'
    `).run(activatedAt, activatedAt);
  });
  repositories.config.setRules('family_a', rulesFor('a', '家庭 A'));
  repositories.config.setRules('family_b', rulesFor('b', '家庭 B'));
}

function createApi() {
  const app = express();
  app.use(require('../middleware/request-logger'));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', require('../routes/points'));
  app.use('/api', require('../routes/history'));
  return app;
}

async function withServer(work) {
  const server = await new Promise(resolve => {
    const listening = createApi().listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function headers(userId = 'admin_a') {
  const user = repositories.users.findById(userId);
  return {
    Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}`,
    'Content-Type': 'application/json'
  };
}

async function change(baseUrl, body, userId = 'admin_a') {
  const response = await fetch(`${baseUrl}/api/points/change`, {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('005 迁移保留旧流水快照，新增字段可空且回滚可恢复旧结构', () => {
  const file = path.join(tempDir, 'migration-roundtrip.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        kid_id TEXT NOT NULL,
        kid_name TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        operator TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        deleted_at TEXT
      );
      INSERT INTO transactions(
        id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note
      ) VALUES ('legacy-1', 'default', '2026/8/2 10:00:00', 'kid-1', '孩子', 3, '旧规则名称', '家长', '旧备注');
    `);
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '005_transaction_rule_ids.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run('005_transaction_rule_ids.sql', new Date().toISOString());

    const migrated = db.prepare('SELECT reason, rule_id, category_id FROM transactions WHERE id = ?').get('legacy-1');
    assert.equal(migrated.reason, '旧规则名称');
    assert.equal(migrated.rule_id, null);
    assert.equal(migrated.category_id, null);
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name));
    assert.ok(indexes.has('idx_transactions_family_rule'));
    assert.ok(indexes.has('idx_transactions_family_category'));
    assert.throws(() => db.prepare(`
      INSERT INTO transactions(
        id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note, rule_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('partial-link', 'default', '2026/8/2 10:01:00', 'kid-1', '孩子', 1, '错误关联', '家长', '', 'r_only'));
    db.prepare(`
      INSERT INTO transactions(
        id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note, rule_id, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('linked-1', 'default', '2026/8/2 10:02:00', 'kid-1', '孩子', 2, '关联规则', '家长', '', 'r_linked', 'cat_linked');

    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'rollbacks', '005_transaction_rule_ids.sql'), 'utf8'));
    const columns = db.prepare('PRAGMA table_info(transactions)').all().map(column => column.name);
    assert.equal(columns.includes('rule_id'), false);
    assert.equal(columns.includes('category_id'), false);
    assert.equal(db.prepare('SELECT reason FROM transactions WHERE id = ?').get('legacy-1').reason, '旧规则名称');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?')
      .get('005_transaction_rule_ids.sql').count, 0);
    const archived = db.prepare(`
      SELECT family_id, rule_id, category_id
      FROM transaction_rule_links_v25_archive
      WHERE transaction_id = 'linked-1'
    `).get();
    assert.deepEqual({ ...archived }, { family_id: 'default', rule_id: 'r_linked', category_id: 'cat_linked' });

    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '005_transaction_rule_ids.sql'), 'utf8'));
    const restored = db.prepare('SELECT rule_id, category_id FROM transactions WHERE id = ?').get('linked-1');
    assert.deepEqual({ ...restored }, { rule_id: 'r_linked', category_id: 'cat_linked' });
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test('规则记分保存稳定 ID，并以服务端当前规则名作为 reason 快照', async () => {
  await withServer(async baseUrl => {
    const result = await change(baseUrl, {
      kid: 'child_a',
      amount: 3,
      reason: '客户端伪造名称',
      ruleId: 'r_a_study',
      categoryId: 'cat_a_reward'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.record.ruleId, 'r_a_study');
    assert.equal(result.json.record.categoryId, 'cat_a_reward');
    assert.equal(result.json.record.reason, '家庭 A按时学习');

    const historyResponse = await fetch(`${baseUrl}/api/history`, { headers: headers() });
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.history[0].ruleId, 'r_a_study');
    assert.equal(history.history[0].categoryId, 'cat_a_reward');
    assert.equal(history.history[0].reason, '家庭 A按时学习');
  });
});

test('只传 ruleId 时由服务端补全当前家庭分类 ID', async () => {
  await withServer(async baseUrl => {
    const result = await change(baseUrl, {
      kid: 'child_a', amount: -3, ruleId: 'p_a_late'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.record.ruleId, 'p_a_late');
    assert.equal(result.json.record.categoryId, 'cat_a_punish');
    assert.equal(result.json.record.reason, '家庭 A没有按时完成');
  });
});

test('规则改名后稳定 ID 不变，旧流水保留旧名称而新流水使用新快照', async () => {
  await withServer(async baseUrl => {
    const first = await change(baseUrl, {
      kid: 'child_a', amount: 3, ruleId: 'r_a_study', categoryId: 'cat_a_reward'
    });
    assert.equal(first.response.status, 200);

    const edited = repositories.config.getRules('family_a');
    edited.reward[0].items[0].label = '家庭 A主动学习';
    repositories.config.setRules('family_a', edited, { expectedRevision: edited.revision, updatedBy: 'admin_a' });

    const second = await change(baseUrl, {
      kid: 'child_a', amount: 3, ruleId: 'r_a_study', categoryId: 'cat_a_reward'
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.json.record.reason, '家庭 A主动学习');

    const records = repositories.transactions.listByFamily('family_a');
    const oldRecord = records.find(record => record.id === first.json.record.id);
    const newRecord = records.find(record => record.id === second.json.record.id);
    assert.equal(oldRecord.ruleId, 'r_a_study');
    assert.equal(oldRecord.reason, '家庭 A按时学习');
    assert.equal(newRecord.ruleId, 'r_a_study');
    assert.equal(newRecord.reason, '家庭 A主动学习');
  });
});

test('拒绝跨家庭、错分类、仅分类和超出规则范围的关联请求且不改余额', async () => {
  await withServer(async baseUrl => {
    const cases = [
      {
        body: { kid: 'child_a', amount: 3, ruleId: 'r_b_study', categoryId: 'cat_b_reward' },
        code: 'RULE_REFERENCE_INVALID', field: 'ruleId'
      },
      {
        body: { kid: 'child_a', amount: 3, ruleId: 'r_a_study', categoryId: 'cat_a_punish' },
        code: 'RULE_REFERENCE_INVALID', field: 'categoryId'
      },
      {
        body: { kid: 'child_a', amount: 3, categoryId: 'cat_a_reward' },
        code: 'RULE_REFERENCE_INVALID', field: 'categoryId'
      },
      {
        body: { kid: 'child_a', amount: 11, ruleId: 'r_a_study', categoryId: 'cat_a_reward' },
        code: 'RULE_AMOUNT_OUT_OF_RANGE', field: 'amount'
      }
    ];
    for (const scenario of cases) {
      const result = await change(baseUrl, scenario.body);
      assert.equal(result.response.status, 400);
      assert.equal(result.json.code, scenario.code);
      assert.equal(result.json.field, scenario.field);
    }
  });
  assert.equal(repositories.points.getFamilyPoints('family_a').child_a, undefined);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM transactions WHERE family_id = 'family_a'").get().count, 0);
});

test('旧客户端不传规则 ID 仍可记分，旧流水返回 null 关联字段', async () => {
  await withServer(async baseUrl => {
    const result = await change(baseUrl, {
      kid: 'child_a', amount: 2, reason: '旧客户端手动鼓励'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.record.reason, '旧客户端手动鼓励');
    assert.equal(result.json.record.ruleId, null);
    assert.equal(result.json.record.categoryId, null);
  });

  getDb().prepare(`
    INSERT INTO transactions(id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-2', 'family_a', '2026/8/2 11:00:00', 'child_a', '孩子 A', 1, '历史名称快照', '家长', '');
  const legacy = repositories.transactions.listByFamily('family_a').find(record => record.id === 'legacy-2');
  assert.equal(legacy.reason, '历史名称快照');
  assert.equal(legacy.ruleId, null);
  assert.equal(legacy.categoryId, null);
});

test('备注编辑忽略关联字段，不能篡改流水的规则归属', async () => {
  await withServer(async baseUrl => {
    const created = await change(baseUrl, {
      kid: 'child_a', amount: 3, ruleId: 'r_a_study', categoryId: 'cat_a_reward'
    });
    const noteResponse = await fetch(`${baseUrl}/api/history/note`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        recordId: created.json.record.id,
        note: '只修改备注',
        ruleId: 'r_b_study',
        categoryId: 'cat_b_reward'
      })
    });
    assert.equal(noteResponse.status, 200);
    const record = repositories.transactions.listByFamily('family_a')
      .find(item => item.id === created.json.record.id);
    assert.equal(record.note, '只修改备注');
    assert.equal(record.ruleId, 'r_a_study');
    assert.equal(record.categoryId, 'cat_a_reward');
  });
});

test('流水插入失败时余额更新与流水写入一起回滚', () => {
  repositories.points.setBalance('family_a', 'child_a', 7);
  getDb().exec(`
    CREATE TRIGGER reject_test_rule
    BEFORE INSERT ON transactions
    WHEN NEW.rule_id = 'r_a_study'
    BEGIN
      SELECT RAISE(ABORT, 'forced transaction failure');
    END;
  `);
  try {
    assert.throws(() => repositories.points.changePoints({
      familyId: 'family_a',
      kid: 'child_a',
      kidName: '孩子 A',
      amount: 3,
      reason: '家庭 A按时学习',
      operator: '管理员 A',
      note: '',
      ruleId: 'r_a_study',
      categoryId: 'cat_a_reward'
    }), /forced transaction failure/);
  } finally {
    getDb().exec('DROP TRIGGER IF EXISTS reject_test_rule');
  }
  assert.equal(repositories.points.getFamilyPoints('family_a').child_a, 7);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM transactions WHERE family_id = 'family_a'").get().count, 0);
});
