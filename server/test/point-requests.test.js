const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-point-requests-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'point-requests.sqlite');
process.env.HARMONY_CHILD_ENABLED = 'true';
process.env.CHILD_ENROLLMENT_ENABLED = 'true';
process.env.DEVICE_PAIRING_ENABLED = 'true';
process.env.POINT_REQUESTS_ENABLED = 'true';
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
process.env.GUARDIAN_RELATION_DECLARATION_VERSION = 'guardian-relation-v1';
process.env.GUARDIAN_RELATION_DECLARATION_SHA256 = 'e'.repeat(64);
process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL = 'https://example.invalid/guardian-relation';

const { getDb, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

const TEST_PASSWORD = 'synthetic-point-request-password';
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
let requestSequence = 0;
let server;
let baseUrl;

function enableAllGates() {
  process.env.HARMONY_CHILD_ENABLED = 'true';
  process.env.CHILD_ENROLLMENT_ENABLED = 'true';
  process.env.DEVICE_PAIRING_ENABLED = 'true';
  process.env.POINT_REQUESTS_ENABLED = 'true';
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
  process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
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

function createApi() {
  const app = express();
  app.use(require('../middleware/cache-control'));
  app.use(require('../middleware/request-logger'));
  app.use(express.json({ limit: '50kb' }));
  app.use('/api', require('../routes/v2-guardian-consents'));
  app.use('/api', require('../routes/v2-device-pairing-sessions'));
  app.use('/api', require('../routes/v2-point-requests'));
  return app;
}

async function startServer() {
  server = await new Promise(resolve => {
    const listening = createApi().listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  const listening = server;
  server = undefined;
  await new Promise(resolve => listening.close(resolve));
}

function authHeaders(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

function idempotencyKey(label) {
  requestSequence += 1;
  return `points-${label}-${String(requestSequence).padStart(5, '0')}-${crypto.randomBytes(8).toString('hex')}`;
}

async function request(pathname, {
  method = 'GET', userId, bearer, idempotency, body, headers = {}
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(userId ? authHeaders(userId) : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

function assertApiError(result, status, code) {
  assert.equal(result.response.status, status);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.message, 'string');
}

function assertMinimalResponse(body) {
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    'familyId', 'deviceBindingId', 'sessionId', 'tokenFamilyId',
    'reviewerUserId', 'requestFingerprint', 'idempotencyKeyHash',
    'accessTokenHash', 'refreshTokenHash', 'operator'
  ]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, `response leaked ${forbidden}`);
  }
}

function consentBody(reauthAssertion, { alias, expectedRevision } = {}) {
  return {
    ...(alias ? { alias } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    reauthAssertion,
    guardianRelation: 'legal_guardian',
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

function rulesFor(suffix, { label = '完成合成任务', min = 2, max = 10, defaultPoints = 4 } = {}) {
  return {
    reward: [{
      id: `cat_reward_${suffix}`,
      category: `合成鼓励分类 ${suffix}`,
      items: [{
        id: `reward_${suffix}`,
        label,
        min,
        max,
        default: defaultPoints,
        unit: '每次',
        hint: '仅用于临时数据库测试'
      }]
    }],
    punish: [{
      id: `cat_punish_${suffix}`,
      category: `合成提醒分类 ${suffix}`,
      items: [{
        id: `punish_${suffix}`,
        label: '合成提醒项',
        min: -5,
        max: -1,
        default: -2,
        unit: '每次',
        hint: '仅用于临时数据库测试'
      }]
    }],
    special: [],
    revision: 0
  };
}

async function createAuthorizedFamily({ childCount = 1 } = {}) {
  enableAllGates();
  ensureLegalTexts();
  const suffix = String(++fixtureSequence).padStart(3, '0');
  const familyId = `family_points_${suffix}`;
  const adminId = `admin_points_${suffix}`;
  const parentId = `parent_points_${suffix}`;
  repositories.families.ensureDefault({
    id: familyId,
    name: `合成积分家庭 ${suffix}`,
    createdAt: new Date().toISOString()
  });
  const password = token.hashPwd(TEST_PASSWORD);
  repositories.users.insert({
    id: adminId, name: `合成管理员 ${suffix}`, role: 'admin', password, familyId
  });
  repositories.users.insert({
    id: parentId, name: `合成家长 ${suffix}`, role: 'parent', password, familyId
  });

  const children = [];
  for (let index = 0; index < childCount; index += 1) {
    const reauth = await request('/api/v2/reauth-assertions', {
      method: 'POST', userId: adminId,
      body: { purpose: 'child_enrollment', password: TEST_PASSWORD }
    });
    assert.equal(reauth.response.status, 200);
    const enrolled = await request('/api/v2/child-enrollments', {
      method: 'POST', userId: adminId,
      idempotency: idempotencyKey(`enroll-${suffix}-${index}`),
      body: consentBody(reauth.body.reauthAssertion, {
        alias: `合成积分孩子 ${suffix}-${index + 1}`
      })
    });
    assert.equal(enrolled.response.status, 201);
    children.push({
      id: enrolled.body.child.id,
      alias: enrolled.body.child.alias,
      privacyRevision: enrolled.body.privacyState.revision
    });
  }
  repositories.config.setRules(familyId, rulesFor(suffix), {
    expectedRevision: 0, updatedBy: adminId
  });
  return { suffix, familyId, adminId, parentId, children };
}

async function addGuardianConsent(fixture, guardianId, child) {
  const state = repositories.guardianConsents.getPrivacyState({
    familyId: fixture.familyId, childId: child.id
  });
  const reauth = await request('/api/v2/reauth-assertions', {
    method: 'POST', userId: guardianId,
    body: { purpose: 'child_consent', password: TEST_PASSWORD }
  });
  assert.equal(reauth.response.status, 200);
  const consent = await request(`/api/v2/children/${child.id}/consents`, {
    method: 'POST', userId: guardianId,
    idempotency: idempotencyKey(`consent-${fixture.suffix}`),
    body: consentBody(reauth.body.reauthAssertion, { expectedRevision: state.revision })
  });
  assert.equal(consent.response.status, 201);
  return consent.body;
}

function createDevice(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });
  return {
    publicId: `device_${crypto.randomBytes(16).toString('base64url')}`,
    alias: `合成申报设备-${label}`,
    publicKey: {
      algorithm: 'ECDSA_P256_SHA256',
      spkiBase64url: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    },
    privateKey
  };
}

function signProof(proof, privateKey) {
  return crypto.sign(
    'sha256', Buffer.from(proof.signingPayload, 'base64url'), privateKey
  ).toString('base64url');
}

async function fullDeviceFlow(fixture, child = fixture.children[0], label = fixture.suffix) {
  const device = createDevice(label);
  const created = await request('/api/v2/device-pairings', {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey(`pair-create-${label}`),
    body: { childId: child.id }
  });
  assert.equal(created.response.status, 201);
  const claimed = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: idempotencyKey(`pair-claim-${label}`),
    body: {
      shortCode: created.body.shortCode,
      devicePublicId: device.publicId,
      deviceAlias: device.alias,
      publicKey: device.publicKey
    }
  });
  assert.equal(claimed.response.status, 202);
  const current = await request(`/api/v2/device-pairings/${created.body.pairing.id}`, {
    userId: fixture.adminId
  });
  const confirmed = await request(`/api/v2/device-pairings/${created.body.pairing.id}/confirm`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey(`pair-confirm-${label}`),
    body: {
      expectedRevision: current.body.pairing.revision,
      pairingChallenge: created.body.pairingChallenge
    }
  });
  assert.equal(confirmed.response.status, 200);
  const completed = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.body.claimId,
    idempotency: idempotencyKey(`pair-complete-${label}`),
    body: { signatureBase64url: signProof(claimed.body.proof, device.privateKey) }
  });
  assert.equal(completed.response.status, 201);
  return { device, created: created.body, completed: completed.body };
}

