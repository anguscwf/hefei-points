const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const coordination = require('../../scripts/support/synthetic-authority-coordination-intent');
const authorization = require('../../scripts/support/synthetic-authorization-consumer');
const externalApproval = require('../../scripts/support/synthetic-external-approval');
const sagaReadiness = require('../../scripts/support/synthetic-external-saga-readiness');
const { installLoopbackOnlyNetwork } = require('../test-support/loopback-only-network');

const projectRoot = path.resolve(__dirname, '..', '..');
const cli = path.join(projectRoot, 'scripts', 'prepare-synthetic-authority-coordination-intent.js');
const supportFile = path.join(
  projectRoot,
  'scripts',
  'support',
  'synthetic-authority-coordination-intent.js'
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-s18-intent-'));
const FIXED_NOW = new Date('2026-08-28T03:00:00.000Z');
const FIXED_NOW_ISO = FIXED_NOW.toISOString();
const GENESIS_SEQUENCE = 20;

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestId(kind, label) {
  return `synthetic-${kind}-${digest(label).slice(0, 32)}`;
}

function checkpointEnvelope(value, overrides = {}) {
  return {
    schemaVersion: 1,
    purpose: 'test_only_synthetic_revocation_checkpoint',
    nonce: digest(`${value.label}:checkpoint:${overrides.nonce || 'genesis'}`),
    policyIdSha256: value.policyIdSha256,
    policySha256: value.policySha256,
    policyRevision: 1,
    sequence: GENESIS_SEQUENCE,
    authorityPrincipalIdSha256: value.authorityPrincipalIdSha256,
    issuedAt: '2026-08-28T02:00:00.000Z',
    validUntil: '2026-08-28T08:00:00.000Z',
    revokedKeyIds: [],
    revokedPrincipalIdsSha256: [],
    revokedApprovalIdsSha256: [],
    revokedGrantIdsSha256: [],
    ...overrides
  };
}

function fakeCheckpointVerification(_environment, envelope) {
  return {
    schemaVersion: 1,
    profile: 'synthetic-external-revocation-checkpoint-verification',
    result: 'revocation-checkpoint-valid-against-provided-policy-not-authoritative-latest',
    trustPolicyIdSha256: envelope.policyIdSha256,
    trustPolicySha256: envelope.policySha256,
    trustPolicyRevision: envelope.policyRevision,
    revocationCheckpointSequence: envelope.sequence,
    revocationCheckpointSha256: authorization.canonicalHash(envelope),
    revocationCheckpointIssuedAt: envelope.issuedAt,
    revocationCheckpointValidUntil: envelope.validUntil,
    revocationAuthorityPrincipalIdSha256: envelope.authorityPrincipalIdSha256,
    revokedKeyIds: envelope.revokedKeyIds,
    revokedPrincipalIdsSha256: envelope.revokedPrincipalIdsSha256,
    revokedApprovalIdsSha256: envelope.revokedApprovalIdsSha256,
    revokedGrantIdsSha256: envelope.revokedGrantIdsSha256,
    verifiedAt: FIXED_NOW_ISO,
    validUntil: envelope.validUntil,
    checks: {
      testOnlyOverridesUsed: true,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      revocationAuthorityIdentityAuthenticatedByThisCommand: false,
      revocationCheckpointLatestAtAuthorityVerified: false,
      trustedTimeVerified: false
    },
    operations: {
      networkAccessPerformedByVerifier: false,
      fileWritePerformedByVerifier: false,
      databaseWritePerformedByVerifier: false,
      deploymentPerformed: false
    },
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  };
}

function verificationDocument(value, label, overrides = {}) {
  const sourceCommit = overrides.sourceCommit || digest(`${label}:source-commit`);
  const implementationTreeSha256 = overrides.implementationTreeSha256
    || digest(`${label}:implementation-tree`);
  const configurationSha256 = overrides.configurationSha256
    || digest(`${label}:configuration`);
  const subjectSha256 = overrides.subjectSha256 || digest(`${label}:subject`);
  const candidateBindingSha256 = overrides.candidateBindingSha256
    || digest(`${label}:candidate-binding`);
  return {
    signedRevocationCheckpoint: value.genesisCheckpoint,
    signedDeploymentApproval: {
      schemaVersion: 1,
      purpose: 'test_only_synthetic_deployment_approval',
      nonce: digest(`${label}:approval`)
    },
    signedDeploymentGrant: {
      schemaVersion: 1,
      purpose: 'test_only_synthetic_deployment_grant',
      nonce: digest(`${label}:grant-envelope`),
      payload: {
        grantId: `synthetic-test-grant-${digest(`${label}:grant-id`).slice(0, 32)}`,
        consumerIdSha256: value.environment[authorization.CONSUMER_ID_ENV],
        targetEnvironmentSha256:
          value.environment[authorization.TARGET_ENVIRONMENT_ENV],
        subjectSha256,
        candidateBindingSha256,
        sourceCommit,
        implementationTreeSha256,
        configurationSha256,
        expiresAt: '2026-08-28T06:00:00.000Z'
      }
    }
  };
}

function fakeApprovalVerification(_environment, document) {
  const checkpoint = fakeCheckpointVerification(null, document.signedRevocationCheckpoint);
  const grant = document.signedDeploymentGrant;
  const payload = grant.payload;
  return {
    schemaVersion: 2,
    profile: 'synthetic-external-approval-verification',
    result: 'signed-bundle-valid-against-provided-policy-unconsumed',
    trustPolicyIdSha256: checkpoint.trustPolicyIdSha256,
    trustPolicySha256: checkpoint.trustPolicySha256,
    trustPolicyRevision: checkpoint.trustPolicyRevision,
    revocationCheckpointSequence: checkpoint.revocationCheckpointSequence,
    revocationCheckpointSha256: checkpoint.revocationCheckpointSha256,
    approvalEnvelopeSha256: authorization.canonicalHash(document.signedDeploymentApproval),
    grantIdSha256: digest(payload.grantId),
    grantEnvelopeSha256: authorization.canonicalHash(grant),
    consumerIdSha256: payload.consumerIdSha256,
    targetEnvironmentSha256: payload.targetEnvironmentSha256,
    subjectSha256: payload.subjectSha256,
    candidateBindingSha256: payload.candidateBindingSha256,
    sourceCommit: payload.sourceCommit,
    implementationTreeSha256: payload.implementationTreeSha256,
    configurationSha256: payload.configurationSha256,
    verifiedAt: FIXED_NOW_ISO,
    validUntil: payload.expiresAt,
    checks: {
      testOnlyOverridesUsed: true,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      trustedTimeVerified: false,
      authorizationConsumptionVerified: false
    },
    operations: {
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    },
    deploymentGrantStatus: 'signature_valid_against_provided_policy_unconsumed',
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  };
}

function createFixture(label, options = {}) {
  const root = path.join(tempRoot, label);
  const ledgerParent = path.join(root, 'ledger');
  const journalParent = path.join(root, 'coordination-journal');
  const dataRoot = path.join(root, 'synthetic-data');
  const policyParent = path.join(root, 'policy');
  for (const directory of [ledgerParent, journalParent, dataRoot, policyParent]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const policyFile = path.join(policyParent, 'synthetic-trust-policy.json');
  fs.writeFileSync(policyFile, '{"testOnly":true}', { mode: 0o600 });
  const value = {
    label,
    root,
    ledgerParent,
    journalParent,
    dataRoot,
    policyParent,
    policyFile,
    policyIdSha256: digest(`${label}:policy-id`),
    policySha256: digest(`${label}:policy`),
    authorityPrincipalIdSha256: digest(`${label}:revocation-authority`)
  };
  value.environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    [authorization.INIT_ACK_ENV]: authorization.INIT_ACK,
    [authorization.CONSUME_ACK_ENV]: authorization.CONSUME_ACK,
    [authorization.LEDGER_FILE_ENV]:
      path.join(ledgerParent, authorization.LEDGER_FILENAME),
    [authorization.LEDGER_PARENT_ENV]: ledgerParent,
    [authorization.LEDGER_ID_ENV]: digest(`${label}:ledger-id`),
    [authorization.CONSUMER_ID_ENV]:
      options.consumerIdSha256 || digest(`${label}:consumer-id`),
    [authorization.TARGET_ENVIRONMENT_ENV]:
      options.targetEnvironmentSha256 || digest(`${label}:target-environment`),
    [coordination.ACK_ENV]: coordination.ACK,
    [coordination.JOURNAL_FILE_ENV]:
      path.join(journalParent, coordination.JOURNAL_FILENAME),
    [coordination.JOURNAL_PARENT_ENV]: journalParent,
    [coordination.JOURNAL_ID_ENV]: digest(`${label}:coordination-journal-id`),
    [sagaReadiness.ACK_ENV]: sagaReadiness.ACK,
    SYNTHETIC_DATA_ROOT: dataRoot,
    SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT: policyParent,
    SYNTHETIC_APPROVAL_TRUST_POLICY_FILE: policyFile,
    SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256: value.policySha256
  };
  value.ledgerFile = value.environment[authorization.LEDGER_FILE_ENV];
  value.journalFile = value.environment[coordination.JOURNAL_FILE_ENV];
  value.genesisCheckpoint = checkpointEnvelope(value);
  value.initializationDocument = {
    schemaVersion: 1,
    purpose: 'synthetic_local_authorization_ledger_initialize',
    requestId: requestId('ledger-init', label),
    signedRevocationCheckpoint: value.genesisCheckpoint
  };
  authorization.initializeSyntheticAuthorizationLedgerForTest(
    value.environment,
    value.initializationDocument,
    {
      checkpointVerifier: fakeCheckpointVerification,
      now: FIXED_NOW,
      commitAt: FIXED_NOW
    }
  );
  const tuple = options.tuple || {};
  value.verificationDocument = verificationDocument(value, `${label}:consume`, tuple);
  value.consumptionDocument = {
    schemaVersion: 1,
    purpose: 'synthetic_local_grant_compare_and_consume',
    requestId: requestId('grant-consume', `${label}:consume`),
    verificationDocument: value.verificationDocument
  };
  if (options.consume !== false) {
    authorization.consumeSyntheticDeploymentGrantForTest(
      value.environment,
      value.consumptionDocument,
      {
        checkpointVerifier: fakeCheckpointVerification,
        approvalVerifier: fakeApprovalVerification,
        now: FIXED_NOW,
        commitAt: FIXED_NOW
      }
    );
  }
  value.intentDocument = {
    schemaVersion: 1,
    purpose: 'synthetic_authority_coordination_intent_prepare',
    requestId: requestId('authority-intent', label),
    authorizationConsumptionDocument: value.consumptionDocument
  };
  return value;
}

function prepare(value, document = value.intentDocument, options = {}) {
  return coordination.prepareSyntheticAuthorityCoordinationIntentForTest(
    value.environment,
    document,
    { now: FIXED_NOW, ...options }
  );
}

function assertCode(work, code) {
  assert.throws(work, error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function assertRecoveryFailureBeforeJournalCreation(value, document, code) {
  const originalRecovery = authorization.recoverSyntheticAuthorizationReceiptForTest;
  let recoveryCalls = 0;
  authorization.recoverSyntheticAuthorizationReceiptForTest = (...parameters) => {
    recoveryCalls += 1;
    assertJournalFamilyAbsent(value);
    return originalRecovery(...parameters);
  };
  try {
    assertCode(() => prepare(value, document), code);
  } finally {
    authorization.recoverSyntheticAuthorizationReceiptForTest = originalRecovery;
  }
  assert.equal(recoveryCalls, 1);
  assertJournalFamilyAbsent(value);
}

function withDatabase(filename, work) {
  const db = new DatabaseSync(filename);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function fileDigest(filename) {
  return digest(fs.readFileSync(filename));
}

function assertJournalFamilyAbsent(value) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.journalFile}${suffix}`), false, suffix || 'main');
  }
}

function coordinationJournalSnapshot(value) {
  return withDatabase(value.journalFile, db => ({
    identity: db.prepare('SELECT * FROM journal_identity').get(),
    intents: db.prepare(
      'SELECT * FROM coordination_intents ORDER BY intent_id_sha256'
    ).all()
  }));
}

function coordinationReadOnlyEvidence(value) {
  const db = new DatabaseSync(value.journalFile, { readOnly: true });
  let rows;
  try {
    db.exec('PRAGMA query_only = ON');
    rows = {
      identity: db.prepare('SELECT * FROM journal_identity').all(),
      intents: db.prepare(
        'SELECT * FROM coordination_intents ORDER BY intent_id_sha256'
      ).all()
    };
  } finally {
    db.close();
  }
  const metadata = fs.lstatSync(value.journalFile, { bigint: true });
  return {
    bytes: fs.readFileSync(value.journalFile),
    metadata: {
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
      birthtimeNs: metadata.birthtimeNs
    },
    rows
  };
}

function directoryTreeEvidence(root) {
  const rows = [];
  const visit = (filename, relative) => {
    const metadata = fs.lstatSync(filename, { bigint: true });
    rows.push({
      relative,
      kind: metadata.isDirectory() ? 'directory' : 'file',
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: String(metadata.mode),
      nlink: String(metadata.nlink),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
      ctimeNs: String(metadata.ctimeNs),
      birthtimeNs: String(metadata.birthtimeNs),
      bytes: metadata.isFile() ? fs.readFileSync(filename).toString('hex') : null
    });
    if (metadata.isDirectory()) {
      for (const entry of fs.readdirSync(filename).sort()) {
        visit(path.join(filename, entry), relative ? path.join(relative, entry) : entry);
      }
    }
  };
  visit(root, '');
  return rows;
}

const HOT_COORDINATION_JOURNAL_WRITER = String.raw`
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.S18_JOURNAL_FILE);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA synchronous = FULL');
db.exec('PRAGMA cache_size = 1');
db.exec('BEGIN IMMEDIATE');
db.exec('DROP TRIGGER trg_coordination_journal_identity_no_update');
db.prepare('UPDATE journal_identity SET created_at_observed = ? WHERE singleton_id = 1')
  .run('2026-08-28T03:00:00.001Z');
db.exec('CREATE TABLE hot_uncommitted_rows (row_id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO hot_uncommitted_rows(row_id, payload) VALUES (?, ?)');
for (let index = 0; index < 5000; index += 1) {
  insert.run(index + 1, 'uncommitted-coordination-row-' + index + '-'.repeat(128));
}
fs.writeFileSync(process.env.S18_HOT_MARKER, 'hot-journal-ready', { flag: 'wx' });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
`;

const CHILD_PREPARE = String.raw`
const fs = require('node:fs');
const coordination = require(process.env.S18_COORDINATION_MODULE);
const value = JSON.parse(process.env.S18_COORDINATION_CASE);
try {
  const result = coordination.prepareSyntheticAuthorityCoordinationIntentForTest(
    value.environment,
    value.document,
    {
      now: new Date(value.now),
      fault(stage) {
        if (stage === 'after_begin' && value.holdMarker) {
          fs.writeFileSync(value.holdMarker, 'coordination-lock-held', { flag: 'wx' });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        }
      }
    }
  );
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error && error.code }));
}
`;

function runPrepareProcess(value, document, options = {}) {
  const payload = {
    environment: value.environment,
    document,
    now: FIXED_NOW_ISO,
    holdMarker: options.holdMarker || ''
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_PREPARE], {
      cwd: projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        S18_COORDINATION_MODULE: supportFile,
        S18_COORDINATION_CASE: JSON.stringify(payload)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`S18 child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`S18 child returned invalid JSON: ${stdout}\n${stderr}`, {
          cause: error
        }));
      }
    });
  });
}

