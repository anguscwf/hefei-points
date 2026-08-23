const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-device-sessions-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'device-pairing-sessions.sqlite');
process.env.HARMONY_CHILD_ENABLED = 'true';
process.env.CHILD_ENROLLMENT_ENABLED = 'true';
process.env.DEVICE_PAIRING_ENABLED = 'true';
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
process.env.GUARDIAN_RELATION_DECLARATION_VERSION = 'guardian-relation-v1';
process.env.GUARDIAN_RELATION_DECLARATION_SHA256 = 'e'.repeat(64);
process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL = 'https://example.invalid/guardian-relation';

const { getDb, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');
const credentials = require('../lib/device-credentials');
const sessionConfig = require('../config/device-sessions');
const { requireDeviceV2 } = require('../lib/v2-auth');
const deviceService = require('../services/device-pairing-sessions');

const TEST_PASSWORD = 'synthetic-device-password';
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

async function restartServer() {
  await stopServer();
  await startServer();
}

function authHeaders(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

function idempotencyKey(label) {
  requestSequence += 1;
  return `device-${label}-${String(requestSequence).padStart(4, '0')}-${crypto.randomBytes(8).toString('hex')}`;
}

async function request(pathname, {
  method = 'GET', userId, bearer, idempotency, headers = {}, body
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
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    assert.fail(`expected JSON response, received ${response.status}: ${text}\n${error.message}`);
  }
  return { response, body: parsed };
}

function assertApiError(result, status, code, secrets = []) {
  assert.equal(result.response.status, status);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.message, 'string');
  assertNoSensitiveResponse(result.body, secrets);
}

function assertNoSensitiveResponse(body, secrets = []) {
  const serialized = JSON.stringify(body);
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(serialized.includes(secret), false, `response leaked ${secret.slice(0, 12)}`);
  }
  for (const field of [
    'shortCodeHmac', 'parentChallengeHash', 'claimTokenHash',
    'accessTokenHash', 'refreshTokenHash', 'devicePublicKeySpki'
  ]) {
    assert.equal(serialized.includes(`\"${field}\"`), false, `response leaked ${field}`);
  }
}

function enrollmentBody(reauthAssertion, alias) {
  return {
    alias,
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

async function createAuthorizedFamily({ childCount = 1 } = {}) {
  enableAllGates();
  ensureLegalTexts();
  const suffix = String(++fixtureSequence).padStart(3, '0');
  const familyId = `family_device_${suffix}`;
  const adminId = `admin_device_${suffix}`;
  const parentId = `parent_device_${suffix}`;
  repositories.families.ensureDefault({
    id: familyId,
    name: `合成设备家庭 ${suffix}`,
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
      method: 'POST',
      userId: adminId,
      body: { purpose: 'child_enrollment', password: TEST_PASSWORD }
    });
    assert.equal(reauth.response.status, 200);
    const enrolled = await request('/api/v2/child-enrollments', {
      method: 'POST',
      userId: adminId,
      idempotency: idempotencyKey(`enroll-${suffix}-${index}`),
      body: enrollmentBody(reauth.body.reauthAssertion, `合成设备孩子 ${suffix}-${index + 1}`)
    });
    assert.equal(enrolled.response.status, 201);
    children.push({
      id: enrolled.body.child.id,
      consent: enrolled.body.consent,
      privacyState: enrolled.body.privacyState
    });
  }
  return { suffix, familyId, adminId, parentId, children };
}

function createDevice(label = 'synthetic') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });
  return {
    publicId: `device_${crypto.randomBytes(16).toString('base64url')}`,
    alias: `合成设备-${label}`,
    publicKey: {
      algorithm: 'ECDSA_P256_SHA256',
      spkiBase64url: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    },
    privateKey
  };
}

function signProof(proof, privateKey) {
  return crypto.sign(
    'sha256',
    Buffer.from(proof.signingPayload, 'base64url'),
    privateKey
  ).toString('base64url');
}

async function createPairing(fixture, child = fixture.children[0], key = idempotencyKey('pair-create')) {
  const result = await request('/api/v2/device-pairings', {
    method: 'POST', userId: fixture.adminId, idempotency: key,
    body: { childId: child.id }
  });
  assert.equal(result.response.status, 201);
  assert.match(result.body.shortCode, /^\d{6}$/);
  assert.match(result.body.pairingChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.body.pairing.status, 'pending');
  return { ...result.body, idempotency: key };
}

async function claimPairing(created, device, key = idempotencyKey('pair-claim')) {
  const body = {
    shortCode: created.shortCode,
    devicePublicId: device.publicId,
    deviceAlias: device.alias,
    publicKey: device.publicKey
  };
  const result = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: key, body
  });
  assert.equal(result.response.status, 202);
  assert.match(result.body.claimId, /^tg_claim\.[A-Za-z0-9_-]{43}$/);
  assert.equal(result.body.proof.algorithm, 'ECDSA_P256_SHA256');
  assert.equal(typeof result.body.proof.signingPayload, 'string');
  return { ...result.body, requestBody: body, idempotency: key };
}

async function confirmClaim(fixture, created, claimed, key = idempotencyKey('pair-confirm')) {
  const current = await request(`/api/v2/device-pairings/${created.pairing.id}`, {
    userId: fixture.adminId
  });
  assert.equal(current.response.status, 200);
  assert.equal(current.body.pairing.status, 'claimed');
  const body = {
    expectedRevision: current.body.pairing.revision,
    pairingChallenge: created.pairingChallenge
  };
  const result = await request(`/api/v2/device-pairings/${created.pairing.id}/confirm`, {
    method: 'POST', userId: fixture.adminId, idempotency: key, body
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.pairing.status, 'confirmed');
  return { ...result.body, requestBody: body, idempotency: key, claim: claimed };
}

async function completeClaim(claimed, device, key = idempotencyKey('pair-complete')) {
  const body = { signatureBase64url: signProof(claimed.proof, device.privateKey) };
  const result = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: key, body
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.device.status, 'active');
  assert.match(result.body.session.accessToken, /^tg_access\./);
  assert.match(result.body.session.refreshToken, /^tg_refresh\./);
  return { ...result.body, requestBody: body, idempotency: key, claim: claimed };
}

