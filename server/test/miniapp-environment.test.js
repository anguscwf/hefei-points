const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MINIAPP = path.join(ROOT, 'hefei-miniapp');
const PRODUCTION_API_BASE = 'https://hefeijifen.cn';

function fresh(relativePath) {
  const filename = path.join(MINIAPP, relativePath);
  delete require.cache[require.resolve(filename)];
  return require(filename);
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

async function withWx(wxApi, work) {
  const previousWx = global.wx;
  global.wx = wxApi;
  try {
    return await work();
  } finally {
    global.wx = previousWx;
  }
}

function wxRuntime(envVersion, calls) {
  const storage = Object.create(null);
  return {
    getAccountInfoSync() {
      return { miniProgram: { envVersion } };
    },
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '';
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    removeStorageSync(key) {
      delete storage[key];
    },
    request(options) {
      calls.push(options);
      options.success({
        statusCode: 200,
        header: { 'X-Request-Id': 'synthetic-environment-test' },
        data: { success: true, texts: {} }
      });
    }
  };
}

test('develop、trial 与未知环境当前均远离生产源并保持关闭', () => {
  const environment = fresh('utils/runtime-environment.js');
  for (const envVersion of ['develop', 'trial', 'unknown']) {
    const profile = environment.resolve(envVersion);
    assert.equal(profile.environmentReady, false, envVersion);
    assert.equal(profile.production, false, envVersion);
    assert.equal(profile.guardianPreviewEnabled, false, envVersion);
    assert.notEqual(profile.apiBase, PRODUCTION_API_BASE, envVersion);
    assert.equal(environment.isProductionOrigin(profile.apiBase), false, envVersion);
    assert.equal(Object.isFrozen(profile), true, envVersion);
  }
});

test('release 环境只绑定精确生产源', () => {
  const environment = fresh('utils/runtime-environment.js');
  const profile = environment.resolve('release');
  assert.equal(profile.envVersion, 'release');
  assert.equal(profile.apiBase, PRODUCTION_API_BASE);
  assert.equal(profile.environmentReady, true);
  assert.equal(profile.production, true);
  assert.equal(profile.guardianPreviewEnabled, false);
  assert.equal(environment.isProductionOrigin(profile.apiBase), true);
  assert.equal(Object.isFrozen(profile), true);
});

test('生产 host 的大小写、默认端口与尾点等价写法仍被识别并禁止用于预览', () => {
  const environment = fresh('utils/runtime-environment.js');
  for (const origin of [
    'https://HEFEIJIFEN.CN',
    'https://hefeijifen.cn:443',
    'https://hefeijifen.cn.'
  ]) {
    assert.equal(environment.isProductionOrigin(origin), true, origin);
  }
  assert.equal(environment.isProductionOrigin('https://synthetic-api.invalid'), false);
});

for (const envVersion of ['develop', 'trial', 'unknown']) {
  test(`${envVersion} 环境的 legacy/v2 请求均在本地拒绝且不调用 wx.request`, async () => {
    const calls = [];
    const wxApi = wxRuntime(envVersion, calls);
    const app = appRuntime(wxApi);
    await withWx(wxApi, async () => {
      const legacy = await app.fetchAPI('/api/config');
      const v2 = await app.requestV2({
        path: '/api/v2/legal-texts/current',
        auth: 'public'
      });
      assert.equal(legacy.code, 'API_ENVIRONMENT_INVALID');
      assert.equal(v2.code, 'API_ENVIRONMENT_INVALID');
      assert.equal(v2.outcomeUnknown, false);
    });
    assert.equal(calls.length, 0);
  });
}

test('缺失、异常或畸形的 envVersion 均 fail closed 且零请求', async () => {
  const scenarios = [
    {},
    { getAccountInfoSync() { throw new Error('synthetic account info failure'); } },
    { getAccountInfoSync() { return null; } },
    { getAccountInfoSync() { return { miniProgram: { envVersion: 'production' } }; } }
  ];
  for (const wxApi of scenarios) {
    let requests = 0;
    wxApi.request = function() { requests += 1; };
    const app = appRuntime(wxApi);
    await withWx(wxApi, async () => {
      const legacy = await app.fetchAPI('/api/config');
      const v2 = await app.requestV2({
        path: '/api/v2/legal-texts/current',
        auth: 'public'
      });
      assert.equal(legacy.code, 'API_ENVIRONMENT_INVALID');
      assert.equal(v2.code, 'API_ENVIRONMENT_INVALID');
    });
    assert.equal(requests, 0);
  }
});

test('release 环境的 legacy/v2 请求均只发往生产源', async () => {
  const calls = [];
  const wxApi = wxRuntime('release', calls);
  const app = appRuntime(wxApi);
  await withWx(wxApi, async () => {
    const legacy = await app.fetchAPI('/api/config');
    const v2 = await app.requestV2({
      path: '/api/v2/legal-texts/current',
      auth: 'public'
    });
    assert.equal(legacy.success, true);
    assert.equal(v2.ok, true);
  });
  assert.deepEqual(
    calls.map(call => call.url),
    [
      `${PRODUCTION_API_BASE}/api/config`,
      `${PRODUCTION_API_BASE}/api/v2/legal-texts/current`
    ]
  );
  assert.ok(calls.every(call => call.url.startsWith(`${PRODUCTION_API_BASE}/`)));
});

test('legacy 请求不能用 userinfo、子域拼接或绝对 URL 逃逸固定源', async () => {
  const calls = [];
  const wxApi = wxRuntime('release', calls);
  const app = appRuntime(wxApi);
  await withWx(wxApi, async () => {
    for (const value of [
      '@hefeijifen.cn/api/config',
      '.hefeijifen.cn/api/config',
      '//hefeijifen.cn/api/config',
      '/api\\@hefeijifen.cn/config',
      'https://hefeijifen.cn/api/config'
    ]) {
      const result = await app.fetchAPI(value);
      assert.equal(result.code, 'CLIENT_REQUEST_INVALID', value);
    }
  });
  assert.equal(calls.length, 0);
});
