const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const preflight = require('../preflight-synthetic-api');
const rootTools = require('./synthetic-data-root-tools');
const bootstrap = require('./synthetic-bootstrap');
const runtimeFilesystem = require('../../server/config/synthetic-runtime-filesystem');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_STDIN_BYTES = 256 * 1024;
const ACK_ENV = 'SYNTHETIC_CANDIDATE_EVIDENCE_ACK';
const ACK = 'assemble-review-only-not-deployment-v1';
const SUBJECT_TTL_MS = 30 * 60 * 1000;
const ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_CANDIDATE_DATABASE_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const GATE_SPECS = Object.freeze([
  ['app_id_provisioning', 'application_operator', 'authority_record'],
  ['developer_authorization', 'application_operator', 'authority_record'],
  ['app_secret_independence', 'security_reviewer', 'security_review'],
  ['request_domain', 'network_operator', 'authority_record'],
  ['business_domain', 'network_operator', 'authority_record'],
  ['dns', 'network_operator', 'authority_record'],
  ['tls', 'network_operator', 'authority_record'],
  ['proxy_port_boundary', 'network_operator', 'host_inspection'],
  ['os_account', 'platform_administrator', 'host_inspection'],
  ['filesystem_acl', 'security_reviewer', 'host_inspection'],
  ['filesystem_owner', 'security_reviewer', 'host_inspection'],
  ['disk_isolation', 'platform_administrator', 'host_inspection'],
  ['backup_isolation', 'platform_administrator', 'host_inspection'],
  ['database_isolation', 'security_reviewer', 'security_review'],
  ['runtime_secret_management', 'security_reviewer', 'security_review'],
  ['infrastructure_connectivity', 'platform_administrator', 'host_inspection'],
  ['legal_records_publication', 'legal_reviewer', 'legal_review'],
  ['devtools_domain_tls_validation', 'application_operator', 'authority_record'],
  ['production_root_isolation', 'security_reviewer', 'security_review']
].map(value => Object.freeze(value)));
const REQUIRED_GATE_IDS = Object.freeze(GATE_SPECS.map(([gateId]) => gateId));

const STABLE_ERROR_CODES = new Set([
  'SYNTHETIC_CANDIDATE_ARGUMENT_INVALID',
  'SYNTHETIC_CANDIDATE_ACK_REQUIRED',
  'SYNTHETIC_CANDIDATE_STDIN_REQUIRED',
  'SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE',
  'SYNTHETIC_CANDIDATE_INPUT_INVALID',
  'SYNTHETIC_CANDIDATE_SENSITIVE_INPUT',
  'SYNTHETIC_CANDIDATE_SOURCE_INVALID',
  'SYNTHETIC_CANDIDATE_SOURCE_CHANGED',
  'SYNTHETIC_CANDIDATE_BINDING_MISMATCH',
  'SYNTHETIC_CANDIDATE_STATE_ADVANCED',
  'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID',
  'SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED',
  'SYNTHETIC_CANDIDATE_ATTESTATION_INCOMPLETE',
  'SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED',
  'SYNTHETIC_CANDIDATE_VERIFICATION_FAILED'
]);

class SyntheticCandidateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticCandidateError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticCandidateError(code);
}

function safeErrorCode(error) {
  return error && STABLE_ERROR_CODES.has(error.code)
    ? error.code
    : 'SYNTHETIC_CANDIDATE_VERIFICATION_FAILED';
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function exactKeys(value, expected, code = 'SYNTHETIC_CANDIDATE_SOURCE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function allFalse(value) {
  return value && Object.values(value).every(item => item === false);
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value) && !/^([0-9a-f])\1{63}$/.test(value);
}

function validCommit(value) {
  return typeof value === 'string' && COMMIT.test(value) && !/^([0-9a-f])\1+$/.test(value);
}

function parseCanonicalTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code);
  return epoch;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('SYNTHETIC_CANDIDATE_ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('SYNTHETIC_CANDIDATE_ARGUMENT_INVALID');
}

function assertAck(environment) {
  if (!environment || typeof environment !== 'object') {
    fail('SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED');
  }
  if (environment[ACK_ENV] !== ACK) fail('SYNTHETIC_CANDIDATE_ACK_REQUIRED');
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
    environment.GUARDIAN_RELATION_DECLARATION_VERSION
  ].filter(value => typeof value === 'string' && value.length >= 6);
}

function sensitiveRawForms(environment) {
  const result = [];
  for (const value of sensitiveValues(environment)) {
    result.push(value, JSON.stringify(value).slice(1, -1));
  }
  return [...new Set(result)];
}

function decodeCanonicalInput(buffer, environment = process.env) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('SYNTHETIC_CANDIDATE_STDIN_REQUIRED');
  }
  if (buffer.length > MAX_STDIN_BYTES) fail('SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE');
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  }
  if (raw.endsWith('\n') && !raw.endsWith('\r\n')) raw = raw.slice(0, -1);
  if (!raw) fail('SYNTHETIC_CANDIDATE_STDIN_REQUIRED');
  if (sensitiveRawForms(environment).some(value => raw.includes(value))) {
    fail('SYNTHETIC_CANDIDATE_SENSITIVE_INPUT');
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  }
  if (JSON.stringify(document) !== raw) fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('SYNTHETIC_CANDIDATE_STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += input.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      input.fill(0);
      fail('SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(input));
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function validateS12Evidence(evidence, expected) {
  if (canonicalJson(evidence) !== canonicalJson(expected)) {
    fail('SYNTHETIC_CANDIDATE_BINDING_MISMATCH');
  }
  if (evidence.schemaVersion !== 4
      || evidence.profile !== 'synthetic-api-offline-preflight'
      || evidence.result !== 'configuration-shape-validated'
      || !validCommit(evidence.sourceCommit)
      || !validDigest(evidence.implementationTreeSha256)
      || !validDigest(evidence.configurationSha256)
      || !allFalse(evidence.externalVerification)
      || canonicalJson(evidence.productionChildGate)
        !== canonicalJson({ deployedStateVerified: false, changeAttempted: false })) {
    fail('SYNTHETIC_CANDIDATE_SOURCE_INVALID');
  }
}

function validateS13Evidence(evidence, markerSha256) {
  const expected = rootTools.evidenceFor(Object.freeze({
    markerSha256,
    rootEntryCount: 2,
    dataEntryCount: 0,
    sqlitePresent: false,
    sqliteWalPresent: false,
    sqliteShmPresent: false,
    tokenSecretPresent: false
  }));
  if (canonicalJson(evidence) !== canonicalJson(expected)) {
    fail('SYNTHETIC_CANDIDATE_BINDING_MISMATCH');
  }
}

function validateS14Evidence(evidence, validated, provenance) {
  exactKeys(evidence, [
    'schemaVersion', 'purpose', 'outcome', 'receipt', 'administrator',
    'legalEvidence', 'database', 'operations', 'externalHardGates',
    'datasetIdSha256', 'approvalReferenceSha256', 'credentialPurpose',
    'environmentValidated'
  ]);
  exactKeys(evidence.receipt, [
    'status', 'requestIdSha256', 'requestFingerprintSha256', 'sourceCommit',
    'implementationTreeSha256', 'preflightConfigurationSha256',
    'deploymentFingerprintSha256', 'schemaFingerprintSha256', 'markerSha256',
    'completedAt', 'immutable'
  ]);
  exactKeys(evidence.administrator, [
    'idSha256', 'familyId', 'role', 'credentialMethod', 'credentialWritten'
  ]);
  exactKeys(evidence.legalEvidence, [
    'textCount', 'aggregateSha256', 'metadataWritten',
    'publicationExternallyVerified'
  ]);
  exactKeys(evidence.database, [
    'migrationCount', 'initialEmptyBusinessStateVerified', 'familyRowsWritten',
    'administratorRowsWritten', 'legalTextRowsWritten',
    'bootstrapReceiptRowsWritten', 'familyRowsPresent',
    'administratorRowsPresent', 'legalTextRowsPresent',
    'bootstrapReceiptRowsPresent', 'childOrBusinessRowsWritten',
    'tokenSecretCreated'
  ]);
  exactKeys(evidence.operations, [
    'networkAttempted', 'serverStarted', 'subprocessStarted', 'deployed',
    'productionDataRead', 'productionChildGateChanged'
  ]);
  exactKeys(evidence.externalHardGates, [
    'appCredentialsVerified', 'legalPublicationVerified', 'dnsTlsVerified',
    'filesystemAclVerified', 'deploymentApproved', 'adultDeviceSmokePassed'
  ]);

  const { receipt } = validated;
  const created = evidence.outcome === 'created';
  const written = created ? { family: 1, administrator: 1, legal: 4, receipt: 1 } : {
    family: 0, administrator: 0, legal: 0, receipt: 0
  };
  if (evidence.schemaVersion !== 1 || evidence.purpose !== 'synthetic_initial_bootstrap'
      || (!created && evidence.outcome !== 'replayed')
      || evidence.receipt.status !== 'completed' || evidence.receipt.immutable !== true
      || evidence.receipt.requestIdSha256 !== receipt.request_id_sha256
      || evidence.receipt.requestFingerprintSha256 !== receipt.request_fingerprint_sha256
      || evidence.receipt.sourceCommit !== receipt.source_commit
      || evidence.receipt.implementationTreeSha256 !== receipt.implementation_tree_sha256
      || evidence.receipt.preflightConfigurationSha256
        !== receipt.preflight_configuration_sha256
      || evidence.receipt.deploymentFingerprintSha256
        !== receipt.deployment_fingerprint_sha256
      || evidence.receipt.schemaFingerprintSha256 !== receipt.schema_fingerprint_sha256
      || evidence.receipt.markerSha256 !== receipt.marker_sha256
      || evidence.receipt.completedAt !== receipt.completed_at
      || evidence.receipt.sourceCommit !== provenance.sourceCommit
      || evidence.receipt.implementationTreeSha256 !== provenance.implementationTreeSha256
      || evidence.receipt.preflightConfigurationSha256 !== provenance.configurationSha256
      || evidence.administrator.idSha256 !== receipt.administrator_id_sha256
      || evidence.administrator.familyId !== 'default'
      || evidence.administrator.role !== 'admin'
      || evidence.administrator.credentialMethod !== 'scrypt-v1'
      || evidence.administrator.credentialWritten !== created
      || evidence.legalEvidence.textCount !== 4
      || evidence.legalEvidence.aggregateSha256 !== receipt.legal_evidence_sha256
      || evidence.legalEvidence.metadataWritten !== created
      || evidence.legalEvidence.publicationExternallyVerified !== false
      || evidence.database.migrationCount !== 10
      || evidence.database.initialEmptyBusinessStateVerified !== true
      || evidence.database.familyRowsWritten !== written.family
      || evidence.database.administratorRowsWritten !== written.administrator
      || evidence.database.legalTextRowsWritten !== written.legal
      || evidence.database.bootstrapReceiptRowsWritten !== written.receipt
      || evidence.database.familyRowsPresent !== 1
      || evidence.database.administratorRowsPresent !== 1
      || evidence.database.legalTextRowsPresent !== 4
      || evidence.database.bootstrapReceiptRowsPresent !== 1
      || evidence.database.childOrBusinessRowsWritten !== 0
      || evidence.database.tokenSecretCreated !== false
      || !allFalse(evidence.operations) || !allFalse(evidence.externalHardGates)
      || evidence.datasetIdSha256 !== receipt.dataset_id_sha256
      || evidence.approvalReferenceSha256 !== receipt.approval_reference_sha256
      || evidence.credentialPurpose !== bootstrap.CREDENTIAL_PURPOSE
      || evidence.environmentValidated !== true) {
    fail('SYNTHETIC_CANDIDATE_BINDING_MISMATCH');
  }
}

function validateCurrentRoot(evidence) {
  const expected = {
    markerSha256: evidence.filesystem.markerSha256,
    rootEntryCount: 2,
    dataEntryCount: 1,
    sqlitePresent: true,
    sqliteWalPresent: false,
    sqliteShmPresent: false,
    tokenSecretPresent: false
  };
  if (canonicalJson(evidence.filesystem) !== canonicalJson(expected)) {
    fail('SYNTHETIC_CANDIDATE_STATE_ADVANCED');
  }
}

function metadataSnapshot(filename, expectedType) {
  let metadata;
  let real;
  try {
    metadata = fs.lstatSync(filename, { bigint: true });
    real = (fs.realpathSync.native || fs.realpathSync)(filename);
  } catch (_) {
    fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
  }
  if (metadata.isSymbolicLink()
      || (expectedType === 'file' && (!metadata.isFile() || metadata.nlink !== 1n))
      || (expectedType === 'directory' && !metadata.isDirectory())) {
    fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
  }
  return Object.freeze({
    canonicalPath: process.platform === 'win32' ? real.toLowerCase() : real,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: String(metadata.mode),
    nlink: String(metadata.nlink),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs)
  });
}

function physicalRootContext(environment) {
  let account;
  try {
    account = os.userInfo();
  } catch (_) {
    fail('SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED');
  }
  const root = environment.SYNTHETIC_DATA_ROOT;
  const data = environment.DATA_DIR;
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'synthetic-candidate-physical-root-context-v1',
    host: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      username: account.username,
      uid: typeof account.uid === 'number' ? account.uid : null,
      gid: typeof account.gid === 'number' ? account.gid : null
    }),
    approvedParent: metadataSnapshot(
      environment.SYNTHETIC_DATA_ROOT_APPROVED_PARENT,
      'directory'
    ),
    root: metadataSnapshot(root, 'directory'),
    data: metadataSnapshot(data, 'directory'),
    marker: metadataSnapshot(
      path.join(root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME),
      'file'
    ),
    sqlite: metadataSnapshot(environment.SQLITE_FILE, 'file')
  });
}

