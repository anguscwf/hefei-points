const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const prepareScript = path.join(projectRoot, 'scripts', 'prepare-synthetic-data-root.js');
const verifyScript = path.join(projectRoot, 'scripts', 'verify-synthetic-data-root.js');
const profile = require('../config/deployment-profile');
const runtimeFilesystem = require('../config/synthetic-runtime-filesystem');
const rootTools = require('../../scripts/support/synthetic-data-root-tools');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-root-tools-'));
let sequence = 0;

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function removeCase(caseRoot) {
  const resolved = path.resolve(caseRoot);
  assert.equal(isWithin(tempRoot, resolved), true);
  assert.notEqual(resolved, tempRoot);
  fs.rmSync(resolved, { recursive: true, force: true });
}

after(() => {
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  fs.rmdirSync(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false);
});

function syntheticCase(label) {
  sequence += 1;
  const suffix = `${String(sequence).padStart(2, '0')}-${label}`.toLowerCase();
  const caseRoot = path.join(tempRoot, `case-${suffix}`);
  const approvedParent = path.join(caseRoot, 'approved-parent');
  const root = path.join(approvedParent, `tangguan-synthetic-${suffix}`);
  const origin = `https://synthetic-${sequence}.example.com`;
  const datasetId = `synthetic-root-${sequence}`;
  const appId = `wx${sequence.toString(16).padStart(16, '0')}`;
  const secret = `synthetic-root-secret-${sequence}-only`;
  fs.mkdirSync(approvedParent, { recursive: true, mode: 0o700 });
  const environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    SYNTHETIC_RUNTIME_ACK: profile.SYNTHETIC_RUNTIME_ACK,
    SYNTHETIC_APP_CREDENTIALS_ACK: profile.SYNTHETIC_APP_CREDENTIALS_ACK,
    SYNTHETIC_DATA_ACK: profile.SYNTHETIC_DATA_ACK,
    SYNTHETIC_DATA_ROOT_PREPARE_ACK: 'prepare-new-empty-synthetic-root-v1',
    SYNTHETIC_DATA_ROOT_APPROVED_PARENT: approvedParent,
    SYNTHETIC_DATASET_ID: datasetId,
    SYNTHETIC_DATA_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    SQLITE_FILE: path.join(root, 'data', 'hefei-points-synthetic.sqlite'),
    API_PUBLIC_ORIGIN: origin,
    LEGAL_PUBLIC_ORIGIN: origin,
    GUARDIAN_RELATION_DECLARATION_VERSION: 'synthetic-relation-v1',
    GUARDIAN_RELATION_DECLARATION_SHA256: 'e'.repeat(64),
    GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
      `${origin}/legal/guardian-relation-declaration/synthetic-relation-v1/${'e'.repeat(64)}.html`,
    WX_APPID: appId,
    WX_APPSECRET: secret,
    HARMONY_CHILD_ENABLED: 'true',
    CHILD_ENROLLMENT_ENABLED: 'true',
    DEVICE_PAIRING_ENABLED: 'true',
    POINT_REQUESTS_ENABLED: 'true',
    CHILD_DATA_RIGHTS_ENABLED: 'false',
    LEGACY_CHILD_LOGIN_ENABLED: 'false',
    LEGACY_CHILD_MANAGEMENT_ENABLED: 'false',
    PAIRING_CLIENT_IP_MODE: 'direct',
    TRUSTED_PROXIES: '',
    LOG_LEVEL: 'info'
  };
  return { caseRoot, approvedParent, root, origin, datasetId, appId, secret, environment };
}

function assertToolCode(work, expectedCode) {
  assert.throws(work, error => error && error.code === expectedCode);
}

function assertNoRuntimeFiles(value) {
  const data = path.join(value.root, 'data');
  assert.deepEqual(fs.readdirSync(data), []);
  assert.equal(fs.existsSync(path.join(data, 'hefei-points-synthetic.sqlite')), false);
  assert.equal(fs.existsSync(path.join(data, '.secret')), false);
}