async function waitForFile(filename) {
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('S18 只读恢复 S17 历史 receipt 并持久化未提交摘要意图', () => {
  const value = createFixture('prepare-local-intent');
  const ledgerBefore = {
    digest: fileDigest(value.ledgerFile),
    size: fs.statSync(value.ledgerFile).size,
    mtimeMs: fs.statSync(value.ledgerFile).mtimeMs
  };
  const result = prepare(value);
  assert.equal(result.result, 'locally_prepared_unsubmitted');
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.authorityCoordinationStatus, 'locally_prepared_unsubmitted');
  assert.equal(result.checks.testOnlyOverridesUsed, true);
  assert.equal(result.checks.historicalLocalAuthorizationReceiptBoundAtPreparation, true);
  assert.equal(result.checks.historicalIntentRecovered, false);
  assert.equal(result.checks.localReceiptRecoveryPerformedForThisCall, true);
  assert.equal(result.checks.rawAuthorizationMaterialExcluded, true);
  assert.equal(result.checks.journalIdentityBoundToSingleLedger, false);
  assert.equal(result.checks.crossLedgerUniquenessOnlyWithinThisJournal, true);
  assert.equal(result.checks.externalRollbackAnchorVerified, false);
  assert.equal(result.checks.localClockMonotonicWithinThisJournal, true);
  assert.equal(result.preparedAtObserved, result.localConsumedAtObserved);
  for (const name of [
    'currentExternalApprovalRevalidatedByThisCommand',
    'trustPolicyExternallyAuthorizedByThisCommand',
    'externalRoleIdentitiesAuthenticatedByThisCommand',
    'externalEvidenceRetrievedByThisCommand',
    'externalAuditRecordRetrievedByThisCommand',
    'trustedTimeVerified',
    'latestCheckpointExternallyConfirmed',
    'globalConsumptionVerified',
    'externalAuthorityReceiptVerified',
    'deploymentReceiptVerified',
    'externalDeploymentAtomicityVerified',
    'externalFactsVerified'
  ]) assert.equal(result.checks[name], false, name);
  assert.deepEqual(result.operations, {
    coordinationIntentRowInserted: true,
    localIntentJournalOpenedWritable: true,
    s17AuthorizationLedgerWritten: false,
    syntheticDatabaseWritten: false,
    networkAccessPerformed: false,
    externalSubmissionPerformed: false,
    deploymentPerformed: false,
    productionDataRead: false,
    productionChildGateChanged: false
  });
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.productionChildGateState, 'not_observed');
  assert.equal(result.childUseAuthorization, 'not_granted');
  assert.equal(fs.existsSync(`${value.ledgerFile}-journal`), false);
  assert.deepEqual({
    digest: fileDigest(value.ledgerFile),
    size: fs.statSync(value.ledgerFile).size,
    mtimeMs: fs.statSync(value.ledgerFile).mtimeMs
  }, ledgerBefore);

  withDatabase(value.journalFile, db => {
    assert.equal(db.prepare('PRAGMA application_id').get().application_id,
      coordination.JOURNAL_APPLICATION_ID);
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
      'delete');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_identity').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 1);
    const columns = db.prepare('PRAGMA table_info(coordination_intents)').all()
      .map(row => row.name);
    assert.equal(columns.some(name => /json|signature|envelope_json/i.test(name)), false);
  });
  const bytes = fs.readFileSync(value.journalFile);
  assert.equal(bytes.includes(Buffer.from(value.intentDocument.requestId)), false);
  assert.equal(bytes.includes(Buffer.from(value.consumptionDocument.requestId)), false);
  assert.equal(bytes.includes(Buffer.from(
    value.verificationDocument.signedDeploymentGrant.payload.grantId
  )), false);
});