function pointRequestBody(fixture, clientRequestId, overrides = {}) {
  return {
    clientRequestId,
    ruleId: `reward_${fixture.suffix}`,
    requestedPoints: 8,
    description: '合成孩子完成了测试任务',
    ...overrides
  };
}

function previousShanghaiDayOccurredAt() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const currentShanghaiNoonUtc = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 4
  );
  return new Date(currentShanghaiNoonUtc - 24 * 60 * 60 * 1000).toISOString();
}

async function createPointRequest(fixture, flow, clientRequestId, overrides = {}, key) {
  return request('/api/v2/point-requests', {
    method: 'POST',
    bearer: flow.completed.session.accessToken,
    idempotency: key || idempotencyKey(`point-create-${clientRequestId}`),
    body: pointRequestBody(fixture, clientRequestId, overrides)
  });
}

before(startServer);

after(async () => {
  enableAllGates();
  await stopServer();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('积分申报双门先止损，设备身份决定作用域且待审不入账', async () => {
  const fixture = await createAuthorizedFamily({ childCount: 2 });
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'create-scope');
  const before = getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance;

  process.env.POINT_REQUESTS_ENABLED = 'false';
  const gated = await request('/api/v2/point-requests', {
    method: 'POST', bearer: flow.completed.session.accessToken,
    body: { familyId: 'attacker', childId: fixture.children[1].id }
  });
  assertApiError(gated, 403, 'FEATURE_DISABLED');
  enableAllGates();

  const forbiddenSelector = await createPointRequest(
    fixture, flow, 'client-create-selector-0001', { childId: fixture.children[1].id }
  );
  assertApiError(forbiddenSelector, 400, 'VALIDATION_ERROR');
  assert.equal(forbiddenSelector.body.field, 'childId');

  const created = await createPointRequest(fixture, flow, 'client-create-success-0001');
  assert.equal(created.response.status, 201);
  assert.equal(created.body.pointRequest.status, 'pending');
  assert.equal(created.body.pointRequest.revision, 0);
  assert.equal(created.body.pointRequest.rule.id, `reward_${fixture.suffix}`);
  assert.equal(created.body.pointRequest.rule.categoryId, `cat_reward_${fixture.suffix}`);
  assert.equal(created.body.pointRequest.rule.minPoints, 2);
  assert.equal(created.body.pointRequest.rule.maxPoints, 10);
  assert.equal(created.body.pointRequest.clientRequestId, 'client-create-success-0001');
  assertMinimalResponse(created.body);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE family_id = ? AND source_type = 'point_request'
  `).get(fixture.familyId).count, 0);
  assert.equal(getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance, before);

  const mine = await request('/api/v2/me/point-requests', {
    bearer: flow.completed.session.accessToken
  });
  assert.equal(mine.response.status, 200);
  assert.deepEqual(mine.body.pointRequests.map(item => item.id), [created.body.pointRequest.id]);
  assertMinimalResponse(mine.body);

  const adult = await request('/api/v2/point-requests', { userId: fixture.adminId });
  assert.equal(adult.response.status, 200);
  assert.equal(adult.body.pointRequests.length, 1);
  assert.deepEqual(adult.body.pointRequests[0].child, {
    id: fixture.children[0].id, alias: fixture.children[0].alias
  });
  assert.equal('clientRequestId' in adult.body.pointRequests[0], false);
  assertMinimalResponse(adult.body);
});

test('同一设备 clientRequestId 的 100 次并发重试只产生一条申请', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'hundred-retries');
  const clientRequestId = 'client-concurrency-100-0001';
  const key = idempotencyKey('hundred-same-key');
  const results = await Promise.all(Array.from({ length: 100 }, () => createPointRequest(
    fixture, flow, clientRequestId, {}, key
  )));
  assert.equal(results.filter(item => item.response.status === 201).length, 1);
  assert.equal(results.filter(item => item.response.status === 200).length, 99);
  const ids = new Set(results.map(item => item.body.pointRequest.id));
  assert.equal(ids.size, 1);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_requests
    WHERE device_binding_id = ? AND client_request_id = ?
  `).get(flow.completed.device.id, clientRequestId).count, 1);
  const persistedEvent = getDb().prepare(`
    SELECT idempotency_key_hash, event_data_json
    FROM point_request_events
    WHERE actor_device_binding_id = ? AND action = 'create'
      AND idempotency_key_hash = ?
  `).get(
    flow.completed.device.id,
    crypto.createHash('sha256').update(key, 'utf8').digest('hex')
  );
  assert.equal(
    persistedEvent.idempotency_key_hash,
    crypto.createHash('sha256').update(key, 'utf8').digest('hex')
  );
  assert.equal(persistedEvent.event_data_json.includes(key), false);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE family_id = ?
  `).get(fixture.familyId).count, 0);

  const newKeyReplay = await createPointRequest(
    fixture, flow, clientRequestId, {}, idempotencyKey('same-domain-new-key')
  );
  assert.equal(newKeyReplay.response.status, 200);
  assert.equal(newKeyReplay.body.pointRequest.id, [...ids][0]);
  const changed = await createPointRequest(
    fixture,
    flow,
    clientRequestId,
    { description: '相同 ID 的不同合成内容' },
    idempotencyKey('same-domain-changed')
  );
  assertApiError(changed, 409, 'IDEMPOTENCY_CONFLICT');

  const duplicate = await createPointRequest(
    fixture, flow, 'client-concurrency-100-0002', {}, idempotencyKey('duplicate-signal')
  );
  assert.equal(duplicate.response.status, 201);
  assert.equal(duplicate.body.pointRequest.duplicateSuspected, true);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_requests WHERE family_id = ?
  `).get(fixture.familyId).count, 2);
});

