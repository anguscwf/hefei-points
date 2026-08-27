const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { TextDecoder } = require('node:util');

const externalApproval = require('./synthetic-external-approval');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const MAX_STDIN_BYTES = 768 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const LEDGER_FILENAME = 'synthetic-authorization-ledger.sqlite';
const LEDGER_APPLICATION_ID = 1413958705;
const LEDGER_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 15000;
const INIT_ACK_ENV = 'SYNTHETIC_AUTHORIZATION_LEDGER_INIT_ACK';
const INIT_ACK = 'initialize-local-ledger-not-authority-v1';
const CONSUME_ACK_ENV = 'SYNTHETIC_AUTHORIZATION_CONSUME_ACK';
const CONSUME_ACK = 'record-local-single-use-not-deployment-v1';
const LEDGER_FILE_ENV = 'SYNTHETIC_AUTHORIZATION_LEDGER_FILE';
const LEDGER_PARENT_ENV = 'SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT';
const LEDGER_ID_ENV = 'SYNTHETIC_AUTHORIZATION_LEDGER_ID_SHA256';
const CONSUMER_ID_ENV = 'SYNTHETIC_AUTHORIZATION_CONSUMER_ID_SHA256';
const TARGET_ENVIRONMENT_ENV = 'SYNTHETIC_AUTHORIZATION_TARGET_ENVIRONMENT_SHA256';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const INIT_REQUEST_ID = /^synthetic-ledger-init-[a-z0-9][a-z0-9_-]{15,80}$/;
const CONSUME_REQUEST_ID = /^synthetic-grant-consume-[a-z0-9][a-z0-9_-]{15,80}$/;

const STABLE_ERROR_CODES = new Set([
  'SYNTHETIC_AUTHORIZATION_LEDGER_ARGUMENT_INVALID',
  'SYNTHETIC_AUTHORIZATION_LEDGER_ACK_REQUIRED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_STDIN_REQUIRED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_TOO_LARGE',
  'SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID',
  'SYNTHETIC_AUTHORIZATION_LEDGER_SENSITIVE_INPUT',
  'SYNTHETIC_AUTHORIZATION_LEDGER_PRODUCTION_RESOURCE_REJECTED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE',
  'SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE',
  'SYNTHETIC_AUTHORIZATION_LEDGER_REQUIRED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_ALREADY_INITIALIZED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH',
  'SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID',
  'SYNTHETIC_AUTHORIZATION_LEDGER_BUSY',
  'SYNTHETIC_AUTHORIZATION_LEDGER_BLOCKED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_MISMATCH',
  'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_ROLLBACK',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_GAP',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_REVOCATION_REMOVED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMER_MISMATCH',
  'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_MISMATCH',
  'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_APPROVAL_ALREADY_CONSUMED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_ALREADY_CONSUMED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT',
  'SYNTHETIC_AUTHORIZATION_LEDGER_LOCAL_CLOCK_ROLLBACK',
  'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_TRANSACTION_FAILED',
  'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN',
  'SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED'
]);

const LEDGER_SCHEMA_SQL = `
CREATE TABLE ledger_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  purpose TEXT NOT NULL CHECK (purpose = 'synthetic_local_authorization_ledger'),
  ledger_id_sha256 TEXT NOT NULL UNIQUE CHECK (length(ledger_id_sha256) = 64 AND ledger_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  consumer_id_sha256 TEXT NOT NULL CHECK (length(consumer_id_sha256) = 64 AND consumer_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_environment_sha256 TEXT NOT NULL CHECK (length(target_environment_sha256) = 64 AND target_environment_sha256 NOT GLOB '*[^0-9a-f]*'),
  context_sha256 TEXT NOT NULL CHECK (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
  test_only_initialized INTEGER NOT NULL CHECK (test_only_initialized IN (0, 1)),
  init_request_id_sha256 TEXT NOT NULL UNIQUE CHECK (length(init_request_id_sha256) = 64 AND init_request_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  init_request_fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (length(init_request_fingerprint_sha256) = 64 AND init_request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  active_policy_id_sha256 TEXT NOT NULL CHECK (length(active_policy_id_sha256) = 64 AND active_policy_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  active_policy_sha256 TEXT NOT NULL UNIQUE CHECK (length(active_policy_sha256) = 64 AND active_policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  active_policy_revision INTEGER NOT NULL CHECK (active_policy_revision >= 1),
  genesis_checkpoint_sequence INTEGER NOT NULL CHECK (genesis_checkpoint_sequence >= 1),
  genesis_checkpoint_sha256 TEXT NOT NULL UNIQUE CHECK (length(genesis_checkpoint_sha256) = 64 AND genesis_checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at_observed TEXT NOT NULL
);

CREATE TABLE revocation_checkpoints (
  policy_id_sha256 TEXT NOT NULL CHECK (length(policy_id_sha256) = 64 AND policy_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  authority_principal_id_sha256 TEXT NOT NULL CHECK (length(authority_principal_id_sha256) = 64 AND authority_principal_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  checkpoint_sha256 TEXT NOT NULL UNIQUE CHECK (length(checkpoint_sha256) = 64 AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  revoked_key_ids_json TEXT NOT NULL,
  revoked_principal_ids_json TEXT NOT NULL,
  revoked_approval_ids_json TEXT NOT NULL,
  revoked_grant_ids_json TEXT NOT NULL,
  checkpoint_envelope_json TEXT NOT NULL,
  checkpoint_record_sha256 TEXT NOT NULL UNIQUE CHECK (length(checkpoint_record_sha256) = 64 AND checkpoint_record_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at_observed TEXT NOT NULL,
  PRIMARY KEY (policy_sha256, sequence)
);

CREATE TABLE grant_consumptions (
  grant_id_sha256 TEXT PRIMARY KEY CHECK (length(grant_id_sha256) = 64 AND grant_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  grant_envelope_sha256 TEXT NOT NULL UNIQUE CHECK (length(grant_envelope_sha256) = 64 AND grant_envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  approval_envelope_sha256 TEXT NOT NULL UNIQUE CHECK (length(approval_envelope_sha256) = 64 AND approval_envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_id_sha256 TEXT NOT NULL UNIQUE CHECK (length(request_id_sha256) = 64 AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64 AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_id_sha256 TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  checkpoint_sequence INTEGER NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  consumer_id_sha256 TEXT NOT NULL,
  target_environment_sha256 TEXT NOT NULL,
  subject_sha256 TEXT NOT NULL,
  candidate_binding_sha256 TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  implementation_tree_sha256 TEXT NOT NULL,
  configuration_sha256 TEXT NOT NULL,
  consumed_at_observed TEXT NOT NULL,
  verification_valid_until TEXT NOT NULL,
  test_only_overrides_used INTEGER NOT NULL CHECK (test_only_overrides_used IN (0, 1)),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (target_environment_sha256, source_commit, implementation_tree_sha256, configuration_sha256),
  FOREIGN KEY (policy_sha256, checkpoint_sequence)
    REFERENCES revocation_checkpoints(policy_sha256, sequence)
);

CREATE TABLE grant_rejections (
  request_id_sha256 TEXT PRIMARY KEY CHECK (length(request_id_sha256) = 64 AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_fingerprint_sha256 TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  stable_error_code TEXT NOT NULL,
  rejection_record_sha256 TEXT NOT NULL UNIQUE,
  recorded_at_observed TEXT NOT NULL,
  FOREIGN KEY (checkpoint_sha256) REFERENCES revocation_checkpoints(checkpoint_sha256)
);

CREATE TABLE ledger_blocks (
  block_sha256 TEXT PRIMARY KEY CHECK (length(block_sha256) = 64 AND block_sha256 NOT GLOB '*[^0-9a-f]*'),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK',
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_REVOCATION_REMOVED'
  )),
  presented_checkpoint_sequence INTEGER NOT NULL CHECK (presented_checkpoint_sequence >= 1),
  presented_checkpoint_sha256 TEXT NOT NULL CHECK (length(presented_checkpoint_sha256) = 64 AND presented_checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL
);

CREATE TRIGGER trg_ledger_identity_once
BEFORE INSERT ON ledger_identity
WHEN EXISTS (SELECT 1 FROM ledger_identity)
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_ALREADY_INITIALIZED');
END;

CREATE TRIGGER trg_ledger_identity_no_update
BEFORE UPDATE ON ledger_identity
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER trg_ledger_identity_no_delete
BEFORE DELETE ON ledger_identity
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_IDENTITY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_revocation_checkpoint_insert_guard
BEFORE INSERT ON revocation_checkpoints
WHEN
  NEW.policy_id_sha256 <> (SELECT active_policy_id_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.policy_sha256 <> (SELECT active_policy_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.policy_revision <> (SELECT active_policy_revision FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.sequence <> COALESCE(
    (SELECT MAX(sequence) + 1 FROM revocation_checkpoints),
    (SELECT genesis_checkpoint_sequence FROM ledger_identity WHERE singleton_id = 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_SEQUENCE_INVALID');
END;

CREATE TRIGGER trg_revocation_checkpoint_no_update
BEFORE UPDATE ON revocation_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_IMMUTABLE');
END;

CREATE TRIGGER trg_revocation_checkpoint_no_delete
BEFORE DELETE ON revocation_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_grant_consumption_insert_guard
BEFORE INSERT ON grant_consumptions
WHEN
  NEW.policy_id_sha256 <> (SELECT active_policy_id_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.policy_sha256 <> (SELECT active_policy_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.policy_revision <> (SELECT active_policy_revision FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.consumer_id_sha256 <> (SELECT consumer_id_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.target_environment_sha256 <> (SELECT target_environment_sha256 FROM ledger_identity WHERE singleton_id = 1)
  OR NEW.test_only_overrides_used <> (SELECT test_only_initialized FROM ledger_identity WHERE singleton_id = 1)
  OR NOT EXISTS (
    SELECT 1 FROM revocation_checkpoints
    WHERE policy_sha256 = NEW.policy_sha256
      AND sequence = NEW.checkpoint_sequence
      AND checkpoint_sha256 = NEW.checkpoint_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMPTION_BINDING_INVALID');
END;

CREATE TRIGGER trg_grant_consumption_no_update
BEFORE UPDATE ON grant_consumptions
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMPTION_IMMUTABLE');
END;

CREATE TRIGGER trg_grant_consumption_no_delete
BEFORE DELETE ON grant_consumptions
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMPTION_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_grant_rejection_no_update
BEFORE UPDATE ON grant_rejections
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_REJECTION_IMMUTABLE');
END;

CREATE TRIGGER trg_grant_rejection_no_delete
BEFORE DELETE ON grant_rejections
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_REJECTION_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_ledger_block_no_update
BEFORE UPDATE ON ledger_blocks
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_BLOCK_IMMUTABLE');
END;

CREATE TRIGGER trg_ledger_block_no_delete
BEFORE DELETE ON ledger_blocks
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORIZATION_LEDGER_BLOCK_DELETE_FORBIDDEN');
END;
`;

class SyntheticAuthorizationLedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticAuthorizationLedgerError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticAuthorizationLedgerError(code);
}

function safeErrorCode(error) {
  if (error instanceof SyntheticAuthorizationLedgerError
      && STABLE_ERROR_CODES.has(error.code)) return error.code;
  if (error instanceof externalApproval.SyntheticExternalApprovalError) {
    return externalApproval.safeErrorCode(error);
  }
  return 'SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED';
}

function recoveredStableError(code) {
  if (STABLE_ERROR_CODES.has(code)) return new SyntheticAuthorizationLedgerError(code);
  const externalError = new externalApproval.SyntheticExternalApprovalError(code);
  if (externalApproval.safeErrorCode(externalError) === code) return externalError;
  fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
}

function canonicalJson(value) {
  return externalApproval.canonicalJson(value);
}

function canonicalHash(value) {
  return externalApproval.canonicalHash(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value)
    && !/^([0-9a-f])\1{63}$/.test(value);
}

function exactKeys(value, expected, code = 'SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function parseCanonicalTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code);
  return epoch;
}

function sortedUniqueDigests(value, code) {
  if (!Array.isArray(value) || value.some(item => !validDigest(item))) fail(code);
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) fail(code);
  }
  return Object.freeze([...value]);
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('SYNTHETIC_AUTHORIZATION_LEDGER_ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('SYNTHETIC_AUTHORIZATION_LEDGER_ARGUMENT_INVALID');
}

function assertEnvironment(environment, acknowledgementName, acknowledgement) {
  if (!environment || typeof environment !== 'object'
      || environment.NODE_ENV !== 'production'
      || environment.DEPLOYMENT_TIER !== 'synthetic') {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_PRODUCTION_RESOURCE_REJECTED');
  }
  if (environment[acknowledgementName] !== acknowledgement) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ACK_REQUIRED');
  }
  for (const name of [LEDGER_ID_ENV, CONSUMER_ID_ENV, TARGET_ENVIRONMENT_ENV]) {
    if (!validDigest(environment[name])) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
    }
  }
}

function sensitiveValues(environment) {
  return [
    environment.API_PUBLIC_ORIGIN,
    environment.LEGAL_PUBLIC_ORIGIN,
    environment.WX_APPID,
    environment.WX_APPSECRET,
    environment.SYNTHETIC_DATASET_ID,
    environment.SYNTHETIC_DATA_ROOT,
    environment.SYNTHETIC_DATA_ROOT_APPROVED_PARENT,
    environment.DATA_DIR,
    environment.SQLITE_FILE,
    environment.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL,
    environment.GUARDIAN_RELATION_DECLARATION_VERSION,
    environment[externalApproval.POLICY_FILE_ENV],
    environment[externalApproval.POLICY_PARENT_ENV],
    environment[LEDGER_FILE_ENV],
    environment[LEDGER_PARENT_ENV]
  ].filter(value => typeof value === 'string' && value.length >= 6);
}

function decodeCanonicalInput(buffer, environment = process.env) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_STDIN_REQUIRED');
  }
  if (buffer.length > MAX_STDIN_BYTES) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_TOO_LARGE');
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  }
  if (raw.endsWith('\n') && !raw.endsWith('\r\n')) raw = raw.slice(0, -1);
  if (!raw) fail('SYNTHETIC_AUTHORIZATION_LEDGER_STDIN_REQUIRED');
  const sensitive = sensitiveValues(environment)
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  if ([...new Set(sensitive)].some(value => raw.includes(value))) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_SENSITIVE_INPUT');
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  }
  if (JSON.stringify(document) !== raw) fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('SYNTHETIC_AUTHORIZATION_LEDGER_STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += input.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      input.fill(0);
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(input));
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function isNetworkOrDevicePath(value) {
  return typeof value === 'string' && value.replaceAll('/', '\\').startsWith('\\\\');
}

function isCanonicalAbsolutePath(value) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && path.resolve(value) === value;
}

function assertUnlinkedSegments(filename, finalKind, allowMissingFinal = false) {
  const root = path.parse(filename).root;
  const segments = path.relative(root, filename).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const last = index === segments.length - 1;
    let metadata;
    try {
      metadata = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (last && allowMissingFinal && error && error.code === 'ENOENT') return;
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
    }
    if (metadata.isSymbolicLink()
        || (!last && !metadata.isDirectory())
        || (last && finalKind === 'directory' && !metadata.isDirectory())
        || (last && finalKind === 'file' && !metadata.isFile())) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
    }
  }
}

function basicFileIdentity(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: String(metadata.mode),
    nlink: String(metadata.nlink)
  });
}

function sameFileIdentity(left, right) {
  return canonicalJson(basicFileIdentity(left)) === canonicalJson(basicFileIdentity(right));
}

function hostContextSha256() {
  let user;
  try {
    user = os.userInfo();
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
  }
  return canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic-authorization-ledger-host-context',
    platform: process.platform,
    architecture: process.arch,
    hostname: os.hostname(),
    username: user.username,
    uid: user.uid,
    gid: user.gid
  });
}

function ledgerContextSha256(filename, approvedParent, metadata) {
  return canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic-authorization-ledger-file-context',
    filenameSha256: sha256(Buffer.from(filename, 'utf8')),
    approvedParentSha256: sha256(Buffer.from(approvedParent, 'utf8')),
    device: String(metadata.dev),
    inode: String(metadata.ino),
    hostContextSha256: hostContextSha256()
  });
}

function sidecarPaths(filename) {
  return [`${filename}-journal`, `${filename}-wal`, `${filename}-shm`];
}

function assertNoSidecars(filename, code = 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN') {
  if (sidecarPaths(filename).some(candidate => fs.existsSync(candidate))) fail(code);
}

function assertNoWalSidecars(
  filename,
  code = 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
) {
  if ([`${filename}-wal`, `${filename}-shm`].some(candidate => fs.existsSync(candidate))) {
    fail(code);
  }
}

function createPathContext(environment, requireLedger) {
  const filename = environment[LEDGER_FILE_ENV];
  const approvedParent = environment[LEDGER_PARENT_ENV];
  const dataRoot = environment.SYNTHETIC_DATA_ROOT;
  const policyParent = environment[externalApproval.POLICY_PARENT_ENV];
  const policyFile = environment[externalApproval.POLICY_FILE_ENV];
  if (typeof filename !== 'string' || typeof approvedParent !== 'string'
      || typeof dataRoot !== 'string' || typeof policyParent !== 'string'
      || typeof policyFile !== 'string') {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
  }
  const values = [filename, approvedParent, dataRoot, policyParent, policyFile];
  if (values.some(value => !isCanonicalAbsolutePath(value)
      || isNetworkOrDevicePath(value))) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
  }
  const projectVolume = path.parse(PROJECT_ROOT).root;
  if (values.some(value => !samePath(path.parse(value).root, projectVolume))
      || path.basename(filename) !== LEDGER_FILENAME
      || path.dirname(filename) !== approvedParent) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
  }
  assertUnlinkedSegments(approvedParent, 'directory');
  assertUnlinkedSegments(filename, 'file', !requireLedger);
  assertUnlinkedSegments(dataRoot, 'directory');
  assertUnlinkedSegments(policyParent, 'directory');
  assertUnlinkedSegments(policyFile, 'file');
  let parentMetadata;
  let parentReal;
  let dataRootReal;
  let policyParentReal;
  let policyFileReal;
  try {
    parentMetadata = fs.lstatSync(approvedParent, { bigint: true });
    parentReal = realpathSync(approvedParent);
    dataRootReal = realpathSync(dataRoot);
    policyParentReal = realpathSync(policyParent);
    policyFileReal = realpathSync(policyFile);
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
  }
  const projectReal = realpathSync(PROJECT_ROOT);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || !samePath(parentReal, approvedParent)
      || isWithin(projectReal, approvedParent)
      || !samePath(dataRootReal, dataRoot)
      || !samePath(policyParentReal, policyParent)
      || !samePath(policyFileReal, policyFile)
      || !samePath(path.dirname(policyFileReal), policyParentReal)
      || isWithin(dataRootReal, parentReal) || isWithin(parentReal, dataRootReal)
      || isWithin(policyParentReal, parentReal) || isWithin(parentReal, policyParentReal)
      || isWithin(parentReal, policyFileReal)
      || (process.platform !== 'win32' && (Number(parentMetadata.mode) & 0o022) !== 0)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
  }
  const exists = fs.existsSync(filename);
  if (requireLedger && !exists) fail('SYNTHETIC_AUTHORIZATION_LEDGER_REQUIRED');
  if (!requireLedger && exists) {
    return existingPathContext(environment, filename, approvedParent, parentReal);
  }
  if (!exists) {
    assertNoSidecars(filename, 'SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
    return Object.freeze({
      filename,
      approvedParent,
      parentReal,
      exists: false,
      metadata: null,
      contextSha256: null
    });
  }
  return existingPathContext(environment, filename, approvedParent, parentReal);
}