test('S18 精确幂等重放不再读取 S17，同 key 异指纹及 test/production 混用拒绝', () => {
  const value = createFixture('intent-replay');
  const prepared = prepare(value);
  const originalRecovery = authorization.recoverSyntheticAuthorizationReceiptForTest;
  authorization.recoverSyntheticAuthorizationReceiptForTest = () => {
    assert.fail('精确 S18 replay 不应再次读取 S17 ledger');
  };
  try {
    const replayed = prepare(value, value.intentDocument, {
      now: new Date('2026-08-28T01:00:00.000Z')
    });
    assert.equal(replayed.outcome, 'replayed');
    assert.equal(replayed.intentRecordSha256, prepared.intentRecordSha256);
    assert.equal(replayed.checks.historicalIntentRecovered, true);
    assert.equal(replayed.checks.localReceiptRecoveryPerformedForThisCall, false);
    assert.equal(replayed.checks.localClockMonotonicWithinThisJournal, true);
    assert.equal(replayed.operations.coordinationIntentRowInserted, false);
    assert.equal(replayed.operations.localIntentJournalOpenedWritable, true);
    const changed = structuredClone(value.intentDocument);
    changed.authorizationConsumptionDocument.verificationDocument
      .signedDeploymentApproval.nonce = digest('changed-approval');
    assertCode(
      () => prepare(value, changed),
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    authorization.recoverSyntheticAuthorizationReceiptForTest = originalRecovery;
  }
  assertCode(
    () => coordination.prepareSyntheticAuthorityCoordinationIntent(
      value.environment,
      value.intentDocument
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TEST_ONLY_STATE_REJECTED'
  );
});

test('S18 只读 API 精确恢复历史 intent，拒绝 sidecar 且不读取 S17 或改动 journal', () => {
  const absent = createFixture('intent-read-only-absent');
  assertCode(
    () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
      absent.environment,
      absent.intentDocument
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED'
  );
  assertJournalFamilyAbsent(absent);

  const value = createFixture('intent-read-only-recovery');
  const prepared = prepare(value);
  const before = coordinationReadOnlyEvidence(value);
  const originalProductionS17Recovery = authorization.recoverSyntheticAuthorizationReceipt;
  const originalTestS17Recovery = authorization.recoverSyntheticAuthorizationReceiptForTest;
  authorization.recoverSyntheticAuthorizationReceipt = () => {
    assert.fail('S18 intent read-only recovery 不得读取 S17 production ledger API');
  };
  authorization.recoverSyntheticAuthorizationReceiptForTest = () => {
    assert.fail('S18 intent read-only recovery 不得读取 S17 test ledger API');
  };
  try {
    const recovered = coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
      value.environment,
      value.intentDocument
    );
    assert.equal(recovered.outcome, 'replayed');
    assert.equal(recovered.result, 'locally_prepared_unsubmitted');
    assert.equal(recovered.intentRecordSha256, prepared.intentRecordSha256);
    assert.equal(recovered.checks.historicalIntentRecovered, true);
    assert.equal(recovered.checks.localReceiptRecoveryPerformedForThisCall, false);
    assert.deepEqual(recovered.operations, {
      coordinationIntentRowInserted: false,
      localIntentJournalOpenedReadOnly: true,
      localIntentJournalOpenedWritable: false,
      s17AuthorizationLedgerWritten: false,
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      externalSubmissionPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    });

    const missing = {
      ...value.intentDocument,
      requestId: requestId('authority-intent', 'intent-read-only-recovery-missing')
    };
    assertCode(
      () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
        value.environment,
        missing
      ),
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED'
    );

    const conflict = structuredClone(value.intentDocument);
    conflict.authorizationConsumptionDocument.verificationDocument
      .signedDeploymentApproval.nonce = digest('intent-read-only-recovery-conflict');
    assertCode(
      () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
        value.environment,
        conflict
      ),
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDEMPOTENCY_CONFLICT'
    );

    assertCode(
      () => coordination.recoverSyntheticAuthorityCoordinationIntent(
        value.environment,
        value.intentDocument
      ),
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TEST_ONLY_STATE_REJECTED'
    );

    for (const [suffix, code] of [
      ['-journal', 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY'],
      ['-wal', 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'],
      ['-shm', 'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN']
    ]) {
      const sidecar = `${value.journalFile}${suffix}`;
      const marker = Buffer.from(`synthetic-read-only-sidecar:${suffix}`);
      fs.writeFileSync(sidecar, marker, { mode: 0o600 });
      try {
        assertCode(
          () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
            value.environment,
            value.intentDocument
          ),
          code
        );
        assert.deepEqual(fs.readFileSync(sidecar), marker);
      } finally {
        fs.rmSync(sidecar, { force: true });
      }
    }
  } finally {
    authorization.recoverSyntheticAuthorizationReceipt = originalProductionS17Recovery;
    authorization.recoverSyntheticAuthorizationReceiptForTest = originalTestS17Recovery;
  }
  assert.deepEqual(coordinationReadOnlyEvidence(value), before);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.journalFile}${suffix}`), false, suffix);
  }

  const source = fs.readFileSync(supportFile, 'utf8');
  const recoveryStart = source.indexOf(
    'function recoverSyntheticAuthorityCoordinationIntentInternal('
  );
  const recoveryEnd = source.indexOf(
    'function recoverSyntheticAuthorityCoordinationIntent(environment',
    recoveryStart
  );
  const recoverySource = source.slice(recoveryStart, recoveryEnd);
  const heldOpen = recoverySource.indexOf('openHeldJournal(context)');
  const sqliteOpen = recoverySource.indexOf(
    'new DatabaseSync(context.filename, { readOnly: true })'
  );
  assert.ok(heldOpen >= 0 && sqliteOpen > heldOpen);
  assert.match(source, /function readHeldJournalDigest\(descriptor, expectedMetadata\)/);
  const heldFunctionStart = source.indexOf('function openHeldJournal(context)');
  const heldFunctionEnd = source.indexOf(
    'function assertPathMatchesHeldJournal(context, held)',
    heldFunctionStart
  );
  assert.match(
    source.slice(heldFunctionStart, heldFunctionEnd),
    /readHeldJournalDigest\(descriptor, metadata\)/
  );
  assert.match(recoverySource, /new DatabaseSync\(context\.filename, \{ readOnly: true \}\)/);
  assert.match(recoverySource, /configureReadOnlyDatabase\(db\)/);
  assert.match(recoverySource, /db\.exec\('BEGIN'\)/);
  assert.equal(recoverySource.includes('BEGIN IMMEDIATE'), false);
  const transactionSource = recoverySource.slice(
    recoverySource.indexOf("db.exec('BEGIN')"),
    recoverySource.indexOf("db.exec('COMMIT')")
  );
  assert.ok(
    (transactionSource.match(/assertPathMatchesHeldJournal\(context, held\)/g) || [])
      .length >= 2
  );
  const configureStart = source.indexOf('function configureReadOnlyDatabase(db)');
  const configureEnd = source.indexOf('function createJournalSchema(db)', configureStart);
  const configureSource = source.slice(configureStart, configureEnd);
  assert.match(configureSource, /PRAGMA query_only = ON/);
  assert.match(configureSource, /PRAGMA temp_store = MEMORY/);
  assert.match(configureSource, /tempStore\.temp_store !== 2/);
  assert.equal(configureSource.includes('journal_mode = DELETE'), false);
});

test('S18 只读 recovery 在 SQLite open 前拒绝无 sidecar 的持久 WAL header 且目录零变化', () => {
  const value = createFixture('intent-read-only-wal-header');
  prepare(value);
  withDatabase(value.journalFile, db => {
    assert.equal(
      String(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode).toLowerCase(),
      'wal'
    );
  });
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.journalFile}${suffix}`), false, suffix);
  }
  const header = fs.readFileSync(value.journalFile);
  assert.equal(header[18], 2);
  assert.equal(header[19], 2);
  const before = directoryTreeEvidence(value.journalParent);
  assertCode(
    () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
      value.environment,
      value.intentDocument
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID'
  );
  assert.deepEqual(directoryTreeEvidence(value.journalParent), before);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.journalFile}${suffix}`), false, suffix);
  }
});

test('S18 本地观察时钟不得早于 receipt 或 journal 高水位，精确 replay 不重判时钟', () => {
  const beforeReceipt = createFixture('intent-clock-before-receipt');
  assertCode(
    () => prepare(beforeReceipt, beforeReceipt.intentDocument, {
      now: new Date('2026-08-28T02:59:59.999Z')
    }),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_LOCAL_CLOCK_ROLLBACK'
  );
  assertJournalFamilyAbsent(beforeReceipt);

  const first = createFixture('intent-clock-first');
  const firstResult = prepare(first);
  assert.equal(firstResult.preparedAtObserved, firstResult.localConsumedAtObserved);

  const useFirstJournal = value => {
    value.environment[coordination.JOURNAL_FILE_ENV] = first.journalFile;
    value.environment[coordination.JOURNAL_PARENT_ENV] = first.journalParent;
    value.environment[coordination.JOURNAL_ID_ENV] =
      first.environment[coordination.JOURNAL_ID_ENV];
  };

  const later = createFixture('intent-clock-later');
  useFirstJournal(later);
  const laterResult = prepare(later, later.intentDocument, {
    now: new Date('2026-08-28T03:00:01.000Z')
  });
  assert.equal(laterResult.preparedAtObserved, '2026-08-28T03:00:01.000Z');

  const equalHighWater = createFixture('intent-clock-equal-high-water');
  useFirstJournal(equalHighWater);
  const equalResult = prepare(equalHighWater, equalHighWater.intentDocument, {
    now: new Date('2026-08-28T03:00:01.000Z')
  });
  assert.equal(equalResult.outcome, 'prepared');
  assert.equal(equalResult.preparedAtObserved, laterResult.preparedAtObserved);

  const rollback = createFixture('intent-clock-journal-rollback');
  useFirstJournal(rollback);
  assertCode(
    () => prepare(rollback, rollback.intentDocument, {
      now: new Date('2026-08-28T03:00:00.999Z')
    }),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_LOCAL_CLOCK_ROLLBACK'
  );
  withDatabase(first.journalFile, db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 3);
  });
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${first.journalFile}${suffix}`), false, suffix);
  }

  const originalRecovery = authorization.recoverSyntheticAuthorizationReceiptForTest;
  authorization.recoverSyntheticAuthorizationReceiptForTest = () => {
    assert.fail('精确 replay 即使当前时钟回拨也不应重新读取 S17');
  };
  try {
    const replay = prepare(first, first.intentDocument, {
      now: new Date('2026-08-27T00:00:00.000Z')
    });
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.preparedAtObserved, FIXED_NOW_ISO);
    assert.equal(replay.checks.localClockMonotonicWithinThisJournal, true);
  } finally {
    authorization.recoverSyntheticAuthorizationReceiptForTest = originalRecovery;
  }
});

