const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-guardian-consents-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'guardian-consents.sqlite');
process.env.HARMONY_CHILD_ENABLED = 'false';
process.env.CHILD_ENROLLMENT_ENABLED = 'false';
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
process.env.GUARDIAN_RELATION_DECLARATION_VERSION = 'guardian-relation-v1';
process.env.GUARDIAN_RELATION_DECLARATION_SHA256 = 'e'.repeat(64);
process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL = 'https://example.invalid/guardian-relation';

const { getDb, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

const TEST_PASSWORD = 'synthetic-password';
const legalTexts = Object.freeze({
  privacyPolicy: {
    type: 'privacy_policy', version: 'privacy-v1', sha256: 'a'.repeat(64),
    publicUrl: 'https://example.invalid/privacy'
  },
  childPersonalInformationRules: {
    type: 'child_personal_information_rules', version: 'child-rules-v1', sha256: 'b'.repeat(64),
    publicUrl: 'https://example.invalid/child-rules'
  },
  childUserAgreement: {
    type: 'child_user_agreement', version: 'child-agreement-v1', sha256: 'c'.repeat(64),
    publicUrl: 'https://example.invalid/child-agreement'
  },
  sensitiveInformationNotice: {
    type: 'sensitive_information_notice', version: 'sensitive-notice-v1', sha256: 'd'.repeat(64),
    publicUrl: 'https://example.invalid/sensitive-notice'
  }
});
let fixtureSequence = 0;

function setEnrollmentGates(enabled) {
  process.env.HARMONY_CHILD_ENABLED = enabled ? 'true' : 'false';
  process.env.CHILD_ENROLLMENT_ENABLED = enabled ? 'true' : 'false';
}

function ensureLegalTexts() {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  Object.values(legalTexts).forEach((text, index) => {
    const timestamp = `2026-01-01T00:0${index}:00.000Z`;
    insert.run(text.type, text.version, text.sha256, text.publicUrl, timestamp, timestamp);
  });
}

function createFixture({ existingChild = false } = {}) {
  const suffix = String(++fixtureSequence).padStart(3, '0');
  const familyId = `family_gc_${suffix}`;
  const adminId = `admin_gc_${suffix}`;
  const parentId = `parent_gc_${suffix}`;
  const childId = `child_gc_${suffix}`;
  repositories.families.ensureDefault({
    id: familyId,
    name: `合成授权家庭 ${suffix}`,
    createdAt: new Date().toISOString()
  });
  const password = token.hashPwd(TEST_PASSWORD);
  repositories.users.insert({
    id: adminId, name: `合成管理员 ${suffix}`, role: 'admin', password, familyId
  });
  repositories.users.insert({
    id: parentId, name: `合成家长 ${suffix}`, role: 'parent', password, familyId
  });
  if (existingChild) {
    repositories.users.insert({
      id: childId, name: `合成存量孩子 ${suffix}`, role: 'child', password: '', familyId
    });
  }
  return { suffix, familyId, adminId, parentId, childId };
}

function authHeaders(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

function createApi() {
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use('/api', require('../routes/v2-guardian-consents'));
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

async function request(baseUrl, pathname, {
  method = 'GET', userId, headers = {}, body
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(userId ? authHeaders(userId) : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, body: await response.json() };
}

async function issueReauth(baseUrl, userId, purpose, password = TEST_PASSWORD) {
  return request(baseUrl, '/api/v2/reauth-assertions', {
    method: 'POST', userId, body: { purpose, password }
  });
}

function enrollmentBody(reauthAssertion, alias = '合成孩子') {
  return {
    alias,
    reauthAssertion,
    guardianRelation: 'father',
    relationDeclaration: {
      accepted: true,
      version: process.env.GUARDIAN_RELATION_DECLARATION_VERSION,
      sha256: process.env.GUARDIAN_RELATION_DECLARATION_SHA256
    },
    consents: Object.fromEntries(Object.entries(legalTexts).map(([field, text]) => [field, {
      accepted: true,
      version: text.version,
      sha256: text.sha256
    }]))
  };
}

function consentBody(reauthAssertion, expectedRevision) {
  const body = enrollmentBody(reauthAssertion);
  delete body.alias;
  body.expectedRevision = expectedRevision;
  return body;
}

function idempotencyKey(fixture, label) {
  return `gc-${fixture.suffix}-${label}-0123456789abcdef`;
}

async function recordFixtureConsent(baseUrl, fixture, {
  userId = fixture.adminId,
  expectedRevision = 0,
  label = 'read-model-consent'
} = {}) {
  const reauth = await issueReauth(baseUrl, userId, 'child_consent');
  const result = await request(baseUrl, `/api/v2/children/${fixture.childId}/consents`, {
    method: 'POST',
    userId,
    headers: { 'Idempotency-Key': idempotencyKey(fixture, label) },
    body: consentBody(reauth.body.reauthAssertion, expectedRevision)
  });
  assert.equal(result.response.status, 201);
  return result;
}

function countFamilyRows(table, familyId) {
  return getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE family_id = ?`).get(familyId).count;
}

function assertNoSensitiveResponse(body, secrets = []) {
  const serialized = JSON.stringify(body);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  for (const field of [
    'password', 'tokenHash', 'reauthAssertionId', 'auditData', 'verificationMethod'
  ]) {
    assert.equal(serialized.includes(`\"${field}\"`), false, `response leaked ${field}`);
  }
}

after(() => {
  setEnrollmentGates(false);
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('公共法律文本缺失时失败，四类文本完整后只返回公开最小证据', async () => {
  await withServer(async baseUrl => {
    const missing = await request(baseUrl, '/api/v2/legal-texts/current');
    assert.equal(missing.response.status, 503);
    assert.equal(missing.body.code, 'LEGAL_TEXTS_UNAVAILABLE');

    ensureLegalTexts();
    const current = await request(baseUrl, '/api/v2/legal-texts/current');
    assert.equal(current.response.status, 200);
    assert.deepEqual(Object.keys(current.body.texts).sort(), Object.keys(legalTexts).sort());
    for (const [field, expected] of Object.entries(legalTexts)) {
      assert.deepEqual(current.body.texts[field], {
        type: expected.type,
        version: expected.version,
        sha256: expected.sha256,
        publicUrl: expected.publicUrl,
        effectiveAt: current.body.texts[field].effectiveAt
      });
      assert.equal(Object.prototype.hasOwnProperty.call(current.body.texts[field], 'content'), false);
    }
    assert.deepEqual(current.body.guardianRelationDeclaration, {
      version: process.env.GUARDIAN_RELATION_DECLARATION_VERSION,
      sha256: process.env.GUARDIAN_RELATION_DECLARATION_SHA256,
      publicUrl: process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL
    });
    assertNoSensitiveResponse(current.body);
  });
});

test('v2 重新认证严格只接受 Bearer，不接受 query 或 body Token', async () => {
  ensureLegalTexts();
  const fixture = createFixture();
  const bearer = authHeaders(fixture.adminId).Authorization.slice('Bearer '.length);
  await withServer(async baseUrl => {
    for (const attempt of [
      () => request(baseUrl, '/api/v2/reauth-assertions', {
        method: 'POST', body: { purpose: 'child_enrollment', password: TEST_PASSWORD }
      }),
      () => request(baseUrl, `/api/v2/reauth-assertions?token=${encodeURIComponent(bearer)}`, {
        method: 'POST', body: { purpose: 'child_enrollment', password: TEST_PASSWORD }
      }),
      () => request(baseUrl, '/api/v2/reauth-assertions', {
        method: 'POST', body: { token: bearer, purpose: 'child_enrollment', password: TEST_PASSWORD }
      })
    ]) {
      const result = await attempt();
      assert.equal(result.response.status, 401);
      assert.equal(result.body.code, 'AUTH_REQUIRED');
    }
    assert.equal(countFamilyRows('reauth_assertions', fixture.familyId), 0);

    const accepted = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    assert.equal(accepted.response.status, 200);
    assert.equal(typeof accepted.body.reauthAssertion, 'string');
  });
});

test('儿童建档要求 Harmony 总门与 enrollment 门同时开启', async () => {
  ensureLegalTexts();
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    const body = enrollmentBody(reauth.body.reauthAssertion, '双门合成孩子');
    const scenarios = [
      ['false', 'false'],
      ['true', 'false'],
      ['false', 'true']
    ];
    for (const [harmony, enrollment] of scenarios) {
      process.env.HARMONY_CHILD_ENABLED = harmony;
      process.env.CHILD_ENROLLMENT_ENABLED = enrollment;
      const blocked = await request(baseUrl, '/api/v2/child-enrollments', {
        method: 'POST', userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, `gate-${harmony}-${enrollment}`) },
        body
      });
      assert.equal(blocked.response.status, 403);
      assert.equal(blocked.body.code, 'FEATURE_DISABLED');
    }
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 0);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM users WHERE family_id = ? AND role = 'child'
    `).get(fixture.familyId).count, 0);
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions WHERE family_id = ?
    `).get(fixture.familyId).consumed_at, null);
  });
  setEnrollmentGates(false);
});

