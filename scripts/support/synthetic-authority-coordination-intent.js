const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { TextDecoder } = require('node:util');

const authorization = require('./synthetic-authorization-consumer');
const externalApproval = require('./synthetic-external-approval');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const JOURNAL_FILENAME = 'synthetic-authority-coordination-intent.sqlite';
const JOURNAL_APPLICATION_ID = 1413958706;
const JOURNAL_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 15000;
const ACK_ENV = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK';
const ACK = 'prepare-local-intent-not-submitted-v1';
const JOURNAL_FILE_ENV = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_FILE';
const JOURNAL_PARENT_ENV = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVED_PARENT';
const JOURNAL_ID_ENV = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_ID_SHA256';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUEST_ID = /^synthetic-authority-intent-[a-z0-9][a-z0-9_-]{15,80}$/;

const STABLE_ERROR_CODES = new Set([
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ARGUMENT_INVALID',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK_REQUIRED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_STDIN_REQUIRED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_TOO_LARGE',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SENSITIVE_INPUT',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_PRODUCTION_RESOURCE_REJECTED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_CONTEXT_MISMATCH',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TEST_ONLY_STATE_REJECTED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDEMPOTENCY_CONFLICT',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECEIPT_ALREADY_PREPARED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_GRANT_ALREADY_PREPARED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVAL_ALREADY_PREPARED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TARGET_ALREADY_PREPARED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECOVERY_INVALID',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_LOCAL_CLOCK_ROLLBACK',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TRANSACTION_FAILED',
  'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
]);

const JOURNAL_SCHEMA_SQL = `
CREATE TABLE journal_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  purpose TEXT NOT NULL CHECK (purpose = 'synthetic_authority_coordination_intent_journal'),
  journal_id_sha256 TEXT NOT NULL UNIQUE CHECK (length(journal_id_sha256) = 64 AND journal_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  context_sha256 TEXT NOT NULL CHECK (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
  test_only_prepared INTEGER NOT NULL CHECK (test_only_prepared IN (0, 1)),
  created_at_observed TEXT NOT NULL,
  identity_record_sha256 TEXT NOT NULL UNIQUE CHECK (length(identity_record_sha256) = 64 AND identity_record_sha256 NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE coordination_intents (
  intent_id_sha256 TEXT PRIMARY KEY CHECK (length(intent_id_sha256) = 64 AND intent_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64 AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorization_consumption_document_sha256 TEXT NOT NULL CHECK (length(authorization_consumption_document_sha256) = 64 AND authorization_consumption_document_sha256 NOT GLOB '*[^0-9a-f]*'),
  local_receipt_sha256 TEXT NOT NULL UNIQUE CHECK (length(local_receipt_sha256) = 64 AND local_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  ledger_id_sha256 TEXT NOT NULL CHECK (length(ledger_id_sha256) = 64 AND ledger_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  consumer_id_sha256 TEXT NOT NULL CHECK (length(consumer_id_sha256) = 64 AND consumer_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_environment_sha256 TEXT NOT NULL CHECK (length(target_environment_sha256) = 64 AND target_environment_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_id_sha256 TEXT NOT NULL CHECK (length(policy_id_sha256) = 64 AND policy_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence >= 1),
  checkpoint_sha256 TEXT NOT NULL CHECK (length(checkpoint_sha256) = 64 AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
  subject_sha256 TEXT NOT NULL CHECK (length(subject_sha256) = 64 AND subject_sha256 NOT GLOB '*[^0-9a-f]*'),
  candidate_binding_sha256 TEXT NOT NULL CHECK (length(candidate_binding_sha256) = 64 AND candidate_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_commit TEXT NOT NULL,
  implementation_tree_sha256 TEXT NOT NULL CHECK (length(implementation_tree_sha256) = 64 AND implementation_tree_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_sha256 TEXT NOT NULL CHECK (length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  approval_envelope_sha256 TEXT NOT NULL UNIQUE CHECK (length(approval_envelope_sha256) = 64 AND approval_envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  grant_id_sha256 TEXT NOT NULL UNIQUE CHECK (length(grant_id_sha256) = 64 AND grant_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  grant_envelope_sha256 TEXT NOT NULL UNIQUE CHECK (length(grant_envelope_sha256) = 64 AND grant_envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  local_consumed_at_observed TEXT NOT NULL,
  local_verification_valid_until TEXT NOT NULL,
  prepared_at_observed TEXT NOT NULL,
  authority_submission_status TEXT NOT NULL CHECK (authority_submission_status = 'locally_prepared_unsubmitted'),
  test_only_prepared INTEGER NOT NULL CHECK (test_only_prepared IN (0, 1)),
  intent_record_sha256 TEXT NOT NULL UNIQUE CHECK (length(intent_record_sha256) = 64 AND intent_record_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (target_environment_sha256, source_commit, implementation_tree_sha256, configuration_sha256)
);

CREATE TRIGGER trg_coordination_journal_identity_once
BEFORE INSERT ON journal_identity
WHEN EXISTS (SELECT 1 FROM journal_identity)
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ALREADY_INITIALIZED');
END;

CREATE TRIGGER trg_coordination_journal_identity_no_update
BEFORE UPDATE ON journal_identity
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER trg_coordination_journal_identity_no_delete
BEFORE DELETE ON journal_identity
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDENTITY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_coordination_intent_insert_guard
BEFORE INSERT ON coordination_intents
WHEN NEW.test_only_prepared <> (
  SELECT test_only_prepared FROM journal_identity WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_PROVENANCE_INVALID');
END;

CREATE TRIGGER trg_coordination_intent_no_update
BEFORE UPDATE ON coordination_intents
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IMMUTABLE');
END;

CREATE TRIGGER trg_coordination_intent_no_delete
BEFORE DELETE ON coordination_intents
BEGIN
  SELECT RAISE(ABORT, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_DELETE_FORBIDDEN');
END;
`;