test('S18 只接受精确历史 consumption，恢复 missing 或稳定 rejection 时不留下 journal', () => {
  const missing = createFixture('intent-missing-history', { consume: false });
  assertRecoveryFailureBeforeJournalCreation(
    missing,
    missing.intentDocument,
    'SYNTHETIC_AUTHORIZATION_LEDGER_HISTORICAL_RECEIPT_REQUIRED'
  );

  const rejected = createFixture('intent-historical-rejection');
  const rejectedConsumption = {
    ...rejected.consumptionDocument,
    requestId: requestId('grant-consume', 'intent-historical-rejection:loser')
  };
  assertCode(
    () => authorization.consumeSyntheticDeploymentGrantForTest(
      rejected.environment,
      rejectedConsumption,
      {
        checkpointVerifier: fakeCheckpointVerification,
        approvalVerifier: fakeApprovalVerification,
        now: FIXED_NOW,
        commitAt: FIXED_NOW
      }
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );
  const rejectedIntent = {
    ...rejected.intentDocument,
    requestId: requestId('authority-intent', 'intent-historical-rejection:loser'),
    authorizationConsumptionDocument: rejectedConsumption
  };
  assertRecoveryFailureBeforeJournalCreation(
    rejected,
    rejectedIntent,
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );

  const externalRejected = createFixture('intent-historical-external-rejection', {
    consume: false
  });
  const revoked = 'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED';
  assertCode(
    () => authorization.consumeSyntheticDeploymentGrantForTest(
      externalRejected.environment,
      externalRejected.consumptionDocument,
      {
        checkpointVerifier: fakeCheckpointVerification,
        approvalVerifier() {
          throw new externalApproval.SyntheticExternalApprovalError(revoked);
        },
        now: FIXED_NOW,
        commitAt: FIXED_NOW
      }
    ),
    revoked
  );
  assertRecoveryFailureBeforeJournalCreation(
    externalRejected,
    externalRejected.intentDocument,
    revoked
  );
});

test('S18 对 receipt 与候选目标执行独立唯一约束', () => {
  const value = createFixture('intent-unique-receipt');
  prepare(value);
  const secondIntent = {
    ...value.intentDocument,
    requestId: requestId('authority-intent', 'intent-unique-receipt:second')
  };
  assertCode(
    () => prepare(value, secondIntent),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECEIPT_ALREADY_PREPARED'
  );
  withDatabase(value.journalFile, db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 1);
  });

  const target = createFixture('intent-unique-target-first');
  const firstPayload = target.verificationDocument.signedDeploymentGrant.payload;
  prepare(target);
  const second = createFixture('intent-unique-target-second', {
    targetEnvironmentSha256: target.environment[authorization.TARGET_ENVIRONMENT_ENV],
    tuple: {
      sourceCommit: firstPayload.sourceCommit,
      implementationTreeSha256: firstPayload.implementationTreeSha256,
      configurationSha256: firstPayload.configurationSha256
    }
  });
  second.environment[coordination.JOURNAL_FILE_ENV] = target.journalFile;
  second.environment[coordination.JOURNAL_PARENT_ENV] = target.journalParent;
  second.environment[coordination.JOURNAL_ID_ENV] =
    target.environment[coordination.JOURNAL_ID_ENV];
  assertCode(
    () => prepare(second),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TARGET_ALREADY_PREPARED'
  );
  withDatabase(target.journalFile, db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 1);
  });

  const grant = createFixture('intent-unique-grant-first');
  prepare(grant);
  const grantSecond = createFixture('intent-unique-grant-second', {
    consume: false,
    consumerIdSha256: grant.environment[authorization.CONSUMER_ID_ENV],
    targetEnvironmentSha256: grant.environment[authorization.TARGET_ENVIRONMENT_ENV]
  });
  grantSecond.verificationDocument.signedDeploymentGrant = structuredClone(
    grant.verificationDocument.signedDeploymentGrant
  );
  authorization.consumeSyntheticDeploymentGrantForTest(
    grantSecond.environment,
    grantSecond.consumptionDocument,
    {
      checkpointVerifier: fakeCheckpointVerification,
      approvalVerifier: fakeApprovalVerification,
      now: FIXED_NOW,
      commitAt: FIXED_NOW
    }
  );
  grantSecond.environment[coordination.JOURNAL_FILE_ENV] = grant.journalFile;
  grantSecond.environment[coordination.JOURNAL_PARENT_ENV] = grant.journalParent;
  grantSecond.environment[coordination.JOURNAL_ID_ENV] =
    grant.environment[coordination.JOURNAL_ID_ENV];
  assertCode(
    () => prepare(grantSecond),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_GRANT_ALREADY_PREPARED'
  );

  const approval = createFixture('intent-unique-approval-first');
  prepare(approval);
  const approvalSecond = createFixture('intent-unique-approval-second', { consume: false });
  approvalSecond.verificationDocument.signedDeploymentApproval = structuredClone(
    approval.verificationDocument.signedDeploymentApproval
  );
  authorization.consumeSyntheticDeploymentGrantForTest(
    approvalSecond.environment,
    approvalSecond.consumptionDocument,
    {
      checkpointVerifier: fakeCheckpointVerification,
      approvalVerifier: fakeApprovalVerification,
      now: FIXED_NOW,
      commitAt: FIXED_NOW
    }
  );
  approvalSecond.environment[coordination.JOURNAL_FILE_ENV] = approval.journalFile;
  approvalSecond.environment[coordination.JOURNAL_PARENT_ENV] = approval.journalParent;
  approvalSecond.environment[coordination.JOURNAL_ID_ENV] =
    approval.environment[coordination.JOURNAL_ID_ENV];
  assertCode(
    () => prepare(approvalSecond),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVAL_ALREADY_PREPARED'
  );
});