test('退回补充后按提交快照审批，余额与唯一来源流水原子落账且不可删改', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'snapshot-approval');
  const occurredAt = new Date().toISOString();
  const created = await createPointRequest(
    fixture, flow, 'client-snapshot-approval-01', { occurredAt }
  );
  assert.equal(created.response.status, 201);
  assert.equal(created.body.pointRequest.occurredAt, occurredAt);
  const id = created.body.pointRequest.id;

  const requestInfoKey = idempotencyKey('request-info');
  const requestedInfo = await request(`/api/v2/point-requests/${id}/request-info`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: requestInfoKey,
    body: { expectedRevision: 0, note: '请补充合成任务完成情况' }
  });
  assert.equal(requestedInfo.response.status, 200);
  assert.equal(requestedInfo.body.pointRequest.status, 'needs_info');
  assert.equal(requestedInfo.body.pointRequest.revision, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 0);

  const cannotApprove = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey('approve-needs-info'),
    body: { expectedRevision: 1, approvedPoints: 8 }
  });
  assertApiError(cannotApprove, 409, 'POINT_REQUEST_STATE_CONFLICT');

  const resubmitted = await request(`/api/v2/point-requests/${id}`, {
    method: 'PATCH', bearer: flow.completed.session.accessToken,
    idempotency: idempotencyKey('resubmit'),
    body: { expectedRevision: 1, description: '已补充：合成任务完整完成' }
  });
  assert.equal(resubmitted.response.status, 200);
  assert.equal(resubmitted.body.pointRequest.status, 'pending');
  assert.equal(resubmitted.body.pointRequest.revision, 2);

  const staleRequestInfoReplay = await request(`/api/v2/point-requests/${id}/request-info`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: requestInfoKey,
    body: { expectedRevision: 0, note: '请补充合成任务完成情况' }
  });
  assertApiError(staleRequestInfoReplay, 409, 'IDEMPOTENCY_REPLAY_STALE');

  const requestedAgain = await request(`/api/v2/point-requests/${id}/request-info`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey('request-info-again'),
    body: { expectedRevision: 2, note: '请再次确认合成任务细节' }
  });
  assert.equal(requestedAgain.response.status, 200);
  assert.equal(requestedAgain.body.pointRequest.revision, 3);
  assert.equal(requestedAgain.body.pointRequest.requestInfo.resubmittedAt, null);
  const resubmittedAgain = await request(`/api/v2/point-requests/${id}`, {
    method: 'PATCH', bearer: flow.completed.session.accessToken,
    idempotency: idempotencyKey('resubmit-again'),
    body: { expectedRevision: 3, description: '再次补充：合成任务细节已确认' }
  });
  assert.equal(resubmittedAgain.response.status, 200);
  assert.equal(resubmittedAgain.body.pointRequest.revision, 4);

  const changedRules = rulesFor(fixture.suffix, {
    label: '后来改名且缩小范围的规则', min: 1, max: 3, defaultPoints: 2
  });
  repositories.config.setRules(fixture.familyId, changedRules, {
    expectedRevision: 1, updatedBy: fixture.adminId
  });

  const approveKey = idempotencyKey('approve-snapshot');
  const approved = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: approveKey,
    body: { expectedRevision: 4, approvedPoints: 8, note: '按提交时规则批准' }
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.pointRequest.status, 'approved');
  assert.equal(approved.body.pointRequest.rule.label, '完成合成任务');
  assert.equal(approved.body.pointRequest.approvedPoints, 8);
  assertMinimalResponse(approved.body);

  const account = getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id);
  assert.equal(account.balance, 8);
  const sourced = getDb().prepare(`
    SELECT * FROM transactions
    WHERE family_id = ? AND source_type = 'point_request' AND source_id = ?
  `).all(fixture.familyId, id);
  assert.equal(sourced.length, 1);
  assert.equal(sourced[0].amount, 8);
  assert.equal(sourced[0].occurred_at, occurredAt);
  assert.equal(sourced[0].reason, '完成合成任务');
  assert.equal(sourced[0].rule_id, `reward_${fixture.suffix}`);
  assert.equal(sourced[0].category_id, `cat_reward_${fixture.suffix}`);
  assert.equal(sourced[0].id, approved.body.pointRequest.decision.transactionId);

  const exactApprovalReplay = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: approveKey,
    body: { expectedRevision: 4, approvedPoints: 8, note: '按提交时规则批准' }
  });
  assert.equal(exactApprovalReplay.response.status, 200);
  assert.equal(
    exactApprovalReplay.body.pointRequest.decision.transactionId,
    approved.body.pointRequest.decision.transactionId
  );
  const conflictingApprovalReplay = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: approveKey,
    body: { expectedRevision: 4, approvedPoints: 7, note: '按提交时规则批准' }
  });
  assertApiError(conflictingApprovalReplay, 409, 'IDEMPOTENCY_CONFLICT');
  const staleApproval = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey('approve-stale-revision'),
    body: { expectedRevision: 4, approvedPoints: 8, note: '按提交时规则批准' }
  });
  assertApiError(staleApproval, 409, 'REVISION_CONFLICT');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE source_id = ?
  `).get(id).count, 1);
  assert.equal(getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance, 8);

  assert.throws(
    () => repositories.transactions.removeForGuardian(
      sourced[0].id, fixture.familyId, fixture.adminId
    ),
    /SOURCED_TRANSACTION_IMMUTABLE/
  );
  assert.throws(
    () => getDb().prepare('DELETE FROM transactions WHERE id = ?').run(sourced[0].id),
    /SOURCED_TRANSACTION_DELETE_FORBIDDEN/
  );
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE source_id = ?
  `).get(id).count, 1);
});

