const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-data-rights-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'data-rights.sqlite');
process.env.HARMONY_CHILD_ENABLED = 'false';
process.env.CHILD_ENROLLMENT_ENABLED = 'false';
process.env.CHILD_DATA_RIGHTS_ENABLED = 'false';
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
process.env.GUARDIAN_RELATION_DECLARATION_VERSION = 'guardian-relation-v1';
process.env.GUARDIAN_RELATION_DECLARATION_SHA256 = 'e'.repeat(64);
process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL = 'https://example.invalid/guardian-relation';

const { getDb, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');
const dataRightsService = require('../services/data-rights');

const TEST_PASSWORD = 'synthetic-data-rights-password';
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
let enrollmentSequence = 0;

function setEnrollmentGates(enabled) {
  process.env.HARMONY_CHILD_ENABLED = enabled ? 'true' : 'false';
  process.env.CHILD_ENROLLMENT_ENABLED = enabled ? 'true' : 'false';
}

function setDataRightsGate(enabled) {
  process.env.CHILD_DATA_RIGHTS_ENABLED = enabled ? 'true' : 'false';
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

function createFixture() {
  const suffix = String(++fixtureSequence).padStart(3, '0');
  const familyId = `family_dr_${suffix}`;
  const adminId = `admin_dr_${suffix}`;
  const parentId = `parent_dr_${suffix}`;
  repositories.families.ensureDefault({
    id: familyId,
    name: `合成行权家庭 ${suffix}`,
    createdAt: new Date().toISOString()
  });
  const password = token.hashPwd(TEST_PASSWORD);
  repositories.users.insert({
    id: adminId, name: `合成管理员 ${suffix}`, role: 'admin', password, familyId
  });
  repositories.users.insert({
    id: parentId, name: `合成家长 ${suffix}`, role: 'parent', password, familyId
  });
  return { suffix, familyId, adminId, parentId };
}

function authHeaders(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

function createApi() {
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use('/api', require('../routes/v2-guardian-consents'));
  app.use('/api', require('../routes/v2-data-rights'));
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

async function issueReauth(baseUrl, userId, purpose) {
  const result = await request(baseUrl, '/api/v2/reauth-assertions', {
    method: 'POST', userId, body: { purpose, password: TEST_PASSWORD }
  });
  assert.equal(result.response.status, 200);
  return result.body.reauthAssertion;
}

function acceptance(reauthAssertion, expectedRevision, guardianRelation = 'father') {
  return {
    reauthAssertion,
    expectedRevision,
    guardianRelation,
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

async function enroll(baseUrl, fixture, alias = `合成行权孩子 ${fixture.suffix}`) {
  setEnrollmentGates(true);
  const reauthAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_enrollment');
  const body = acceptance(reauthAssertion, 0);
  delete body.expectedRevision;
  body.alias = alias;
  const result = await request(baseUrl, '/api/v2/child-enrollments', {
    method: 'POST',
    userId: fixture.adminId,
    headers: {
      'Idempotency-Key': `dr-${fixture.suffix}-enroll-${++enrollmentSequence}-0123456789abcdef`
    },
    body
  });
  setEnrollmentGates(false);
  assert.equal(result.response.status, 201);
  return result.body.child;
}

async function recordParentConsent(baseUrl, fixture, childId, expectedRevision) {
  setEnrollmentGates(true);
  const reauthAssertion = await issueReauth(baseUrl, fixture.parentId, 'child_consent');
  const result = await request(baseUrl, `/api/v2/children/${childId}/consents`, {
    method: 'POST',
    userId: fixture.parentId,
    headers: { 'Idempotency-Key': `dr-${fixture.suffix}-parent-consent-0123456789` },
    body: acceptance(reauthAssertion, expectedRevision, 'mother')
  });
  setEnrollmentGates(false);
  assert.equal(result.response.status, 201);
  return result.body;
}

function rightsKey(fixture, label) {
  return `dr-${fixture.suffix}-${label}-0123456789abcdef`;
}

async function createRight(baseUrl, {
  fixture, userId = fixture.adminId, childId, requestType,
  expectedRevision, reauthAssertion, label, correction
}) {
  return request(baseUrl, `/api/v2/children/${childId}/data-rights-requests`, {
    method: 'POST',
    userId,
    headers: { 'Idempotency-Key': rightsKey(fixture, label) },
    body: { requestType, expectedRevision, reauthAssertion, ...(correction ? { correction } : {}) }
  });
}

function assertNoCredentialLeak(value, secrets = []) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  for (const field of [
    'password', 'tokenHash', 'accessTokenHash', 'refreshTokenHash',
    'publicKeyPem', 'publicKeyFingerprint', 'reauthAssertionId', 'requestFingerprint',
    'verificationMethod', 'tokenFamilyId', 'rotationCounter'
  ]) {
    assert.equal(serialized.includes(`"${field}"`), false, `response leaked ${field}`);
  }
}

after(() => {
  setEnrollmentGates(false);
  setDataRightsGate(false);
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('action-bound reauth、独立功能门、本人列表详情和动态导出形成完整 access 切片', async () => {
  ensureLegalTexts();
  const fixture = createFixture();
  const foreign = createFixture();
  await withServer(async baseUrl => {
    const child = await enroll(baseUrl, fixture, '合成查阅孩子');
    const sibling = await enroll(baseUrl, fixture, '不会进入查阅导出的兄弟姐妹');
    const rawAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_access');
    const gated = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'access', expectedRevision: 1,
      reauthAssertion: rawAssertion, label: 'access-gated'
    });
    assert.equal(gated.response.status, 403);
    assert.equal(gated.body.code, 'FEATURE_DISABLED');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions
      WHERE family_id = ? AND purpose = 'child_data_access'
    `).get(fixture.familyId).consumed_at, null);

    setDataRightsGate(true);
    const created = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'access', expectedRevision: 1,
      reauthAssertion: rawAssertion, label: 'access-created'
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.dataRightsRequest.status, 'completed');
    assert.equal(created.body.dataRightsRequest.receipt.code, 'ACCESS_REQUEST_COMPLETED');
    const requestId = created.body.dataRightsRequest.id;
    assertNoCredentialLeak(created.body, [rawAssertion]);

    const detail = await request(baseUrl, `/api/v2/data-rights-requests/${requestId}`, {
      userId: fixture.adminId
    });
    assert.equal(detail.response.status, 200);
    assert.deepEqual(
      detail.body.dataRightsRequest.auditTrail.map(event => event.eventType),
      ['data_rights_requested', 'data_rights_verified', 'data_rights_completed']
    );
    const parentHidden = await request(baseUrl, `/api/v2/data-rights-requests/${requestId}`, {
      userId: fixture.parentId
    });
    assert.equal(parentHidden.response.status, 404);
    const familyHidden = await request(baseUrl, `/api/v2/data-rights-requests/${requestId}`, {
      userId: foreign.adminId
    });
    assert.equal(familyHidden.response.status, 404);

    const unverifiedRelationAssertion = await issueReauth(
      baseUrl, fixture.parentId, 'child_data_access'
    );
    const unverifiedRelation = await createRight(baseUrl, {
      fixture,
      userId: fixture.parentId,
      childId: child.id,
      requestType: 'access',
      expectedRevision: 1,
      reauthAssertion: unverifiedRelationAssertion,
      label: 'parent-without-relation'
    });
    assert.equal(unverifiedRelation.response.status, 404);
    assert.equal(unverifiedRelation.body.code, 'CHILD_NOT_FOUND');

    setDataRightsGate(false);
    const list = await request(baseUrl, '/api/v2/data-rights-requests?limit=1', {
      userId: fixture.adminId
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.dataRightsRequests[0].id, requestId);
    const exported = await request(
      baseUrl,
      `/api/v2/children/${child.id}/data-export?requestId=${requestId}`,
      { userId: fixture.adminId }
    );
    assert.equal(exported.response.status, 200);
    assert.equal(exported.body.dataExport.child.alias, '合成查阅孩子');
    assert.deepEqual(exported.body.dataExport.deviceSessions, []);
    assert.equal(exported.body.dataExport.authorizedByRequestId, requestId);
    assert.equal(exported.body.dataExport.retentionNotice.deletionExecutionEnabled, false);
    assertNoCredentialLeak(exported.body, [rawAssertion, TEST_PASSWORD]);
    assert.equal(JSON.stringify(exported.body).includes(sibling.id), false);
    assert.equal(JSON.stringify(exported.body).includes('不会进入查阅导出的兄弟姐妹'), false);
    const completedAt = Date.parse(created.body.dataRightsRequest.completedAt);
    assert.throws(
      () => dataRightsService.exportChildData({
        actor: repositories.users.findById(fixture.adminId),
        childId: child.id,
        query: { requestId },
        body: undefined,
        now: new Date(completedAt - 6001)
      }),
      error => error.status === 410 && error.code === 'DATA_EXPORT_EXPIRED'
    );
    const wrongChildExport = await request(
      baseUrl,
      `/api/v2/children/${sibling.id}/data-export?requestId=${requestId}`,
      { userId: fixture.adminId }
    );
    assert.equal(wrongChildExport.response.status, 404);
  });
  setDataRightsGate(false);
});

test('别名更正只更新当前档案，保留历史账本快照并提供当前状态幂等重放', async () => {
  ensureLegalTexts();
  setDataRightsGate(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const oldAlias = '合成更正前别名';
    const newAlias = '合成更正后别名';
    const child = await enroll(baseUrl, fixture, oldAlias);
    repositories.points.changePoints({
      familyId: fixture.familyId,
      kid: child.id,
      kidName: oldAlias,
      amount: 3,
      reason: '合成历史任务',
      operator: '合成监护人',
      note: '合成历史备注'
    });

    const wrongPurpose = await issueReauth(baseUrl, fixture.adminId, 'child_data_export');
    const rejected = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'correct', expectedRevision: 1,
      reauthAssertion: wrongPurpose, label: 'correct-wrong-purpose',
      correction: {
        target: 'child_profile', field: 'alias', expectedValue: oldAlias, value: newAlias
      }
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.code, 'REAUTH_REQUIRED');

    const assertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_correct');
    const input = {
      fixture, childId: child.id, requestType: 'correct', expectedRevision: 1,
      reauthAssertion: assertion, label: 'correct-success',
      correction: {
        target: 'child_profile', field: 'alias', expectedValue: oldAlias, value: newAlias
      }
    };
    const corrected = await createRight(baseUrl, input);
    assert.equal(corrected.response.status, 201);
    assert.equal(corrected.body.dataRightsRequest.receipt.code, 'CORRECTION_APPLIED');
    assert.equal(repositories.users.findById(child.id).name, newAlias);
    const history = getDb().prepare(`
      SELECT kid_name FROM transactions WHERE family_id = ? AND kid_id = ?
    `).get(fixture.familyId, child.id);
    assert.equal(history.kid_name, oldAlias);
    const exportSnapshot = repositories.dataRights.readExportSnapshot({
      familyId: fixture.familyId,
      childId: child.id,
      guardianId: fixture.adminId
    });
    assert.equal(exportSnapshot.child.alias, newAlias);
    assert.equal(exportSnapshot.transactions[0].childAliasSnapshot, oldAlias);
    const stored = getDb().prepare(`
      SELECT request_payload_json FROM data_rights_requests WHERE id = ?
    `).get(corrected.body.dataRightsRequest.id);
    assert.equal(stored.request_payload_json.includes(oldAlias), false);
    assert.equal(stored.request_payload_json.includes(newAlias), false);
    assert.equal(JSON.parse(stored.request_payload_json).expectedValueSha256.length, 64);

    const replay = await createRight(baseUrl, input);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.dataRightsRequest.id, corrected.body.dataRightsRequest.id);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM data_rights_requests
      WHERE family_id = ? AND request_type = 'correct'
    `).get(fixture.familyId).count, 1);

    const freshAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_correct');
    const staleAlias = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'correct', expectedRevision: 1,
      reauthAssertion: freshAssertion, label: 'correct-stale-alias',
      correction: {
        target: 'child_profile', field: 'alias', expectedValue: oldAlias, value: '另一合成别名'
      }
    });
    assert.equal(staleAlias.response.status, 409);
    assert.equal(staleAlias.body.code, 'CORRECTION_CONFLICT');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions
      WHERE token_hash = ?
    `).get(require('crypto').createHash('sha256').update(freshAssertion).digest('hex')).consumed_at, null);
  });
  setDataRightsGate(false);
});

test('删除与终止在功能门关闭时仍可受理，但只进入 deletion_pending 和 blocked_policy', async () => {
  ensureLegalTexts();
  setDataRightsGate(false);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const target = await enroll(baseUrl, fixture, '合成待删除孩子');
    const sibling = await enroll(baseUrl, fixture, '合成隔离兄弟姐妹');
    const assertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_delete');
    const deletion = await createRight(baseUrl, {
      fixture, childId: target.id, requestType: 'delete', expectedRevision: 1,
      reauthAssertion: assertion, label: 'delete-policy-block'
    });
    assert.equal(deletion.response.status, 202);
    assert.equal(deletion.body.dataRightsRequest.status, 'processing');
    assert.equal(deletion.body.dataRightsRequest.retentionDecision, 'policy_pending');
    assert.equal(deletion.body.dataRightsRequest.deletion.status, 'blocked_policy');
    assert.equal(deletion.body.dataRightsRequest.receipt.code, 'RETENTION_DECISION_REQUIRED');

    const targetState = repositories.guardianConsents.getPrivacyState({
      familyId: fixture.familyId, childId: target.id
    });
    const siblingState = repositories.guardianConsents.getPrivacyState({
      familyId: fixture.familyId, childId: sibling.id
    });
    assert.equal(targetState.status, 'deletion_pending');
    assert.equal(siblingState.status, 'active');
    assert.ok(repositories.users.findById(target.id).tokensValidAfter > 0);
    assert.equal(repositories.users.findById(sibling.id).tokensValidAfter, 0);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM data_deletion_jobs
      WHERE family_id = ? AND child_id = ? AND status = 'blocked_policy'
    `).get(fixture.familyId, target.id).count, 1);

    const terminateAssertion = await issueReauth(
      baseUrl, fixture.adminId, 'child_service_terminate'
    );
    const duplicate = await createRight(baseUrl, {
      fixture, childId: target.id, requestType: 'terminate',
      expectedRevision: targetState.revision,
      reauthAssertion: terminateAssertion, label: 'terminate-conflict'
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, 'DESTRUCTIVE_REQUEST_IN_PROGRESS');
    const hash = require('crypto').createHash('sha256').update(terminateAssertion).digest('hex');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions WHERE token_hash = ?
    `).get(hash).consumed_at, null);
  });
});

test('既有撤回 API 同事务写入 009 审计，撤回后可查阅、删除且 deletion_pending 不会被降级', async () => {
  ensureLegalTexts();
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const child = await enroll(baseUrl, fixture, '合成撤回孩子');
    const parentConsent = await recordParentConsent(baseUrl, fixture, child.id, 1);
    assert.equal(parentConsent.privacyState.revision, 2);
    const tokenFloorBeforeWithdrawal = repositories.users.findById(child.id).tokensValidAfter;
    const preWithdrawalToken = token.signToken(child.id, 'child', fixture.familyId);
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
    assert.equal(token.verifyToken(preWithdrawalToken)?.id, child.id);
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';

    const withdrawAssertion = await issueReauth(
      baseUrl, fixture.adminId, 'child_consent_withdraw'
    );
    const withdrawn = await request(baseUrl, `/api/v2/children/${child.id}/consents/withdraw`, {
      method: 'POST',
      userId: fixture.adminId,
      headers: { 'Idempotency-Key': rightsKey(fixture, 'withdraw-admin') },
      body: { reauthAssertion: withdrawAssertion, expectedRevision: 2 }
    });
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.privacyState.status, 'processing_blocked');
    const tokenFloorAfterWithdrawal = repositories.users.findById(child.id).tokensValidAfter;
    assert.ok(tokenFloorAfterWithdrawal > tokenFloorBeforeWithdrawal);
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
    assert.equal(token.verifyToken(preWithdrawalToken), null);
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
    setEnrollmentGates(true);
    const renewedAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_consent');
    const renewed = await request(baseUrl, `/api/v2/children/${child.id}/consents`, {
      method: 'POST',
      userId: fixture.adminId,
      headers: { 'Idempotency-Key': rightsKey(fixture, 'renew-after-withdraw') },
      body: acceptance(renewedAssertion, 3)
    });
    setEnrollmentGates(false);
    assert.equal(renewed.response.status, 201);
    assert.equal(renewed.body.privacyState.status, 'active');
    assert.equal(
      repositories.users.findById(child.id).tokensValidAfter,
      tokenFloorAfterWithdrawal
    );
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
    assert.equal(token.verifyToken(preWithdrawalToken), null);
    process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
    const withdrawalRequest = getDb().prepare(`
      SELECT id, status FROM data_rights_requests
      WHERE family_id = ? AND child_id = ? AND guardian_id = ? AND request_type = 'withdraw'
    `).get(fixture.familyId, child.id, fixture.adminId);
    assert.equal(withdrawalRequest.status, 'completed');
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ?
    `).get(withdrawalRequest.id).count, 3);

    setDataRightsGate(true);
    const accessAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_access');
    const access = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'access', expectedRevision: 4,
      reauthAssertion: accessAssertion, label: 'access-after-withdraw'
    });
    assert.equal(access.response.status, 201);
    setDataRightsGate(false);
    const exported = await request(
      baseUrl,
      `/api/v2/children/${child.id}/data-export?requestId=${access.body.dataRightsRequest.id}`,
      { userId: fixture.adminId }
    );
    assert.equal(exported.response.status, 200);

    const deleteAssertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_delete');
    const deletion = await createRight(baseUrl, {
      fixture, childId: child.id, requestType: 'delete', expectedRevision: 4,
      reauthAssertion: deleteAssertion, label: 'delete-after-withdraw'
    });
    assert.equal(deletion.response.status, 202);
    assert.equal(deletion.body.dataRightsRequest.revision, 2);
    const deletionRevision = repositories.guardianConsents.getPrivacyState({
      familyId: fixture.familyId, childId: child.id
    }).revision;

    const parentWithdrawalAssertion = await issueReauth(
      baseUrl, fixture.parentId, 'child_consent_withdraw'
    );
    const parentWithdrawal = await request(
      baseUrl,
      `/api/v2/children/${child.id}/consents/withdraw`,
      {
        method: 'POST',
        userId: fixture.parentId,
        headers: { 'Idempotency-Key': rightsKey(fixture, 'withdraw-parent-after-delete') },
        body: {
          reauthAssertion: parentWithdrawalAssertion,
          expectedRevision: deletionRevision
        }
      }
    );
    assert.equal(parentWithdrawal.response.status, 200);
    assert.equal(parentWithdrawal.body.privacyState.status, 'deletion_pending');
    assert.equal(parentWithdrawal.body.privacyState.revision, deletionRevision);
  });
  setDataRightsGate(false);
});