test('S18 commit 前故障完整回滚，commit 后结果未知可由原请求恢复', () => {
  const before = createFixture('intent-fault-before-commit');
  assertCode(
    () => prepare(before, before.intentDocument, {
      fault(stage) {
        if (stage === 'after_intent_insert') throw new Error('test fault before commit');
      }
    }),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_TRANSACTION_FAILED'
  );
  assert.equal(fs.existsSync(before.journalFile), false);
  assert.equal(prepare(before).outcome, 'prepared');

  const after = createFixture('intent-fault-after-commit');
  assertCode(
    () => prepare(after, after.intentDocument, {
      fault(stage) {
        if (stage === 'after_commit') throw new Error('test fault after commit');
      }
    }),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
  );
  assert.equal(fs.existsSync(after.journalFile), true);
  const recovered = prepare(after);
  assert.equal(recovered.outcome, 'replayed');
  withDatabase(after.journalFile, db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 1);
  });
});

test('S18 可写入口恢复真实 hot DELETE journal 后全量校验并精确 replay', async () => {
  const value = createFixture('intent-hot-journal-recovery');
  const prepared = prepare(value);
  const before = coordinationJournalSnapshot(value);
  const marker = path.join(value.journalParent, 'hot-journal-ready.marker');
  const child = spawn(process.execPath, ['-e', HOT_COORDINATION_JOURNAL_WRITER], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      S18_JOURNAL_FILE: value.journalFile,
      S18_HOT_MARKER: marker
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForFile(marker);
  assert.equal(fs.existsSync(`${value.journalFile}-journal`), true);
  const liveBytes = {
    main: fs.readFileSync(value.journalFile),
    journal: fs.readFileSync(`${value.journalFile}-journal`)
  };
  assertCode(
    () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
      value.environment,
      value.intentDocument
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY'
  );
  assert.deepEqual(fs.readFileSync(value.journalFile), liveBytes.main);
  assert.deepEqual(fs.readFileSync(`${value.journalFile}-journal`), liveBytes.journal);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(child.kill('SIGKILL'), true);
  const exit = await closed;
  assert.notEqual(exit.code, 0, stderr);
  assert.equal(fs.existsSync(`${value.journalFile}-journal`), true);
  const crashedBytes = {
    main: fs.readFileSync(value.journalFile),
    journal: fs.readFileSync(`${value.journalFile}-journal`)
  };
  assertCode(
    () => coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
      value.environment,
      value.intentDocument
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_BUSY'
  );
  assert.deepEqual(fs.readFileSync(value.journalFile), crashedBytes.main);
  assert.deepEqual(fs.readFileSync(`${value.journalFile}-journal`), crashedBytes.journal);

  const replayed = prepare(value, value.intentDocument, {
    now: new Date('2026-08-27T00:00:00.000Z')
  });
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(replayed.intentRecordSha256, prepared.intentRecordSha256);
  assert.equal(replayed.operations.coordinationIntentRowInserted, false);
  assert.equal(replayed.operations.localIntentJournalOpenedWritable, true);
  assert.equal(fs.existsSync(`${value.journalFile}-journal`), false);
  assert.equal(fs.existsSync(`${value.journalFile}-wal`), false);
  assert.equal(fs.existsSync(`${value.journalFile}-shm`), false);
  const readOnlyRecovered = coordination.recoverSyntheticAuthorityCoordinationIntentForTest(
    value.environment,
    value.intentDocument
  );
  assert.equal(readOnlyRecovered.outcome, 'replayed');
  assert.equal(readOnlyRecovered.intentRecordSha256, prepared.intentRecordSha256);
  assert.equal(readOnlyRecovered.operations.localIntentJournalOpenedReadOnly, true);
  assert.equal(readOnlyRecovered.operations.localIntentJournalOpenedWritable, false);
  const readinessReport = sagaReadiness.assessSyntheticExternalSagaReadinessForTest(
    value.environment,
    {
      schemaVersion: 1,
      purpose: 'synthetic_s19_external_integration_blocker_report',
      authorityCoordinationIntentDocument: value.intentDocument
    }
  );
  assert.equal(readinessReport.result, 'external_integration_blocked');
  assert.equal(readinessReport.readyForExternalIntegration, false);
  assert.equal(readinessReport.operations.s18IntentJournalOpenedReadOnly, true);
  assert.deepEqual(coordinationJournalSnapshot(value), before);
  withDatabase(value.journalFile, db => {
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'hot_uncommitted_rows'"
    ).get().count, 0);
  });
});

