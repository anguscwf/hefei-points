const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const deploymentProfile = require('../../server/config/deployment-profile');
const runtimeFilesystem = require('../../server/config/synthetic-runtime-filesystem');
const {
  applyMigrations,
  applyMigrationsInCurrentTransaction,
  appliedMigrations,
  migrationFiles,
  tableExists
} = require('../../server/db/migrations');
const { hashPwd, verifyPwd } = require('../../server/lib/password');
const {
  LEGAL_TEXT_PATH_SLUGS,
  LEGAL_TEXT_TYPES,
  SHA256,
  VERSION
} = require('../../server/config/guardian-consent');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BOOTSTRAP_ACK_ENV = 'SYNTHETIC_BOOTSTRAP_ACK';
const BOOTSTRAP_ACK = 'initialize-new-synthetic-database-v1';
const CREDENTIAL_PURPOSE = 'synthetic-only-never-production-v1';
const MAX_STDIN_BYTES = 16 * 1024;
const ADMINISTRATOR_NAME = '合成管理员';
const SYNTHETIC_FAMILY_NAME = '合成默认家庭';
const RECEIPT_TABLE = 'synthetic_bootstrap_receipts';
const BOOTSTRAP_LOCK_FILENAME = path.basename(
  runtimeFilesystem.BOOTSTRAP_LOCK_RELATIVE_PATH
);
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));
const EXPECTED_TABLES = Object.freeze([
  'audit_events',
  'child_privacy_states',
  'data_deletion_jobs',
  'data_rights_requests',
  'device_bindings',
  'device_session_challenges',
  'device_sessions',
  'families',
  'guardian_consents',
  'legal_text_versions',
  'pairing_challenges',
  'pairing_claim_attempt_windows',
  'point_accounts',
  'point_request_events',
  'point_requests',
  'reauth_assertions',
  'rule_versions',
  'rule_versions_v25_archive',
  'rules',
  'rules_v25_archive',
  'schema_migrations',
  RECEIPT_TABLE,
  'transaction_rule_links_v25_archive',
  'transactions',
  'users',
  'v2_idempotency_records'
]);
const STABLE_ERROR_CODES = new Set([
  'ARGUMENT_INVALID',
  'STDIN_REQUIRED',
  'STDIN_TOO_LARGE',
  'BOOTSTRAP_ACK_REQUIRED',
  'BOOTSTRAP_SECRET_CHANNEL_INVALID',
  'BOOTSTRAP_INPUT_INVALID',
  'BOOTSTRAP_DATABASE_UNSAFE',
  'BOOTSTRAP_SCHEMA_INVALID',
  'BOOTSTRAP_DATABASE_NOT_EMPTY',
  'BOOTSTRAP_BUSY',
  'BOOTSTRAP_CONFLICT',
  'BOOTSTRAP_STATE_INVALID',
  'BOOTSTRAP_TRANSACTION_FAILED',
  'BOOTSTRAP_RESULT_UNKNOWN',
  'BOOTSTRAP_VERIFICATION_FAILED',
  'BOOTSTRAP_FAILED',
  'SYNTHETIC_ACK_REQUIRED',
  'SYNTHETIC_CONFIG_INVALID',
  'SYNTHETIC_DATA_ROOT_UNSAFE',
  'SYNTHETIC_FEATURE_GATES_INVALID',
  'SYNTHETIC_LEGAL_SOURCE_INVALID',
  'SYNTHETIC_MODE_REQUIRED',
  'SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN',
  'SYNTHETIC_PROXY_POLICY_INVALID'
]);

class SyntheticBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticBootstrapError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticBootstrapError(code);
}

function safeErrorCode(error, fallback = 'BOOTSTRAP_FAILED') {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return STABLE_ERROR_CODES.has(code) ? code : fallback;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('ARGUMENT_INVALID');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function waitForLock() {
  Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS);
}