async function fullDeviceFlow(fixture, child = fixture.children[0], label = fixture.suffix) {
  const device = createDevice(label);
  const created = await createPairing(fixture, child);
  const claimed = await claimPairing(created, device);
  await confirmClaim(fixture, created, claimed);
  const completed = await completeClaim(claimed, device);
  return { device, created, claimed, completed };
}

function refreshEligibleAt(session, offsetMs = 0) {
  return new Date(
    Date.parse(session.accessExpiresAt) - sessionConfig.refreshEligibilityWindowMs + offsetMs
  );
}

function deviceRequest(accessToken) {
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

function assertDeviceAuthError(accessToken, code) {
  assert.throws(
    () => requireDeviceV2(deviceRequest(accessToken)),
    error => error && error.code === code
  );
}

before(startServer);

after(async () => {
  enableAllGates();
  await stopServer();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('设备配对要求 Harmony 与 device 双门，且不会开启 legacy 儿童入口', async () => {
  const fixture = await createAuthorizedFamily();
  const combinations = [
    { harmony: 'false', device: 'true' },
    { harmony: 'true', device: 'false' }
  ];
  for (const [index, gates] of combinations.entries()) {
    process.env.HARMONY_CHILD_ENABLED = gates.harmony;
    process.env.DEVICE_PAIRING_ENABLED = gates.device;
    const blocked = await request('/api/v2/device-pairings', {
      method: 'POST', userId: fixture.adminId,
      idempotency: idempotencyKey(`gate-${index}`),
      body: { childId: fixture.children[0].id }
    });
    assertApiError(blocked, 403, 'FEATURE_DISABLED');
  }
  assert.equal(process.env.LEGACY_CHILD_LOGIN_ENABLED, 'false');
  assert.equal(process.env.LEGACY_CHILD_MANAGEMENT_ENABLED, 'false');

  enableAllGates();
  const created = await createPairing(fixture);
  assert.equal(created.pairing.childId, fixture.children[0].id);
});

test('完整配对只持久化摘要，幂等重放不增行且设备 Access 固定作用域', async () => {
  const fixture = await createAuthorizedFamily();
  const createKey = idempotencyKey('hash-create');
  const created = await createPairing(fixture, fixture.children[0], createKey);
  const createReplay = await request('/api/v2/device-pairings', {
    method: 'POST', userId: fixture.adminId, idempotency: createKey,
    body: { childId: fixture.children[0].id }
  });
  assert.equal(createReplay.response.status, 200);
  assert.equal(createReplay.body.shortCode, created.shortCode);
  assert.equal(createReplay.body.pairingChallenge, created.pairingChallenge);
  assert.equal(createReplay.body.pairing.id, created.pairing.id);

  const device = createDevice('hashes');
  const claimKey = idempotencyKey('hash-claim');
  const claimed = await claimPairing(created, device, claimKey);
  const claimReplay = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: claimKey, body: claimed.requestBody
  });
  assert.equal(claimReplay.response.status, 200);
  assert.equal(claimReplay.body.claimId, claimed.claimId);
  assert.deepEqual(claimReplay.body.proof, claimed.proof);

  await confirmClaim(fixture, created, claimed);
  const completeKey = idempotencyKey('hash-complete');
  const completed = await completeClaim(claimed, device, completeKey);
  const completeReplay = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: completeKey,
    body: completed.requestBody
  });
  assert.equal(completeReplay.response.status, 200);
  assert.deepEqual(completeReplay.body.session, completed.session);

  const pairing = getDb().prepare(`
    SELECT parent_challenge_hash, short_code_hmac, claim_token_hash,
           claim_idempotency_key_hash, claim_request_fingerprint, status
    FROM pairing_challenges WHERE id = ?
  `).get(created.pairing.id);
  assert.equal(pairing.status, 'completed');
  for (const value of [
    pairing.parent_challenge_hash, pairing.short_code_hmac, pairing.claim_token_hash,
    pairing.claim_idempotency_key_hash, pairing.claim_request_fingerprint
  ]) assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(pairing.parent_challenge_hash,
    credentials.sha256(Buffer.from(created.pairingChallenge, 'utf8')));
  assert.equal(pairing.short_code_hmac, credentials.shortCodeHmac(created.shortCode));
  assert.equal(pairing.claim_token_hash, credentials.digestCredential(claimed.claimId));
  assert.notEqual(pairing.parent_challenge_hash, created.pairingChallenge);
  assert.notEqual(pairing.short_code_hmac, created.shortCode);
  assert.notEqual(pairing.claim_token_hash, claimed.claimId);

  const storedSession = getDb().prepare(`
    SELECT access_token_hash, refresh_token_hash, status, rotation_counter
    FROM device_sessions WHERE id = ?
  `).get(completed.session.id);
  assert.deepEqual({ status: storedSession.status, rotation: storedSession.rotation_counter }, {
    status: 'active', rotation: 0
  });
  assert.match(storedSession.access_token_hash, /^[0-9a-f]{64}$/);
  assert.match(storedSession.refresh_token_hash, /^[0-9a-f]{64}$/);
  assert.equal(storedSession.access_token_hash,
    credentials.digestCredential(completed.session.accessToken));
  assert.equal(storedSession.refresh_token_hash,
    credentials.digestCredential(completed.session.refreshToken));
  assert.notEqual(storedSession.access_token_hash, completed.session.accessToken);
  assert.notEqual(storedSession.refresh_token_hash, completed.session.refreshToken);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM device_bindings WHERE pairing_challenge_id = ?')
    .get(created.pairing.id).count, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM device_sessions WHERE device_binding_id = ?')
    .get(completed.device.id).count, 1);

  const context = requireDeviceV2(deviceRequest(completed.session.accessToken));
  assert.deepEqual(context, {
    role: 'device',
    familyId: fixture.familyId,
    childId: fixture.children[0].id,
    deviceBindingId: completed.device.id,
    sessionId: completed.session.id,
    tokenFamilyId: context.tokenFamilyId,
    rotationCounter: 0
  });

  const listed = await request('/api/v2/devices', { userId: fixture.adminId });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.devices.some(item => item.id === completed.device.id), true);
  assertNoSensitiveResponse(listed.body, [
    created.shortCode, created.pairingChallenge, claimed.claimId,
    completed.session.accessToken, completed.session.refreshToken
  ]);
});