test('S18 两个真实 Node 进程并发准备时保持一次写入、精确 replay 与唯一 loser', async () => {
  const seed = createFixture('intent-concurrency-seed');
  prepare(seed);

  const identical = createFixture('intent-concurrency-identical');
  identical.environment[coordination.JOURNAL_FILE_ENV] = seed.journalFile;
  identical.environment[coordination.JOURNAL_PARENT_ENV] = seed.journalParent;
  identical.environment[coordination.JOURNAL_ID_ENV] =
    seed.environment[coordination.JOURNAL_ID_ENV];
  const identicalMarker = path.join(seed.journalParent, 'identical-lock-held.marker');
  const original = runPrepareProcess(identical, identical.intentDocument, {
    holdMarker: identicalMarker
  });
  await waitForFile(identicalMarker);
  const retry = runPrepareProcess(identical, identical.intentDocument);
  const identicalOutcomes = await Promise.all([original, retry]);
  assert.equal(identicalOutcomes.every(outcome => outcome.ok), true);
  assert.deepEqual(
    identicalOutcomes.map(outcome => outcome.result.outcome).sort(),
    ['prepared', 'replayed']
  );

  const conflict = createFixture('intent-concurrency-conflict');
  conflict.environment[coordination.JOURNAL_FILE_ENV] = seed.journalFile;
  conflict.environment[coordination.JOURNAL_PARENT_ENV] = seed.journalParent;
  conflict.environment[coordination.JOURNAL_ID_ENV] =
    seed.environment[coordination.JOURNAL_ID_ENV];
  const first = conflict.intentDocument;
  const second = {
    ...first,
    requestId: requestId('authority-intent', 'intent-concurrency-conflict:second')
  };
  const conflictMarker = path.join(seed.journalParent, 'conflict-lock-held.marker');
  const firstOutcome = runPrepareProcess(conflict, first, { holdMarker: conflictMarker });
  await waitForFile(conflictMarker);
  const secondOutcome = runPrepareProcess(conflict, second);
  const conflictOutcomes = await Promise.all([firstOutcome, secondOutcome]);
  assert.equal(conflictOutcomes.filter(outcome => outcome.ok).length, 1);
  assert.deepEqual(
    conflictOutcomes.filter(outcome => !outcome.ok).map(outcome => outcome.code),
    ['SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RECEIPT_ALREADY_PREPARED']
  );
  withDatabase(seed.journalFile, db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coordination_intents').get().count, 3);
  });
});