test('重新认证拒绝错误密码和用途，且用途绑定不能被建档重用', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const wrongPassword = await issueReauth(
      baseUrl, fixture.adminId, 'child_enrollment', 'definitely-wrong'
    );
    assert.equal(wrongPassword.response.status, 403);
    assert.equal(wrongPassword.body.code, 'REAUTH_REQUIRED');

    const wrongPurpose = await issueReauth(baseUrl, fixture.adminId, 'not-an-action');
    assert.equal(wrongPurpose.response.status, 400);
    assert.equal(wrongPurpose.body.code, 'REAUTH_PURPOSE_INVALID');

    const consentAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_consent');
    assert.equal(consentAssertion.response.status, 200);
    const rejected = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'wrong-purpose') },
      body: enrollmentBody(consentAssertion.body.reauthAssertion, '用途错误孩子')
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.code, 'REAUTH_REQUIRED');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions
      WHERE family_id = ? AND purpose = 'child_consent'
    `).get(fixture.familyId).consumed_at, null);
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 0);
  });
  setEnrollmentGates(false);
});

test('关系声明与四类法律文本 accepted 必须严格为布尔 true', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    const valid = enrollmentBody(reauth.body.reauthAssertion, '严格同意孩子');
    const mutations = [];
    for (const field of Object.keys(legalTexts)) {
      mutations.push(body => { body.consents[field].accepted = false; });
    }
    for (const value of ['true', 1, {}, []]) {
      mutations.push(body => { body.consents.privacyPolicy.accepted = value; });
    }
    mutations.push(body => { body.relationDeclaration.accepted = 'true'; });

    for (let index = 0; index < mutations.length; index++) {
      const body = structuredClone(valid);
      mutations[index](body);
      const rejected = await request(baseUrl, '/api/v2/child-enrollments', {
        method: 'POST', userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, `accept-${index}`) }, body
      });
      assert.equal(rejected.response.status, 400);
      assert.equal(rejected.body.code, 'CONSENT_REQUIRED');
    }
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 0);
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions WHERE family_id = ?
    `).get(fixture.familyId).consumed_at, null);

    const accepted = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'accept-valid') }, body: valid
    });
    assert.equal(accepted.response.status, 201);
  });
  setEnrollmentGates(false);
});