test('claim、Refresh 与 Access 都严格只接受 Bearer，不读取 query 或 body 凭据', async () => {
  const fixture = await createAuthorizedFamily();
  const device = createDevice('bearer');
  const created = await createPairing(fixture);
  const claimed = await claimPairing(created, device);
  await confirmClaim(fixture, created, claimed);
  const signature = signProof(claimed.proof, device.privateKey);

  for (const attempt of [
    request(`/api/v2/device-pairings/claim/complete?token=${encodeURIComponent(claimed.claimId)}`, {
      method: 'POST', idempotency: idempotencyKey('claim-query'),
      body: { signatureBase64url: signature }
    }),
    request('/api/v2/device-pairings/claim/complete', {
      method: 'POST', idempotency: idempotencyKey('claim-body'),
      body: { signatureBase64url: signature, claimId: claimed.claimId }
    })
  ]) {
    assertApiError(await attempt, 401, 'AUTH_REQUIRED', [claimed.claimId, signature]);
  }

  const completed = await completeClaim(claimed, device);
  assert.throws(
    () => requireDeviceV2({
      headers: {},
      query: { token: completed.session.accessToken },
      body: { token: completed.session.accessToken }
    }),
    error => error && error.code === 'AUTH_REQUIRED'
  );
  assert.equal(requireDeviceV2(deviceRequest(completed.session.accessToken)).childId,
    fixture.children[0].id);

  for (const attempt of [
    request(`/api/v2/devices/${completed.device.id}/session-challenges?token=${encodeURIComponent(completed.session.refreshToken)}`, {
      method: 'POST', idempotency: idempotencyKey('refresh-query')
    }),
    request(`/api/v2/devices/${completed.device.id}/session-challenges`, {
      method: 'POST', idempotency: idempotencyKey('refresh-body'),
      body: { refreshToken: completed.session.refreshToken }
    })
  ]) {
    assertApiError(await attempt, 401, 'AUTH_REQUIRED', [completed.session.refreshToken]);
  }
});

test('设备 Access 对畸形、未知与过期凭据返回稳定错误码', async () => {
  const fixture = await createAuthorizedFamily();
  const { completed } = await fullDeviceFlow(fixture, fixture.children[0], 'access-errors');
  assert.throws(
    () => requireDeviceV2(deviceRequest('not-a-device-token')),
    error => error && error.code === 'AUTH_REQUIRED'
  );
  assert.throws(
    () => requireDeviceV2(deviceRequest(`tg_access.${crypto.randomBytes(32).toString('base64url')}`)),
    error => error && error.code === 'SESSION_REVOKED'
  );
  assert.throws(
    () => requireDeviceV2(
      deviceRequest(completed.session.accessToken),
      new Date(Date.parse(completed.session.accessExpiresAt) + 1)
    ),
    error => error && error.code === 'ACCESS_TOKEN_EXPIRED'
  );
});

test('错误短码按设备持久计数并跨服务重启锁定，过期短码稳定返回 PAIRING_EXPIRED', async () => {
  const fixture = await createAuthorizedFamily();
  const created = await createPairing(fixture);
  const device = createDevice('lock');
  let wrongCode;
  for (let number = 0; number < 1_000_000; number += 1) {
    const candidate = String(number).padStart(6, '0');
    if (candidate === created.shortCode) continue;
    const existing = repositories.deviceSessions.findPairingByCodeHash({
      shortCodeHmac: credentials.shortCodeHmac(candidate)
    });
    if (!existing) {
      wrongCode = candidate;
      break;
    }
  }
  assert.ok(wrongCode);
  const wrongBody = {
    shortCode: wrongCode,
    devicePublicId: device.publicId,
    deviceAlias: device.alias,
    publicKey: device.publicKey
  };

  for (let attempt = 1; attempt < sessionConfig.deviceAttemptLimit; attempt += 1) {
    const failed = await request('/api/v2/device-pairings/claim-by-code', {
      method: 'POST', idempotency: idempotencyKey(`wrong-${attempt}`), body: wrongBody
    });
    assertApiError(failed, 404, 'PAIRING_CODE_INVALID', [wrongCode]);
  }
  closeDb();
  await restartServer();
  const locked = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: idempotencyKey('wrong-lock'), body: wrongBody
  });
  assertApiError(locked, 423, 'PAIRING_LOCKED', [wrongCode]);
  const correctAfterLock = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: idempotencyKey('correct-after-lock'),
    body: { ...wrongBody, shortCode: created.shortCode }
  });
  assertApiError(correctAfterLock, 423, 'PAIRING_LOCKED', [created.shortCode]);
  const deviceWindow = getDb().prepare(`
    SELECT subject_hmac, attempt_count, locked_until
    FROM pairing_claim_attempt_windows WHERE scope = 'device'
    ORDER BY updated_at DESC LIMIT 1
  `).get();
  assert.match(deviceWindow.subject_hmac, /^[0-9a-f]{64}$/);
  assert.equal(deviceWindow.attempt_count, sessionConfig.deviceAttemptLimit);
  assert.ok(deviceWindow.locked_until);

  const expiredId = `pair_${crypto.randomUUID().replace(/-/g, '')}`;
  const expiredCode = credentials.deriveShortCode(expiredId);
  const now = Date.now();
  repositories.deviceSessions.createPairing({
    id: expiredId,
    familyId: fixture.familyId,
    childId: fixture.children[0].id,
    issuedByGuardianId: fixture.adminId,
    guardianConsentId: fixture.children[0].consent.id,
    parentChallengeHash: credentials.sha256(Buffer.from(credentials.deriveParentChallenge(expiredId))),
    shortCodeHmac: credentials.shortCodeHmac(expiredCode),
    attemptLimit: sessionConfig.deviceAttemptLimit,
    createdAt: new Date(now - 20 * 60_000).toISOString(),
    updatedAt: new Date(now - 20 * 60_000).toISOString(),
    expiresAt: new Date(now - 10 * 60_000).toISOString()
  });
  const freshDevice = createDevice('expired');
  const expiredKey = idempotencyKey('expired');
  const expiredBody = {
    shortCode: expiredCode,
    devicePublicId: freshDevice.publicId,
    deviceAlias: freshDevice.alias,
    publicKey: freshDevice.publicKey
  };
  const expired = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: expiredKey, body: expiredBody
  });
  assertApiError(expired, 410, 'PAIRING_EXPIRED', [expiredCode]);
  const expiredReplay = await request('/api/v2/device-pairings/claim-by-code', {
    method: 'POST', idempotency: expiredKey, body: expiredBody
  });
  assertApiError(expiredReplay, 410, 'PAIRING_EXPIRED', [expiredCode]);
  assert.equal(repositories.deviceSessions.findPairingById({ pairingId: expiredId }).status, 'expired');
});