test('S18 journal schema、sidecar、context 和独立目录边界 fail closed', () => {
  const schema = createFixture('intent-schema-tamper');
  prepare(schema);
  withDatabase(schema.journalFile, db => db.exec('DROP TRIGGER trg_coordination_intent_no_delete'));
  assertCode(
    () => prepare(schema),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID'
  );

  const record = createFixture('intent-record-tamper');
  prepare(record);
  withDatabase(record.journalFile, db => {
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'trg_coordination_intent_no_update'
    `).get();
    db.exec('DROP TRIGGER trg_coordination_intent_no_update');
    db.prepare('UPDATE coordination_intents SET subject_sha256 = ?')
      .run(digest('tampered-subject'));
    db.exec(trigger.sql);
  });
  assertCode(
    () => prepare(record),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
  );

  const identity = createFixture('intent-identity-tamper');
  prepare(identity);
  withDatabase(identity.journalFile, db => {
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'trg_coordination_journal_identity_no_update'
    `).get();
    db.exec('DROP TRIGGER trg_coordination_journal_identity_no_update');
    db.prepare('UPDATE journal_identity SET created_at_observed = ? WHERE singleton_id = 1')
      .run('2026-08-28T03:00:00.001Z');
    db.exec(trigger.sql);
  });
  assertCode(
    () => prepare(identity),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INTEGRITY_INVALID'
  );

  const walProfile = createFixture('intent-wal-profile');
  prepare(walProfile);
  withDatabase(walProfile.journalFile, db => {
    assert.equal(String(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode).toLowerCase(),
      'wal');
  });
  assert.equal(fs.existsSync(`${walProfile.journalFile}-wal`), false);
  assert.equal(fs.existsSync(`${walProfile.journalFile}-shm`), false);
  assertCode(
    () => prepare(walProfile),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SCHEMA_INVALID'
  );
  withDatabase(walProfile.journalFile, db => {
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
      'wal');
    db.prepare('PRAGMA journal_mode = DELETE').get();
  });

  const sidecar = createFixture('intent-sidecar');
  prepare(sidecar);
  fs.writeFileSync(`${sidecar.journalFile}-wal`, 'test-only-invalid-wal', { mode: 0o600 });
  try {
    assertCode(
      () => prepare(sidecar),
      'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN'
    );
  } finally {
    fs.rmSync(`${sidecar.journalFile}-wal`, { force: true });
  }

  const copySource = createFixture('intent-context-source');
  prepare(copySource);
  const copyTarget = createFixture('intent-context-target');
  copyTarget.environment[coordination.JOURNAL_ID_ENV] =
    copySource.environment[coordination.JOURNAL_ID_ENV];
  fs.copyFileSync(copySource.journalFile, copyTarget.journalFile);
  assertCode(
    () => prepare(copyTarget),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_CONTEXT_MISMATCH'
  );

  const overlap = createFixture('intent-overlap');
  overlap.environment[coordination.JOURNAL_PARENT_ENV] = overlap.ledgerParent;
  overlap.environment[coordination.JOURNAL_FILE_ENV] =
    path.join(overlap.ledgerParent, coordination.JOURNAL_FILENAME);
  assertCode(
    () => prepare(overlap),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ROOT_UNSAFE'
  );
});

