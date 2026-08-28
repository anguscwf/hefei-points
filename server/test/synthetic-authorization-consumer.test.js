const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const consumer = require('../../scripts/support/synthetic-authorization-consumer');
const externalApproval = require('../../scripts/support/synthetic-external-approval');

const projectRoot = path.resolve(__dirname, '..', '..');
const consumerModule = path.join(
  projectRoot,
  'scripts',
  'support',
  'synthetic-authorization-consumer.js'
);
const initializeCli = path.join(projectRoot, 'scripts', 'init-synthetic-authorization-ledger.js');
const consumeCli = path.join(projectRoot, 'scripts', 'consume-synthetic-deployment-grant.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-s17-consumer-'));
const FIXED_NOW = new Date('2026-08-28T03:00:00.000Z');
const FIXED_NOW_ISO = FIXED_NOW.toISOString();
const GENESIS_SEQUENCE = 10;

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestId(kind, label) {
  return `synthetic-${kind}-${digest(label).slice(0, 32)}`;
}

function sorted(values) {
  return [...values].sort();
}

function checkpointEnvelope(value, overrides = {}) {
  const baseline = {
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
    revokedKeyIds: [digest(`${value.label}:revoked-key:baseline`)],
    revokedPrincipalIdsSha256: [digest(`${value.label}:revoked-principal:baseline`)],
    revokedApprovalIdsSha256: [digest(`${value.label}:revoked-approval:baseline`)],
    revokedGrantIdsSha256: [digest(`${value.label}:revoked-grant:baseline`)]
  };
  return {
    ...baseline,
    ...overrides,
    revokedKeyIds: sorted(overrides.revokedKeyIds ?? baseline.revokedKeyIds),
    revokedPrincipalIdsSha256: sorted(
      overrides.revokedPrincipalIdsSha256 ?? baseline.revokedPrincipalIdsSha256
    ),
    revokedApprovalIdsSha256: sorted(
      overrides.revokedApprovalIdsSha256 ?? baseline.revokedApprovalIdsSha256
    ),
    revokedGrantIdsSha256: sorted(
      overrides.revokedGrantIdsSha256 ?? baseline.revokedGrantIdsSha256
    )
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
    revocationCheckpointSha256: consumer.canonicalHash(envelope),
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
  const checkpoint = overrides.checkpoint || value.genesisCheckpoint;
  const sourceCommit = overrides.sourceCommit || digest(`${label}:source-commit`);
  const implementationTreeSha256 = overrides.implementationTreeSha256
    || digest(`${label}:implementation-tree`);
  const configurationSha256 = overrides.configurationSha256
    || digest(`${label}:configuration`);
  const targetEnvironmentSha256 = overrides.targetEnvironmentSha256
    || value.environment[consumer.TARGET_ENVIRONMENT_ENV];
  const consumerIdSha256 = overrides.consumerIdSha256
    || value.environment[consumer.CONSUMER_ID_ENV];
  const subjectSha256 = overrides.subjectSha256 || digest(`${label}:subject`);
  const candidateBindingSha256 = overrides.candidateBindingSha256
    || digest(`${label}:candidate-binding`);
  return {
    signedRevocationCheckpoint: checkpoint,
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
        consumerIdSha256,
        targetEnvironmentSha256,
        subjectSha256,
        candidateBindingSha256,
        sourceCommit,
        implementationTreeSha256,
        configurationSha256,
        expiresAt: overrides.expiresAt || '2026-08-28T06:00:00.000Z'
      }
    }
  };
}

function fakeApprovalVerification(_environment, document, overrides = {}) {
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
    approvalEnvelopeSha256: consumer.canonicalHash(document.signedDeploymentApproval),
    grantIdSha256: digest(payload.grantId),
    grantEnvelopeSha256: consumer.canonicalHash(grant),
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
    childUseAuthorization: 'not_granted',
    ...overrides
  };
}

function consumeRequest(value, label, overrides = {}) {
  return {
    schemaVersion: 1,
    purpose: 'synthetic_local_grant_compare_and_consume',
    requestId: overrides.requestId || requestId('grant-consume', label),
    verificationDocument: overrides.verificationDocument
      || verificationDocument(value, label, overrides)
  };
}

function createFixture(label, { initialize = true } = {}) {
  const root = path.join(tempRoot, label);
  const ledgerParent = path.join(root, 'ledger');
  const dataRoot = path.join(root, 'synthetic-data');
  const policyParent = path.join(root, 'policy');
  fs.mkdirSync(ledgerParent, { recursive: true });
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(policyParent);
  const policyFile = path.join(policyParent, 'synthetic-trust-policy.json');
  fs.writeFileSync(policyFile, '{"testOnly":true}', { mode: 0o600 });
  const policyIdSha256 = digest(`${label}:policy-id`);
  const policySha256 = digest(`${label}:policy`);
  const authorityPrincipalIdSha256 = digest(`${label}:revocation-authority`);
  const environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    [consumer.INIT_ACK_ENV]: consumer.INIT_ACK,
    [consumer.CONSUME_ACK_ENV]: consumer.CONSUME_ACK,
    [consumer.LEDGER_FILE_ENV]: path.join(ledgerParent, consumer.LEDGER_FILENAME),
    [consumer.LEDGER_PARENT_ENV]: ledgerParent,
    [consumer.LEDGER_ID_ENV]: digest(`${label}:ledger-id`),
    [consumer.CONSUMER_ID_ENV]: digest(`${label}:consumer-id`),
    [consumer.TARGET_ENVIRONMENT_ENV]: digest(`${label}:target-environment`),
    SYNTHETIC_DATA_ROOT: dataRoot,
    SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT: policyParent,
    SYNTHETIC_APPROVAL_TRUST_POLICY_FILE: policyFile,
    SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256: policySha256
  };
  const value = {
    label,
    environment,
    ledgerParent,
    ledgerFile: environment[consumer.LEDGER_FILE_ENV],
    policyIdSha256,
    policySha256,
    authorityPrincipalIdSha256
  };
  value.genesisCheckpoint = checkpointEnvelope(value);
  value.initializationDocument = {
    schemaVersion: 1,
    purpose: 'synthetic_local_authorization_ledger_initialize',
    requestId: requestId('ledger-init', label),
    signedRevocationCheckpoint: value.genesisCheckpoint
  };
  if (initialize) initializeFixture(value);
  return value;
}