test('两个有效监护人使用同一 revision 审批时仅一次成功', async () => {
  const fixture = await createAuthorizedFamily();
  await addGuardianConsent(fixture, fixture.parentId, fixture.children[0]);
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'two-guardians');
  const created = await createPointRequest(fixture, flow, 'client-two-guardians-0001');
  const id = created.body.pointRequest.id;
  const before = getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance;

  const [admin, parent] = await Promise.all([
    request(`/api/v2/point-requests/${id}/approve`, {
      method: 'POST', userId: fixture.adminId,
      idempotency: idempotencyKey('approve-admin-race'),
      body: { expectedRevision: 0, approvedPoints: 7 }
    }),
    request(`/api/v2/point-requests/${id}/approve`, {
      method: 'POST', userId: fixture.parentId,
      idempotency: idempotencyKey('approve-parent-race'),
      body: { expectedRevision: 0, approvedPoints: 7 }
    })
  ]);
  const statuses = [admin.response.status, parent.response.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = admin.response.status === 409 ? admin : parent;
  assert.equal(loser.body.code, 'REVISION_CONFLICT');
  assert.equal(getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance, before + 7);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE family_id = ? AND source_type = 'point_request' AND source_id = ?
  `).get(fixture.familyId, id).count, 1);
});

test('拒绝和取消不入账，终态与陈旧 revision 稳定冲突', async () => {
  const fixture = await createAuthorizedFamily();
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'reject-cancel');
  const rejectedRequest = await createPointRequest(fixture, first, 'client-reject-00000001');
  const rejectedId = rejectedRequest.body.pointRequest.id;
  const rejectKey = idempotencyKey('reject');
  const rejected = await request(`/api/v2/point-requests/${rejectedId}/reject`, {
    method: 'POST', userId: fixture.adminId, idempotency: rejectKey,
    body: { expectedRevision: 0, note: '合成材料不足' }
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.pointRequest.status, 'rejected');
  const replay = await request(`/api/v2/point-requests/${rejectedId}/reject`, {
    method: 'POST', userId: fixture.adminId, idempotency: rejectKey,
    body: { expectedRevision: 0, note: '合成材料不足' }
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.pointRequest.revision, 1);
  const staleApprove = await request(`/api/v2/point-requests/${rejectedId}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey('approve-rejected'),
    body: { expectedRevision: 0, approvedPoints: 4 }
  });
  assertApiError(staleApprove, 409, 'REVISION_CONFLICT');

  const cancelledRequest = await createPointRequest(fixture, first, 'client-cancel-00000001');
  const cancelled = await request(
    `/api/v2/point-requests/${cancelledRequest.body.pointRequest.id}/cancel`,
    {
      method: 'POST', bearer: first.completed.session.accessToken,
      idempotency: idempotencyKey('cancel'),
      body: { expectedRevision: 0 }
    }
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.pointRequest.status, 'cancelled');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE family_id = ?
  `).get(fixture.familyId).count, 0);
  assert.equal(getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance, 0);
});

test('审批中间故障完整回滚，缺失账户不会被静默创建', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'rollback');
  const created = await createPointRequest(fixture, flow, 'client-rollback-0000001');
  const id = created.body.pointRequest.id;
  const approveKey = idempotencyKey('rollback-approve');
  getDb().exec(`
    CREATE TRIGGER synthetic_reject_point_request_ledger
    BEFORE INSERT ON transactions
    WHEN NEW.source_type = 'point_request'
    BEGIN
      SELECT RAISE(ABORT, 'SYNTHETIC_LEDGER_FAILURE');
    END;
  `);
  const failed = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId, idempotency: approveKey,
    body: { expectedRevision: 0, approvedPoints: 6 }
  });
  assertApiError(failed, 500, 'INTERNAL_ERROR');
  assert.deepEqual({ ...getDb().prepare(`
    SELECT status, revision, transaction_id FROM point_requests WHERE id = ?
  `).get(id) }, { status: 'pending', revision: 0, transaction_id: null });
  assert.equal(getDb().prepare(`
    SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(fixture.familyId, fixture.children[0].id).balance, 0);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_request_events
    WHERE point_request_id = ? AND action = 'approve'
  `).get(id).count, 0);
  getDb().exec('DROP TRIGGER synthetic_reject_point_request_ledger');

  const retried = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: fixture.adminId, idempotency: approveKey,
    body: { expectedRevision: 0, approvedPoints: 6 }
  });
  assert.equal(retried.response.status, 200);

  const incompleteFixture = await createAuthorizedFamily();
  const incompleteFlow = await fullDeviceFlow(
    incompleteFixture, incompleteFixture.children[0], 'missing-account'
  );
  const pendingBeforeAccountLoss = await createPointRequest(
    incompleteFixture, incompleteFlow, 'client-account-loss-pending-01'
  );
  assert.equal(pendingBeforeAccountLoss.response.status, 201);
  const pendingId = pendingBeforeAccountLoss.body.pointRequest.id;
  getDb().prepare(`
    DELETE FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).run(incompleteFixture.familyId, incompleteFixture.children[0].id);
  const blockedApproval = await request(`/api/v2/point-requests/${pendingId}/approve`, {
    method: 'POST', userId: incompleteFixture.adminId,
    idempotency: idempotencyKey('approve-after-account-loss'),
    body: { expectedRevision: 0, approvedPoints: 6 }
  });
  assertApiError(blockedApproval, 409, 'CHILD_DATA_INCOMPLETE');
  assert.deepEqual({ ...getDb().prepare(`
    SELECT status, revision, transaction_id FROM point_requests WHERE id = ?
  `).get(pendingId) }, { status: 'pending', revision: 0, transaction_id: null });
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_request_events
    WHERE point_request_id = ? AND action = 'approve'
  `).get(pendingId).count, 0);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE source_id = ?
  `).get(pendingId).count, 0);
  const incomplete = await createPointRequest(
    incompleteFixture, incompleteFlow, 'client-missing-account-01'
  );
  assertApiError(incomplete, 409, 'CHILD_DATA_INCOMPLETE');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_accounts WHERE family_id = ? AND kid_id = ?
  `).get(incompleteFixture.familyId, incompleteFixture.children[0].id).count, 0);
});

test('家庭、兄弟姐妹和监护授权隔离，授权撤回阻断审批并撤销设备会话', async () => {
  const family = await createAuthorizedFamily({ childCount: 2 });
  const other = await createAuthorizedFamily();
  const first = await fullDeviceFlow(family, family.children[0], 'isolation-first');
  const sibling = await fullDeviceFlow(family, family.children[1], 'isolation-sibling');
  const foreign = await fullDeviceFlow(other, other.children[0], 'isolation-foreign');
  const created = await createPointRequest(family, first, 'client-isolation-000001');
  const id = created.body.pointRequest.id;

  const siblingMine = await request('/api/v2/me/point-requests', {
    bearer: sibling.completed.session.accessToken
  });
  assert.equal(siblingMine.response.status, 200);
  assert.deepEqual(siblingMine.body.pointRequests, []);
  const foreignMine = await request('/api/v2/me/point-requests', {
    bearer: foreign.completed.session.accessToken
  });
  assert.equal(foreignMine.response.status, 200);
  assert.deepEqual(foreignMine.body.pointRequests, []);
  const noConsent = await request(`/api/v2/point-requests/${id}`, {
    userId: family.parentId
  });
  assertApiError(noConsent, 404, 'POINT_REQUEST_NOT_FOUND');
  const crossFamily = await request(`/api/v2/point-requests/${id}`, {
    userId: other.adminId
  });
  assertApiError(crossFamily, 404, 'POINT_REQUEST_NOT_FOUND');

  await addGuardianConsent(family, family.parentId, family.children[0]);
  const state = repositories.guardianConsents.getPrivacyState({
    familyId: family.familyId, childId: family.children[0].id
  });
  const reauth = await request('/api/v2/reauth-assertions', {
    method: 'POST', userId: family.adminId,
    body: { purpose: 'child_consent_withdraw', password: TEST_PASSWORD }
  });
  const withdrawn = await request(
    `/api/v2/children/${family.children[0].id}/consents/withdraw`,
    {
      method: 'POST', userId: family.adminId,
      idempotency: idempotencyKey('withdraw'),
      body: {
        expectedRevision: state.revision,
        reauthAssertion: reauth.body.reauthAssertion
      }
    }
  );
  assert.equal(withdrawn.response.status, 200);

  const revokedDevice = await request('/api/v2/me/point-requests', {
    bearer: first.completed.session.accessToken
  });
  assertApiError(revokedDevice, 401, 'SESSION_REVOKED');
  const blockedParent = await request(`/api/v2/point-requests/${id}/approve`, {
    method: 'POST', userId: family.parentId,
    idempotency: idempotencyKey('withdrawn-approve'),
    body: { expectedRevision: 0, approvedPoints: 8 }
  });
  assertApiError(blockedParent, 404, 'POINT_REQUEST_NOT_FOUND');
  assert.equal(getDb().prepare(`
    SELECT status FROM point_requests WHERE id = ?
  `).get(id).status, 'pending');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE source_id = ?
  `).get(id).count, 0);
  const blockedSummary = await request('/api/v2/family/tasks/summary', {
    userId: family.parentId
  });
  assert.equal(blockedSummary.response.status, 200);
  assert.deepEqual(blockedSummary.body.pointRequests, {
    pending: 0, needsInfo: 0, total: 0
  });
  const siblingStillWorks = await request('/api/v2/me/point-requests', {
    bearer: sibling.completed.session.accessToken
  });
  assert.equal(siblingStillWorks.response.status, 200);
});