function existingPathContext(environment, filename, approvedParent, parentReal) {
  // A DELETE journal can be a live peer transaction or a hot journal that SQLite must
  // recover while taking its own lock. WAL/SHM are never valid for this ledger profile.
  assertNoWalSidecars(filename);
  let metadata;
  let real;
  try {
    metadata = fs.lstatSync(filename, { bigint: true });
    real = realpathSync(filename);
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNAVAILABLE');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
      || metadata.size <= 0n || metadata.size > BigInt(MAX_LEDGER_BYTES)
      || !samePath(real, filename) || !samePath(path.dirname(real), parentReal)
      || (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
  }
  return Object.freeze({
    filename,
    approvedParent,
    parentReal,
    exists: true,
    metadata,
    contextSha256: ledgerContextSha256(filename, approvedParent, metadata),
    environment
  });
}

function createLedgerFile(context) {
  let descriptor;
  try {
    descriptor = fs.openSync(context.filename, 'wx', 0o600);
    const metadata = fs.fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
        || (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const pathMetadata = fs.lstatSync(context.filename, { bigint: true });
    if (!sameFileIdentity(metadata, pathMetadata)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
    }
    return Object.freeze({ metadata: pathMetadata });
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    if (error instanceof SyntheticAuthorizationLedgerError) throw error;
    if (error && error.code === 'EEXIST') {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ALREADY_INITIALIZED');
    }
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_ROOT_UNSAFE');
  }
}

function cleanupCreatedLedger(context, createdMetadata) {
  try {
    assertNoSidecars(context.filename);
    const current = fs.lstatSync(context.filename, { bigint: true });
    if (!sameFileIdentity(current, createdMetadata)) return false;
    fs.unlinkSync(context.filename);
    return !fs.existsSync(context.filename);
  } catch (_) {
    return false;
  }
}

function configureWritableDatabase(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const journal = db.prepare('PRAGMA journal_mode = DELETE').get();
  if (!journal || String(journal.journal_mode).toLowerCase() !== 'delete') {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID');
  }
  db.exec('PRAGMA synchronous = FULL');
}

function createLedgerSchema(db) {
  db.exec(`PRAGMA application_id = ${LEDGER_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
  db.exec(LEDGER_SCHEMA_SQL);
}

let referenceSchema;
function expectedSchemaRows() {
  if (referenceSchema) return referenceSchema;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    createLedgerSchema(db);
    referenceSchema = Object.freeze(db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all().map(row => Object.freeze({ ...row })));
    return referenceSchema;
  } finally {
    db.close();
  }
}

function validateSchema(db) {
  const application = db.prepare('PRAGMA application_id').get();
  const version = db.prepare('PRAGMA user_version').get();
  const actual = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  if (!application || application.application_id !== LEDGER_APPLICATION_ID
      || !version || version.user_version !== LEDGER_SCHEMA_VERSION
      || canonicalJson(actual) !== canonicalJson(expectedSchemaRows())) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID');
  }
}

function validateIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
  }
}

function identityRow(db) {
  return db.prepare('SELECT * FROM ledger_identity WHERE singleton_id = 1').get();
}

function checkpointRecordShape(value) {
  return {
    policyIdSha256: value.policyIdSha256,
    policySha256: value.policySha256,
    policyRevision: value.policyRevision,
    sequence: value.sequence,
    authorityPrincipalIdSha256: value.authorityPrincipalIdSha256,
    checkpointSha256: value.checkpointSha256,
    issuedAt: value.issuedAt,
    validUntil: value.validUntil,
    revokedKeyIds: value.revokedKeyIds,
    revokedPrincipalIdsSha256: value.revokedPrincipalIdsSha256,
    revokedApprovalIdsSha256: value.revokedApprovalIdsSha256,
    revokedGrantIdsSha256: value.revokedGrantIdsSha256,
    checkpointEnvelopeSha256: canonicalHash(value.envelope)
  };
}

function checkpointRecordSha256(value, recordedAtObserved) {
  return canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic-local-revocation-checkpoint-record',
    ...checkpointRecordShape(value),
    recordedAtObserved
  });
}

function checkpointFromRow(row) {
  let revokedKeyIds;
  let revokedPrincipalIdsSha256;
  let revokedApprovalIdsSha256;
  let revokedGrantIdsSha256;
  let envelope;
  try {
    revokedKeyIds = JSON.parse(row.revoked_key_ids_json);
    revokedPrincipalIdsSha256 = JSON.parse(row.revoked_principal_ids_json);
    revokedApprovalIdsSha256 = JSON.parse(row.revoked_approval_ids_json);
    revokedGrantIdsSha256 = JSON.parse(row.revoked_grant_ids_json);
    envelope = JSON.parse(row.checkpoint_envelope_json);
  } catch (_) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
  }
  const value = {
    policyIdSha256: row.policy_id_sha256,
    policySha256: row.policy_sha256,
    policyRevision: row.policy_revision,
    sequence: row.sequence,
    authorityPrincipalIdSha256: row.authority_principal_id_sha256,
    checkpointSha256: row.checkpoint_sha256,
    issuedAt: row.issued_at,
    validUntil: row.valid_until,
    recordedAtObserved: row.recorded_at_observed,
    revokedKeyIds: sortedUniqueDigests(
      revokedKeyIds,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    ),
    revokedPrincipalIdsSha256: sortedUniqueDigests(
      revokedPrincipalIdsSha256,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    ),
    revokedApprovalIdsSha256: sortedUniqueDigests(
      revokedApprovalIdsSha256,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    ),
    revokedGrantIdsSha256: sortedUniqueDigests(
      revokedGrantIdsSha256,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    ),
    envelope
  };
  if (!validDigest(value.policyIdSha256) || !validDigest(value.policySha256)
      || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !validDigest(value.authorityPrincipalIdSha256)
      || !validDigest(value.checkpointSha256)
      || parseCanonicalTimestamp(value.issuedAt,
        'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID')
        >= parseCanonicalTimestamp(value.validUntil,
          'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID')
      || !Number.isFinite(parseCanonicalTimestamp(value.recordedAtObserved,
        'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'))
      || canonicalHash(envelope) !== value.checkpointSha256
      || checkpointRecordSha256(value, value.recordedAtObserved)
        !== row.checkpoint_record_sha256) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
  }
  return Object.freeze(value);
}

function validateStoredRecords(db, identity) {
  const checkpoints = db.prepare(`
    SELECT * FROM revocation_checkpoints ORDER BY sequence
  `).all().map(checkpointFromRow);
  if (checkpoints.length === 0) fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (checkpoints[index].sequence !== checkpoints[index - 1].sequence + 1
        || Date.parse(checkpoints[index].issuedAt)
          < Date.parse(checkpoints[index - 1].issuedAt)
        || Date.parse(checkpoints[index].recordedAtObserved)
          < Date.parse(checkpoints[index - 1].recordedAtObserved)
        || !revocationsAreSuperset(checkpoints[index - 1], checkpoints[index])) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
  }
  const consumptions = db.prepare('SELECT * FROM grant_consumptions').all();
  for (const row of consumptions) {
    const receipt = receiptShapeFromRow(row, identity.ledger_id_sha256);
    const checkpoint = checkpoints.find(candidate => (
      candidate.policySha256 === row.policy_sha256
      && candidate.sequence === row.checkpoint_sequence
    ));
    const digestFields = [
      row.grant_id_sha256,
      row.grant_envelope_sha256,
      row.approval_envelope_sha256,
      row.request_id_sha256,
      row.request_fingerprint_sha256,
      row.policy_id_sha256,
      row.policy_sha256,
      row.checkpoint_sha256,
      row.consumer_id_sha256,
      row.target_environment_sha256,
      row.subject_sha256,
      row.candidate_binding_sha256,
      row.implementation_tree_sha256,
      row.configuration_sha256,
      row.receipt_sha256
    ];
    const consumedAt = parseCanonicalTimestamp(
      row.consumed_at_observed,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    );
    const verificationValidUntil = parseCanonicalTimestamp(
      row.verification_valid_until,
      'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
    );
    if (digestFields.some(value => !validDigest(value))
        || !Number.isSafeInteger(row.policy_revision) || row.policy_revision < 1
        || !Number.isSafeInteger(row.checkpoint_sequence)
        || row.checkpoint_sequence < 1
        || !Number.isSafeInteger(row.test_only_overrides_used)
        || row.test_only_overrides_used !== identity.test_only_initialized
        || !COMMIT.test(row.source_commit)
        || /^([0-9a-f])\1+$/.test(row.source_commit)
        || consumedAt >= verificationValidUntil
        || !checkpoint
        || checkpoint.policyIdSha256 !== row.policy_id_sha256
        || checkpoint.policyRevision !== row.policy_revision
        || checkpoint.checkpointSha256 !== row.checkpoint_sha256
        || canonicalHash(receipt) !== row.receipt_sha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
  }
  const rejections = db.prepare('SELECT * FROM grant_rejections').all();
  for (const row of rejections) {
    const record = rejectionShape(row);
    recoveredStableError(row.stable_error_code);
    if (!validDigest(row.request_id_sha256)
        || !validDigest(row.request_fingerprint_sha256)
        || !validDigest(row.checkpoint_sha256)
        || !validDigest(row.rejection_record_sha256)
        || !Number.isFinite(parseCanonicalTimestamp(row.recorded_at_observed,
          'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'))
        || !checkpoints.some(checkpoint => (
          checkpoint.checkpointSha256 === row.checkpoint_sha256
        ))
        || canonicalHash(record) !== row.rejection_record_sha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
  }
  const blocks = db.prepare('SELECT * FROM ledger_blocks').all();
  for (const row of blocks) {
    if (!validDigest(row.block_sha256)
        || !Number.isSafeInteger(row.presented_checkpoint_sequence)
        || row.presented_checkpoint_sequence < 1
        || !validDigest(row.presented_checkpoint_sha256)
        || !Number.isFinite(parseCanonicalTimestamp(row.observed_at,
          'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'))
        || canonicalHash(blockShapeFromRow(row)) !== row.block_sha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
  }
  return Object.freeze({ checkpoints, consumptions, rejections, blocks });
}

function inspectLedger(context, environment) {
  const before = fs.lstatSync(context.filename, { bigint: true });
  let db;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(context.filename);
    configureWritableDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    validateSchema(db);
    validateIntegrity(db);
    const identity = identityRow(db);
    if (!identity || db.prepare('SELECT COUNT(*) AS count FROM ledger_identity').get().count !== 1
        || identity.schema_version !== 1
        || identity.purpose !== 'synthetic_local_authorization_ledger'
        || identity.ledger_id_sha256 !== environment[LEDGER_ID_ENV]
        || identity.consumer_id_sha256 !== environment[CONSUMER_ID_ENV]
        || identity.target_environment_sha256 !== environment[TARGET_ENVIRONMENT_ENV]
        || identity.context_sha256 !== context.contextSha256
        || !Number.isSafeInteger(identity.test_only_initialized)
        || ![0, 1].includes(identity.test_only_initialized)
        || !validDigest(identity.active_policy_id_sha256)
        || !validDigest(identity.active_policy_sha256)
        || !Number.isSafeInteger(identity.active_policy_revision)
        || identity.active_policy_revision < 1
        || !Number.isSafeInteger(identity.genesis_checkpoint_sequence)
        || identity.genesis_checkpoint_sequence < 1
        || !validDigest(identity.genesis_checkpoint_sha256)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    const records = validateStoredRecords(db, identity);
    if (records.checkpoints[0].sequence !== identity.genesis_checkpoint_sequence
        || records.checkpoints[0].checkpointSha256 !== identity.genesis_checkpoint_sha256
        || records.checkpoints.some(checkpoint => (
          checkpoint.policyIdSha256 !== identity.active_policy_id_sha256
          || checkpoint.policySha256 !== identity.active_policy_sha256
          || checkpoint.policyRevision !== identity.active_policy_revision
        ))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
    if (identity.created_at_observed !== records.checkpoints[0].recordedAtObserved
        || !Number.isFinite(parseCanonicalTimestamp(identity.created_at_observed,
          'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
    const result = Object.freeze({
      identity: Object.freeze({ ...identity }),
      records,
      blocks: records.blocks.length
    });
    db.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen && db) {
      try {
        db.exec('ROLLBACK');
        transactionOpen = false;
      } catch (_) {
        fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
      }
    }
    if (error instanceof SyntheticAuthorizationLedgerError) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_BUSY');
    }
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    let after;
    try {
      after = fs.lstatSync(context.filename, { bigint: true });
    } catch (_) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    if (!sameFileIdentity(before, after)
        || after.size <= 0n || after.size > BigInt(MAX_LEDGER_BYTES)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    assertNoWalSidecars(context.filename);
  }
}

function normalizeInitializationDocument(document) {
  exactKeys(document, [
    'schemaVersion', 'purpose', 'requestId', 'signedRevocationCheckpoint'
  ]);
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_local_authorization_ledger_initialize'
      || typeof document.requestId !== 'string'
      || !INIT_REQUEST_ID.test(document.requestId)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  }
  return Object.freeze({
    requestIdSha256: sha256(Buffer.from(document.requestId, 'utf8')),
    requestFingerprintSha256: canonicalHash(document),
    checkpointEnvelope: document.signedRevocationCheckpoint
  });
}

function normalizeConsumptionDocument(document) {
  exactKeys(document, ['schemaVersion', 'purpose', 'requestId', 'verificationDocument']);
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_local_grant_compare_and_consume'
      || typeof document.requestId !== 'string'
      || !CONSUME_REQUEST_ID.test(document.requestId)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  }
  return Object.freeze({
    requestIdSha256: sha256(Buffer.from(document.requestId, 'utf8')),
    requestFingerprintSha256: canonicalHash(document),
    verificationDocument: document.verificationDocument
  });
}

function approvalEnvironment(environment) {
  return {
    ...environment,
    [externalApproval.ACK_ENV]: externalApproval.ACK
  };
}

function normalizeCheckpointVerification(result, envelope, environment, testOnly) {
  const code = 'SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED';
  if (!result || typeof result !== 'object'
      || result.schemaVersion !== 1
      || result.profile !== 'synthetic-external-revocation-checkpoint-verification'
      || result.result
        !== 'revocation-checkpoint-valid-against-provided-policy-not-authoritative-latest') {
    fail(code);
  }
  const policyIdSha256 = result.trustPolicyIdSha256;
  const policySha256 = result.trustPolicySha256;
  const policyRevision = result.trustPolicyRevision;
  const sequence = result.revocationCheckpointSequence;
  const checkpointSha256 = result.revocationCheckpointSha256;
  const issuedAt = result.revocationCheckpointIssuedAt;
  const checkpointDeclaredValidUntil = result.revocationCheckpointValidUntil;
  const validUntil = result.validUntil;
  const authorityPrincipalIdSha256 = result.revocationAuthorityPrincipalIdSha256;
  const revokedKeyIds = sortedUniqueDigests(result.revokedKeyIds, code);
  const revokedPrincipalIdsSha256 = sortedUniqueDigests(
    result.revokedPrincipalIdsSha256,
    code
  );
  const revokedApprovalIdsSha256 = sortedUniqueDigests(
    result.revokedApprovalIdsSha256,
    code
  );
  const revokedGrantIdsSha256 = sortedUniqueDigests(result.revokedGrantIdsSha256, code);
  if (!validDigest(policyIdSha256) || !validDigest(policySha256)
      || policySha256 !== environment[externalApproval.POLICY_SHA256_ENV]
      || !Number.isSafeInteger(policyRevision) || policyRevision < 1
      || !Number.isSafeInteger(sequence) || sequence < 1
      || !validDigest(checkpointSha256) || canonicalHash(envelope) !== checkpointSha256
      || !validDigest(authorityPrincipalIdSha256)
      || parseCanonicalTimestamp(issuedAt, code)
        >= parseCanonicalTimestamp(checkpointDeclaredValidUntil, code)
      || parseCanonicalTimestamp(validUntil, code)
        > parseCanonicalTimestamp(checkpointDeclaredValidUntil, code)
      || parseCanonicalTimestamp(result.verifiedAt, code)
        >= parseCanonicalTimestamp(validUntil, code)
      || result.checks?.testOnlyOverridesUsed !== testOnly
      || result.checks?.trustPolicyExternallyAuthorizedByThisCommand !== false
      || result.checks?.revocationAuthorityIdentityAuthenticatedByThisCommand !== false
      || result.checks?.revocationCheckpointLatestAtAuthorityVerified !== false
      || result.checks?.trustedTimeVerified !== false
      || result.operations?.networkAccessPerformedByVerifier !== false
      || result.operations?.fileWritePerformedByVerifier !== false
      || result.operations?.databaseWritePerformedByVerifier !== false
      || result.operations?.deploymentPerformed !== false
      || result.deploymentAuthorization !== 'not_granted'
      || result.productionChildGateState !== 'not_observed'
      || result.childUseAuthorization !== 'not_granted') {
    fail(code);
  }
  return Object.freeze({
    policyIdSha256,
    policySha256,
    policyRevision,
    sequence,
    checkpointSha256,
    issuedAt,
    validUntil,
    authorityPrincipalIdSha256,
    revokedKeyIds,
    revokedPrincipalIdsSha256,
    revokedApprovalIdsSha256,
    revokedGrantIdsSha256,
    envelope
  });
}

function callCheckpointVerifier(environment, envelope, options) {
  const testOnly = typeof options.checkpointVerifier === 'function';
  const result = testOnly
    ? options.checkpointVerifier(environment, envelope, options)
    : externalApproval.verifySyntheticRevocationCheckpoint(
      approvalEnvironment(environment),
      envelope
    );
  return normalizeCheckpointVerification(result, envelope, environment, testOnly);
}

function callApprovalVerifier(environment, document, options) {
  const testOnly = typeof options.approvalVerifier === 'function';
  const result = testOnly
    ? options.approvalVerifier(environment, document, options)
    : externalApproval.verifySyntheticExternalApproval(
      approvalEnvironment(environment),
      document
    );
  return normalizeApprovalVerification(result, document, environment, testOnly);
}

function normalizeApprovalVerification(result, document, environment, testOnly) {
  const code = 'SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED';
  if (!result || typeof result !== 'object' || result.schemaVersion !== 2
      || result.profile !== 'synthetic-external-approval-verification'
      || result.result !== 'signed-bundle-valid-against-provided-policy-unconsumed'
      || result.trustPolicySha256 !== environment[externalApproval.POLICY_SHA256_ENV]
      || !validDigest(result.trustPolicyIdSha256)
      || !validDigest(result.consumerIdSha256)
      || !validDigest(result.targetEnvironmentSha256)
      || !Number.isSafeInteger(result.trustPolicyRevision)
      || !validDigest(result.revocationCheckpointSha256)
      || !Number.isSafeInteger(result.revocationCheckpointSequence)
      || !validDigest(result.approvalEnvelopeSha256)
      || !validDigest(result.grantIdSha256)
      || !validDigest(result.grantEnvelopeSha256)
      || !validDigest(result.subjectSha256)
      || !validDigest(result.candidateBindingSha256)
      || !COMMIT.test(result.sourceCommit)
      || !validDigest(result.implementationTreeSha256)
      || !validDigest(result.configurationSha256)
      || result.checks?.testOnlyOverridesUsed !== testOnly
      || result.checks?.trustPolicyExternallyAuthorizedByThisCommand !== false
      || result.checks?.trustedTimeVerified !== false
      || result.checks?.authorizationConsumptionVerified !== false
      || result.operations?.syntheticDatabaseWritten !== false
      || result.operations?.networkAccessPerformed !== false
      || result.operations?.deploymentPerformed !== false
      || result.operations?.productionDataRead !== false
      || result.operations?.productionChildGateChanged !== false
      || result.deploymentAuthorization !== 'not_granted'
      || result.childUseAuthorization !== 'not_granted'
      || result.productionChildGateState !== 'not_observed'
      || result.deploymentGrantStatus
        !== 'signature_valid_against_provided_policy_unconsumed') {
    fail(code);
  }
  const checkpointEnvelope = document?.signedRevocationCheckpoint;
  const approvalEnvelope = document?.signedDeploymentApproval;
  const grantEnvelope = document?.signedDeploymentGrant;
  const grantPayload = grantEnvelope?.payload;
  if (canonicalHash(checkpointEnvelope) !== result.revocationCheckpointSha256
      || canonicalHash(approvalEnvelope) !== result.approvalEnvelopeSha256
      || canonicalHash(grantEnvelope) !== result.grantEnvelopeSha256
      || typeof grantPayload?.grantId !== 'string'
      || sha256(Buffer.from(grantPayload.grantId, 'utf8')) !== result.grantIdSha256
      || grantPayload.consumerIdSha256 !== result.consumerIdSha256
      || grantPayload.subjectSha256 !== result.subjectSha256
      || grantPayload.candidateBindingSha256 !== result.candidateBindingSha256
      || grantPayload.sourceCommit !== result.sourceCommit
      || grantPayload.implementationTreeSha256 !== result.implementationTreeSha256
      || grantPayload.configurationSha256 !== result.configurationSha256
      || grantPayload.targetEnvironmentSha256 !== result.targetEnvironmentSha256) {
    fail(code);
  }
  const verifiedAt = parseCanonicalTimestamp(result.verifiedAt, code);
  const validUntil = parseCanonicalTimestamp(result.validUntil, code);
  const grantValidUntil = parseCanonicalTimestamp(grantPayload.expiresAt, code);
  if (verifiedAt >= validUntil || validUntil > grantValidUntil) fail(code);
  return Object.freeze({ ...result, testOnly });
}

function revocationsAreSuperset(prior, current) {
  for (const name of [
    'revokedKeyIds', 'revokedPrincipalIdsSha256',
    'revokedApprovalIdsSha256', 'revokedGrantIdsSha256'
  ]) {
    const next = new Set(current[name]);
    if (prior[name].some(value => !next.has(value))) return false;
  }
  return true;
}

function insertCheckpoint(db, checkpoint, recordedAt) {
  const recordSha256 = checkpointRecordSha256(checkpoint, recordedAt);
  db.prepare(`
    INSERT INTO revocation_checkpoints(
      policy_id_sha256, policy_sha256, policy_revision, sequence,
      authority_principal_id_sha256, checkpoint_sha256, issued_at, valid_until,
      revoked_key_ids_json, revoked_principal_ids_json,
      revoked_approval_ids_json, revoked_grant_ids_json,
      checkpoint_envelope_json, checkpoint_record_sha256, recorded_at_observed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.policyIdSha256,
    checkpoint.policySha256,
    checkpoint.policyRevision,
    checkpoint.sequence,
    checkpoint.authorityPrincipalIdSha256,
    checkpoint.checkpointSha256,
    checkpoint.issuedAt,
    checkpoint.validUntil,
    JSON.stringify(checkpoint.revokedKeyIds),
    JSON.stringify(checkpoint.revokedPrincipalIdsSha256),
    JSON.stringify(checkpoint.revokedApprovalIdsSha256),
    JSON.stringify(checkpoint.revokedGrantIdsSha256),
    canonicalJson(checkpoint.envelope),
    recordSha256,
    recordedAt
  );
  return recordSha256;
}

function initializeOutput(identity, outcome, checkpoint) {
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-local-authorization-ledger-initialization',
    result: outcome === 'created'
      ? 'local-ledger-genesis-recorded'
      : 'local-ledger-genesis-replayed',
    outcome,
    ledgerIdSha256: identity.ledger_id_sha256,
    consumerIdSha256: identity.consumer_id_sha256,
    targetEnvironmentSha256: identity.target_environment_sha256,
    trustPolicyIdSha256: identity.active_policy_id_sha256,
    trustPolicySha256: identity.active_policy_sha256,
    trustPolicyRevision: identity.active_policy_revision,
    revocationCheckpointSequence: checkpoint.sequence,
    revocationCheckpointSha256: checkpoint.checkpointSha256,
    checks: Object.freeze({
      testOnlyOverridesUsed: identity.test_only_initialized === 1,
      ledgerContextBound: true,
      checkpointSignatureVerifiedAgainstProvidedPolicy: true,
      localGenesisRecorded: true,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      trustedTimeVerified: false,
      latestCheckpointExternallyConfirmed: false,
      rollbackResistanceExternallyAnchored: false,
      consumerIdentityExternallyAuthenticatedByThisCommand: false,
      deploymentActionAtomicallyBound: false
    }),
    operations: Object.freeze({
      localAuthorizationLedgerWritten: outcome === 'created',
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function callFault(options, stage) {
  if (options && typeof options.fault === 'function') options.fault(stage);
}

function currentDate(options, name = 'now') {
  const source = options[name] instanceof Date
    ? options[name]
    : (name !== 'now' && options.now instanceof Date ? options.now : new Date());
  const value = new Date(source);
  if (!Number.isFinite(value.getTime())) fail('SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID');
  return value;
}

function initializeLedgerInternal(environment, document, options) {
  assertEnvironment(environment, INIT_ACK_ENV, INIT_ACK);
  const input = normalizeInitializationDocument(document);
  const initialContext = createPathContext(environment, false);
  if (initialContext.exists) {
    const inspected = inspectLedger(initialContext, environment);
    const identity = inspected.identity;
    if (identity.test_only_initialized !== (options.testOnly === true ? 1 : 0)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED');
    }
    if (identity.init_request_id_sha256 !== input.requestIdSha256
        || identity.init_request_fingerprint_sha256 !== input.requestFingerprintSha256
        || canonicalHash(input.checkpointEnvelope) !== identity.genesis_checkpoint_sha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_ALREADY_INITIALIZED');
    }
    const checkpoint = inspected.records.checkpoints[0];
    const verifiedCheckpoint = callCheckpointVerifier(
      environment,
      input.checkpointEnvelope,
      options
    );
    if (canonicalJson(checkpointRecordShape(verifiedCheckpoint))
        !== canonicalJson(checkpointRecordShape(checkpoint))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED');
    }
    if (currentDate(options).getTime() >= Date.parse(verifiedCheckpoint.validUntil)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED');
    }
    return initializeOutput(identity, 'replayed', checkpoint);
  }
  const created = createLedgerFile(initialContext);
  const context = Object.freeze({
    filename: initialContext.filename,
    approvedParent: initialContext.approvedParent,
    parentReal: initialContext.parentReal,
    exists: true,
    metadata: created.metadata,
    contextSha256: ledgerContextSha256(
      initialContext.filename,
      initialContext.approvedParent,
      created.metadata
    ),
    environment
  });
  let db;
  let transactionOpen = false;
  let committed = false;
  try {
    db = new DatabaseSync(context.filename);
    configureWritableDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    callFault(options, 'after_begin');
    createLedgerSchema(db);
    const checkpoint = callCheckpointVerifier(environment, input.checkpointEnvelope, options);
    const observedStart = currentDate(options);
    if (observedStart.getTime() >= Date.parse(checkpoint.validUntil)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED');
    }
    callFault(options, 'before_commit');
    const checkpointAtCommit = callCheckpointVerifier(
      environment,
      input.checkpointEnvelope,
      options
    );
    if (canonicalJson(checkpointRecordShape(checkpointAtCommit))
        !== canonicalJson(checkpointRecordShape(checkpoint))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED');
    }
    const commitDate = currentDate(options, 'commitAt');
    if (commitDate.getTime() < observedStart.getTime()
        || commitDate.getTime() >= Date.parse(checkpointAtCommit.validUntil)) {
      fail(commitDate.getTime() < observedStart.getTime()
        ? 'SYNTHETIC_AUTHORIZATION_LEDGER_LOCAL_CLOCK_ROLLBACK'
        : 'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED');
    }
    const observed = commitDate.toISOString();
    db.prepare(`
      INSERT INTO ledger_identity(
        singleton_id, schema_version, purpose,
        ledger_id_sha256, consumer_id_sha256, target_environment_sha256,
        context_sha256, test_only_initialized,
        init_request_id_sha256, init_request_fingerprint_sha256,
        active_policy_id_sha256, active_policy_sha256, active_policy_revision,
        genesis_checkpoint_sequence, genesis_checkpoint_sha256, created_at_observed
      ) VALUES (1, 1, 'synthetic_local_authorization_ledger', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      environment[LEDGER_ID_ENV],
      environment[CONSUMER_ID_ENV],
      environment[TARGET_ENVIRONMENT_ENV],
      context.contextSha256,
      options.testOnly === true ? 1 : 0,
      input.requestIdSha256,
      input.requestFingerprintSha256,
      checkpointAtCommit.policyIdSha256,
      checkpointAtCommit.policySha256,
      checkpointAtCommit.policyRevision,
      checkpointAtCommit.sequence,
      checkpointAtCommit.checkpointSha256,
      observed
    );
    insertCheckpoint(db, checkpointAtCommit, observed);
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    callFault(options, 'after_commit');
    const identity = identityRow(db);
    return initializeOutput(identity, 'created', checkpointAtCommit);
  } catch (error) {
    let rollbackUnknown = false;
    if (transactionOpen && db) {
      try { db.exec('ROLLBACK'); } catch (_) { rollbackUnknown = true; }
    }
    if (db) {
      try { db.close(); } catch (_) { rollbackUnknown = true; }
      db = undefined;
    }
    if (!committed && !rollbackUnknown
        && !cleanupCreatedLedger(initialContext, created.metadata)) rollbackUnknown = true;
    if (rollbackUnknown || committed) fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
    if (error instanceof SyntheticAuthorizationLedgerError
        || error instanceof externalApproval.SyntheticExternalApprovalError) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_BUSY');
    }
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_TRANSACTION_FAILED');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (!fs.existsSync(initialContext.filename) && committed) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
    }
    if (fs.existsSync(initialContext.filename)) {
      let after;
      try {
        after = fs.lstatSync(initialContext.filename, { bigint: true });
      } catch (_) {
        fail(committed
          ? 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
          : 'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
      }
      if (!sameFileIdentity(created.metadata, after)
          || after.size <= 0n || after.size > BigInt(MAX_LEDGER_BYTES)) {
        fail(committed
          ? 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
          : 'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
      }
      assertNoWalSidecars(initialContext.filename);
    }
  }
}

function initializeSyntheticAuthorizationLedger(environment, document) {
  return initializeLedgerInternal(environment, document, {});
}

function initializeSyntheticAuthorizationLedgerForTest(environment, document, options = {}) {
  return initializeLedgerInternal(environment, document, { ...options, testOnly: true });
}

function latestCheckpoint(db) {
  const row = db.prepare(`
    SELECT * FROM revocation_checkpoints ORDER BY sequence DESC LIMIT 1
  `).get();
  return row ? checkpointFromRow(row) : null;
}

function maximumObservedTime(db) {
  const values = db.prepare(`
    SELECT created_at_observed AS value FROM ledger_identity
    UNION ALL SELECT recorded_at_observed FROM revocation_checkpoints
    UNION ALL SELECT consumed_at_observed FROM grant_consumptions
    UNION ALL SELECT recorded_at_observed FROM grant_rejections
    UNION ALL SELECT observed_at FROM ledger_blocks
  `).all().map(row => Date.parse(row.value));
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
  }
  return Math.max(...values);
}

function compareCheckpoint(identity, head, checkpoint) {
  if (checkpoint.policyIdSha256 !== identity.active_policy_id_sha256) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_MISMATCH');
  }
  if (checkpoint.policySha256 !== identity.active_policy_sha256
      || checkpoint.policyRevision !== identity.active_policy_revision) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED');
  }
  if (checkpoint.sequence < head.sequence) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_ROLLBACK');
  }
  if (checkpoint.sequence === head.sequence) {
    return checkpoint.checkpointSha256 === head.checkpointSha256
      ? Object.freeze({ action: 'same' })
      : Object.freeze({ action: 'block', code: 'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK' });
  }
  if (checkpoint.sequence !== head.sequence + 1) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_GAP');
  }
  if (Date.parse(checkpoint.issuedAt) < Date.parse(head.issuedAt)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_ROLLBACK');
  }
  if (!revocationsAreSuperset(head, checkpoint)) {
    return Object.freeze({
      action: 'block',
      code: 'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_REVOCATION_REMOVED'
    });
  }
  return Object.freeze({ action: 'advance' });
}

function blockShapeFromRow(row) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic-local-authorization-ledger-block',
    reasonCode: row.reason_code,
    presentedCheckpointSequence: row.presented_checkpoint_sequence,
    presentedCheckpointSha256: row.presented_checkpoint_sha256,
    observedAt: row.observed_at
  };
}

function insertBlock(db, code, checkpoint, observedAt) {
  const row = {
    reason_code: code,
    presented_checkpoint_sequence: checkpoint.sequence,
    presented_checkpoint_sha256: checkpoint.checkpointSha256,
    observed_at: observedAt
  };
  const shape = blockShapeFromRow(row);
  const blockSha256 = canonicalHash(shape);
  db.prepare(`
    INSERT INTO ledger_blocks(
      block_sha256, reason_code, presented_checkpoint_sequence,
      presented_checkpoint_sha256, observed_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    blockSha256,
    code,
    checkpoint.sequence,
    checkpoint.checkpointSha256,
    observedAt
  );
}

function rejectionShape(row) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic-local-grant-rejection-record',
    requestIdSha256: row.request_id_sha256,
    requestFingerprintSha256: row.request_fingerprint_sha256,
    checkpointSha256: row.checkpoint_sha256,
    stableErrorCode: row.stable_error_code,
    recordedAtObserved: row.recorded_at_observed
  };
}

function insertRejection(db, input, checkpoint, errorCode, observedAt) {
  const shape = {
    schemaVersion: 1,
    purpose: 'synthetic-local-grant-rejection-record',
    requestIdSha256: input.requestIdSha256,
    requestFingerprintSha256: input.requestFingerprintSha256,
    checkpointSha256: checkpoint.checkpointSha256,
    stableErrorCode: errorCode,
    recordedAtObserved: observedAt
  };
  db.prepare(`
    INSERT INTO grant_rejections(
      request_id_sha256, request_fingerprint_sha256, checkpoint_sha256,
      stable_error_code, rejection_record_sha256, recorded_at_observed
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.requestIdSha256,
    input.requestFingerprintSha256,
    checkpoint.checkpointSha256,
    errorCode,
    canonicalHash(shape),
    observedAt
  );
}

function receiptShape(value) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic-local-grant-consumption-receipt',
    ledgerIdSha256: value.ledgerIdSha256,
    testOnlyOverridesUsed: value.testOnlyOverridesUsed,
    consumerIdSha256: value.consumerIdSha256,
    targetEnvironmentSha256: value.targetEnvironmentSha256,
    trustPolicyIdSha256: value.trustPolicyIdSha256,
    trustPolicySha256: value.trustPolicySha256,
    trustPolicyRevision: value.trustPolicyRevision,
    revocationCheckpointSequence: value.revocationCheckpointSequence,
    revocationCheckpointSha256: value.revocationCheckpointSha256,
    requestIdSha256: value.requestIdSha256,
    requestFingerprintSha256: value.requestFingerprintSha256,
    subjectSha256: value.subjectSha256,
    candidateBindingSha256: value.candidateBindingSha256,
    sourceCommit: value.sourceCommit,
    implementationTreeSha256: value.implementationTreeSha256,
    configurationSha256: value.configurationSha256,
    approvalEnvelopeSha256: value.approvalEnvelopeSha256,
    grantIdSha256: value.grantIdSha256,
    grantEnvelopeSha256: value.grantEnvelopeSha256,
    consumedAtObserved: value.consumedAtObserved,
    verificationValidUntil: value.verificationValidUntil
  };
}

function receiptShapeFromRow(row, ledgerIdSha256) {
  return receiptShape({
    ledgerIdSha256,
    testOnlyOverridesUsed: row.test_only_overrides_used === 1,
    consumerIdSha256: row.consumer_id_sha256,
    targetEnvironmentSha256: row.target_environment_sha256,
    trustPolicyIdSha256: row.policy_id_sha256,
    trustPolicySha256: row.policy_sha256,
    trustPolicyRevision: row.policy_revision,
    revocationCheckpointSequence: row.checkpoint_sequence,
    revocationCheckpointSha256: row.checkpoint_sha256,
    requestIdSha256: row.request_id_sha256,
    requestFingerprintSha256: row.request_fingerprint_sha256,
    subjectSha256: row.subject_sha256,
    candidateBindingSha256: row.candidate_binding_sha256,
    sourceCommit: row.source_commit,
    implementationTreeSha256: row.implementation_tree_sha256,
    configurationSha256: row.configuration_sha256,
    approvalEnvelopeSha256: row.approval_envelope_sha256,
    grantIdSha256: row.grant_id_sha256,
    grantEnvelopeSha256: row.grant_envelope_sha256,
    consumedAtObserved: row.consumed_at_observed,
    verificationValidUntil: row.verification_valid_until
  });
}

function consumptionOutput(identity, row, outcome) {
  const receipt = receiptShapeFromRow(row, identity.ledger_id_sha256);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-local-authorization-ledger-consumption',
    result: outcome === 'consumed'
      ? 'local-single-use-record-committed'
      : 'local-single-use-record-replayed',
    outcome,
    receiptSha256: row.receipt_sha256,
    ledgerIdSha256: identity.ledger_id_sha256,
    consumerIdSha256: receipt.consumerIdSha256,
    targetEnvironmentSha256: receipt.targetEnvironmentSha256,
    trustPolicyIdSha256: receipt.trustPolicyIdSha256,
    trustPolicySha256: receipt.trustPolicySha256,
    trustPolicyRevision: receipt.trustPolicyRevision,
    revocationCheckpointSequence: receipt.revocationCheckpointSequence,
    revocationCheckpointSha256: receipt.revocationCheckpointSha256,
    subjectSha256: receipt.subjectSha256,
    candidateBindingSha256: receipt.candidateBindingSha256,
    sourceCommit: receipt.sourceCommit,
    implementationTreeSha256: receipt.implementationTreeSha256,
    configurationSha256: receipt.configurationSha256,
    approvalEnvelopeSha256: receipt.approvalEnvelopeSha256,
    grantIdSha256: receipt.grantIdSha256,
    grantEnvelopeSha256: receipt.grantEnvelopeSha256,
    consumedAtObserved: receipt.consumedAtObserved,
    verificationValidUntil: receipt.verificationValidUntil,
    checks: Object.freeze({
      testOnlyOverridesUsed: receipt.testOnlyOverridesUsed,
      historicalReceiptRecovered: outcome === 'replayed',
      historicalFinalRevocationCheckedAtConsumption: true,
      currentLedgerHeadRevalidatedForThisCall: outcome === 'consumed',
      externalApprovalRevalidatedForNewConsumption: outcome === 'consumed',
      checkpointMonotonicAgainstThisLedgerInstance: true,
      checkpointRevocationSetsCumulative: true,
      finalRevocationCheckedAgainstLocalLedgerHead: outcome === 'consumed',
      consumerDigestMatched: true,
      grantCompareAndConsumeAtomicLocallyForThisCall: outcome === 'consumed',
      grantSingleUseRecordCommitted: true,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      trustedTimeVerified: false,
      latestCheckpointExternallyConfirmed: false,
      rollbackResistanceExternallyAnchored: false,
      consumerIdentityExternallyAuthenticatedByThisCommand: false,
      externalDeploymentAtomicityVerified: false,
      globalConsumptionVerified: false
    }),
    operations: Object.freeze({
      localAuthorizationLedgerWritten: outcome === 'consumed',
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    deploymentGrantStatus: outcome === 'consumed'
      ? 'local_single_use_record_committed'
      : 'historical_local_single_use_record_replayed',
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function findHistoricalRequest(db, input) {
  const consumption = db.prepare(`
    SELECT * FROM grant_consumptions WHERE request_id_sha256 = ?
  `).get(input.requestIdSha256);
  if (consumption) {
    if (consumption.request_fingerprint_sha256 !== input.requestFingerprintSha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT');
    }
    return Object.freeze({ type: 'consumption', row: consumption });
  }
  const rejection = db.prepare(`
    SELECT * FROM grant_rejections WHERE request_id_sha256 = ?
  `).get(input.requestIdSha256);
  if (rejection) {
    if (rejection.request_fingerprint_sha256 !== input.requestFingerprintSha256) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT');
    }
    return Object.freeze({ type: 'rejection', row: rejection });
  }
  return null;
}

function insertConsumption(db, identity, input, verification, observedAt) {
  const value = {
    ledgerIdSha256: identity.ledger_id_sha256,
    testOnlyOverridesUsed: identity.test_only_initialized === 1,
    consumerIdSha256: verification.consumerIdSha256,
    targetEnvironmentSha256: verification.targetEnvironmentSha256,
    trustPolicyIdSha256: verification.trustPolicyIdSha256,
    trustPolicySha256: verification.trustPolicySha256,
    trustPolicyRevision: verification.trustPolicyRevision,
    revocationCheckpointSequence: verification.revocationCheckpointSequence,
    revocationCheckpointSha256: verification.revocationCheckpointSha256,
    requestIdSha256: input.requestIdSha256,
    requestFingerprintSha256: input.requestFingerprintSha256,
    subjectSha256: verification.subjectSha256,
    candidateBindingSha256: verification.candidateBindingSha256,
    sourceCommit: verification.sourceCommit,
    implementationTreeSha256: verification.implementationTreeSha256,
    configurationSha256: verification.configurationSha256,
    approvalEnvelopeSha256: verification.approvalEnvelopeSha256,
    grantIdSha256: verification.grantIdSha256,
    grantEnvelopeSha256: verification.grantEnvelopeSha256,
    consumedAtObserved: observedAt,
    verificationValidUntil: verification.validUntil
  };
  const receipt = receiptShape(value);
  const receiptSha256 = canonicalHash(receipt);
  db.prepare(`
    INSERT INTO grant_consumptions(
      grant_id_sha256, grant_envelope_sha256, approval_envelope_sha256,
      request_id_sha256, request_fingerprint_sha256,
      policy_id_sha256, policy_sha256, policy_revision,
      checkpoint_sequence, checkpoint_sha256,
      consumer_id_sha256, target_environment_sha256,
      subject_sha256, candidate_binding_sha256,
      source_commit, implementation_tree_sha256, configuration_sha256,
      consumed_at_observed, verification_valid_until,
      test_only_overrides_used, receipt_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.grantIdSha256,
    value.grantEnvelopeSha256,
    value.approvalEnvelopeSha256,
    value.requestIdSha256,
    value.requestFingerprintSha256,
    value.trustPolicyIdSha256,
    value.trustPolicySha256,
    value.trustPolicyRevision,
    value.revocationCheckpointSequence,
    value.revocationCheckpointSha256,
    value.consumerIdSha256,
    value.targetEnvironmentSha256,
    value.subjectSha256,
    value.candidateBindingSha256,
    value.sourceCommit,
    value.implementationTreeSha256,
    value.configurationSha256,
    value.consumedAtObserved,
    value.verificationValidUntil,
    value.testOnlyOverridesUsed ? 1 : 0,
    receiptSha256
  );
  return db.prepare('SELECT * FROM grant_consumptions WHERE grant_id_sha256 = ?')
    .get(value.grantIdSha256);
}

function uniqueConsumptionConflict(db, verification) {
  if (db.prepare('SELECT 1 FROM grant_consumptions WHERE grant_id_sha256 = ?')
    .get(verification.grantIdSha256)) {
    return 'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED';
  }
  if (db.prepare('SELECT 1 FROM grant_consumptions WHERE grant_envelope_sha256 = ?')
    .get(verification.grantEnvelopeSha256)) {
    return 'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED';
  }
  if (db.prepare('SELECT 1 FROM grant_consumptions WHERE approval_envelope_sha256 = ?')
    .get(verification.approvalEnvelopeSha256)) {
    return 'SYNTHETIC_AUTHORIZATION_LEDGER_APPROVAL_ALREADY_CONSUMED';
  }
  if (db.prepare(`
    SELECT 1 FROM grant_consumptions
    WHERE target_environment_sha256 = ? AND source_commit = ?
      AND implementation_tree_sha256 = ? AND configuration_sha256 = ?
  `).get(
    verification.targetEnvironmentSha256,
    verification.sourceCommit,
    verification.implementationTreeSha256,
    verification.configurationSha256
  )) return 'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_ALREADY_CONSUMED';
  return null;
}

function consumeLedgerInternal(environment, document, options) {
  assertEnvironment(environment, CONSUME_ACK_ENV, CONSUME_ACK);
  const input = normalizeConsumptionDocument(document);
  const context = createPathContext(environment, true);
  const expectedTestOnly = options.testOnly === true ? 1 : 0;
  const before = fs.lstatSync(context.filename, { bigint: true });
  if (!sameFileIdentity(context.metadata, before)) {
    fail('SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
  }
  let db;
  let transactionOpen = false;
  let committed = false;
  let committedRow;
  try {
    db = new DatabaseSync(context.filename);
    configureWritableDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    callFault(options, 'after_begin');
    validateSchema(db);
    validateIntegrity(db);
    const identity = identityRow(db);
    if (!identity || identity.context_sha256 !== context.contextSha256
        || identity.ledger_id_sha256 !== environment[LEDGER_ID_ENV]
        || identity.consumer_id_sha256 !== environment[CONSUMER_ID_ENV]
        || identity.target_environment_sha256 !== environment[TARGET_ENVIRONMENT_ENV]
        || !validDigest(identity.active_policy_id_sha256)
        || !validDigest(identity.active_policy_sha256)
        || !Number.isSafeInteger(identity.test_only_initialized)
        || ![0, 1].includes(identity.test_only_initialized)
        || !Number.isSafeInteger(identity.active_policy_revision)
        || identity.active_policy_revision < 1
        || !Number.isSafeInteger(identity.genesis_checkpoint_sequence)
        || identity.genesis_checkpoint_sequence < 1
        || !validDigest(identity.genesis_checkpoint_sha256)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    if (identity.test_only_initialized !== expectedTestOnly) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED');
    }
    if (identity.active_policy_sha256 !== environment[externalApproval.POLICY_SHA256_ENV]) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED');
    }
    const lockedRecords = validateStoredRecords(db, identity);
    if (lockedRecords.checkpoints[0].sequence !== identity.genesis_checkpoint_sequence
        || lockedRecords.checkpoints[0].checkpointSha256
          !== identity.genesis_checkpoint_sha256
        || identity.created_at_observed
          !== lockedRecords.checkpoints[0].recordedAtObserved
        || lockedRecords.checkpoints.some(checkpoint => (
          checkpoint.policyIdSha256 !== identity.active_policy_id_sha256
          || checkpoint.policySha256 !== identity.active_policy_sha256
          || checkpoint.policyRevision !== identity.active_policy_revision
        ))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID');
    }
    const historical = findHistoricalRequest(db, input);
    if (historical?.type === 'consumption') {
      db.exec('COMMIT');
      transactionOpen = false;
      return consumptionOutput(identity, historical.row, 'replayed');
    }
    if (historical?.type === 'rejection') {
      db.exec('ROLLBACK');
      transactionOpen = false;
      throw recoveredStableError(historical.row.stable_error_code);
    }
    if (lockedRecords.blocks.length !== 0) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_BLOCKED');
    }
    const observedStart = currentDate(options).getTime();
    if (observedStart < maximumObservedTime(db)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_LOCAL_CLOCK_ROLLBACK');
    }
    const checkpoint = callCheckpointVerifier(
      environment,
      input.verificationDocument?.signedRevocationCheckpoint,
      options
    );
    const head = latestCheckpoint(db);
    const comparison = compareCheckpoint(identity, head, checkpoint);
    if (comparison.action === 'block') {
      const blockedAt = currentDate(options, 'commitAt').toISOString();
      insertBlock(db, comparison.code, checkpoint, blockedAt);
      db.exec('COMMIT');
      transactionOpen = false;
      committed = true;
      fail(comparison.code);
    }
    let verification;
    let verificationError;
    try {
      verification = callApprovalVerifier(environment, input.verificationDocument, options);
    } catch (error) {
      verificationError = error;
    }
    const checkpointAtCommit = callCheckpointVerifier(
      environment,
      input.verificationDocument?.signedRevocationCheckpoint,
      options
    );
    if (canonicalJson(checkpointRecordShape(checkpointAtCommit))
        !== canonicalJson(checkpointRecordShape(checkpoint))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED');
    }
    const commitDate = currentDate(options, 'commitAt');
    const commitTime = commitDate.getTime();
    if (commitTime < maximumObservedTime(db)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_LOCAL_CLOCK_ROLLBACK');
    }
    const advances = comparison.action === 'advance';
    if (advances) insertCheckpoint(db, checkpointAtCommit, commitDate.toISOString());
    if (verificationError) {
      insertRejection(
        db,
        input,
        checkpointAtCommit,
        safeErrorCode(verificationError),
        commitDate.toISOString()
      );
      db.exec('COMMIT');
      transactionOpen = false;
      committed = true;
      throw verificationError;
    }
    let terminalError = null;
    if (verification.trustPolicyIdSha256 !== identity.active_policy_id_sha256
        || verification.trustPolicySha256 !== identity.active_policy_sha256
        || verification.trustPolicyRevision !== identity.active_policy_revision
        || verification.revocationCheckpointSha256 !== checkpoint.checkpointSha256
        || verification.revocationCheckpointSequence !== checkpoint.sequence) {
      terminalError = 'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_MISMATCH';
    } else if (verification.consumerIdSha256 !== identity.consumer_id_sha256) {
      terminalError = 'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMER_MISMATCH';
    } else if (verification.targetEnvironmentSha256 !== identity.target_environment_sha256) {
      terminalError = 'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_MISMATCH';
    }
    if (!terminalError) terminalError = uniqueConsumptionConflict(db, verification);
    if (!terminalError && (commitTime >= Date.parse(checkpoint.validUntil)
        || commitTime >= Date.parse(verification.validUntil))) {
      terminalError = 'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED';
    }
    if (terminalError) {
      insertRejection(db, input, checkpointAtCommit, terminalError, commitDate.toISOString());
      db.exec('COMMIT');
      transactionOpen = false;
      committed = true;
      fail(terminalError);
    }
    callFault(options, 'before_consumption');
    committedRow = insertConsumption(db, identity, input, verification, commitDate.toISOString());
    callFault(options, 'after_consumption');
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    callFault(options, 'after_commit');
    if (new Date().getTime() >= Date.parse(verification.validUntil) && !options.testOnly) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
    }
    return consumptionOutput(identity, committedRow, 'consumed');
  } catch (error) {
    let rollbackUnknown = false;
    if (transactionOpen && db) {
      try { db.exec('ROLLBACK'); } catch (_) { rollbackUnknown = true; }
    }
    if (db) {
      try { db.close(); } catch (_) { rollbackUnknown = true; }
      db = undefined;
    }
    if (rollbackUnknown) fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
    if (committed && !(error instanceof SyntheticAuthorizationLedgerError)
        && !(error instanceof externalApproval.SyntheticExternalApprovalError)) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN');
    }
    if (error instanceof SyntheticAuthorizationLedgerError
        || error instanceof externalApproval.SyntheticExternalApprovalError) throw error;
    if (error && typeof error.code === 'string'
        && error.code.startsWith('SYNTHETIC_EXTERNAL_APPROVAL_')) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('SYNTHETIC_AUTHORIZATION_LEDGER_BUSY');
    }
    fail(committed
      ? 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
      : 'SYNTHETIC_AUTHORIZATION_LEDGER_TRANSACTION_FAILED');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    let after;
    try {
      after = fs.lstatSync(context.filename, { bigint: true });
    } catch (_) {
      fail(committed
        ? 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
        : 'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    if (!sameFileIdentity(before, after)
        || after.size <= 0n || after.size > BigInt(MAX_LEDGER_BYTES)) {
      fail(committed
        ? 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
        : 'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH');
    }
    assertNoWalSidecars(context.filename);
  }
}

function consumeSyntheticDeploymentGrant(environment, document) {
  return consumeLedgerInternal(environment, document, {});
}

function consumeSyntheticDeploymentGrantForTest(environment, document, options = {}) {
  return consumeLedgerInternal(environment, document, { ...options, testOnly: true });
}

function initializationUsage() {
  return [
    'Usage: npm run init:synthetic-authorization-ledger',
    '',
    `Requires ${INIT_ACK_ENV}=${INIT_ACK}.`,
    `Requires ${LEDGER_FILE_ENV}, ${LEDGER_PARENT_ENV}, ${LEDGER_ID_ENV},`,
    `${CONSUMER_ID_ENV} and ${TARGET_ENVIRONMENT_ENV}.`,
    'Creates one independent local SQLite ledger and records a signed checkpoint genesis.',
    'It does not authenticate the policy publisher, trust local time, deploy or grant child use.'
  ].join('\n');
}

function consumptionUsage() {
  return [
    'Usage: npm run consume:synthetic-deployment-grant',
    '',
    `Requires ${CONSUME_ACK_ENV}=${CONSUME_ACK}.`,
    'Reads one canonical S16 verification document inside a local consume request.',
    'It writes only the independent ledger, enforces local checkpoint monotonicity and records',
    'one local single-use receipt. It does not prove the checkpoint is globally latest, trust',
    'local time, call a deployment system, deploy, grant production access or grant child use.'
  ].join('\n');
}

async function runCli(kind, argv, environment, stream) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write(`${kind === 'initialize' ? initializationUsage() : consumptionUsage()}\n`);
      return 0;
    }
    const buffer = await readStdin(stream);
    try {
      const document = decodeCanonicalInput(buffer, environment);
      const output = kind === 'initialize'
        ? initializeSyntheticAuthorizationLedger(environment, document)
        : consumeSyntheticDeploymentGrant(environment, document);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } finally {
      buffer.fill(0);
    }
    return 0;
  } catch (error) {
    const operation = kind === 'initialize' ? 'initialization' : 'consumption';
    process.stderr.write(
      `Synthetic authorization ledger ${operation} failed (${safeErrorCode(error)}).\n`
    );
    return 1;
  }
}

function runInitializeCli(
  argv = process.argv.slice(2),
  environment = process.env,
  stream = process.stdin
) {
  return runCli('initialize', argv, environment, stream);
}

function runConsumeCli(
  argv = process.argv.slice(2),
  environment = process.env,
  stream = process.stdin
) {
  return runCli('consume', argv, environment, stream);
}

module.exports = {
  BUSY_TIMEOUT_MS,
  CONSUME_ACK,
  CONSUME_ACK_ENV,
  CONSUMER_ID_ENV,
  INIT_ACK,
  INIT_ACK_ENV,
  LEDGER_APPLICATION_ID,
  LEDGER_FILE_ENV,
  LEDGER_FILENAME,
  LEDGER_ID_ENV,
  LEDGER_PARENT_ENV,
  LEDGER_SCHEMA_VERSION,
  MAX_LEDGER_BYTES,
  MAX_STDIN_BYTES,
  SyntheticAuthorizationLedgerError,
  TARGET_ENVIRONMENT_ENV,
  canonicalHash,
  consumeSyntheticDeploymentGrant,
  consumeSyntheticDeploymentGrantForTest,
  consumptionUsage,
  decodeCanonicalInput,
  initializeSyntheticAuthorizationLedger,
  initializeSyntheticAuthorizationLedgerForTest,
  initializationUsage,
  parseArguments,
  readStdin,
  runConsumeCli,
  runInitializeCli,
  safeErrorCode
};
