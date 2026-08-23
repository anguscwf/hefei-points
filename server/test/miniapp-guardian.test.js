const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MINIAPP = path.join(ROOT, 'hefei-miniapp');

function fresh(relativePath) {
  const filename = path.join(MINIAPP, relativePath);
  delete require.cache[require.resolve(filename)];
  return require(filename);
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function pageRuntime(relativePath, app, wxApi) {
  const previousPage = global.Page;
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let definition;
  global.Page = value => { definition = value; };
  global.getApp = () => app;
  global.wx = wxApi;
  try {
    fresh(relativePath);
  } finally {
    global.Page = previousPage;
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
  assert.ok(definition, `${relativePath} did not register a Page`);
  const page = Object.assign({}, definition, {
    data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, update); }
  });
  return page;
}

function appRuntime(wxApi) {
  const previousApp = global.App;
  const previousWx = global.wx;
  let definition;
  global.App = value => { definition = value; };
  global.wx = wxApi;
  try {
    fresh('app.js');
  } finally {
    global.App = previousApp;
    global.wx = previousWx;
  }
  assert.ok(definition, 'app.js did not register an App');
  return Object.assign({}, definition, { globalData: structuredClone(definition.globalData) });
}

const SYNTHETIC_TIME = '2026-08-24T00:00:00.000Z';

function currentLegalPayload() {
  return {
    success: true,
    texts: {
      privacyPolicy: { version: 'privacyPolicy-v1', sha256: 'a'.repeat(64) },
      childPersonalInformationRules: {
        version: 'childPersonalInformationRules-v1', sha256: 'b'.repeat(64)
      },
      childUserAgreement: { version: 'childUserAgreement-v1', sha256: 'c'.repeat(64) },
      sensitiveInformationNotice: {
        version: 'sensitiveInformationNotice-v1', sha256: 'd'.repeat(64)
      }
    },
    guardianRelationDeclaration: { version: 'relation-v1', sha256: 'e'.repeat(64) }
  };
}

function consentMutationPayload({
  childId = 'child_synthetic',
  alias = '合成孩子',
  consentStatus = 'active',
  privacyStatus = 'active',
  privacyRevision = 1,
  includeChild = false
} = {}) {
  const legalTexts = {};
  [
    ['privacyPolicy', 'a'],
    ['childPersonalInformationRules', 'b'],
    ['childUserAgreement', 'c'],
    ['sensitiveInformationNotice', 'd']
  ].forEach(([key, marker]) => {
    legalTexts[key] = { version: `${key}-v1`, sha256: marker.repeat(64) };
  });
  const payload = {
    success: true,
    consent: {
      id: 'consent_synthetic', childId, version: 1, status: consentStatus,
      lifecycleRevision: consentStatus === 'active' ? 0 : 1,
      guardianRelation: 'father',
      relationDeclaration: { version: 'relation-v1', sha256: 'e'.repeat(64) },
      legalTexts,
      consentScope: {
        childProfile: true, pointsLedger: true, pointRequests: true,
        sensitiveInformationNotice: true, optionalPhoto: false
      },
      visibilityScope: { guardian: 'full', familyAdults: 'none', childDevice: 'self_only' },
      consentedAt: {
        privacy: SYNTHETIC_TIME, childRules: SYNTHETIC_TIME,
        childUserAgreement: SYNTHETIC_TIME, sensitiveInformation: SYNTHETIC_TIME
      },
      verifiedAt: SYNTHETIC_TIME,
      createdAt: SYNTHETIC_TIME,
      ...(consentStatus === 'withdrawn' ? { withdrawnAt: SYNTHETIC_TIME } : {})
    },
    privacyState: { status: privacyStatus, revision: privacyRevision, updatedAt: SYNTHETIC_TIME }
  };
  if (includeChild) {
    payload.child = {
      id: childId, alias, privacyStatus, createdAt: SYNTHETIC_TIME
    };
  }
  return payload;
}

function rightsMutationPayload({
  childId = 'child_synthetic', requestType = 'access'
} = {}) {
  const destructive = requestType === 'delete' || requestType === 'terminate';
  return {
    success: true,
    dataRightsRequest: {
      id: 'data_rights_synthetic', childId, requestType,
      status: destructive ? 'processing' : 'completed', revision: 2,
      retentionDecision: destructive ? 'policy_pending' : 'not_applicable',
      receipt: { code: 'SYNTHETIC_RECEIPT', message: '合成回执' },
      requestedAt: SYNTHETIC_TIME,
      processingStartedAt: destructive ? SYNTHETIC_TIME : null,
      completedAt: destructive ? null : SYNTHETIC_TIME,
      rejectedAt: null,
      updatedAt: SYNTHETIC_TIME,
      ...(destructive ? {
        deletion: {
          status: 'blocked_policy', retentionDecision: 'policy_pending',
          blockedReason: 'formal_policy_required', requestedAt: SYNTHETIC_TIME,
          updatedAt: SYNTHETIC_TIME
        }
      } : {})
    }
  };
}

function pointRequestPayload({
  id = 'point_request_0123456789abcdef0123456789abcdef',
  status = 'pending', revision = 0, approvedPoints
} = {}) {
  return {
    id, status, revision,
    child: { id: 'child_synthetic', alias: '合成孩子' },
    rule: {
      id: 'rule_synthetic', categoryId: 'category_synthetic', label: '合成规则',
      categoryLabel: '合成分类', unit: '次', revision: 1,
      minPoints: 1, defaultPoints: 5, maxPoints: 10
    },
    requestedPoints: 8,
    ...(approvedPoints === undefined ? {} : { approvedPoints }),
    description: '合成说明',
    occurredAt: SYNTHETIC_TIME,
    submittedAt: SYNTHETIC_TIME,
    updatedAt: SYNTHETIC_TIME
  };
}

test('guardian v2 foundation keeps public reads anonymous and adult bearer out of bodies', async () => {
  const { createV2Client } = fresh('utils/v2-request.js');
  const { createGuardianApi } = fresh('utils/guardian-api.js');
  const calls = [];
  let token = `hefei.${'a'.repeat(32)}`;
  let responseMode = 'success';
  let authInvalid = 0;
  const wxApi = {
    request(options) {
      calls.push(options);
      if (responseMode === 'network') {
        options.fail({ errMsg: 'request:fail network' });
        return;
      }
      if (responseMode === 'html-gateway') {
        options.success({
          statusCode: 502,
          header: { 'X-Request-Id': 'req-gateway' },
          data: '<html>synthetic gateway error</html>'
        });
        return;
      }
      if (responseMode === 'forbidden') {
        options.success({
          statusCode: 403,
          header: { 'X-Request-Id': 'req-forbidden' },
          data: { success: false, code: 'FEATURE_DISABLED', message: 'closed' }
        });
        return;
      }
      if (responseMode === 'unauthorized') {
        options.success({
          statusCode: 401,
          header: {},
          data: { success: false, code: 'AUTH_REQUIRED', message: 'login' }
        });
        return;
      }
      options.success({
        statusCode: options.method === 'POST' ? 201 : 200,
        header: { 'X-Request-Id': 'req-success' },
        data: { success: true, texts: {}, children: [], pairing: { id: 'pair_synthetic' } }
      });
    },
    getRandomValues(options) {
      const buffer = new ArrayBuffer(options.length);
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1;
      options.success({ randomValues: buffer });
    }
  };
  const client = createV2Client({
    wxApi,
    baseUrl: 'https://example.invalid',
    getAdultToken: () => token,
    onAuthInvalid: () => { authInvalid += 1; }
  });
  const api = createGuardianApi({
    request: client.request,
    createIdempotencyKey: client.createIdempotencyKey
  });

  const legal = await api.currentLegalTexts();
  assert.equal(legal.ok, true);
  assert.equal(calls[0].url, 'https://example.invalid/api/v2/legal-texts/current');
  assert.equal(Object.hasOwn(calls[0].header, 'Authorization'), false);
  assert.equal(calls[0].data, undefined);

  const children = await api.listChildren();
  assert.equal(children.ok, true);
  assert.equal(calls[1].header.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].data, undefined);

  const key = await api.createIdempotencyKey('guardian');
  assert.match(key, /^guardian:[a-f0-9]{32}$/);
  await api.createPairing({ childId: 'child_synthetic' }, key);
  assert.equal(calls[2].header['Idempotency-Key'], key);
  assert.equal(calls[2].header.Authorization, `Bearer ${token}`);
  assert.deepEqual(calls[2].data, { childId: 'child_synthetic' });
  assert.equal(Object.hasOwn(calls[2].data, 'token'), false);

  responseMode = 'forbidden';
  const forbidden = await api.taskSummary();
  assert.equal(forbidden.code, 'FEATURE_DISABLED');
  assert.equal(authInvalid, 0);

  responseMode = 'unauthorized';
  const unauthorized = await api.taskSummary();
  assert.equal(unauthorized.code, 'AUTH_REQUIRED');
  assert.equal(authInvalid, 1);

  responseMode = 'network';
  const before = calls.length;
  const failedWrite = await api.approvePointRequest(
    'point_request_0123456789abcdef0123456789abcdef',
    { expectedRevision: 1, approvedPoints: 5 },
    key
  );
  assert.equal(failedWrite.code, 'NETWORK_ERROR');
  assert.equal(failedWrite.outcomeUnknown, true);
  assert.equal(calls.length, before + 1, 'mutating transport must not retry automatically');

  responseMode = 'html-gateway';
  const gatewayBefore = calls.length;
  const gatewayWrite = await api.approvePointRequest(
    'point_request_0123456789abcdef0123456789abcdef',
    { expectedRevision: 1, approvedPoints: 5 },
    key
  );
  assert.equal(gatewayWrite.code, 'INVALID_RESPONSE');
  assert.equal(gatewayWrite.status, 502);
  assert.equal(gatewayWrite.outcomeUnknown, true);
  assert.equal(calls.length, gatewayBefore + 1, 'gateway ambiguity must not trigger automatic retry');
});