test('只允许当前家庭鼓励规则和快照范围，严格拒绝伪造字段', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'rule-validation');
  const punish = await createPointRequest(
    fixture,
    flow,
    'client-punish-rule-00001',
    { ruleId: `punish_${fixture.suffix}`, requestedPoints: 2 }
  );
  assertApiError(punish, 400, 'RULE_REFERENCE_INVALID');
  const outOfRange = await createPointRequest(
    fixture,
    flow,
    'client-range-rule-000001',
    { requestedPoints: 11 }
  );
  assertApiError(outOfRange, 400, 'RULE_AMOUNT_OUT_OF_RANGE');
  const forgedCategory = await createPointRequest(
    fixture,
    flow,
    'client-forged-category-01',
    { categoryId: 'cat_attacker' }
  );
  assertApiError(forgedCategory, 400, 'VALIDATION_ERROR');
  const noKey = await request('/api/v2/point-requests', {
    method: 'POST', bearer: flow.completed.session.accessToken,
    body: pointRequestBody(fixture, 'client-no-idem-key-0001')
  });
  assertApiError(noKey, 400, 'IDEMPOTENCY_REQUIRED');

  const future = await createPointRequest(
    fixture,
    flow,
    'client-future-occurred-01',
    { occurredAt: new Date(Date.now() + 60 * 1000).toISOString() }
  );
  assertApiError(future, 400, 'VALIDATION_ERROR');
  assert.equal(future.body.field, 'occurredAt');
  const impossibleDate = await createPointRequest(
    fixture,
    flow,
    'client-impossible-date-001',
    { occurredAt: '2026-02-30T00:00:00Z' }
  );
  assertApiError(impossibleDate, 400, 'VALIDATION_ERROR');
  assert.equal(impossibleDate.body.field, 'occurredAt');
  const outsideSubmissionWindow = await createPointRequest(
    fixture,
    flow,
    'client-old-occurred-date-01',
    { occurredAt: previousShanghaiDayOccurredAt() }
  );
  assertApiError(outsideSubmissionWindow, 400, 'OCCURRED_AT_OUT_OF_WINDOW');
  assert.equal(outsideSubmissionWindow.body.field, 'occurredAt');

  repositories.config.setRules(fixture.familyId, rulesFor(fixture.suffix, {
    label: '允许零下界但申报必须为正', min: 0, max: 3, defaultPoints: 1
  }), { expectedRevision: 1, updatedBy: fixture.adminId });
  const zeroLowerBound = await createPointRequest(
    fixture,
    flow,
    'client-zero-lower-bound-01',
    { requestedPoints: 1 }
  );
  assert.equal(zeroLowerBound.response.status, 201);
  assert.equal(zeroLowerBound.body.pointRequest.rule.minPoints, 0);
  assert.equal(zeroLowerBound.body.pointRequest.requestedPoints, 1);
});

