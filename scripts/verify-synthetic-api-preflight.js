const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const implementationFiles = Object.freeze([
  'package.json',
  'scripts/bootstrap-synthetic-database.js',
  'scripts/capture-synthetic-candidate-evidence.js',
  'scripts/consume-synthetic-deployment-grant.js',
  'scripts/finalize-synthetic-candidate-evidence.js',
  'scripts/init-synthetic-authorization-ledger.js',
  'scripts/preflight-synthetic-api.js',
  'scripts/prepare-synthetic-authority-coordination-intent.js',
  'scripts/prepare-synthetic-data-root.js',
  'scripts/support/synthetic-authority-coordination-intent.js',
  'scripts/support/synthetic-authorization-consumer.js',
  'scripts/support/synthetic-bootstrap.js',
  'scripts/support/synthetic-candidate-evidence.js',
  'scripts/support/synthetic-data-root-tools.js',
  'scripts/support/synthetic-external-approval.js',
  'scripts/support/synthetic-preflight-offline-guard.js',
  'scripts/verify-synthetic-api-preflight.js',
  'scripts/verify-synthetic-data-root.js',
  'scripts/verify-synthetic-external-approval.js',
  'server/config/defaults.js',
  'server/config/deployment-profile.js',
  'server/config/env.js',
  'server/config/guardian-consent.js',
  'server/config/synthetic-runtime-filesystem.js',
  'server/db/connection.js',
  'server/db/migrations.js',
  'server/db/migrations/001_init.sql',
  'server/db/migrations/002_token_revocation.sql',
  'server/db/migrations/003_transaction_soft_delete.sql',
  'server/db/migrations/004_family_rules_history.sql',
  'server/db/migrations/005_transaction_rule_ids.sql',
  'server/db/migrations/006_guardian_consent_enrollment.sql',
  'server/db/migrations/007_device_pairing_sessions.sql',
  'server/db/migrations/008_point_requests_transaction_sources.sql',
  'server/db/migrations/009_data_rights_audit.sql',
  'server/db/migrations/010_synthetic_bootstrap_receipt.sql',
  'server/lib/backup.js',
  'server/lib/password.js',
  'server/lib/token.js',
  'server/lib/wx-auth.js',
  'server/routes/backup.js'
]);
const migrationImplementationFiles = Object.freeze(
  implementationFiles.filter(filename => filename.startsWith('server/db/migrations/'))
);

function assertExactMigrationDirectory() {
  const entries = fs.readdirSync(
    path.join(projectRoot, 'server', 'db', 'migrations'),
    { withFileTypes: true }
  );
  const sqlEntries = entries.filter(entry => entry.name.endsWith('.sql'));
  const actual = sqlEntries.map(entry => `server/db/migrations/${entry.name}`).sort();
  if (sqlEntries.some(entry => !entry.isFile() || entry.isSymbolicLink())
      || actual.length !== migrationImplementationFiles.length
      || actual.some((filename, index) => filename !== migrationImplementationFiles[index])) {
    fail('MIGRATION_SET_INVALID');
  }
}
const verificationPrefix = 'tangguan-synthetic-api-preflight-verification-';
const stagingPrefix = '.tangguan-api-preflight-stage-';
const evidenceName = '.synthetic-api-preflight.json';
const guardRootEnvironment = 'TANGGUAN_PREFLIGHT_GUARD_ROOT';
const guardOutputEnvironment = 'TANGGUAN_PREFLIGHT_GUARD_OUTPUT';

class VerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VerificationError';
    this.code = code;
  }
}