test('guardian endpoint adapter exposes no child claim, signature, or refresh capability', () => {
  const source = fs.readFileSync(path.join(MINIAPP, 'utils/guardian-api.js'), 'utf8');
  for (const forbidden of [
    'claim-by-code', '/claim/complete', 'session-challenges', 'device-sessions/refresh',
    '/v2/me/point-requests'
  ]) {
    assert.equal(source.includes(forbidden), false, `guardian adapter exposed ${forbidden}`);
  }
  assert.match(source, /listChildren/);
  assert.match(source, /withdrawConsent/);
  assert.match(source, /revokeDeviceSession/);
});

test('adult session storage is field-whitelisted and corrupt or child sessions cannot authorize v2', () => {
  const { createSessionStore } = fresh('utils/session.js');
  const values = new Map();
  const storage = {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
    removeStorageSync(key) { values.delete(key); }
  };
  const store = createSessionStore({ storage });
  const adultToken = `hefei.${'b'.repeat(32)}`;
  const committed = store.commit(adultToken, {
    id: 'adult_synthetic', name: '合成家长', role: 'parent', familyId: 'family_synthetic',
    password: 'must-not-persist', reauthAssertion: 'must-not-persist'
  });
  assert.deepEqual(committed.user, {
    id: 'adult_synthetic', name: '合成家长', role: 'parent', familyId: 'family_synthetic'
  });
  assert.equal(values.get('hefei_user').includes('password'), false);
  assert.equal(store.getAdultBearer(committed), adultToken);
  assert.equal(store.getAdultBearer({
    token: adultToken,
    user: { id: 'child_synthetic', name: '合成孩子', role: 'child', familyId: 'family_synthetic' }
  }), '');

  values.set('hefei_user', '{broken');
  assert.deepEqual(store.restore(), { token: '', user: null });
  assert.equal(values.has('hefei_token'), false);
  assert.equal(values.has('hefei_user'), false);
});

test('session storage clear and same-token identity changes fail closed', () => {
  const { createSessionStore } = fresh('utils/session.js');
  const stuck = new Map([
    ['hefei_token', `hefei.${'9'.repeat(32)}`],
    ['hefei_user', JSON.stringify({
      id: 'adult_old', name: '旧合成人', role: 'parent', familyId: 'family_old'
    })]
  ]);
  const store = createSessionStore({
    storage: {
      getStorageSync(key) { return stuck.get(key); },
      setStorageSync() {},
      removeStorageSync() {}
    }
  });
  assert.throws(() => store.clear(), /could not be cleared/);

  const app = appRuntime({ request() {}, getRandomValues() {}, showToast() {} });
  const token = `hefei.${'8'.repeat(32)}`;
  app.globalData.token = token;
  app.globalData.user = { id: 'adult_a', name: '合成甲', role: 'parent', familyId: 'family_a' };
  app._sessionGeneration = 3;
  const snapshot = app._captureSessionSnapshot();
  app.globalData.user = { id: 'adult_b', name: '合成乙', role: 'parent', familyId: 'family_b' };
  assert.equal(app._isSessionSnapshotCurrent(snapshot), false);
});

test('session replacement tombstones the old bearer before staging a new family identity', () => {
  const { createSessionStore } = fresh('utils/session.js');
  const tokenA = `hefei.${'a'.repeat(32)}`;
  const tokenB = `hefei.${'b'.repeat(32)}`;
  const values = new Map([
    ['hefei_token', tokenA],
    ['hefei_user', JSON.stringify({
      id: 'adult_a', name: '合成甲', role: 'parent', familyId: 'family_a'
    })]
  ]);
  const failingStorage = {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) {
      if (key === 'hefei_token' && value === tokenB) {
        throw new Error('synthetic final token failure');
      }
      if (key === 'hefei_user' && value === '') {
        throw new Error('synthetic cleanup failure');
      }
      values.set(key, value);
    },
    removeStorageSync() {}
  };
  const store = createSessionStore({ storage: failingStorage });
  assert.throws(() => store.commit(tokenB, {
    id: 'adult_b', name: '合成乙', role: 'parent', familyId: 'family_b'
  }), /unavailable/);
  assert.equal(values.get('hefei_token'), '', 'old family bearer must remain tombstoned');
  assert.match(values.get('hefei_user'), /adult_b/);

  const rebootStore = createSessionStore({
    storage: {
      getStorageSync(key) { return values.get(key); },
      setStorageSync(key, value) { values.set(key, value); },
      removeStorageSync(key) { values.delete(key); }
    }
  });
  assert.deepEqual(rebootStore.restore(), { token: '', user: null });
  assert.equal(rebootStore.getAdultBearer({
    token: values.get('hefei_token'),
    user: JSON.parse(values.get('hefei_user') || 'null')
  }), '');
});

test('guardian operation recovery survives restart without storing child data or reauth secrets', () => {
  const { createRecoveryStore } = fresh('utils/guardian-operation-recovery.js');
  const values = new Map();
  const storage = {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); }
  };
  let user = { id: 'adult_recovery', familyId: 'family_recovery', role: 'parent' };
  const key = 'miniapp:1234567890abcdef1234567890abcdef';
  const first = createRecoveryStore({ storage, getUser: () => user });
  first.begin('child-enrollment', key);

  const serialized = [...values.values()].join('');
  assert.equal(serialized.includes('合成孩子'), false);
  assert.equal(/password|reauthAssertion|shortCode|challenge/.test(serialized), false);
  const restarted = createRecoveryStore({ storage, getUser: () => user });
  const restored = restarted.current();
  assert.equal(restored.idempotencyKey, key);
  assert.equal(typeof restarted.noteNotFound, 'undefined');
  assert.equal(typeof restarted.canAbandon, 'undefined');
  user = { id: 'adult_other', familyId: 'family_recovery', role: 'parent' };
  assert.equal(restarted.current(), null, 'recovery marker must remain scoped to the original adult');
  user = { id: 'adult_recovery', familyId: 'family_recovery', role: 'parent' };
  assert.equal(restarted.clear(key), true);
  assert.equal(restarted.current(), null);

  const unreadable = createRecoveryStore({
    storage: { getStorageSync() { return undefined; }, setStorageSync() {} },
    getUser: () => user
  });
  assert.throws(
    () => unreadable.begin('child-enrollment', key),
    /verification failed/
  );
});

test('device pairing recovery survives restart without secrets and never evicts unresolved scopes', () => {
  const { createRecoveryStore } = fresh('utils/device-pairing-recovery.js');
  const values = new Map();
  const storage = {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); }
  };
  let user = { id: 'adult_00', familyId: 'family_00', role: 'parent' };
  const store = createRecoveryStore({ storage, getUser: () => user });
  const firstKey = 'miniapp:00000000000000000000000000000000';
  store.begin('child_synthetic', firstKey);
  for (let index = 1; index < 32; index += 1) {
    user = { id: `adult_${index}`, familyId: `family_${index}`, role: 'parent' };
    store.begin(`child_${index}`, `miniapp:${String(index).padStart(32, '0')}`);
  }
  user = { id: 'adult_32', familyId: 'family_32', role: 'parent' };
  assert.throws(
    () => store.begin('child_32', 'miniapp:32323232323232323232323232323232'),
    /storage is full/
  );
  user = { id: 'adult_00', familyId: 'family_00', role: 'parent' };
  assert.equal(store.current().idempotencyKey, firstKey);
  const serialized = [...values.values()].join('');
  assert.equal(/shortCode|pairingChallenge|accessToken|refreshToken/.test(serialized), false);
});

test('guardian view model accepts the historical-child read model and never calls blocked deletion complete', () => {
  const model = fresh('utils/guardian-page.js');
  const child = model.decorateChild({
    child: { id: 'child_synthetic', alias: '合成孩子' },
    privacyState: { status: 'processing_blocked', revision: 7, updatedAt: '2026-08-24T00:00:00.000Z' },
    latestConsent: { id: 'consent_synthetic', version: 3, status: 'withdrawn' }
  });
  assert.equal(child.id, 'child_synthetic');
  assert.equal(child.revision, 7);
  assert.equal(child.privacyLabel, '已阻断处理');
  assert.equal(child.consentLabel, '已撤回');

  const deletion = model.decorateRightsRequest({
    id: 'data_rights_synthetic',
    requestType: 'delete',
    status: 'processing',
    retentionDecision: 'policy_pending',
    deletion: { status: 'blocked_policy' }
  });
  assert.equal(deletion.statusLabel, '已受理，留存政策待确认');
  assert.equal(/已删除/.test(deletion.statusLabel), false);
});

test('guardian view model validates complete export, receipt, and task DTOs before rendering', () => {
  const model = fresh('utils/guardian-page.js');
  const snapshot = {
    schemaVersion: '1.0',
    generatedAt: '2026-08-24T00:00:00.000Z',
    authorizedByRequestId: 'data_rights_export',
    child: { id: 'child_synthetic', alias: '合成孩子' },
    privacyState: { status: 'active', revision: 1 },
    pointAccount: { balance: 7 },
    guardianConsents: [],
    deviceBindings: [],
    deviceSessions: [],
    transactions: [{
      id: 'transaction_synthetic', occurredAt: '2026-08-24T00:00:00.000Z',
      childAliasSnapshot: '合成孩子', amount: 7, reason: '合成任务', note: '',
      refreshToken: 'must-not-render'
    }],
    pointRequests: [],
    dataRightsRequests: [],
    auditEvents: [],
    retentionNotice: {
      deletionExecutionEnabled: false,
      immutableEvidenceRetained: true,
      reason: 'retention_policy_unapproved'
    },
    password: 'must-not-render'
  };
  assert.equal(model.validExportSnapshot(snapshot, 'child_synthetic', 'data_rights_export'), true);
  const safe = model.safeExportSnapshot(snapshot);
  assert.equal(JSON.stringify(safe).includes('transaction_synthetic'), true);
  assert.equal(/password|refreshToken|must-not-render/.test(JSON.stringify(safe)), false);
  assert.equal(model.validExportSnapshot({ ...snapshot, transactions: [null] }, 'child_synthetic', 'data_rights_export'), false);

  const detail = {
    id: 'data_rights_detail', childId: 'child_synthetic', requestType: 'delete',
    status: 'processing', revision: 2, auditTrail: []
  };
  assert.equal(model.validRightsDetail(detail, 'data_rights_detail'), true);
  assert.equal(model.validRightsDetail(detail, 'data_rights_other'), false);

  const pointRequest = {
    id: 'point_request_synthetic', status: 'pending', revision: 0,
    child: { id: 'child_synthetic', alias: '合成孩子' },
    rule: {
      id: 'rule_synthetic', categoryId: 'category_synthetic', label: '合成规则',
      categoryLabel: '合成分类', unit: '次', revision: 1,
      minPoints: 1, defaultPoints: 2, maxPoints: 3
    },
    requestedPoints: 2, description: '合成说明',
    occurredAt: '2026-08-24T00:00:00.000Z',
    submittedAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z'
  };
  assert.equal(model.validPointRequestDto(pointRequest, pointRequest.id), true);
  assert.equal(model.validPointRequestDto({ ...pointRequest, rule: null }, pointRequest.id), false);
});