function databaseSnapshot(filename) {
  const first = metadataSnapshot(filename, 'file');
  if (BigInt(first.size) <= 0n || BigInt(first.size) > BigInt(MAX_CANDIDATE_DATABASE_BYTES)) {
    fail('SYNTHETIC_CANDIDATE_STATE_ADVANCED');
  }
  let content;
  try {
    content = fs.readFileSync(filename);
  } catch (_) {
    fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
  }
  const second = metadataSnapshot(filename, 'file');
  if (canonicalJson(first) !== canonicalJson(second)
      || content.length !== Number(BigInt(first.size))) {
    content.fill(0);
    fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
  }
  const contentSha256 = sha256(content);
  content.fill(0);
  return Object.freeze({ ...second, contentSha256 });
}

function validateReadOnlyDatabase(environment, provenance, options) {
  const filename = environment.SQLITE_FILE;
  let before;
  let db;
  try {
    before = databaseSnapshot(filename);
    const immutableUri = `${pathToFileURL(filename).href}?immutable=1`;
    db = new DatabaseSync(immutableUri, { readOnly: true });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN DEFERRED');
    const validated = bootstrap.validateSyntheticCandidateDatabase(
      db,
      environment,
      provenance,
      { projectRoot: options.projectRoot || PROJECT_ROOT }
    );
    db.exec('COMMIT');
    db.close();
    db = undefined;
    if (options && typeof options.onPhase === 'function') {
      options.onPhase('afterDatabaseReadOnlyValidation');
    }
    const after = databaseSnapshot(filename);
    if (canonicalJson(before) !== canonicalJson(after)) {
      fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
    }
    return Object.freeze({
      validated,
      databaseSnapshotSha256: canonicalHash(after)
    });
  } catch (error) {
    if (db) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      try { db.close(); } catch (_) {}
    }
    if (error instanceof SyntheticCandidateError) throw error;
    if (error && error.code === 'SYNTHETIC_BOOTSTRAP_CONTEXT_MISMATCH') {
      fail('SYNTHETIC_CANDIDATE_STATE_ADVANCED');
    }
    if (error && /^(?:SYNTHETIC_|BOOTSTRAP_)/.test(error.code || '')) {
      fail('SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED');
    }
    fail('SYNTHETIC_CANDIDATE_VERIFICATION_FAILED');
  }
}

