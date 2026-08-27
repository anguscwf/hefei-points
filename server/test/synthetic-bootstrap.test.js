const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..', '..');
const bootstrapScript = path.join(projectRoot, 'scripts', 'bootstrap-synthetic-database.js');
const profile = require('../config/deployment-profile');
const rootTools = require('../../scripts/support/synthetic-data-root-tools');
const {
  BOOTSTRAP_ACK,
  CREDENTIAL_PURPOSE,
  EXPECTED_TABLES,
  MAX_STDIN_BYTES,
  acquireBootstrapLock,
  bootstrapFromDocument,
  createContext,
  decodeCanonicalInput,
  parseArguments,
  readStdin
} = require('../../scripts/support/synthetic-bootstrap');
const {
  applyMigrations,
  applyMigrationsInCurrentTransaction,
  migrationFiles
} = require('../db/migrations');
const { verifyPwd } = require('../lib/password');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-s14-bootstrap-'));
const fixedNow = new Date('2026-08-27T08:00:00.000Z');
let sequence = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function removeCase(caseRoot) {
  assert.equal(isWithin(tempRoot, caseRoot), true);
  fs.rmSync(caseRoot, { recursive: true, force: true });
}

after(() => {
  assert.equal(path.basename(tempRoot).startsWith('tangguan-s14-bootstrap-'), true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function syntheticCase(t, label) {
  sequence += 1;
  const id = String(sequence).padStart(4, '0');
  const caseRoot = path.join(tempRoot, `case-${id}-${label}`);
  const approvedParent = path.join(caseRoot, 'approved-parent');
  const root = path.join(approvedParent, `tangguan-synthetic-s14-${id}`);
  const origin = `https://synthetic-s14-${Number(id)}.example.com`;
  const relationVersion = `synthetic-relation-${id}`;
  const relationSha256 = sha256(`synthetic relation declaration ${id}`);
  fs.mkdirSync(approvedParent, { recursive: true, mode: 0o700 });
  const environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    SYNTHETIC_RUNTIME_ACK: profile.SYNTHETIC_RUNTIME_ACK,
    SYNTHETIC_APP_CREDENTIALS_ACK: profile.SYNTHETIC_APP_CREDENTIALS_ACK,
    SYNTHETIC_DATA_ACK: profile.SYNTHETIC_DATA_ACK,
    SYNTHETIC_DATA_ROOT_PREPARE_ACK: 'prepare-new-empty-synthetic-root-v1',
    SYNTHETIC_DATA_ROOT_APPROVED_PARENT: approvedParent,
    SYNTHETIC_BOOTSTRAP_ACK: BOOTSTRAP_ACK,
    SYNTHETIC_DATASET_ID: `synthetic-s14-${id}`,
    SYNTHETIC_DATA_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    SQLITE_FILE: path.join(root, 'data', 'hefei-points-synthetic.sqlite'),
    API_PUBLIC_ORIGIN: origin,
    LEGAL_PUBLIC_ORIGIN: origin,
    GUARDIAN_RELATION_DECLARATION_VERSION: relationVersion,
    GUARDIAN_RELATION_DECLARATION_SHA256: relationSha256,
    GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
      `${origin}/legal/guardian-relation-declaration/${relationVersion}/${relationSha256}.html`,
    WX_APPID: `wx${Number(id).toString(16).padStart(16, '0')}`,
    WX_APPSECRET: `synthetic-s14-app-secret-${id}`,
    HARMONY_CHILD_ENABLED: 'true',
    CHILD_ENROLLMENT_ENABLED: 'true',
    DEVICE_PAIRING_ENABLED: 'true',
    POINT_REQUESTS_ENABLED: 'true',
    CHILD_DATA_RIGHTS_ENABLED: 'false',
    LEGACY_CHILD_LOGIN_ENABLED: 'false',
    LEGACY_CHILD_MANAGEMENT_ENABLED: 'false',
    PAIRING_CLIENT_IP_MODE: 'direct',
    TRUSTED_PROXIES: '',
    LOG_LEVEL: 'error'
  };
  rootTools.prepareSyntheticDataRoot(environment, { rootProject: projectRoot });
  const password = `S14!Synthetic-Password-${id}-Aa9`;
  const input = {
    schemaVersion: 1,
    requestId: `synthetic-bootstrap-request_${id}_abcdef0123456789`,
    datasetId: environment.SYNTHETIC_DATASET_ID,
    approvalReference: `synthetic-approval-case_${id}_abcdef`,
    administrator: {
      id: `synthetic_admin_case_${id}`,
      password,
      credentialPurpose: CREDENTIAL_PURPOSE
    },
    legalEvidence: {
      effectiveAt: '2026-08-27T00:00:00.000Z',
      texts: [
        ['privacy_policy', 'privacy'],
        ['child_personal_information_rules', 'child-rules'],
        ['child_user_agreement', 'child-agreement'],
        ['sensitive_information_notice', 'sensitive-notice']
      ].map(([type, slug]) => ({
        type,
        version: `synthetic-${slug}-${id}`,
        contentSha256: sha256(`approved synthetic ${slug} ${id}`)
      }))
    }
  };
  t.after(() => removeCase(caseRoot));
  return { caseRoot, root, environment, input, password, origin };
}

function assertCode(work, code) {
  assert.throws(work, error => error && error.code === code);
}

function applicationTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function tableCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function childEnvironment(environment, extra = {}) {
  const result = {};
  for (const name of [
    'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR'
  ]) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  return { ...result, ...environment, ...extra };
}

function spawnNode(args, environment, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: childEnvironment(environment),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    child.stdin.end(stdin);
  });
}

