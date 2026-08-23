const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-s0-security-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'security.sqlite');
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';

const { inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

const TEST_PASSWORD = 'test-password';

function resetDatabase() {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
  process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
  inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM rules').run();
    db.prepare('DELETE FROM families').run();
  });
  const createdAt = new Date().toISOString();
  repositories.families.ensureDefault({ id: 'default', name: '默认家庭', createdAt });
  repositories.families.ensureDefault({ id: 'family_a', name: '家庭A', inviteCode: 'INVITA', createdAt });
  repositories.families.ensureDefault({ id: 'family_b', name: '家庭B', inviteCode: 'INVITB', createdAt });
  const password = token.hashPwd(TEST_PASSWORD);
  for (const user of [
    { id: 'admin_a', name: '管理员A', role: 'admin', familyId: 'family_a' },
    { id: 'parent_a', name: '家长A', role: 'parent', familyId: 'family_a' },
    { id: 'child_a1', name: '孩子A1', role: 'child', familyId: 'family_a' },
    { id: 'child_a2', name: '孩子A2', role: 'child', familyId: 'family_a' },
    { id: 'child_a3', name: '孩子A3', role: 'child', familyId: 'family_a' },
    { id: 'admin_b', name: '管理员B', role: 'admin', familyId: 'family_b' },
    { id: 'child_b1', name: '孩子B1', role: 'child', familyId: 'family_b' }
  ]) repositories.users.insert({ ...user, password });

  for (const entry of [
    ['family_a', 'child_a1', 11],
    ['family_a', 'child_a2', 22],
    ['family_b', 'child_b1', 33]
  ]) {
    const [familyId, kid, amount] = entry;
    repositories.points.changePoints({
      familyId,
      kid,
      kidName: kid,
      amount,
      reason: '合成测试',
      operator: '测试执行器',
      note: ''
    });
  }
}

function createApi() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/auth'));
  app.use('/api', require('../routes/points'));
  app.use('/api', require('../routes/history'));
  app.use('/api', require('../routes/family'));
  app.use('/api', require('../routes/config'));
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