test('S18 核心路径在 synthetic 网络守卫下仍只做本地摘要准备', () => {
  const value = createFixture('intent-offline');
  const restore = installLoopbackOnlyNetwork();
  try {
    const result = prepare(value);
    assert.equal(result.operations.networkAccessPerformed, false);
    assert.equal(result.operations.externalSubmissionPerformed, false);
    assert.equal(result.operations.deploymentPerformed, false);
  } finally {
    restore();
  }
  const source = fs.readFileSync(supportFile, 'utf8');
  for (const forbidden of [
    "require('node:http')", "require('node:https')", "require('node:net')",
    "require('node:tls')", "require('node:child_process')", 'globalThis.fetch('
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test('S18 CLI help、ACK、canonical stdin 和脱敏错误保持稳定', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout,
    /^Usage: node scripts\/prepare-synthetic-authority-coordination-intent\.js/);
  assert.equal(help.stderr, '');

  const secret = 'synthetic-s18-cli-secret-must-not-appear';
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    WX_APPSECRET: secret
  };
  const failure = spawnSync(process.execPath, [cli], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: '{}',
    windowsHide: true,
    env: environment
  });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(
    failure.stderr,
    'Synthetic authority coordination intent preparation failed '
      + '(SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK_REQUIRED).\n'
  );
  assert.equal(failure.stderr.includes(secret), false);

  assert.deepEqual(
    coordination.decodeCanonicalInput(Buffer.from('{"schemaVersion":1}\n'), {}),
    { schemaVersion: 1 }
  );
  assertCode(
    () => coordination.decodeCanonicalInput(Buffer.from('{"schemaVersion":1}\n\n'), {}),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID'
  );
  assertCode(
    () => coordination.decodeCanonicalInput(
      Buffer.from(JSON.stringify({ value: secret })),
      { WX_APPSECRET: secret }
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_SENSITIVE_INPUT'
  );

  const strict = createFixture('intent-strict-schema');
  const extraTopLevel = { ...strict.intentDocument, submitted: false };
  assertCode(
    () => prepare(strict, extraTopLevel),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID'
  );
  const extraNested = structuredClone(strict.intentDocument);
  extraNested.authorizationConsumptionDocument.receiptSha256 = digest('caller-claimed-receipt');
  assertCode(
    () => prepare(strict, extraNested),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_INPUT_INVALID'
  );
  assert.equal(fs.existsSync(strict.journalFile), false);
});