function childEnvironment(environment) {
  const result = {};
  for (const name of [
    'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR'
  ]) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  return { ...result, ...environment };
}

function runChild(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: childEnvironment(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assertEvidenceIsRedacted(evidence, value) {
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    value.caseRoot,
    value.approvedParent,
    value.root,
    value.origin,
    value.appId,
    value.secret,
    value.datasetId
  ]) {
    assert.equal(serialized.includes(forbidden), false, `evidence disclosed ${forbidden}`);
  }
}

test('prepare 创建全新空数据根，verify 只返回脱敏 readiness 证据', async () => {
  const value = syntheticCase('success');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    assert.deepEqual(fs.readdirSync(value.root).sort(), [
      runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME,
      'data'
    ].sort());
    assertNoRuntimeFiles(value);

    const evidence = rootTools.verifySyntheticDataRoot(value.environment);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.profile, 'synthetic-data-root-readiness');
    assert.equal(evidence.result, 'verified');
    assert.equal(evidence.filesystem.rootEntryCount, 2);
    assert.equal(evidence.filesystem.dataEntryCount, 0);
    assert.equal(evidence.filesystem.sqlitePresent, false);
    assert.equal(evidence.filesystem.tokenSecretPresent, false);
    assert.deepEqual(evidence.externalVerification, {
      appIdProvisioningVerified: false,
      developerAuthorizationVerified: false,
      appSecretIndependenceVerified: false,
      requestDomainVerified: false,
      businessDomainVerified: false,
      dnsVerified: false,
      tlsVerified: false,
      osAccountVerified: false,
      aclVerified: false,
      ownerVerified: false,
      diskIsolationVerified: false,
      backupIsolationVerified: false,
      databaseContentVerified: false,
      infrastructureConnectivityVerified: false,
      legalRecordsVerified: false,
      productionRootIsolationVerified: false
    });
    assert.deepEqual(evidence.operations, {
      deploymentPerformed: false,
      databaseOpened: false,
      networkAccessPerformed: false,
      serverStarted: false,
      subprocessStarted: false,
      devToolsInvoked: false,
      previewOrUploadPerformed: false,
      adultDeviceSmokeVerified: false,
      huksAssetStoreRuntimeVerified: false
    });
    assert.deepEqual(evidence.productionChildGate, {
      deployedStateVerified: false,
      changeAttempted: false
    });
    assertEvidenceIsRedacted(evidence, value);

    const cli = await runChild(verifyScript, value.environment);
    assert.equal(cli.code, 0);
    assert.equal(cli.signal, null);
    assert.equal(cli.stderr, '');
    const lines = cli.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const cliEvidence = JSON.parse(lines[0]);
    assert.deepEqual(cliEvidence, evidence);
    assertEvidenceIsRedacted(cliEvidence, value);

    if (process.platform === 'win32') {
      assert.equal(cliEvidence.externalVerification.aclVerified, false);
      assert.equal(cliEvidence.externalVerification.ownerVerified, false);
    } else {
      const rootMode = fs.statSync(value.root).mode & 0o777;
      const dataMode = fs.statSync(path.join(value.root, 'data')).mode & 0o777;
      const markerMode = fs.statSync(path.join(
        value.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME
      )).mode & 0o777;
      assert.equal(rootMode, 0o700);
      assert.equal(dataMode, 0o700);
      assert.equal(markerMode, 0o600);
    }
  } finally {
    removeCase(value.caseRoot);
  }
});