class SyntheticAuthorityCoordinationIntentError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticAuthorityCoordinationIntentError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticAuthorityCoordinationIntentError(code);
}

function safeErrorCode(error) {
  if (error instanceof SyntheticAuthorityCoordinationIntentError
      && STABLE_ERROR_CODES.has(error.code)) return error.code;
  if (error instanceof authorization.SyntheticAuthorizationLedgerError) {
    return authorization.safeErrorCode(error);
  }
  if (error instanceof externalApproval.SyntheticExternalApprovalError) {
    return externalApproval.safeErrorCode(error);
  }
  return 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECOVERY_INVALID';
}

function canonicalJson(value) {
  return externalApproval.canonicalJson(value);
}

function canonicalHash(value) {
  return authorization.canonicalHash(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value)
    && !/^([0-9a-f])\1{63}$/.test(value);
}

function exactKeys(value, expected, code = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID') {
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

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ARGUMENT_INVALID');
}

function assertEnvironment(environment) {
  if (!environment || typeof environment !== 'object'
      || environment.NODE_ENV !== 'production'
      || environment.DEPLOYMENT_TIER !== 'synthetic') {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_PRODUCTION_RESOURCE_REJECTED');
  }
  if (environment[ACK_ENV] !== ACK) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK_REQUIRED');
  }
  if (!validDigest(environment[JOURNAL_ID_ENV])) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE');
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
    environment.DATA_DIR,
    environment.SQLITE_FILE,
    environment[externalApproval.POLICY_FILE_ENV],
    environment[externalApproval.POLICY_PARENT_ENV],
    environment[authorization.LEDGER_FILE_ENV],
    environment[authorization.LEDGER_PARENT_ENV],
    environment[JOURNAL_FILE_ENV],
    environment[JOURNAL_PARENT_ENV]
  ].filter(value => typeof value === 'string' && value.length >= 6);
}

function decodeCanonicalInput(buffer, environment = process.env) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_STDIN_REQUIRED');
  }
  if (buffer.length > MAX_STDIN_BYTES) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_TOO_LARGE');
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  if (raw.endsWith('\n') && !raw.endsWith('\r\n')) raw = raw.slice(0, -1);
  if (!raw) fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_STDIN_REQUIRED');
  const sensitive = sensitiveValues(environment)
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  if ([...new Set(sensitive)].some(value => raw.includes(value))) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SENSITIVE_INPUT');
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  if (JSON.stringify(document) !== raw) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += input.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      input.fill(0);
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_TOO_LARGE');
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

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
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
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE');
    }
    if (metadata.isSymbolicLink()
        || (!last && !metadata.isDirectory())
        || (last && finalKind === 'directory' && !metadata.isDirectory())
        || (last && finalKind === 'file' && !metadata.isFile())) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
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
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE');
  }
  return canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic-authority-coordination-intent-host-context',
    platform: process.platform,
    architecture: process.arch,
    hostname: os.hostname(),
    username: user.username,
    uid: user.uid,
    gid: user.gid
  });
}

function journalContextSha256(filename, approvedParent, metadata) {
  return canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic-authority-coordination-intent-file-context',
    filenameSha256: sha256(Buffer.from(filename, 'utf8')),
    approvedParentSha256: sha256(Buffer.from(approvedParent, 'utf8')),
    device: String(metadata.dev),
    inode: String(metadata.ino),
    hostContextSha256: hostContextSha256()
  });
}

function pathEntryMetadata(filename, code) {
  try {
    return fs.lstatSync(filename, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail(code);
  }
}

function assertNoSidecars(filename, code = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN') {
  if ([`${filename}-journal`, `${filename}-wal`, `${filename}-shm`]
    .some(candidate => pathEntryMetadata(candidate, code) !== null)) fail(code);
}

function assertNoWalSidecars(filename, code = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN') {
  if ([`${filename}-wal`, `${filename}-shm`]
    .some(candidate => pathEntryMetadata(candidate, code) !== null)) fail(code);
}

function assertSafeDeleteJournal(filename) {
  const metadata = pathEntryMetadata(
    `${filename}-journal`,
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
  );
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.nlink !== 1n || metadata.size > BigInt(MAX_JOURNAL_BYTES)
      || (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600))) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN');
  }
}

function existingPathContext(environment, filename, approvedParent, parentReal) {
  assertNoWalSidecars(filename);
  assertSafeDeleteJournal(filename);
  let metadata;
  let real;
  try {
    metadata = fs.lstatSync(filename, { bigint: true });
    real = realpathSync(filename);
  } catch (_) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
      || metadata.size <= 0n || metadata.size > BigInt(MAX_JOURNAL_BYTES)
      || !samePath(real, filename) || !samePath(path.dirname(real), parentReal)
      || (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600)) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
  }
  return Object.freeze({
    filename,
    approvedParent,
    parentReal,
    exists: true,
    metadata,
    contextSha256: journalContextSha256(filename, approvedParent, metadata)
  });
}