function normalizeCaptureInput(document) {
  exactKeys(document, [
    'schemaVersion', 'purpose', 'candidateId', 's12Preflight',
    's13PreBootstrap', 's14Bootstrap'
  ], 'SYNTHETIC_CANDIDATE_INPUT_INVALID');
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_candidate_machine_capture'
      || typeof document.candidateId !== 'string'
      || !/^synthetic-candidate-[a-z0-9][a-z0-9_-]{15,78}$/.test(document.candidateId)) {
    fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  }
  return document;
}

function lockedCommittedProvenance() {
  return require('../verify-synthetic-api-preflight').lockedCommittedProvenance();
}

function captureMachineSubject(environment, document, options = {}) {
  assertAck(environment);
  const input = normalizeCaptureInput(document);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');

  let provenance;
  let committed;
  let expectedS12;
  let firstRoot;
  try {
    const provider = options.provenanceProvider || lockedCommittedProvenance;
    committed = provider();
    expectedS12 = preflight.evidenceFor(environment, committed);
    provenance = Object.freeze({
      ...committed,
      configurationSha256: expectedS12.configurationSha256
    });
    firstRoot = rootTools.verifySyntheticDataRoot(environment, {
      projectRoot: options.projectRoot || PROJECT_ROOT
    });
    validateCurrentRoot(firstRoot);
    validateS12Evidence(input.s12Preflight, expectedS12);
    validateS13Evidence(input.s13PreBootstrap, firstRoot.filesystem.markerSha256);
    const firstPhysicalContext = physicalRootContext(environment);
    const databaseValidation = validateReadOnlyDatabase(environment, provenance, options);
    const { validated } = databaseValidation;
    validateS14Evidence(input.s14Bootstrap, validated, provenance);

    const secondRoot = rootTools.verifySyntheticDataRoot(environment, {
      projectRoot: options.projectRoot || PROJECT_ROOT
    });
    validateCurrentRoot(secondRoot);
    if (canonicalJson(firstRoot) !== canonicalJson(secondRoot)) {
      fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
    }
    const secondPhysicalContext = physicalRootContext(environment);
    if (canonicalJson(firstPhysicalContext) !== canonicalJson(secondPhysicalContext)) {
      fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
    }
    const finalProvenance = provider();
    if (canonicalJson(finalProvenance) !== canonicalJson(committed)) {
      fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
    }

    const receipt = validated.receipt;
    const bindings = Object.freeze({
      s12EvidenceSha256: canonicalHash(input.s12Preflight),
      s13PreBootstrapEvidenceSha256: canonicalHash(input.s13PreBootstrap),
      s14BootstrapEvidenceSha256: canonicalHash(input.s14Bootstrap),
      rootContextSha256: canonicalHash(secondPhysicalContext),
      databaseSnapshotSha256: databaseValidation.databaseSnapshotSha256,
      configurationSha256: provenance.configurationSha256,
      markerSha256: receipt.marker_sha256,
      datasetIdSha256: receipt.dataset_id_sha256,
      deploymentFingerprintSha256: receipt.deployment_fingerprint_sha256,
      schemaFingerprintSha256: receipt.schema_fingerprint_sha256,
      requestFingerprintSha256: receipt.request_fingerprint_sha256,
      approvalReferenceSha256: receipt.approval_reference_sha256,
      administratorIdSha256: receipt.administrator_id_sha256,
      legalEvidenceSha256: receipt.legal_evidence_sha256
    });
    const machineStateSha256 = canonicalHash({
      schemaVersion: 1,
      sourceCommit: provenance.sourceCommit,
      implementationTreeSha256: provenance.implementationTreeSha256,
      implementationFileCount: provenance.implementationFiles.length,
      migrationCount: provenance.implementationFiles
        .filter(item => item.path.startsWith('server/db/migrations/')).length,
      bindings,
      currentRoot: firstRoot.filesystem
    });
    const candidateBindingSha256 = canonicalHash({
      schemaVersion: 1,
      candidateIdSha256: sha256(input.candidateId),
      machineStateSha256,
      bindings
    });
    const capturedAt = now.toISOString();
    const validUntil = new Date(now.getTime() + SUBJECT_TTL_MS).toISOString();
    const core = Object.freeze({
      schemaVersion: 1,
      profile: 'synthetic-candidate-machine-subject',
      result: 'offline-machine-evidence-validated',
      capturedAt,
      validUntil,
      candidateIdSha256: sha256(input.candidateId),
      sourceCommit: provenance.sourceCommit,
      implementationTreeSha256: provenance.implementationTreeSha256,
      implementationFileCount: provenance.implementationFiles.length,
      migrationCount: provenance.implementationFiles
        .filter(item => item.path.startsWith('server/db/migrations/')).length,
      candidateBindingSha256,
      machineStateSha256,
      bindings,
      checks: Object.freeze({
        currentCommitBound: true,
        currentConfigurationAggregateBound: true,
        trustedProxyAllowlistBound: true,
        runtimeSecretIdentityBound: true,
        bootstrapSourceCommitBound: true,
        s13S14MarkerBound: true,
        liveBootstrapReceiptBound: true,
        currentDatabasePristine: true,
        historicalSequenceVerified: false,
        runtimeSecretIndependenceVerified: false,
        localClockExternallyTrusted: false
      }),
      operations: Object.freeze({
        readOnlyGitSubprocessStarted: true,
        databaseOpenedReadOnly: true,
        syntheticDatabaseWritten: false,
        inMemoryReferenceDatabaseCreated: true,
        networkAccessPerformed: false,
        deploymentPerformed: false,
        productionDataRead: false,
        productionChildGateChanged: false
      }),
      externalFactsVerifiedByThisCommand: false,
      deploymentAuthorization: 'not_granted',
      productionChildGateState: 'not_observed',
      childUseAuthorization: 'not_granted'
    });
    return Object.freeze({
      ...core,
      subjectSha256: canonicalHash(core)
    });
  } catch (error) {
    if (error instanceof SyntheticCandidateError) throw error;
    if (error && /^(?:SYNTHETIC_|BOOTSTRAP_|ROOT_|MIGRATION_)/.test(error.code || '')) {
      fail('SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED');
    }
    fail('SYNTHETIC_CANDIDATE_VERIFICATION_FAILED');
  }
}