test('bootstrap 输入只接受无参数、非 TTY 和无歧义 canonical JSON', async () => {
  assert.deepEqual(parseArguments([]), { help: false });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assertCode(() => parseArguments(['--status']), 'ARGUMENT_INVALID');
  assert.deepEqual(decodeCanonicalInput(Buffer.from('{"schemaVersion":1}\n')), {
    schemaVersion: 1
  });
  assertCode(
    () => decodeCanonicalInput(Buffer.from('{ "schemaVersion": 1 }')),
    'BOOTSTRAP_INPUT_INVALID'
  );
  assertCode(
    () => decodeCanonicalInput(Buffer.from('{"schemaVersion":1,"schemaVersion":1}')),
    'BOOTSTRAP_INPUT_INVALID'
  );
  assertCode(
    () => decodeCanonicalInput(Buffer.from([0xc3, 0x28])),
    'BOOTSTRAP_INPUT_INVALID'
  );
  assertCode(
    () => decodeCanonicalInput(Buffer.alloc(MAX_STDIN_BYTES + 1, 0x61)),
    'STDIN_TOO_LARGE'
  );
  await assert.rejects(readStdin({ isTTY: true }), error => error.code === 'STDIN_REQUIRED');
});

test('所有迁移在调用者事务内任一点失败都回到空 schema 并可重试', () => {
  for (const target of migrationFiles()) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA recursive_triggers = ON');
      db.exec('BEGIN IMMEDIATE');
      assert.throws(() => applyMigrationsInCurrentTransaction(db, {
        now: () => fixedNow,
        afterMigration: filename => {
          if (filename === target) throw new Error('synthetic fault');
        }
      }), /synthetic fault/);
      db.exec('ROLLBACK');
      assert.deepEqual(applicationTables(db), []);
      applyMigrations(db, { now: () => fixedNow });
      assert.deepEqual(applicationTables(db), EXPECTED_TABLES);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  }
});