function authorization(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

async function json(response) {
  return { response, body: await response.json() };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('匿名或畸形 Token 的 config 只返回无成员公共空壳', async () => {
  await withServer(async baseUrl => {
    const expected = { success: true, public: true, users: [] };
    for (const request of [
      fetch(`${baseUrl}/api/config`),
      fetch(`${baseUrl}/api/config`, { headers: { Authorization: 'Bearer garbage' } }),
      fetch(`${baseUrl}/api/config?token=garbage`)
    ]) {
      const result = await json(await request);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body, expected);
    }
  });
});

test('家长仍可按用户 ID 登录且配置严格限制在当前家庭', async () => {
  await withServer(async baseUrl => {
    const login = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(login.response.status, 200);
    assert.equal(login.body.success, true);

    const config = await json(await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${login.body.token}` }
    }));
    assert.equal(config.response.status, 200);
    assert.deepEqual(config.body.users.map(user => user.id).sort(),
      ['admin_a', 'child_a1', 'child_a2', 'child_a3', 'parent_a']);
    assert.deepEqual(Object.keys(config.body.families), ['family_a']);
    assert.equal(JSON.stringify(config.body).includes('child_b1'), false);
    assert.equal(JSON.stringify(config.body).includes('家庭B'), false);
  });
});

test('旧儿童密码登录与既有 Token 默认失效', async () => {
  const childToken = token.signToken('child_a1', 'child', 'family_a');
  assert.equal(token.verifyToken(childToken), null);
  await withServer(async baseUrl => {
    const login = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'child_a1', password: TEST_PASSWORD })
    }));
    assert.equal(login.response.status, 403);
    assert.equal(login.body.code, 'FEATURE_DISABLED');

    const wrongPassword = await json(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'child_a1', password: 'definitely-wrong' })
    }));
    assert.equal(wrongPassword.response.status, 403);
    assert.equal(wrongPassword.body.code, 'FEATURE_DISABLED');

    const points = await fetch(`${baseUrl}/api/points`, { headers: { Authorization: `Bearer ${childToken}` } });
    assert.equal(points.status, 403);
  });
});

test('微信绑定只接受服务端签名的短期绑定凭据，不信任客户端 openid', async () => {
  await withServer(async baseUrl => {
    const rawOpenId = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openid: 'client-controlled', userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(rawOpenId.response.status, 400);

    for (const password of [TEST_PASSWORD, 'definitely-wrong']) {
      const childBinding = await json(await fetch(`${baseUrl}/api/wx-bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bindingTicket: token.signScopedTicket('wx-bind', `wx-child-${password}`),
          userId: 'child_a1',
          password
        })
      }));
      assert.equal(childBinding.response.status, 403);
      assert.equal(childBinding.body.code, 'FEATURE_DISABLED');
    }

    const bindingTicket = token.signScopedTicket('wx-bind', 'wx-openid-parent-a');
    const bound = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingTicket, userId: 'parent_a', password: TEST_PASSWORD })
    }));
    assert.equal(bound.response.status, 200);
    assert.equal(bound.body.success, true);
    assert.equal(repositories.users.findById('parent_a').openid, 'wx-openid-parent-a');

    const tampered = bindingTicket.slice(0, -1) + (bindingTicket.endsWith('A') ? 'B' : 'A');
    const rejected = await json(await fetch(`${baseUrl}/api/wx-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingTicket: tampered, userId: 'admin_a', password: TEST_PASSWORD })
    }));
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.code, 'BINDING_TICKET_INVALID');
  });
});

test('显式开启旧儿童登录时，儿童仍只能读取本人积分、流水和资料', async () => {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
  await withServer(async baseUrl => {
    const headers = authorization('child_a1');
    const points = await json(await fetch(`${baseUrl}/api/points`, { headers }));
    assert.equal(points.response.status, 200);
    assert.deepEqual(points.body.points, { child_a1: 11 });

    for (const query of ['', '?kid=child_a2', '?kid=child_b1', '?kid=missing']) {
      const history = await json(await fetch(`${baseUrl}/api/history${query}`, { headers }));
      assert.equal(history.response.status, 200);
      assert.ok(history.body.history.length > 0);
      assert.ok(history.body.history.every(record => record.kid === 'child_a1' && record.familyId === 'family_a'));
    }

    const config = await json(await fetch(`${baseUrl}/api/config`, { headers }));
    assert.deepEqual(config.body.users.map(user => user.id), ['child_a1']);
    assert.equal(Object.prototype.hasOwnProperty.call(config.body.families.family_a, 'inviteCode'), false);

    const family = await json(await fetch(`${baseUrl}/api/family`, { headers }));
    assert.deepEqual(family.body.members.map(member => member.id), ['child_a1']);
    assert.equal(Object.prototype.hasOwnProperty.call(family.body.family, 'inviteCode'), false);

    const emptyPoints = await json(await fetch(`${baseUrl}/api/points`, { headers: authorization('child_a3') }));
    assert.deepEqual(emptyPoints.body.points, {});
  });
});

test('家长家庭级读取保持兼容，无效孩子筛选不再退化为全家庭', async () => {
  await withServer(async baseUrl => {
    const headers = authorization('admin_a');
    const points = await json(await fetch(`${baseUrl}/api/points`, { headers }));
    assert.deepEqual(Object.keys(points.body.points).sort(), ['child_a1', 'child_a2']);

    const history = await json(await fetch(`${baseUrl}/api/history`, { headers }));
    assert.deepEqual([...new Set(history.body.history.map(record => record.kid))].sort(), ['child_a1', 'child_a2']);

    const filtered = await json(await fetch(`${baseUrl}/api/history?kid=child_a2`, { headers }));
    assert.ok(filtered.body.history.every(record => record.kid === 'child_a2'));

    const invalid = await json(await fetch(`${baseUrl}/api/history?kid=child_b1`, { headers }));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.message, '无效的孩子');
  });
});