function fail(code) {
  throw new VerificationError(code);
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function minimumEnvironment() {
  const environment = {};
  const inherited = new Set([
    'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR'
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (inherited.has(key.toUpperCase()) && typeof value === 'string') {
      environment[key] = value;
    }
  }
  return environment;
}

function readOnlyGitEnvironment() {
  return {
    ...minimumEnvironment(),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0'
  };
}

function environmentValue(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name);
  return entry && entry[1];
}

function executableIdentity(filename) {
  const real = realpathSync(filename);
  const metadata = fs.statSync(real);
  if (!metadata.isFile()) fail('GIT_EXECUTABLE_INVALID');
  return Object.freeze({
    real,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    birthtimeMs: metadata.birthtimeMs
  });
}

function resolveGitExecutable(environment) {
  const searchPath = environmentValue(environment, 'PATH');
  if (typeof searchPath !== 'string' || !searchPath) fail('GIT_EXECUTABLE_INVALID');
  const realProjectRoot = realpathSync(projectRoot);
  const realTemporaryRoot = realpathSync(os.tmpdir());
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const rawDirectory of searchPath.split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, '');
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executableName);
    if (!fs.existsSync(candidate)) continue;
    const identity = executableIdentity(candidate);
    if (!isWithin(realProjectRoot, identity.real)
        && !isWithin(realTemporaryRoot, identity.real)) {
      return identity;
    }
  }
  fail('GIT_EXECUTABLE_INVALID');
}

function assertExecutableIdentity(expected) {
  const actual = executableIdentity(expected.real);
  if (!samePath(actual.real, expected.real)
      || actual.dev !== expected.dev || actual.ino !== expected.ino
      || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs
      || actual.birthtimeMs !== expected.birthtimeMs) {
    fail('GIT_EXECUTABLE_CHANGED');
  }
}

const gitEnvironment = Object.freeze(readOnlyGitEnvironment());
const gitExecutable = resolveGitExecutable(gitEnvironment);

