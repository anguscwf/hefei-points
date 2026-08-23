const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-s0-security-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'security.sqlite');
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';

const { getDb, inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

const TEST_PASSWORD = 'test-password';

function ensureSyntheticConsent(db, { familyId, guardianId, childId, tag, createdAt }) {
  const version = 'synthetic-s1-v1';
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
      '{"fixture":"s0-security"}', NULL, ?, ?
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
}

function resetDatabase() {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
  process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
  inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM rule_versions').run();
    db.prepare('DELETE FROM rules').run();
  });
  const createdAt = new Date().toISOString();
  repositories.families.ensureDefault({ id: 'default', name: '默认家庭', createdAt });
  repositories.families.ensureDefault({ id: 'family_a', name: '家庭A', inviteCode: 'INVITA', createdAt });
  repositories.families.ensureDefault({ id: 'family_b', name: '家庭B', inviteCode: 'INVITB', createdAt });
  const password = token.hashPwd(TEST_PASSWORD);
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
    { id: 'admin_a', name: '管理员A', role: 'admin', familyId: 'family_a' },
    { id: 'parent_a', name: '家长A', role: 'parent', familyId: 'family_a' },
    { id: 'child_a1', name: '孩子A1', role: 'child', familyId: 'family_a' },
    { id: 'child_a2', name: '孩子A2', role: 'child', familyId: 'family_a' },
    { id: 'child_a3', name: '孩子A3', role: 'child', familyId: 'family_a' },
    { id: 'admin_b', name: '管理员B', role: 'admin', familyId: 'family_b' },
    { id: 'child_b1', name: '孩子B1', role: 'child', familyId: 'family_b' }
  ]) upsertUser.run(user.id, user.name, user.role, password, user.familyId);

  // These synthetic S0 fixtures exercise legacy point reads/writes, but 009
  // still requires real consent evidence before a privacy row can be active.
  const activatedAt = new Date().toISOString();
  ensureSyntheticConsent(getDb(), {
    familyId: 'family_a',
    guardianId: 'admin_a',
    childId: 'child_a1',
    tag: 's0_admin_a_child_a1',
    createdAt: activatedAt
  });
  ensureSyntheticConsent(getDb(), {
    familyId: 'family_a',
    guardianId: 'parent_a',
    childId: 'child_a2',
    tag: 's0_parent_a_child_a2',
    createdAt: activatedAt
  });
  ensureSyntheticConsent(getDb(), {
    familyId: 'family_b',
    guardianId: 'admin_b',
    childId: 'child_b1',
    tag: 's0_admin_b_child_b1',
    createdAt: activatedAt
  });
  inTransaction(db => db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active',
        revision = revision + 1,
        reason_code = 'guardian_consent_recorded',
        updated_at = ?,
        activated_at = ?
    WHERE status = 'suspended_pending_consent'
      AND child_id IN ('child_a1', 'child_a2', 'child_b1')
  `).run(activatedAt, activatedAt));

  for (const entry of [
    ['family_a', 'child_a1', 11],
    ['family_a', 'child_a2', 22],
    ['family_b', 'child_b1', 33]
  ]) {
    const [familyId, kid, amount] = entry;
    repositories.points.changePoints({
      familyId,
      kid,
      kidName: kid,
      amount,
      reason: '合成测试',
      operator: '测试执行器',
      note: ''
    });
  }
  // Preserve a non-zero legacy balance on a suspended child so response-scope
  // assertions prove that hidden accounts are filtered, not merely absent.
  repositories.points.setBalance('family_a', 'child_a3', 44);
}

function createApi() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/auth'));
  app.use('/api', require('../routes/points'));
  app.use('/api', require('../routes/history'));
  app.use('/api', require('../routes/family'));
  app.use('/api', require('../routes/config'));
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

function authorization(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

async function json(response) {
  const text = await response.text();
  try {
    return { response, body: JSON.parse(text) };
  } catch (error) {
    assert.fail(`expected JSON response, received ${response.status}: ${text}\n${error.message}`);
  }
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('匿名或畸形 Token 的 config 只返回无成员公共空壳', async () => {
  await withServer(async baseUrl => {
    const expected = { success: true, public: true, users: [] };
    for (const request of [
      fetch(`${baseUrl}/api/config`),
      fetch(`${baseUrl}/api/config`, { headers: { Authorization: 'Bearer garbage' } }),
      fetch(`${baseUrl}/api/config?token=garbage`)
    ]) {
      const result = await json(await request);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body, expected);
    }
  });
});

test('家长仍可按用户 ID 登录且配置不暴露未授权儿童或其他家庭', async () => {
  await withServer(async baseUrl => {
    const login = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(login.response.status, 200);
    assert.equal(login.body.success, true);

    const config = await json(await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${login.body.token}` }
    }));
    assert.equal(config.response.status, 200);
    assert.deepEqual(
      config.body.users.map(user => user.id).sort(),
      ['admin_a', 'child_a2', 'parent_a']
    );
    assert.deepEqual(Object.keys(config.body.families), ['family_a']);
    assert.equal(JSON.stringify(config.body).includes('child_a1'), false);
    assert.equal(JSON.stringify(config.body).includes('child_b1'), false);
    assert.equal(JSON.stringify(config.body).includes('家庭B'), false);
  });
});