test('成功 enrollment 原子创建空密码孩子、零余额账户、active 状态和最小响应', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    const body = enrollmentBody(reauth.body.reauthAssertion, '原子建档孩子');
    const result = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'atomic-success') }, body
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(result.body.child.alias, '原子建档孩子');
    assert.equal(result.body.child.privacyStatus, 'active');
    assert.deepEqual(result.body.privacyState, {
      status: 'active', revision: 1, updatedAt: result.body.privacyState.updatedAt
    });

    const storedChild = getDb().prepare(`
      SELECT id, role, password, family_id, openid FROM users WHERE id = ?
    `).get(result.body.child.id);
    assert.deepEqual({ ...storedChild }, {
      id: result.body.child.id,
      role: 'child',
      password: '',
      family_id: fixture.familyId,
      openid: null
    });
    assert.deepEqual({ ...getDb().prepare(`
      SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
    `).get(fixture.familyId, result.body.child.id) }, { balance: 0 });
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 1);
    assert.equal(getDb().prepare(`
      SELECT consumed_at IS NOT NULL AS consumed
      FROM reauth_assertions WHERE family_id = ?
    `).get(fixture.familyId).consumed, 1);
    assert.equal(getDb().prepare(`
      SELECT status FROM v2_idempotency_records WHERE family_id = ?
    `).get(fixture.familyId).status, 'completed');
    assertNoSensitiveResponse(result.body, [reauth.body.reauthAssertion, TEST_PASSWORD]);
  });
  setEnrollmentGates(false);
});

