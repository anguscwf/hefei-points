const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