test('prepare 对任何既存 root fail closed，二次执行不接管也不改写', () => {
  const value = syntheticCase('existing');
  try {
    fs.mkdirSync(value.root, { mode: 0o700 });
    const sentinel = path.join(value.root, 'operator-owned-sentinel');
    fs.writeFileSync(sentinel, 'do-not-touch', { flag: 'wx' });
    assertToolCode(
      () => rootTools.prepareSyntheticDataRoot(value.environment),
      'ROOT_ALREADY_EXISTS'
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do-not-touch');
    assert.deepEqual(fs.readdirSync(value.root), ['operator-owned-sentinel']);

    fs.rmSync(value.root, { recursive: true });
    rootTools.prepareSyntheticDataRoot(value.environment);
    const marker = path.join(value.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME);
    const before = fs.readFileSync(marker);
    assertToolCode(
      () => rootTools.prepareSyntheticDataRoot(value.environment),
      'ROOT_ALREADY_EXISTS'
    );
    assert.equal(fs.readFileSync(marker).equals(before), true);
    assertNoRuntimeFiles(value);
  } finally {
    removeCase(value.caseRoot);
  }
});

test('两个并发 prepare 对同一 root 只允许一个成功', async () => {
  const value = syntheticCase('concurrent');
  try {
    const results = await Promise.all([
      runChild(prepareScript, value.environment),
      runChild(prepareScript, value.environment)
    ]);
    assert.deepEqual(results.map(item => item.code).sort(), [0, 1]);
    const winner = results.find(item => item.code === 0);
    const loser = results.find(item => item.code === 1);
    assert.equal(winner.signal, null);
    assert.equal(winner.stderr, '');
    assert.match(winner.stdout, /^[A-Z][A-Z0-9_]*\r?\n$/);
    assert.equal(loser.stdout, '');
    assert.match(loser.stderr, /^ROOT_ALREADY_EXISTS\r?\n$/);
    for (const output of [winner.stdout, loser.stderr]) {
      for (const forbidden of [value.root, value.origin, value.appId, value.secret, value.datasetId]) {
        assert.equal(output.includes(forbidden), false);
      }
    }
    assert.equal(rootTools.verifySyntheticDataRoot(value.environment).result, 'verified');
    assertNoRuntimeFiles(value);
    assert.deepEqual(fs.readdirSync(value.approvedParent), [path.basename(value.root)]);
  } finally {
    removeCase(value.caseRoot);
  }
});

test('approved parent 自身为 symlink 或 junction 时拒绝且不创建 root', t => {
  const value = syntheticCase('parent-link');
  const physical = path.join(value.caseRoot, 'physical-parent');
  const alias = path.join(value.caseRoot, 'approved-parent-alias');
  fs.mkdirSync(physical, { mode: 0o700 });
  try {
    try {
      fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.diagnostic('当前平台不能创建 symlink/junction；运行时链接拒绝已有其他测试覆盖');
        return;
      }
      throw error;
    }
    const linkedRoot = path.join(alias, 'tangguan-synthetic-linked-root');
    const environment = {
      ...value.environment,
      SYNTHETIC_DATA_ROOT_APPROVED_PARENT: alias,
      SYNTHETIC_DATA_ROOT: linkedRoot,
      DATA_DIR: path.join(linkedRoot, 'data'),
      SQLITE_FILE: path.join(linkedRoot, 'data', 'hefei-points-synthetic.sqlite')
    };
    assertToolCode(
      () => rootTools.prepareSyntheticDataRoot(environment),
      'APPROVED_PARENT_UNSAFE'
    );
    assert.equal(fs.existsSync(path.join(physical, path.basename(linkedRoot))), false);
  } finally {
    removeCase(value.caseRoot);
  }
});

test('prepare 中途失败保留不可用残根，后续 prepare 不会接管', () => {
  for (const phase of ['afterRootCreate', 'afterDataCreate']) {
    const value = syntheticCase(`partial-${phase.toLowerCase()}`);
    try {
      assert.throws(
        () => rootTools.prepareSyntheticDataRoot(value.environment, {
          onPhase(current) {
            if (current === phase) throw new Error(`synthetic fault at ${phase}`);
          }
        }),
        new RegExp(`synthetic fault at ${phase}`)
      );
      assert.equal(fs.existsSync(value.root), true);
      assert.equal(
        fs.existsSync(path.join(value.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME)),
        false
      );
      assertToolCode(
        () => rootTools.prepareSyntheticDataRoot(value.environment),
        'ROOT_ALREADY_EXISTS'
      );
      assertToolCode(
        () => rootTools.verifySyntheticDataRoot(value.environment),
        'ROOT_BOUNDARY_UNSAFE'
      );
    } finally {
      removeCase(value.caseRoot);
    }
  }
});