test('同一孩子的有效设备共享申请视图与处理权，但客户端幂等域按绑定隔离', async () => {
  const fixture = await createAuthorizedFamily();
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'same-child-first');
  const second = await fullDeviceFlow(fixture, fixture.children[0], 'same-child-second');
  const sharedClientRequestId = 'client-same-child-devices-01';
  const sharedKey = idempotencyKey('same-child-shared-key');
  const firstCreated = await createPointRequest(
    fixture, first, sharedClientRequestId, {}, sharedKey
  );
  const secondCreated = await createPointRequest(
    fixture, second, sharedClientRequestId, {}, sharedKey
  );
  assert.equal(firstCreated.response.status, 201);
  assert.equal(secondCreated.response.status, 201);
  assert.notEqual(firstCreated.body.pointRequest.id, secondCreated.body.pointRequest.id);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_requests
    WHERE family_id = ? AND child_id = ? AND client_request_id = ?
  `).get(fixture.familyId, fixture.children[0].id, sharedClientRequestId).count, 2);

  const secondView = await request('/api/v2/me/point-requests', {
    bearer: second.completed.session.accessToken
  });
  assert.equal(secondView.response.status, 200);
  assert.deepEqual(
    new Set(secondView.body.pointRequests.map(item => item.id)),
    new Set([firstCreated.body.pointRequest.id, secondCreated.body.pointRequest.id])
  );
  assert.equal(
    'clientRequestId' in secondView.body.pointRequests.find(
      item => item.id === firstCreated.body.pointRequest.id
    ),
    false
  );
  assert.equal(
    secondView.body.pointRequests.find(item => item.id === secondCreated.body.pointRequest.id)
      .clientRequestId,
    sharedClientRequestId
  );
  const crossDeviceCancel = await request(
    `/api/v2/point-requests/${firstCreated.body.pointRequest.id}/cancel`,
    {
      method: 'POST', bearer: second.completed.session.accessToken,
      idempotency: idempotencyKey('same-child-cross-device-cancel'),
      body: { expectedRevision: 0 }
    }
  );
  assert.equal(crossDeviceCancel.response.status, 200);
  assert.equal(crossDeviceCancel.body.pointRequest.status, 'cancelled');
  assert.equal('clientRequestId' in crossDeviceCancel.body.pointRequest, false);
});

test('设备与监护列表使用作用域绑定游标分页且状态变化不会越权回显', async () => {
  const fixture = await createAuthorizedFamily({ childCount: 2 });
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'cursor-first');
  const second = await fullDeviceFlow(fixture, fixture.children[0], 'cursor-second');
  const sibling = await fullDeviceFlow(fixture, fixture.children[1], 'cursor-sibling');
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    const item = await createPointRequest(
      fixture,
      first,
      `client-cursor-${String(index + 1).padStart(8, '0')}`
    );
    assert.equal(item.response.status, 201);
    created.push(item.body.pointRequest.id);
  }

  const firstDevicePage = await request('/api/v2/me/point-requests?status=pending&limit=1', {
    bearer: first.completed.session.accessToken
  });
  assert.equal(firstDevicePage.response.status, 200);
  assert.equal(firstDevicePage.body.pointRequests.length, 1);
  assert.equal(typeof firstDevicePage.body.nextCursor, 'string');
  const deviceCursor = firstDevicePage.body.nextCursor;
  const deviceIds = [firstDevicePage.body.pointRequests[0].id];
  let nextDeviceCursor = deviceCursor;
  while (nextDeviceCursor) {
    const page = await request(
      `/api/v2/me/point-requests?status=pending&limit=1&cursor=${encodeURIComponent(nextDeviceCursor)}`,
      { bearer: first.completed.session.accessToken }
    );
    assert.equal(page.response.status, 200);
    deviceIds.push(...page.body.pointRequests.map(item => item.id));
    nextDeviceCursor = page.body.nextCursor;
  }
  assert.deepEqual(new Set(deviceIds), new Set(created));
  assert.equal(deviceIds.length, new Set(deviceIds).size);

  const tamperedCursor = `${deviceCursor.slice(0, -1)}${deviceCursor.endsWith('A') ? 'B' : 'A'}`;
  for (const [bearer, status, cursor] of [
    [first.completed.session.accessToken, 'pending', tamperedCursor],
    [first.completed.session.accessToken, 'needs_info', deviceCursor],
    [second.completed.session.accessToken, 'pending', deviceCursor],
    [sibling.completed.session.accessToken, 'pending', deviceCursor]
  ]) {
    const invalid = await request(
      `/api/v2/me/point-requests?status=${status}&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { bearer }
    );
    assertApiError(invalid, 400, 'VALIDATION_ERROR');
    assert.equal(invalid.body.field, 'cursor');
  }

  const firstAdultPage = await request('/api/v2/point-requests?limit=1', {
    userId: fixture.adminId
  });
  assert.equal(firstAdultPage.response.status, 200);
  assert.equal(firstAdultPage.body.pointRequests.length, 1);
  assert.equal(typeof firstAdultPage.body.nextCursor, 'string');
  const adultCursor = firstAdultPage.body.nextCursor;
  const otherPendingId = created.find(id => id !== firstAdultPage.body.pointRequests[0].id);
  const approved = await request(`/api/v2/point-requests/${otherPendingId}/approve`, {
    method: 'POST', userId: fixture.adminId,
    idempotency: idempotencyKey('cursor-boundary-approve'),
    body: { expectedRevision: 0, approvedPoints: 8 }
  });
  assert.equal(approved.response.status, 200);

  const adultIds = [firstAdultPage.body.pointRequests[0].id];
  let nextAdultCursor = adultCursor;
  while (nextAdultCursor) {
    const page = await request(
      `/api/v2/point-requests?limit=1&cursor=${encodeURIComponent(nextAdultCursor)}`,
      { userId: fixture.adminId }
    );
    assert.equal(page.response.status, 200);
    adultIds.push(...page.body.pointRequests.map(item => item.id));
    nextAdultCursor = page.body.nextCursor;
  }
  assert.equal(adultIds.includes(otherPendingId), false);
  assert.equal(adultIds.length, 2);
  assert.equal(adultIds.length, new Set(adultIds).size);

  const otherFamily = await createAuthorizedFamily();
  for (const [userId, suffix] of [
    [fixture.adminId, '&status=needs_info'],
    [fixture.adminId, `&childId=${encodeURIComponent(fixture.children[0].id)}`],
    [fixture.parentId, ''],
    [otherFamily.adminId, '']
  ]) {
    const invalid = await request(
      `/api/v2/point-requests?limit=1&cursor=${encodeURIComponent(adultCursor)}${suffix}`,
      { userId }
    );
    assertApiError(invalid, 400, 'VALIDATION_ERROR');
    assert.equal(invalid.body.field, 'cursor');
  }
});