test('new-consent page performs only the public legal read on initial load', async () => {
  const calls = [];
  const app = {
    globalData: {
      token: `hefei.${'c'.repeat(32)}`,
      user: { role: 'parent' },
      theme: 'mint',
      guardianPreviewEnabled: false,
      guardianRouteContext: null
    },
    getThemePageStyle: () => '',
    guardianApi: {
      currentLegalTexts() {
        calls.push('legal');
        return Promise.resolve({
          ok: true,
          data: {
            texts: {
              privacyPolicy: { version: 'v1', sha256: 'a'.repeat(64) },
              childPersonalInformationRules: { version: 'v1', sha256: 'b'.repeat(64) },
              childUserAgreement: { version: 'v1', sha256: 'c'.repeat(64) },
              sensitiveInformationNotice: { version: 'v1', sha256: 'd'.repeat(64) }
            },
            guardianRelationDeclaration: { version: 'v1', sha256: 'e'.repeat(64) }
          }
        });
      },
      listChildren() { calls.push('children'); return Promise.resolve({ ok: true, data: {} }); },
      createReauth() { calls.push('reauth'); return Promise.resolve({ ok: true, data: {} }); }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, {
    navigateTo() {}, showToast() {}
  });
  page.onLoad();
  await nextTurn();
  assert.deepEqual(calls, ['legal']);
  assert.equal(page.data.previewEnabled, false);
  assert.equal(page.data.canSubmit, false);
});

test('consent page reloads legal evidence after a hide interrupts the first request', async () => {
  let resolveFirst;
  let legalReads = 0;
  const app = {
    globalData: {
      token: `hefei.${'c'.repeat(32)}`,
      user: { id: 'adult_lifecycle', familyId: 'family_lifecycle', role: 'parent' },
      theme: 'mint', guardianPreviewEnabled: true,
      guardianRouteContext: null, guardianEnrollmentReviewRequired: null
    },
    getThemePageStyle: () => '',
    guardianApi: {
      currentLegalTexts() {
        legalReads += 1;
        if (legalReads === 1) return new Promise(resolve => { resolveFirst = resolve; });
        return Promise.resolve({ ok: true, data: currentLegalPayload() });
      }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, {});
  page.onLoad();
  page.onHide();
  resolveFirst({ ok: true, data: currentLegalPayload() });
  await nextTurn();
  assert.equal(page.data.loading, true, 'hidden response must not update the page');
  page.onShow();
  await nextTurn();
  assert.equal(legalReads, 2);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.relationAccepted, false);
  assert.equal(page.data.legalItems.every(item => item.accepted === false), true);
  assert.equal(page.data.relationVersion, 'relation-v1');
});

test('consent submission freezes the clicked legal evidence while reauthentication is pending', async () => {
  let resolveReauth;
  let submitted;
  const legalItems = [
    ['privacyPolicy', 'a'],
    ['childPersonalInformationRules', 'b'],
    ['childUserAgreement', 'c'],
    ['sensitiveInformationNotice', 'd']
  ].map(([key, marker]) => ({
    key, title: key, accepted: true, version: `${key}-v1`, sha256: marker.repeat(64), shaShort: marker.repeat(12)
  }));
  const app = {
    globalData: {
      token: `hefei.${'1'.repeat(32)}`,
      user: { id: 'adult_snapshot', familyId: 'family_snapshot', role: 'parent' },
      theme: 'mint', guardianPreviewEnabled: true, guardianEnrollmentReviewRequired: null
    },
    beginGuardianConsentReview(operation, idempotencyKey) {
      const marker = { operation, idempotencyKey, createdAt: 1 };
      this.globalData.guardianEnrollmentReviewRequired = marker;
      return marker;
    },
    clearGuardianConsentReview() {
      this.globalData.guardianEnrollmentReviewRequired = null;
      return true;
    },
    guardianApi: {
      createReauth: () => new Promise(resolve => { resolveReauth = resolve; }),
      createIdempotencyKey: () => Promise.resolve('miniapp:0123456789abcdef0123456789abcdef'),
      enrollChild(body) {
        submitted = structuredClone(body);
        return Promise.resolve({
          ok: true,
          data: consentMutationPayload({
            childId: 'child_snapshot', alias: body.alias, includeChild: true
          })
        });
      }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, {});
  page._alive = true;
  page._epoch = 0;
  page.setData({
    isAdult: true,
    previewEnabled: true,
    mode: 'enroll',
    alias: '点击时别名',
    relationIndex: 0,
    relationAccepted: true,
    relationVersion: 'relation-v1',
    relationSha256: 'e'.repeat(64),
    legalItems,
    password: 'synthetic-password'
  });
  page.syncCanSubmit();
  const previousWx = global.wx;
  global.wx = { showToast() {} };
  try {
    page.submit();
    page.setData({
      alias: '等待期间被改动',
      relationIndex: 1,
      legalItems: legalItems.map(item => Object.assign({}, item, { accepted: false }))
    });
    resolveReauth({ ok: true, data: { reauthAssertion: 'temporary-assertion' } });
    await nextTurn();
    await nextTurn();
  } finally {
    global.wx = previousWx;
  }
  assert.equal(submitted.alias, '点击时别名');
  assert.equal(submitted.guardianRelation, 'father');
  assert.equal(submitted.consents.privacyPolicy.accepted, true);
  assert.equal(submitted.consents.sensitiveInformationNotice.version, 'sensitiveInformationNotice-v1');
});

test('interrupted enrollment blocks a new key until the privacy page reconciles server state', async () => {
  let resolveEnrollment;
  let enrollmentCalls = 0;
  const legalItems = [
    ['privacyPolicy', 'a'],
    ['childPersonalInformationRules', 'b'],
    ['childUserAgreement', 'c'],
    ['sensitiveInformationNotice', 'd']
  ].map(([key, marker]) => ({
    key, title: key, accepted: true, version: `${key}-v1`, sha256: marker.repeat(64)
  }));
  const app = {
    globalData: {
      token: `hefei.${'2'.repeat(32)}`,
      user: { role: 'parent' },
      theme: 'mint',
      guardianPreviewEnabled: true,
      guardianEnrollmentReviewRequired: null
    },
    beginGuardianConsentReview(operation, idempotencyKey) {
      const marker = { operation, idempotencyKey, createdAt: 1 };
      this.globalData.guardianEnrollmentReviewRequired = marker;
      return marker;
    },
    clearGuardianConsentReview(expectedKey) {
      if (!this.globalData.guardianEnrollmentReviewRequired
          || this.globalData.guardianEnrollmentReviewRequired.idempotencyKey !== expectedKey) return false;
      this.globalData.guardianEnrollmentReviewRequired = null;
      return true;
    },
    getThemePageStyle: () => '',
    guardianApi: {
      currentLegalTexts: () => Promise.resolve({ ok: true, data: currentLegalPayload() }),
      createReauth: () => Promise.resolve({ ok: true, data: { reauthAssertion: 'temporary-assertion' } }),
      createIdempotencyKey: () => Promise.resolve('miniapp:11112222333344445555666677778888'),
      enrollChild() {
        enrollmentCalls += 1;
        return new Promise(resolve => { resolveEnrollment = resolve; });
      }
    }
  };
  const wxApi = { showToast() {}, navigateBack() {} };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, wxApi);
  page._alive = true;
  page._epoch = 0;
  page._sessionGeneration = 0;
  page._enrollmentBaselineIds = [];
  page.setData({
    isAdult: true,
    previewEnabled: true,
    mode: 'enroll',
    alias: '合成新儿童',
    relationIndex: 0,
    relationAccepted: true,
    relationVersion: 'relation-v1',
    relationSha256: 'e'.repeat(64),
    legalItems,
    password: 'synthetic-password'
  });
  page.syncCanSubmit();
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    page.submit();
    await nextTurn();
    await nextTurn();
    assert.equal(enrollmentCalls, 1);
    assert.equal(app.globalData.guardianEnrollmentReviewRequired.operation, 'child-enrollment');
    page.onHide();
    resolveEnrollment({ ok: true, data: { child: { id: 'child_new', alias: '合成新儿童' } } });
    await nextTurn();
    assert.equal(app.globalData.guardianEnrollmentReviewRequired.idempotencyKey, 'miniapp:11112222333344445555666677778888');
    page.onShow();
    assert.equal(page.data.reconcileRequired, true);
    page.submit();
    assert.equal(enrollmentCalls, 1, 'interrupted enrollment must not create a second key/write');

    app.guardianApi = {
      listChildren: () => Promise.resolve({
        ok: true,
        data: {
          children: [{
            child: { id: 'child_new', alias: '合成新儿童' },
            privacyState: { status: 'active', revision: 0, updatedAt: '2026-08-24T00:00:00.000Z' },
            latestConsent: { id: 'consent_new', version: 1, status: 'active' }
          }]
        }
      }),
      listConsents: () => Promise.resolve({ ok: true, data: { consents: [] } }),
      listDataRightsRequests: () => Promise.resolve({ ok: true, data: { dataRightsRequests: [], nextCursor: null } })
      ,getConsentOperation: () => Promise.resolve({
        ok: true,
        data: { guardianConsentOperation: {
          operation: 'child-enrollment', status: 'completed',
          completedAt: '2026-08-24T00:00:00.000Z'
        } }
      })
    };
    const privacy = pageRuntime('pages/family-privacy/family-privacy.js', app, wxApi);
    privacy._alive = true;
    privacy._visible = true;
    privacy.loadChildren();
    await nextTurn();
    await nextTurn();
    assert.equal(app.globalData.guardianEnrollmentReviewRequired, null);
    assert.equal(privacy.data.enrollmentReviewRequired, false);
  } finally {
    global.wx = previousWx;
  }
});