test('claim 精确重试在 proof 过期并级联取消后保持 CHALLENGE_EXPIRED', async () => {
  const fixture = await createAuthorizedFamily();
  const created = await createPairing(fixture);
  const device = createDevice('claim-expiry');
  const claimed = await claimPairing(created, device);
  const replayInput = {
    body: claimed.requestBody,
    idempotencyKey: claimed.idempotency,
    networkKey: 'synthetic-claim-expiry',
    now: new Date(Date.parse(claimed.proof.expiresAt) + 1)
  };
  for (let replay = 0; replay < 2; replay += 1) {
    assert.throws(
      () => deviceService.claimPairing(replayInput),
      error => error && error.code === 'CHALLENGE_EXPIRED'
    );
  }
  assert.equal(repositories.deviceSessions.findPairingById({
    pairingId: created.pairing.id
  }).status, 'cancelled');
  assert.equal(repositories.deviceSessions.findBindingByPairingId({
    pairingId: created.pairing.id
  }).status, 'revoked');
});

test('跨家庭和同家庭无授权成人都不能创建、查看或确认设备配对', async () => {
  const familyA = await createAuthorizedFamily();
  const familyB = await createAuthorizedFamily();

  const noConsent = await request('/api/v2/device-pairings', {
    method: 'POST', userId: familyA.parentId, idempotency: idempotencyKey('no-consent'),
    body: { childId: familyA.children[0].id }
  });
  assertApiError(noConsent, 403, 'CONSENT_REQUIRED');

  const crossCreate = await request('/api/v2/device-pairings', {
    method: 'POST', userId: familyB.adminId, idempotency: idempotencyKey('cross-create'),
    body: { childId: familyA.children[0].id }
  });
  assertApiError(crossCreate, 404, 'CHILD_NOT_FOUND');

  const created = await createPairing(familyA);
  const device = createDevice('scope');
  const claimed = await claimPairing(created, device);
  const pairingId = created.pairing.id;
  for (const userId of [familyA.parentId, familyB.adminId]) {
    const hidden = await request(`/api/v2/device-pairings/${pairingId}`, { userId });
    assertApiError(hidden, 404, 'PAIRING_NOT_FOUND');
    const forbiddenConfirm = await request(`/api/v2/device-pairings/${pairingId}/confirm`, {
      method: 'POST', userId, idempotency: idempotencyKey(`scope-confirm-${userId}`),
      body: { expectedRevision: 1, pairingChallenge: created.pairingChallenge }
    });
    assertApiError(forbiddenConfirm, 404, 'PAIRING_NOT_FOUND', [created.pairingChallenge]);
  }
  const noConsentDevices = await request('/api/v2/devices', { userId: familyA.parentId });
  assert.equal(noConsentDevices.response.status, 200);
  assert.deepEqual(noConsentDevices.body.devices, []);
  assert.ok(claimed.claimId);
});

test('错误设备密钥不会消费 proof，正确证明可完成且不同幂等键重放被拒绝', async () => {
  const fixture = await createAuthorizedFamily();
  const device = createDevice('proof-owner');
  const attacker = createDevice('proof-attacker');
  const created = await createPairing(fixture);
  const claimed = await claimPairing(created, device);
  await confirmClaim(fixture, created, claimed);

  const wrongSignature = signProof(claimed.proof, attacker.privateKey);
  const wrongKey = idempotencyKey('proof-wrong');
  const rejected = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: wrongKey,
    body: { signatureBase64url: wrongSignature }
  });
  assertApiError(rejected, 403, 'DEVICE_PROOF_INVALID', [claimed.claimId, wrongSignature]);
  const failedOnce = repositories.deviceSessions.findChallengeById({
    challengeId: claimed.proof.challengeId
  });
  assert.equal(failedOnce.status, 'pending');
  assert.equal(failedOnce.attemptCount, 1);
  const rejectedReplay = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: wrongKey,
    body: { signatureBase64url: wrongSignature }
  });
  assertApiError(rejectedReplay, 403, 'DEVICE_PROOF_INVALID');
  assert.equal(repositories.deviceSessions.findChallengeById({
    challengeId: claimed.proof.challengeId
  }).attemptCount, 1);
  const changedFailure = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: wrongKey,
    body: { signatureBase64url: signProof(claimed.proof, createDevice('other').privateKey) }
  });
  assertApiError(changedFailure, 409, 'IDEMPOTENCY_CONFLICT');

  const key = idempotencyKey('proof-valid');
  const completed = await completeClaim(claimed, device, key);
  const replay = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: key, body: completed.requestBody
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body.session, completed.session);

  const consumed = repositories.deviceSessions.findChallengeById({
    challengeId: claimed.proof.challengeId
  });
  assert.ok(Date.parse(consumed.consumedAt) > Date.parse(consumed.issuedAt));
  const expiryBoundaryReplay = deviceService.completePairing({
    claimToken: claimed.claimId,
    body: completed.requestBody,
    idempotencyKey: key,
    now: new Date(consumed.expiresAt)
  });
  assert.equal(expiryBoundaryReplay.status, 200);
  assert.deepEqual(expiryBoundaryReplay.body.session, completed.session);
  assert.throws(() => deviceService.completePairing({
    claimToken: claimed.claimId,
    body: completed.requestBody,
    idempotencyKey: key,
    now: new Date(Date.parse(consumed.consumedAt) + sessionConfig.idempotencyReplayTtlMs + 1)
  }), error => error && error.code === 'IDEMPOTENCY_REPLAY_STALE');

  const replayed = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: claimed.claimId, idempotency: idempotencyKey('proof-replay'),
    body: completed.requestBody
  });
  assertApiError(replayed, 409, 'CHALLENGE_REPLAYED', [claimed.claimId]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM device_sessions WHERE device_binding_id = ?')
    .get(completed.device.id).count, 1);
});