function validateMachineSubject(subject, now) {
  exactKeys(subject, [
    'schemaVersion', 'profile', 'result', 'capturedAt', 'validUntil',
    'candidateIdSha256', 'sourceCommit', 'implementationTreeSha256',
    'implementationFileCount', 'migrationCount', 'candidateBindingSha256',
    'machineStateSha256', 'bindings', 'checks', 'operations',
    'externalFactsVerifiedByThisCommand', 'deploymentAuthorization',
    'productionChildGateState', 'childUseAuthorization', 'subjectSha256'
  ], 'SYNTHETIC_CANDIDATE_SOURCE_INVALID');
  const { subjectSha256, ...core } = subject;
  const capturedAt = parseCanonicalTimestamp(
    subject.capturedAt,
    'SYNTHETIC_CANDIDATE_SOURCE_INVALID'
  );
  const validUntil = parseCanonicalTimestamp(
    subject.validUntil,
    'SYNTHETIC_CANDIDATE_SOURCE_INVALID'
  );
  if (subject.schemaVersion !== 1
      || subject.profile !== 'synthetic-candidate-machine-subject'
      || subject.result !== 'offline-machine-evidence-validated'
      || !validDigest(subject.candidateIdSha256)
      || !validCommit(subject.sourceCommit)
      || !validDigest(subject.implementationTreeSha256)
      || !validDigest(subject.candidateBindingSha256)
      || !validDigest(subject.machineStateSha256)
      || !validDigest(subject.subjectSha256)
      || canonicalHash(core) !== subjectSha256
      || validUntil - capturedAt !== SUBJECT_TTL_MS
      || capturedAt > now.getTime() + CLOCK_SKEW_MS
      || validUntil <= now.getTime()
      || subject.externalFactsVerifiedByThisCommand !== false
      || subject.deploymentAuthorization !== 'not_granted'
      || subject.productionChildGateState !== 'not_observed'
      || subject.childUseAuthorization !== 'not_granted') {
    fail(validUntil <= now.getTime()
      ? 'SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED'
      : 'SYNTHETIC_CANDIDATE_SOURCE_INVALID');
  }
  return { capturedAt, validUntil };
}