test('全新 synthetic 库原子写入最小管理员、四类法律证据和不可变回执', t => {
  const value = syntheticCase(t, 'success');
  const result = bootstrapFromDocument(value.environment, value.input, { now: fixedNow });
  assert.equal(result.outcome, 'created');
  assert.equal(result.administrator.credentialWritten, true);
  assert.equal(result.database.migrationCount, migrationFiles().length);
  assert.equal(result.database.childOrBusinessRowsWritten, 0);
  assert.equal(result.database.tokenSecretCreated, false);
  assert.equal(fs.existsSync(path.join(value.environment.DATA_DIR, '.secret')), false);
  assert.equal(
    fs.existsSync(path.join(value.environment.DATA_DIR, '.synthetic-bootstrap.lock')),
    false
  );

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    value.password,
    value.input.administrator.id,
    value.root,
    value.origin,
    value.environment.WX_APPID,
    value.environment.WX_APPSECRET,
    ...value.input.legalEvidence.texts.flatMap(text => [text.version, text.contentSha256])
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const db = new DatabaseSync(value.environment.SQLITE_FILE, { readOnly: true });
  try {
    assert.deepEqual(applicationTables(db), EXPECTED_TABLES);
    const expectedCounts = new Map([
      ['schema_migrations', migrationFiles().length],
      ['families', 1],
      ['users', 1],
      ['legal_text_versions', 4],
      ['synthetic_bootstrap_receipts', 1]
    ]);
    for (const table of EXPECTED_TABLES) {
      assert.equal(tableCount(db, table), expectedCounts.get(table) || 0, table);
    }
    assert.deepEqual({ ...db.prepare(`
      SELECT id, name, invite_code, invite_json FROM families
    `).get() }, {
      id: 'default', name: '合成默认家庭', invite_code: null, invite_json: null
    });
    const admin = db.prepare(`
      SELECT id, name, role, password, family_id, openid, bound_at, tokens_valid_after
      FROM users
    `).get();
    assert.equal(admin.id, value.input.administrator.id);
    assert.equal(admin.name, '合成管理员');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.family_id, 'default');
    assert.equal(admin.openid, null);
    assert.equal(admin.bound_at, null);
    assert.equal(Number(admin.tokens_valid_after), 0);
    assert.match(admin.password, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.equal(verifyPwd(value.password, admin.password), true);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  const writable = new DatabaseSync(value.environment.SQLITE_FILE);
  try {
    writable.exec('PRAGMA recursive_triggers = ON');
    assert.throws(
      () => writable.prepare(`
        UPDATE synthetic_bootstrap_receipts SET status = 'completed'
      `).run(),
      /SYNTHETIC_BOOTSTRAP_RECEIPT_IMMUTABLE/
    );
    assert.throws(
      () => writable.prepare('DELETE FROM synthetic_bootstrap_receipts').run(),
      /SYNTHETIC_BOOTSTRAP_RECEIPT_DELETE_FORBIDDEN/
    );
  } finally {
    writable.close();
  }

  const replay = bootstrapFromDocument(value.environment, value.input, { now: fixedNow });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.administrator.credentialWritten, false);
  const changedPassword = structuredClone(value.input);
  changedPassword.administrator.password = `${value.password}X`;
  assertCode(
    () => bootstrapFromDocument(value.environment, changedPassword, { now: fixedNow }),
    'BOOTSTRAP_CONFLICT'
  );
  const changedLegal = structuredClone(value.input);
  changedLegal.legalEvidence.texts[0].version += '-changed';
  assertCode(
    () => bootstrapFromDocument(value.environment, changedLegal, { now: fixedNow }),
    'BOOTSTRAP_CONFLICT'
  );
});

test('每个 bootstrap 写阶段故障都完整回滚且原输入可恢复', t => {
  const stages = [
    'after_migrations',
    'after_family',
    'after_administrator',
    'after_legal_privacy_policy',
    'after_legal_child_personal_information_rules',
    'after_legal_child_user_agreement',
    'after_legal_sensitive_information_notice',
    'after_receipt',
    'before_commit'
  ];
  for (const stage of stages) {
    const value = syntheticCase(t, `rollback-${stage.replaceAll('_', '-')}`);
    assertCode(() => bootstrapFromDocument(value.environment, value.input, {
      now: fixedNow,
      fault: current => {
        if (current === stage) throw new Error('synthetic injected failure');
      }
    }), 'BOOTSTRAP_TRANSACTION_FAILED');
    assert.equal(fs.existsSync(path.join(value.environment.DATA_DIR, '.secret')), false);
    const db = new DatabaseSync(value.environment.SQLITE_FILE, { readOnly: true });
    try {
      assert.deepEqual(applicationTables(db), []);
    } finally {
      db.close();
    }
    const recovered = bootstrapFromDocument(value.environment, value.input, { now: fixedNow });
    assert.equal(recovered.outcome, 'created');
  }
});

