const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const deploymentProfile = require('../../server/config/deployment-profile');
const runtimeFilesystem = require('../../server/config/synthetic-runtime-filesystem');

const projectRoot = path.resolve(__dirname, '..', '..');
const PREPARE_ACK = 'prepare-new-empty-synthetic-root-v1';
const APPROVED_PARENT_ENV = 'SYNTHETIC_DATA_ROOT_APPROVED_PARENT';
const PREPARE_ACK_ENV = 'SYNTHETIC_DATA_ROOT_PREPARE_ACK';
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const STABLE_ERROR_CODES = new Set([
  'ARGUMENT_INVALID',
  'APPROVED_PARENT_UNSAFE',
  'DATA_CREATE_FAILED',
  'MARKER_COMMIT_FAILED',
  'PREPARATION_FAILED',
  'PREPARE_ACK_REQUIRED',
  'ROOT_ALREADY_EXISTS',
  'ROOT_BOUNDARY_CHANGED',
  'ROOT_BOUNDARY_UNSAFE',
  'ROOT_CHANGED_DURING_VERIFICATION',
  'ROOT_CREATE_FAILED',
  'SYNTHETIC_ACK_REQUIRED',
  'SYNTHETIC_CONFIG_INVALID',
  'SYNTHETIC_DATA_ROOT_FAILED',
  'SYNTHETIC_DATA_ROOT_UNSAFE',
  'SYNTHETIC_FEATURE_GATES_INVALID',
  'SYNTHETIC_LEGAL_SOURCE_INVALID',
  'SYNTHETIC_MODE_REQUIRED',
  'SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN',
  'SYNTHETIC_PROXY_POLICY_INVALID',
  'VERIFICATION_FAILED'
]);

class SyntheticDataRootError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticDataRootError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticDataRootError(code);
}

function safeErrorCode(error, fallback = 'SYNTHETIC_DATA_ROOT_FAILED') {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return STABLE_ERROR_CODES.has(code) ? code : fallback;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('ARGUMENT_INVALID');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function statValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function lstat(filename, code) {
  try {
    return fs.lstatSync(filename, { bigint: true });
  } catch (_) {
    fail(code);
  }
}

function realpath(filename, code) {
  try {
    return realpathSync(filename);
  } catch (_) {
    fail(code);
  }
}

function identityFor(filename, kind, code) {
  const metadata = lstat(filename, code);
  if ((kind === 'directory' && !metadata.isDirectory())
      || (kind === 'file' && !metadata.isFile())
      || metadata.isSymbolicLink()) {
    fail(code);
  }
  const physical = realpath(filename, code);
  if (!samePath(physical, filename)) fail(code);
  return Object.freeze({
    physical,
    dev: statValue(metadata.dev),
    ino: statValue(metadata.ino)
  });
}

function metadataFor(filename, kind, code) {
  const identity = identityFor(filename, kind, code);
  const metadata = lstat(filename, code);
  return Object.freeze({
    ...identity,
    mode: statValue(metadata.mode),
    nlink: statValue(metadata.nlink),
    size: statValue(metadata.size),
    mtimeNs: statValue(metadata.mtimeNs),
    ctimeNs: statValue(metadata.ctimeNs)
  });
}

function sameIdentity(left, right) {
  return left && right && samePath(left.physical, right.physical)
    && left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateMode(filename, kind, code) {
  if (process.platform === 'win32') return;
  const metadata = lstat(filename, code);
  const expected = kind === 'file' ? 0o600 : 0o700;
  if (Number(metadata.mode & 0o777n) !== expected) fail(code);
  if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) fail(code);
  if (kind === 'file' && metadata.nlink !== 1n) fail(code);
}

function assertOpenMarkerDescriptor(descriptor) {
  let metadata;
  try {
    metadata = fs.fstatSync(descriptor, { bigint: true });
  } catch (_) {
    fail('MARKER_COMMIT_FAILED');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    fail('MARKER_COMMIT_FAILED');
  }
  if (process.platform !== 'win32') {
    if (Number(metadata.mode & 0o777n) !== 0o600) fail('MARKER_COMMIT_FAILED');
    if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) {
      fail('MARKER_COMMIT_FAILED');
    }
  }
  return metadata;
}

