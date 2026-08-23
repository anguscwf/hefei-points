const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-points-test-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'test.sqlite');

const { getDb, inTransaction, closeDb } = require('../server/db/connection');
const repositories = require('../server/db/repositories');
const token = require('../server/lib/token');

function resetDatabase() {
  inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM rules').run();
    db.prepare('DELETE FROM families').run();
  });
  const createdAt = new Date().toISOString();
  repositories.families.ensureDefault({ id: 'default', name: '默认家庭', createdAt });
  repositories.families.ensureDefault({ id: 'family_a', name: '家庭A', createdAt });
  repositories.families.ensureDefault({ id: 'family_b', name: '家庭B', createdAt });
  const password = token.hashPwd('test-password');
  repositories.users.insert({ id: 'admin_a', name: '管理员A', role: 'admin', password, familyId: 'family_a' });
  repositories.users.insert({ id: 'parent_a', name: '家长A', role: 'parent', password, familyId: 'family_a' });
  repositories.users.insert({ id: 'child_a', name: '孩子A', role: 'child', password, familyId: 'family_a' });
  repositories.users.insert({ id: 'admin_b', name: '管理员B', role: 'admin', password, familyId: 'family_b' });
  repositories.users.insert({ id: 'child_b', name: '孩子B', role: 'child', password, familyId: 'family_b' });
  const activatedAt = new Date().toISOString();
  inTransaction(db => db.prepare(`
    UPDATE child_privacy_states
    SET status = 'active',
        revision = revision + 1,
        reason_code = 'synthetic_quality_fixture',
        updated_at = ?,
        activated_at = ?
    WHERE status = 'suspended_pending_consent'
  `).run(activatedAt, activatedAt));
}

function change(familyId, kid, amount) {
  return repositories.points.changePoints({
    familyId,
    kid,
    kidName: kid,
    amount,
    reason: '自动化测试',
    operator: '测试执行器',
    note: ''
  });
}

function createApi() {
  const app = express();
  app.use(require('../server/middleware/request-logger'));
  app.use(express.json());
  app.use(require('../server/routes/health'));
  app.use('/api', require('../server/routes/points'));
  app.use('/api', require('../server/routes/history'));
  app.use('/api', require('../server/routes/config'));
  return app;
}

async function withServer(work) {
  const server = await new Promise(resolve => {
    const listening = createApi().listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await work(baseUrl); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function authorization(userId) {
  const user = repositories.users.findById(userId);
  return { Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}` };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('同一孩子100次并发加分不丢数据', async () => {
  await Promise.all(Array.from({ length: 100 }, () => new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(change('family_a', 'child_a', 1)); }
      catch (error) { reject(error); }
    });
  })));
  assert.equal(repositories.points.getFamilyPoints('family_a').child_a, 100);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM transactions WHERE family_id='family_a' AND kid_id='child_a'").get().count, 100);
});

test('余额始终等于流水求和', () => {
  const records = [10, -3, 8, -2, 17].map(amount => change('family_a', 'child_a', amount).record);
  assert.equal(repositories.transactions.remove(records[0].id, 'family_a'), true);
  const balance = repositories.points.getFamilyPoints('family_a').child_a;
  const sum = getDb().prepare("SELECT SUM(amount) AS total FROM transactions WHERE family_id='family_a' AND kid_id='child_a'").get().total;
  assert.equal(balance, sum);
  assert.ok(!repositories.transactions.listByFamily('family_a').some(record => record.id === records[0].id));
});

test('家庭A无法读写家庭B数据', async () => {
  const recordB = change('family_b', 'child_b', 20).record;
  await withServer(async baseUrl => {
    const headers = { ...authorization('admin_a'), 'Content-Type': 'application/json' };
    const historyResponse = await fetch(`${baseUrl}/api/history`, { headers });
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.ok(history.history.every(record => record.familyId === 'family_a'));

    const changeResponse = await fetch(`${baseUrl}/api/points/change`, {
      method: 'POST', headers, body: JSON.stringify({ kid: 'child_b', amount: 10, reason: '越权测试' })
    });
    assert.equal(changeResponse.status, 400);

    const noteResponse = await fetch(`${baseUrl}/api/history/note`, {
      method: 'POST', headers, body: JSON.stringify({ recordId: recordB.id, note: '越权备注' })
    });
    assert.equal(noteResponse.status, 404);
  });
  assert.equal(repositories.points.getFamilyPoints('family_b').child_b, 20);
});

test('被踢用户的旧Token立即失效', async () => {
  const oldToken = token.signToken('parent_a', 'parent', 'family_a');
  await new Promise(resolve => setTimeout(resolve, 2));
  repositories.families.kickUser('parent_a', 'family_a');
  assert.equal(token.verifyToken(oldToken), null);
});

test('非管理员不能修改规则', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/config/rules`, {
      method: 'POST',
      headers: { ...authorization('parent_a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { reward: [] } })
    });
    assert.equal(response.status, 403);
  });
});

test('畸形Token不会导致服务崩溃', () => {
  const malformed = ['', 'garbage', 'hefei.a.b.c', 'hefei.a.b.c.d.e.f.g', 'hefei.user.admin.family.not-a-time.signature'];
  for (const value of malformed) assert.doesNotThrow(() => assert.equal(token.verifyToken(value), null));
});

test('健康检查可用且每个请求都有唯一requestId', async () => {
  await withServer(async baseUrl => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(live.status, 200);
    assert.equal(ready.status, 200);
    assert.match(live.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.match(ready.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.notEqual(live.headers.get('x-request-id'), ready.headers.get('x-request-id'));
    assert.equal((await ready.json()).status, 'ready');
  });
});
