const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const deployment = require('../server/config/deployment-profile');

const projectRoot = path.resolve(__dirname, '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const OFFLINE_GUARD_MARKER = Symbol.for(
  'tangguan.syntheticPreflightOfflineGuardInstalled.v1'
);
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
  'scripts/report-synthetic-external-saga-blockers.js',
  'scripts/support/synthetic-authority-coordination-intent.js',
  'scripts/support/synthetic-authorization-consumer.js',
  'scripts/support/synthetic-bootstrap.js',
  'scripts/support/synthetic-candidate-evidence.js',
  'scripts/support/synthetic-data-root-tools.js',
  'scripts/support/synthetic-external-approval.js',
  'scripts/support/synthetic-external-saga-readiness.js',
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

function assertExactMigrationDirectory(entries = fs.readdirSync(
  path.join(projectRoot, 'server', 'db', 'migrations'),
  { withFileTypes: true }
)) {
  const sqlEntries = entries.filter(entry => entry.name.endsWith('.sql'));
  const actual = sqlEntries.map(entry => `server/db/migrations/${entry.name}`).sort();
  if (sqlEntries.some(entry => !entry.isFile() || entry.isSymbolicLink())
      || actual.length !== migrationImplementationFiles.length
      || actual.some((filename, index) => filename !== migrationImplementationFiles[index])) {
    const error = new Error('migration directory does not match committed preflight manifest');
    error.code = 'MIGRATION_SET_INVALID';
    throw error;
  }
  return true;
}

function runtimeRoots() {
  const projectRealRoot = realpathSync(projectRoot);
  const temporaryRootValue = os.tmpdir();
  if (!path.isAbsolute(temporaryRootValue)
      || (process.platform === 'win32'
        && temporaryRootValue.replaceAll('/', '\\').startsWith('\\\\'))) {
    throw new Error('system temporary directory must be a local absolute path');
  }
  const temporaryRoot = path.resolve(temporaryRootValue);
  const temporaryRootMetadata = fs.lstatSync(temporaryRoot);
  if (!temporaryRootMetadata.isDirectory() || temporaryRootMetadata.isSymbolicLink()) {
    throw new Error('system temporary directory must be a real local directory');
  }
  return Object.freeze({
    projectRealRoot,
    temporaryRoot,
    temporaryRealRoot: realpathSync(temporaryRoot)
  });
}

function readOnlyGitPrefix() {
  const { projectRealRoot } = runtimeRoots();
  return [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', `safe.directory=${projectRealRoot}`
  ];
}

function parseArguments(argv) {
  const result = { output: '', help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      if (seen.has(argument)) throw new Error('duplicate argument');
      seen.add(argument);
      result.help = true;
      continue;
    }
    if (argument !== '--output' || seen.has(argument)) throw new Error('unknown argument');
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing output value');
    result.output = value;
    index += 1;
  }
  return result;
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function resolveOutput(value) {
  const { projectRealRoot, temporaryRoot, temporaryRealRoot } = runtimeRoots();
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new Error('output must be an absolute path');
  }
  if (process.platform === 'win32' && value.replaceAll('/', '\\').startsWith('\\\\')) {
    throw new Error('output must stay inside the local temporary directory');
  }
  const output = path.resolve(value);
  const basename = path.basename(output);
  if (!basename || /[\u0000-\u001f\u007f:]/.test(basename) || /[. ]$/.test(basename)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(basename)) {
    throw new Error('output path must use a canonical local directory name');
  }
  if (isWithin(projectRealRoot, output)) {
    throw new Error('output must stay outside the canonical repository');
  }
  const parent = path.dirname(output);
  if (!isWithin(temporaryRoot, parent)) {
    throw new Error('output must stay inside the local temporary directory');
  }
  const parentRelative = path.relative(temporaryRoot, parent);
  let current = temporaryRoot;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = fs.lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('output parent must be a real local temporary directory');
    }
  }
  if (fs.existsSync(output)) throw new Error('output path must not already exist');
  const realParent = realpathSync(parent);
  if (!isWithin(temporaryRealRoot, realParent)
      || isWithin(projectRealRoot, path.join(realParent, basename))) {
    throw new Error('output parent must remain outside the canonical repository');
  }
  return output;
}

