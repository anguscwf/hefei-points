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
  return Object.assign({}, definition, {
    data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, update); }
  });
}

function legalEvidence(type = 'privacyPolicy', marker = 'a') {
  return { type, version: 'privacy-v1', sha256: marker.repeat(64) };
}

function legalUrl(evidence) {
  const slugs = {
    privacyPolicy: 'privacy-policy',
    childPersonalInformationRules: 'child-personal-information-rules',
    childUserAgreement: 'child-user-agreement',
    sensitiveInformationNotice: 'sensitive-information-notice',
    guardianRelationDeclaration: 'guardian-relation-declaration'
  };
  return `https://hefeijifen.cn/legal/${slugs[evidence.type]}/${evidence.version}/${evidence.sha256}.html`;
}

test('法律 URL 精确绑定环境、文本类型、版本与 SHA-256 叶子路径', () => {
  const validator = fresh('utils/legal-public-url.js');
  const environment = fresh('utils/runtime-environment.js').resolve('release');
  const evidence = legalEvidence();
  const canonical = legalUrl(evidence);
  assert.equal(validator.safePublicUrl(canonical, environment, evidence), canonical);

  const attacks = [
    'http://hefeijifen.cn/legal/privacy-policy/privacy-v1/' + 'a'.repeat(64) + '.html',
    'https://evil.invalid/legal/privacy-policy/privacy-v1/' + 'a'.repeat(64) + '.html',
    'https://hefeijifen.cn.evil.invalid/legal/privacy-policy/privacy-v1/' + 'a'.repeat(64) + '.html',
    'https://user@hefeijifen.cn/legal/privacy-policy/privacy-v1/' + 'a'.repeat(64) + '.html',
    'https://hefeijifen.cn:443/legal/privacy-policy/privacy-v1/' + 'a'.repeat(64) + '.html',
    'https://hefeijifen.cn/legal/',
    'https://hefeijifen.cn/legal/open-redirect',
    canonical + '?next=https://evil.invalid',
    canonical + '#different-text',
    canonical.replace('/privacy-policy/', '/child-user-agreement/'),
    canonical.replace('/privacy-v1/', '/privacy-v2/'),
    canonical.replace(/a{64}/, 'b'.repeat(64)),
    canonical.replace('/privacy-v1/', '/%2e%2e/'),
    canonical.replace('/privacy-v1/', '/..\\privacy-v1/')
  ];
  for (const value of attacks) {
    assert.equal(validator.safePublicUrl(value, environment, evidence), '', value);
  }
  assert.equal(validator.safePublicUrl(canonical, environment, {
    ...evidence, type: 'childUserAgreement'
  }), '');
  assert.equal(validator.safePublicUrl(canonical, environment, null), '');
});

test('法律 web-view 仅呈现契约匹配的文本并在加载错误时清 URL', async () => {
  const evidence = legalEvidence();
  const canonical = legalUrl(evidence);
  const app = {
    globalData: { theme: 'mint' },
    getThemePageStyle: () => '',
    getRuntimeEnvironment: () => fresh('utils/runtime-environment.js').resolve('release'),
    guardianApi: {
      currentLegalTexts: () => Promise.resolve({
        ok: true,
        data: {
          texts: {
            privacyPolicy: {
              version: evidence.version,
              sha256: evidence.sha256,
              publicUrl: canonical
            }
          }
        }
      })
    }
  };
  const titles = [];
  const wxApi = {
    setNavigationBarTitle(value) { titles.push(value.title); }
  };
  const page = pageRuntime('pages/legal-document/legal-document.js', app, wxApi);
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    page.onLoad({ type: 'privacyPolicy' });
    await nextTurn();
    assert.equal(page.data.publicUrl, canonical);
    assert.deepEqual(titles, ['隐私政策']);

    page.onWebViewError({ detail: { errMsg: canonical + '?secret=must-not-leak' } });
    assert.equal(page.data.publicUrl, '');
    assert.equal(page.data.errorText, '公开文本打开失败，请稍后重新加载');
    assert.equal(page.data.errorText.includes('secret'), false);

    page.data.errorText = '卸载前状态';
    page.onUnload();
    page.onWebViewError({ detail: { errMsg: 'late synthetic error' } });
    assert.equal(page.data.errorText, '卸载前状态');
  } finally {
    global.wx = previousWx;
  }
});

