const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RealDate = global.Date;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-stage1-synthetic-e2e-'));
const dataDir = path.join(tempRoot, 'data');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.PORT = '3002';
process.env.PAIRING_CLIENT_IP_MODE = 'direct';
process.env.TRUSTED_PROXIES = '';
process.env.DATA_DIR = dataDir;
process.env.SQLITE_FILE = path.join(dataDir, 'stage1-synthetic.sqlite');
process.env.HARMONY_CHILD_ENABLED = 'true';
process.env.CHILD_ENROLLMENT_ENABLED = 'true';
process.env.DEVICE_PAIRING_ENABLED = 'true';
process.env.POINT_REQUESTS_ENABLED = 'true';
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
process.env.LEGAL_PUBLIC_ORIGIN = 'https://synthetic-stage1.invalid';
process.env.GUARDIAN_RELATION_DECLARATION_VERSION = 'synthetic-relation-v1';
process.env.GUARDIAN_RELATION_DECLARATION_SHA256 = 'e'.repeat(64);
process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL =
  `https://synthetic-stage1.invalid/legal/guardian-relation-declaration/`
  + `synthetic-relation-v1/${'e'.repeat(64)}.html`;

const { getDb, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const { hashPwd } = require('../lib/token');
const { createApp } = require('../index');

const FAMILY_A = 'family_synthetic_e2e_a';
const FAMILY_B = 'family_synthetic_e2e_b';
const ADMIN_A = 'admin_synth_e2e_a';
const ADMIN_B = 'admin_synth_e2e_b';
const SYNTHETIC_PASSWORD = 'synthetic-stage1-e2e-password';
const SYNTHETIC_RULE_ID = 'reward_synthetic_e2e';

const legalTexts = Object.freeze([
  {
    type: 'privacy_policy',
    field: 'privacyPolicy',
    slug: 'privacy-policy',
    version: 'synthetic-privacy-v1',
    sha256: 'a'.repeat(64)
  },
  {
    type: 'child_personal_information_rules',
    field: 'childPersonalInformationRules',
    slug: 'child-personal-information-rules',
    version: 'synthetic-child-rules-v1',
    sha256: 'b'.repeat(64)
  },
  {
    type: 'child_user_agreement',
    field: 'childUserAgreement',
    slug: 'child-user-agreement',
    version: 'synthetic-child-agreement-v1',
    sha256: 'c'.repeat(64)
  },
  {
    type: 'sensitive_information_notice',
    field: 'sensitiveInformationNotice',
    slug: 'sensitive-information-notice',
    version: 'synthetic-sensitive-v1',
    sha256: 'd'.repeat(64)
  }
]);

let server;
let baseUrl = '';
let clockOverridden = false;

async function startServer() {
  server = await new Promise((resolve, reject) => {
    const listening = createApp().listen(0, '127.0.0.1');
    listening.once('listening', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'loopback listener must expose an address');
  assert.equal(address.address, '127.0.0.1');
  assert.ok(Number.isInteger(address.port) && address.port > 0, 'loopback port must be ephemeral');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  const listening = server;
  server = undefined;
  baseUrl = '';
  await new Promise(resolve => listening.close(resolve));
}

function requestOptions({ method = 'GET', bearer = '', idempotencyKey = '', body } = {}) {
  return {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, requestOptions(options));
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      assert.fail('synthetic API returned a non-JSON response');
    }
  }
  return { status: response.status, headers: response.headers, body };
}

async function requestAndDiscard(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, requestOptions(options));
  await response.arrayBuffer();
  return response.status;
}

function idempotencyKey(label) {
  return `s9-${label}-${crypto.randomBytes(16).toString('base64url')}`;
}

function assertApiError(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.message, 'string');
}

function requireNonemptyString(value, message) {
  assert.ok(typeof value === 'string' && value.length > 0, message);
  return value;
}