function git(arguments_, options = {}) {
  assertExecutableIdentity(gitExecutable);
  const result = execFileSync(gitExecutable.real, [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', `safe.directory=${realpathSync(projectRoot)}`,
    ...arguments_
  ], {
    cwd: projectRoot,
    windowsHide: true,
    env: gitEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  assertExecutableIdentity(gitExecutable);
  return result;
}

function parseIndexEntries(output) {
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) fail('INDEX_ENTRY_INVALID');
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function parseHeadEntries(output) {
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) fail('HEAD_ENTRY_INVALID');
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function entrySignature(entries) {
  return entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.filename}`).join('\0');
}

function implementationSnapshot(commit) {
  const index = parseIndexEntries(git([
    'ls-files', '--stage', '-z', '--', ...implementationFiles
  ], { encoding: 'utf8' }));
  const head = parseHeadEntries(git([
    'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...implementationFiles
  ], { encoding: 'utf8' }));
  if (index.length !== implementationFiles.length
      || entrySignature(index) !== entrySignature(head)
      || index.map(entry => entry.filename).join('\0') !== implementationFiles.join('\0')) {
    fail('INDEX_HEAD_MISMATCH');
  }
  return Object.freeze({
    indexSignature: entrySignature(index),
    headSignature: entrySignature(head),
    head
  });
}

function readBatchBlobs(entries) {
  const output = git(['cat-file', '--batch'], {
    encoding: null,
    input: `${entries.map(entry => entry.oid).join('\n')}\n`
  });
  const inputs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) fail('BLOB_RESPONSE_INVALID');
    const match = /^((?:[0-9a-f]{40}|[0-9a-f]{64})) blob (0|[1-9][0-9]*)$/.exec(
      output.subarray(offset, headerEnd).toString('utf8')
    );
    if (!match || /^0+$/.test(match[1]) || match[1] !== entry.oid) {
      fail('BLOB_RESPONSE_INVALID');
    }
    const length = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0
        || length > output.length - start - 1
        || output[end] !== 0x0a) {
      fail('BLOB_RESPONSE_INVALID');
    }
    inputs.push({ filename: entry.filename, content: output.subarray(start, end) });
    offset = end + 1;
  }
  if (offset !== output.length) fail('BLOB_RESPONSE_INVALID');
  return inputs;
}

function canonicalLineEndings(content) {
  const normalized = Buffer.allocUnsafe(content.length);
  let writeOffset = 0;
  for (let readOffset = 0; readOffset < content.length; readOffset += 1) {
    const byte = content[readOffset];
    if (byte === 0x0d) {
      if (content[readOffset + 1] !== 0x0a) return null;
      continue;
    }
    normalized[writeOffset] = byte;
    writeOffset += 1;
  }
  return normalized.subarray(0, writeOffset);
}

function worktreeMatchesCommitted(running, committed) {
  if (running.equals(committed)) return true;
  const normalizedRunning = canonicalLineEndings(running);
  const normalizedCommitted = canonicalLineEndings(committed);
  return normalizedRunning !== null && normalizedCommitted !== null
    && normalizedRunning.equals(normalizedCommitted);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sensitiveConfigurationBinding(environment) {
  const proxies = String(environment.TRUSTED_PROXIES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .sort();
  const publicContext = {
    schemaVersion: 1,
    purpose: 'synthetic-sensitive-configuration-context-v1',
    apiOriginSha256: sha256(environment.API_PUBLIC_ORIGIN),
    datasetIdSha256: sha256(environment.SYNTHETIC_DATASET_ID),
    wechatAppIdSha256: sha256(environment.WX_APPID),
    proxyMode: environment.PAIRING_CLIENT_IP_MODE,
    trustedProxySetSha256: sha256(JSON.stringify(proxies))
  };
  const appSecretKeyedProofSha256 = crypto.createHmac(
    'sha256',
    environment.WX_APPSECRET
  ).update(JSON.stringify(publicContext)).digest('hex');
  return sha256(JSON.stringify({
    schemaVersion: 1,
    purpose: 'synthetic-sensitive-configuration-binding-v1',
    publicContext,
    appSecretKeyedProofSha256
  }));
}

function captureExpectedProvenance() {
  assertExactMigrationDirectory();
  const canonicalRoot = realpathSync(projectRoot);
  const rootOutput = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const rootMatch = /^([^\r\n]+)\n$/.exec(rootOutput);
  const gitRoot = rootMatch && rootMatch[1];
  if (!gitRoot || !samePath(realpathSync(gitRoot), canonicalRoot)) fail('GIT_ROOT_INVALID');
  const commitOutput = git(['rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8'
  });
  const commitMatch = /^((?:[0-9a-f]{40}|[0-9a-f]{64}))\n$/.exec(commitOutput);
  const sourceCommit = commitMatch && commitMatch[1];
  if (!sourceCommit || /^0+$/.test(sourceCommit)) fail('HEAD_INVALID');
  const snapshot = implementationSnapshot(sourceCommit);
  const inputs = readBatchBlobs(snapshot.head);
  const treeDigest = crypto.createHash('sha256');
  for (const input of inputs) {
    const running = fs.readFileSync(path.join(projectRoot, ...input.filename.split('/')));
    if (!worktreeMatchesCommitted(running, input.content)) fail('WORKTREE_HEAD_MISMATCH');
    treeDigest.update(Buffer.from(`${input.filename}\0${input.content.length}\0`, 'utf8'));
    treeDigest.update(input.content);
  }
  assertExactMigrationDirectory();
  return Object.freeze({
    sourceCommit,
    indexSignature: snapshot.indexSignature,
    headSignature: snapshot.headSignature,
    implementationTreeSha256: treeDigest.digest('hex'),
    implementationFiles: inputs.map(input => Object.freeze({
      path: input.filename,
      sha256: sha256(input.content)
    }))
  });
}

function lockedCommittedProvenance() {
  const first = captureExpectedProvenance();
  const second = captureExpectedProvenance();
  if (canonicalJson(first) !== canonicalJson(second)) fail('REPOSITORY_STATE_CHANGED');
  return Object.freeze({
    sourceCommit: second.sourceCommit,
    implementationIndexMatchesHead: true,
    implementationWorktreeMatchesHeadAfterEolNormalization: true,
    implementationTreeSha256: second.implementationTreeSha256,
    implementationFiles: second.implementationFiles
  });
}

function syntheticEnvironment(verificationRoot, nonce) {
  const origin = 'https://synthetic-api.example.com';
  const guardianSha256 = sha256(Buffer.from('synthetic guardian declaration fixture', 'utf8'));
  const dataRoot = path.join(verificationRoot, `tangguan-synthetic-verify-${nonce}`);
  return {
    ...minimumEnvironment(),
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    SYNTHETIC_RUNTIME_ACK: 'synthetic-api-runtime-v1',
    SYNTHETIC_APP_CREDENTIALS_ACK: 'independent-synthetic-wechat-v1',
    SYNTHETIC_DATA_ACK: 'synthetic-data-only-v1',
    SYNTHETIC_DATASET_ID: 'synthetic-preflight-verifier',
    SYNTHETIC_DATA_ROOT: dataRoot,
    DATA_DIR: path.join(dataRoot, 'data'),
    SQLITE_FILE: path.join(dataRoot, 'data', 'hefei-points-synthetic.sqlite'),
    API_PUBLIC_ORIGIN: origin,
    LEGAL_PUBLIC_ORIGIN: origin,
    GUARDIAN_RELATION_DECLARATION_VERSION: 'synthetic-relation-v1',
    GUARDIAN_RELATION_DECLARATION_SHA256: guardianSha256,
    GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
      `${origin}/legal/guardian-relation-declaration/synthetic-relation-v1/${guardianSha256}.html`,
    WX_APPID: 'wx0123456789abcdef',
    WX_APPSECRET: crypto.randomBytes(32).toString('hex'),
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
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectStrings(item, output));
  }
  return output;
}

function assertEvidence(evidence, raw, expected, environment, boundaries) {
  const topKeys = [
    'schemaVersion', 'profile', 'result', 'sourceCommit',
    'implementationIndexMatchesHead',
    'implementationWorktreeMatchesHeadAfterEolNormalization',
    'implementationTreeSha256', 'implementationFiles', 'configuration',
    'configurationSha256', 'externalVerification', 'productionChildGate'
  ];
  if (raw !== `${JSON.stringify(evidence, null, 2)}\n`
      || !exactKeys(evidence, topKeys)
      || evidence.schemaVersion !== 4
      || evidence.profile !== 'synthetic-api-offline-preflight'
      || evidence.result !== 'configuration-shape-validated'
      || evidence.sourceCommit !== expected.sourceCommit
      || evidence.implementationIndexMatchesHead !== true
      || evidence.implementationWorktreeMatchesHeadAfterEolNormalization !== true
      || evidence.implementationTreeSha256 !== expected.implementationTreeSha256
      || canonicalJson(evidence.implementationFiles)
        !== canonicalJson(expected.implementationFiles)) {
    fail('PROVENANCE_MISMATCH');
  }

  const expectedConfiguration = {
    deploymentTierSynthetic: true,
    nodeEnvironmentProduction: true,
    apiOriginSha256: sha256(Buffer.from(environment.API_PUBLIC_ORIGIN, 'utf8')),
    legalOriginMatchesApi: true,
    wechatAppIdSha256: sha256(Buffer.from(environment.WX_APPID, 'utf8')),
    wechatAppIdStringDiffersFromProduction: true,
    wechatSecretPresent: true,
    sensitiveConfigurationBindingSha256: sensitiveConfigurationBinding(environment),
    operatorAcknowledgementsPresent: true,
    coreFeatureGatesEnabled: true,
    closedFeatureGatesDisabled: true,
    proxyPolicyShapeValid: true,
    syntheticDataPathShapeValid: true
  };
  const expectedExternalVerification = {
    appIdProvisioningVerified: false,
    developerAuthorizationVerified: false,
    appSecretIndependenceVerified: false,
    requestDomainVerified: false,
    businessDomainVerified: false,
    dnsVerified: false,
    tlsVerified: false,
    infrastructureConnectivityVerified: false,
    databaseIsolationVerified: false,
    legalRecordsVerified: false,
    deploymentPerformed: false,
    serverStarted: false,
    databaseOpened: false,
    networkAccessPerformed: false,
    devToolsInvoked: false,
    previewOrUploadPerformed: false,
    adultDeviceSmokeVerified: false,
    huksAssetStoreRuntimeVerified: false
  };
  const expectedProductionChildGate = {
    deployedStateVerified: false,
    changeAttempted: false
  };
  if (canonicalJson(evidence.configuration) !== canonicalJson(expectedConfiguration)
      || evidence.configurationSha256
        !== sha256(Buffer.from(JSON.stringify(evidence.configuration), 'utf8'))
      || canonicalJson(evidence.externalVerification)
        !== canonicalJson(expectedExternalVerification)
      || canonicalJson(evidence.productionChildGate)
        !== canonicalJson(expectedProductionChildGate)) {
    fail('EVIDENCE_SCHEMA_INVALID');
  }

  const forbidden = [
    environment.API_PUBLIC_ORIGIN,
    environment.LEGAL_PUBLIC_ORIGIN,
    environment.GUARDIAN_RELATION_DECLARATION_VERSION,
    environment.GUARDIAN_RELATION_DECLARATION_SHA256,
    environment.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL,
    environment.WX_APPID,
    environment.WX_APPSECRET,
    environment.SYNTHETIC_RUNTIME_ACK,
    environment.SYNTHETIC_APP_CREDENTIALS_ACK,
    environment.SYNTHETIC_DATA_ACK,
    environment.SYNTHETIC_DATASET_ID,
    environment.SYNTHETIC_DATA_ROOT,
    environment.DATA_DIR,
    environment.SQLITE_FILE,
    projectRoot,
    realpathSync(projectRoot),
    boundaries.temporaryRoot,
    boundaries.realTemporaryRoot,
    boundaries.verificationRoot,
    boundaries.realVerificationRoot,
    boundaries.output
  ].filter(value => typeof value === 'string' && value.length > 0);
  for (const secret of forbidden) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (raw.includes(secret) || raw.includes(escaped)) fail('EVIDENCE_DISCLOSURE');
  }
  for (const value of collectStrings(evidence)) {
    if (forbidden.some(secret => value.includes(secret))) fail('EVIDENCE_DISCLOSURE');
  }
}

function assertEvidenceDirectory(output, realVerificationRoot) {
  const metadata = fs.lstatSync(output);
  const realOutput = realpathSync(output);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !samePath(path.dirname(realOutput), realVerificationRoot)) {
    fail('OUTPUT_INVALID');
  }
  const entries = fs.readdirSync(output, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== evidenceName
      || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    fail('OUTPUT_INVALID');
  }
  const evidenceFile = path.join(output, evidenceName);
  const evidenceMetadata = fs.lstatSync(evidenceFile);
  if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()
      || evidenceMetadata.nlink !== 1
      || !samePath(realpathSync(evidenceFile), path.join(realOutput, evidenceName))) {
    fail('OUTPUT_INVALID');
  }
  return evidenceFile;
}

function safelyRemoveEvidenceDirectory(directory, realVerificationRoot) {
  const metadata = fs.lstatSync(directory);
  const realDirectory = realpathSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !samePath(path.dirname(realDirectory), realVerificationRoot)) {
    fail('CLEANUP_TARGET_UNSAFE');
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 1 || (entries.length === 1 && entries[0].name !== evidenceName)) {
    fail('CLEANUP_TARGET_UNSAFE');
  }
  if (entries.length === 1) {
    const evidenceFile = path.join(directory, evidenceName);
    const evidenceMetadata = fs.lstatSync(evidenceFile);
    if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()
        || evidenceMetadata.nlink !== 1
        || !samePath(realpathSync(evidenceFile), path.join(realDirectory, evidenceName))) {
      fail('CLEANUP_TARGET_UNSAFE');
    }
    fs.unlinkSync(evidenceFile);
  }
  fs.rmdirSync(directory);
}

function safelyRemoveVerificationRoot(boundaries) {
  const { temporaryRoot, realTemporaryRoot, verificationRoot, realVerificationRoot } = boundaries;
  const metadata = fs.lstatSync(verificationRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !path.basename(verificationRoot).startsWith(verificationPrefix)
      || !samePath(path.dirname(verificationRoot), temporaryRoot)
      || !samePath(realpathSync(verificationRoot), realVerificationRoot)
      || !samePath(path.dirname(realVerificationRoot), realTemporaryRoot)) {
    fail('CLEANUP_TARGET_UNSAFE');
  }
  const entries = fs.readdirSync(verificationRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
        || (entry.name !== 'evidence' && !entry.name.startsWith(stagingPrefix))) {
      fail('CLEANUP_TARGET_UNSAFE');
    }
  }
  for (const entry of entries) {
    safelyRemoveEvidenceDirectory(
      path.join(verificationRoot, entry.name),
      realVerificationRoot
    );
  }
  if (fs.readdirSync(verificationRoot).length !== 0) fail('CLEANUP_TARGET_UNSAFE');
  fs.rmdirSync(verificationRoot);
}

function verifyCommittedPreflight() {
  const temporaryRootValue = os.tmpdir();
  if (!path.isAbsolute(temporaryRootValue)
      || (process.platform === 'win32'
        && temporaryRootValue.replaceAll('/', '\\').startsWith('\\\\'))) {
    fail('TEMPORARY_ROOT_INVALID');
  }
  const temporaryRoot = path.resolve(temporaryRootValue);
  const temporaryMetadata = fs.lstatSync(temporaryRoot);
  if (!temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink()) {
    fail('TEMPORARY_ROOT_INVALID');
  }
  const realTemporaryRoot = realpathSync(temporaryRoot);
  const indexLockValue = git(['rev-parse', '--git-path', 'index.lock'], {
    encoding: 'utf8'
  }).trim();
  const indexLock = path.resolve(projectRoot, indexLockValue);
  if (fs.existsSync(indexLock)) fail('PRECONDITION_FAILED');
  const statusBefore = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null
  });
  const expectedBefore = captureExpectedProvenance();
  if (fs.existsSync(indexLock)) fail('PRECONDITION_FAILED');

  const verificationRoot = fs.mkdtempSync(path.join(temporaryRoot, verificationPrefix));
  const realVerificationRoot = realpathSync(verificationRoot);
  const output = path.join(verificationRoot, 'evidence');
  const nonce = crypto.randomBytes(6).toString('hex');
  const environment = syntheticEnvironment(verificationRoot, nonce);
  const boundaries = Object.freeze({
    temporaryRoot,
    realTemporaryRoot,
    verificationRoot,
    realVerificationRoot,
    output
  });

  let verificationFailure = null;
  try {
    const child = spawnSync(process.execPath, [
      '--require',
      path.join(projectRoot, 'scripts', 'support', 'synthetic-preflight-offline-guard.js'),
      path.join(projectRoot, 'scripts', 'preflight-synthetic-api.js'),
      '--output', output
    ], {
      cwd: projectRoot,
      env: {
        ...environment,
        [guardRootEnvironment]: verificationRoot,
        [guardOutputEnvironment]: output
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000
    });
    if (child.status !== 0
        || child.stdout !== 'Synthetic API offline configuration shape preflight passed.\n'
        || child.stderr !== '') {
      fail('CLI_FAILED');
    }
    const rootEntries = fs.readdirSync(verificationRoot, { withFileTypes: true });
    if (rootEntries.length !== 1 || rootEntries[0].name !== 'evidence'
        || !rootEntries[0].isDirectory() || rootEntries[0].isSymbolicLink()
        || fs.existsSync(environment.SYNTHETIC_DATA_ROOT)) {
      fail('SIDE_EFFECT_DETECTED');
    }
    const evidenceFile = assertEvidenceDirectory(output, realVerificationRoot);
    const raw = fs.readFileSync(evidenceFile, 'utf8');
    const evidence = JSON.parse(raw);
    assertEvidence(evidence, raw, expectedBefore, environment, boundaries);
  } catch (error) {
    verificationFailure = error;
  }

  try {
    safelyRemoveVerificationRoot(boundaries);
  } catch (error) {
    verificationFailure = error;
  }

  const expectedAfter = captureExpectedProvenance();
  const statusAfter = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null
  });
  if (!statusBefore.equals(statusAfter) || fs.existsSync(indexLock)
      || canonicalJson(expectedBefore) !== canonicalJson(expectedAfter)) {
    fail('REPOSITORY_STATE_CHANGED');
  }
  if (verificationFailure) throw verificationFailure;
  return expectedBefore.sourceCommit;
}

function safeErrorCode(error) {
  return error instanceof VerificationError && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
    ? error.code
    : 'VERIFICATION_FAILED';
}

if (require.main === module) {
  try {
    verifyCommittedPreflight();
    process.stdout.write('Synthetic API committed preflight verification passed.\n');
  } catch (error) {
    process.stderr.write(
      `Synthetic API committed preflight verification failed (${safeErrorCode(error)}).\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  assertEvidenceForTest: assertEvidence,
  lockedCommittedProvenance,
  verifyCommittedPreflight
};