test('设备 SHA-256 指纹完整显示八组且非法值不展示', () => {
  const viewModel = fresh('utils/guardian-page.js');
  const fingerprint = 'Ab'.repeat(32);
  const formatted = viewModel.formatSha256Fingerprint(fingerprint);
  assert.equal(formatted.split(' ').length, 8);
  assert.equal(formatted.replace(/ /g, ''), fingerprint.toLowerCase());
  assert.equal(formatted.includes('…'), false);
  assert.equal(viewModel.formatSha256Fingerprint('a'.repeat(63)), '未提供');
  assert.equal(viewModel.formatSha256Fingerprint('g'.repeat(64)), '未提供');
  assert.equal(
    viewModel.decorateDevice({ publicKey: { sha256: fingerprint } }).fingerprint,
    formatted
  );

  const source = fs.readFileSync(
    path.join(MINIAPP, 'pages/device-management/device-management.js'), 'utf8'
  );
  assert.match(source, /deviceFingerprint:\s*viewModel\.formatSha256Fingerprint/);
  assert.doesNotMatch(source, /publicKey\.sha256\.slice\(/);
});

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getStorageSync(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''; },
    setStorageSync(key, value) { values[key] = value; }
  };
}

test('资料权利恢复存储跨重启、隔离作用域且绝不持久化请求秘密', () => {
  const recovery = fresh('utils/data-rights-recovery.js');
  const storage = memoryStorage();
  let user = { id: 'adult_recovery', familyId: 'family_recovery', role: 'parent' };
  const options = { storage, getUser: () => user };
  const store = recovery.createRecoveryStore(options);
  const key = 'miniapp:rights-recovery-0123456789abcdef';
  const marker = store.begin('child_recovery', 'correct', key);
  assert.deepEqual(marker, {
    childId: 'child_recovery',
    requestType: 'correct',
    idempotencyKey: key,
    createdAt: marker.createdAt
  });
  assert.deepEqual(recovery.createRecoveryStore(options).current(), marker);

  const serialized = Object.values(storage.values).join('');
  for (const forbidden of [
    'password', 'reauthAssertion', 'expectedRevision', 'expectedValue',
    'correctionAlias', 'requestBody', 'responseBody'
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  user = { id: 'other_adult', familyId: 'family_recovery', role: 'parent' };
  assert.equal(store.current(), null);
  user = { id: 'adult_recovery', familyId: 'other_family', role: 'parent' };
  assert.equal(store.current(), null);
  user = { id: 'adult_recovery', familyId: 'family_recovery', role: 'parent' };
  assert.throws(
    () => store.begin('child_other', 'access', 'miniapp:another-rights-key-0123456789'),
    /already pending/
  );
  assert.equal(store.clear(key), true);
  assert.equal(store.clear(key), true, 'clearing an already-cleared matching scope is idempotent');
  assert.equal(recovery.createRecoveryStore(options).current(), null);
});

test('资料权利恢复存储对腐坏、静默写失败和容量耗尽保持 fail-closed', () => {
  const recovery = fresh('utils/data-rights-recovery.js');
  let user = { id: 'adult_00', familyId: 'family_00', role: 'admin' };
  const storage = memoryStorage();
  const store = recovery.createRecoveryStore({ storage, getUser: () => user });
  for (let index = 0; index < 32; index += 1) {
    user = {
      id: `adult_${String(index).padStart(2, '0')}`,
      familyId: `family_${String(index).padStart(2, '0')}`,
      role: index % 2 ? 'parent' : 'admin'
    };
    store.begin(
      `child_${String(index).padStart(2, '0')}`,
      index % 2 ? 'access' : 'export',
      `miniapp:rights-capacity-${String(index).padStart(2, '0')}-0123456789abcdef`
    );
  }
  const before = Object.values(storage.values).join('');
  user = { id: 'adult_33', familyId: 'family_33', role: 'parent' };
  assert.throws(
    () => store.begin('child_33', 'delete', 'miniapp:rights-capacity-33-0123456789abcdef'),
    /full/
  );
  assert.equal(Object.values(storage.values).join(''), before, 'full storage must not evict records');

  const corrupt = memoryStorage({ hefei_guardian_data_rights_recovery_v1: '{bad json' });
  assert.throws(
    () => recovery.createRecoveryStore({ storage: corrupt, getUser: () => user }).current(),
    /cannot be read/
  );
  const silent = {
    getStorageSync() { return ''; },
    setStorageSync() {}
  };
  assert.throws(
    () => recovery.createRecoveryStore({ storage: silent, getUser: () => user })
      .begin('child_33', 'access', 'miniapp:rights-silent-write-0123456789abcdef'),
    /verification failed/
  );
  user = { id: 'child_actor', familyId: 'family_33', role: 'child' };
  assert.throws(
    () => recovery.createRecoveryStore({ storage: memoryStorage(), getUser: () => user })
      .begin('child_33', 'access', 'miniapp:rights-child-role-0123456789abcdef'),
    /invalid/
  );
});