test('enrollment 中途数据库失败会回滚断言、孩子、账户、状态、授权和幂等记录', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  const triggerName = `reject_consent_${fixture.suffix}`;
  getDb().exec(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON guardian_consents
    WHEN NEW.family_id = '${fixture.familyId}'
    BEGIN
      SELECT RAISE(ABORT, 'SYNTHETIC_CONSENT_FAILURE');
    END;
  `);
  try {
    await withServer(async baseUrl => {
      const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
      const result = await request(baseUrl, '/api/v2/child-enrollments', {
        method: 'POST', userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, 'atomic-failure') },
        body: enrollmentBody(reauth.body.reauthAssertion, '不应落库孩子')
      });
      assert.equal(result.response.status, 500);
      assert.equal(result.body.code, 'INTERNAL_ERROR');
      assert.equal(getDb().prepare(`
        SELECT COUNT(*) AS count FROM users WHERE family_id = ? AND role = 'child'
      `).get(fixture.familyId).count, 0);
      for (const table of [
        'point_accounts', 'child_privacy_states', 'guardian_consents', 'v2_idempotency_records'
      ]) assert.equal(countFamilyRows(table, fixture.familyId), 0);
      assert.equal(getDb().prepare(`
        SELECT consumed_at FROM reauth_assertions WHERE family_id = ?
      `).get(fixture.familyId).consumed_at, null);
      assertNoSensitiveResponse(result.body, [reauth.body.reauthAssertion]);
    });
  } finally {
    getDb().exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    setEnrollmentGates(false);
  }
});

test('enrollment 幂等重放返回同一结果，冲突请求与已消费断言不能创建第二个孩子', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    const body = enrollmentBody(reauth.body.reauthAssertion, '幂等合成孩子');
    const key = idempotencyKey(fixture, 'replay');
    const first = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': key }, body
    });
    assert.equal(first.response.status, 201);

    const replay = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': key }, body
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.child.id, first.body.child.id);
    assert.equal(replay.body.consent.id, first.body.consent.id);

    const changed = structuredClone(body);
    changed.alias = '冲突别名';
    const conflict = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': key }, body: changed
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

    const reusedAssertion = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'new-key') }, body
    });
    assert.equal(reusedAssertion.response.status, 403);
    assert.equal(reusedAssertion.body.code, 'REAUTH_REQUIRED');
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 1);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM users WHERE family_id = ? AND role = 'child'
    `).get(fixture.familyId).count, 1);
  });
  setEnrollmentGates(false);
});

test('授权操作恢复查询按成人与幂等键精确隔离且不受创建功能门影响', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture();
  const key = idempotencyKey(fixture, 'operation-recovery');
  await withServer(async baseUrl => {
    const missing = await request(
      baseUrl,
      '/api/v2/guardian-consent-operations/child-enrollment',
      { userId: fixture.adminId, headers: { 'Idempotency-Key': key } }
    );
    assert.equal(missing.response.status, 200);
    assert.deepEqual(missing.body.guardianConsentOperation, {
      operation: 'child-enrollment', status: 'not_found'
    });

    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
    const enrolled = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': key },
      body: enrollmentBody(reauth.body.reauthAssertion, '恢复查询合成孩子')
    });
    assert.equal(enrolled.response.status, 201);

    setEnrollmentGates(false);
    const completed = await request(
      baseUrl,
      '/api/v2/guardian-consent-operations/child-enrollment',
      { userId: fixture.adminId, headers: { 'Idempotency-Key': key } }
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.guardianConsentOperation.operation, 'child-enrollment');
    assert.equal(completed.body.guardianConsentOperation.status, 'completed');
    assert.equal(typeof completed.body.guardianConsentOperation.completedAt, 'string');
    assert.equal(Object.hasOwn(completed.body.guardianConsentOperation, 'resourceId'), false);

    const otherAdult = await request(
      baseUrl,
      '/api/v2/guardian-consent-operations/child-enrollment',
      { userId: fixture.parentId, headers: { 'Idempotency-Key': key } }
    );
    assert.equal(otherAdult.response.status, 200);
    assert.equal(otherAdult.body.guardianConsentOperation.status, 'not_found');
  });
  setEnrollmentGates(false);
});