function releaseBootstrapLock(lock) {
  if (!lock || !Number.isInteger(lock.descriptor)) fail('BOOTSTRAP_RESULT_UNKNOWN');
  let descriptorMetadata;
  let pathMetadata;
  try {
    descriptorMetadata = fs.fstatSync(lock.descriptor, { bigint: true });
    pathMetadata = fs.lstatSync(lock.filename, { bigint: true });
    if (!descriptorMetadata.isFile() || descriptorMetadata.isSymbolicLink()
        || descriptorMetadata.nlink !== 1n || !pathMetadata.isFile()
        || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1n
        || !sameFileIdentity(descriptorMetadata, pathMetadata)) {
      fail('BOOTSTRAP_RESULT_UNKNOWN');
    }
    fs.closeSync(lock.descriptor);
    lock.descriptor = -1;
    fs.unlinkSync(lock.filename);
  } catch (error) {
    if (lock.descriptor >= 0) {
      try { fs.closeSync(lock.descriptor); } catch (_) {}
      lock.descriptor = -1;
    }
    if (error instanceof SyntheticBootstrapError) throw error;
    fail('BOOTSTRAP_RESULT_UNKNOWN');
  }
}

function acquireBootstrapLock(environment, {
  projectRoot = PROJECT_ROOT,
  lockTimeoutMs = LOCK_TIMEOUT_MS
} = {}) {
  const deployment = deploymentProfile.validateSyntheticDeployment(environment, { projectRoot });
  const filename = path.join(deployment.dataPaths.dataDir, BOOTSTRAP_LOCK_FILENAME);
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    let existing;
    try {
      existing = fs.lstatSync(filename, { bigint: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') fail('SYNTHETIC_DATA_ROOT_UNSAFE');
    }
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n) {
        fail('SYNTHETIC_DATA_ROOT_UNSAFE');
      }
      if (Date.now() >= deadline) fail('BOOTSTRAP_BUSY');
      waitForLock();
      continue;
    }

    // The first contender validates the full physical root before creating the
    // coordination artifact. Later contenders observe that regular file and
    // wait without racing WAL/SHM inspection.
    runtimeFilesystem.validateSyntheticRuntimeFilesystem(deployment, projectRoot);
    let descriptor;
    try {
      descriptor = fs.openSync(filename, 'wx', 0o600);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        if (Date.now() >= deadline) fail('BOOTSTRAP_BUSY');
        waitForLock();
        continue;
      }
      fail('SYNTHETIC_DATA_ROOT_UNSAFE');
    }
    const lock = { descriptor, filename };
    try {
      const metadata = fs.fstatSync(descriptor, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
        fail('SYNTHETIC_DATA_ROOT_UNSAFE');
      }
      if (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== 0o600) {
        fail('SYNTHETIC_DATA_ROOT_UNSAFE');
      }
      fs.fsyncSync(descriptor);
      runtimeFilesystem.validateSyntheticRuntimeFilesystem(deployment, projectRoot);
      return lock;
    } catch (error) {
      try { releaseBootstrapLock(lock); } catch (_) {}
      if (error instanceof SyntheticBootstrapError) throw error;
      fail('SYNTHETIC_DATA_ROOT_UNSAFE');
    }
  }
}

function canonicalHash(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
}

function canonicalTimestamp(value, now) {
  if (typeof value !== 'string') fail('BOOTSTRAP_INPUT_INVALID');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value || epoch > now.getTime()) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  return value;
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 24 || value.length > 128
      || !/^[\x21-\x7e]+$/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter(pattern => pattern.test(value)).length;
  return classes >= 3;
}

function repeatedDigest(value) {
  return /^([0-9a-f])\1{63}$/.test(value);
}