test('marker、额外条目和硬链接篡改均 fail closed', t => {
  const cases = [
    {
      name: 'marker',
      tamper(value) {
        fs.writeFileSync(
          path.join(value.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME),
          '{}\n'
        );
      }
    },
    {
      name: 'extra',
      tamper(value) {
        fs.writeFileSync(path.join(value.root, 'unexpected.txt'), 'unexpected', { flag: 'wx' });
      }
    },
    {
      name: 'hardlink',
      tamper(value) {
        const marker = path.join(value.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME);
        const external = path.join(value.caseRoot, 'external-marker');
        fs.writeFileSync(external, fs.readFileSync(marker), { flag: 'wx', mode: 0o600 });
        fs.unlinkSync(marker);
        fs.linkSync(external, marker);
        assert.ok(fs.statSync(marker).nlink > 1);
      }
    }
  ];

  for (const entry of cases) {
    const value = syntheticCase(`tamper-${entry.name}`);
    try {
      rootTools.prepareSyntheticDataRoot(value.environment);
      try {
        entry.tamper(value);
      } catch (error) {
        if (entry.name === 'hardlink'
            && error && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
          t.diagnostic('当前平台不能创建硬链接；single-link 检查已有静态实现覆盖');
          continue;
        }
        throw error;
      }
      assertToolCode(
        () => rootTools.verifySyntheticDataRoot(value.environment),
        'ROOT_BOUNDARY_UNSAFE'
      );
    } finally {
      removeCase(value.caseRoot);
    }
  }
});

test('marker 绑定 dataset、origin 和 AppID，配置漂移不能通过 verify', () => {
  const value = syntheticCase('config-drift');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    const otherOrigin = 'https://synthetic-drift.example.net';
    const drifted = [
      { ...value.environment, SYNTHETIC_DATASET_ID: 'synthetic-different-dataset' },
      { ...value.environment, WX_APPID: 'wxfedcba9876543210' },
      {
        ...value.environment,
        API_PUBLIC_ORIGIN: otherOrigin,
        LEGAL_PUBLIC_ORIGIN: otherOrigin,
        GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
          `${otherOrigin}/legal/guardian-relation-declaration/synthetic-relation-v1/${'e'.repeat(64)}.html`
      }
    ];
    for (const environment of drifted) {
      assertToolCode(
        () => rootTools.verifySyntheticDataRoot(environment),
        'ROOT_BOUNDARY_UNSAFE'
      );
    }
    assert.equal(rootTools.verifySyntheticDataRoot(value.environment).result, 'verified');
  } finally {
    removeCase(value.caseRoot);
  }
});

test('verify 两轮之间发生文件系统漂移时拒绝发布证据', () => {
  const value = syntheticCase('verify-race');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    const raceFile = path.join(value.root, 'race-entry');
    const phases = [];
    assertToolCode(
      () => rootTools.verifySyntheticDataRoot(value.environment, {
        onPhase(phase) {
          phases.push(phase);
          if (phase === 'afterFirstValidation') {
            fs.writeFileSync(raceFile, 'race', { flag: 'wx' });
          }
        }
      }),
      'ROOT_CHANGED_DURING_VERIFICATION'
    );
    assert.ok(phases.includes('afterFirstValidation'));
    assert.equal(fs.existsSync(raceFile), true);
  } finally {
    removeCase(value.caseRoot);
  }
});