function createPathContext(environment) {
  const filename = environment[JOURNAL_FILE_ENV];
  const approvedParent = environment[JOURNAL_PARENT_ENV];
  const dataRoot = environment.SYNTHETIC_DATA_ROOT;
  const policyParent = environment[externalApproval.POLICY_PARENT_ENV];
  const policyFile = environment[externalApproval.POLICY_FILE_ENV];
  const ledgerParent = environment[authorization.LEDGER_PARENT_ENV];
  const ledgerFile = environment[authorization.LEDGER_FILE_ENV];
  const values = [
    filename, approvedParent, dataRoot, policyParent, policyFile, ledgerParent, ledgerFile
  ];
  if (values.some(value => !isCanonicalAbsolutePath(value)
      || isNetworkOrDevicePath(value))) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
  }
  const projectVolume = path.parse(PROJECT_ROOT).root;
  if (values.some(value => !samePath(path.parse(value).root, projectVolume))
      || path.basename(filename) !== JOURNAL_FILENAME
      || path.dirname(filename) !== approvedParent) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
  }
  assertUnlinkedSegments(approvedParent, 'directory');
  assertUnlinkedSegments(filename, 'file', true);
  assertUnlinkedSegments(dataRoot, 'directory');
  assertUnlinkedSegments(policyParent, 'directory');
  assertUnlinkedSegments(policyFile, 'file');
  assertUnlinkedSegments(ledgerParent, 'directory');
  assertUnlinkedSegments(ledgerFile, 'file');
  let parentMetadata;
  let parentReal;
  let dataRootReal;
  let policyParentReal;
  let policyFileReal;
  let ledgerParentReal;
  let ledgerFileReal;
  try {
    parentMetadata = fs.lstatSync(approvedParent, { bigint: true });
    parentReal = realpathSync(approvedParent);
    dataRootReal = realpathSync(dataRoot);
    policyParentReal = realpathSync(policyParent);
    policyFileReal = realpathSync(policyFile);
    ledgerParentReal = realpathSync(ledgerParent);
    ledgerFileReal = realpathSync(ledgerFile);
  } catch (_) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNAVAILABLE');
  }
  const projectReal = realpathSync(PROJECT_ROOT);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || !samePath(parentReal, approvedParent)
      || !samePath(dataRootReal, dataRoot)
      || !samePath(policyParentReal, policyParent)
      || !samePath(policyFileReal, policyFile)
      || !samePath(ledgerParentReal, ledgerParent)
      || !samePath(ledgerFileReal, ledgerFile)
      || !samePath(path.dirname(policyFileReal), policyParentReal)
      || !samePath(path.dirname(ledgerFileReal), ledgerParentReal)
      || pathsOverlap(projectReal, parentReal)
      || [dataRootReal, policyParentReal, policyFileReal, ledgerParentReal, ledgerFileReal]
        .some(candidate => pathsOverlap(candidate, parentReal))
      || (process.platform !== 'win32' && (Number(parentMetadata.mode) & 0o022) !== 0)) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
  }
  const exists = fs.existsSync(filename);
  if (!exists) {
    assertNoSidecars(filename, 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
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

function createJournalFile(context) {
  let descriptor;
  let createdByThisCall = false;
  let metadata;
  try {
    descriptor = fs.openSync(context.filename, 'wx', 0o600);
    createdByThisCall = true;
    metadata = fs.fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
        || (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600)) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const pathMetadata = fs.lstatSync(context.filename, { bigint: true });
    if (!sameFileIdentity(metadata, pathMetadata)) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
    }
    return Object.freeze({ metadata: pathMetadata });
  } catch (error) {
    let closeUnknown = false;
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { closeUnknown = true; }
      descriptor = undefined;
    }
    if (createdByThisCall) {
      const cleaned = metadata && !closeUnknown
        ? cleanupCreatedJournal(context, metadata)
        : false;
      if (!cleaned) fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN');
    }
    if (error instanceof SyntheticAuthorityCoordinationIntentError) throw error;
    if (error && error.code === 'EEXIST') {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY');
    }
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE');
  }
}

function cleanupCreatedJournal(context, createdMetadata) {
  try {
    assertNoSidecars(context.filename);
    const current = fs.lstatSync(context.filename, { bigint: true });
    if (!sameFileIdentity(current, createdMetadata)) return false;
    fs.unlinkSync(context.filename);
    return pathEntryMetadata(
      context.filename,
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
    ) === null;
  } catch (_) {
    return false;
  }
}

function configureWritableDatabase(db, initializeJournalMode) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const journal = initializeJournalMode
    ? db.prepare('PRAGMA journal_mode = DELETE').get()
    : db.prepare('PRAGMA journal_mode').get();
  if (!journal || String(journal.journal_mode).toLowerCase() !== 'delete') {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID');
  }
  db.exec('PRAGMA synchronous = FULL');
}

function createJournalSchema(db) {
  db.exec(`PRAGMA application_id = ${JOURNAL_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`);
  db.exec(JOURNAL_SCHEMA_SQL);
}

let referenceSchema;
function expectedSchemaRows() {
  if (referenceSchema) return referenceSchema;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    createJournalSchema(db);
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
  if (!application || application.application_id !== JOURNAL_APPLICATION_ID
      || !version || version.user_version !== JOURNAL_SCHEMA_VERSION
      || canonicalJson(actual) !== canonicalJson(expectedSchemaRows())) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID');
  }
}

function validateIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID');
  }
}

function identityRecordShape(value) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic-authority-coordination-intent-journal-identity',
    journalIdSha256: value.journalIdSha256,
    contextSha256: value.contextSha256,
    testOnlyPrepared: value.testOnlyPrepared,
    createdAtObserved: value.createdAtObserved
  };
}