test('两个家长确认请求使用同一 revision 时只允许一次状态推进', async () => {
  const fixture = await createAuthorizedFamily();
  const device = createDevice('confirm-race');
  const created = await createPairing(fixture);
  await claimPairing(created, device);
  const current = await request(`/api/v2/device-pairings/${created.pairing.id}`, {
    userId: fixture.adminId
  });
  const body = {
    expectedRevision: current.body.pairing.revision,
    pairingChallenge: created.pairingChallenge
  };
  const results = await Promise.all([
    request(`/api/v2/device-pairings/${created.pairing.id}/confirm`, {
      method: 'POST', userId: fixture.adminId, idempotency: idempotencyKey('confirm-a'), body
    }),
    request(`/api/v2/device-pairings/${created.pairing.id}/confirm`, {
      method: 'POST', userId: fixture.adminId, idempotency: idempotencyKey('confirm-b'), body
    })
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const conflict = results.find(result => result.response.status === 409);
  assert.equal(conflict.body.code, 'REVISION_CONFLICT');
  assert.equal(repositories.deviceSessions.findPairingById({
    pairingId: created.pairing.id
  }).status, 'confirmed');
});

test('公开设备身份不能在 proof 前抢注，撤销后可经新授权流程重新配对', async () => {
  const attackerFamily = await createAuthorizedFamily();
  const ownerFamily = await createAuthorizedFamily();
  const device = createDevice('identity-owner');
  const attackerKey = createDevice('identity-attacker');

  const squattingPairing = await createPairing(attackerFamily);
  const squattingClaim = await claimPairing(squattingPairing, {
    ...device,
    privateKey: attackerKey.privateKey
  });
  await confirmClaim(attackerFamily, squattingPairing, squattingClaim);

  const ownerPairing = await createPairing(ownerFamily);
  const ownerClaim = await claimPairing(ownerPairing, device);
  await confirmClaim(ownerFamily, ownerPairing, ownerClaim);
  const ownerFlow = {
    device,
    completed: await completeClaim(ownerClaim, device)
  };
  assert.equal(ownerFlow.completed.device.status, 'active');
  const attackerProof = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: squattingClaim.claimId,
    idempotency: idempotencyKey('identity-squat-proof'),
    body: {
      signatureBase64url: signProof(squattingClaim.proof, attackerKey.privateKey)
    }
  });
  assertApiError(attackerProof, 403, 'DEVICE_PROOF_INVALID');

  const rePairing = await createPairing(attackerFamily);
  const reClaim = await claimPairing(rePairing, ownerFlow.device);
  await confirmClaim(attackerFamily, rePairing, reClaim);
  const rePairBody = {
    signatureBase64url: signProof(reClaim.proof, ownerFlow.device.privateKey)
  };
  const rePairKey = idempotencyKey('identity-repair-complete');
  const collision = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: reClaim.claimId, idempotency: rePairKey, body: rePairBody
  });
  assertApiError(collision, 409, 'DEVICE_ALREADY_BOUND');

  const revoked = await request(`/api/v2/devices/${ownerFlow.completed.device.id}`, {
    method: 'DELETE', userId: ownerFamily.adminId,
    idempotency: idempotencyKey('identity-owner-revoke'),
    body: { expectedRevision: ownerFlow.completed.device.revision }
  });
  assert.equal(revoked.response.status, 200);
  const repaired = await request('/api/v2/device-pairings/claim/complete', {
    method: 'POST', bearer: reClaim.claimId, idempotency: rePairKey, body: rePairBody
  });
  assert.equal(repaired.response.status, 201);
  assert.equal(repaired.body.device.status, 'active');
});

