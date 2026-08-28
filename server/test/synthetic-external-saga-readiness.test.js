const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readiness = require('../../scripts/support/synthetic-external-saga-readiness');
const coordination = require('../../scripts/support/synthetic-authority-coordination-intent');
const { installLoopbackOnlyNetwork } = require('../test-support/loopback-only-network');

const projectRoot = path.resolve(__dirname, '..', '..');
const supportFile = path.join(
  projectRoot,
  'scripts',
  'support',
  'synthetic-external-saga-readiness.js'
);
const cli = path.join(projectRoot, 'scripts', 'report-synthetic-external-saga-blockers.js');
const retiredCli = path.join(
  projectRoot,
  'scripts',
  'assess-synthetic-external-saga-readiness.js'
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-s19-readiness-'));

const BLOCKING_REASONS = [
  'approved_authority_protocol_missing',
  'approved_coordinator_protocol_missing',
  'approved_deployer_protocol_missing',
  'approved_parent_acl_and_same_account_process_isolation_unverified',
  'authoritative_evidence_and_audit_retrieval_unverified',
  'authoritative_latest_checkpoint_unverified',
  'authoritative_trust_root_missing',
  'compensation_authorization_protocol_missing',
  'durable_outbox_atomicity_unverified',
  'external_role_identities_unauthenticated',
  'global_consumption_unverified',
  'global_linearizable_reservation_unverified',
  'independent_health_observation_unverified',
  'independent_platform_state_observation_unverified',
  'rollback_safety_unverified',
  'target_admission_and_fencing_unverified',
  'trusted_time_source_unverified'
];

const REQUIRED_PROTOCOL_CAPABILITIES = [
  'approved_coordinator_protocol',
  'authenticated_authority_evidence_and_audit_retrieval',
  'authenticated_platform_change_event',
  'authoritative_trust_root_and_role_lifecycle',
  'global_linearizable_reservation_and_single_consumption',
  'idempotent_target_admission',
  'immutable_artifact_configuration_secret_version_binding',
  'immutable_operation_fingerprint_and_monotonic_fence',
  'independent_health_observation',
  'independent_read_after_write_observation',
  'reservation_and_durable_outbox_same_transaction',
  'separately_authorized_compensation_and_rollback',
  'sticky_unknown_reconciliation',
  'trusted_time_and_latest_checkpoint'
];

const CHECK_KEYS = [
  'testOnlyOverridesUsed',
  'historicalLocalCoordinationIntentRecovered',
  'rawAuthorizationMaterialExcludedFromReport',
  'inputDocumentPersistedByThisCommand',
  'approvedParentAclAndSameAccountProcessIsolationExternallyVerified',
  'callerProvidedExternalFactsAccepted',
  'overallDeploymentReadinessAssessed',
  'externalProtocolApproved',
  'authorityTrustRootApproved',
  'authorityAuthenticated',
  'externalRoleIdentitiesAuthenticated',
  'trustedTimeVerified',
  'latestCheckpointExternallyConfirmed',
  'globalReservationVerified',
  'durableOutboxAtomicityVerified',
  'globalConsumptionVerified',
  'targetAdmissionVerified',
  'fencingVerified',
  'immutableDeploymentBindingVerified',
  'externalSubmissionVerified',
  'deploymentReceiptVerified',
  'independentPlatformStateVerified',
  'healthVerified',
  'compensationAuthorized',
  'rollbackSafetyVerified',
  'externalFactsVerified'
];

const OPERATION_KEYS = [
  's18IntentJournalOpenedReadOnly',
  's18IntentJournalWritten',
  'credentialsRead',
  'syntheticDatabaseWritten',
  'localReadinessStateWritten',
  'networkAccessPerformed',
  'externalSubmissionPerformed',
  'reservationPerformed',
  'deploymentPerformed',
  'compensationPerformed',
  'productionDataRead',
  'productionChildGateChanged'
];

const BINDING_KEYS = [
  'journalIdSha256',
  'intentIdSha256',
  'intentRecordSha256',
  'requestFingerprintSha256',
  'authorizationConsumptionDocumentSha256',
  'localReceiptSha256',
  'ledgerIdSha256',
  'consumerIdSha256',
  'targetEnvironmentSha256',
  'trustPolicyIdSha256',
  'trustPolicySha256',
  'trustPolicyRevision',
  'revocationCheckpointSequence',
  'revocationCheckpointSha256',
  'subjectSha256',
  'candidateBindingSha256',
  'sourceCommit',
  'implementationTreeSha256',
  'configurationSha256',
  'approvalEnvelopeSha256',
  'grantIdSha256',
  'grantEnvelopeSha256'
];

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestId(kind, label) {
  return `synthetic-${kind}-${digest(label).slice(0, 32)}`;
}

function assertCode(work, code) {
  assert.throws(work, error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function createFixture(label) {
  const root = path.join(tempRoot, label);
  const journalParent = path.join(root, 'coordination-journal');
  const ledgerParent = path.join(root, 'authorization-ledger');
  const policyParent = path.join(root, 'policy');
  const dataRoot = path.join(root, 'synthetic-data');
  for (const directory of [journalParent, ledgerParent, policyParent, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const ledgerFile = path.join(ledgerParent, 'synthetic-authorization-ledger.sqlite');
  const policyFile = path.join(policyParent, 'synthetic-trust-policy.json');
  fs.writeFileSync(ledgerFile, 'synthetic-readiness-ledger-placeholder', { mode: 0o600 });
  fs.writeFileSync(policyFile, '{"testOnly":true}', { mode: 0o600 });
  const intentDocument = {
    schemaVersion: 1,
    purpose: 'synthetic_authority_coordination_intent_prepare',
    requestId: requestId('authority-intent', label),
    authorizationConsumptionDocument: {
      schemaVersion: 1,
      purpose: 'synthetic_local_grant_compare_and_consume',
      requestId: requestId('grant-consume', label),
      verificationDocument: {}
    }
  };
  const environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    [readiness.ACK_ENV]: readiness.ACK,
    [coordination.ACK_ENV]: coordination.ACK,
    [coordination.JOURNAL_FILE_ENV]:
      path.join(journalParent, coordination.JOURNAL_FILENAME),
    [coordination.JOURNAL_PARENT_ENV]: journalParent,
    [coordination.JOURNAL_ID_ENV]: digest(`${label}:journal-id`),
    SYNTHETIC_DATA_ROOT: dataRoot,
    SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT: ledgerParent,
    SYNTHETIC_AUTHORIZATION_LEDGER_FILE: ledgerFile,
    SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT: policyParent,
    SYNTHETIC_APPROVAL_TRUST_POLICY_FILE: policyFile
  };
  return {
    root,
    environment,
    intentDocument,
    input: {
      schemaVersion: 1,
      purpose: 'synthetic_s19_external_integration_blocker_report',
      authorityCoordinationIntentDocument: intentDocument
    }
  };
}

function recoveredIntent(label = 'default', overrides = {}) {
  const digestValue = key => digest(`s19-readiness:${label}:${key}`);
  return {
    schemaVersion: 1,
    profile: 'synthetic-authority-coordination-intent',
    result: 'locally_prepared_unsubmitted',
    outcome: 'replayed',
    authorityCoordinationStatus: 'locally_prepared_unsubmitted',
    journalIdSha256: digestValue('journal-id'),
    intentIdSha256: digestValue('intent-id'),
    intentRecordSha256: digestValue('intent-record'),
    requestFingerprintSha256: digestValue('request-fingerprint'),
    authorizationConsumptionDocumentSha256: digestValue('consumption-document'),
    localReceiptSha256: digestValue('local-receipt'),
    ledgerIdSha256: digestValue('ledger-id'),
    consumerIdSha256: digestValue('consumer-id'),
    targetEnvironmentSha256: digestValue('target-environment'),
    trustPolicyIdSha256: digestValue('trust-policy-id'),
    trustPolicySha256: digestValue('trust-policy'),
    trustPolicyRevision: 1,
    revocationCheckpointSequence: 20,
    revocationCheckpointSha256: digestValue('checkpoint'),
    subjectSha256: digestValue('subject'),
    candidateBindingSha256: digestValue('candidate-binding'),
    sourceCommit: digestValue('source-commit'),
    implementationTreeSha256: digestValue('implementation-tree'),
    configurationSha256: digestValue('configuration'),
    approvalEnvelopeSha256: digestValue('approval-envelope'),
    grantIdSha256: digestValue('grant-id'),
    grantEnvelopeSha256: digestValue('grant-envelope'),
    localConsumedAtObserved: '2026-08-28T03:00:00.000Z',
    localVerificationValidUntil: '2026-08-28T06:00:00.000Z',
    preparedAtObserved: '2026-08-28T03:00:00.000Z',
    checks: {
      testOnlyOverridesUsed: true,
      historicalLocalAuthorizationReceiptBoundAtPreparation: true,
      historicalIntentRecovered: true,
      localReceiptRecoveryPerformedForThisCall: false,
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
    },
    operations: {
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
    },
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted',
    ...overrides
  };
}

function treeEvidence(root) {
  const rows = [];
  const visit = (filename, relative) => {
    const metadata = fs.lstatSync(filename, { bigint: true });
    rows.push({
      relative,
      kind: metadata.isDirectory() ? 'directory' : 'file',
      mode: String(metadata.mode),
      nlink: String(metadata.nlink),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
      ctimeNs: String(metadata.ctimeNs),
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

test('S19 readiness 固定报告完整 blocker/requirement 且零写、零网、零提交、零部署', () => {
  const value = createFixture('fixed-blocker-report');
  const recovered = recoveredIntent('fixed-blocker-report');
  const before = treeEvidence(value.root);
  let recoveryCalls = 0;
  const restoreNetwork = installLoopbackOnlyNetwork();
  let result;
  try {
    result = readiness.assessSyntheticExternalSagaReadinessForTest(
      value.environment,
      value.input,
      {
        recoverIntent(environment, document) {
          recoveryCalls += 1;
          assert.equal(environment, value.environment);
          assert.equal(document, value.intentDocument);
          return recovered;
        }
      }
    );
  } finally {
    restoreNetwork();
  }
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(treeEvidence(value.root), before);
  assert.deepEqual(Object.keys(result).sort(), [
    'schemaVersion', 'profile', 'result', 'scope', 'readyForExternalIntegration',
    'blockerSetCompleteness', 'localIntentStatus', 'localIntentBinding', 'blockingReasons',
    'blockingReasonsSha256', 'requiredProtocolCapabilities',
    'requiredProtocolCapabilitiesSha256', 'checks', 'operations',
    'deploymentAuthorization', 'productionChildGateState', 'childUseAuthorization'
  ].sort());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.profile, 'synthetic-external-saga-readiness-blocker-report');
  assert.equal(result.result, 'external_integration_blocked');
  assert.equal(result.scope, 'local_read_only_blocker_report');
  assert.equal(result.readyForExternalIntegration, false);
  assert.equal(result.blockerSetCompleteness, 'minimum_known_non_exhaustive');
  assert.equal(result.localIntentStatus, 'locally_prepared_unsubmitted');
  assert.deepEqual(result.blockingReasons, BLOCKING_REASONS);
  assert.deepEqual(result.requiredProtocolCapabilities, REQUIRED_PROTOCOL_CAPABILITIES);
  assert.deepEqual(result.blockingReasons, [...result.blockingReasons].sort());
  assert.deepEqual(
    result.requiredProtocolCapabilities,
    [...result.requiredProtocolCapabilities].sort()
  );
  assert.equal(new Set(result.blockingReasons).size, result.blockingReasons.length);
  assert.equal(
    new Set(result.requiredProtocolCapabilities).size,
    result.requiredProtocolCapabilities.length
  );
  assert.equal(
    result.blockingReasonsSha256,
    readiness.canonicalHash({
      schemaVersion: 1,
      purpose: 'synthetic-external-saga-blocking-reasons',
      values: BLOCKING_REASONS
    })
  );
  assert.equal(
    result.requiredProtocolCapabilitiesSha256,
    readiness.canonicalHash({
      schemaVersion: 1,
      purpose: 'synthetic-external-saga-required-protocol-capabilities',
      values: REQUIRED_PROTOCOL_CAPABILITIES
    })
  );
  assert.deepEqual(Object.keys(result.localIntentBinding).sort(), [...BINDING_KEYS].sort());
  for (const key of BINDING_KEYS) assert.equal(result.localIntentBinding[key], recovered[key], key);
  assert.deepEqual(Object.keys(result.checks).sort(), [...CHECK_KEYS].sort());
  assert.equal(result.checks.testOnlyOverridesUsed, true);
  assert.equal(result.checks.historicalLocalCoordinationIntentRecovered, true);
  assert.equal(result.checks.rawAuthorizationMaterialExcludedFromReport, true);
  assert.equal(result.checks.inputDocumentPersistedByThisCommand, false);
  assert.equal(result.checks.overallDeploymentReadinessAssessed, false);
  for (const key of CHECK_KEYS.filter(key => ![
    'testOnlyOverridesUsed',
    'historicalLocalCoordinationIntentRecovered',
    'rawAuthorizationMaterialExcludedFromReport'
  ].includes(key))) assert.equal(result.checks[key], false, key);
  assert.deepEqual(Object.keys(result.operations).sort(), [...OPERATION_KEYS].sort());
  assert.equal(result.operations.s18IntentJournalOpenedReadOnly, true);
  for (const key of OPERATION_KEYS.slice(1)) assert.equal(result.operations[key], false, key);
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.productionChildGateState, 'not_observed');
  assert.equal(result.childUseAuthorization, 'not_granted');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(value.intentDocument.requestId), false);
  assert.equal(
    serialized.includes(value.intentDocument.authorizationConsumptionDocument.requestId),
    false
  );
});

test('S19 readiness 严格拒绝 caller 外部事实并隔离 test recovery seam', () => {
  const value = createFixture('strict-input-and-seam');
  const recovered = recoveredIntent('strict-input-and-seam');
  const before = treeEvidence(value.root);
  let invalidRecoveryCalls = 0;
  for (const [key, claimed] of [
    ['endpoint', 'https://authority.invalid.example'],
    ['apiKey', 'synthetic-caller-key'],
    ['authorityReceipt', digest('caller-receipt')],
    ['verified', true],
    ['readyForExternalIntegration', true]
  ]) {
    assertCode(
      () => readiness.assessSyntheticExternalSagaReadinessForTest(
        value.environment,
        { ...value.input, [key]: claimed },
        {
          recoverIntent() {
            invalidRecoveryCalls += 1;
            return recovered;
          }
        }
      ),
      'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID'
    );
  }
  const nested = structuredClone(value.input);
  nested.authorityCoordinationIntentDocument.endpoint = 'https://authority.invalid.example';
  assertCode(
    () => readiness.assessSyntheticExternalSagaReadinessForTest(
      value.environment,
      nested,
      { recoverIntent: () => recovered }
    ),
    'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID'
  );
  assert.equal(invalidRecoveryCalls, 0);
  assertCode(
    () => readiness.assessSyntheticExternalSagaReadinessForTest(
      value.environment,
      value.input,
      { recoverIntent: () => recovered, endpoint: 'forbidden-option' }
    ),
    'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID'
  );
  assertCode(
    () => readiness.assessSyntheticExternalSagaReadinessForTest(
      value.environment,
      value.input,
      {
        recoverIntent: () => recoveredIntent('wrong-provenance', {
          checks: { ...recovered.checks, testOnlyOverridesUsed: false }
        })
      }
    ),
    'SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID'
  );

  let productionSeamCalls = 0;
  assertCode(
    () => readiness.assessSyntheticExternalSagaReadiness(
      value.environment,
      value.input,
      {
        recoverIntent() {
          productionSeamCalls += 1;
          return recovered;
        }
      }
    ),
    'SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED'
  );
  assert.equal(productionSeamCalls, 0);
  assert.deepEqual(treeEvidence(value.root), before);
});

test('S19 production 遇到 WX_APPSECRET 键时在 recovery 前拒绝且绝不读取 secret 值', () => {
  const value = createFixture('forbidden-secret-environment-key');
  const before = treeEvidence(value.root);
  const target = { ...value.environment };
  let secretValueReads = 0;
  let secretPresenceChecks = 0;
  Object.defineProperty(target, 'WX_APPSECRET', {
    configurable: true,
    enumerable: true,
    get() {
      secretValueReads += 1;
      throw new Error('WX_APPSECRET value must never be read');
    }
  });
  const guardedEnvironment = new Proxy(target, {
    has(object, key) {
      if (key === 'WX_APPSECRET') secretPresenceChecks += 1;
      return Reflect.has(object, key);
    },
    get(object, key, receiver) {
      if (key === 'WX_APPSECRET') {
        secretValueReads += 1;
        throw new Error('WX_APPSECRET value must never be read');
      }
      return Reflect.get(object, key, receiver);
    }
  });
  const originalRecovery = coordination.recoverSyntheticAuthorityCoordinationIntent;
  let recoveryCalls = 0;
  coordination.recoverSyntheticAuthorityCoordinationIntent = () => {
    recoveryCalls += 1;
    assert.fail('credential-bearing environment 必须在 S18 recovery 前被拒绝');
  };
  try {
    assertCode(
      () => readiness.assessSyntheticExternalSagaReadiness(
        guardedEnvironment,
        value.input
      ),
      'SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED'
    );
  } finally {
    coordination.recoverSyntheticAuthorityCoordinationIntent = originalRecovery;
  }
  assert.ok(secretPresenceChecks >= 1);
  assert.equal(secretValueReads, 0);
  assert.equal(recoveryCalls, 0);
  assert.deepEqual(treeEvidence(value.root), before);

  const source = fs.readFileSync(supportFile, 'utf8');
  for (const forbiddenValueRead of [
    'environment.WX_APPSECRET',
    "environment['WX_APPSECRET']",
    'environment["WX_APPSECRET"]',
    'Reflect.get(environment',
    'Object.values(environment)',
    'Object.entries(environment)',
    'Object.getOwnPropertyDescriptor(environment'
  ]) assert.equal(source.includes(forbiddenValueRead), false, forbiddenValueRead);
});

test('S19 readiness CLI ACK、canonical stdin、脱敏与静态零 production action 保持稳定', async () => {
  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout,
    /^Usage: node scripts\/report-synthetic-external-saga-blockers\.js/);
  assert.match(
    help.stdout,
    /exit (?:status )?0[^\n]*blocker report[^\n]*(?:does not|not)[^\n]*(?:ready|readiness)/i
  );
  assert.equal(help.stderr, '');
  assert.equal(fs.existsSync(retiredCli), false);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  );
  assert.equal(
    packageJson.scripts['report:synthetic-external-saga-blockers'],
    'node scripts/report-synthetic-external-saga-blockers.js'
  );
  assert.equal(packageJson.scripts['assess:synthetic-external-saga-readiness'], undefined);

  const value = createFixture('cli-contract');
  const childEnvironment = { ...process.env, ...value.environment };
  delete childEnvironment.WX_APPSECRET;
  const noAck = { ...childEnvironment };
  delete noAck[readiness.ACK_ENV];
  const ackFailure = spawnSync(process.execPath, [cli], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: '{}',
    windowsHide: true,
    env: noAck
  });
  assert.equal(ackFailure.status, 1);
  assert.equal(ackFailure.stdout, '');
  assert.equal(
    ackFailure.stderr,
    'Synthetic external saga blocker report failed '
      + '(SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK_REQUIRED).\n'
  );

  const canonical = JSON.stringify(value.input);
  assert.deepEqual(
    readiness.decodeCanonicalInput(Buffer.from(`${canonical}\n`), value.environment),
    value.input
  );
  const acceptedCanonical = spawnSync(process.execPath, [cli], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: `${canonical}\n`,
    windowsHide: true,
    env: childEnvironment
  });
  assert.equal(acceptedCanonical.status, 1);
  assert.equal(acceptedCanonical.stdout, '');
  assert.equal(
    acceptedCanonical.stderr,
    'Synthetic external saga blocker report failed '
      + '(SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED).\n'
  );
  const nonCanonical = spawnSync(process.execPath, [cli], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: `${canonical}\n\n`,
    windowsHide: true,
    env: childEnvironment
  });
  assert.equal(nonCanonical.status, 1);
  assert.equal(
    nonCanonical.stderr,
    'Synthetic external saga blocker report failed '
      + '(SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID).\n'
  );

  const secret = 'synthetic-s19-secret-must-not-appear';
  const forbiddenCredential = spawnSync(process.execPath, [cli], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: `${canonical}\n`,
    windowsHide: true,
    env: { ...childEnvironment, WX_APPSECRET: secret }
  });
  assert.equal(forbiddenCredential.status, 1);
  assert.equal(forbiddenCredential.stdout, '');
  assert.equal(
    forbiddenCredential.stderr,
    'Synthetic external saga blocker report failed '
      + '(SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED).\n'
  );
  assert.equal(forbiddenCredential.stderr.includes(secret), false);

  for (const environmentKey of [
    'SYNTHETIC_APPROVAL_TRUST_POLICY_FILE',
    'SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT'
  ]) {
    const rawPolicyPath = value.environment[environmentKey];
    const sensitivePolicyPath = spawnSync(process.execPath, [cli], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: JSON.stringify({ ...value.input, endpoint: rawPolicyPath }),
      windowsHide: true,
      env: childEnvironment
    });
    assert.equal(sensitivePolicyPath.status, 1, environmentKey);
    assert.equal(sensitivePolicyPath.stdout, '');
    assert.equal(
      sensitivePolicyPath.stderr,
      'Synthetic external saga blocker report failed '
        + '(SYNTHETIC_EXTERNAL_SAGA_READINESS_SENSITIVE_INPUT).\n'
    );
    assert.equal(sensitivePolicyPath.stderr.includes(rawPolicyPath), false);
  }

  const baseProductionRecovery = recoveredIntent('cli-production-success');
  const productionRecovery = {
    ...baseProductionRecovery,
    checks: {
      ...baseProductionRecovery.checks,
      testOnlyOverridesUsed: false
    }
  };
  const runCliWithFakeProductionRecovery = String.raw`
const coordination = require(process.env.S19_COORDINATION_MODULE);
const readiness = require(process.env.S19_READINESS_MODULE);
const recovered = JSON.parse(process.env.S19_RECOVERED_INTENT);
const environment = JSON.parse(process.env.S19_ENVIRONMENT);
let calls = 0;
coordination.recoverSyntheticAuthorityCoordinationIntent = () => {
  calls += 1;
  return recovered;
};
readiness.runCli([], environment, process.stdin).then(code => {
  process.exitCode = calls === 1 ? code : 9;
});
`;
  const successfulReport = spawnSync(
    process.execPath,
    ['-e', runCliWithFakeProductionRecovery],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      input: `${canonical}\n`,
      windowsHide: true,
      env: {
        ...process.env,
        S19_COORDINATION_MODULE: path.join(
          projectRoot,
          'scripts',
          'support',
          'synthetic-authority-coordination-intent.js'
        ),
        S19_READINESS_MODULE: supportFile,
        S19_RECOVERED_INTENT: JSON.stringify(productionRecovery),
        S19_ENVIRONMENT: JSON.stringify(value.environment)
      }
    }
  );
  assert.equal(successfulReport.status, 0, successfulReport.stderr);
  assert.equal(successfulReport.stderr, '');
  const reported = JSON.parse(successfulReport.stdout);
  assert.equal(reported.result, 'external_integration_blocked');
  assert.equal(reported.readyForExternalIntegration, false);
  assert.equal(reported.checks.testOnlyOverridesUsed, false);
  assert.equal(reported.checks.externalFactsVerified, false);
  assert.equal(reported.operations.networkAccessPerformed, false);
  assert.equal(reported.operations.externalSubmissionPerformed, false);
  assert.equal(reported.operations.deploymentPerformed, false);
  assert.equal(reported.deploymentAuthorization, 'not_granted');

  assert.deepEqual(readiness.BLOCKING_REASONS, BLOCKING_REASONS);
  assert.deepEqual(readiness.REQUIRED_PROTOCOL_CAPABILITIES, REQUIRED_PROTOCOL_CAPABILITIES);
  const source = fs.readFileSync(supportFile, 'utf8');
  for (const forbidden of [
    "require('node:http')", "require('node:https')", "require('node:net')",
    "require('node:tls')", "require('node:dns')", "require('node:dgram')",
    "require('node:child_process')", "require('undici')", 'globalThis.fetch('
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  const actionExport = /submit|reserve|deploy|compensat|rollback|reconcile|poll|credential/i;
  for (const key of Object.keys(readiness)) {
    assert.equal(actionExport.test(key), false, `forbidden production action export: ${key}`);
  }
});