function intentRecordShape(value) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic-authority-coordination-intent-record',
    journalIdSha256: value.journalIdSha256,
    testOnlyPrepared: value.testOnlyPrepared,
    intentIdSha256: value.intentIdSha256,
    requestFingerprintSha256: value.requestFingerprintSha256,
    authorizationConsumptionDocumentSha256: value.authorizationConsumptionDocumentSha256,
    localReceiptSha256: value.localReceiptSha256,
    ledgerIdSha256: value.ledgerIdSha256,
    consumerIdSha256: value.consumerIdSha256,
    targetEnvironmentSha256: value.targetEnvironmentSha256,
    trustPolicyIdSha256: value.trustPolicyIdSha256,
    trustPolicySha256: value.trustPolicySha256,
    trustPolicyRevision: value.trustPolicyRevision,
    revocationCheckpointSequence: value.revocationCheckpointSequence,
    revocationCheckpointSha256: value.revocationCheckpointSha256,
    subjectSha256: value.subjectSha256,
    candidateBindingSha256: value.candidateBindingSha256,
    sourceCommit: value.sourceCommit,
    implementationTreeSha256: value.implementationTreeSha256,
    configurationSha256: value.configurationSha256,
    approvalEnvelopeSha256: value.approvalEnvelopeSha256,
    grantIdSha256: value.grantIdSha256,
    grantEnvelopeSha256: value.grantEnvelopeSha256,
    localConsumedAtObserved: value.localConsumedAtObserved,
    localVerificationValidUntil: value.localVerificationValidUntil,
    preparedAtObserved: value.preparedAtObserved,
    authoritySubmissionStatus: 'locally_prepared_unsubmitted'
  };
}

function intentValueFromRow(identity, row) {
  return {
    journalIdSha256: identity.journal_id_sha256,
    testOnlyPrepared: row.test_only_prepared === 1,
    intentIdSha256: row.intent_id_sha256,
    requestFingerprintSha256: row.request_fingerprint_sha256,
    authorizationConsumptionDocumentSha256:
      row.authorization_consumption_document_sha256,
    localReceiptSha256: row.local_receipt_sha256,
    ledgerIdSha256: row.ledger_id_sha256,
    consumerIdSha256: row.consumer_id_sha256,
    targetEnvironmentSha256: row.target_environment_sha256,
    trustPolicyIdSha256: row.policy_id_sha256,
    trustPolicySha256: row.policy_sha256,
    trustPolicyRevision: row.policy_revision,
    revocationCheckpointSequence: row.checkpoint_sequence,
    revocationCheckpointSha256: row.checkpoint_sha256,
    subjectSha256: row.subject_sha256,
    candidateBindingSha256: row.candidate_binding_sha256,
    sourceCommit: row.source_commit,
    implementationTreeSha256: row.implementation_tree_sha256,
    configurationSha256: row.configuration_sha256,
    approvalEnvelopeSha256: row.approval_envelope_sha256,
    grantIdSha256: row.grant_id_sha256,
    grantEnvelopeSha256: row.grant_envelope_sha256,
    localConsumedAtObserved: row.local_consumed_at_observed,
    localVerificationValidUntil: row.local_verification_valid_until,
    preparedAtObserved: row.prepared_at_observed
  };
}

function validateStoredRecords(db, identity) {
  const rows = db.prepare('SELECT * FROM coordination_intents').all();
  for (const row of rows) {
    const value = intentValueFromRow(identity, row);
    const digestFields = [
      value.journalIdSha256,
      value.intentIdSha256,
      value.requestFingerprintSha256,
      value.authorizationConsumptionDocumentSha256,
      value.localReceiptSha256,
      value.ledgerIdSha256,
      value.consumerIdSha256,
      value.targetEnvironmentSha256,
      value.trustPolicyIdSha256,
      value.trustPolicySha256,
      value.revocationCheckpointSha256,
      value.subjectSha256,
      value.candidateBindingSha256,
      value.implementationTreeSha256,
      value.configurationSha256,
      value.approvalEnvelopeSha256,
      value.grantIdSha256,
      value.grantEnvelopeSha256,
      row.intent_record_sha256
    ];
    const consumedAt = parseCanonicalTimestamp(
      value.localConsumedAtObserved,
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
    );
    const validUntil = parseCanonicalTimestamp(
      value.localVerificationValidUntil,
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
    );
    const preparedAt = parseCanonicalTimestamp(
      value.preparedAtObserved,
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
    );
    if (digestFields.some(item => !validDigest(item))
        || value.journalIdSha256 !== identity.journal_id_sha256
        || row.test_only_prepared !== identity.test_only_prepared
        || !Number.isSafeInteger(value.trustPolicyRevision)
        || value.trustPolicyRevision < 1
        || !Number.isSafeInteger(value.revocationCheckpointSequence)
        || value.revocationCheckpointSequence < 1
        || !COMMIT.test(value.sourceCommit)
        || /^([0-9a-f])\1+$/.test(value.sourceCommit)
        || consumedAt >= validUntil
        || !Number.isFinite(preparedAt)
        || preparedAt < consumedAt
        || row.authority_submission_status !== 'locally_prepared_unsubmitted'
        || canonicalHash(intentRecordShape(value)) !== row.intent_record_sha256) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID');
    }
  }
  return rows;
}

