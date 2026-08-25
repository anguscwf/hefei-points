const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-v2-http-errors-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'http-errors.sqlite');

const { closeDb } = require('../db/connection');
const { createApp } = require('../index');

async function withServer(work) {
  const server = await new Promise(resolve => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function json(response) {
  return { response, body: await response.json() };
}

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('默认不信任可伪造的代理地址头', () => {
  assert.equal(createApp().get('trust proxy'), false);
});

test('生产儿童门保持关闭且配对误开时先要求显式地址信任边界', () => {
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'production',
    API_PUBLIC_ORIGIN: 'https://hefeijifen.cn',
    DATA_DIR: tempDir,
    WX_APPID: 'wx90237ce600b51eea',
    WX_APPSECRET: 'synthetic-app-secret',
    HARMONY_CHILD_ENABLED: 'false',
    CHILD_ENROLLMENT_ENABLED: 'false',
    DEVICE_PAIRING_ENABLED: '1',
    POINT_REQUESTS_ENABLED: 'false',
    CHILD_DATA_RIGHTS_ENABLED: 'false',
    LEGACY_CHILD_LOGIN_ENABLED: 'false',
    LEGACY_CHILD_MANAGEMENT_ENABLED: 'false',
    PAIRING_CLIENT_IP_MODE: '',
    TRUSTED_PROXIES: ''
  };
  const blocked = spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
    cwd: path.join(__dirname, '..', '..'),
    env: baseEnv,
    encoding: 'utf8'
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /PAIRING_CLIENT_IP_MODE/);

  const direct = spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...baseEnv, PAIRING_CLIENT_IP_MODE: 'direct' },
    encoding: 'utf8'
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /production child feature gates must remain explicitly closed/);

  const proxied = spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...baseEnv,
      PAIRING_CLIENT_IP_MODE: 'trusted_proxy',
      TRUSTED_PROXIES: '127.0.0.1/32'
    },
    encoding: 'utf8'
  });
  assert.notEqual(proxied.status, 0);
  assert.match(proxied.stderr, /production child feature gates must remain explicitly closed/);
});

test('v2 外围 404、JSON、体积和限流错误使用稳定 code 与 requestId', async () => {
  await withServer(async baseUrl => {
    const missing = await json(await fetch(`${baseUrl}/api/v2/not-real`));
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, 'NOT_FOUND');
    assert.equal(typeof missing.body.requestId, 'string');

    const malformed = await json(await fetch(`${baseUrl}/api/v2/reauth-assertions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    }));
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, 'INVALID_JSON');
    assert.equal(typeof malformed.body.requestId, 'string');

    const tooLarge = await json(await fetch(`${baseUrl}/api/v2/reauth-assertions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(60 * 1024) })
    }));
    assert.equal(tooLarge.response.status, 413);
    assert.equal(tooLarge.body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(typeof tooLarge.body.requestId, 'string');

    let limited;
    for (let index = 0; index < 11; index++) {
      limited = await json(await fetch(`${baseUrl}/api/v2/reauth-assertions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'child_enrollment', password: 'synthetic' })
      }));
    }
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal(typeof limited.body.requestId, 'string');

    const legacy = await json(await fetch(`${baseUrl}/api/not-real`));
    assert.equal(legacy.response.status, 404);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy.body, 'code'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy.body, 'requestId'), false);
  });
});