function initializeFixture(value, options = {}) {
  return consumer.initializeSyntheticAuthorizationLedgerForTest(
    value.environment,
    value.initializationDocument,
    {
      checkpointVerifier: fakeCheckpointVerification,
      now: FIXED_NOW,
      ...options
    }
  );
}

function consumeFixture(value, request, options = {}, environment = value.environment) {
  return consumer.consumeSyntheticDeploymentGrantForTest(environment, request, {
    checkpointVerifier: fakeCheckpointVerification,
    approvalVerifier: fakeApprovalVerification,
    now: FIXED_NOW,
    commitAt: FIXED_NOW,
    ...options
  });
}

function assertCode(work, code) {
  assert.throws(work, error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function withDatabase(value, work) {
  const db = new DatabaseSync(value.ledgerFile);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function rowCount(value, table) {
  return withDatabase(value, db => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function ledgerSnapshot(value) {
  const tables = [
    'ledger_identity',
    'revocation_checkpoints',
    'grant_consumptions',
    'grant_rejections',
    'ledger_blocks'
  ];
  const db = new DatabaseSync(value.ledgerFile, { readOnly: true });
  let counts;
  try {
    counts = Object.fromEntries(tables.map(table => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    ]));
  } finally {
    db.close();
  }
  const metadata = fs.statSync(value.ledgerFile, { bigint: true });
  return {
    bytes: fs.readFileSync(value.ledgerFile),
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    counts
  };
}

function assertLedgerUnchanged(value, before) {
  const after = ledgerSnapshot(value);
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(after.counts, before.counts);
}

function ledgerDirectoryEvidence(value) {
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
  visit(value.ledgerParent, '');
  return rows;
}

function mutateImmutableRow(value, triggerName, statement, parameters = []) {
  withDatabase(value, db => {
    const trigger = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
    ).get(triggerName);
    assert.equal(typeof trigger?.sql, 'string');
    db.exec(`DROP TRIGGER ${triggerName}`);
    db.prepare(statement).run(...parameters);
    db.exec(trigger.sql);
  });
}

test('S17 初始化只写独立本地账本，精确请求幂等重放且不伪称外部权威', () => {
  const value = createFixture('initialization-replay', { initialize: false });
  const created = initializeFixture(value);
  assert.equal(created.outcome, 'created');
  assert.equal(created.result, 'local-ledger-genesis-recorded');
  assert.equal(created.revocationCheckpointSequence, GENESIS_SEQUENCE);
  assert.equal(created.checks.testOnlyOverridesUsed, true);
  assert.equal(created.checks.trustPolicyExternallyAuthorizedByThisCommand, false);
  assert.equal(created.checks.trustedTimeVerified, false);
  assert.equal(created.checks.latestCheckpointExternallyConfirmed, false);
  assert.equal(created.checks.rollbackResistanceExternallyAnchored, false);
  assert.equal(created.checks.consumerIdentityExternallyAuthenticatedByThisCommand, false);
  assert.equal(created.checks.deploymentActionAtomicallyBound, false);
  assert.equal(created.deploymentAuthorization, 'not_granted');
  assert.equal(created.childUseAuthorization, 'not_granted');
  assert.equal(rowCount(value, 'ledger_identity'), 1);
  assert.equal(rowCount(value, 'revocation_checkpoints'), 1);
  assertCode(
    () => consumer.initializeSyntheticAuthorizationLedger(
      value.environment,
      value.initializationDocument
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED'
  );

  let replayVerificationCalls = 0;
  const replayed = initializeFixture(value, {
    checkpointVerifier(environment, envelope) {
      replayVerificationCalls += 1;
      return fakeCheckpointVerification(environment, envelope);
    }
  });
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(replayed.result, 'local-ledger-genesis-replayed');
  assert.equal(replayVerificationCalls, 1);
  assert.equal(rowCount(value, 'revocation_checkpoints'), 1);
});

test('S17 消费提交一次且精确重放在 verifier 前恢复同一 receipt', () => {
  const value = createFixture('consume-and-replay');
  const request = consumeRequest(value, 'consume-and-replay-request');
  const consumed = consumeFixture(value, request);
  assert.equal(consumed.outcome, 'consumed');
  assert.equal(consumed.result, 'local-single-use-record-committed');
  assert.equal(consumed.checks.grantSingleUseRecordCommitted, true);
  assert.equal(consumed.checks.trustedTimeVerified, false);
  assert.equal(consumed.checks.latestCheckpointExternallyConfirmed, false);
  assert.equal(consumed.checks.rollbackResistanceExternallyAnchored, false);
  assert.equal(consumed.checks.globalConsumptionVerified, false);
  assert.equal(consumed.checks.externalDeploymentAtomicityVerified, false);
  assert.equal(consumed.deploymentAuthorization, 'not_granted');
  assert.equal(consumed.childUseAuthorization, 'not_granted');
  assertCode(
    () => consumer.consumeSyntheticDeploymentGrant(value.environment, request),
    'SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED'
  );

  const replayed = consumeFixture(value, request, {
    checkpointVerifier() {
      assert.fail('消费精确重放不应再次调用 checkpoint verifier');
    },
    approvalVerifier() {
      assert.fail('消费精确重放不应再次调用 approval verifier');
    }
  });
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(replayed.receiptSha256, consumed.receiptSha256);
  assert.equal(replayed.checks.historicalReceiptRecovered, true);
  assert.equal(replayed.checks.testOnlyOverridesUsed, true);
  assert.equal(replayed.checks.currentLedgerHeadRevalidatedForThisCall, false);
  assert.equal(replayed.checks.finalRevocationCheckedAgainstLocalLedgerHead, false);
  assert.equal(replayed.checks.grantCompareAndConsumeAtomicLocallyForThisCall, false);
  assert.equal(replayed.checks.grantSingleUseRecordCommitted, true);
  assert.equal(rowCount(value, 'grant_consumptions'), 1);
});

test('S17 只读 API 仅恢复精确历史 receipt 且生产与 test provenance 隔离', () => {
  const value = createFixture('read-only-receipt-recovery');
  const request = consumeRequest(value, 'read-only-receipt-recovery-request');
  const consumed = consumeFixture(value, request);
  const before = ledgerSnapshot(value);

  const recovered = consumer.recoverSyntheticAuthorizationReceiptForTest(
    value.environment,
    request
  );
  assert.equal(recovered.outcome, 'replayed');
  assert.equal(recovered.result, 'local-single-use-record-replayed');
  assert.equal(recovered.receiptSha256, consumed.receiptSha256);
  assert.equal(recovered.checks.historicalReceiptRecovered, true);
  assert.equal(recovered.checks.currentLedgerHeadRevalidatedForThisCall, false);
  assert.equal(recovered.checks.externalApprovalRevalidatedForNewConsumption, false);
  assert.equal(recovered.operations.localAuthorizationLedgerWritten, false);
  assert.equal(recovered.operations.networkAccessPerformed, false);
  assert.equal(recovered.operations.deploymentPerformed, false);
  assert.equal(recovered.deploymentAuthorization, 'not_granted');

  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceipt(value.environment, request),
    'SYNTHETIC_AUTHORIZATION_LEDGER_TEST_ONLY_STATE_REJECTED'
  );
  const missing = consumeRequest(value, 'read-only-receipt-recovery-missing');
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      value.environment,
      missing
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_HISTORICAL_RECEIPT_REQUIRED'
  );
  const conflicting = {
    ...request,
    verificationDocument: verificationDocument(
      value,
      'read-only-receipt-recovery-conflicting-fingerprint'
    )
  };
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      value.environment,
      conflicting
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT'
  );
  assertLedgerUnchanged(value, before);
});

test('S17 只读 recovery 在 SQLite open 前拒绝无 sidecar 的持久 WAL header 且目录零变化', () => {
  const value = createFixture('read-only-wal-header');
  const request = consumeRequest(value, 'read-only-wal-header-request');
  consumeFixture(value, request);
  withDatabase(value, db => {
    assert.equal(
      String(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode).toLowerCase(),
      'wal'
    );
  });
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.ledgerFile}${suffix}`), false, suffix);
  }
  const header = fs.readFileSync(value.ledgerFile);
  assert.equal(header[18], 2);
  assert.equal(header[19], 2);
  const before = ledgerDirectoryEvidence(value);
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      value.environment,
      request
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID'
  );
  assert.deepEqual(ledgerDirectoryEvidence(value), before);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(fs.existsSync(`${value.ledgerFile}${suffix}`), false, suffix);
  }

  const source = fs.readFileSync(consumerModule, 'utf8');
  const recoveryStart = source.indexOf(
    'function recoverSyntheticAuthorizationReceiptInternal(environment, document, options)'
  );
  const recoveryEnd = source.indexOf(
    'function recoverSyntheticAuthorizationReceipt(environment',
    recoveryStart
  );
  const recoverySource = source.slice(recoveryStart, recoveryEnd);
  const heldOpen = recoverySource.indexOf('openHeldLedger(context)');
  const sqliteOpen = recoverySource.indexOf(
    'new DatabaseSync(context.filename, { readOnly: true })'
  );
  assert.ok(heldOpen >= 0 && sqliteOpen > heldOpen);
  assert.match(source, /function readHeldLedgerDigest\(descriptor, expectedMetadata\)/);
  const heldFunctionStart = source.indexOf('function openHeldLedger(context)');
  const heldFunctionEnd = source.indexOf(
    'function assertPathMatchesHeldLedger(context, held)',
    heldFunctionStart
  );
  const heldSource = source.slice(heldFunctionStart, heldFunctionEnd);
  assert.match(heldSource, /readHeldLedgerDigest\(descriptor, metadata\)/);
  assert.match(source, /buffer\[18\] !== 1 \|\| buffer\[19\] !== 1/);
  assert.match(recoverySource, /db\.exec\('BEGIN'\)/);
  assert.equal(recoverySource.includes('BEGIN IMMEDIATE'), false);
  const transactionSource = recoverySource.slice(
    recoverySource.indexOf("db.exec('BEGIN')"),
    recoverySource.indexOf("db.exec('COMMIT')")
  );
  assert.ok(
    (transactionSource.match(/assertPathMatchesHeldLedger\(context, held\)/g) || [])
      .length >= 2
  );
  const configureStart = source.indexOf('function configureReadOnlyDatabase(db)');
  const configureEnd = source.indexOf('function createLedgerSchema(db)', configureStart);
  const configureSource = source.slice(configureStart, configureEnd);
  assert.match(configureSource, /PRAGMA query_only = ON/);
  assert.match(configureSource, /PRAGMA temp_store = MEMORY/);
  assert.match(configureSource, /tempStore\.temp_store !== 2/);
  assert.equal(configureSource.includes('journal_mode = DELETE'), false);
});

test('S17 只读 API 恢复稳定 rejection，拒绝 sidecar 与跨表 request 歧义', () => {
  const rejected = createFixture('read-only-rejection-recovery');
  const rejectedRequest = consumeRequest(rejected, 'read-only-rejection-recovery-request', {
    consumerIdSha256: digest('read-only-rejection-recovery:wrong-consumer')
  });
  assertCode(
    () => consumeFixture(rejected, rejectedRequest),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMER_MISMATCH'
  );
  const rejectedBefore = ledgerSnapshot(rejected);
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      rejected.environment,
      rejectedRequest
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMER_MISMATCH'
  );
  assertLedgerUnchanged(rejected, rejectedBefore);

  const externallyRejected = createFixture('read-only-external-rejection-recovery');
  const externalRequest = consumeRequest(
    externallyRejected,
    'read-only-external-rejection-recovery-request'
  );
  const externalCode = 'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED';
  assertCode(
    () => consumeFixture(externallyRejected, externalRequest, {
      approvalVerifier() {
        throw new externalApproval.SyntheticExternalApprovalError(externalCode);
      }
    }),
    externalCode
  );
  const externallyRejectedBefore = ledgerSnapshot(externallyRejected);
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      externallyRejected.environment,
      externalRequest
    ),
    externalCode
  );
  assertLedgerUnchanged(externallyRejected, externallyRejectedBefore);

  const sidecars = createFixture('read-only-recovery-sidecars');
  const sidecarRequest = consumeRequest(sidecars, 'read-only-recovery-sidecars-request');
  consumeFixture(sidecars, sidecarRequest);
  for (const [suffix, code] of [
    ['-journal', 'SYNTHETIC_AUTHORIZATION_LEDGER_BUSY'],
    ['-wal', 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'],
    ['-shm', 'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN']
  ]) {
    const sidecar = `${sidecars.ledgerFile}${suffix}`;
    const marker = Buffer.from(`test-only-sidecar:${suffix}`);
    fs.writeFileSync(sidecar, marker);
    assertCode(
      () => consumer.recoverSyntheticAuthorizationReceiptForTest(
        sidecars.environment,
        sidecarRequest
      ),
      code
    );
    assert.deepEqual(fs.readFileSync(sidecar), marker);
    fs.unlinkSync(sidecar);
  }

  const ambiguous = createFixture('read-only-recovery-ambiguous-request');
  const ambiguousRequest = consumeRequest(
    ambiguous,
    'read-only-recovery-ambiguous-request'
  );
  consumeFixture(ambiguous, ambiguousRequest);
  withDatabase(ambiguous, db => {
    const consumption = db.prepare(`
      SELECT request_id_sha256, request_fingerprint_sha256, checkpoint_sha256
      FROM grant_consumptions
      LIMIT 1
    `).get();
    const rejection = {
      schemaVersion: 1,
      purpose: 'synthetic-local-grant-rejection-record',
      requestIdSha256: consumption.request_id_sha256,
      requestFingerprintSha256: consumption.request_fingerprint_sha256,
      checkpointSha256: consumption.checkpoint_sha256,
      stableErrorCode: 'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED',
      recordedAtObserved: FIXED_NOW_ISO
    };
    db.prepare(`
      INSERT INTO grant_rejections(
        request_id_sha256, request_fingerprint_sha256, checkpoint_sha256,
        stable_error_code, rejection_record_sha256, recorded_at_observed
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      rejection.requestIdSha256,
      rejection.requestFingerprintSha256,
      rejection.checkpointSha256,
      rejection.stableErrorCode,
      consumer.canonicalHash(rejection),
      rejection.recordedAtObserved
    );
  });
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      ambiguous.environment,
      ambiguousRequest
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
  );
});