test('只接管全新或精确当前空基线，拒绝未知 schema、业务行和预生成 secret', t => {
  const baseline = syntheticCase(t, 'baseline');
  let db = new DatabaseSync(baseline.environment.SQLITE_FILE);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyMigrations(db, { now: () => fixedNow });
  db.close();
  assert.equal(
    bootstrapFromDocument(baseline.environment, baseline.input, { now: fixedNow }).outcome,
    'created'
  );

  const unknown = syntheticCase(t, 'unknown-schema');
  db = new DatabaseSync(unknown.environment.SQLITE_FILE);
  db.exec('CREATE TABLE unexpected(value TEXT)');
  db.close();
  assertCode(
    () => bootstrapFromDocument(unknown.environment, unknown.input, { now: fixedNow }),
    'BOOTSTRAP_SCHEMA_INVALID'
  );

  const populated = syntheticCase(t, 'populated');
  db = new DatabaseSync(populated.environment.SQLITE_FILE);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyMigrations(db, { now: () => fixedNow });
  db.prepare(`
    INSERT INTO rules(family_id, revision, data_json, updated_at)
    VALUES ('default', 0, '{}', ?)
  `).run(fixedNow.toISOString());
  db.close();
  assertCode(
    () => bootstrapFromDocument(populated.environment, populated.input, { now: fixedNow }),
    'BOOTSTRAP_DATABASE_NOT_EMPTY'
  );

  const secret = syntheticCase(t, 'secret');
  fs.writeFileSync(path.join(secret.environment.DATA_DIR, '.secret'), 'f'.repeat(64), {
    flag: 'wx', mode: 0o600
  });
  assertCode(
    () => bootstrapFromDocument(secret.environment, secret.input, { now: fixedNow }),
    'BOOTSTRAP_DATABASE_NOT_EMPTY'
  );
});

test('配置与 secret 通道 fail closed，失败前不创建 SQLite', t => {
  const value = syntheticCase(t, 'guards');
  const sqlite = value.environment.SQLITE_FILE;
  const missingAck = { ...value.environment };
  delete missingAck.SYNTHETIC_BOOTSTRAP_ACK;
  assertCode(() => createContext(missingAck), 'BOOTSTRAP_ACK_REQUIRED');
  assert.equal(fs.existsSync(sqlite), false);

  const envSecret = {
    ...value.environment,
    SYNTHETIC_BOOTSTRAP_PASSWORD: value.password
  };
  assertCode(() => createContext(envSecret), 'BOOTSTRAP_SECRET_CHANNEL_INVALID');
  assert.equal(fs.existsSync(sqlite), false);

  const production = {
    ...value.environment,
    DEPLOYMENT_TIER: 'production'
  };
  assertCode(() => createContext(production), 'SYNTHETIC_MODE_REQUIRED');
  assert.equal(fs.existsSync(sqlite), false);

  const staleLock = path.join(value.environment.DATA_DIR, '.synthetic-bootstrap.lock');
  fs.writeFileSync(staleLock, '', { flag: 'wx', mode: 0o600 });
  assertCode(
    () => acquireBootstrapLock(value.environment, { lockTimeoutMs: 1 }),
    'BOOTSTRAP_BUSY'
  );
  assert.equal(fs.existsSync(staleLock), true, 'stale locks require explicit operator handling');
  fs.unlinkSync(staleLock);
});

test('并发 CLI 对同一全新库只创建一次，其余进程安全重放', async t => {
  const value = syntheticCase(t, 'concurrent');
  const stdin = `${JSON.stringify(value.input)}\n`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => spawnNode(
    [bootstrapScript],
    value.environment,
    stdin
  )));
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.stderr, '');
  }
  const results = runs.map(run => JSON.parse(run.stdout));
  assert.equal(results.filter(result => result.outcome === 'created').length, 1);
  assert.equal(results.filter(result => result.outcome === 'replayed').length, 7);
  assert.equal(
    fs.existsSync(path.join(value.environment.DATA_DIR, '.synthetic-bootstrap.lock')),
    false
  );
  const db = new DatabaseSync(value.environment.SQLITE_FILE, { readOnly: true });
  try {
    assert.equal(tableCount(db, 'users'), 1);
    assert.equal(tableCount(db, 'legal_text_versions'), 4);
    assert.equal(tableCount(db, 'synthetic_bootstrap_receipts'), 1);
  } finally {
    db.close();
  }
});