test('家庭与监护身份从 Bearer 推导，跨家庭 child ID 不能查询或授权', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const familyA = createFixture();
  const familyB = createFixture({ existingChild: true });
  await withServer(async baseUrl => {
    const reauthA = await issueReauth(baseUrl, familyA.adminId, 'child_enrollment');
    const forged = enrollmentBody(reauthA.body.reauthAssertion, '服务端定域孩子');
    forged.familyId = familyB.familyId;
    forged.guardianId = familyB.adminId;
    forged.childId = familyB.childId;
    const enrolled = await request(baseUrl, '/api/v2/child-enrollments', {
      method: 'POST', userId: familyA.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(familyA, 'server-scope') }, body: forged
    });
    assert.equal(enrolled.response.status, 201);
    const stored = getDb().prepare(`
      SELECT family_id FROM users WHERE id = ?
    `).get(enrolled.body.child.id);
    assert.equal(stored.family_id, familyA.familyId);
    assert.equal(getDb().prepare(`
      SELECT guardian_id FROM guardian_consents WHERE id = ?
    `).get(enrolled.body.consent.id).guardian_id, familyA.adminId);

    const crossRead = await request(
      baseUrl, `/api/v2/children/${familyB.childId}/consents`, { userId: familyA.adminId }
    );
    assert.equal(crossRead.response.status, 404);
    assert.equal(crossRead.body.code, 'CHILD_NOT_FOUND');

    const consentReauth = await issueReauth(baseUrl, familyA.adminId, 'child_consent');
    const crossWrite = await request(
      baseUrl, `/api/v2/children/${familyB.childId}/consents`, {
        method: 'POST', userId: familyA.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(familyA, 'cross-consent') },
        body: consentBody(consentReauth.body.reauthAssertion, 0)
      }
    );
    assert.equal(crossWrite.response.status, 404);
    assert.equal(crossWrite.body.code, 'CHILD_NOT_FOUND');
    assert.equal(countFamilyRows('guardian_consents', familyB.familyId), 0);
  });
  setEnrollmentGates(false);
});