function assertAbsent(filename) {
  try {
    fs.lstatSync(filename);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    fail('ROOT_BOUNDARY_UNSAFE');
  }
  fail('ROOT_ALREADY_EXISTS');
}

function listDirectory(directory, code) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .map(entry => ({
        name: entry.name,
        directory: entry.isDirectory(),
        file: entry.isFile(),
        link: entry.isSymbolicLink()
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (_) {
    fail(code);
  }
}

function contextFor(environment, { requirePrepareAck = false, rootProject = projectRoot } = {}) {
  if (!environment || typeof environment !== 'object') fail('SYNTHETIC_CONFIG_INVALID');
  if (requirePrepareAck && environment[PREPARE_ACK_ENV] !== PREPARE_ACK) {
    fail('PREPARE_ACK_REQUIRED');
  }
  let validated;
  try {
    validated = deploymentProfile.validateSyntheticDeployment(environment, {
      projectRoot: rootProject
    });
  } catch (error) {
    const code = safeErrorCode(error, 'SYNTHETIC_CONFIG_INVALID');
    fail(code);
  }
  const suppliedParent = environment[APPROVED_PARENT_ENV];
  const approvedParent = deploymentProfile.canonicalAbsolutePath(suppliedParent);
  if (!approvedParent || suppliedParent !== approvedParent
      || samePath(approvedParent, path.parse(approvedParent).root)
      || !samePath(approvedParent, path.dirname(validated.dataPaths.root))) {
    fail('APPROVED_PARENT_UNSAFE');
  }
  const parentIdentity = identityFor(approvedParent, 'directory', 'APPROVED_PARENT_UNSAFE');
  const marker = runtimeFilesystem.markerBufferFor(validated);
  const fingerprint = sha256(Buffer.from(JSON.stringify({
    approvedParent,
    parentIdentity,
    deploymentTier: validated.deploymentTier,
    apiOrigin: validated.apiOrigin,
    wechatAppId: validated.wechatAppId,
    wechatSecretSha256: sha256(Buffer.from(String(environment.WX_APPSECRET || ''), 'utf8')),
    datasetId: validated.datasetId,
    dataPaths: validated.dataPaths,
    proxyPolicy: validated.proxyPolicy,
    legalSource: validated.legalSource,
    markerSha256: sha256(marker)
  }), 'utf8'));
  return Object.freeze({
    validated,
    approvedParent,
    parentIdentity,
    marker,
    fingerprint,
    projectRoot: rootProject
  });
}

function assertContextStable(initial, environment, options) {
  const current = contextFor(environment, options);
  if (current.fingerprint !== initial.fingerprint
      || !sameIdentity(current.parentIdentity, initial.parentIdentity)) {
    fail('ROOT_BOUNDARY_CHANGED');
  }
  return current;
}

function assertExactEntries(directory, expected, code) {
  const entries = listDirectory(directory, code);
  if (entries.length !== expected.length) fail(code);
  for (let index = 0; index < entries.length; index += 1) {
    const wanted = expected[index];
    const actual = entries[index];
    if (actual.name !== wanted.name || actual.directory !== !!wanted.directory
        || actual.file !== !!wanted.file || actual.link) {
      fail(code);
    }
  }
  return entries;
}

function captureFilesystem(context) {
  const { root, dataDir } = context.validated.dataPaths;
  const markerFile = path.join(root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME);
  const runtimeResult = (() => {
    try {
      return runtimeFilesystem.validateSyntheticRuntimeFilesystem(
        context.validated,
        context.projectRoot
      );
    } catch (_) {
      fail('ROOT_BOUNDARY_UNSAFE');
    }
  })();
  const parent = metadataFor(context.approvedParent, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  const rootMetadata = metadataFor(root, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  const dataMetadata = metadataFor(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  const markerMetadata = metadataFor(markerFile, 'file', 'ROOT_BOUNDARY_UNSAFE');
  if (!sameIdentity(parent, context.parentIdentity)) fail('ROOT_BOUNDARY_CHANGED');
  if (markerMetadata.nlink !== '1') fail('ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(root, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(markerFile, 'file', 'ROOT_BOUNDARY_UNSAFE');

  let markerBytes;
  try {
    markerBytes = fs.readFileSync(markerFile);
  } catch (_) {
    fail('ROOT_BOUNDARY_UNSAFE');
  }
  if (!markerBytes.equals(context.marker)) fail('ROOT_BOUNDARY_UNSAFE');

  const rootEntries = listDirectory(root, 'ROOT_BOUNDARY_UNSAFE');
  const dataEntries = listDirectory(dataDir, 'ROOT_BOUNDARY_UNSAFE');
  const dataFiles = {};
  for (const entry of dataEntries) {
    dataFiles[entry.name] = metadataFor(
      path.join(dataDir, entry.name),
      'file',
      'ROOT_BOUNDARY_UNSAFE'
    );
  }
  return Object.freeze({
    comparison: Object.freeze({
      contextFingerprint: context.fingerprint,
      parent,
      root: rootMetadata,
      data: dataMetadata,
      marker: markerMetadata,
      rootEntries,
      dataEntries,
      dataFiles,
      markerSha256: runtimeResult.markerSha256
    }),
    summary: Object.freeze({
      markerSha256: runtimeResult.markerSha256,
      rootEntryCount: rootEntries.length,
      dataEntryCount: dataEntries.length,
      sqlitePresent: Object.hasOwn(dataFiles, 'hefei-points-synthetic.sqlite'),
      sqliteWalPresent: Object.hasOwn(dataFiles, 'hefei-points-synthetic.sqlite-wal'),
      sqliteShmPresent: Object.hasOwn(dataFiles, 'hefei-points-synthetic.sqlite-shm'),
      tokenSecretPresent: Object.hasOwn(dataFiles, '.secret')
    })
  });
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

function evidenceFor(summary) {
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-data-root-readiness',
    result: 'verified',
    configuration: Object.freeze({
      deploymentTierSynthetic: true,
      nodeEnvironmentProduction: true,
      approvedParentCanonical: true,
      finalRootDirectChild: true,
      markerMatchesConfiguration: true
    }),
    filesystem: summary,
    externalVerification: Object.freeze({
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
    }),
    operations: Object.freeze({
      deploymentPerformed: false,
      databaseOpened: false,
      networkAccessPerformed: false,
      serverStarted: false,
      subprocessStarted: false,
      devToolsInvoked: false,
      previewOrUploadPerformed: false,
      adultDeviceSmokeVerified: false,
      huksAssetStoreRuntimeVerified: false
    }),
    productionChildGate: Object.freeze({
      deployedStateVerified: false,
      changeAttempted: false
    })
  });
}

function invokePhase(options, phase) {
  if (options && typeof options.onPhase === 'function') options.onPhase(phase);
}

function verifySyntheticDataRoot(environment, options = {}) {
  const contextOptions = { rootProject: options.projectRoot || projectRoot };
  const firstContext = contextFor(environment, contextOptions);
  const first = captureFilesystem(firstContext);
  invokePhase(options, 'afterFirstValidation');
  let second;
  try {
    const secondContext = contextFor(environment, contextOptions);
    second = captureFilesystem(secondContext);
  } catch (_) {
    fail('ROOT_CHANGED_DURING_VERIFICATION');
  }
  if (canonicalJson(first.comparison) !== canonicalJson(second.comparison)) {
    fail('ROOT_CHANGED_DURING_VERIFICATION');
  }
  return evidenceFor(second.summary);
}

function createDirectoryExclusive(directory, code, existsCode = code) {
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') fail(existsCode);
    fail(code);
  }
}

function writeMarkerExclusive(filename, content) {
  let descriptor;
  let failure = null;
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600);
    assertOpenMarkerDescriptor(descriptor);
    let offset = 0;
    while (offset < content.length) {
      const written = fs.writeSync(descriptor, content, offset, content.length - offset, offset);
      if (!Number.isInteger(written) || written <= 0) fail('MARKER_COMMIT_FAILED');
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const committed = assertOpenMarkerDescriptor(descriptor);
    if (committed.size !== BigInt(content.length)) fail('MARKER_COMMIT_FAILED');
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = failure || error;
    }
  }
  if (failure) fail('MARKER_COMMIT_FAILED');
}

function prepareSyntheticDataRoot(environment, options = {}) {
  const contextOptions = {
    requirePrepareAck: true,
    rootProject: options.projectRoot || projectRoot
  };
  const initial = contextFor(environment, contextOptions);
  const { root, dataDir } = initial.validated.dataPaths;
  const markerFile = path.join(root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME);

  assertAbsent(root);
  invokePhase(options, 'beforeRootCreate');
  assertContextStable(initial, environment, contextOptions);
  assertAbsent(root);
  createDirectoryExclusive(root, 'ROOT_CREATE_FAILED', 'ROOT_ALREADY_EXISTS');
  const rootIdentity = identityFor(root, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(root, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertExactEntries(root, [], 'ROOT_BOUNDARY_UNSAFE');

  invokePhase(options, 'afterRootCreate');
  assertContextStable(initial, environment, contextOptions);
  if (!sameIdentity(identityFor(root, 'directory', 'ROOT_BOUNDARY_UNSAFE'), rootIdentity)) {
    fail('ROOT_BOUNDARY_CHANGED');
  }
  assertExactEntries(root, [], 'ROOT_BOUNDARY_UNSAFE');

  invokePhase(options, 'beforeDataCreate');
  assertContextStable(initial, environment, contextOptions);
  assertExactEntries(root, [], 'ROOT_BOUNDARY_UNSAFE');
  createDirectoryExclusive(dataDir, 'DATA_CREATE_FAILED');
  const dataIdentity = identityFor(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE');
  assertExactEntries(root, [{ name: 'data', directory: true }], 'ROOT_BOUNDARY_UNSAFE');
  assertExactEntries(dataDir, [], 'ROOT_BOUNDARY_UNSAFE');

  invokePhase(options, 'afterDataCreate');
  assertContextStable(initial, environment, contextOptions);
  if (!sameIdentity(identityFor(root, 'directory', 'ROOT_BOUNDARY_UNSAFE'), rootIdentity)
      || !sameIdentity(identityFor(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE'), dataIdentity)) {
    fail('ROOT_BOUNDARY_CHANGED');
  }
  assertExactEntries(root, [{ name: 'data', directory: true }], 'ROOT_BOUNDARY_UNSAFE');
  assertExactEntries(dataDir, [], 'ROOT_BOUNDARY_UNSAFE');

  invokePhase(options, 'beforeMarkerCreate');
  assertContextStable(initial, environment, contextOptions);
  assertExactEntries(root, [{ name: 'data', directory: true }], 'ROOT_BOUNDARY_UNSAFE');
  assertExactEntries(dataDir, [], 'ROOT_BOUNDARY_UNSAFE');
  writeMarkerExclusive(markerFile, initial.marker);
  invokePhase(options, 'afterMarkerFsync');

  const markerIdentity = identityFor(markerFile, 'file', 'ROOT_BOUNDARY_UNSAFE');
  assertPrivateMode(markerFile, 'file', 'ROOT_BOUNDARY_UNSAFE');
  let readback;
  try {
    readback = fs.readFileSync(markerFile);
  } catch (_) {
    fail('MARKER_COMMIT_FAILED');
  }
  if (!readback.equals(initial.marker)) fail('MARKER_COMMIT_FAILED');
  invokePhase(options, 'afterMarkerReadback');

  const stable = assertContextStable(initial, environment, contextOptions);
  if (!sameIdentity(identityFor(root, 'directory', 'ROOT_BOUNDARY_UNSAFE'), rootIdentity)
      || !sameIdentity(identityFor(dataDir, 'directory', 'ROOT_BOUNDARY_UNSAFE'), dataIdentity)
      || !sameIdentity(identityFor(markerFile, 'file', 'ROOT_BOUNDARY_UNSAFE'), markerIdentity)) {
    fail('ROOT_BOUNDARY_CHANGED');
  }
  const first = captureFilesystem(stable);
  const second = captureFilesystem(assertContextStable(initial, environment, contextOptions));
  if (canonicalJson(first.comparison) !== canonicalJson(second.comparison)) {
    fail('ROOT_CHANGED_DURING_VERIFICATION');
  }
  return evidenceFor(second.summary);
}

module.exports = {
  APPROVED_PARENT_ENV,
  PREPARE_ACK,
  PREPARE_ACK_ENV,
  SyntheticDataRootError,
  evidenceFor,
  parseArguments,
  prepareSyntheticDataRoot,
  safeErrorCode,
  verifySyntheticDataRoot
};