test('旧儿童密码登录与既有 Token 默认失效', async () => {
  const childToken = token.signToken('child_a1', 'child', 'family_a');
  assert.equal(token.verifyToken(childToken), null);
  await withServer(async baseUrl => {
    const login = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'child_a1', password: TEST_PASSWORD })
    }));
    assert.equal(login.response.status, 403);
    assert.equal(login.body.code, 'FEATURE_DISABLED');

    const wrongPassword = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'child_a1', password: 'definitely-wrong' })
    }));
    assert.equal(wrongPassword.response.status, 403);
    assert.deepEqual(wrongPassword.body, { success: false, message: '用户或密码错误' });

    const unknownUser = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'not_a_real_user', password: 'definitely-wrong' })
    }));
    assert.equal(unknownUser.response.status, 403);
    assert.deepEqual(unknownUser.body, wrongPassword.body);

    const points = await fetch(`${baseUrl}/api/points`, { headers: { Authorization: `Bearer ${childToken}` } });
    assert.equal(points.status, 403);
  });
});

test('微信绑定只接受服务端签名的短期绑定凭据，不信任客户端 openid', async () => {
  await withServer(async baseUrl => {
    const rawOpenId = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openid: 'client-controlled', userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(rawOpenId.response.status, 400);

    const validChildBinding = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bindingTicket: token.signScopedTicket('wx-bind', 'wx-child-valid'),
        userId: 'child_a1',
        password: TEST_PASSWORD
      })
    }));
    assert.equal(validChildBinding.response.status, 403);
    assert.equal(validChildBinding.body.code, 'FEATURE_DISABLED');

    for (const userId of ['child_a1', 'not_a_real_user']) {
      const rejectedIdentity = await json(await fetch(`${baseUrl}/api/wx-bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bindingTicket: token.signScopedTicket('wx-bind', `wx-rejected-${userId}`),
          userId,
          password: 'definitely-wrong'
        })
      }));
      assert.equal(rejectedIdentity.response.status, 403);
      assert.deepEqual(rejectedIdentity.body, { success: false, message: '账号或密码错误' });
    }

    const bindingTicket = token.signScopedTicket('wx-bind', 'wx-openid-parent-a');
    const bound = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingTicket, userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(bound.response.status, 200);
    assert.equal(bound.body.success, true);
    assert.equal(repositories.users.findById('parent_a').openid, 'wx-openid-parent-a');

    const tampered = bindingTicket.slice(0, -1) + (bindingTicket.endsWith('A') ? 'B' : 'A');
    const rejected = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingTicket: tampered, userId: 'admin_a', password: TEST_PASSWORD })
    }));
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.code, 'BINDING_TICKET_INVALID');
  });
});

test('显式开启旧儿童登录时，儿童仍只能读取本人积分、流水和资料', async () => {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
  await withServer(async baseUrl => {
    const headers = authorization('child_a1');
    const points = await json(await fetch(`${baseUrl}/api/points`, { headers }));
    assert.equal(points.response.status, 200);
    assert.deepEqual(points.body.points, { child_a1: 11 });

    for (const query of ['', '?kid=child_a2', '?kid=child_b1', '?kid=missing']) {
      const history = await json(await fetch(`${baseUrl}/api/history${query}`, { headers }));
      assert.equal(history.response.status, 200);
      assert.ok(history.body.history.length > 0);
      assert.ok(history.body.history.every(record => record.kid === 'child_a1' && record.familyId === 'family_a'));
    }

    const config = await json(await fetch(`${baseUrl}/api/config`, { headers }));
    assert.deepEqual(config.body.users.map(user => user.id), ['child_a1']);
    assert.equal(Object.prototype.hasOwnProperty.call(config.body.families.family_a, 'inviteCode'), false);

    const family = await json(await fetch(`${baseUrl}/api/family`, { headers }));
    assert.deepEqual(family.body.members.map(member => member.id), ['child_a1']);
    assert.equal(Object.prototype.hasOwnProperty.call(family.body.family, 'inviteCode'), false);

    const blockedPoints = await json(await fetch(`${baseUrl}/api/points`, { headers: authorization('child_a3') }));
    assert.equal(blockedPoints.response.status, 409);
    assert.equal(blockedPoints.body.code, 'CHILD_PROCESSING_BLOCKED');

    const blockedFamily = await json(await fetch(`${baseUrl}/api/family`, { headers: authorization('child_a3') }));
    assert.equal(blockedFamily.response.status, 409);
    assert.equal(blockedFamily.body.code, 'CHILD_PROCESSING_BLOCKED');
  });
});

test('监护人读取仅包含已授权儿童，同家庭未授权与跨家庭筛选均拒绝', async () => {
  await withServer(async baseUrl => {
    const headers = authorization('admin_a');
    const points = await json(await fetch(`${baseUrl}/api/points`, { headers }));
    assert.deepEqual(Object.keys(points.body.points), ['child_a1']);

    const history = await json(await fetch(`${baseUrl}/api/history`, { headers }));
    assert.deepEqual([...new Set(history.body.history.map(record => record.kid))], ['child_a1']);

    const family = await json(await fetch(`${baseUrl}/api/family`, { headers }));
    assert.equal(family.response.status, 200);
    const memberIds = new Set(family.body.members.map(member => member.id));
    assert.equal(memberIds.has('child_a1'), true);
    assert.equal(memberIds.has('child_a2'), false);
    assert.equal(memberIds.has('child_a3'), false);

    const filtered = await json(await fetch(`${baseUrl}/api/history?kid=child_a1`, { headers }));
    assert.ok(filtered.body.history.every(record => record.kid === 'child_a1'));

    const unauthorized = await json(await fetch(`${baseUrl}/api/history?kid=child_a2`, { headers }));
    assert.equal(unauthorized.response.status, 403);
    assert.equal(unauthorized.body.code, 'FORBIDDEN_SCOPE');

    const invalid = await json(await fetch(`${baseUrl}/api/history?kid=child_b1`, { headers }));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.message, '无效的孩子');
  });
});

test('同家庭但未取得该儿童授权的成人不能经旧记分接口写入', async () => {
  await withServer(async baseUrl => {
    const request = (userId, amount) => fetch(`${baseUrl}/api/points/change`, {
      method: 'POST',
      headers: { ...authorization(userId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kid: 'child_a1', amount, reason: '授权范围回归测试' })
    });

    const denied = await json(await request('parent_a', 5));
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, 'FORBIDDEN_SCOPE');
    assert.equal(repositories.points.getFamilyPoints('family_a').child_a1, 11);

    const allowed = await json(await request('admin_a', 5));
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.success, true);
    assert.deepEqual(allowed.body.points, { child_a1: 16 });
    assert.equal(repositories.points.getFamilyPoints('family_a').child_a1, 16);
    assert.equal(repositories.points.getFamilyPoints('family_a').child_a2, 22);
    assert.equal(repositories.points.getFamilyPoints('family_a').child_a3, 44);
  });
});