test('synthetic runtime 无 receipt 拒启且不建 secret，精确空基线随后可 bootstrap', async t => {
  const value = syntheticCase(t, 'runtime-gate');
  const runtimeEnvironment = { ...value.environment };
  delete runtimeEnvironment.SYNTHETIC_BOOTSTRAP_ACK;
  const program = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    'let close=()=>{};',
    'try {',
    "  const {createApp}=require('./server/index');",
    "  close=require('./server/db/connection').closeDb;",
    '  createApp();',
    '  process.exitCode=10;',
    '} catch(error) {',
    "  if(error.code!=='SYNTHETIC_BOOTSTRAP_REQUIRED')process.exitCode=11;",
    '} finally {',
    '  close();',
    "  if(fs.existsSync(path.join(process.env.DATA_DIR,'.secret')))process.exitCode=12;",
    '}'
  ].join('\n');
  const result = await spawnNode(['-e', program], runtimeEnvironment);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(path.join(value.environment.DATA_DIR, '.secret')), false);
  assert.equal(
    bootstrapFromDocument(value.environment, value.input, { now: fixedNow }).outcome,
    'created'
  );
});

test('bootstrap 后成人登录、公开法律证据和重新认证可用且仍未创建儿童业务', async t => {
  const value = syntheticCase(t, 'http-chain');
  bootstrapFromDocument(value.environment, value.input, { now: fixedNow });
  const runtimeEnvironment = { ...value.environment };
  delete runtimeEnvironment.SYNTHETIC_BOOTSTRAP_ACK;
  const program = [
    "const {installLoopbackOnlyNetwork}=require('./server/test-support/loopback-only-network');",
    'const restore=installLoopbackOnlyNetwork();',
    'let server;',
    'let close=()=>{};',
    '(async()=>{try{',
    "  const {createApp}=require('./server/index');",
    "  const connection=require('./server/db/connection');",
    '  close=connection.closeDb;',
    "  server=await new Promise((resolve,reject)=>{const s=createApp().listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});",
    "  const base='http://127.0.0.1:'+server.address().port;",
    "  const request=(pathname,body,token='')=>fetch(base+pathname,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});",
    "  const bad=await request('/api/auth',{userId:process.env.S14_TEST_ADMIN,password:'wrong-password'});",
    '  if(bad.status!==403)process.exitCode=20;',
    "  const login=await request('/api/auth',{userId:process.env.S14_TEST_ADMIN,password:process.env.S14_TEST_PASSWORD});",
    '  const loginBody=await login.json();',
    '  if(login.status!==200||!loginBody.success||!loginBody.token)process.exitCode=21;',
    "  const legal=await fetch(base+'/api/v2/legal-texts/current');",
    '  const legalBody=await legal.json();',
    '  if(legal.status!==200||!legalBody.success||Object.keys(legalBody.texts||{}).length!==4)process.exitCode=22;',
    "  const reauth=await request('/api/v2/reauth-assertions',{purpose:'child_enrollment',password:process.env.S14_TEST_PASSWORD},loginBody.token);",
    '  const reauthBody=await reauth.json();',
    '  if(reauth.status!==200||!reauthBody.success||!reauthBody.reauthAssertion)process.exitCode=23;',
    '  const db=connection.getDb();',
    "  for(const table of ['child_privacy_states','guardian_consents','device_bindings','device_sessions','point_accounts','transactions','point_requests','data_rights_requests','audit_events']){if(db.prepare('SELECT COUNT(*) c FROM '+table).get().c!==0)process.exitCode=24;}",
    "  if(db.prepare('SELECT COUNT(*) c FROM rules').get().c!==0)process.exitCode=25;",
    "  const family=db.prepare(\"SELECT invite_code,invite_json FROM families WHERE id='default'\").get();",
    '  if(!family||family.invite_code!==null||family.invite_json!==null)process.exitCode=26;',
    '}finally{',
    '  if(server)await new Promise(resolve=>server.close(resolve));',
    '  close();',
    '  restore();',
    '}})().catch(()=>{process.exitCode=30;});'
  ].join('\n');
  // Test-only synthetic credentials are passed under names the bootstrap does
  // not read; they exercise the normal login/reauth endpoints after bootstrap.
  const result = await spawnNode(['-e', program], {
    ...runtimeEnvironment,
    S14_TEST_ADMIN: value.input.administrator.id,
    S14_TEST_PASSWORD: value.password
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(path.join(value.environment.DATA_DIR, '.secret')), true);
});