test('并发幂等只生成一份证据，冲突载荷与中途失败均不消费新凭据或留下半成品', async () => {
  ensureLegalTexts();
  setDataRightsGate(true);
  const fixture = createFixture();
  await withServer(async baseUrl => {
    const child = await enroll(baseUrl, fixture, '合成并发行权孩子');
    const assertion = await issueReauth(baseUrl, fixture.adminId, 'child_data_access');
    const concurrentInput = {
      fixture,
      childId: child.id,
      requestType: 'access',
      expectedRevision: 1,
      reauthAssertion: assertion,
      label: 'concurrent-access'
    };
    const concurrent = await Promise.all([
      createRight(baseUrl, concurrentInput),
      createRight(baseUrl, concurrentInput)
    ]);
    assert.deepEqual(concurrent.map(item => item.response.status).sort(), [200, 201]);
    assert.equal(
      concurrent[0].body.dataRightsRequest.id,
      concurrent[1].body.dataRightsRequest.id
    );
    const requestId = concurrent[0].body.dataRightsRequest.id;
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM data_rights_requests
      WHERE family_id = ? AND request_type = 'access'
    `).get(fixture.familyId).count, 1);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ?
    `).get(requestId).count, 3);

    const conflictingAssertion = await issueReauth(
      baseUrl, fixture.adminId, 'child_data_export'
    );
    const conflicting = await createRight(baseUrl, {
      fixture,
      childId: child.id,
      requestType: 'export',
      expectedRevision: 1,
      reauthAssertion: conflictingAssertion,
      label: 'concurrent-access'
    });
    assert.equal(conflicting.response.status, 409);
    assert.equal(conflicting.body.code, 'IDEMPOTENCY_CONFLICT');
    const conflictingHash = require('crypto').createHash('sha256')
      .update(conflictingAssertion).digest('hex');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions WHERE token_hash = ?
    `).get(conflictingHash).consumed_at, null);

    const correctionAssertion = await issueReauth(
      baseUrl, fixture.adminId, 'child_data_correct'
    );
    getDb().exec(`
      CREATE TRIGGER synthetic_data_rights_alias_failure
      BEFORE UPDATE OF name ON users
      BEGIN
        SELECT RAISE(ABORT, 'SYNTHETIC_DATA_RIGHTS_ALIAS_FAILURE');
      END;
    `);
    let failed;
    try {
      failed = await createRight(baseUrl, {
        fixture,
        childId: child.id,
        requestType: 'correct',
        expectedRevision: 1,
        reauthAssertion: correctionAssertion,
        label: 'correction-rollback',
        correction: {
          target: 'child_profile',
          field: 'alias',
          expectedValue: '合成并发行权孩子',
          value: '不会提交的合成别名'
        }
      });
    } finally {
      getDb().exec('DROP TRIGGER synthetic_data_rights_alias_failure');
    }
    assert.equal(failed.response.status, 500);
    assert.equal(repositories.users.findById(child.id).name, '合成并发行权孩子');
    const correctionHash = require('crypto').createHash('sha256')
      .update(correctionAssertion).digest('hex');
    assert.equal(getDb().prepare(`
      SELECT consumed_at FROM reauth_assertions WHERE token_hash = ?
    `).get(correctionHash).consumed_at, null);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM data_rights_requests
      WHERE family_id = ? AND request_type = 'correct'
    `).get(fixture.familyId).count, 0);
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM v2_idempotency_records
      WHERE family_id = ? AND operation = 'data_rights_request_create'
        AND resource_type IS NULL
    `).get(fixture.familyId).count, 0);
  });
  setDataRightsGate(false);
});