function decodeCanonicalInput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail('STDIN_REQUIRED');
  if (buffer.length > MAX_STDIN_BYTES) fail('STDIN_TOO_LARGE');
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  if (raw.endsWith('\r\n')) raw = raw.slice(0, -2);
  else if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (!raw) fail('STDIN_REQUIRED');
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  // This rejects insignificant whitespace, duplicate keys, trailing data and
  // alternative encodings that could make an audit replay ambiguous.
  if (JSON.stringify(document) !== raw) fail('BOOTSTRAP_INPUT_INVALID');
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      value.fill(0);
      fail('STDIN_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function createContext(environment, { projectRoot = PROJECT_ROOT } = {}) {
  if (!environment || typeof environment !== 'object') fail('SYNTHETIC_CONFIG_INVALID');
  const deployment = deploymentProfile.validateSyntheticDeployment(environment, { projectRoot });
  if (environment[BOOTSTRAP_ACK_ENV] !== BOOTSTRAP_ACK) fail('BOOTSTRAP_ACK_REQUIRED');
  if (typeof environment.SYNTHETIC_BOOTSTRAP_PASSWORD === 'string') {
    fail('BOOTSTRAP_SECRET_CHANNEL_INVALID');
  }
  const filesystem = runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    deployment,
    projectRoot
  );
  const deploymentFingerprintSha256 = canonicalHash({
    schemaVersion: 1,
    deploymentTier: deployment.deploymentTier,
    datasetIdSha256: sha256(deployment.datasetId),
    apiOriginSha256: sha256(deployment.apiOrigin),
    wechatAppIdSha256: sha256(deployment.wechatAppId),
    markerSha256: filesystem.markerSha256,
    proxyMode: deployment.proxyPolicy.mode,
    trustedProxyCount: deployment.proxyPolicy.trustedProxyCount,
    legalOriginSha256: sha256(deployment.legalSource.legalOrigin),
    coreFeatureGatesEnabled: deployment.coreFeatureGatesEnabled,
    closedFeatureGatesDisabled: deployment.closedFeatureGatesDisabled
  });
  return Object.freeze({
    deployment,
    filesystem,
    projectRoot,
    deploymentFingerprintSha256
  });
}

function normalizeInput(document, context, now = new Date()) {
  exactKeys(document, [
    'schemaVersion',
    'requestId',
    'datasetId',
    'approvalReference',
    'administrator',
    'legalEvidence'
  ]);
  if (document.schemaVersion !== 1
      || document.datasetId !== context.deployment.datasetId
      || typeof document.requestId !== 'string'
      || !/^synthetic-bootstrap-[a-z0-9][a-z0-9_-]{15,78}$/.test(document.requestId)
      || typeof document.approvalReference !== 'string'
      || !/^synthetic-approval-[a-z0-9][a-z0-9_-]{5,78}$/.test(document.approvalReference)) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  exactKeys(document.administrator, ['id', 'password', 'credentialPurpose']);
  if (typeof document.administrator.id !== 'string'
      || !/^synthetic_admin_[a-z0-9][a-z0-9_-]{5,47}$/.test(document.administrator.id)
      || document.administrator.credentialPurpose !== CREDENTIAL_PURPOSE
      || !validPassword(document.administrator.password)
      || document.administrator.password.toLowerCase().includes(
        document.administrator.id.toLowerCase()
      )) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  exactKeys(document.legalEvidence, ['effectiveAt', 'texts']);
  const effectiveAt = canonicalTimestamp(document.legalEvidence.effectiveAt, now);
  if (!Array.isArray(document.legalEvidence.texts)
      || document.legalEvidence.texts.length !== LEGAL_TEXT_TYPES.length) {
    fail('BOOTSTRAP_INPUT_INVALID');
  }
  const byType = new Map();
  for (const text of document.legalEvidence.texts) {
    exactKeys(text, ['type', 'version', 'contentSha256']);
    if (!LEGAL_TEXT_TYPES.includes(text.type) || byType.has(text.type)
        || typeof text.version !== 'string' || !text.version.startsWith('synthetic-')
        || !VERSION.test(text.version) || !SHA256.test(text.contentSha256)
        || repeatedDigest(text.contentSha256)) {
      fail('BOOTSTRAP_INPUT_INVALID');
    }
    byType.set(text.type, text);
  }
  const relation = context.deployment.legalSource;
  if (repeatedDigest(relation.sha256)) fail('BOOTSTRAP_INPUT_INVALID');
  const texts = LEGAL_TEXT_TYPES.map(type => {
    const input = byType.get(type);
    const publicUrl = `${context.deployment.apiOrigin}/legal/`
      + `${LEGAL_TEXT_PATH_SLUGS[type]}/${input.version}/${input.contentSha256}.html`;
    return Object.freeze({
      type,
      version: input.version,
      contentSha256: input.contentSha256,
      publicUrl,
      effectiveAt
    });
  });
  const canonical = Object.freeze({
    schemaVersion: 1,
    requestId: document.requestId,
    datasetId: document.datasetId,
    approvalReference: document.approvalReference,
    administrator: Object.freeze({
      id: document.administrator.id,
      name: ADMINISTRATOR_NAME,
      password: document.administrator.password,
      credentialPurpose: CREDENTIAL_PURPOSE
    }),
    legalEvidence: Object.freeze({ effectiveAt, texts }),
    relationDeclaration: Object.freeze({
      version: relation.version,
      contentSha256: relation.sha256,
      publicUrl: relation.publicUrl
    })
  });
  const fingerprintPayload = {
    schemaVersion: canonical.schemaVersion,
    requestId: canonical.requestId,
    datasetId: canonical.datasetId,
    approvalReference: canonical.approvalReference,
    administrator: {
      id: canonical.administrator.id,
      name: canonical.administrator.name,
      familyId: 'default',
      role: 'admin',
      credentialPurpose: canonical.administrator.credentialPurpose,
      credentialMethod: 'scrypt-v1'
    },
    legalEvidence: canonical.legalEvidence,
    relationDeclaration: canonical.relationDeclaration
  };
  return Object.freeze({
    ...canonical,
    requestIdSha256: sha256(canonical.requestId),
    requestFingerprintSha256: canonicalHash(fingerprintPayload),
    datasetIdSha256: sha256(canonical.datasetId),
    approvalReferenceSha256: sha256(canonical.approvalReference),
    administratorIdSha256: sha256(canonical.administrator.id),
    legalEvidenceSha256: canonicalHash({
      texts: canonical.legalEvidence.texts,
      relationDeclaration: canonical.relationDeclaration
    })
  });
}