test('verify 不依赖 prepare ACK，prepare 缺失或错误 ACK 不创建 root', () => {
  const prepared = syntheticCase('ack-verify');
  try {
    rootTools.prepareSyntheticDataRoot(prepared.environment);
    const verifyEnvironment = { ...prepared.environment };
    delete verifyEnvironment.SYNTHETIC_DATA_ROOT_PREPARE_ACK;
    assert.equal(rootTools.verifySyntheticDataRoot(verifyEnvironment).result, 'verified');
  } finally {
    removeCase(prepared.caseRoot);
  }

  for (const ack of [undefined, '', 'prepare-synthetic-root-yes']) {
    const value = syntheticCase(`ack-reject-${ack === undefined ? 'missing' : 'wrong'}`);
    try {
      const environment = { ...value.environment };
      if (ack === undefined) delete environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK;
      else environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK = ack;
      assertToolCode(
        () => rootTools.prepareSyntheticDataRoot(environment),
        'PREPARE_ACK_REQUIRED'
      );
      assert.equal(fs.existsSync(value.root), false);
      assert.deepEqual(fs.readdirSync(value.approvedParent), []);
    } finally {
      removeCase(value.caseRoot);
    }
  }
});

test('approved parent 必须存在、canonical 且精确等于 root dirname', () => {
  const cases = [];

  const missing = syntheticCase('parent-missing');
  const missingParent = path.join(missing.caseRoot, 'missing-approved-parent');
  const missingRoot = path.join(missingParent, 'tangguan-synthetic-missing-parent');
  cases.push({
    value: missing,
    environment: {
      ...missing.environment,
      SYNTHETIC_DATA_ROOT_APPROVED_PARENT: missingParent,
      SYNTHETIC_DATA_ROOT: missingRoot,
      DATA_DIR: path.join(missingRoot, 'data'),
      SQLITE_FILE: path.join(missingRoot, 'data', 'hefei-points-synthetic.sqlite')
    },
    absentRoot: missingRoot
  });

  const mismatch = syntheticCase('parent-mismatch');
  const otherParent = path.join(mismatch.caseRoot, 'other-parent');
  fs.mkdirSync(otherParent, { mode: 0o700 });
  const otherRoot = path.join(otherParent, 'tangguan-synthetic-mismatched-parent');
  cases.push({
    value: mismatch,
    environment: {
      ...mismatch.environment,
      SYNTHETIC_DATA_ROOT: otherRoot,
      DATA_DIR: path.join(otherRoot, 'data'),
      SQLITE_FILE: path.join(otherRoot, 'data', 'hefei-points-synthetic.sqlite')
    },
    absentRoot: otherRoot
  });

  const noncanonical = syntheticCase('parent-noncanonical');
  cases.push({
    value: noncanonical,
    environment: {
      ...noncanonical.environment,
      SYNTHETIC_DATA_ROOT_APPROVED_PARENT: `${noncanonical.approvedParent}${path.sep}.`
    },
    absentRoot: noncanonical.root
  });

  for (const entry of cases) {
    try {
      assertToolCode(
        () => rootTools.prepareSyntheticDataRoot(entry.environment),
        'APPROVED_PARENT_UNSAFE'
      );
      assert.equal(fs.existsSync(entry.absentRoot), false);
    } finally {
      removeCase(entry.value.caseRoot);
    }
  }
});

test('parseArguments 只接受空参数或单个 --help', () => {
  assert.deepEqual(rootTools.parseArguments([]), { help: false });
  assert.deepEqual(rootTools.parseArguments(['--help']), { help: true });
  for (const argv of [
    null,
    '',
    [''],
    ['--help', '--help'],
    ['--approved-parent', 'C:\\synthetic'],
    ['--force'],
    ['--output=synthetic']
  ]) {
    assertToolCode(() => rootTools.parseArguments(argv), 'ARGUMENT_INVALID');
  }
});