test('Refresh 只在临近过期时签发且每代仅保留一个 pending challenge', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'refresh-window');
  const early = await request(`/api/v2/devices/${flow.completed.device.id}/session-challenges`, {
    method: 'POST', bearer: flow.completed.session.refreshToken,
    idempotency: idempotencyKey('refresh-too-early')
  });
  assertApiError(early, 409, 'REFRESH_TOO_EARLY');

  const eligibleAt = refreshEligibleAt(flow.completed.session);
  const issueKey = idempotencyKey('refresh-window-issue');
  const first = deviceService.issueSessionChallenge({
    refreshToken: flow.completed.session.refreshToken,
    bindingId: flow.completed.device.id,
    idempotencyKey: issueKey,
    now: eligibleAt
  });
  assert.equal(first.status, 201);
  const exact = deviceService.issueSessionChallenge({
    refreshToken: flow.completed.session.refreshToken,
    bindingId: flow.completed.device.id,
    idempotencyKey: issueKey,
    now: eligibleAt
  });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.proof.challengeId, first.body.proof.challengeId);
  assert.throws(() => deviceService.issueSessionChallenge({
    refreshToken: flow.completed.session.refreshToken,
    bindingId: flow.completed.device.id,
    idempotencyKey: idempotencyKey('refresh-parallel-issue'),
    now: eligibleAt
  }), error => error && error.code === 'CHALLENGE_ALREADY_PENDING');
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM device_session_challenges
    WHERE device_session_id = ? AND status = 'pending'
  `).get(flow.completed.session.id).count, 1);

  const replacementAt = new Date(Date.parse(first.body.proof.expiresAt) + 1);
  const replacement = deviceService.issueSessionChallenge({
    refreshToken: flow.completed.session.refreshToken,
    bindingId: flow.completed.device.id,
    idempotencyKey: idempotencyKey('refresh-after-expiry'),
    now: replacementAt
  });
  assert.equal(replacement.status, 201);
  const attacker = createDevice('refresh-proof-attacker');
  let lockedRequest;
  for (let attempt = 1; attempt <= sessionConfig.proofAttemptLimit; attempt += 1) {
    const expectedCode = attempt === sessionConfig.proofAttemptLimit
      ? 'PAIRING_LOCKED'
      : 'DEVICE_PROOF_INVALID';
    const failureRequest = {
      idempotencyKey: idempotencyKey(`refresh-proof-failure-${attempt}`),
      body: {
        challengeId: replacement.body.proof.challengeId,
        signatureBase64url: signProof(replacement.body.proof, attacker.privateKey)
      }
    };
    if (attempt === sessionConfig.proofAttemptLimit) lockedRequest = failureRequest;
    assert.throws(() => deviceService.refreshSession({
      refreshToken: flow.completed.session.refreshToken,
      ...failureRequest,
      now: new Date(replacementAt.getTime() + attempt)
    }), error => error && error.code === expectedCode);
  }
  const lockedBefore = repositories.deviceSessions.findChallengeById({
    challengeId: replacement.body.proof.challengeId
  });
  assert.throws(() => deviceService.refreshSession({
    refreshToken: flow.completed.session.refreshToken,
    ...lockedRequest,
    now: new Date(replacementAt.getTime() + sessionConfig.proofAttemptLimit + 1)
  }), error => error && error.code === 'PAIRING_LOCKED');
  const lockedAfter = repositories.deviceSessions.findChallengeById({
    challengeId: replacement.body.proof.challengeId
  });
  assert.equal(lockedAfter.attemptCount, lockedBefore.attemptCount);
  assert.equal(lockedAfter.revision, lockedBefore.revision);
  assertDeviceAuthError(flow.completed.session.accessToken, 'SESSION_REVOKED');
  const bypass = await request(`/api/v2/devices/${flow.completed.device.id}/session-challenges`, {
    method: 'POST', bearer: flow.completed.session.refreshToken,
    idempotency: idempotencyKey('refresh-lock-bypass')
  });
  assertApiError(bypass, 401, 'SESSION_REVOKED');
});

test('Refresh 精确幂等重放保持同一代，换幂等键重用旧凭据会撤销整组会话', async () => {
  const fixture = await createAuthorizedFamily();
  const flow = await fullDeviceFlow(fixture, fixture.children[0], 'refresh');
  const { device, completed } = flow;
  const challengeKey = idempotencyKey('refresh-challenge');
  const refreshNow = refreshEligibleAt(completed.session);
  const challenge = deviceService.issueSessionChallenge({
    refreshToken: completed.session.refreshToken,
    bindingId: completed.device.id,
    idempotencyKey: challengeKey,
    now: refreshNow
  });
  assert.equal(challenge.status, 201);
  assert.equal(challenge.body.proof.algorithm, 'ECDSA_P256_SHA256');
  const refreshBody = {
    challengeId: challenge.body.proof.challengeId,
    signatureBase64url: signProof(challenge.body.proof, device.privateKey)
  };
  const refreshKey = idempotencyKey('refresh-complete');
  const rotated = deviceService.refreshSession({
    refreshToken: completed.session.refreshToken,
    idempotencyKey: refreshKey,
    body: refreshBody,
    now: new Date(refreshNow.getTime() + 1)
  });
  assert.equal(rotated.status, 201);
  assert.equal(rotated.body.session.rotationCounter, 1);

  const delayedIssueReplay = await request(`/api/v2/devices/${completed.device.id}/session-challenges`, {
    method: 'POST', bearer: completed.session.refreshToken, idempotency: challengeKey
  });
  assertApiError(delayedIssueReplay, 409, 'IDEMPOTENCY_REPLAY_STALE');
  assert.equal(requireDeviceV2(deviceRequest(rotated.body.session.accessToken)).rotationCounter, 1);

  const exactReplay = await request('/api/v2/device-sessions/refresh', {
    method: 'POST', bearer: completed.session.refreshToken,
    idempotency: refreshKey, body: refreshBody
  });
  assert.equal(exactReplay.response.status, 200);
  assert.deepEqual(exactReplay.body.session, rotated.body.session);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM device_sessions WHERE token_family_id = ?')
    .get(repositories.deviceSessions.findSessionById({ sessionId: completed.session.id }).tokenFamilyId).count, 2);
  assertDeviceAuthError(completed.session.accessToken, 'SESSION_REVOKED');
  assert.equal(requireDeviceV2(deviceRequest(rotated.body.session.accessToken)).rotationCounter, 1);

  const consumedChallenge = repositories.deviceSessions.findChallengeById({
    challengeId: challenge.body.proof.challengeId
  });
  const boundaryReplay = deviceService.refreshSession({
    refreshToken: completed.session.refreshToken,
    body: refreshBody,
    idempotencyKey: refreshKey,
    now: new Date(consumedChallenge.expiresAt)
  });
  assert.equal(boundaryReplay.status, 200);
  assert.deepEqual(boundaryReplay.body.session, rotated.body.session);

  const issueKeyConflict = await request(`/api/v2/devices/${completed.device.id}/session-challenges`, {
    method: 'POST', bearer: rotated.body.session.refreshToken, idempotency: challengeKey
  });
  assertApiError(issueKeyConflict, 409, 'IDEMPOTENCY_CONFLICT');
  const nextRefreshNow = refreshEligibleAt(rotated.body.session);
  const nextChallenge = deviceService.issueSessionChallenge({
    refreshToken: rotated.body.session.refreshToken,
    bindingId: completed.device.id,
    idempotencyKey: idempotencyKey('refresh-next-challenge'),
    now: nextRefreshNow
  });
  assert.equal(nextChallenge.status, 201);
  const completionConflictBody = {
    challengeId: nextChallenge.body.proof.challengeId,
    signatureBase64url: signProof(nextChallenge.body.proof, device.privateKey)
  };
  assert.throws(() => deviceService.refreshSession({
    refreshToken: rotated.body.session.refreshToken,
    idempotencyKey: refreshKey,
    body: {
      ...completionConflictBody
    },
    now: new Date(nextRefreshNow.getTime() + 1)
  }), error => error && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(requireDeviceV2(deviceRequest(rotated.body.session.accessToken)).rotationCounter, 1);

  assert.throws(() => deviceService.refreshSession({
    refreshToken: completed.session.refreshToken,
    idempotencyKey: idempotencyKey('refresh-reuse'),
    body: refreshBody,
    now: new Date(nextRefreshNow.getTime() + 2)
  }), error => error && error.code === 'SESSION_REVOKED');
  const familyId = repositories.deviceSessions.findSessionById({
    sessionId: completed.session.id
  }).tokenFamilyId;
  assert.deepEqual(getDb().prepare(`
    SELECT DISTINCT status FROM device_sessions WHERE token_family_id = ? ORDER BY status
  `).all(familyId).map(row => row.status), ['revoked']);
  assertDeviceAuthError(rotated.body.session.accessToken, 'SESSION_REVOKED');
  const blockedChallenge = await request(`/api/v2/devices/${completed.device.id}/session-challenges`, {
    method: 'POST', bearer: rotated.body.session.refreshToken,
    idempotency: idempotencyKey('refresh-after-reuse')
  });
  assertApiError(blockedChallenge, 401, 'SESSION_REVOKED', [rotated.body.session.refreshToken]);
});

test('过期 Refresh 精确重放和旧 Refresh 携带无关 challenge 都会撤销会话组', async () => {
  const fixture = await createAuthorizedFamily();
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'refresh-stale');
  const firstIssueKey = idempotencyKey('refresh-stale-issue');
  const firstRefreshNow = refreshEligibleAt(first.completed.session);
  const firstChallenge = deviceService.issueSessionChallenge({
    refreshToken: first.completed.session.refreshToken,
    bindingId: first.completed.device.id,
    idempotencyKey: firstIssueKey,
    now: firstRefreshNow
  });
  const firstBody = {
    challengeId: firstChallenge.body.proof.challengeId,
    signatureBase64url: signProof(firstChallenge.body.proof, first.device.privateKey)
  };
  const firstCompleteKey = idempotencyKey('refresh-stale-complete');
  const firstRotated = deviceService.refreshSession({
    refreshToken: first.completed.session.refreshToken,
    idempotencyKey: firstCompleteKey,
    body: firstBody,
    now: new Date(firstRefreshNow.getTime() + 1)
  });
  assert.equal(firstRotated.status, 201);
  const storedChallenge = repositories.deviceSessions.findChallengeById({
    challengeId: firstBody.challengeId
  });
  assert.throws(() => deviceService.refreshSession({
    refreshToken: first.completed.session.refreshToken,
    body: firstBody,
    idempotencyKey: firstCompleteKey,
    now: new Date(
      Date.parse(storedChallenge.consumedAt) + sessionConfig.idempotencyReplayTtlMs + 1
    )
  }), error => error && error.code === 'SESSION_REVOKED');
  assertDeviceAuthError(firstRotated.body.session.accessToken, 'SESSION_REVOKED');

  const second = await fullDeviceFlow(fixture, fixture.children[0], 'refresh-mismatch');
  const secondRefreshNow = refreshEligibleAt(second.completed.session);
  const secondChallenge = deviceService.issueSessionChallenge({
    refreshToken: second.completed.session.refreshToken,
    bindingId: second.completed.device.id,
    idempotencyKey: idempotencyKey('refresh-mismatch-issue'),
    now: secondRefreshNow
  });
  const secondBody = {
    challengeId: secondChallenge.body.proof.challengeId,
    signatureBase64url: signProof(secondChallenge.body.proof, second.device.privateKey)
  };
  const secondRotated = deviceService.refreshSession({
    refreshToken: second.completed.session.refreshToken,
    idempotencyKey: idempotencyKey('refresh-mismatch-complete'),
    body: secondBody,
    now: new Date(secondRefreshNow.getTime() + 1)
  });
  assert.equal(secondRotated.status, 201);
  assert.throws(() => deviceService.refreshSession({
    refreshToken: second.completed.session.refreshToken,
    idempotencyKey: idempotencyKey('refresh-mismatched-challenge'),
    body: {
      challengeId: `refresh_proof_${'f'.repeat(32)}`,
      signatureBase64url: secondBody.signatureBase64url
    },
    now: new Date(secondRefreshNow.getTime() + 2)
  }), error => error && error.code === 'SESSION_REVOKED');
  assertDeviceAuthError(secondRotated.body.session.accessToken, 'SESSION_REVOKED');
});

test('功能门关闭仍可撤销设备，旧 Access/Refresh 立即失效且响应不泄露凭据', async () => {
  const fixture = await createAuthorizedFamily();
  const { completed } = await fullDeviceFlow(fixture, fixture.children[0], 'revoke');
  process.env.HARMONY_CHILD_ENABLED = 'false';
  process.env.DEVICE_PAIRING_ENABLED = 'false';
  const key = idempotencyKey('device-revoke');
  const revoked = await request(`/api/v2/devices/${completed.device.id}`, {
    method: 'DELETE', userId: fixture.adminId, idempotency: key,
    body: { expectedRevision: completed.device.revision }
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.device.status, 'revoked');
  assertNoSensitiveResponse(revoked.body, [
    completed.session.accessToken, completed.session.refreshToken
  ]);
  const replay = await request(`/api/v2/devices/${completed.device.id}`, {
    method: 'DELETE', userId: fixture.adminId, idempotency: key,
    body: { expectedRevision: completed.device.revision }
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.device.status, 'revoked');

  enableAllGates();
  assertDeviceAuthError(completed.session.accessToken, 'SESSION_REVOKED');
  const refresh = await request(`/api/v2/devices/${completed.device.id}/session-challenges`, {
    method: 'POST', bearer: completed.session.refreshToken,
    idempotency: idempotencyKey('revoked-refresh')
  });
  assertApiError(refresh, 401, 'SESSION_REVOKED', [completed.session.refreshToken]);
  assert.equal(repositories.deviceSessions.findBindingById({
    bindingId: completed.device.id
  }).status, 'revoked');
  assert.deepEqual(repositories.deviceSessions.listSessionsForBinding({
    bindingId: completed.device.id
  }).map(item => item.status), ['revoked']);
});

test('会话撤销按家庭与授权隔离、幂等撤销整组且不影响兄弟姐妹', async () => {
  const family = await createAuthorizedFamily({ childCount: 2 });
  const other = await createAuthorizedFamily();
  const first = await fullDeviceFlow(family, family.children[0], 'session-revoke-first');
  const sibling = await fullDeviceFlow(family, family.children[1], 'session-revoke-sibling');
  const pending = deviceService.issueSessionChallenge({
    refreshToken: first.completed.session.refreshToken,
    bindingId: first.completed.device.id,
    idempotencyKey: idempotencyKey('session-revoke-pending'),
    now: refreshEligibleAt(first.completed.session)
  });
  assert.equal(pending.status, 201);
  const storedSession = repositories.deviceSessions.findSessionById({
    sessionId: first.completed.session.id
  });

  const crossFamily = await request(`/api/v2/device-sessions/${storedSession.id}`, {
    method: 'DELETE', userId: other.adminId,
    idempotency: idempotencyKey('session-revoke-cross'),
    body: { expectedRevision: storedSession.revision }
  });
  assertApiError(crossFamily, 404, 'DEVICE_NOT_FOUND');
  const noConsent = await request(`/api/v2/device-sessions/${storedSession.id}`, {
    method: 'DELETE', userId: family.parentId,
    idempotency: idempotencyKey('session-revoke-no-consent'),
    body: { expectedRevision: storedSession.revision }
  });
  assertApiError(noConsent, 403, 'CONSENT_REQUIRED');

  process.env.HARMONY_CHILD_ENABLED = 'false';
  process.env.DEVICE_PAIRING_ENABLED = 'false';
  const revokeKey = idempotencyKey('session-revoke-owner');
  const revokeNow = new Date(Date.parse(storedSession.issuedAt) - 60_000);
  const actor = repositories.users.findById(family.adminId);
  const revoked = deviceService.revokeSession({
    actor,
    sessionId: storedSession.id,
    body: { expectedRevision: storedSession.revision },
    idempotencyKey: revokeKey,
    now: revokeNow
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.session.status, 'revoked');
  const replay = deviceService.revokeSession({
    actor,
    sessionId: storedSession.id,
    body: { expectedRevision: storedSession.revision },
    idempotencyKey: revokeKey,
    now: new Date(revokeNow.getTime() + 1)
  });
  assert.equal(replay.status, 200);
  assert.equal(repositories.deviceSessions.findChallengeById({
    challengeId: pending.body.proof.challengeId
  }).status, 'revoked');
  enableAllGates();
  assertDeviceAuthError(first.completed.session.accessToken, 'SESSION_REVOKED');
  const revokedRefresh = await request(
    `/api/v2/devices/${first.completed.device.id}/session-challenges`,
    {
      method: 'POST', bearer: first.completed.session.refreshToken,
      idempotency: idempotencyKey('session-revoke-refresh')
    }
  );
  assertApiError(revokedRefresh, 401, 'SESSION_REVOKED');
  assert.equal(requireDeviceV2(
    deviceRequest(sibling.completed.session.accessToken)
  ).childId, family.children[1].id);
});

test('授权撤回在功能门关闭时仍联动撤销目标儿童设备并保持兄弟姐妹隔离', async () => {
  const fixture = await createAuthorizedFamily({ childCount: 2 });
  const first = await fullDeviceFlow(fixture, fixture.children[0], 'withdraw-first');
  const sibling = await fullDeviceFlow(fixture, fixture.children[1], 'withdraw-sibling');
  const pending = await createPairing(fixture, fixture.children[0]);

  const reauth = await request('/api/v2/reauth-assertions', {
    method: 'POST', userId: fixture.adminId,
    body: { purpose: 'child_consent_withdraw', password: TEST_PASSWORD }
  });
  assert.equal(reauth.response.status, 200);
  process.env.HARMONY_CHILD_ENABLED = 'false';
  process.env.DEVICE_PAIRING_ENABLED = 'false';
  const withdrawn = await request(
    `/api/v2/children/${fixture.children[0].id}/consents/withdraw`,
    {
      method: 'POST', userId: fixture.adminId,
      idempotency: idempotencyKey('consent-withdraw-device-cascade'),
      body: {
        reauthAssertion: reauth.body.reauthAssertion,
        expectedRevision: fixture.children[0].privacyState.revision
      }
    }
  );
  assert.equal(withdrawn.response.status, 200);
  assert.equal(withdrawn.body.privacyState.status, 'processing_blocked');
  assertNoSensitiveResponse(withdrawn.body, [
    reauth.body.reauthAssertion,
    first.completed.session.accessToken,
    first.completed.session.refreshToken
  ]);

  assert.equal(repositories.deviceSessions.findBindingById({
    bindingId: first.completed.device.id
  }).status, 'revoked');
  assert.equal(repositories.deviceSessions.findSessionById({
    sessionId: first.completed.session.id
  }).status, 'revoked');
  assert.equal(repositories.deviceSessions.findPairingById({
    pairingId: pending.pairing.id
  }).status, 'cancelled');
  assert.equal(repositories.deviceSessions.findBindingById({
    bindingId: sibling.completed.device.id
  }).status, 'active');
  assert.equal(repositories.deviceSessions.findSessionById({
    sessionId: sibling.completed.session.id
  }).status, 'active');

  enableAllGates();
  assertDeviceAuthError(first.completed.session.accessToken, 'SESSION_REVOKED');
  assert.equal(requireDeviceV2(deviceRequest(sibling.completed.session.accessToken)).childId,
    fixture.children[1].id);
});
