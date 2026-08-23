const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-child-gates-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'gates.sqlite');
process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';

const { getDb, inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');
const features = require('../config/features');

const TEST_PASSWORD = 'test-password';

function resetDatabase() {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'false';
  process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'false';
  process.env.CHILD_ENROLLMENT_ENABLED = 'false';
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
  repositories.families.ensureDefault({ id: 'family_adults', name: '成人家庭', inviteCode: 'ADULTS', createdAt });
  const password = token.hashPwd(TEST_PASSWORD);
  for (const user of [
    { id: 'admin_a', name: '管理员A', role: 'admin', familyId: 'family_a' },
    { id: 'parent_a', name: '家长A', role: 'parent', familyId: 'family_a' },
    { id: 'child_a', name: '孩子A', role: 'child', familyId: 'family_a' },
    { id: 'admin_adults', name: '成人管理员', role: 'admin', familyId: 'family_adults' },
    { id: 'parent_adults', name: '成人成员', role: 'parent', familyId: 'family_adults' }
  ]) repositories.users.insert({ ...user, password });
  repositories.points.setBalance('family_a', 'child_a', 9);
}

function createApi() {
  const app = express();
  app.use(express.json());
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

function familyPayload(familyId = 'family_a') {
  return repositories.users.listByFamily(familyId).map(user => ({ id: user.id, name: user.name, role: user.role }));
}

function snapshot(familyId = 'family_a') {
  return getDb().prepare('SELECT id,name,role,password,family_id FROM users WHERE family_id = ? ORDER BY id').all(familyId);
}

async function post(baseUrl, route, userId, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { ...authorization(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('legacy 儿童管理门默认关闭且不会被新 enrollment 开关误开启', () => {
  for (const value of [undefined, '', 'false', '0', 'disabled', 'TRUE-ish']) {
    if (value === undefined) delete process.env.LEGACY_CHILD_MANAGEMENT_ENABLED;
    else process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = value;
    assert.equal(features.isLegacyChildManagementEnabled(), false);
  }
  process.env.CHILD_ENROLLMENT_ENABLED = 'true';
  assert.equal(features.isChildEnrollmentEnabled(), true);
  assert.equal(features.isLegacyChildManagementEnabled(), false);
  for (const value of ['1', 'true', 'YES', 'on']) {
    process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = value;
    assert.equal(features.isLegacyChildManagementEnabled(), true);
  }
});

test('旧儿童创建默认拒绝，显式开启后仍要求 8 至 128 位密码', async () => {
  await withServer(async baseUrl => {
    for (const userId of ['admin_a', 'parent_a']) {
      const blocked = await post(baseUrl, '/api/family/child/create', userId, {
        id: `blocked_${userId}`, name: '被阻止孩子', password: 'strong-password'
      });
      assert.equal(blocked.response.status, 403);
      assert.equal(blocked.body.code, 'FEATURE_DISABLED');
      assert.equal(repositories.users.findById(`blocked_${userId}`), null);
    }

    process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'true';
    for (const [id, password] of [['missing_pwd', undefined], ['short_pwd', '123456'], ['seven_pwd', '1234567']]) {
      const rejected = await post(baseUrl, '/api/family/child/create', 'admin_a', { id, name: '合成孩子', password });
      assert.equal(rejected.response.status, 400);
      assert.equal(repositories.users.findById(id), null);
    }

    const created = await post(baseUrl, '/api/family/child/create', 'admin_a', {
      id: 'legacy_child', name: '旧流程合成孩子', password: '12345678'
    });
    assert.equal(created.response.status, 200);
    const stored = repositories.users.findById('legacy_child');
    assert.notEqual(stored.password, '12345678');
    assert.equal(token.verifyPwd('12345678', stored.password), true);
  });
});

test('门关闭时成人资料可更新，但任何儿童增删改整批原子拒绝', async () => {
  await withServer(async baseUrl => {
    const adultOnly = familyPayload();
    adultOnly.find(user => user.id === 'parent_a').name = '家长A已更新';
    adultOnly.push({ id: 'parent_new', name: '新增成人', role: 'parent', password: TEST_PASSWORD });
    const allowed = await post(baseUrl, '/api/config/users', 'admin_a', { users: adultOnly });
    assert.equal(allowed.response.status, 200);
    assert.equal(repositories.users.findById('parent_a').name, '家长A已更新');
    assert.equal(repositories.users.findById('parent_new').role, 'parent');

    const mutations = [
      users => users.concat({ id: 'child_new', name: '新增孩子', role: 'child', password: 'strong-password' }),
      users => users.filter(user => user.id !== 'child_a'),
      users => { users.find(user => user.id === 'child_a').name = '孩子A改名'; return users; },
      users => { users.find(user => user.id === 'child_a').password = 'changed-password'; return users; },
      users => { users.find(user => user.id === 'child_a').role = 'parent'; return users; },
      users => { const adult = users.find(user => user.id === 'parent_a'); adult.role = 'child'; adult.password = 'strong-password'; return users; }
    ];

    for (const mutate of mutations) {
      resetDatabase();
      const before = snapshot();
      const users = mutate(familyPayload());
      users.find(user => user.id === 'parent_a').name = '不应提交的成人改名';
      const blocked = await post(baseUrl, '/api/config/users', 'admin_a', { users });
      assert.equal(blocked.response.status, 403);
      assert.equal(blocked.body.code, 'FEATURE_DISABLED');
      assert.deepEqual(snapshot(), before);
    }
  });
});

test('显式开启批量旧管理时，新儿童也不能使用空密码或弱密码', async () => {
  process.env.LEGACY_CHILD_MANAGEMENT_ENABLED = 'true';
  await withServer(async baseUrl => {
    for (const password of ['', '123456']) {
      const users = familyPayload();
      users.push({ id: `weak_${password.length}`, name: '弱密码孩子', role: 'child', password });
      const rejected = await post(baseUrl, '/api/config/users', 'admin_a', { users });
      assert.equal(rejected.response.status, 400);
    }

    const users = familyPayload();
    users.push({ id: 'strong_child', name: '强密码孩子', role: 'child', password: 'strong-password' });
    const created = await post(baseUrl, '/api/config/users', 'admin_a', { users });
    assert.equal(created.response.status, 200);
    assert.equal(token.verifyPwd('strong-password', repositories.users.findById('strong_child').password), true);
  });
});

test('儿童不能自行离家，管理员不能绕过门踢出儿童或删除含儿童家庭', async () => {
  process.env.LEGACY_CHILD_LOGIN_ENABLED = 'true';
  await withServer(async baseUrl => {
    const leave = await post(baseUrl, '/api/family/leave', 'child_a', {});
    assert.equal(leave.response.status, 403);
    assert.equal(repositories.users.findById('child_a').familyId, 'family_a');

    const kickChild = await post(baseUrl, '/api/family/kick', 'admin_a', { userId: 'child_a' });
    assert.equal(kickChild.response.status, 403);
    assert.equal(kickChild.body.code, 'FEATURE_DISABLED');

    const kickAdult = await post(baseUrl, '/api/family/kick', 'admin_a', { userId: 'parent_a' });
    assert.equal(kickAdult.response.status, 200);
    assert.equal(repositories.users.findById('parent_a').familyId, 'default');

    const deleteWithChild = await post(baseUrl, '/api/family/delete', 'admin_a', {});
    assert.equal(deleteWithChild.response.status, 403);
    assert.equal(deleteWithChild.body.code, 'FEATURE_DISABLED');
    assert.ok(repositories.families.findById('family_a'));
    assert.equal(repositories.points.getFamilyPoints('family_a').child_a, 9);

    const deleteAdults = await post(baseUrl, '/api/family/delete', 'admin_adults', {});
    assert.equal(deleteAdults.response.status, 200);
    assert.equal(repositories.families.findById('family_adults'), null);
  });
});

test('仓储默认在事务内拒绝儿童变更并完整回滚', () => {
  const before = snapshot();
  const users = repositories.users.listByFamily('family_a').map(user => ({
    id: user.id,
    name: user.id === 'parent_a' ? '不应落库' : user.name,
    role: user.role,
    password: user.password,
    familyId: user.familyId
  })).filter(user => user.id !== 'child_a');
  assert.throws(
    () => repositories.users.replaceFamily('family_a', users, 'admin_a'),
    error => error && error.code === 'FEATURE_DISABLED'
  );
  assert.deepEqual(snapshot(), before);
});