test('verify 是只读操作，不调用 fs 写入、删除、链接或改名 API', () => {
  const value = syntheticCase('verify-read-only');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    const originals = new Map();
    const mutationMethods = [
      'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
      'copyFile', 'copyFileSync', 'cp', 'cpSync', 'fchmod', 'fchmodSync',
      'fchown', 'fchownSync', 'ftruncate', 'ftruncateSync', 'fsync', 'fsyncSync',
      'link', 'linkSync', 'lutimes', 'lutimesSync', 'mkdir', 'mkdirSync',
      'mkdtemp', 'mkdtempSync', 'rename', 'renameSync',
      'rm', 'rmSync', 'rmdir', 'rmdirSync', 'symlink', 'symlinkSync',
      'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync',
      'write', 'writeFile', 'writeFileSync', 'writeSync'
    ];
    try {
      for (const name of mutationMethods) {
        if (typeof fs[name] !== 'function') continue;
        originals.set(name, fs[name]);
        fs[name] = function forbiddenMutation() {
          throw new Error(`verify invoked fs.${name}`);
        };
      }
      const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
        | fs.constants.O_TRUNC | fs.constants.O_APPEND;
      for (const name of ['open', 'openSync']) {
        const original = fs[name];
        originals.set(name, original);
        fs[name] = function guardedReadOnlyOpen(filename, flags, ...args) {
          const mutating = typeof flags === 'number'
            ? (flags & writeFlags) !== 0
            : typeof flags !== 'string' || /[wax+]/.test(flags);
          if (mutating) throw new Error(`verify invoked mutating fs.${name}`);
          return original.call(this, filename, flags, ...args);
        };
      }
      assert.equal(rootTools.verifySyntheticDataRoot(value.environment).result, 'verified');
    } finally {
      for (const [name, original] of originals) fs[name] = original;
    }
  } finally {
    removeCase(value.caseRoot);
  }
});

test('verify 对四个持久运行文件只报告 presence，不读取正文', () => {
  const value = syntheticCase('allowed-runtime-files');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    const data = path.join(value.root, 'data');
    const canaries = {
      'hefei-points-synthetic.sqlite': `sqlite-canary-${value.root}`,
      'hefei-points-synthetic.sqlite-wal': `wal-canary-${value.origin}`,
      'hefei-points-synthetic.sqlite-shm': `shm-canary-${value.appId}`,
      '.secret': `secret-canary-${value.secret}-${value.datasetId}`
    };
    for (const [name, content] of Object.entries(canaries)) {
      fs.writeFileSync(path.join(data, name), content, { flag: 'wx', mode: 0o600 });
    }

    const evidence = rootTools.verifySyntheticDataRoot(value.environment);
    assert.equal(evidence.filesystem.dataEntryCount, 4);
    assert.equal(evidence.filesystem.sqlitePresent, true);
    assert.equal(evidence.filesystem.sqliteWalPresent, true);
    assert.equal(evidence.filesystem.sqliteShmPresent, true);
    assert.equal(evidence.filesystem.tokenSecretPresent, true);
    const serialized = JSON.stringify(evidence);
    for (const content of Object.values(canaries)) {
      assert.equal(serialized.includes(content), false);
    }
    assertEvidenceIsRedacted(evidence, value);
  } finally {
    removeCase(value.caseRoot);
  }
});

test('verify 拒绝 bootstrap 正在进行或崩溃遗留的锁文件', () => {
  const value = syntheticCase('bootstrap-lock');
  try {
    rootTools.prepareSyntheticDataRoot(value.environment);
    const lock = path.join(value.root, 'data', '.synthetic-bootstrap.lock');
    fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 });
    assertToolCode(
      () => rootTools.verifySyntheticDataRoot(value.environment),
      'ROOT_BOUNDARY_UNSAFE'
    );
  } finally {
    removeCase(value.caseRoot);
  }
});

test('CLI 错误只输出稳定代码，不泄露配置或本机路径', async () => {
  const value = syntheticCase('redacted-error');
  try {
    fs.mkdirSync(value.root, { mode: 0o700 });
    const result = await runChild(prepareScript, value.environment);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^ROOT_ALREADY_EXISTS\r?\n$/);
    for (const forbidden of [
      value.caseRoot, value.approvedParent, value.root,
      value.origin, value.appId, value.secret, value.datasetId
    ]) {
      assert.equal(result.stderr.includes(forbidden), false);
    }
  } finally {
    removeCase(value.caseRoot);
  }
});