function readOnlyGitEnvironment() {
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
  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : os.devNull;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_PROTOCOL_FROM_USER = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function gitArguments(arguments_) {
  return [...readOnlyGitPrefix(), ...arguments_];
}

function git(arguments_, options = {}) {
  return execFileSync('git', gitArguments(arguments_), {
    cwd: projectRoot,
    windowsHide: true,
    env: readOnlyGitEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

function parseIndexEntries(output) {
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) {
      throw new Error('preflight implementation index entry is invalid');
    }
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function parseHeadEntries(output) {
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) {
      throw new Error('preflight implementation HEAD entry is invalid');
    }
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function entrySignature(entries) {
  return entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.filename}`).join('\0');
}

function readBatchBlobs(entries) {
  const output = git(['cat-file', '--batch'], {
    encoding: null,
    input: `${entries.map(entry => entry.oid).join('\n')}\n`
  });
  const inputs = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = entry.filename;
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('preflight implementation blob response is incomplete');
    const match = /^((?:[0-9a-f]{40}|[0-9a-f]{64})) blob (0|[1-9][0-9]*)$/.exec(
      output.subarray(offset, headerEnd).toString('utf8')
    );
    if (!match || /^0+$/.test(match[1]) || match[1] !== entry.oid) {
      throw new Error('preflight implementation must resolve to the captured blob');
    }
    const length = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0
        || length > output.length - start - 1
        || output[end] !== 0x0a) {
      throw new Error('preflight implementation blob response is malformed');
    }
    inputs.push({ filename, content: output.subarray(start, end) });
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error('preflight implementation blob response has trailing data');
  return inputs;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function framedDigest(inputs) {
  const digest = crypto.createHash('sha256');
  for (const input of inputs) {
    digest.update(Buffer.from(`${input.filename}\0${input.content.length}\0`, 'utf8'));
    digest.update(input.content);
  }
  return digest.digest('hex');
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

function runningContentMatchesCommitted(running, committed) {
  if (!Buffer.isBuffer(running) || !Buffer.isBuffer(committed)) return false;
  if (running.equals(committed)) return true;
  const normalizedRunning = canonicalLineEndings(running);
  const normalizedCommitted = canonicalLineEndings(committed);
  return normalizedRunning !== null && normalizedCommitted !== null
    && normalizedRunning.equals(normalizedCommitted);
}

function capturedCommit() {
  const output = git(['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  const match = /^((?:[0-9a-f]{40}|[0-9a-f]{64}))\n$/.exec(output);
  const commit = match && match[1];
  if (!commit || /^0+$/.test(commit)) {
    throw new Error('preflight implementation commit is invalid');
  }
  return commit;
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
    throw new Error('preflight implementation index must match committed HEAD');
  }
  return Object.freeze({
    indexSignature: entrySignature(index),
    headSignature: entrySignature(head),
    head
  });
}

function assertRunningImplementation(inputs) {
  for (const input of inputs) {
    const running = fs.readFileSync(path.join(projectRoot, ...input.filename.split('/')));
    if (!runningContentMatchesCommitted(running, input.content)) {
      throw new Error('running preflight implementation must match committed HEAD');
    }
  }
}

function guardedCommittedProvenance() {
  assertExactMigrationDirectory();
  const { projectRealRoot } = runtimeRoots();
  const rootOutput = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const rootMatch = /^([^\r\n]+)\n$/.exec(rootOutput);
  const root = rootMatch && rootMatch[1];
  if (!root || path.relative(projectRealRoot, realpathSync(root)) !== '') {
    throw new Error('preflight must use the canonical repository');
  }
  const sourceCommit = capturedCommit();
  const snapshot = implementationSnapshot(sourceCommit);
  const inputs = readBatchBlobs(snapshot.head);
  assertRunningImplementation(inputs);

  const finalCommit = capturedCommit();
  const finalSnapshot = implementationSnapshot(finalCommit);
  if (sourceCommit !== finalCommit
      || snapshot.indexSignature !== finalSnapshot.indexSignature
      || snapshot.headSignature !== finalSnapshot.headSignature) {
    throw new Error('preflight implementation changed during provenance capture');
  }
  assertRunningImplementation(inputs);
  assertExactMigrationDirectory();
  return Object.freeze({
    sourceCommit,
    implementationIndexMatchesHead: true,
    implementationWorktreeMatchesHeadAfterEolNormalization: true,
    implementationTreeSha256: framedDigest(inputs),
    implementationFiles: inputs.map(input => Object.freeze({
      path: input.filename,
      sha256: sha256(input.content)
    }))
  });
}

function committedProvenance() {
  if (globalThis[OFFLINE_GUARD_MARKER] === true) {
    return guardedCommittedProvenance();
  }
  return require('./verify-synthetic-api-preflight').lockedCommittedProvenance();
}

function evidenceFor(environment, provenance) {
  const validated = deployment.validateSyntheticDeployment(environment, { projectRoot });
  const configuration = {
    deploymentTierSynthetic: true,
    nodeEnvironmentProduction: true,
    apiOriginSha256: sha256(Buffer.from(validated.apiOrigin, 'utf8')),
    legalOriginMatchesApi: validated.legalSource.legalOrigin === validated.apiOrigin,
    wechatAppIdSha256: sha256(Buffer.from(validated.wechatAppId, 'utf8')),
    wechatAppIdStringDiffersFromProduction:
      validated.wechatAppId !== deployment.PRODUCTION_WECHAT_APP_ID,
    wechatSecretPresent: validated.wechatSecretPresent,
    sensitiveConfigurationBindingSha256:
      validated.sensitiveConfigurationBindingSha256,
    operatorAcknowledgementsPresent: true,
    coreFeatureGatesEnabled: validated.coreFeatureGatesEnabled,
    closedFeatureGatesDisabled: validated.closedFeatureGatesDisabled,
    proxyPolicyShapeValid: true,
    syntheticDataPathShapeValid: true
  };
  return {
    schemaVersion: 4,
    profile: 'synthetic-api-offline-preflight',
    result: 'configuration-shape-validated',
    sourceCommit: provenance.sourceCommit,
    implementationIndexMatchesHead: provenance.implementationIndexMatchesHead,
    implementationWorktreeMatchesHeadAfterEolNormalization:
      provenance.implementationWorktreeMatchesHeadAfterEolNormalization,
    implementationTreeSha256: provenance.implementationTreeSha256,
    implementationFiles: provenance.implementationFiles,
    configuration,
    configurationSha256: sha256(Buffer.from(JSON.stringify(configuration), 'utf8')),
    externalVerification: {
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
    },
    productionChildGate: {
      deployedStateVerified: false,
      changeAttempted: false
    }
  };
}

function verifyTemporaryDirectory(directory) {
  const { projectRealRoot, temporaryRealRoot } = runtimeRoots();
  const metadata = fs.lstatSync(directory);
  const real = realpathSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || isWithin(projectRealRoot, real) || !isWithin(temporaryRealRoot, real)) {
    throw new Error('preflight staging directory is unsafe');
  }
  return real;
}

function safeCleanup(staging) {
  if (!staging || !fs.existsSync(staging)) return;
  const real = verifyTemporaryDirectory(staging);
  if (!path.basename(real).startsWith('.tangguan-api-preflight-stage-')) {
    throw new Error('refusing to clean an unexpected directory');
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function prepareEvidence(options, environment = process.env, provenanceProvider = committedProvenance) {
  const destination = resolveOutput(options && options.output);
  const provenance = provenanceProvider();
  const evidence = evidenceFor(environment, provenance);
  const evidenceInput = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  let staging = '';
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(destination), '.tangguan-api-preflight-stage-'));
    verifyTemporaryDirectory(staging);
    const evidenceFile = path.join(staging, '.synthetic-api-preflight.json');
    fs.writeFileSync(evidenceFile, evidenceInput, { flag: 'wx' });
    const entries = fs.readdirSync(staging, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== '.synthetic-api-preflight.json'
        || !entries[0].isFile() || entries[0].isSymbolicLink()
        || !fs.readFileSync(evidenceFile).equals(evidenceInput)) {
      throw new Error('preflight evidence verification failed');
    }
    if (JSON.stringify(provenanceProvider()) !== JSON.stringify(provenance)) {
      throw new Error('preflight implementation changed before evidence publication');
    }
    if (fs.existsSync(destination)) throw new Error('output path must not already exist');
    // Atomic publish is the final fallible operation. No post-publish path
    // inspection or cleanup is allowed after this rename succeeds.
    fs.renameSync(staging, destination);
    staging = '';
    return destination;
  } catch (error) {
    safeCleanup(staging);
    throw error;
  }
}

function safeErrorCode(error) {
  return error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code || '')
    ? error.code
    : 'SYNTHETIC_CONFIG_INVALID';
}

function usage() {
  return [
    'Usage:',
    '  node scripts/preflight-synthetic-api.js',
    '    --output <new-directory-under-system-temp>',
    '',
    'Configuration is read only from explicitly injected environment variables.',
    'The command does not open a database, start a server, access the network or deploy.'
  ].join('\n');
}

function runCli(argv = process.argv.slice(2), environment = process.env) {
  try {
    const options = parseArguments(argv);
    if (options.help) process.stdout.write(`${usage()}\n`);
    else {
      prepareEvidence(options, environment);
      process.stdout.write('Synthetic API offline configuration shape preflight passed.\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Synthetic API offline preflight failed (${safeErrorCode(error)}).\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = runCli();

module.exports = {
  assertExactMigrationDirectory,
  committedProvenance,
  evidenceFor,
  parseArguments,
  prepareEvidence,
  resolveOutput,
  runningContentMatchesCommitted,
  runCli,
  safeErrorCode
};