test('visible ambiguous consent retry keeps the assertion and reuses the exact key and body', async () => {
  const writes = [];
  const legalItems = [
    ['privacyPolicy', 'a'],
    ['childPersonalInformationRules', 'b'],
    ['childUserAgreement', 'c'],
    ['sensitiveInformationNotice', 'd']
  ].map(([key, marker]) => ({
    key, title: key, accepted: true, version: `${key}-v1`, sha256: marker.repeat(64)
  }));
  const app = {
    globalData: {
      token: `hefei.${'7'.repeat(32)}`,
      user: { id: 'adult_retry', familyId: 'family_retry', role: 'parent' },
      theme: 'mint', guardianPreviewEnabled: true, guardianEnrollmentReviewRequired: null
    },
    beginGuardianConsentReview(operation, idempotencyKey) {
      const marker = { operation, idempotencyKey, createdAt: 1 };
      this.globalData.guardianEnrollmentReviewRequired = marker;
      return marker;
    },
    clearGuardianConsentReview() {
      this.globalData.guardianEnrollmentReviewRequired = null;
      return true;
    },
    guardianApi: {
      createReauth: () => Promise.resolve({ ok: true, data: { reauthAssertion: 'same-temporary-assertion' } }),
      createIdempotencyKey: () => Promise.resolve('miniapp:99990000111122223333444455556666'),
      enrollChild(body, key) {
        writes.push({ body: structuredClone(body), key });
        return Promise.resolve(writes.length === 1
          ? { ok: false, code: 'NETWORK_ERROR', outcomeUnknown: true }
          : {
              ok: true,
              data: consentMutationPayload({
                childId: 'child_retry', alias: body.alias, includeChild: true
              })
            });
      }
    }
  };
  const wxApi = { showToast() {} };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, wxApi);
  page._alive = true;
  page._epoch = 0;
  page.setData({
    isAdult: true, previewEnabled: true, mode: 'enroll', alias: '幂等重试孩子',
    relationIndex: 0, relationAccepted: true, relationVersion: 'relation-v1',
    relationSha256: 'e'.repeat(64), legalItems, password: 'synthetic-password'
  });
  page.syncCanSubmit();
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    page.submit();
    await nextTurn();
    await nextTurn();
    assert.equal(page.data.canRetry, true);
    assert.equal(page._pendingWrite.body.reauthAssertion, 'same-temporary-assertion');
    page.submit();
    await nextTurn();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, writes[1].key);
    assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(app.globalData.guardianEnrollmentReviewRequired, null);
  } finally {
    global.wx = previousWx;
  }
});