test('S17 同 grant 新 request 被拒绝，同 request 不同指纹稳定冲突', () => {
  const grantValue = createFixture('same-grant-new-request');
  const original = consumeRequest(grantValue, 'same-grant-original');
  consumeFixture(grantValue, original);
  const newRequest = {
    ...original,
    requestId: requestId('grant-consume', 'same-grant-second-request')
  };
  assertCode(
    () => consumeFixture(grantValue, newRequest),
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );
  assert.equal(rowCount(grantValue, 'grant_rejections'), 1);
  assertCode(
    () => consumeFixture(grantValue, newRequest, {
      checkpointVerifier() {
        assert.fail('持久 rejection 的精确重放不应再次调用 verifier');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );
  assert.equal(rowCount(grantValue, 'grant_consumptions'), 1);

  const conflictValue = createFixture('same-request-conflict');
  const first = consumeRequest(conflictValue, 'same-request-conflict-original');
  consumeFixture(conflictValue, first);
  const changed = structuredClone(first);
  changed.verificationDocument.signedDeploymentApproval.nonce = digest('changed approval');
  assertCode(
    () => consumeFixture(conflictValue, changed, {
      checkpointVerifier() {
        assert.fail('幂等键冲突应在 verifier 前拒绝');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT'
  );
  assert.equal(rowCount(conflictValue, 'grant_consumptions'), 1);
});

test('S17 有效新 checkpoint 即使 bundle 被拒也推进并稳定绑定 rejection', () => {
  const value = createFixture('checkpoint-advance-rejection');
  const next = checkpointEnvelope(value, {
    nonce: 'advance-then-reject',
    sequence: GENESIS_SEQUENCE + 1,
    issuedAt: '2026-08-28T02:30:00.000Z'
  });
  const request = consumeRequest(value, 'checkpoint-advance-rejection-request', {
    checkpoint: next
  });
  const revoked = 'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED';
  assertCode(
    () => consumeFixture(value, request, {
      approvalVerifier() {
        throw new externalApproval.SyntheticExternalApprovalError(revoked);
      }
    }),
    revoked
  );
  assert.equal(rowCount(value, 'revocation_checkpoints'), 2);
  assert.equal(rowCount(value, 'grant_rejections'), 1);
  assert.equal(rowCount(value, 'grant_consumptions'), 0);
  assertCode(
    () => consumeFixture(value, request, {
      checkpointVerifier() {
        assert.fail('持久 external rejection 的精确重放不应再次调用 verifier');
      }
    }),
    revoked
  );
  const changed = structuredClone(request);
  changed.verificationDocument.signedDeploymentApproval.nonce = digest('changed-rejection');
  assertCode(
    () => consumeFixture(value, changed),
    'SYNTHETIC_AUTHORIZATION_LEDGER_IDEMPOTENCY_CONFLICT'
  );
});

test('S17 使用 checkpoint/policy/key 的最早有效期并在初始化提交前复核', () => {
  const value = createFixture('effective-checkpoint-expiry', { initialize: false });
  const effectiveValidUntil = '2026-08-28T03:10:00.000Z';
  assertCode(
    () => initializeFixture(value, {
      now: new Date('2026-08-28T03:15:00.000Z'),
      checkpointVerifier(environment, envelope) {
        return {
          ...fakeCheckpointVerification(environment, envelope),
          validUntil: effectiveValidUntil
        };
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED'
  );
  assert.equal(fs.existsSync(value.ledgerFile), false);

  const atBoundary = createFixture('effective-checkpoint-expiry-at-commit', {
    initialize: false
  });
  assertCode(
    () => initializeFixture(atBoundary, {
      now: new Date('2026-08-28T03:05:00.000Z'),
      commitAt: new Date(effectiveValidUntil),
      checkpointVerifier(environment, envelope) {
        return {
          ...fakeCheckpointVerification(environment, envelope),
          validUntil: effectiveValidUntil
        };
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED'
  );
  assert.equal(fs.existsSync(atBoundary.ledgerFile), false);

  const beforeBoundary = createFixture('effective-checkpoint-expiry-before-commit', {
    initialize: false
  });
  let successfulVerifierCalls = 0;
  const created = initializeFixture(beforeBoundary, {
    now: new Date('2026-08-28T03:05:00.000Z'),
    commitAt: new Date('2026-08-28T03:09:59.999Z'),
    checkpointVerifier(environment, envelope) {
      successfulVerifierCalls += 1;
      return {
        ...fakeCheckpointVerification(environment, envelope),
        validUntil: effectiveValidUntil
      };
    }
  });
  assert.equal(created.outcome, 'created');
  assert.equal(successfulVerifierCalls, 2);

  const drift = createFixture('checkpoint-second-verification-drift', {
    initialize: false
  });
  let driftVerifierCalls = 0;
  assertCode(
    () => initializeFixture(drift, {
      now: new Date('2026-08-28T03:05:00.000Z'),
      commitAt: new Date('2026-08-28T03:06:00.000Z'),
      checkpointVerifier(environment, envelope) {
        driftVerifierCalls += 1;
        const result = fakeCheckpointVerification(environment, envelope);
        return driftVerifierCalls === 1
          ? result
          : { ...result, validUntil: '2026-08-28T03:20:00.000Z' };
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_VERIFICATION_FAILED'
  );
  assert.equal(driftVerifierCalls, 2);
  assert.equal(fs.existsSync(drift.ledgerFile), false);
});

test('S17 消费在 checkpoint 或 bundle 有效期边界原子拒绝并稳定重放', () => {
  const bundle = createFixture('consume-bundle-expiry-boundary');
  const bundleRequest = consumeRequest(bundle, 'consume-bundle-expiry-boundary-request', {
    expiresAt: '2026-08-28T03:10:00.000Z'
  });
  assertCode(
    () => consumeFixture(bundle, bundleRequest, {
      commitAt: new Date('2026-08-28T03:10:00.000Z')
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED'
  );
  assert.equal(rowCount(bundle, 'grant_consumptions'), 0);
  assert.equal(rowCount(bundle, 'grant_rejections'), 1);
  assertCode(
    () => consumeFixture(bundle, bundleRequest, {
      checkpointVerifier() {
        assert.fail('过期 rejection 精确重放不应再次调用 verifier');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED'
  );

  const checkpoint = createFixture('consume-checkpoint-expiry-boundary');
  const checkpointRequest = consumeRequest(
    checkpoint,
    'consume-checkpoint-expiry-boundary-request'
  );
  const checkpointValidUntil = '2026-08-28T03:10:00.000Z';
  assertCode(
    () => consumeFixture(checkpoint, checkpointRequest, {
      commitAt: new Date(checkpointValidUntil),
      checkpointVerifier(environment, envelope) {
        return {
          ...fakeCheckpointVerification(environment, envelope),
          validUntil: checkpointValidUntil
        };
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_AUTHORIZATION_EXPIRED'
  );
  assert.equal(rowCount(checkpoint, 'grant_consumptions'), 0);
  assert.equal(rowCount(checkpoint, 'grant_rejections'), 1);

  const before = createFixture('consume-expiry-before-boundary');
  const beforeRequest = consumeRequest(before, 'consume-expiry-before-boundary-request', {
    expiresAt: '2026-08-28T03:10:00.000Z'
  });
  assert.equal(consumeFixture(before, beforeRequest, {
    commitAt: new Date('2026-08-28T03:09:59.999Z')
  }).outcome, 'consumed');
});

test('S17 checkpoint rollback/gap 不推进账本，严格 +1 且累计撤销集合可提交', () => {
  const value = createFixture('checkpoint-monotonic');
  const rollback = checkpointEnvelope(value, {
    nonce: 'rollback',
    sequence: GENESIS_SEQUENCE - 1,
    issuedAt: '2026-08-28T02:10:00.000Z'
  });
  assertCode(
    () => consumeFixture(value, consumeRequest(value, 'checkpoint-rollback', {
      checkpoint: rollback
    })),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_ROLLBACK'
  );
  const gap = checkpointEnvelope(value, {
    nonce: 'gap',
    sequence: GENESIS_SEQUENCE + 2,
    issuedAt: '2026-08-28T02:20:00.000Z'
  });
  assertCode(
    () => consumeFixture(value, consumeRequest(value, 'checkpoint-gap', { checkpoint: gap })),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_GAP'
  );
  const issuedAtRollback = checkpointEnvelope(value, {
    nonce: 'issued-at-rollback',
    sequence: GENESIS_SEQUENCE + 1,
    issuedAt: '2026-08-28T01:59:59.000Z'
  });
  assertCode(
    () => consumeFixture(value, consumeRequest(value, 'checkpoint-issued-at-rollback', {
      checkpoint: issuedAtRollback
    })),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_ROLLBACK'
  );
  assert.equal(rowCount(value, 'revocation_checkpoints'), 1);

  const next = checkpointEnvelope(value, {
    nonce: 'strict-next',
    sequence: GENESIS_SEQUENCE + 1,
    issuedAt: '2026-08-28T02:30:00.000Z',
    revokedKeyIds: [
      ...value.genesisCheckpoint.revokedKeyIds,
      digest('checkpoint-monotonic:new-revoked-key')
    ]
  });
  const result = consumeFixture(
    value,
    consumeRequest(value, 'checkpoint-strict-next', { checkpoint: next })
  );
  assert.equal(result.revocationCheckpointSequence, GENESIS_SEQUENCE + 1);
  assert.equal(rowCount(value, 'revocation_checkpoints'), 2);
  assert.equal(rowCount(value, 'grant_consumptions'), 1);
});

test('S17 同序列不同摘要形成 fork 后永久封锁本地账本', () => {
  const value = createFixture('checkpoint-fork');
  const fork = checkpointEnvelope(value, { nonce: 'forked-same-sequence' });
  assert.notEqual(
    consumer.canonicalHash(fork),
    consumer.canonicalHash(value.genesisCheckpoint)
  );
  assertCode(
    () => consumeFixture(value, consumeRequest(value, 'checkpoint-fork-first', {
      checkpoint: fork
    })),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK'
  );
  assert.equal(rowCount(value, 'ledger_blocks'), 1);
  assertCode(
    () => consumeFixture(value, consumeRequest(value, 'checkpoint-fork-blocked')),
    'SYNTHETIC_AUTHORIZATION_LEDGER_BLOCKED'
  );
});

test('S17 任一累计撤销集合在 +1 checkpoint 回退都会封锁账本', () => {
  for (const field of [
    'revokedKeyIds',
    'revokedPrincipalIdsSha256',
    'revokedApprovalIdsSha256',
    'revokedGrantIdsSha256'
  ]) {
    const value = createFixture(`revocation-removal-${field.toLowerCase()}`);
    const checkpoint = checkpointEnvelope(value, {
      nonce: `remove-${field}`,
      sequence: GENESIS_SEQUENCE + 1,
      issuedAt: '2026-08-28T02:30:00.000Z',
      [field]: []
    });
    assertCode(
      () => consumeFixture(value, consumeRequest(value, `revocation-removal-${field}`, {
        checkpoint
      })),
      'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_REVOCATION_REMOVED'
    );
    assert.equal(rowCount(value, 'ledger_blocks'), 1, field);
  }
});

test('S17 policy/consumer/target 与候选目标元组均隔离并 fail closed', () => {
  const policy = createFixture('isolation-policy');
  const policyRequest = consumeRequest(policy, 'isolation-policy-request');
  assertCode(
    () => consumeFixture(policy, policyRequest, {
      approvalVerifier(environment, document) {
        return fakeApprovalVerification(environment, document, {
          trustPolicyIdSha256: digest('different-policy-id')
        });
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_MISMATCH'
  );

  const rotation = createFixture('isolation-policy-rotation');
  const rotatedPolicySha256 = digest('rotated-policy-sha');
  const changedPolicyEnvironment = {
    ...rotation.environment,
    SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256: rotatedPolicySha256
  };
  const rotatedCheckpoint = checkpointEnvelope(rotation, {
    nonce: 'rotated-policy',
    policyRevision: 2
  });
  assertCode(
    () => consumeFixture(
      rotation,
      consumeRequest(rotation, 'isolation-policy-context-change'),
      {},
      changedPolicyEnvironment
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED'
  );
  assertCode(
    () => consumeFixture(
      rotation,
      consumeRequest(rotation, 'isolation-policy-rotation-request', {
        checkpoint: rotatedCheckpoint
      })
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_POLICY_ROTATION_REQUIRED'
  );

  for (const [field, environmentName] of [
    ['consumerIdSha256', consumer.CONSUMER_ID_ENV],
    ['targetEnvironmentSha256', consumer.TARGET_ENVIRONMENT_ENV]
  ]) {
    const value = createFixture(`isolation-verifier-${field.toLowerCase()}`);
    const request = consumeRequest(value, `isolation-verifier-${field}`, {
      [field]: digest(`forged-${field}`)
    });
    assertCode(
      () => consumeFixture(value, request),
      field === 'consumerIdSha256'
        ? 'SYNTHETIC_AUTHORIZATION_LEDGER_CONSUMER_MISMATCH'
        : 'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_MISMATCH'
    );
    const changedEnvironment = {
      ...value.environment,
      [environmentName]: digest(`different-ledger-${field}`)
    };
    assertCode(
      () => consumeFixture(value, consumeRequest(value, `isolation-context-${field}`), {},
        changedEnvironment),
      'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH'
    );
  }

  const target = createFixture('isolation-target-tuple');
  const first = consumeRequest(target, 'target-tuple-first');
  consumeFixture(target, first);
  const firstPayload = first.verificationDocument.signedDeploymentGrant.payload;
  const second = consumeRequest(target, 'target-tuple-second', {
    sourceCommit: firstPayload.sourceCommit,
    implementationTreeSha256: firstPayload.implementationTreeSha256,
    configurationSha256: firstPayload.configurationSha256
  });
  assertCode(
    () => consumeFixture(target, second),
    'SYNTHETIC_AUTHORIZATION_LEDGER_TARGET_ALREADY_CONSUMED'
  );
});

test('S17 初始化事务在 commit 前可安全重试，commit 后只返回结果未知并可精确恢复', () => {
  const before = createFixture('init-fault-before-commit', { initialize: false });
  assertCode(
    () => initializeFixture(before, {
      fault(stage) {
        if (stage === 'before_commit') throw new Error('test-only init fault before commit');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_TRANSACTION_FAILED'
  );
  assert.equal(fs.existsSync(before.ledgerFile), false);
  assert.equal(initializeFixture(before).outcome, 'created');

  const afterCommit = createFixture('init-fault-after-commit', { initialize: false });
  assertCode(
    () => initializeFixture(afterCommit, {
      fault(stage) {
        if (stage === 'after_commit') throw new Error('test-only init fault after commit');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
  );
  assert.equal(fs.existsSync(afterCommit.ledgerFile), true);
  assert.equal(initializeFixture(afterCommit).outcome, 'replayed');
  assert.equal(rowCount(afterCommit, 'ledger_identity'), 1);
});

test('S17 消费 commit 前故障完整回滚，commit 后结果未知可由同请求恢复', () => {
  for (const stage of ['before_consumption', 'after_consumption']) {
    const value = createFixture(`consume-fault-${stage.replaceAll('_', '-')}`);
    const request = consumeRequest(value, `consume-fault-${stage}`);
    assertCode(
      () => consumeFixture(value, request, {
        fault(actual) {
          if (actual === stage) throw new Error(`test-only fault ${stage}`);
        }
      }),
      'SYNTHETIC_AUTHORIZATION_LEDGER_TRANSACTION_FAILED'
    );
    assert.equal(rowCount(value, 'grant_consumptions'), 0, stage);
    assert.equal(consumeFixture(value, request).outcome, 'consumed', stage);
  }

  const value = createFixture('consume-fault-after-commit');
  const request = consumeRequest(value, 'consume-fault-after-commit-request');
  assertCode(
    () => consumeFixture(value, request, {
      fault(stage) {
        if (stage === 'after_commit') throw new Error('test-only fault after commit');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
  );
  assert.equal(rowCount(value, 'grant_consumptions'), 1);
  const replay = consumeFixture(value, request);
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.checks.historicalReceiptRecovered, true);
});

test('S17 schema 与 checkpoint/receipt 记录篡改在使用前被完整性检查拒绝', () => {
  const schema = createFixture('tamper-schema');
  withDatabase(schema, db => db.exec('DROP TRIGGER trg_ledger_block_no_delete'));
  assertCode(
    () => consumeFixture(schema, consumeRequest(schema, 'tamper-schema-request')),
    'SYNTHETIC_AUTHORIZATION_LEDGER_SCHEMA_INVALID'
  );

  const receipt = createFixture('tamper-receipt');
  const receiptRequest = consumeRequest(receipt, 'tamper-receipt-request');
  consumeFixture(receipt, receiptRequest);
  mutateImmutableRow(
    receipt,
    'trg_grant_consumption_no_update',
    'UPDATE grant_consumptions SET subject_sha256 = ?',
    [digest('tampered stored subject')]
  );
  assertCode(
    () => consumeFixture(receipt, receiptRequest),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
  );

  const checkpoint = createFixture('tamper-checkpoint-record');
  mutateImmutableRow(
    checkpoint,
    'trg_revocation_checkpoint_no_update',
    'UPDATE revocation_checkpoints SET revoked_key_ids_json = ?',
    ['[]']
  );
  assertCode(
    () => initializeFixture(checkpoint),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
  );

  const rejection = createFixture('tamper-rejection-record');
  const accepted = consumeRequest(rejection, 'tamper-rejection-accepted');
  consumeFixture(rejection, accepted);
  const rejected = {
    ...accepted,
    requestId: requestId('grant-consume', 'tamper-rejection-rejected')
  };
  assertCode(
    () => consumeFixture(rejection, rejected),
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );
  mutateImmutableRow(
    rejection,
    'trg_grant_rejection_no_update',
    'UPDATE grant_rejections SET recorded_at_observed = ?',
    ['2026-08-28T03:00:00.001Z']
  );
  assertCode(
    () => consumeFixture(rejection, rejected),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
  );

  const block = createFixture('tamper-block-record');
  const fork = checkpointEnvelope(block, { nonce: 'tamper-block-fork' });
  assertCode(
    () => consumeFixture(block, consumeRequest(block, 'tamper-block-fork-request', {
      checkpoint: fork
    })),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK'
  );
  mutateImmutableRow(
    block,
    'trg_ledger_block_no_update',
    'UPDATE ledger_blocks SET observed_at = ?',
    ['2026-08-28T03:00:00.001Z']
  );
  assertCode(
    () => consumeFixture(block, consumeRequest(block, 'tamper-block-after-change')),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INTEGRITY_INVALID'
  );
});

test('S17 禁止 WAL/SHM sidecar 且跨 context 文件复制 fail closed', () => {
  const sidecar = createFixture('sidecar-rejected');
  for (const suffix of ['-wal', '-shm']) {
    const filename = `${sidecar.ledgerFile}${suffix}`;
    fs.writeFileSync(filename, 'synthetic-test-only-sidecar', { mode: 0o600 });
    try {
      assertCode(
        () => consumeFixture(sidecar, consumeRequest(sidecar, `sidecar-${suffix.slice(1)}`)),
        'SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN'
      );
    } finally {
      fs.rmSync(filename, { force: true });
    }
  }

  const source = createFixture('context-copy-source');
  const copy = createFixture('context-copy-target', { initialize: false });
  copy.environment[consumer.LEDGER_ID_ENV] = source.environment[consumer.LEDGER_ID_ENV];
  copy.environment[consumer.CONSUMER_ID_ENV] = source.environment[consumer.CONSUMER_ID_ENV];
  copy.environment[consumer.TARGET_ENVIRONMENT_ENV] =
    source.environment[consumer.TARGET_ENVIRONMENT_ENV];
  copy.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256 = source.policySha256;
  fs.copyFileSync(source.ledgerFile, copy.ledgerFile);
  assertCode(
    () => consumeFixture(copy, consumeRequest(copy, 'context-copy-request')),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CONTEXT_MISMATCH'
  );
});

test('S17 CLI help、ACK 失败与 canonical stdin 保持稳定且脱敏', () => {
  for (const cli of [initializeCli, consumeCli]) {
    const help = spawnSync(process.execPath, [cli, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: npm run /);
    assert.equal(help.stderr, '');
  }

  const secret = 'synthetic-cli-secret-must-not-appear';
  const baseEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    WX_APPSECRET: secret
  };
  for (const [cli, operation, ackCode] of [
    [initializeCli, 'initialization', 'SYNTHETIC_AUTHORIZATION_LEDGER_ACK_REQUIRED'],
    [consumeCli, 'consumption', 'SYNTHETIC_AUTHORIZATION_LEDGER_ACK_REQUIRED']
  ]) {
    const failure = spawnSync(process.execPath, [cli], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: '{}',
      windowsHide: true,
      env: baseEnvironment
    });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.equal(
      failure.stderr,
      `Synthetic authorization ledger ${operation} failed (${ackCode}).\n`
    );
    assert.equal(failure.stderr.includes(secret), false);

    const sensitive = spawnSync(process.execPath, [cli], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: JSON.stringify({ value: secret }),
      windowsHide: true,
      env: baseEnvironment
    });
    assert.equal(sensitive.status, 1);
    assert.match(sensitive.stderr, /SYNTHETIC_AUTHORIZATION_LEDGER_SENSITIVE_INPUT/);
    assert.equal(sensitive.stderr.includes(secret), false);

    const nonCanonical = spawnSync(process.execPath, [cli], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: '{}\n\n',
      windowsHide: true,
      env: baseEnvironment
    });
    assert.equal(nonCanonical.status, 1);
    assert.match(nonCanonical.stderr, /SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID/);
    assert.equal(nonCanonical.stderr.includes(secret), false);
  }

  assert.deepEqual(
    consumer.decodeCanonicalInput(Buffer.from('{"schemaVersion":1}\n'), {}),
    { schemaVersion: 1 }
  );
  assertCode(
    () => consumer.decodeCanonicalInput(Buffer.from('{"schemaVersion":1}\n\n'), {}),
    'SYNTHETIC_AUTHORIZATION_LEDGER_INPUT_INVALID'
  );
  assertCode(
    () => consumer.decodeCanonicalInput(
      Buffer.from(JSON.stringify({ value: secret })),
      { WX_APPSECRET: secret }
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_SENSITIVE_INPUT'
  );
});

const CHILD_CONSUMER = String.raw`
const fs = require('node:fs');
const consumer = require(process.env.S17_CONSUMER_MODULE);
const value = JSON.parse(process.env.S17_CONSUMER_CASE);
try {
  const result = consumer.consumeSyntheticDeploymentGrantForTest(
    value.environment,
    value.request,
    {
      checkpointVerifier() { return value.checkpointVerification; },
      approvalVerifier() { return value.approvalVerification; },
      now: new Date(value.now),
      commitAt: new Date(value.commitAt),
      fault(stage) {
        if (stage === 'after_begin' && value.holdMarker) {
          fs.writeFileSync(value.holdMarker, 'writer-lock-held', { flag: 'wx' });
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

function runConsumerProcess(value, request, options = {}) {
  const document = request.verificationDocument;
  const payload = {
    environment: value.environment,
    request,
    checkpointVerification: fakeCheckpointVerification(
      value.environment,
      document.signedRevocationCheckpoint
    ),
    approvalVerification: fakeApprovalVerification(value.environment, document),
    now: FIXED_NOW_ISO,
    commitAt: FIXED_NOW_ISO,
    holdMarker: options.holdMarker || ''
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_CONSUMER], {
      cwd: projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        S17_CONSUMER_MODULE: consumerModule,
        S17_CONSUMER_CASE: JSON.stringify(payload)
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
        reject(new Error(`consumer child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`consumer child returned invalid JSON: ${stdout}\n${stderr}`, {
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

const HOT_JOURNAL_WRITER = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.S17_LEDGER_FILE);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA synchronous = FULL');
db.exec('PRAGMA cache_size = 1');
db.exec('BEGIN IMMEDIATE');
db.exec('DROP TRIGGER trg_ledger_identity_no_update');
db.prepare('UPDATE ledger_identity SET created_at_observed = ? WHERE singleton_id = 1')
  .run('2026-08-28T03:00:00.001Z');
const insert = db.prepare(
  'INSERT INTO ledger_blocks(block_sha256,reason_code,presented_checkpoint_sequence,'
  + 'presented_checkpoint_sha256,observed_at) VALUES (?,?,?,?,?)'
);
for (let index = 0; index < 5000; index += 1) {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  insert.run(
    hash('hot-block-' + index),
    'SYNTHETIC_AUTHORIZATION_LEDGER_CHECKPOINT_FORK',
    index + 1,
    hash('hot-checkpoint-' + index),
    '2026-08-28T03:00:00.001Z'
  );
}
fs.writeFileSync(process.env.S17_HOT_MARKER, 'hot-journal-ready', { flag: 'wx' });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
`;

test('S17 可写排他入口恢复真实 hot DELETE journal 后再完整验证与消费', async () => {
  const value = createFixture('hot-journal-recovery');
  const historicalRequest = consumeRequest(
    value,
    'hot-journal-recovery-historical-receipt'
  );
  const historicalReceipt = consumeFixture(value, historicalRequest);
  const marker = path.join(value.ledgerParent, 'hot-journal-ready.marker');
  const child = spawn(process.execPath, ['-e', HOT_JOURNAL_WRITER], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      S17_LEDGER_FILE: value.ledgerFile,
      S17_HOT_MARKER: marker
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForFile(marker);
  assert.equal(fs.existsSync(`${value.ledgerFile}-journal`), true);

  const liveBytes = {
    main: fs.readFileSync(value.ledgerFile),
    journal: fs.readFileSync(`${value.ledgerFile}-journal`)
  };
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      value.environment,
      historicalRequest
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_BUSY'
  );
  assert.deepEqual(fs.readFileSync(value.ledgerFile), liveBytes.main);
  assert.deepEqual(
    fs.readFileSync(`${value.ledgerFile}-journal`),
    liveBytes.journal
  );

  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(child.kill('SIGKILL'), true);
  const exit = await closed;
  assert.notEqual(exit.code, 0, stderr);
  assert.equal(fs.existsSync(`${value.ledgerFile}-journal`), true);

  const crashedBytes = {
    main: fs.readFileSync(value.ledgerFile),
    journal: fs.readFileSync(`${value.ledgerFile}-journal`)
  };
  assertCode(
    () => consumer.recoverSyntheticAuthorizationReceiptForTest(
      value.environment,
      historicalRequest
    ),
    'SYNTHETIC_AUTHORIZATION_LEDGER_BUSY'
  );
  assert.deepEqual(fs.readFileSync(value.ledgerFile), crashedBytes.main);
  assert.deepEqual(
    fs.readFileSync(`${value.ledgerFile}-journal`),
    crashedBytes.journal
  );

  const request = consumeRequest(value, 'hot-journal-recovery-request');
  assert.equal(consumeFixture(value, request).outcome, 'consumed');
  assert.equal(rowCount(value, 'ledger_blocks'), 0);
  assert.equal(rowCount(value, 'grant_consumptions'), 2);
  assert.equal(fs.existsSync(`${value.ledgerFile}-journal`), false);
  const recovered = consumer.recoverSyntheticAuthorizationReceiptForTest(
    value.environment,
    historicalRequest
  );
  assert.equal(recovered.outcome, 'replayed');
  assert.equal(recovered.receiptSha256, historicalReceipt.receiptSha256);
});

test('S17 两个真实 Node 进程争抢同一 grant 时仅一个提交，另一方稳定拒绝', async () => {
  const value = createFixture('multiprocess-single-use');
  const first = consumeRequest(value, 'multiprocess-first');
  const second = {
    ...first,
    requestId: requestId('grant-consume', 'multiprocess-second')
  };
  const marker = path.join(value.ledgerParent, 'writer-lock-held.marker');
  const firstOutcome = runConsumerProcess(value, first, { holdMarker: marker });
  await waitForFile(marker);
  const secondOutcome = runConsumerProcess(value, second);
  const outcomes = await Promise.all([firstOutcome, secondOutcome]);
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
  assert.deepEqual(
    outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.code),
    ['SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED']
  );
  assert.equal(rowCount(value, 'grant_consumptions'), 1);
  assert.equal(rowCount(value, 'grant_rejections'), 1);
  const loserRequest = outcomes[0].ok ? second : first;
  assertCode(
    () => consumeFixture(value, loserRequest, {
      checkpointVerifier() {
        assert.fail('并发 loser 的持久 rejection 不应再次调用 verifier');
      }
    }),
    'SYNTHETIC_AUTHORIZATION_LEDGER_GRANT_ALREADY_CONSUMED'
  );

  // 本地 SQLite 锁竞争不构成外部权威、可信时间或全局消费证明。
  const winner = outcomes.find(outcome => outcome.ok).result;
  assert.equal(winner.checks.trustedTimeVerified, false);
  assert.equal(winner.checks.latestCheckpointExternallyConfirmed, false);
  assert.equal(winner.checks.globalConsumptionVerified, false);
  assert.equal(winner.deploymentAuthorization, 'not_granted');

  const replayValue = createFixture('multiprocess-identical-request');
  const replayRequest = consumeRequest(replayValue, 'multiprocess-identical-request');
  const replayMarker = path.join(replayValue.ledgerParent, 'writer-lock-held.marker');
  const original = runConsumerProcess(replayValue, replayRequest, {
    holdMarker: replayMarker
  });
  await waitForFile(replayMarker);
  const retry = runConsumerProcess(replayValue, replayRequest);
  const replayOutcomes = await Promise.all([original, retry]);
  assert.equal(replayOutcomes.every(outcome => outcome.ok), true);
  assert.deepEqual(
    replayOutcomes.map(outcome => outcome.result.outcome).sort(),
    ['consumed', 'replayed']
  );
  assert.equal(rowCount(replayValue, 'grant_consumptions'), 1);
  assert.equal(rowCount(replayValue, 'grant_rejections'), 0);
});