function schemaRows(db) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map(row => ({ ...row }));
}

function schemaFingerprint(db) {
  return canonicalHash(schemaRows(db));
}

let cachedReferenceSchemaFingerprint;
function referenceSchemaFingerprint() {
  if (cachedReferenceSchemaFingerprint) return cachedReferenceSchemaFingerprint;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrations(db);
    cachedReferenceSchemaFingerprint = schemaFingerprint(db);
    return cachedReferenceSchemaFingerprint;
  } finally {
    db.close();
  }
}

function applicationTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count);
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSchemaCurrent(db) {
  if (!exactArray(applicationTables(db), EXPECTED_TABLES)
      || !exactArray(appliedMigrations(db), migrationFiles())
      || schemaFingerprint(db) !== referenceSchemaFingerprint()) {
    fail('BOOTSTRAP_SCHEMA_INVALID');
  }
}

function assertEmptyBaseline(db) {
  assertSchemaCurrent(db);
  const family = db.prepare(`
    SELECT id, name, invite_code, invite_json, created_at FROM families
  `).get();
  if (count(db, 'families') !== 1 || !family || family.id !== 'default'
      || family.name !== '默认家庭' || family.invite_code !== null
      || family.invite_json !== null || typeof family.created_at !== 'string'
      || !family.created_at) {
    fail('BOOTSTRAP_DATABASE_NOT_EMPTY');
  }
  for (const table of EXPECTED_TABLES) {
    if (table === 'schema_migrations' || table === 'families') continue;
    if (count(db, table) !== 0) fail('BOOTSTRAP_DATABASE_NOT_EMPTY');
  }
}

function legalRows(db) {
  return db.prepare(`
    SELECT text_type AS type, version, content_sha256 AS contentSha256,
           public_url AS publicUrl, effective_at AS effectiveAt
    FROM legal_text_versions
    ORDER BY text_type
  `).all().map(row => ({ ...row }));
}