test('malformed enrollment 2xx keeps the durable marker and exact write for retry', async () => {
  let attempts = 0;
  const key = 'miniapp:malformed00001111222233334444';
  const app = {
    globalData: {
      token: `hefei.${'e'.repeat(32)}`,
      user: { id: 'adult_malformed', familyId: 'family_malformed', role: 'parent' },
      guardianEnrollmentReviewRequired: null
    },
    beginGuardianConsentReview(operation, idempotencyKey) {
      const marker = { operation, idempotencyKey, createdAt: 1 };
      this.globalData.guardianEnrollmentReviewRequired = marker;
      return marker;
    },
    clearGuardianConsentReview(expectedKey) {
      if (!this.globalData.guardianEnrollmentReviewRequired
          || this.globalData.guardianEnrollmentReviewRequired.idempotencyKey !== expectedKey) return false;
      this.globalData.guardianEnrollmentReviewRequired = null;
      return true;
    },
    guardianApi: {
      enrollChild(body) {
        attempts += 1;
        return Promise.resolve(attempts === 1
          ? { ok: true, data: { success: true, child: { id: 'child_truncated' } } }
          : {
              ok: true,
              data: consentMutationPayload({
                childId: 'child_malformed', alias: body.alias, includeChild: true
              })
            });
      }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, {});
  page._alive = true;
  page._visible = true;
  page._epoch = 0;
  page.setData({ mode: 'enroll' });
  const pending = {
    key,
    epoch: 0,
    reviewMarker: null,
    body: { alias: '畸形响应孩子', reauthAssertion: 'temporary-assertion' }
  };
  page._pendingWrite = pending;
  page.performConsentWrite(pending);
  await nextTurn();
  assert.equal(page.data.canRetry, true);
  assert.equal(page._pendingWrite, pending);
  assert.equal(pending.body.reauthAssertion, 'temporary-assertion');
  assert.equal(app.globalData.guardianEnrollmentReviewRequired.idempotencyKey, key);
  page.submit();
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(page._pendingWrite, null);
  assert.equal(pending.body.reauthAssertion, '');
  assert.equal(app.globalData.guardianEnrollmentReviewRequired, null);
});

test('malformed reconsent 2xx stays outcome-unknown until the same key returns the target child', async () => {
  let attempts = 0;
  const key = 'miniapp:malformed55556666777788889999';
  const childId = 'child_reconsent';
  const app = {
    globalData: { guardianEnrollmentReviewRequired: null },
    beginGuardianConsentReview(operation, idempotencyKey) {
      const marker = { operation, idempotencyKey, createdAt: 1 };
      this.globalData.guardianEnrollmentReviewRequired = marker;
      return marker;
    },
    clearGuardianConsentReview(expectedKey) {
      if (!this.globalData.guardianEnrollmentReviewRequired
          || this.globalData.guardianEnrollmentReviewRequired.idempotencyKey !== expectedKey) return false;
      this.globalData.guardianEnrollmentReviewRequired = null;
      return true;
    },
    guardianApi: {
      createConsent(id) {
        attempts += 1;
        return Promise.resolve({
          ok: true,
          data: consentMutationPayload({
            childId: attempts === 1 ? 'child_wrong_scope' : id,
            privacyRevision: 5
          })
        });
      }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, {});
  page._alive = true;
  page._visible = true;
  page._epoch = 0;
  page._childId = childId;
  page._previousPrivacyStatus = 'active';
  page.setData({ mode: 'reconsent', childAlias: '合成孩子', expectedRevision: 4 });
  const pending = {
    key,
    epoch: 0,
    reviewMarker: null,
    body: { expectedRevision: 4, reauthAssertion: 'temporary-assertion' }
  };
  page._pendingWrite = pending;
  page.performConsentWrite(pending);
  await nextTurn();
  assert.equal(page.data.canRetry, true);
  assert.equal(page._pendingWrite, pending);
  assert.equal(app.globalData.guardianEnrollmentReviewRequired.idempotencyKey, key);
  page.submit();
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(page._pendingWrite, null);
  assert.equal(pending.body.reauthAssertion, '');
  assert.equal(app.globalData.guardianEnrollmentReviewRequired, null);
});

test('consent write fails closed when its durable recovery marker cannot be verified', async () => {
  let writes = 0;
  const legalItems = [
    ['privacyPolicy', 'a'], ['childPersonalInformationRules', 'b'],
    ['childUserAgreement', 'c'], ['sensitiveInformationNotice', 'd']
  ].map(([key, marker]) => ({
    key, title: key, accepted: true, version: `${key}-v1`, sha256: marker.repeat(64)
  }));
  const app = {
    globalData: {
      token: `hefei.${'8'.repeat(32)}`, user: { role: 'parent' }, theme: 'mint',
      guardianPreviewEnabled: true, guardianEnrollmentReviewRequired: null
    },
    beginGuardianConsentReview() { throw new Error('synthetic storage failure'); },
    guardianApi: {
      createReauth: () => Promise.resolve({ ok: true, data: { reauthAssertion: 'temporary-assertion' } }),
      createIdempotencyKey: () => Promise.resolve('miniapp:00001111222233334444555566667777'),
      enrollChild() { writes += 1; return Promise.resolve({ ok: true }); }
    }
  };
  const page = pageRuntime('pages/guardian-consent/guardian-consent.js', app, { showToast() {} });
  page._alive = true;
  page._epoch = 0;
  page.setData({
    isAdult: true, previewEnabled: true, mode: 'enroll', alias: '不会提交的孩子',
    relationIndex: 0, relationAccepted: true, relationVersion: 'relation-v1',
    relationSha256: 'e'.repeat(64), legalItems, password: 'synthetic-password'
  });
  page.syncCanSubmit();
  const previousWx = global.wx;
  global.wx = { showToast() {} };
  try {
    page.submit();
    await nextTurn();
    await nextTurn();
  } finally {
    global.wx = previousWx;
  }
  assert.equal(writes, 0);
  assert.match(page.data.errorText, /恢复标记/);
});

test('family task list resets opaque cursor on filter changes and ignores late responses after unload', async () => {
  const queries = [];
  let resolveLate;
  const app = {
    globalData: { token: `hefei.${'d'.repeat(32)}`, user: { role: 'parent' }, theme: 'mint', guardianPreviewEnabled: true },
    getThemePageStyle: () => '',
    guardianApi: {
      taskSummary: () => Promise.resolve({ ok: true, data: { pointRequests: { pending: 0, needsInfo: 0, total: 0 } } }),
      listPointRequests(query) {
        queries.push(structuredClone(query));
        return Promise.resolve({ ok: true, data: { pointRequests: [], nextCursor: null } });
      }
    }
  };
  const page = pageRuntime('pages/family-tasks/family-tasks.js', app, {});
  page._alive = true;
  page.data.nextCursor = 'opaque-cursor-must-not-be-parsed';
  page.data.operating = true;
  page.data.loadingMore = true;
  page.changeFilter({ currentTarget: { dataset: { status: 'rejected' } } });
  await nextTurn();
  assert.deepEqual(queries[0], { status: 'rejected', limit: 20 });
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.operating, false);
  assert.equal(page.data.loadingMore, false);

  app.guardianApi.listPointRequests = query => {
    queries.push(structuredClone(query));
    return new Promise(resolve => { resolveLate = resolve; });
  };
  page.loadFirstPage();
  page.onUnload();
  resolveLate({
    ok: true,
    data: { pointRequests: [{ id: 'late', status: 'pending', child: {}, rule: {} }], nextCursor: 'late' }
  });
  await nextTurn();
  assert.deepEqual(page.data.requests, []);
  assert.equal(page.data.nextCursor, null);
});

test('privacy page clears transient credentials, ambiguous intents, and export body on hide', () => {
  const app = {
    globalData: { token: '', user: null, theme: 'mint', guardianPreviewEnabled: false },
    getThemePageStyle: () => '',
    guardianApi: {}
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._dataExport = { child: { alias: '合成孩子' }, transactions: [{ id: 'synthetic' }] };
  page._pendingIntent = { body: { reauthAssertion: 'temporary-only' } };
  page.setData({
    withdrawPassword: 'temporary-only',
    rightsPassword: 'temporary-only',
    correctionAlias: '合成新别名',
    canRetryAction: true,
    exportSummary: { childAlias: '合成孩子' }
  });
  page.onHide();
  assert.equal(page._dataExport, null);
  assert.equal(page._pendingIntent, null);
  assert.equal(page.data.withdrawPassword, '');
  assert.equal(page.data.rightsPassword, '');
  assert.equal(page.data.correctionAlias, '');
  assert.equal(page.data.canRetryAction, false);
  assert.equal(page.data.exportSummary, null);
});

test('privacy mutations retain the same intent on malformed 2xx and accept deletion-pending withdrawal', async () => {
  let rightsAttempts = 0;
  const childId = 'child_privacy_mutation';
  const app = {
    globalData: { guardianDataRightsReviewRequired: null },
    clearDataRightsRecovery() {
      this.globalData.guardianDataRightsReviewRequired = null;
      return true;
    },
    guardianApi: {
      createDataRightsRequest(id, body) {
        rightsAttempts += 1;
        return Promise.resolve(rightsAttempts === 1
          ? { ok: true, data: { success: true, dataRightsRequest: { id: 'truncated' } } }
          : {
              ok: true,
              data: rightsMutationPayload({ childId: id, requestType: body.requestType })
            });
      },
      withdrawConsent(id) {
        return Promise.resolve({
          ok: true,
          data: consentMutationPayload({
            childId: id,
            consentStatus: 'withdrawn',
            privacyStatus: 'deletion_pending',
            privacyRevision: 7
          })
        });
      }
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 3;
  page.loadChildren = function() {};
  const rightsIntent = {
    kind: 'rights', childId, key: 'miniapp:rights-synthetic-key', generation: 3,
    body: {
      requestType: 'access', expectedRevision: 6,
      reauthAssertion: 'temporary-rights-assertion'
    }
  };
  page._pendingIntent = rightsIntent;
  page.performProtectedAction(rightsIntent);
  await nextTurn();
  assert.equal(page.data.canRetryAction, true);
  assert.equal(page.data.canAbandonAction, false);
  assert.equal(page._pendingIntent, rightsIntent);
  assert.equal(rightsIntent.body.reauthAssertion, 'temporary-rights-assertion');
  page.retryProtectedAction();
  await nextTurn();
  assert.equal(rightsAttempts, 2);
  assert.equal(page._pendingIntent, null);
  assert.equal(rightsIntent.body.reauthAssertion, '');

  const withdrawalIntent = {
    kind: 'withdraw', childId, key: 'miniapp:withdraw-synthetic-key', generation: 3,
    previousPrivacyStatus: 'deletion_pending',
    body: { expectedRevision: 7, reauthAssertion: 'temporary-withdraw-assertion' }
  };
  page._pendingIntent = withdrawalIntent;
  page.performProtectedAction(withdrawalIntent);
  await nextTurn();
  assert.equal(page._pendingIntent, null);
  assert.equal(withdrawalIntent.body.reauthAssertion, '');
  assert.match(page.data.successText, /授权已撤回/);
});

test('privacy rights write persists and verifies its recovery marker before dispatch', async () => {
  const events = [];
  const key = 'miniapp:rights-marker-before-dispatch-0123456789';
  const childId = 'child_rights_marker';
  let dispatchedAssertion = '';
  const app = {
    globalData: { guardianDataRightsReviewRequired: null },
    beginDataRightsRecovery(id, requestType, idempotencyKey) {
      events.push('marker');
      assert.equal(id, childId);
      assert.equal(requestType, 'access');
      assert.equal(idempotencyKey, key);
      this.globalData.guardianDataRightsReviewRequired = {
        childId: id, requestType, idempotencyKey, createdAt: 1
      };
      return this.globalData.guardianDataRightsReviewRequired;
    },
    clearDataRightsRecovery(idempotencyKey) {
      events.push('clear');
      assert.equal(idempotencyKey, key);
      this.globalData.guardianDataRightsReviewRequired = null;
      return true;
    },
    guardianApi: {
      createReauth: () => Promise.resolve({
        ok: true, data: { reauthAssertion: 'temporary-rights-assertion' }
      }),
      createIdempotencyKey: () => Promise.resolve(key),
      createDataRightsRequest(id, body, idempotencyKey) {
        events.push('post');
        assert.ok(app.globalData.guardianDataRightsReviewRequired, 'marker must exist before POST');
        assert.equal(id, childId);
        assert.equal(idempotencyKey, key);
        dispatchedAssertion = body.reauthAssertion;
        return Promise.resolve({
          ok: true,
          data: rightsMutationPayload({ childId: id, requestType: body.requestType })
        });
      }
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 4;
  page.loadChildren = function() { events.push('reload'); };
  page.setData({
    selectedChild: {
      id: childId, alias: '合成孩子', revision: 1,
      privacyState: { status: 'active' }
    },
    rightsPassword: 'synthetic-password',
    rightsTypeIndex: 0,
    currentRightsType: 'access'
  });
  page.beginProtectedAction('rights');
  await nextTurn();
  await nextTurn();
  assert.deepEqual(events, ['marker', 'post', 'clear', 'reload']);
  assert.equal(dispatchedAssertion, 'temporary-rights-assertion');
  assert.equal(app.globalData.guardianDataRightsReviewRequired, null);
  assert.equal(page.data.rightsReviewRequired, false);
  assert.match(page.data.successText, /请求已记录/);
});

test('privacy rights write never dispatches when durable marker storage fails', async () => {
  let writes = 0;
  const app = {
    globalData: { guardianDataRightsReviewRequired: null },
    beginDataRightsRecovery() {
      this.globalData.guardianDataRightsReviewRequired = { storageUnavailable: true };
      throw new Error('synthetic storage failure');
    },
    guardianApi: {
      createReauth: () => Promise.resolve({
        ok: true, data: { reauthAssertion: 'temporary-rights-assertion' }
      }),
      createIdempotencyKey: () => Promise.resolve(
        'miniapp:rights-storage-failure-0123456789abcdef'
      ),
      createDataRightsRequest() {
        writes += 1;
        return Promise.resolve({ ok: true });
      }
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 2;
  page.setData({
    selectedChild: {
      id: 'child_storage_failure', alias: '合成孩子', revision: 1,
      privacyState: { status: 'active' }
    },
    rightsPassword: 'synthetic-password',
    rightsTypeIndex: 0
  });
  page.beginProtectedAction('rights');
  await nextTurn();
  await nextTurn();
  assert.equal(writes, 0);
  assert.equal(page._pendingIntent, null);
  assert.equal(page.data.rightsReviewRequired, true);
  assert.match(page.data.rightsReviewText, /恢复标记无法持久化/);
});

test('first determinate rights failure clears its old scope after hide, but prior unknown does not', async () => {
  async function scenario(recoveryRequired) {
    var resolveWrite;
    var scopedClears = [];
    const app = {
      globalData: {},
      clearDataRightsRecoveryScope(actorId, familyId, key) {
        scopedClears.push({ actorId, familyId, key });
        return true;
      },
      guardianApi: {
        createDataRightsRequest: () => new Promise(resolve => { resolveWrite = resolve; })
      }
    };
    const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
    page._alive = true;
    page._visible = true;
    page._generation = 5;
    const intent = {
      kind: 'rights', childId: 'child_hidden_failure',
      key: 'miniapp:rights-hidden-failure-0123456789', generation: 5,
      recoveryActorId: 'adult_hidden_failure',
      recoveryFamilyId: 'family_hidden_failure',
      recoveryRequired,
      body: {
        requestType: 'access', expectedRevision: 1,
        reauthAssertion: 'temporary-hidden-assertion'
      }
    };
    page._pendingIntent = intent;
    page.performProtectedAction(intent);
    page.onHide();
    resolveWrite({
      ok: false,
      code: 'FEATURE_DISABLED',
      message: 'synthetic determinate failure',
      outcomeUnknown: false
    });
    await nextTurn();
    assert.equal(intent.body.reauthAssertion, '');
    return scopedClears;
  }

  assert.deepEqual(await scenario(false), [{
    actorId: 'adult_hidden_failure',
    familyId: 'family_hidden_failure',
    key: 'miniapp:rights-hidden-failure-0123456789'
  }]);
  assert.deepEqual(await scenario(true), []);
});

test('data-rights 401 clears the marker before deferred session invalidation', async () => {
  const values = new Map();
  const events = [];
  const wxApi = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; },
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
    request(options) {
      options.success({
        statusCode: 401,
        header: {},
        data: { success: false, code: 'AUTH_REQUIRED', message: 'synthetic expired session' }
      });
    },
    showToast() {}
  };
  const app = appRuntime(wxApi);
  const token = `hefei.${'7'.repeat(32)}`;
  const user = {
    id: 'adult_rights_401', familyId: 'family_rights_401', role: 'parent', name: '合成家长'
  };
  app.globalData.token = token;
  app.globalData.user = user;
  app._sessionGeneration = 1;
  app._sessionStore = {
    getAdultBearer: () => token,
    clear() { events.push('session-clear-storage'); }
  };

  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    const key = 'miniapp:rights-auth-failure-0123456789abcdef';
    app.beginDataRightsRecovery('child_rights_401', 'access', key);
    const originalClearMarker = app.clearDataRightsRecovery.bind(app);
    app.clearDataRightsRecovery = function(expectedKey) {
      events.push('marker-clear');
      return originalClearMarker(expectedKey);
    };
    const originalClearSession = app.clearSession.bind(app);
    app.clearSession = function() {
      events.push('session-clear');
      return originalClearSession();
    };
    app._initV2Foundation();
    const page = pageRuntime('pages/family-privacy/family-privacy.js', app, wxApi);
    page._alive = true;
    page._visible = true;
    page._generation = 8;
    const intent = {
      kind: 'rights', childId: 'child_rights_401', key, generation: 8,
      recoveryActorId: user.id,
      recoveryFamilyId: user.familyId,
      body: {
        requestType: 'access', expectedRevision: 1,
        reauthAssertion: 'temporary-auth-assertion'
      }
    };
    page._pendingIntent = intent;
    page.performProtectedAction(intent);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(events.indexOf('marker-clear') >= 0);
    assert.ok(events.indexOf('session-clear') > events.indexOf('marker-clear'));
    assert.equal(intent.body.reauthAssertion, '');
    app.globalData.token = token;
    app.globalData.user = user;
    assert.equal(app._restoreDataRightsReview(), null, 'relogin must not restore a rejected write');
  } finally {
    global.wx = previousWx;
  }
});

test('stale v2 result retains only original failure classification for scoped cleanup', async () => {
  var pending;
  const wxApi = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; },
    request(options) { pending = options; }
  };
  const app = appRuntime(wxApi);
  app.globalData.token = `hefei.${'1'.repeat(32)}`;
  app.globalData.user = { id: 'adult_old', familyId: 'family_old', role: 'parent' };
  app._sessionGeneration = 1;
  app._sessionStore = { getAdultBearer: () => app.globalData.token };
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    const promise = app.requestV2({
      path: '/api/v2/children/child_old/data-rights-requests',
      method: 'POST',
      auth: 'adult',
      idempotencyKey: 'miniapp:rights-stale-0123456789abcdef',
      body: { requestType: 'access' }
    });
    app.globalData.token = `hefei.${'2'.repeat(32)}`;
    app.globalData.user = { id: 'adult_new', familyId: 'family_new', role: 'parent' };
    app._sessionGeneration = 2;
    pending.success({
      statusCode: 403,
      header: {},
      data: { success: false, code: 'FEATURE_DISABLED', message: 'synthetic closed gate' }
    });
    const result = await promise;
    assert.equal(result.code, 'STALE_SESSION_RESPONSE');
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.staleOriginalOk, false);
    assert.equal(result.staleOriginalCode, 'FEATURE_DISABLED');
    assert.equal(result.staleOriginalOutcomeUnknown, false);
    assert.equal(Object.hasOwn(result, 'data'), false, 'old response body must not cross sessions');
  } finally {
    global.wx = previousWx;
  }
});

test('privacy rights unknown result survives hide, forbids abandon, and reconciles exact detail', async () => {
  const requestId = 'data_rights_0123456789abcdef0123456789abcdef';
  const marker = {
    childId: 'child_rights_reconcile',
    requestType: 'access',
    idempotencyKey: 'miniapp:rights-reconcile-0123456789abcdef',
    createdAt: 1
  };
  let clears = 0;
  let reloads = 0;
  let writeAttempts = 0;
  let operationReads = 0;
  const detail = rightsMutationPayload({
    childId: marker.childId, requestType: marker.requestType
  }).dataRightsRequest;
  detail.id = requestId;
  detail.auditTrail = [];
  const app = {
    globalData: { guardianDataRightsReviewRequired: marker },
    clearDataRightsRecovery(idempotencyKey) {
      clears += 1;
      assert.equal(idempotencyKey, marker.idempotencyKey);
      this.globalData.guardianDataRightsReviewRequired = null;
      return true;
    },
    guardianApi: {
      createDataRightsRequest: () => {
        writeAttempts += 1;
        return Promise.resolve(writeAttempts === 1 ? {
          ok: false,
          code: 'NETWORK_ERROR',
          message: 'synthetic network failure',
          outcomeUnknown: true
        } : {
          ok: false,
          code: 'FEATURE_DISABLED',
          message: 'synthetic gate closed after unknown result',
          outcomeUnknown: false
        });
      },
      getDataRightsOperation: () => {
        operationReads += 1;
        return Promise.resolve({
          ok: true,
          data: {
            dataRightsOperation: {
              operation: 'request-create',
              status: 'completed',
              completedAt: SYNTHETIC_TIME,
              dataRightsRequestId: requestId
            }
          }
        });
      },
      getDataRightsRequest: () => Promise.resolve({
        ok: true, data: { success: true, dataRightsRequest: detail }
      })
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 6;
  const intent = {
    kind: 'rights', childId: marker.childId, key: marker.idempotencyKey, generation: 6,
    body: {
      requestType: marker.requestType,
      expectedRevision: 1,
      reauthAssertion: 'temporary-rights-assertion'
    }
  };
  page._pendingIntent = intent;
  page.performProtectedAction(intent);
  await nextTurn();
  assert.equal(page.data.canRetryAction, true);
  assert.equal(page.data.canAbandonAction, false);
  page.retryProtectedAction();
  await nextTurn();
  assert.equal(writeAttempts, 2);
  assert.equal(clears, 0, 'a later determinate error cannot erase an earlier unknown outcome');
  assert.equal(page.data.canRetryAction, true);
  assert.equal(page._pendingIntent, intent);
  page.abandonProtectedRetry();
  assert.equal(page._pendingIntent, intent, 'data-rights retry cannot be abandoned for a new key');
  page.onHide();
  assert.equal(intent.body.reauthAssertion, '');
  assert.equal(page._pendingIntent, null);
  assert.equal(app.globalData.guardianDataRightsReviewRequired, marker);

  const restored = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  restored._alive = true;
  restored._visible = true;
  restored._generation = 9;
  restored.loadChildren = function() { reloads += 1; };
  restored.reconcileDataRightsOperation(marker, 9);
  restored.reconcileDataRightsOperation(marker, 9);
  await nextTurn();
  await nextTurn();
  assert.equal(clears, 1);
  assert.equal(operationReads, 1, 'reconciliation must be single-flight');
  assert.equal(reloads, 1);
  assert.equal(restored.data.rightsReviewRequired, false);
  assert.match(restored.data.successText, /确认上次资料权利请求提交完成/);
});

test('privacy rights not_found and local clear failure remain blocked without new writes', async () => {
  const marker = {
    childId: 'child_rights_blocked', requestType: 'export',
    idempotencyKey: 'miniapp:rights-blocked-0123456789abcdef', createdAt: 1
  };
  let writes = 0;
  let clears = 0;
  const app = {
    globalData: { guardianDataRightsReviewRequired: marker },
    clearDataRightsRecovery() { clears += 1; return false; },
    guardianApi: {
      getDataRightsOperation: () => Promise.resolve({
        ok: true,
        data: {
          dataRightsOperation: { operation: 'request-create', status: 'not_found' }
        }
      }),
      createDataRightsRequest() {
        writes += 1;
        return Promise.resolve({
          ok: true,
          data: rightsMutationPayload({ childId: marker.childId, requestType: marker.requestType })
        });
      }
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 7;
  page.reconcileDataRightsOperation(marker, 7);
  await nextTurn();
  assert.equal(page.data.rightsReviewRequired, true);
  assert.match(page.data.rightsReviewText, /暂未找到/);
  page.setData({
    selectedChild: { id: marker.childId, alias: '合成孩子', revision: 1 },
    rightsPassword: 'synthetic-password'
  });
  page.startRightsRequest();
  assert.equal(writes, 0);
  assert.equal(clears, 0);

  const intent = {
    kind: 'rights', childId: marker.childId, key: marker.idempotencyKey, generation: 7,
    body: {
      requestType: marker.requestType,
      expectedRevision: 1,
      reauthAssertion: 'temporary-rights-assertion'
    }
  };
  page.performProtectedAction(intent);
  await nextTurn();
  assert.equal(clears, 1);
  assert.equal(page.data.rightsReviewRequired, true);
  assert.equal(page.data.successText, '');
  assert.match(page.data.errorText, /恢复标记清理失败/);
});

test('unresolved data-rights marker does not block guardian consent withdrawal', async () => {
  const marker = {
    childId: 'child_withdraw_safety', requestType: 'access',
    idempotencyKey: 'miniapp:rights-before-withdraw-0123456789', createdAt: 1
  };
  let withdrawals = 0;
  const app = {
    globalData: { guardianDataRightsReviewRequired: marker },
    guardianApi: {
      createReauth: () => Promise.resolve({
        ok: true, data: { reauthAssertion: 'temporary-withdraw-assertion' }
      }),
      createIdempotencyKey: () => Promise.resolve(
        'miniapp:withdraw-safety-0123456789abcdef'
      ),
      withdrawConsent(id) {
        withdrawals += 1;
        return Promise.resolve({
          ok: true,
          data: consentMutationPayload({
            childId: id,
            consentStatus: 'withdrawn',
            privacyStatus: 'processing_blocked',
            privacyRevision: 2
          })
        });
      }
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 3;
  page.loadChildren = function() {};
  const abandonedRightsIntent = {
    kind: 'rights', body: { reauthAssertion: 'temporary-old-rights-assertion' }
  };
  page._pendingIntent = abandonedRightsIntent;
  page.setData({
    canRetryAction: true,
    canAbandonAction: false,
    rightsReviewRequired: true,
    rightsReviewText: '仍在核对',
    withdrawPassword: 'synthetic-password',
    selectedChild: {
      id: marker.childId,
      revision: 1,
      privacyState: { status: 'active' }
    }
  });
  page.beginProtectedAction('withdraw');
  await nextTurn();
  await nextTurn();
  assert.equal(abandonedRightsIntent.body.reauthAssertion, '');
  assert.equal(withdrawals, 1);
  assert.equal(app.globalData.guardianDataRightsReviewRequired, marker);
  assert.equal(page.data.rightsReviewRequired, true);
  assert.match(page.data.successText, /授权已撤回/);
});

test('completed rights reconciliation defers reload while consent withdrawal is in flight', async () => {
  const marker = {
    childId: 'child_reconcile_withdraw', requestType: 'access',
    idempotencyKey: 'miniapp:rights-reconcile-withdraw-0123456789', createdAt: 1
  };
  const requestId = 'data_rights_fedcba9876543210fedcba9876543210';
  let resolveDetail;
  let resolveWithdrawal;
  let reloads = 0;
  const detail = rightsMutationPayload({
    childId: marker.childId, requestType: marker.requestType
  }).dataRightsRequest;
  detail.id = requestId;
  detail.auditTrail = [];
  const app = {
    globalData: { guardianDataRightsReviewRequired: marker },
    clearDataRightsRecovery() {
      this.globalData.guardianDataRightsReviewRequired = null;
      return true;
    },
    guardianApi: {
      getDataRightsOperation: () => Promise.resolve({
        ok: true,
        data: {
          dataRightsOperation: {
            operation: 'request-create', status: 'completed',
            completedAt: SYNTHETIC_TIME, dataRightsRequestId: requestId
          }
        }
      }),
      getDataRightsRequest: () => new Promise(resolve => { resolveDetail = resolve; }),
      withdrawConsent: () => new Promise(resolve => { resolveWithdrawal = resolve; })
    }
  };
  const page = pageRuntime('pages/family-privacy/family-privacy.js', app, {});
  page._alive = true;
  page._visible = true;
  page._generation = 12;
  page.loadChildren = function() { reloads += 1; };
  page.reconcileDataRightsOperation(marker, 12);
  await nextTurn();
  assert.equal(typeof resolveDetail, 'function');

  const withdrawalIntent = {
    kind: 'withdraw', childId: marker.childId,
    key: 'miniapp:withdraw-during-reconcile-0123456789', generation: 12,
    previousPrivacyStatus: 'active',
    body: { expectedRevision: 1, reauthAssertion: 'temporary-withdraw-assertion' }
  };
  page._pendingIntent = withdrawalIntent;
  page.performProtectedAction(withdrawalIntent);
  assert.equal(page.data.operating, true);

  resolveDetail({ ok: true, data: { success: true, dataRightsRequest: detail } });
  await nextTurn();
  assert.equal(reloads, 0, 'reconciliation must not invalidate an in-flight withdrawal');
  assert.equal(page._generation, 12);
  assert.equal(page._pendingIntent, withdrawalIntent);
  assert.equal(page._needsReload, true);

  resolveWithdrawal({
    ok: true,
    data: consentMutationPayload({
      childId: marker.childId,
      consentStatus: 'withdrawn',
      privacyStatus: 'processing_blocked',
      privacyRevision: 2
    })
  });
  await nextTurn();
  assert.equal(withdrawalIntent.body.reauthAssertion, '');
  assert.equal(page._pendingIntent, null);
  assert.equal(reloads, 1);
  assert.match(page.data.successText, /授权已撤回/);
});

test('device page reuses one create key after an ambiguous network result and clears pairing secrets on hide', async () => {
  const writes = [];
  let attempt = 0;
  const app = {
    globalData: {
      token: `hefei.${'e'.repeat(32)}`, user: { role: 'parent' }, theme: 'mint',
      guardianPreviewEnabled: true, guardianDeviceCreateIntent: null
    },
    getThemePageStyle: () => '',
    beginDevicePairingRecovery(childId, key) {
      this.globalData.guardianDeviceCreateIntent = { key, body: { childId } };
      return this.globalData.guardianDeviceCreateIntent;
    },
    clearDevicePairingRecovery(key) {
      if (this.globalData.guardianDeviceCreateIntent
          && this.globalData.guardianDeviceCreateIntent.key === key) {
        this.globalData.guardianDeviceCreateIntent = null;
        return true;
      }
      return false;
    },
    guardianApi: {
      createIdempotencyKey: () => Promise.resolve('miniapp:00112233445566778899aabbccddeeff'),
      createPairing(body, key) {
        writes.push({ body: structuredClone(body), key });
        attempt += 1;
        if (attempt === 1) return Promise.resolve({ ok: false, code: 'NETWORK_ERROR' });
        return Promise.resolve({
          ok: true,
          data: {
            pairing: {
              id: 'pair_synthetic', childId: body.childId, status: 'pending', revision: 1,
              expiresAt: '2026-08-24T00:10:00.000Z', createdAt: '2026-08-24T00:00:00.000Z'
            },
            shortCode: '123456',
            pairingChallenge: 'x'.repeat(43)
          }
        });
      }
    }
  };
  const page = pageRuntime('pages/device-management/device-management.js', app, { showToast() {} });
  page._alive = true;
  page._visible = true;
  page._epoch = 0;
  page.setData({ children: [{ id: 'child_synthetic', alias: '合成孩子' }], childIndex: 0 });
  page.createPairing();
  await nextTurn();
  await nextTurn();
  assert.equal(writes.length, 1);
  assert.equal(page.data.canRetryCreate, true);
  page.createPairing();
  await nextTurn();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, writes[1].key);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(page.data.shortCode, '123456');
  assert.equal(page._pairingChallenge.length, 43);
  page.onHide();
  assert.equal(page.data.shortCode, '');
  assert.equal(page._pairingChallenge, '');
  assert.equal(page._pairingCreateIntent, null);
});

test('device creation survives hide with the same key and revision zero sessions can be revoked', async () => {
  let resolveFirstCreate;
  const createKeys = [];
  const revoked = [];
  const app = {
    globalData: {
      token: `hefei.${'3'.repeat(32)}`,
      user: { role: 'parent' },
      theme: 'mint',
      guardianPreviewEnabled: true,
      guardianDeviceCreateIntent: null
    },
    getThemePageStyle: () => '',
    beginDevicePairingRecovery(childId, key) {
      this.globalData.guardianDeviceCreateIntent = { key, body: { childId } };
      return this.globalData.guardianDeviceCreateIntent;
    },
    clearDevicePairingRecovery(key) {
      if (this.globalData.guardianDeviceCreateIntent
          && this.globalData.guardianDeviceCreateIntent.key === key) {
        this.globalData.guardianDeviceCreateIntent = null;
        return true;
      }
      return false;
    },
    guardianApi: {
      createIdempotencyKey: () => Promise.resolve('miniapp:aaaabbbbccccddddeeeeffff00001111'),
      createPairing(body, key) {
        createKeys.push(key);
        if (createKeys.length === 1) return new Promise(resolve => { resolveFirstCreate = resolve; });
        return Promise.resolve({
          ok: true,
          data: {
            pairing: {
              id: 'pair_recovered', childId: body.childId, status: 'pending', revision: 0,
              expiresAt: '2026-08-24T00:10:00.000Z'
            },
            shortCode: '654321', pairingChallenge: 'y'.repeat(43)
          }
        });
      },
      listChildren: () => Promise.resolve({
        ok: true,
        data: {
          children: [{
            child: { id: 'child_synthetic', alias: '合成孩子' },
            privacyState: { status: 'active', revision: 0 },
            latestConsent: { status: 'active', version: 1 }
          }]
        }
      }),
      listDevices: () => Promise.resolve({ ok: true, data: { devices: [] } }),
      revokeDeviceSession(id, body, key) {
        revoked.push({ id, body: structuredClone(body), key });
        return Promise.resolve({
          ok: true,
          data: { session: { id, status: 'revoked', revision: body.expectedRevision + 1 } }
        });
      }
    }
  };
  const wxApi = {
    showToast() {},
    showModal(options) { options.success({ confirm: true }); }
  };
  const page = pageRuntime('pages/device-management/device-management.js', app, wxApi);
  page._alive = true;
  page._visible = true;
  page._loaded = true;
  page._epoch = 0;
  page.setData({ children: [{ id: 'child_synthetic', alias: '合成孩子' }], childIndex: 0, isAdult: true, previewEnabled: true });
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    page.createPairing();
    await nextTurn();
    await nextTurn();
    assert.equal(createKeys.length, 1);
    page.onHide();
    assert.equal(app.globalData.guardianDeviceCreateIntent.key, createKeys[0]);
    page.onShow();
    await nextTurn();
    assert.equal(page.data.canRetryCreate, true);
    page.createPairing();
    await nextTurn();
    assert.equal(createKeys.length, 2);
    assert.equal(createKeys[0], createKeys[1]);
    resolveFirstCreate({ ok: false, code: 'NETWORK_ERROR', outcomeUnknown: true });
    await nextTurn();

    page.setData({ operating: false });
    page.revokeSession({ currentTarget: { dataset: { id: 'session_zero', revision: 0 } } });
    await nextTurn();
    await nextTurn();
    assert.equal(revoked.length, 1);
    assert.deepEqual(revoked[0].body, { expectedRevision: 0 });
  } finally {
    global.wx = previousWx;
  }
});

test('device and session revocation keep their exact mutation key on malformed 2xx', async () => {
  let deviceAttempts = 0;
  let sessionAttempts = 0;
  const marker = {
    key: 'miniapp:pairing-recovery-key', body: { childId: 'child_device_mutation' }
  };
  const app = {
    globalData: { guardianDeviceCreateIntent: marker },
    clearDevicePairingRecovery(expectedKey) {
      if (this.globalData.guardianDeviceCreateIntent
          && this.globalData.guardianDeviceCreateIntent.key === expectedKey) {
        this.globalData.guardianDeviceCreateIntent = null;
        return true;
      }
      return false;
    },
    guardianApi: {
      revokeDevice(id, body) {
        deviceAttempts += 1;
        return Promise.resolve(deviceAttempts === 1
          ? { ok: true, data: { success: true, device: { id, status: 'revoked' } } }
          : {
              ok: true,
              data: {
                success: true,
                device: {
                  id,
                  childId: 'child_device_mutation',
                  publicId: 'synthetic-public-device',
                  alias: '合成设备',
                  publicKey: {
                    algorithm: 'ECDSA_P256_SHA256', sha256: 'f'.repeat(64)
                  },
                  status: 'revoked', revision: body.expectedRevision + 1,
                  claimedAt: SYNTHETIC_TIME, revokedAt: SYNTHETIC_TIME
                }
              }
            });
      },
      revokeDeviceSession(id, body) {
        sessionAttempts += 1;
        return Promise.resolve(sessionAttempts === 1
          ? { ok: true, data: { success: true, session: { id, status: 'active' } } }
          : {
              ok: true,
              data: {
                success: true,
                session: { id, status: 'revoked', revision: body.expectedRevision + 1 }
              }
            });
      },
      listDevices: () => Promise.resolve({ ok: true, data: { devices: [] } })
    }
  };
  const page = pageRuntime('pages/device-management/device-management.js', app, {});
  page._alive = true;
  page._visible = true;
  page._epoch = 0;
  page._pairingCreateIntent = { key: marker.key, body: marker.body, epoch: 0 };
  page.setData({
    pairing: {
      id: 'pair_device_mutation', childId: 'child_device_mutation', status: 'claimed',
      claimedDevice: { id: 'device_mutation' }
    }
  });
  const deviceIntent = {
    type: 'device', id: 'device_mutation', key: 'miniapp:device-mutation-key',
    epoch: 0, body: { expectedRevision: 2 }
  };
  page.performMutation(deviceIntent);
  await nextTurn();
  assert.equal(page.data.canRetryMutation, true);
  assert.equal(page._mutationIntent, deviceIntent);
  assert.equal(app.globalData.guardianDeviceCreateIntent, marker);
  page.retryMutation();
  await nextTurn();
  assert.equal(deviceAttempts, 2);
  assert.equal(page._mutationIntent, null);
  assert.equal(app.globalData.guardianDeviceCreateIntent, null);
  assert.equal(page.data.pairing, null);

  const sessionIntent = {
    type: 'session', id: 'session_mutation', key: 'miniapp:session-mutation-key',
    epoch: 0, body: { expectedRevision: 4 }
  };
  page.performMutation(sessionIntent);
  await nextTurn();
  assert.equal(page.data.canRetryMutation, true);
  assert.equal(page._mutationIntent, sessionIntent);
  page.retryMutation();
  await nextTurn();
  assert.equal(sessionAttempts, 2);
  assert.equal(page._mutationIntent, null);
  assert.equal(page.data.canRetryMutation, false);
});

test('legacy requests discard old-family responses and stale authorization failures', async () => {
  const requests = [];
  const wxApi = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; },
    request(options) { requests.push(options); },
    showToast() {}
  };
  const app = appRuntime(wxApi);
  const tokenA = `hefei.${'4'.repeat(32)}`;
  const tokenB = `hefei.${'5'.repeat(32)}`;
  const tokenC = `hefei.${'6'.repeat(32)}`;
  app._sessionGeneration = 1;
  app.globalData.token = tokenA;
  app.globalData.user = { id: 'adult_a', role: 'parent', familyId: 'family_a' };
  app._sessionStore = {
    commit(token, user) { return { token, user }; },
    clear() {}
  };
  app._v2Client = {};
  app.guardianApi = {};

  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    const pointsPromise = app.loadPoints();
    app.commitSession(tokenB, { id: 'adult_b', role: 'parent', familyId: 'family_b' });
    app.globalData.points = { child_b: 9 };
    requests[0].success({
      statusCode: 200,
      data: { success: true, points: { child_a: 99 }, user: { id: 'adult_a', role: 'parent', familyId: 'family_a' } }
    });
    const stalePoints = await pointsPromise;
    assert.equal(stalePoints.code, 'STALE_SESSION_RESPONSE');
    assert.equal(app.globalData.token, tokenB);
    assert.deepEqual(app.globalData.points, { child_b: 9 });

    const oldRequest = app.fetchAPI('/api/config');
    app.commitSession(tokenC, { id: 'adult_c', role: 'parent', familyId: 'family_c' });
    requests[1].success({ statusCode: 401, data: { success: false, code: 'AUTH_REQUIRED' } });
    const staleFailure = await oldRequest;
    assert.equal(staleFailure.code, 'STALE_SESSION_RESPONSE');
    assert.equal(app.globalData.token, tokenC, 'old 401 must not clear the replacement session');
  } finally {
    global.wx = previousWx;
  }
});

test('family approval double tap dispatches one write and carries the current server revision', async () => {
  let approveCalls = 0;
  let resolveApprove;
  const app = {
    globalData: { token: `hefei.${'f'.repeat(32)}`, user: { role: 'parent' }, theme: 'mint', guardianPreviewEnabled: true },
    getThemePageStyle: () => '',
    guardianApi: {
      createIdempotencyKey: () => Promise.resolve('miniapp:ffeeddccbbaa99887766554433221100'),
      approvePointRequest(id, body, key) {
        approveCalls += 1;
        assert.equal(id, 'point_request_0123456789abcdef0123456789abcdef');
        assert.deepEqual(body, { expectedRevision: 9, approvedPoints: 8 });
        assert.match(key, /^miniapp:/);
        return new Promise(resolve => { resolveApprove = resolve; });
      },
      taskSummary: () => Promise.resolve({ ok: true, data: { pointRequests: { pending: 0, needsInfo: 0, total: 0 } } }),
      listPointRequests: () => Promise.resolve({ ok: true, data: { pointRequests: [], nextCursor: null } })
    }
  };
  const wxApi = {
    showModal(options) { options.success({ confirm: true }); },
    showToast() {}
  };
  const page = pageRuntime('pages/family-tasks/family-tasks.js', app, wxApi);
  page._alive = true;
  page._visible = true;
  page._generation = 1;
  page.setData({
    selected: {
      id: 'point_request_0123456789abcdef0123456789abcdef',
      revision: 9,
      status: 'pending',
      rule: { minPoints: 1, maxPoints: 10 },
      child: { alias: '合成孩子' }
    },
    approvedPoints: '8',
    actionNote: ''
  });
  const event = { currentTarget: { dataset: { action: 'approve' } } };
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    page.decide(event);
    page.decide(event);
    await nextTurn();
    assert.equal(approveCalls, 1);
    resolveApprove({
      ok: true,
      data: { pointRequest: pointRequestPayload({ status: 'pending', revision: 9 }) }
    });
    await nextTurn();
    assert.equal(page.data.canRetryAction, true);
    assert.ok(page._actionIntent, 'malformed success must retain the exact action intent');
    page.retryAction();
    await nextTurn();
    assert.equal(approveCalls, 2);
    resolveApprove({
      ok: true,
      data: {
        pointRequest: pointRequestPayload({
          status: 'approved', revision: 10, approvedPoints: 8
        })
      }
    });
    await nextTurn();
    assert.equal(page.data.operating, false);
    assert.equal(page.data.canRetryAction, false);
    assert.equal(page._actionIntent, null);
  } finally {
    global.wx = previousWx;
  }
});

test('new guardian WXML bindings resolve and withdrawal visibility follows own consent, not privacy activity', () => {
  const pages = [
    'guardian-consent', 'device-management', 'family-tasks', 'family-privacy', 'legal-document'
  ];
  for (const name of pages) {
    const markup = fs.readFileSync(path.join(MINIAPP, 'pages', name, `${name}.wxml`), 'utf8');
    const source = fs.readFileSync(path.join(MINIAPP, 'pages', name, `${name}.js`), 'utf8');
    const handlers = new Set(Array.from(
      markup.matchAll(/(?:bind|catch)(?::?[a-z-]+)?="([A-Za-z_$][A-Za-z0-9_$]*)"/g),
      match => match[1]
    ));
    for (const handler of handlers) {
      assert.match(source, new RegExp(`${handler}\\s*:\\s*function`), `${name} misses ${handler}`);
    }
  }
  const privacyMarkup = fs.readFileSync(
    path.join(MINIAPP, 'pages/family-privacy/family-privacy.wxml'),
    'utf8'
  );
  assert.match(privacyMarkup, /selectedChild\.consent\.status === 'active'/);
  assert.doesNotMatch(
    privacyMarkup,
    /selectedChild\.privacyState\.status === 'active'[^\n]*撤回监护授权/
  );
});

test('all guardian pages are registered and production navigation exposes privacy safety only', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MINIAPP, 'app.json'), 'utf8'));
  for (const page of [
    'pages/family-privacy/family-privacy',
    'pages/guardian-consent/guardian-consent',
    'pages/device-management/device-management',
    'pages/family-tasks/family-tasks',
    'pages/legal-document/legal-document'
  ]) {
    assert.ok(manifest.pages.includes(page), `${page} is not registered`);
  }
  const mine = fs.readFileSync(path.join(MINIAPP, 'pages/mine/mine.wxml'), 'utf8');
  assert.match(mine, /wx:if="\{\{isAdult\}\}" bindtap="goFamilyPrivacy"/);
  assert.match(mine, /wx:if="\{\{isAdult && guardianPreviewEnabled\}\}" bindtap="goFamilyTasks"/);
  assert.match(mine, /wx:if="\{\{isAdult && guardianPreviewEnabled\}\}" bindtap="goDeviceManagement"/);
  const environment = fresh('utils/runtime-environment.js');
  assert.equal(environment.resolve('release').guardianPreviewEnabled, false);
  assert.equal(environment.resolve('develop').guardianPreviewEnabled, false);
  assert.equal(environment.resolve('trial').guardianPreviewEnabled, false);
});