function validateAttestations(attestations, subject, now, capturedAt, subjectValidUntil) {
  if (!Array.isArray(attestations) || attestations.length !== GATE_SPECS.length) {
    fail('SYNTHETIC_CANDIDATE_ATTESTATION_INCOMPLETE');
  }
  let earliestExpiry = Number.POSITIVE_INFINITY;
  const evidenceReferences = new Set();
  for (let index = 0; index < attestations.length; index += 1) {
    const value = attestations[index];
    exactKeys(value, [
      'gateId', 'subjectSha256', 'evidenceReferenceSha256', 'declarantRole',
      'sourceType', 'observedAt', 'expiresAt', 'state', 'signatureStatus'
    ], 'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID');
    const [gateId, role, sourceType] = GATE_SPECS[index];
    const observedAt = parseCanonicalTimestamp(
      value.observedAt,
      'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
    );
    const expiresAt = parseCanonicalTimestamp(
      value.expiresAt,
      'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
    );
    if (value.gateId !== gateId || value.subjectSha256 !== subject.subjectSha256
        || !validDigest(value.evidenceReferenceSha256)
        || evidenceReferences.has(value.evidenceReferenceSha256)
        || value.declarantRole !== role || value.sourceType !== sourceType
        || value.state !== 'declared_satisfied_not_authenticated'
        || value.signatureStatus !== 'not_verified'
        || observedAt < capturedAt || observedAt > subjectValidUntil
        || observedAt > now.getTime() + CLOCK_SKEW_MS
        || expiresAt <= now.getTime() || expiresAt <= observedAt
        || expiresAt - observedAt > ATTESTATION_TTL_MS) {
      if (expiresAt <= now.getTime()) fail('SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED');
      fail('SYNTHETIC_CANDIDATE_ATTESTATION_INVALID');
    }
    evidenceReferences.add(value.evidenceReferenceSha256);
    earliestExpiry = Math.min(earliestExpiry, expiresAt);
  }
  return earliestExpiry;
}