test('监护儿童读取模型只返回本人历史 verified consent 范围与最小字段', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture({ existingChild: true });
  const foreign = createFixture({ existingChild: true });
  const unconsentedChildId = `child_unconsented_${fixture.suffix}`;
  repositories.users.insert({
    id: unconsentedChildId,
    name: `合成未授权孩子 ${fixture.suffix}`,
    role: 'child',
    password: '',
    familyId: fixture.familyId
  });

  try {
    await withServer(async baseUrl => {
      const unauthenticated = await request(baseUrl, '/api/v2/children');
      assert.equal(unauthenticated.response.status, 401);
      assert.equal(unauthenticated.body.code, 'AUTH_REQUIRED');

      const active = await recordFixtureConsent(baseUrl, fixture);
      await recordFixtureConsent(baseUrl, foreign, { label: 'foreign-read-model-consent' });

      const forgedScope = await request(
        baseUrl,
        `/api/v2/children?familyId=${encodeURIComponent(foreign.familyId)}&guardianId=${encodeURIComponent(foreign.adminId)}`,
        { userId: fixture.adminId }
      );
      assert.equal(forgedScope.response.status, 400);
      assert.equal(forgedScope.body.code, 'VALIDATION_ERROR');
      assert.equal(forgedScope.body.field, 'familyId');

      const visible = await request(baseUrl, '/api/v2/children', {
        userId: fixture.adminId
      });
      assert.equal(visible.response.status, 200);
      assert.deepEqual(Object.keys(visible.body).sort(), ['children', 'success']);
      assert.equal(visible.body.success, true);
      assert.equal(visible.body.children.length, 1);
      const entry = visible.body.children[0];
      assert.deepEqual(Object.keys(entry).sort(), ['child', 'latestConsent', 'privacyState']);
      assert.deepEqual(entry.child, {
        id: fixture.childId,
        alias: `合成存量孩子 ${fixture.suffix}`
      });
      assert.deepEqual(entry.privacyState, {
        status: 'active',
        revision: 1,
        updatedAt: entry.privacyState.updatedAt
      });
      assert.deepEqual(Object.keys(entry.latestConsent).sort(), [
        'id', 'status', 'updatedAt', 'verifiedAt', 'version'
      ]);
      assert.equal(entry.latestConsent.id, active.body.consent.id);
      assert.equal(entry.latestConsent.version, 1);
      assert.equal(entry.latestConsent.status, 'active');

      const noOwnHistory = await request(baseUrl, '/api/v2/children', {
        userId: fixture.parentId
      });
      assert.equal(noOwnHistory.response.status, 200);
      assert.deepEqual(noOwnHistory.body.children, []);

      const serialized = JSON.stringify(visible.body);
      for (const hiddenValue of [
        fixture.familyId,
        fixture.adminId,
        fixture.parentId,
        foreign.familyId,
        foreign.adminId,
        foreign.childId,
        unconsentedChildId
      ]) assert.equal(serialized.includes(hiddenValue), false);
      for (const hiddenField of [
        'familyId',
        'guardianId',
        'guardianRelation',
        'legalTexts',
        'consentScope',
        'visibilityScope'
      ]) assert.equal(serialized.includes(`\"${hiddenField}\"`), false);
      assertNoSensitiveResponse(visible.body);

      process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
      try {
        const childDenied = await request(baseUrl, '/api/v2/children', {
          userId: fixture.childId
        });
        assert.equal(childDenied.response.status, 403);
        assert.equal(childDenied.body.code, 'FORBIDDEN_SCOPE');
      } finally {
        process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
      }
    });
  } finally {
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
    setEnrollmentGates(false);
  }
});

test('撤回和 superseded 后仍可按本人严格最新授权发现儿童', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const withdrawnFixture = createFixture({ existingChild: true });
  const supersededFixture = createFixture({ existingChild: true });

  try {
    await withServer(async baseUrl => {
      await recordFixtureConsent(baseUrl, withdrawnFixture, {
        label: 'withdrawn-read-model-consent'
      });
      const withdrawReauth = await issueReauth(
        baseUrl,
        withdrawnFixture.adminId,
        'child_consent_withdraw'
      );
      const withdrawn = await request(
        baseUrl,
        `/api/v2/children/${withdrawnFixture.childId}/consents/withdraw`,
        {
          method: 'POST',
          userId: withdrawnFixture.adminId,
          headers: {
            'Idempotency-Key': idempotencyKey(withdrawnFixture, 'read-model-withdraw')
          },
          body: {
            reauthAssertion: withdrawReauth.body.reauthAssertion,
            expectedRevision: 1
          }
        }
      );
      assert.equal(withdrawn.response.status, 200);

      setEnrollmentGates(false);
      const afterWithdrawal = await request(baseUrl, '/api/v2/children', {
        userId: withdrawnFixture.adminId
      });
      assert.equal(afterWithdrawal.response.status, 200);
      assert.equal(afterWithdrawal.body.children.length, 1);
      assert.equal(afterWithdrawal.body.children[0].latestConsent.status, 'withdrawn');
      assert.deepEqual(afterWithdrawal.body.children[0].privacyState, {
        status: 'processing_blocked',
        revision: 2,
        updatedAt: afterWithdrawal.body.children[0].privacyState.updatedAt
      });

      setEnrollmentGates(true);
      await recordFixtureConsent(baseUrl, supersededFixture, {
        label: 'superseded-read-model-consent'
      });
      const active = repositories.guardianConsents.findActiveConsent({
        familyId: supersededFixture.familyId,
        childId: supersededFixture.childId,
        guardianId: supersededFixture.adminId
      });
      const supersededAt = new Date(Date.parse(active.updatedAt) + 1).toISOString();
      const superseded = repositories.guardianConsents.supersedeConsent({
        familyId: supersededFixture.familyId,
        consentId: active.id,
        expectedLifecycleRevision: active.lifecycleRevision,
        supersededAt,
        updatedAt: supersededAt
      });
      assert.equal(superseded.status, 'superseded');

      const afterSuperseded = await request(baseUrl, '/api/v2/children', {
        userId: supersededFixture.adminId
      });
      assert.equal(afterSuperseded.response.status, 200);
      assert.equal(afterSuperseded.body.children.length, 1);
      assert.equal(afterSuperseded.body.children[0].latestConsent.id, active.id);
      assert.equal(afterSuperseded.body.children[0].latestConsent.status, 'superseded');
      assert.equal(afterSuperseded.body.children[0].latestConsent.version, 1);
    });
  } finally {
    setEnrollmentGates(false);
  }
});