function validateIdentity(db, context, environment, expectedTestOnly) {
  validateSchema(db);
  validateIntegrity(db);
  const identity = db.prepare(
    'SELECT * FROM journal_identity WHERE singleton_id = 1'
  ).get();
  if (!identity
      || db.prepare('SELECT COUNT(*) AS count FROM journal_identity').get().count !== 1
      || identity.schema_version !== 1
      || identity.purpose !== 'synthetic_authority_coordination_intent_journal'
      || identity.journal_id_sha256 !== environment[JOURNAL_ID_ENV]
      || identity.context_sha256 !== context.contextSha256
      || identity.test_only_prepared !== expectedTestOnly) {
    if (identity && identity.test_only_prepared !== expectedTestOnly) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TEST_ONLY_STATE_REJECTED');
    }
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_CONTEXT_MISMATCH');
  }
  if (!Number.isFinite(parseCanonicalTimestamp(
        identity.created_at_observed,
        'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
      ))
      || !validDigest(identity.identity_record_sha256)
      || canonicalHash(identityRecordShape({
        journalIdSha256: identity.journal_id_sha256,
        contextSha256: identity.context_sha256,
        testOnlyPrepared: identity.test_only_prepared === 1,
        createdAtObserved: identity.created_at_observed
      })) !== identity.identity_record_sha256) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID');
  }
  validateStoredRecords(db, identity);
  return Object.freeze({ ...identity });
}

function normalizeInput(document) {
  exactKeys(document, [
    'schemaVersion', 'purpose', 'requestId', 'authorizationConsumptionDocument'
  ]);
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_authority_coordination_intent_prepare'
      || typeof document.requestId !== 'string'
      || !REQUEST_ID.test(document.requestId)) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  exactKeys(document.authorizationConsumptionDocument, [
    'schemaVersion', 'purpose', 'requestId', 'verificationDocument'
  ]);
  if (document.authorizationConsumptionDocument.schemaVersion !== 1
      || document.authorizationConsumptionDocument.purpose
        !== 'synthetic_local_grant_compare_and_consume') {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  return Object.freeze({
    intentIdSha256: sha256(Buffer.from(document.requestId, 'utf8')),
    requestFingerprintSha256: canonicalHash(document),
    authorizationConsumptionDocumentSha256:
      canonicalHash(document.authorizationConsumptionDocument),
    authorizationConsumptionDocument: document.authorizationConsumptionDocument
  });
}

function normalizeRecoveredReceipt(result, testOnly) {
  const code = 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECOVERY_INVALID';
  exactKeys(result, [
    'schemaVersion', 'profile', 'result', 'outcome', 'receiptSha256',
    'ledgerIdSha256', 'consumerIdSha256', 'targetEnvironmentSha256',
    'trustPolicyIdSha256', 'trustPolicySha256', 'trustPolicyRevision',
    'revocationCheckpointSequence', 'revocationCheckpointSha256',
    'subjectSha256', 'candidateBindingSha256', 'sourceCommit',
    'implementationTreeSha256', 'configurationSha256',
    'approvalEnvelopeSha256', 'grantIdSha256', 'grantEnvelopeSha256',
    'consumedAtObserved', 'verificationValidUntil', 'checks', 'operations',
    'deploymentGrantStatus', 'deploymentAuthorization',
    'productionChildGateState', 'childUseAuthorization'
  ], code);
  exactKeys(result.checks, [
    'testOnlyOverridesUsed', 'historicalReceiptRecovered',
    'historicalFinalRevocationCheckedAtConsumption',
    'currentLedgerHeadRevalidatedForThisCall',
    'externalApprovalRevalidatedForNewConsumption',
    'checkpointMonotonicAgainstThisLedgerInstance',
    'checkpointRevocationSetsCumulative',
    'finalRevocationCheckedAgainstLocalLedgerHead', 'consumerDigestMatched',
    'grantCompareAndConsumeAtomicLocallyForThisCall',
    'grantSingleUseRecordCommitted',
    'trustPolicyExternallyAuthorizedByThisCommand', 'trustedTimeVerified',
    'latestCheckpointExternallyConfirmed', 'rollbackResistanceExternallyAnchored',
    'consumerIdentityExternallyAuthenticatedByThisCommand',
    'externalDeploymentAtomicityVerified', 'globalConsumptionVerified'
  ], code);
  exactKeys(result.operations, [
    'localAuthorizationLedgerWritten', 'syntheticDatabaseWritten',
    'networkAccessPerformed', 'deploymentPerformed', 'productionDataRead',
    'productionChildGateChanged'
  ], code);
  const digests = [
    result.receiptSha256,
    result.ledgerIdSha256,
    result.consumerIdSha256,
    result.targetEnvironmentSha256,
    result.trustPolicyIdSha256,
    result.trustPolicySha256,
    result.revocationCheckpointSha256,
    result.subjectSha256,
    result.candidateBindingSha256,
    result.implementationTreeSha256,
    result.configurationSha256,
    result.approvalEnvelopeSha256,
    result.grantIdSha256,
    result.grantEnvelopeSha256
  ];
  const consumedAt = parseCanonicalTimestamp(result.consumedAtObserved, code);
  const validUntil = parseCanonicalTimestamp(result.verificationValidUntil, code);
  if (result.schemaVersion !== 1
      || result.profile !== 'synthetic-local-authorization-ledger-consumption'
      || result.result !== 'local-single-use-record-replayed'
      || result.outcome !== 'replayed'
      || digests.some(value => !validDigest(value))
      || !Number.isSafeInteger(result.trustPolicyRevision)
      || result.trustPolicyRevision < 1
      || !Number.isSafeInteger(result.revocationCheckpointSequence)
      || result.revocationCheckpointSequence < 1
      || !COMMIT.test(result.sourceCommit)
      || /^([0-9a-f])\1+$/.test(result.sourceCommit)
      || consumedAt >= validUntil
      || result.checks.testOnlyOverridesUsed !== testOnly
      || result.checks.historicalReceiptRecovered !== true
      || result.checks.historicalFinalRevocationCheckedAtConsumption !== true
      || result.checks.currentLedgerHeadRevalidatedForThisCall !== false
      || result.checks.externalApprovalRevalidatedForNewConsumption !== false
      || result.checks.checkpointMonotonicAgainstThisLedgerInstance !== true
      || result.checks.checkpointRevocationSetsCumulative !== true
      || result.checks.finalRevocationCheckedAgainstLocalLedgerHead !== false
      || result.checks.consumerDigestMatched !== true
      || result.checks.grantCompareAndConsumeAtomicLocallyForThisCall !== false
      || result.checks.grantSingleUseRecordCommitted !== true
      || result.checks.trustPolicyExternallyAuthorizedByThisCommand !== false
      || result.checks.trustedTimeVerified !== false
      || result.checks.latestCheckpointExternallyConfirmed !== false
      || result.checks.rollbackResistanceExternallyAnchored !== false
      || result.checks.consumerIdentityExternallyAuthenticatedByThisCommand !== false
      || result.checks.externalDeploymentAtomicityVerified !== false
      || result.checks.globalConsumptionVerified !== false
      || Object.values(result.operations).some(value => value !== false)
      || result.deploymentGrantStatus !== 'historical_local_single_use_record_replayed'
      || result.deploymentAuthorization !== 'not_granted'
      || result.productionChildGateState !== 'not_observed'
      || result.childUseAuthorization !== 'not_granted') {
    fail(code);
  }
  return Object.freeze({ ...result });
}

