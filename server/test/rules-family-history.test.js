const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-family-rules-test-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'family-rules.sqlite');

const { inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

function rulesWithLabel(label) {
  return {
    reward: [{
      id: 'cat_reward_study',
      category: '学习成长',
      items: [{
        id: 'r_study_1', label, min: 1, max: 10, default: 3,
        unit: '每次', hint: '认真完成后记录'
      }]
    }],
    punish: [{
      id: 'cat_punish_habit',
      category: '习惯提醒',
      items: [{
        id: 'p_habit_1', label: '没有按时收拾', min: -10, max: -1, default: -3,
        unit: '每次', hint: '先提醒再记录'
      }]
    }],
    special: ['连续七天保持好习惯可获得额外鼓励']
  };
}

function resetDatabase() {
  inTransaction(db => {
    db.prepare('DELETE FROM rule_versions').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM rules').run();
    db.prepare('DELETE FROM families').run();
  });
  const createdAt = new Date().toISOString();
  for (const [id, name] of [['default', '默认家庭'], ['family_a', '家庭A'], ['family_b', '家庭B']]) {
    repositories.families.ensureDefault({ id, name, createdAt });
  }
  for (const [id, familyId] of [['admin_default', 'default'], ['admin_a', 'family_a'], ['admin_b', 'family_b']]) {
    repositories.users.insert({
      id,
      name: id,
      role: 'admin',
      password: token.hashPwd('test-password'),
      familyId
    });
  }
}

function createApi() {
  const app = express();
  app.use(require('../middleware/request-logger'));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', require('../routes/config'));
  return app;
}

async function withServer(work) {
  const server = await new Promise(resolve => {
    const listening = createApi().listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await work(baseUrl); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function headers(userId) {
  const user = repositories.users.findById(userId);
  return {
    Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}`,
    'Content-Type': 'application/json'
  };
}

async function api(baseUrl, pathName, userId, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: headers(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, json: await response.json() };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('004迁移将旧规则只归入default家庭，回滚保留v2.5全量归档', () => {
  const migrationDbPath = path.join(tempDir, `migration-${Date.now()}.sqlite`);
  const db = new DatabaseSync(migrationDbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  for (const name of ['001_init.sql', '002_token_revocation.sql', '003_transaction_soft_delete.sql']) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
  }
  const now = new Date().toISOString();
  for (const id of ['default', 'family_a', 'family_b']) {
    db.prepare('INSERT INTO families(id, name, created_at) VALUES (?, ?, ?)').run(id, id, now);
  }
  const legacy = { ...rulesWithLabel('迁移前规则'), revision: 7 };
  db.prepare('INSERT INTO rules(id, data_json) VALUES (1, ?)').run(JSON.stringify(legacy));

  db.exec(fs.readFileSync(path.join(migrationsDir, '004_family_rules_history.sql'), 'utf8'));
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run('004_family_rules_history.sql', now);
  const migrated = db.prepare('SELECT family_id, revision, data_json FROM rules').all();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].family_id, 'default');
  assert.equal(migrated[0].revision, 7);
  assert.deepEqual(JSON.parse(migrated[0].data_json), legacy);
  const baseline = db.prepare('SELECT family_id, revision, source FROM rule_versions').all();
  assert.deepEqual(baseline.map(row => ({ ...row })), [{ family_id: 'default', revision: 7, source: 'migration' }]);

  const familyARules = { ...rulesWithLabel('家庭A迁移后规则'), revision: 1 };
  db.prepare('INSERT INTO rules(family_id, revision, data_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('family_a', 1, JSON.stringify(familyARules), 'admin_a', now);
  db.prepare(`
    INSERT INTO rule_versions(family_id, revision, data_json, created_by, created_at, source)
    VALUES (?, ?, ?, ?, ?, 'save')
  `).run('family_a', 1, JSON.stringify(familyARules), 'admin_a', now);

  const rollback = path.join(__dirname, '..', 'db', 'rollbacks', '004_family_rules_history.sql');
  db.exec(fs.readFileSync(rollback, 'utf8'));
  assert.deepEqual(JSON.parse(db.prepare('SELECT data_json FROM rules WHERE id = 1').get().data_json), legacy);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rules_v25_archive").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rule_versions_v25_archive").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '004_family_rules_history.sql'").get().count, 0);

  const rollbackPeriodDefault = { ...rulesWithLabel('回滚期间更新的默认规则'), revision: 8 };
  db.prepare('UPDATE rules SET data_json = ? WHERE id = 1').run(JSON.stringify(rollbackPeriodDefault));
  db.exec(fs.readFileSync(path.join(migrationsDir, '004_family_rules_history.sql'), 'utf8'));
  const rolledForward = db.prepare('SELECT family_id, revision, data_json FROM rules ORDER BY family_id').all();
  assert.equal(rolledForward.length, 2);
  const rolledForwardDefault = rolledForward.find(row => row.family_id === 'default');
  assert.equal(rolledForwardDefault.revision, 8);
  assert.equal(JSON.parse(rolledForwardDefault.data_json).reward[0].items[0].label, '回滚期间更新的默认规则');
  assert.equal(JSON.parse(rolledForward.find(row => row.family_id === 'family_a').data_json).reward[0].items[0].label, '家庭A迁移后规则');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rule_versions WHERE family_id = 'family_a'").get().count, 1);
  assert.equal(db.prepare("SELECT source FROM rule_versions WHERE family_id = 'default' AND revision = 8").get().source, 'migration');
  db.close();
});

test('全新数据库占位家庭会由安全初始化补齐名称和邀请码', () => {
  const id = 'bootstrap_family';
  const createdAt = new Date().toISOString();
  inTransaction(db => {
    db.prepare('INSERT INTO families(id, name, invite_code, invite_json, created_at) VALUES (?, ?, NULL, NULL, ?)')
      .run(id, '默认家庭', createdAt);
  });
  const family = repositories.families.ensureDefault({
    id,
    name: '安总家',
    inviteCode: 'ABC789',
    createdAt
  });
  assert.equal(family.name, '安总家');
  assert.equal(family.inviteCode, 'ABC789');
});

test('规则按Token当前家庭隔离，body familyId不能跨家庭写入', async () => {
  repositories.config.setRules('default', rulesWithLabel('默认模板'), { updatedBy: 'admin_default' });
  await withServer(async baseUrl => {
    const initialA = await api(baseUrl, '/api/config', 'admin_a');
    const initialB = await api(baseUrl, '/api/config', 'admin_b');
    assert.deepEqual(initialA.json.rules.reward, []);
    assert.deepEqual(initialB.json.rules.reward, []);
    assert.equal(initialA.json.rules.revision, 0);
    assert.equal(initialB.json.rules.revision, 0);

    const familyARules = rulesWithLabel('家庭A专属');
    familyARules.revision = initialA.json.rules.revision;
    const savedA = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST',
      body: { familyId: 'family_b', revision: 0, rules: familyARules }
    });
    assert.equal(savedA.response.status, 200);
    assert.equal(savedA.json.rules.reward[0].items[0].label, '家庭A专属');

    const afterA = await api(baseUrl, '/api/config', 'admin_a');
    const afterB = await api(baseUrl, '/api/config', 'admin_b');
    assert.equal(afterA.json.rules.reward[0].items[0].label, '家庭A专属');
    assert.deepEqual(afterB.json.rules.reward, []);
    assert.equal(repositories.config.getRules('default').reward[0].items[0].label, '默认模板');
  });
});

test('旧客户不传familyId时default家庭仍可正常读写', async () => {
  await withServer(async baseUrl => {
    const first = await api(baseUrl, '/api/config/rules', 'admin_default', {
      method: 'POST', body: { rules: rulesWithLabel('旧客户规则') }
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.json.revision, 1);
    const config = await api(baseUrl, '/api/config', 'admin_default');
    assert.equal(config.response.status, 200);
    assert.equal(config.json.rules.reward[0].items[0].label, '旧客户规则');
  });
});

test('已删除并关联历史的稳定ID不能被另一条新语义规则复用', async () => {
  await withServer(async baseUrl => {
    const first = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST', body: { revision: 0, rules: rulesWithLabel('原始学习规则') }
    });
    assert.equal(first.response.status, 200);

    const removed = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST',
      body: { revision: 1, rules: { reward: [], punish: [], special: [], revision: 1 } }
    });
    assert.equal(removed.response.status, 200);

    const reused = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST', body: { revision: 2, rules: rulesWithLabel('完全不同的新语义') }
    });
    assert.equal(reused.response.status, 400);
    assert.equal(reused.json.code, 'RULES_VALIDATION_ERROR');
    assert.equal(reused.json.field, 'reward[0].items[0].id');
  });
});

test('历史详情原样展示旧范围，恢复不兼容快照时精确拒绝而不静默改值', async () => {
  await withServer(async baseUrl => {
    const saved = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST', body: { revision: 0, rules: rulesWithLabel('当前规则') }
    });
    assert.equal(saved.response.status, 200);
    const legacy = structuredClone(saved.json.rules);
    legacy.revision = 99;
    legacy.punish[0].items[0].min = -999;
    legacy.punish[0].items[0].default = -999;
    const versionId = inTransaction(db => Number(db.prepare(`
      INSERT INTO rule_versions(family_id, revision, data_json, created_by, created_at, source)
      VALUES (?, ?, ?, ?, ?, 'save')
    `).run('family_a', 99, JSON.stringify(legacy), 'legacy_admin', new Date().toISOString()).lastInsertRowid));

    const detail = await api(baseUrl, `/api/config/rules/history/${versionId}`, 'admin_a');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.json.version.rules.punish[0].items[0].min, -999);

    const restore = await api(baseUrl, `/api/config/rules/history/${versionId}/restore`, 'admin_a', {
      method: 'POST', body: { revision: saved.json.revision }
    });
    assert.equal(restore.response.status, 400);
    assert.equal(restore.json.code, 'RULES_VALIDATION_ERROR');
    assert.match(restore.json.message, /-500/);
    assert.equal(repositories.config.getRules('family_a').punish[0].items[0].min, -10);
  });
});

test('规则历史按家庭隔离，恢复生成新revision且保留源版本', async () => {
  await withServer(async baseUrl => {
    const first = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST', body: { rules: rulesWithLabel('第一版') }
    });
    assert.equal(first.response.status, 200);
    const secondRules = structuredClone(first.json.rules);
    secondRules.reward[0].items[0].label = '第二版';
    const second = await api(baseUrl, '/api/config/rules', 'admin_a', {
      method: 'POST', body: { revision: 1, rules: secondRules }
    });
    assert.equal(second.response.status, 200);
    inTransaction(db => {
      db.prepare(`
        INSERT INTO transactions(
          id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note, rule_id, category_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'tx_before_restore', 'family_a', new Date().toISOString(), 'kid_a', '孩子A', 3,
        '第一版', 'admin_a', '', 'r_study_1', 'cat_reward_study'
      );
    });

    const history = await api(baseUrl, '/api/config/rules/history', 'admin_a');
    assert.equal(history.response.status, 200);
    assert.equal(history.json.currentRevision, 2);
    assert.equal(history.json.history.length, 3);
    assert.equal(history.json.history[0].revision, 2);
    assert.equal(history.json.history[0].rewardCount, 1);
    assert.equal(history.json.history[0].punishCount, 1);
    assert.equal(history.json.history[0].specialCount, 1);
    const revisionOne = history.json.history.find(version => version.revision === 1);
    const initialized = history.json.history.find(version => version.revision === 0);
    assert.equal(initialized.source, 'initialize');

    const detail = await api(baseUrl, `/api/config/rules/history/${revisionOne.versionId}`, 'admin_a');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.json.version.rules.reward[0].items[0].label, '第一版');

    const crossFamily = await api(baseUrl, `/api/config/rules/history/${revisionOne.versionId}`, 'admin_b');
    assert.equal(crossFamily.response.status, 404);

    const missingRevision = await api(baseUrl, `/api/config/rules/history/${revisionOne.versionId}/restore`, 'admin_a', {
      method: 'POST', body: {}
    });
    assert.equal(missingRevision.response.status, 400);
    assert.equal(missingRevision.json.code, 'RULES_REVISION_REQUIRED');

    const restored = await api(baseUrl, `/api/config/rules/history/${revisionOne.versionId}/restore`, 'admin_a', {
      method: 'POST', body: { revision: 2 }
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.json.revision, 3);
    assert.equal(restored.json.rules.reward[0].items[0].label, '第一版');
    assert.equal(restored.json.version.source, 'restore');
    assert.equal(restored.json.version.restoredFromVersionId, revisionOne.versionId);
    const unchangedTransaction = inTransaction(db => db.prepare(`
      SELECT reason, rule_id, category_id
      FROM transactions
      WHERE id = 'tx_before_restore'
    `).get());
    assert.deepEqual({ ...unchangedTransaction }, {
      reason: '第一版', rule_id: 'r_study_1', category_id: 'cat_reward_study'
    });

    const staleRestore = await api(baseUrl, `/api/config/rules/history/${revisionOne.versionId}/restore`, 'admin_a', {
      method: 'POST', body: { revision: 2 }
    });
    assert.equal(staleRestore.response.status, 409);
    assert.equal(staleRestore.json.code, 'RULES_REVISION_CONFLICT');
    assert.equal(staleRestore.json.currentRevision, 3);
  });
});