function expectedLegalRows(input) {
  return input.legalEvidence.texts
    .map(text => ({ ...text }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function receiptStaticValues(input, context, schemaFingerprintSha256) {
  return Object.freeze({
    schema_version: 1,
    status: 'completed',
    request_id_sha256: input.requestIdSha256,
    request_fingerprint_sha256: input.requestFingerprintSha256,
    deployment_fingerprint_sha256: context.deploymentFingerprintSha256,
    marker_sha256: context.filesystem.markerSha256,
    schema_fingerprint_sha256: schemaFingerprintSha256,
    dataset_id_sha256: input.datasetIdSha256,
    approval_reference_sha256: input.approvalReferenceSha256,
    family_id: 'default',
    administrator_id: input.administrator.id,
    administrator_id_sha256: input.administratorIdSha256,
    credential_method: 'scrypt-v1',
    legal_text_count: 4,
    legal_evidence_sha256: input.legalEvidenceSha256,
    relation_declaration_version: input.relationDeclaration.version,
    relation_declaration_sha256: input.relationDeclaration.contentSha256,
    relation_declaration_public_url: input.relationDeclaration.publicUrl
  });
}

function receiptRow(db) {
  return db.prepare(`SELECT * FROM ${RECEIPT_TABLE} WHERE singleton_id = 1`).get();
}

function sameStaticReceipt(row, expected) {
  return row && Object.entries(expected).every(([key, value]) => row[key] === value);
}

function assertCoreSeed(db, input) {
  const family = db.prepare(`
    SELECT id, name, invite_code, invite_json FROM families WHERE id = 'default'
  `).get();
  if (!family || family.name !== SYNTHETIC_FAMILY_NAME
      || family.invite_code !== null || family.invite_json !== null) {
    fail('BOOTSTRAP_STATE_INVALID');
  }
  const administrator = db.prepare(`
    SELECT id, name, role, password, family_id, openid, bound_at, tokens_valid_after
    FROM users WHERE id = ?
  `).get(input.administrator.id);
  if (!administrator || administrator.name !== ADMINISTRATOR_NAME
      || administrator.role !== 'admin' || administrator.family_id !== 'default'
      || administrator.openid !== null || administrator.bound_at !== null
      || Number(administrator.tokens_valid_after) !== 0) {
    fail('BOOTSTRAP_STATE_INVALID');
  }
  if (!verifyPwd(input.administrator.password, administrator.password)) {
    fail('BOOTSTRAP_CONFLICT');
  }
  if (JSON.stringify(legalRows(db)) !== JSON.stringify(expectedLegalRows(input))) {
    fail('BOOTSTRAP_STATE_INVALID');
  }
}

function validateReplay(db, input, context) {
  assertSchemaCurrent(db);
  if (count(db, RECEIPT_TABLE) !== 1) fail('BOOTSTRAP_STATE_INVALID');
  const row = receiptRow(db);
  if (!row || row.schema_version !== 1 || row.status !== 'completed'
      || typeof row.completed_at !== 'string' || !row.completed_at) {
    fail('BOOTSTRAP_STATE_INVALID');
  }
  const expected = receiptStaticValues(input, context, referenceSchemaFingerprint());
  if (row.request_id_sha256 !== expected.request_id_sha256
      || !sameStaticReceipt(row, expected)) {
    fail('BOOTSTRAP_CONFLICT');
  }
  assertCoreSeed(db, input);
  return row;
}

function assertCreatedState(db, input, context) {
  assertSchemaCurrent(db);
  const allowed = new Map([
    ['schema_migrations', migrationFiles().length],
    ['families', 1],
    ['users', 1],
    ['legal_text_versions', 4],
    [RECEIPT_TABLE, 1]
  ]);
  for (const table of EXPECTED_TABLES) {
    if (count(db, table) !== (allowed.get(table) || 0)) fail('BOOTSTRAP_VERIFICATION_FAILED');
  }
  validateReplay(db, input, context);
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    fail('BOOTSTRAP_VERIFICATION_FAILED');
  }
}

function evidence(outcome, row, input, context) {
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'synthetic_initial_bootstrap',
    outcome,
    receipt: Object.freeze({
      status: 'completed',
      requestIdSha256: row.request_id_sha256,
      requestFingerprintSha256: row.request_fingerprint_sha256,
      deploymentFingerprintSha256: row.deployment_fingerprint_sha256,
      schemaFingerprintSha256: row.schema_fingerprint_sha256,
      markerSha256: row.marker_sha256,
      completedAt: row.completed_at,
      immutable: true
    }),
    administrator: Object.freeze({
      idSha256: input.administratorIdSha256,
      familyId: 'default',
      role: 'admin',
      credentialMethod: 'scrypt-v1',
      credentialWritten: outcome === 'created'
    }),
    legalEvidence: Object.freeze({
      textCount: 4,
      aggregateSha256: input.legalEvidenceSha256,
      metadataWritten: true,
      publicationExternallyVerified: false
    }),
    database: Object.freeze({
      migrationCount: migrationFiles().length,
      initialEmptyBusinessStateVerified: true,
      familyRowsWritten: 1,
      administratorRowsWritten: 1,
      legalTextRowsWritten: 4,
      bootstrapReceiptRowsWritten: 1,
      childOrBusinessRowsWritten: 0,
      tokenSecretCreated: false
    }),
    operations: Object.freeze({
      networkAttempted: false,
      serverStarted: false,
      subprocessStarted: false,
      deployed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    externalHardGates: Object.freeze({
      appCredentialsVerified: false,
      legalPublicationVerified: false,
      dnsTlsVerified: false,
      filesystemAclVerified: false,
      deploymentApproved: false,
      adultDeviceSmokePassed: false
    }),
    datasetIdSha256: input.datasetIdSha256,
    approvalReferenceSha256: input.approvalReferenceSha256,
    credentialPurpose: CREDENTIAL_PURPOSE,
    environmentValidated: context.deployment.deploymentTier === 'synthetic'
  });
}

function configureWritableDatabase(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
}

function callFault(options, stage) {
  if (options && typeof options.fault === 'function') options.fault(stage);
}

function preflightExistingDatabase(context, input) {
  const filename = context.deployment.dataPaths.sqliteFile;
  if (!fs.existsSync(filename)) return null;
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (schemaRows(db).length === 0) return null;
    assertSchemaCurrent(db);
    if (count(db, RECEIPT_TABLE) === 1) {
      const row = validateReplay(db, input, context);
      return evidence('replayed', row, input, context);
    }
    assertEmptyBaseline(db);
    return null;
  } catch (error) {
    if (error instanceof SyntheticBootstrapError) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('BOOTSTRAP_BUSY');
    }
    fail('BOOTSTRAP_DATABASE_UNSAFE');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
}

function insertSeed(db, input, context, now, options) {
  const timestamp = now.toISOString();
  db.prepare(`
    UPDATE families
    SET name = ?, invite_code = NULL, invite_json = NULL, created_at = ?
    WHERE id = 'default'
  `).run(SYNTHETIC_FAMILY_NAME, timestamp);
  callFault(options, 'after_family');

  const passwordVerifier = hashPwd(input.administrator.password);
  db.prepare(`
    INSERT INTO users(
      id, name, role, password, family_id, openid, bound_at, tokens_valid_after
    ) VALUES (?, ?, 'admin', ?, 'default', NULL, NULL, 0)
  `).run(input.administrator.id, ADMINISTRATOR_NAME, passwordVerifier);
  callFault(options, 'after_administrator');

  const insertLegal = db.prepare(`
    INSERT INTO legal_text_versions(
      text_type, version, content_sha256, public_url, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const text of input.legalEvidence.texts) {
    insertLegal.run(
      text.type,
      text.version,
      text.contentSha256,
      text.publicUrl,
      text.effectiveAt,
      timestamp
    );
    callFault(options, `after_legal_${text.type}`);
  }

  const receipt = receiptStaticValues(input, context, referenceSchemaFingerprint());
  db.prepare(`
    INSERT INTO synthetic_bootstrap_receipts(
      singleton_id, schema_version, status,
      request_id_sha256, request_fingerprint_sha256,
      deployment_fingerprint_sha256, marker_sha256, schema_fingerprint_sha256,
      dataset_id_sha256, approval_reference_sha256,
      family_id, administrator_id, administrator_id_sha256,
      credential_method, legal_text_count, legal_evidence_sha256,
      relation_declaration_version, relation_declaration_sha256,
      relation_declaration_public_url, completed_at
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    receipt.schema_version,
    receipt.status,
    receipt.request_id_sha256,
    receipt.request_fingerprint_sha256,
    receipt.deployment_fingerprint_sha256,
    receipt.marker_sha256,
    receipt.schema_fingerprint_sha256,
    receipt.dataset_id_sha256,
    receipt.approval_reference_sha256,
    receipt.family_id,
    receipt.administrator_id,
    receipt.administrator_id_sha256,
    receipt.credential_method,
    receipt.legal_text_count,
    receipt.legal_evidence_sha256,
    receipt.relation_declaration_version,
    receipt.relation_declaration_sha256,
    receipt.relation_declaration_public_url,
    timestamp
  );
  callFault(options, 'after_receipt');
}

function bootstrapSyntheticDatabase(context, input, options = {}) {
  const existing = preflightExistingDatabase(context, input);
  if (existing) return existing;
  const secretFile = path.join(context.deployment.dataPaths.dataDir, '.secret');
  if (fs.existsSync(secretFile)) fail('BOOTSTRAP_DATABASE_NOT_EMPTY');

  const filename = context.deployment.dataPaths.sqliteFile;
  let db;
  let transactionOpen = false;
  let committed = false;
  try {
    db = new DatabaseSync(filename);
    configureWritableDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    // Revalidate after the writer lock is held. WAL/SHM files are then stable
    // for this connection, avoiding false failures between concurrent callers.
    runtimeFilesystem.validateSyntheticRuntimeFilesystem(
      context.deployment,
      context.projectRoot
    );
    const objects = schemaRows(db);
    if (objects.length === 0) {
      applyMigrationsInCurrentTransaction(db, { now: () => options.now || new Date() });
      callFault(options, 'after_migrations');
    } else {
      assertSchemaCurrent(db);
    }
    if (count(db, RECEIPT_TABLE) === 1) {
      const row = validateReplay(db, input, context);
      db.exec('COMMIT');
      transactionOpen = false;
      committed = true;
      return evidence('replayed', row, input, context);
    }
    assertEmptyBaseline(db);
    if (fs.existsSync(secretFile)) fail('BOOTSTRAP_DATABASE_NOT_EMPTY');
    const now = options.now instanceof Date ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) fail('BOOTSTRAP_INPUT_INVALID');
    insertSeed(db, input, context, now, options);
    assertCreatedState(db, input, context);
    callFault(options, 'before_commit');
    const row = receiptRow(db);
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    return evidence('created', row, input, context);
  } catch (error) {
    if (transactionOpen && db) {
      try {
        db.exec('ROLLBACK');
        transactionOpen = false;
      } catch (_) {
        fail('BOOTSTRAP_RESULT_UNKNOWN');
      }
    }
    if (error instanceof SyntheticBootstrapError) throw error;
    if (error && (error.code === 'SQLITE_BUSY' || /locked|busy/i.test(error.message || ''))) {
      fail('BOOTSTRAP_BUSY');
    }
    fail(committed ? 'BOOTSTRAP_RESULT_UNKNOWN' : 'BOOTSTRAP_TRANSACTION_FAILED');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
}

function bootstrapFromDocument(environment, document, options = {}) {
  const lock = acquireBootstrapLock(environment, options);
  try {
    const context = createContext(environment, options);
    const now = options.now instanceof Date ? options.now : new Date();
    const input = normalizeInput(document, context, now);
    return bootstrapSyntheticDatabase(context, input, { ...options, now });
  } finally {
    releaseBootstrapLock(lock);
  }
}

module.exports = {
  ADMINISTRATOR_NAME,
  BOOTSTRAP_ACK,
  BOOTSTRAP_ACK_ENV,
  CREDENTIAL_PURPOSE,
  EXPECTED_TABLES,
  MAX_STDIN_BYTES,
  SyntheticBootstrapError,
  acquireBootstrapLock,
  bootstrapFromDocument,
  bootstrapSyntheticDatabase,
  createContext,
  decodeCanonicalInput,
  normalizeInput,
  parseArguments,
  readStdin,
  releaseBootstrapLock,
  referenceSchemaFingerprint,
  safeErrorCode
};