function recoverReceipt(environment, document, testOnly) {
  const recover = testOnly
    ? authorization.recoverSyntheticAuthorizationReceiptForTest
    : authorization.recoverSyntheticAuthorizationReceipt;
  if (typeof recover !== 'function') {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECOVERY_INVALID');
  }
  return normalizeRecoveredReceipt(recover(environment, document), testOnly);
}

function insertIdentity(db, context, environment, testOnly, observedAt) {
  const value = {
    journalIdSha256: environment[JOURNAL_ID_ENV],
    contextSha256: context.contextSha256,
    testOnlyPrepared: testOnly,
    createdAtObserved: observedAt
  };
  db.prepare(`
    INSERT INTO journal_identity(
      singleton_id, schema_version, purpose, journal_id_sha256,
      context_sha256, test_only_prepared, created_at_observed,
      identity_record_sha256
    ) VALUES (
      1, 1, 'synthetic_authority_coordination_intent_journal', ?, ?, ?, ?, ?
    )
  `).run(
    value.journalIdSha256,
    value.contextSha256,
    value.testOnlyPrepared ? 1 : 0,
    value.createdAtObserved,
    canonicalHash(identityRecordShape(value))
  );
}

function conflictCode(db, receipt) {
  if (db.prepare('SELECT 1 FROM coordination_intents WHERE local_receipt_sha256 = ?')
    .get(receipt.receiptSha256)) {
    return 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECEIPT_ALREADY_PREPARED';
  }
  if (db.prepare(`
    SELECT 1 FROM coordination_intents
    WHERE grant_id_sha256 = ? OR grant_envelope_sha256 = ?
  `).get(receipt.grantIdSha256, receipt.grantEnvelopeSha256)) {
    return 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_GRANT_ALREADY_PREPARED';
  }
  if (db.prepare('SELECT 1 FROM coordination_intents WHERE approval_envelope_sha256 = ?')
    .get(receipt.approvalEnvelopeSha256)) {
    return 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVAL_ALREADY_PREPARED';
  }
  if (db.prepare(`
    SELECT 1 FROM coordination_intents
    WHERE target_environment_sha256 = ? AND source_commit = ?
      AND implementation_tree_sha256 = ? AND configuration_sha256 = ?
  `).get(
    receipt.targetEnvironmentSha256,
    receipt.sourceCommit,
    receipt.implementationTreeSha256,
    receipt.configurationSha256
  )) return 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TARGET_ALREADY_PREPARED';
  return null;
}

function insertIntent(db, identity, input, receipt, preparedAtObserved) {
  const value = {
    journalIdSha256: identity.journal_id_sha256,
    testOnlyPrepared: identity.test_only_prepared === 1,
    intentIdSha256: input.intentIdSha256,
    requestFingerprintSha256: input.requestFingerprintSha256,
    authorizationConsumptionDocumentSha256:
      input.authorizationConsumptionDocumentSha256,
    localReceiptSha256: receipt.receiptSha256,
    ledgerIdSha256: receipt.ledgerIdSha256,
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
    localConsumedAtObserved: receipt.consumedAtObserved,
    localVerificationValidUntil: receipt.verificationValidUntil,
    preparedAtObserved
  };
  const recordSha256 = canonicalHash(intentRecordShape(value));
  db.prepare(`
    INSERT INTO coordination_intents(
      intent_id_sha256, request_fingerprint_sha256,
      authorization_consumption_document_sha256, local_receipt_sha256,
      ledger_id_sha256, consumer_id_sha256, target_environment_sha256,
      policy_id_sha256, policy_sha256, policy_revision,
      checkpoint_sequence, checkpoint_sha256,
      subject_sha256, candidate_binding_sha256, source_commit,
      implementation_tree_sha256, configuration_sha256,
      approval_envelope_sha256, grant_id_sha256, grant_envelope_sha256,
      local_consumed_at_observed, local_verification_valid_until,
      prepared_at_observed, authority_submission_status,
      test_only_prepared, intent_record_sha256
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'locally_prepared_unsubmitted', ?, ?
    )
  `).run(
    value.intentIdSha256,
    value.requestFingerprintSha256,
    value.authorizationConsumptionDocumentSha256,
    value.localReceiptSha256,
    value.ledgerIdSha256,
    value.consumerIdSha256,
    value.targetEnvironmentSha256,
    value.trustPolicyIdSha256,
    value.trustPolicySha256,
    value.trustPolicyRevision,
    value.revocationCheckpointSequence,
    value.revocationCheckpointSha256,
    value.subjectSha256,
    value.candidateBindingSha256,
    value.sourceCommit,
    value.implementationTreeSha256,
    value.configurationSha256,
    value.approvalEnvelopeSha256,
    value.grantIdSha256,
    value.grantEnvelopeSha256,
    value.localConsumedAtObserved,
    value.localVerificationValidUntil,
    value.preparedAtObserved,
    value.testOnlyPrepared ? 1 : 0,
    recordSha256
  );
  return db.prepare('SELECT * FROM coordination_intents WHERE intent_id_sha256 = ?')
    .get(value.intentIdSha256);
}