test('家庭待办汇总和筛选只统计当前监护人有权处理的申请', async () => {
  const fixture = await createAuthorizedFamily({ childCount: 2 });
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'tasks-first');
  const second = await fullDeviceFlow(fixture, fixture.children[1], 'tasks-second');
  const pending = await createPointRequest(fixture, first, 'client-tasks-pending-0001');
  const needsInfo = await createPointRequest(fixture, second, 'client-tasks-info-000001');
  const moved = await request(
    `/api/v2/point-requests/${needsInfo.body.pointRequest.id}/request-info`,
    {
      method: 'POST', userId: fixture.adminId,
      idempotency: idempotencyKey('tasks-request-info'),
      body: { expectedRevision: 0, note: '请补充合成说明' }
    }
  );
  assert.equal(moved.response.status, 200);

  const summary = await request('/api/v2/family/tasks/summary', {
    userId: fixture.adminId
  });
  assert.equal(summary.response.status, 200);
  assert.deepEqual(summary.body.pointRequests, { pending: 1, needsInfo: 1, total: 2 });

  const filtered = await request(
    `/api/v2/point-requests?status=needs_info&childId=${encodeURIComponent(fixture.children[1].id)}&limit=1`,
    { userId: fixture.adminId }
  );
  assert.equal(filtered.response.status, 200);
  assert.deepEqual(
    filtered.body.pointRequests.map(item => item.id),
    [needsInfo.body.pointRequest.id]
  );
  assert.equal(filtered.body.pointRequests.some(item => item.id === pending.body.pointRequest.id), false);

  const noConsentSummary = await request('/api/v2/family/tasks/summary', {
    userId: fixture.parentId
  });
  assert.equal(noConsentSummary.response.status, 200);
  assert.deepEqual(noConsentSummary.body.pointRequests, {
    pending: 0, needsInfo: 0, total: 0
  });
  const unknownQuery = await request('/api/v2/family/tasks/summary?childId=attacker', {
    userId: fixture.adminId
  });
  assertApiError(unknownQuery, 400, 'VALIDATION_ERROR');
});