function finalizeAttestations(environment, document, options = {}) {
  assertAck(environment);
  exactKeys(document, [
    'schemaVersion', 'purpose', 'captureInput', 'machineSubject',
    'externalAttestations'
  ], 'SYNTHETIC_CANDIDATE_INPUT_INVALID');
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_candidate_attestation_finalize') {
    fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  }
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) fail('SYNTHETIC_CANDIDATE_INPUT_INVALID');
  const times = validateMachineSubject(document.machineSubject, now);
  const current = captureMachineSubject(environment, document.captureInput, { ...options, now });
  for (const key of [
    'candidateIdSha256', 'sourceCommit', 'implementationTreeSha256',
    'implementationFileCount', 'migrationCount', 'candidateBindingSha256',
    'machineStateSha256', 'bindings', 'checks', 'operations'
  ]) {
    if (canonicalJson(current[key]) !== canonicalJson(document.machineSubject[key])) {
      fail('SYNTHETIC_CANDIDATE_SOURCE_CHANGED');
    }
  }
  const earliestAttestationExpiry = validateAttestations(
    document.externalAttestations,
    document.machineSubject,
    now,
    times.capturedAt,
    times.validUntil
  );
  const validUntilEpoch = Math.min(times.validUntil, earliestAttestationExpiry);
  const attestationSetSha256 = canonicalHash(document.externalAttestations);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-candidate-attestation-envelopes',
    result: 'attestation-envelopes-present',
    finalizedAt: now.toISOString(),
    validUntil: new Date(validUntilEpoch).toISOString(),
    subjectSha256: document.machineSubject.subjectSha256,
    candidateBindingSha256: document.machineSubject.candidateBindingSha256,
    machineStateSha256: document.machineSubject.machineStateSha256,
    attestationSetSha256,
    attestationCount: document.externalAttestations.length,
    requiredGateIds: REQUIRED_GATE_IDS,
    checks: Object.freeze({
      machineStateRevalidated: true,
      attestationShapeComplete: true,
      attestationSubjectBound: true,
      attestationFreshnessChecked: true,
      attestationAuthenticityVerified: false,
      externalFactsVerified: false
    }),
    operations: Object.freeze({
      readOnlyGitSubprocessStarted: true,
      databaseOpenedReadOnly: true,
      syntheticDatabaseWritten: false,
      inMemoryReferenceDatabaseCreated: true,
      networkAccessPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    externalFactsVerifiedByThisCommand: false,
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function usage(mode) {
  const command = mode === 'finalize'
    ? 'finalize:synthetic-candidate-evidence'
    : 'capture:synthetic-candidate-evidence';
  return [
    `Usage: npm run ${command}`,
    '',
    `Requires ${ACK_ENV}=${ACK}.`,
    'Reads one canonical JSON document from non-TTY stdin and writes one redacted JSON line.',
    'This command starts read-only Git subprocesses, opens the synthetic SQLite read-only,',
    'and creates an in-memory reference schema without writing the synthetic database.',
    'It does not persist evidence, access the network, deploy, verify external facts or grant use.'
  ].join('\n');
}

async function runCli(mode, argv = process.argv.slice(2), environment = process.env, stream = process.stdin) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage(mode)}\n`);
      return 0;
    }
    const buffer = await readStdin(stream);
    try {
      const document = decodeCanonicalInput(buffer, environment);
      const output = mode === 'finalize'
        ? finalizeAttestations(environment, document)
        : captureMachineSubject(environment, document);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } finally {
      buffer.fill(0);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Synthetic candidate evidence failed (${safeErrorCode(error)}).\n`);
    return 1;
  }
}

module.exports = {
  ACK,
  ACK_ENV,
  ATTESTATION_TTL_MS,
  GATE_SPECS,
  MAX_STDIN_BYTES,
  REQUIRED_GATE_IDS,
  SUBJECT_TTL_MS,
  SyntheticCandidateError,
  canonicalHash,
  captureMachineSubject,
  decodeCanonicalInput,
  finalizeAttestations,
  parseArguments,
  readStdin,
  runCli,
  safeErrorCode,
  usage
};
