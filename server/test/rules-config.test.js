const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-rules-test-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = tempDir;
process.env.SQLITE_FILE = path.join(tempDir, 'rules.sqlite');

const { inTransaction, closeDb } = require('../db/connection');
const repositories = require('../db/repositories');
const token = require('../lib/token');

function validRules() {
  return {
    futureRoot: { kept: true },
    reward: [{
      category: '学习成长',
      futureCategory: 'kept',
      items: [{
        id: 'r_study_1', label: '按时完成作业', min: 1, max: 10, default: 3,
        unit: '每次', hint: '认真完成后记录', futureItem: { kept: true }
      }]
    }],
    punish: [{
      category: '行为提醒',
      items: [{
        id: 'p_behavior_1', label: '没有按时收拾', min: -10, max: -1, default: -3,
        unit: '每次', hint: '提醒后仍未完成'
      }]
    }],
    special: ['连续七天保持好习惯可获得额外鼓励']
  };
}

function resetDatabase() {
  inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM rules').run();
    db.prepare('DELETE FROM families').run();
  });
  const createdAt = new Date().toISOString();
  repositories.families.ensureDefault({ id: 'family_a', name: '家庭A', createdAt });
  repositories.users.insert({
    id: 'admin_a', name: '管理员A', role: 'admin', password: token.hashPwd('test-password'), familyId: 'family_a'
  });
}