function outputFor(identity, row, outcome) {
  const value = intentValueFromRow(identity, row);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-authority-coordination-intent',
    result: 'locally_prepared_unsubmitted',
    outcome,
    authorityCoordinationStatus: 'locally_prepared_unsubmitted',
    journalIdSha256: value.journalIdSha256,
    intentIdSha256: value.intentIdSha256,
    intentRecordSha256: row.intent_record_sha256,
    requestFingerprintSha256: value.requestFingerprintSha256,
    authorizationConsumptionDocumentSha256:
      value.authorizationConsumptionDocumentSha256,
    localReceiptSha256: value.localReceiptSha256,
    ledgerIdSha256: value.ledgerIdSha256,
    consumerIdSha256: value.consumerIdSha256,
    targetEnvironmentSha256: value.targetEnvironmentSha256,
    trustPolicyIdSha256: value.trustPolicyIdSha256,
    trustPolicySha256: value.trustPolicySha256,
    trustPolicyRevision: value.trustPolicyRevision,
    revocationCheckpointSequence: value.revocationCheckpointSequence,
    revocationCheckpointSha256: value.revocationCheckpointSha256,
    subjectSha256: value.subjectSha256,
    candidateBindingSha256: value.candidateBindingSha256,
    sourceCommit: value.sourceCommit,
    implementationTreeSha256: value.implementationTreeSha256,
    configurationSha256: value.configurationSha256,
    approvalEnvelopeSha256: value.approvalEnvelopeSha256,
    grantIdSha256: value.grantIdSha256,
    grantEnvelopeSha256: value.grantEnvelopeSha256,
    localConsumedAtObserved: value.localConsumedAtObserved,
    localVerificationValidUntil: value.localVerificationValidUntil,
    preparedAtObserved: value.preparedAtObserved,
    checks: Object.freeze({
      testOnlyOverridesUsed: value.testOnlyPrepared,
      historicalLocalAuthorizationReceiptBoundAtPreparation: true,
      historicalIntentRecovered: outcome === 'replayed',
      localReceiptRecoveryPerformedForThisCall: outcome === 'prepared',
      rawAuthorizationMaterialExcluded: true,
      journalIdentityBoundToSingleLedger: false,
      crossLedgerUniquenessOnlyWithinThisJournal: true,
      localClockMonotonicWithinThisJournal: true,
      currentExternalApprovalRevalidatedByThisCommand: false,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      externalRoleIdentitiesAuthenticatedByThisCommand: false,
      externalEvidenceRetrievedByThisCommand: false,
      externalAuditRecordRetrievedByThisCommand: false,
      trustedTimeVerified: false,
      latestCheckpointExternallyConfirmed: false,
      externalRollbackAnchorVerified: false,
      globalConsumptionVerified: false,
      externalAuthorityReceiptVerified: false,
      deploymentReceiptVerified: false,
      externalDeploymentAtomicityVerified: false,
      externalFactsVerified: false
    }),
    operations: Object.freeze({
      coordinationIntentRowInserted: outcome === 'prepared',
      localIntentJournalOpenedWritable: true,
      s17AuthorizationLedgerWritten: false,
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      externalSubmissionPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function currentDate(options) {
  const source = options.now instanceof Date ? options.now : new Date();
  const value = new Date(source);
  if (!Number.isFinite(value.getTime())) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID');
  }
  return value;
}

function preparationObservedAt(db, receipt, options) {
  const observed = currentDate(options);
  const consumedAt = parseCanonicalTimestamp(
    receipt.consumedAtObserved,
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECOVERY_INVALID'
  );
  const latestPreparedAt = db.prepare(`
    SELECT prepared_at_observed FROM coordination_intents
  `).all().reduce((latest, row) => Math.max(
    latest,
    parseCanonicalTimestamp(
      row.prepared_at_observed,
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
    )
  ), Number.NEGATIVE_INFINITY);
  if (observed.getTime() < consumedAt || observed.getTime() < latestPreparedAt) {
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_LOCAL_CLOCK_ROLLBACK');
  }
  return observed.toISOString();
}

function callFault(options, stage) {
  if (options && typeof options.fault === 'function') options.fault(stage);
}

function prepareInternal(environment, document, options) {
  assertEnvironment(environment);
  const input = normalizeInput(document);
  const initialContext = createPathContext(environment);
  const expectedTestOnly = options.testOnly === true ? 1 : 0;
  let prefetchedReceipt;
  let created;
  let context = initialContext;
  let before;
  let db;
  let transactionOpen = false;
  let committed = false;
  let cleaned = false;
  let conservativeResultUnknown = false;
  try {
    if (!initialContext.exists) {
      prefetchedReceipt = recoverReceipt(
        environment,
        input.authorizationConsumptionDocument,
        options.testOnly === true
      );
      callFault(options, 'after_receipt_recovery');
      created = createJournalFile(initialContext);
      context = Object.freeze({
        filename: initialContext.filename,
        approvedParent: initialContext.approvedParent,
        parentReal: initialContext.parentReal,
        exists: true,
        metadata: created.metadata,
        contextSha256: journalContextSha256(
          initialContext.filename,
          initialContext.approvedParent,
          created.metadata
        )
      });
    }
    before = fs.lstatSync(context.filename, { bigint: true });
    db = new DatabaseSync(context.filename);
    configureWritableDatabase(db, Boolean(created));
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    callFault(options, 'after_begin');
    let identity;
    if (created) {
      createJournalSchema(db);
      const observedAt = currentDate(options).toISOString();
      insertIdentity(db, context, environment, options.testOnly === true, observedAt);
      identity = validateIdentity(db, context, environment, expectedTestOnly);
    } else {
      identity = validateIdentity(db, context, environment, expectedTestOnly);
    }
    const historical = db.prepare(
      'SELECT * FROM coordination_intents WHERE intent_id_sha256 = ?'
    ).get(input.intentIdSha256);
    if (historical) {
      if (historical.request_fingerprint_sha256 !== input.requestFingerprintSha256) {
        fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDEMPOTENCY_CONFLICT');
      }
      db.exec('COMMIT');
      transactionOpen = false;
      return outputFor(identity, historical, 'replayed');
    }
    const receipt = prefetchedReceipt || recoverReceipt(
      environment,
      input.authorizationConsumptionDocument,
      options.testOnly === true
    );
    if (!prefetchedReceipt) callFault(options, 'after_receipt_recovery');
    const conflict = conflictCode(db, receipt);
    if (conflict) fail(conflict);
    const preparedAtObserved = preparationObservedAt(db, receipt, options);
    callFault(options, 'before_intent_insert');
    const row = insertIntent(db, identity, input, receipt, preparedAtObserved);
    callFault(options, 'after_intent_insert');
    validateStoredRecords(db, identity);
    callFault(options, 'before_commit');
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    callFault(options, 'after_commit');
    return outputFor(identity, row, 'prepared');
  } catch (error) {
    if (error instanceof SyntheticAuthorityCoordinationIntentError
        && error.code === 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN') {
      conservativeResultUnknown = true;
    }
    let rollbackUnknown = false;
    if (transactionOpen && db) {
      try { db.exec('ROLLBACK'); } catch (_) { rollbackUnknown = true; }
    }
    if (db) {
      try { db.close(); } catch (_) { rollbackUnknown = true; }
      db = undefined;
    }
    if (!committed && created && !rollbackUnknown) {
      cleaned = cleanupCreatedJournal(initialContext, created.metadata);
      if (!cleaned) rollbackUnknown = true;
    }
    if (rollbackUnknown || committed) {
      conservativeResultUnknown = true;
    }
    if (conservativeResultUnknown) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN');
    }
    if (error instanceof SyntheticAuthorityCoordinationIntentError
        || error instanceof authorization.SyntheticAuthorizationLedgerError
        || error instanceof externalApproval.SyntheticExternalApprovalError) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY');
    }
    fail('SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TRANSACTION_FAILED');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (!conservativeResultUnknown && !cleaned && before) {
      let after;
      try {
        after = fs.lstatSync(context.filename, { bigint: true });
      } catch (_) {
        fail(committed
          ? 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
          : 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_CONTEXT_MISMATCH');
      }
      if (!sameFileIdentity(before, after)
          || after.size <= 0n || after.size > BigInt(MAX_JOURNAL_BYTES)) {
        fail(committed
          ? 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
          : 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_CONTEXT_MISMATCH');
      }
      assertNoWalSidecars(context.filename);
    }
  }
}

function prepareSyntheticAuthorityCoordinationIntent(environment, document) {
  return prepareInternal(environment, document, {});
}

function prepareSyntheticAuthorityCoordinationIntentForTest(
  environment,
  document,
  options = {}
) {
  return prepareInternal(environment, document, { ...options, testOnly: true });
}

function usage() {
  return [
    'Usage: node scripts/prepare-synthetic-authority-coordination-intent.js',
    '',
    `Requires ${ACK_ENV}=${ACK}.`,
    `Requires ${JOURNAL_FILE_ENV}, ${JOURNAL_PARENT_ENV} and ${JOURNAL_ID_ENV}.`,
    'Recovers one exact historical S17 receipt and writes only a local digest intent journal.',
    'The result is locally_prepared_unsubmitted. It does not contact an external authority,',
    'trust local time, verify global consumption, access the network, deploy or grant child use.'
  ].join('\n');
}

async function runCli(
  argv = process.argv.slice(2),
  environment = process.env,
  stream = process.stdin
) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const buffer = await readStdin(stream);
    try {
      const document = decodeCanonicalInput(buffer, environment);
      const output = prepareSyntheticAuthorityCoordinationIntent(environment, document);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } finally {
      buffer.fill(0);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `Synthetic authority coordination intent preparation failed (${safeErrorCode(error)}).\n`
    );
    return 1;
  }
}

module.exports = {
  ACK,
  ACK_ENV,
  BUSY_TIMEOUT_MS,
  JOURNAL_APPLICATION_ID,
  JOURNAL_FILE_ENV,
  JOURNAL_FILENAME,
  JOURNAL_ID_ENV,
  JOURNAL_PARENT_ENV,
  JOURNAL_SCHEMA_VERSION,
  MAX_JOURNAL_BYTES,
  MAX_STDIN_BYTES,
  SyntheticAuthorityCoordinationIntentError,
  canonicalHash,
  decodeCanonicalInput,
  parseArguments,
  prepareSyntheticAuthorityCoordinationIntent,
  prepareSyntheticAuthorityCoordinationIntentForTest,
  readStdin,
  runCli,
  safeErrorCode,
  usage
};