test('存量 child 只有完整重新同意后才从 suspended 激活且不重复创建用户', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture({ existingChild: true });
  const userCountBefore = countFamilyRows('users', fixture.familyId);
  assert.deepEqual({ ...getDb().prepare(`
    SELECT status, revision FROM child_privacy_states
    WHERE family_id = ? AND child_id = ?
  `).get(fixture.familyId, fixture.childId) }, {
    status: 'suspended_pending_consent', revision: 0
  });

  await withServer(async baseUrl => {
    const reauth = await issueReauth(baseUrl, fixture.adminId, 'child_consent');
    const result = await request(baseUrl, `/api/v2/children/${fixture.childId}/consents`, {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'legacy-consent') },
      body: consentBody(reauth.body.reauthAssertion, 0)
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.consent.childId, fixture.childId);
    assert.deepEqual(result.body.privacyState, {
      status: 'active', revision: 1, updatedAt: result.body.privacyState.updatedAt
    });
    assert.equal(countFamilyRows('users', fixture.familyId), userCountBefore);
    assert.equal(countFamilyRows('guardian_consents', fixture.familyId), 1);
    assertNoSensitiveResponse(result.body, [reauth.body.reauthAssertion, TEST_PASSWORD]);
  });
  setEnrollmentGates(false);
});