function createApi() {
  const app = express();
  app.use(require('../middleware/request-logger'));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', require('../routes/config'));
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

function headers() {
  const user = repositories.users.findById('admin_a');
  return {
    Authorization: `Bearer ${token.signToken(user.id, user.role, user.familyId)}`,
    'Content-Type': 'application/json'
  };
}

async function save(baseUrl, rules, revisionMarker) {
  const body = { rules };
  if (revisionMarker !== undefined) body.revision = revisionMarker;
  const response = await fetch(`${baseUrl}/api/config/rules`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

beforeEach(resetDatabase);

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('规则接口精确拒绝超长、超范围、重复ID和类型错误', async () => {
  await withServer(async baseUrl => {
    const cases = [
      { mutate(rules) { rules.reward[0].items[0].label = '长'.repeat(51); }, field: 'reward[0].items[0].label' },
      { mutate(rules) { rules.reward[0].items[0].default = 1001; }, field: 'reward[0].items[0].default' },
      { mutate(rules) { rules.punish[0].items[0].id = 'r_study_1'; }, field: 'punish[0].items[0].id' },
      { mutate(rules) { rules.reward = {}; }, field: 'reward' },
      { mutate(rules) { rules.special[0] = 7; }, field: 'special[0]' }
    ];
    for (const testCase of cases) {
      const rules = validRules();
      testCase.mutate(rules);
      const { response, json } = await save(baseUrl, rules);
      assert.equal(response.status, 400);
      assert.equal(json.code, 'RULES_VALIDATION_ERROR');
      assert.equal(json.field, testCase.field);
      assert.ok(typeof json.message === 'string' && json.message.length > 0);
    }
  });
});

test('revision递增并阻止旧版本覆盖，同时返回最新规则', async () => {
  await withServer(async baseUrl => {
    const first = await save(baseUrl, validRules());
    assert.equal(first.response.status, 200);
    assert.equal(first.json.revision, 1);
    assert.equal(first.json.rules.revision, 1);

    const updated = structuredClone(first.json.rules);
    updated.reward[0].items[0].hint = '第二位管理员已经更新';
    const second = await save(baseUrl, updated, 1);
    assert.equal(second.response.status, 200);
    assert.equal(second.json.revision, 2);

    const stale = structuredClone(first.json.rules);
    stale.reward[0].items[0].hint = '过期页面尝试覆盖';
    const conflict = await save(baseUrl, stale, 1);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.code, 'RULES_REVISION_CONFLICT');
    assert.equal(conflict.json.field, 'revision');
    assert.equal(conflict.json.currentRevision, 2);
    assert.equal(conflict.json.revision, 2);
    assert.equal(conflict.json.rules.reward[0].items[0].hint, '第二位管理员已经更新');
    assert.equal(repositories.config.getRules('family_a').reward[0].items[0].hint, '第二位管理员已经更新');
  });
});

test('两个管理员用同一revision并发保存时仅一个成功', async () => {
  await withServer(async baseUrl => {
    const initial = await save(baseUrl, validRules());
    assert.equal(initial.response.status, 200);

    const firstDraft = structuredClone(initial.json.rules);
    const secondDraft = structuredClone(initial.json.rules);
    firstDraft.reward[0].items[0].hint = '并发管理员A';
    secondDraft.reward[0].items[0].hint = '并发管理员B';

    const results = await Promise.all([
      save(baseUrl, firstDraft, initial.json.revision),
      save(baseUrl, secondDraft, initial.json.revision)
    ]);
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);

    const winner = results.find(result => result.response.status === 200);
    const conflict = results.find(result => result.response.status === 409);
    assert.equal(conflict.json.code, 'RULES_REVISION_CONFLICT');
    assert.equal(conflict.json.currentRevision, winner.json.revision);
    assert.equal(conflict.json.rules.reward[0].items[0].hint, winner.json.rules.reward[0].items[0].hint);
    assert.equal(repositories.config.getRules('family_a').reward[0].items[0].hint, winner.json.rules.reward[0].items[0].hint);
  });
});

test('旧客户端不携带revision仍可保存且服务端递增版本', async () => {
  await withServer(async baseUrl => {
    const first = await save(baseUrl, validRules());
    assert.equal(first.response.status, 200);
    const legacyRules = validRules();
    legacyRules.reward[0].items[0].label = '旧客户端保存';
    const legacy = await save(baseUrl, legacyRules);
    assert.equal(legacy.response.status, 200);
    assert.equal(legacy.json.revision, 2);
    assert.equal(legacy.json.rules.reward[0].items[0].label, '旧客户端保存');
  });
});

test('历史 -999 扣分范围读取时兼容为 -500，保存接口仍拒绝新超范围输入', async () => {
  const legacyRules = validRules();
  legacyRules.punish[0].items[0].min = -999;
  inTransaction(db => {
    db.prepare(`
      INSERT INTO rules(family_id, revision, data_json, updated_by, updated_at)
      VALUES ('family_a', 0, ?, NULL, ?)
    `).run(JSON.stringify(legacyRules), new Date().toISOString());
  });

  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/config`, { headers: headers() });
    const config = await response.json();
    assert.equal(response.status, 200);
    assert.equal(config.rules.revision, 0);
    assert.equal(config.rules.punish[0].items[0].min, -500);

    const compatibleSave = await save(baseUrl, config.rules, 0);
    assert.equal(compatibleSave.response.status, 200);
    assert.equal(compatibleSave.json.rules.punish[0].items[0].min, -500);

    const malformed = validRules();
    malformed.punish[0].items[0].min = -501;
    const rejected = await save(baseUrl, malformed);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.json.field, 'punish[0].items[0].min');
  });
});

test('分类稳定ID自动补齐，改名生成aliases并保留未知字段', async () => {
  await withServer(async baseUrl => {
    const first = await save(baseUrl, validRules());
    assert.equal(first.response.status, 200);
    const categoryId = first.json.rules.reward[0].id;
    assert.match(categoryId, /^cat_reward_[a-f0-9]{12}(?:_\d+)?$/);

    const renamed = structuredClone(first.json.rules);
    delete renamed.reward[0].id;
    renamed.reward[0].category = '学习好习惯';
    renamed.reward[0].aliases = ['旧分类', '旧分类', '  家庭学习  '];
    renamed.reward[0].items[0].label = '每天按时完成作业';
    renamed.reward[0].items[0].aliases = ['按时完成作业', '按时完成作业', '  作业完成  '];

    const second = await save(baseUrl, renamed, first.json.revision);
    assert.equal(second.response.status, 200);
    const savedCategory = second.json.rules.reward[0];
    assert.equal(savedCategory.id, categoryId);
    assert.deepEqual(savedCategory.aliases, ['学习成长', '旧分类', '家庭学习']);
    assert.deepEqual(savedCategory.items[0].aliases, ['按时完成作业', '作业完成']);
    assert.deepEqual(second.json.rules.futureRoot, { kept: true });
    assert.equal(savedCategory.futureCategory, 'kept');
    assert.deepEqual(savedCategory.items[0].futureItem, { kept: true });
    assert.equal(savedCategory.items[0].hint, '认真完成后记录');
  });
});

test('请求体revision和rules.revision不一致时精确拒绝', async () => {
  await withServer(async baseUrl => {
    const first = await save(baseUrl, validRules());
    const mismatched = await save(baseUrl, first.json.rules, 0);
    assert.equal(mismatched.response.status, 400);
    assert.equal(mismatched.json.code, 'RULES_VALIDATION_ERROR');
    assert.equal(mismatched.json.field, 'revision');
  });
});