function seedSyntheticDatabase() {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const password = hashPwd(SYNTHETIC_PASSWORD);
  for (const family of [
    { id: FAMILY_A, name: '合成端到端家庭 A' },
    { id: FAMILY_B, name: '合成端到端家庭 B' }
  ]) {
    repositories.families.ensureDefault({ ...family, createdAt });
  }
  repositories.users.insert({
    id: ADMIN_A,
    name: '合成管理员 A',
    role: 'admin',
    password,
    familyId: FAMILY_A
  });
  repositories.users.insert({
    id: ADMIN_B,
    name: '合成管理员 B',
    role: 'admin',
    password,
    familyId: FAMILY_B
  });

  const insert = getDb().prepare(`
    INSERT INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  legalTexts.forEach((text, index) => {
    const timestamp = `2026-01-01T00:0${index}:00.000Z`;
    insert.run(
      text.type,
      text.version,
      text.sha256,
      `${process.env.LEGAL_PUBLIC_ORIGIN}/legal/${text.slug}/${text.version}/${text.sha256}.html`,
      timestamp,
      timestamp
    );
  });
}

function useFixedClock(epochMs) {
  global.Date = class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(epochMs);
      else super(...args);
    }

    static now() {
      return epochMs;
    }
  };
  clockOverridden = true;
}

function restoreClock() {
  if (!clockOverridden) return;
  global.Date = RealDate;
  clockOverridden = false;
}

async function login(userId) {
  const result = await requestJson('/api/auth', {
    method: 'POST',
    body: { userId, password: SYNTHETIC_PASSWORD }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  return requireNonemptyString(result.body.token, 'adult login must return a bearer');
}

function syntheticRules() {
  return {
    reward: [{
      id: 'category_synthetic_e2e',
      category: '合成端到端鼓励',
      items: [{
        id: SYNTHETIC_RULE_ID,
        label: '完成合成端到端任务',
        min: 1,
        max: 8,
        default: 4,
        unit: '每次',
        hint: '仅用于临时数据库自动化测试'
      }]
    }],
    punish: [],
    special: [],
    revision: 0
  };
}

function enrollmentBody(legal, reauthAssertion) {
  const consents = {};
  for (const text of legalTexts) {
    const evidence = legal.body.texts[text.field];
    assert.ok(evidence && typeof evidence === 'object', 'legal evidence must be present');
    consents[text.field] = {
      accepted: true,
      version: evidence.version,
      sha256: evidence.sha256
    };
  }
  return {
    alias: '合成端到端孩子',
    reauthAssertion,
    guardianRelation: 'legal_guardian',
    relationDeclaration: {
      accepted: true,
      version: legal.body.guardianRelationDeclaration.version,
      sha256: legal.body.guardianRelationDeclaration.sha256
    },
    consents
  };
}

function createDeviceKey() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicId: `device_${crypto.randomBytes(16).toString('base64url')}`,
    publicKey: {
      algorithm: 'ECDSA_P256_SHA256',
      spkiBase64url: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    }
  };
}

function signProof(proof, privateKey) {
  return crypto.sign(
    'sha256',
    Buffer.from(proof.signingPayload, 'base64url'),
    privateKey
  ).toString('base64url');
}

function sameSecret(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

after(async () => {
  restoreClock();
  await stopServer();
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('loopback synthetic stage 1 flow survives replay and enforces revocation isolation', async () => {
  seedSyntheticDatabase();
  await startServer();

  // Issue the first device session eleven minutes in the past. Once the real
  // clock is restored, its Access credential is inside the production refresh
  // eligibility window without changing immutable session evidence.
  useFixedClock(RealDate.now() - 11 * 60 * 1000);
  let adultToken;
  let foreignAdultToken;
  let child;
  let device;
  let completed;
  try {
    adultToken = await login(ADMIN_A);
    foreignAdultToken = await login(ADMIN_B);

    const legal = await requestJson('/api/v2/legal-texts/current');
    assert.equal(legal.status, 200);
    assert.equal(legal.body.success, true);

    const enrollmentReauth = await requestJson('/api/v2/reauth-assertions', {
      method: 'POST',
      bearer: adultToken,
      body: { purpose: 'child_enrollment', password: SYNTHETIC_PASSWORD }
    });
    assert.equal(enrollmentReauth.status, 200);
    const enrollment = await requestJson('/api/v2/child-enrollments', {
      method: 'POST',
      bearer: adultToken,
      idempotencyKey: idempotencyKey('enrollment'),
      body: enrollmentBody(
        legal,
        requireNonemptyString(
          enrollmentReauth.body.reauthAssertion,
          'enrollment reauthentication must return an assertion'
        )
      )
    });
    assert.equal(enrollment.status, 201);
    assert.equal(enrollment.body.privacyState.status, 'active');
    child = {
      id: requireNonemptyString(enrollment.body.child.id, 'enrollment must create a child'),
      privacyRevision: enrollment.body.privacyState.revision
    };

    const savedRules = await requestJson('/api/config/rules', {
      method: 'POST',
      bearer: adultToken,
      body: { rules: syntheticRules() }
    });
    assert.equal(savedRules.status, 200);
    assert.equal(savedRules.body.revision, 1);

    device = createDeviceKey();
    const pairing = await requestJson('/api/v2/device-pairings', {
      method: 'POST',
      bearer: adultToken,
      idempotencyKey: idempotencyKey('pairing-create'),
      body: { childId: child.id }
    });
    assert.equal(pairing.status, 201);
    const shortCode = requireNonemptyString(pairing.body.shortCode, 'pairing must issue a short code');
    const pairingChallenge = requireNonemptyString(
      pairing.body.pairingChallenge,
      'pairing must issue a guardian challenge'
    );
    const pairingId = requireNonemptyString(pairing.body.pairing.id, 'pairing must have an id');

    const claimed = await requestJson('/api/v2/device-pairings/claim-by-code', {
      method: 'POST',
      idempotencyKey: idempotencyKey('pairing-claim'),
      body: {
        shortCode,
        devicePublicId: device.publicId,
        deviceAlias: '合成受控设备',
        publicKey: device.publicKey
      }
    });
    assert.equal(claimed.status, 202);
    const claimBearer = requireNonemptyString(claimed.body.claimId, 'claim must issue a bearer');

    const currentPairing = await requestJson(`/api/v2/device-pairings/${pairingId}`, {
      bearer: adultToken
    });
    assert.equal(currentPairing.status, 200);
    assert.equal(currentPairing.body.pairing.status, 'claimed');

    const confirmed = await requestJson(`/api/v2/device-pairings/${pairingId}/confirm`, {
      method: 'POST',
      bearer: adultToken,
      idempotencyKey: idempotencyKey('pairing-confirm'),
      body: {
        expectedRevision: currentPairing.body.pairing.revision,
        pairingChallenge
      }
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.pairing.status, 'confirmed');

    completed = await requestJson('/api/v2/device-pairings/claim/complete', {
      method: 'POST',
      bearer: claimBearer,
      idempotencyKey: idempotencyKey('pairing-complete'),
      body: { signatureBase64url: signProof(claimed.body.proof, device.privateKey) }
    });
    assert.equal(completed.status, 201);
    assert.equal(completed.body.device.status, 'active');
    assert.ok(/^tg_access\.[A-Za-z0-9_-]{43}$/.test(completed.body.session.accessToken),
      'completion must issue an Access credential');
    assert.ok(/^tg_refresh\.[A-Za-z0-9_-]{43}$/.test(completed.body.session.refreshToken),
      'completion must issue a Refresh credential');
  } finally {
    restoreClock();
  }

  const accessToken = completed.body.session.accessToken;
  const refreshToken = completed.body.session.refreshToken;
  const bindingId = completed.body.device.id;

  const initialSummary = await requestJson('/api/v2/me/summary', { bearer: accessToken });
  assert.equal(initialSummary.status, 200);
  assert.equal(initialSummary.body.points.balance, 0);

  const rewardRules = await requestJson('/api/v2/me/reward-rules', { bearer: accessToken });
  assert.equal(rewardRules.status, 200);
  assert.equal(rewardRules.body.revision, 1);
  assert.equal(rewardRules.body.rewardRules.length, 1);
  assert.equal(rewardRules.body.rewardRules[0].id, SYNTHETIC_RULE_ID);
  assert.match(rewardRules.headers.get('cache-control'), /no-store/);

  const pointKey = idempotencyKey('point-create-response-lost');
  const pointBody = {
    clientRequestId: 'hmos-point-client-synthetic-e2e-0001',
    ruleId: SYNTHETIC_RULE_ID,
    requestedPoints: 4,
    description: '合成端到端申报正文'
  };
  const droppedStatus = await requestAndDiscard('/api/v2/point-requests', {
    method: 'POST', bearer: accessToken, idempotencyKey: pointKey, body: pointBody
  });
  assert.equal(droppedStatus, 201);

  // Restart only the loopback listener. The temporary SQLite database remains
  // the source of truth, so the original body and key must recover one result.
  await stopServer();
  await startServer();
  const recovered = await requestJson('/api/v2/point-requests', {
    method: 'POST', bearer: accessToken, idempotencyKey: pointKey, body: pointBody
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.pointRequest.status, 'pending');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM point_requests
    WHERE family_id = ? AND child_id = ? AND client_request_id = ?
  `).get(FAMILY_A, child.id, pointBody.clientRequestId).count, 1);
  const pointRequestId = requireNonemptyString(
    recovered.body.pointRequest.id,
    'point recovery must return the durable request'
  );

  const foreignList = await requestJson('/api/v2/point-requests', {
    bearer: foreignAdultToken
  });
  assert.equal(foreignList.status, 200);
  assert.equal(foreignList.body.pointRequests.length, 0);
  const foreignDetail = await requestJson(`/api/v2/point-requests/${pointRequestId}`, {
    bearer: foreignAdultToken
  });
  assertApiError(foreignDetail, 404, 'POINT_REQUEST_NOT_FOUND');
  const foreignApproval = await requestJson(
    `/api/v2/point-requests/${pointRequestId}/approve`,
    {
      method: 'POST',
      bearer: foreignAdultToken,
      idempotencyKey: idempotencyKey('foreign-approval'),
      body: { expectedRevision: 0, approvedPoints: 4 }
    }
  );
  assertApiError(foreignApproval, 404, 'POINT_REQUEST_NOT_FOUND');

  const adultPending = await requestJson('/api/v2/point-requests', { bearer: adultToken });
  assert.equal(adultPending.status, 200);
  assert.equal(adultPending.body.pointRequests.length, 1);
  const approved = await requestJson(`/api/v2/point-requests/${pointRequestId}/approve`, {
    method: 'POST',
    bearer: adultToken,
    idempotencyKey: idempotencyKey('owner-approval'),
    body: { expectedRevision: 0, approvedPoints: 4 }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.pointRequest.status, 'approved');
  assert.equal(approved.body.pointRequest.approvedPoints, 4);

  const mine = await requestJson('/api/v2/me/point-requests', { bearer: accessToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.pointRequests.length, 1);
  assert.equal(mine.body.pointRequests[0].status, 'approved');
  const credited = await requestJson('/api/v2/me/summary', { bearer: accessToken });
  assert.equal(credited.status, 200);
  assert.equal(credited.body.points.balance, 4);
  const transactions = await requestJson('/api/v2/me/transactions', { bearer: accessToken });
  assert.equal(transactions.status, 200);
  assert.equal(transactions.body.transactions.length, 1);
  assert.equal(transactions.body.transactions[0].amount, 4);

  const refreshChallenge = await requestJson(
    `/api/v2/devices/${bindingId}/session-challenges`,
    {
      method: 'POST',
      bearer: refreshToken,
      idempotencyKey: idempotencyKey('refresh-challenge')
    }
  );
  assert.equal(refreshChallenge.status, 201);
  const refreshBody = {
    challengeId: refreshChallenge.body.proof.challengeId,
    signatureBase64url: signProof(refreshChallenge.body.proof, device.privateKey)
  };
  const refreshKey = idempotencyKey('refresh-complete');
  const refreshed = await requestJson('/api/v2/device-sessions/refresh', {
    method: 'POST', bearer: refreshToken, idempotencyKey: refreshKey, body: refreshBody
  });
  assert.equal(refreshed.status, 201);
  assert.equal(refreshed.body.session.rotationCounter, 1);
  const refreshReplay = await requestJson('/api/v2/device-sessions/refresh', {
    method: 'POST', bearer: refreshToken, idempotencyKey: refreshKey, body: refreshBody
  });
  assert.equal(refreshReplay.status, 200);
  assert.ok(sameSecret(
    refreshed.body.session.accessToken,
    refreshReplay.body.session.accessToken
  ), 'refresh replay must recover the same Access credential');
  assert.ok(sameSecret(
    refreshed.body.session.refreshToken,
    refreshReplay.body.session.refreshToken
  ), 'refresh replay must recover the same Refresh credential');

  const oldAccess = await requestJson('/api/v2/me/summary', { bearer: accessToken });
  assertApiError(oldAccess, 401, 'SESSION_REVOKED');
  const nextAccess = refreshed.body.session.accessToken;
  const nextRefresh = refreshed.body.session.refreshToken;
  const refreshedSummary = await requestJson('/api/v2/me/summary', { bearer: nextAccess });
  assert.equal(refreshedSummary.status, 200);
  assert.equal(refreshedSummary.body.points.balance, 4);

  const withdrawReauth = await requestJson('/api/v2/reauth-assertions', {
    method: 'POST',
    bearer: adultToken,
    body: { purpose: 'child_consent_withdraw', password: SYNTHETIC_PASSWORD }
  });
  assert.equal(withdrawReauth.status, 200);
  const withdrawn = await requestJson(`/api/v2/children/${child.id}/consents/withdraw`, {
    method: 'POST',
    bearer: adultToken,
    idempotencyKey: idempotencyKey('consent-withdraw'),
    body: {
      reauthAssertion: requireNonemptyString(
        withdrawReauth.body.reauthAssertion,
        'withdrawal reauthentication must return an assertion'
      ),
      expectedRevision: child.privacyRevision
    }
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.privacyState.status, 'processing_blocked');

  const revokedAccess = await requestJson('/api/v2/me/summary', { bearer: nextAccess });
  assertApiError(revokedAccess, 401, 'SESSION_REVOKED');
  const revokedRefresh = await requestJson(
    `/api/v2/devices/${bindingId}/session-challenges`,
    {
      method: 'POST',
      bearer: nextRefresh,
      idempotencyKey: idempotencyKey('revoked-refresh')
    }
  );
  assertApiError(revokedRefresh, 401, 'SESSION_REVOKED');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM device_sessions
    WHERE family_id = ? AND status = 'active'
  `).get(FAMILY_A).count, 0);
});