test('功能门关闭后仍可撤回，撤回立即阻止新增积分处理且响应不泄露凭据', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture({ existingChild: true });
  await withServer(async baseUrl => {
    const consentReauth = await issueReauth(baseUrl, fixture.adminId, 'child_consent');
    const consent = await request(baseUrl, `/api/v2/children/${fixture.childId}/consents`, {
      method: 'POST', userId: fixture.adminId,
      headers: { 'Idempotency-Key': idempotencyKey(fixture, 'before-withdraw') },
      body: consentBody(consentReauth.body.reauthAssertion, 0)
    });
    assert.equal(consent.response.status, 201);
    const withdrawReauth = await issueReauth(
      baseUrl, fixture.adminId, 'child_consent_withdraw'
    );

    setEnrollmentGates(false);
    const withdrawBody = {
      reauthAssertion: withdrawReauth.body.reauthAssertion,
      expectedRevision: 1
    };
    const key = idempotencyKey(fixture, 'withdraw');
    const withdrawn = await request(
      baseUrl, `/api/v2/children/${fixture.childId}/consents/withdraw`, {
        method: 'POST', userId: fixture.adminId,
        headers: { 'Idempotency-Key': key }, body: withdrawBody
      }
    );
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.consent.status, 'withdrawn');
    assert.deepEqual(withdrawn.body.privacyState, {
      status: 'processing_blocked', revision: 2, updatedAt: withdrawn.body.privacyState.updatedAt
    });
    assertNoSensitiveResponse(withdrawn.body, [
      consentReauth.body.reauthAssertion,
      withdrawReauth.body.reauthAssertion,
      TEST_PASSWORD
    ]);

    const replay = await request(
      baseUrl, `/api/v2/children/${fixture.childId}/consents/withdraw`, {
        method: 'POST', userId: fixture.adminId,
        headers: { 'Idempotency-Key': key }, body: withdrawBody
      }
    );
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.consent.id, withdrawn.body.consent.id);

    const beforeAccount = repositories.points.getChildPoints(fixture.familyId, fixture.childId);
    assert.throws(() => repositories.points.changePoints({
      familyId: fixture.familyId,
      kid: fixture.childId,
      kidName: '合成存量孩子',
      amount: 5,
      reason: '撤回后不应处理',
      operator: '合成管理员',
      note: ''
    }), error => error && error.code === 'CHILD_PROCESSING_BLOCKED');
    assert.deepEqual(repositories.points.getChildPoints(fixture.familyId, fixture.childId), beforeAccount);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM transactions
      WHERE family_id = ? AND kid_id = ?
    `).get(fixture.familyId, fixture.childId).count, 0);
  });
  setEnrollmentGates(false);
});

test('任一监护人撤回形成全局暂停，其他监护人不能覆盖且旧幂等结果状态漂移时拒绝重放', async () => {
  ensureLegalTexts();
  setEnrollmentGates(true);
  const fixture = createFixture({ existingChild: true });
  await withServer(async baseUrl => {
    const adminReauth = await issueReauth(baseUrl, fixture.adminId, 'child_consent');
    const adminConsent = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents`,
      {
        method: 'POST',
        userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, 'admin-consent-v1') },
        body: consentBody(adminReauth.body.reauthAssertion, 0)
      }
    );
    assert.equal(adminConsent.response.status, 201);

    const parentReauth = await issueReauth(baseUrl, fixture.parentId, 'child_consent');
    const parentConsent = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents`,
      {
        method: 'POST',
        userId: fixture.parentId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, 'parent-consent-v1') },
        body: consentBody(parentReauth.body.reauthAssertion, 1)
      }
    );
    assert.equal(parentConsent.response.status, 201);
    assert.equal(parentConsent.body.privacyState.revision, 2);

    const withdrawReauth = await issueReauth(
      baseUrl,
      fixture.adminId,
      'child_consent_withdraw'
    );
    const withdrawn = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents/withdraw`,
      {
        method: 'POST',
        userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, 'admin-withdraw') },
        body: {
          reauthAssertion: withdrawReauth.body.reauthAssertion,
          expectedRevision: 2
        }
      }
    );
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.privacyState.status, 'processing_blocked');
    assert.equal(withdrawn.body.privacyState.revision, 3);

    const parentReconsentAssertion = await issueReauth(
      baseUrl,
      fixture.parentId,
      'child_consent'
    );
    const parentReplayKey = idempotencyKey(fixture, 'parent-consent-v2');
    const parentReconsentBody = consentBody(parentReconsentAssertion.body.reauthAssertion, 3);
    const held = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents`,
      {
        method: 'POST',
        userId: fixture.parentId,
        headers: { 'Idempotency-Key': parentReplayKey },
        body: parentReconsentBody
      }
    );
    assert.equal(held.response.status, 201);
    assert.equal(held.body.privacyState.status, 'processing_blocked');
    assert.equal(held.body.privacyState.revision, 3);

    const adminReconsentAssertion = await issueReauth(
      baseUrl,
      fixture.adminId,
      'child_consent'
    );
    const resumed = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents`,
      {
        method: 'POST',
        userId: fixture.adminId,
        headers: { 'Idempotency-Key': idempotencyKey(fixture, 'admin-consent-v2') },
        body: consentBody(adminReconsentAssertion.body.reauthAssertion, 3)
      }
    );
    assert.equal(resumed.response.status, 201);
    assert.equal(resumed.body.privacyState.status, 'active');
    assert.equal(resumed.body.privacyState.revision, 4);

    const staleReplay = await request(
      baseUrl,
      `/api/v2/children/${fixture.childId}/consents`,
      {
        method: 'POST',
        userId: fixture.parentId,
        headers: { 'Idempotency-Key': parentReplayKey },
        body: parentReconsentBody
      }
    );
    assert.equal(staleReplay.response.status, 409);
    assert.equal(staleReplay.body.code, 'IDEMPOTENCY_REPLAY_STALE');
    assert.deepEqual({ ...getDb().prepare(`
      SELECT status, revision FROM child_privacy_states
      WHERE family_id = ? AND child_id = ?
    `).get(fixture.familyId, fixture.childId) }, { status: 'active', revision: 4 });
  });
  setEnrollmentGates(false);
});
