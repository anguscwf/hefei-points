const { TextDecoder } = require('node:util');

const coordination = require('./synthetic-authority-coordination-intent');

const MAX_STDIN_BYTES = 1024 * 1024;
const ACK_ENV = 'SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK';
const ACK = 'report-blockers-no-external-action-v1';
const FORBIDDEN_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  'WX_APPSECRET'
]);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const BLOCKING_REASONS = Object.freeze([
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
]);

const REQUIRED_PROTOCOL_CAPABILITIES = Object.freeze([
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
]);

const STABLE_ERROR_CODES = new Set([
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_ARGUMENT_INVALID',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK_REQUIRED',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_STDIN_REQUIRED',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_TOO_LARGE',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_SENSITIVE_INPUT',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED',
  'SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID'
]);

class SyntheticExternalSagaReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticExternalSagaReadinessError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticExternalSagaReadinessError(code);
}

function safeErrorCode(error) {
  if (error instanceof SyntheticExternalSagaReadinessError
      && STABLE_ERROR_CODES.has(error.code)) return error.code;
  if (error instanceof coordination.SyntheticAuthorityCoordinationIntentError) {
    return coordination.safeErrorCode(error);
  }
  return 'SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID';
}

function canonicalHash(value) {
  return coordination.canonicalHash(value);
}

function exactKeys(
  value,
  expected,
  code = 'SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID'
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value)
    && !/^([0-9a-f])\1{63}$/.test(value);
}

function parseCanonicalTimestamp(value) {
  if (typeof value !== 'string') fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID');
  }
  return epoch;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_ARGUMENT_INVALID');
}

function assertEnvironment(environment) {
  if (!environment || typeof environment !== 'object'
      || environment.NODE_ENV !== 'production'
      || environment.DEPLOYMENT_TIER !== 'synthetic') {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED');
  }
  if (FORBIDDEN_CREDENTIAL_ENVIRONMENT_KEYS.some(key => key in environment)) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED');
  }
  if (environment[ACK_ENV] !== ACK) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK_REQUIRED');
  }
}

function sensitiveValues(environment) {
  return [
    environment.API_PUBLIC_ORIGIN,
    environment.LEGAL_PUBLIC_ORIGIN,
    environment.WX_APPID,
    environment.SYNTHETIC_DATASET_ID,
    environment.SYNTHETIC_DATA_ROOT,
    environment.DATA_DIR,
    environment.SQLITE_FILE,
    environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE,
    environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT,
    environment.SYNTHETIC_AUTHORIZATION_LEDGER_FILE,
    environment.SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT,
    environment.SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_FILE,
    environment.SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVED_PARENT
  ].filter(value => typeof value === 'string' && value.length >= 6);
}

function decodeCanonicalInput(buffer, environment = process.env) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_STDIN_REQUIRED');
  }
  if (buffer.length > MAX_STDIN_BYTES) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_TOO_LARGE');
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  if (raw.endsWith('\n') && !raw.endsWith('\r\n')) raw = raw.slice(0, -1);
  if (!raw) fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_STDIN_REQUIRED');
  const sensitive = sensitiveValues(environment)
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  if ([...new Set(sensitive)].some(value => raw.includes(value))) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_SENSITIVE_INPUT');
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  if (JSON.stringify(document) !== raw) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += input.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      input.fill(0);
      fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(input));
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function normalizeInput(document) {
  exactKeys(document, [
    'schemaVersion', 'purpose', 'authorityCoordinationIntentDocument'
  ]);
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_s19_external_integration_blocker_report') {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  exactKeys(document.authorityCoordinationIntentDocument, [
    'schemaVersion', 'purpose', 'requestId', 'authorizationConsumptionDocument'
  ]);
  if (document.authorityCoordinationIntentDocument.schemaVersion !== 1
      || document.authorityCoordinationIntentDocument.purpose
        !== 'synthetic_authority_coordination_intent_prepare') {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  return document.authorityCoordinationIntentDocument;
}

function normalizeRecoveredIntent(result, testOnly) {
  const code = 'SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID';
  exactKeys(result, [
    'schemaVersion', 'profile', 'result', 'outcome', 'authorityCoordinationStatus',
    'journalIdSha256', 'intentIdSha256', 'intentRecordSha256',
    'requestFingerprintSha256', 'authorizationConsumptionDocumentSha256',
    'localReceiptSha256', 'ledgerIdSha256', 'consumerIdSha256',
    'targetEnvironmentSha256', 'trustPolicyIdSha256', 'trustPolicySha256',
    'trustPolicyRevision', 'revocationCheckpointSequence',
    'revocationCheckpointSha256', 'subjectSha256', 'candidateBindingSha256',
    'sourceCommit', 'implementationTreeSha256', 'configurationSha256',
    'approvalEnvelopeSha256', 'grantIdSha256', 'grantEnvelopeSha256',
    'localConsumedAtObserved', 'localVerificationValidUntil', 'preparedAtObserved',
    'checks', 'operations', 'deploymentAuthorization', 'productionChildGateState',
    'childUseAuthorization'
  ], code);
  exactKeys(result.checks, [
    'testOnlyOverridesUsed', 'historicalLocalAuthorizationReceiptBoundAtPreparation',
    'historicalIntentRecovered', 'localReceiptRecoveryPerformedForThisCall',
    'rawAuthorizationMaterialExcluded', 'journalIdentityBoundToSingleLedger',
    'crossLedgerUniquenessOnlyWithinThisJournal',
    'localClockMonotonicWithinThisJournal',
    'currentExternalApprovalRevalidatedByThisCommand',
    'trustPolicyExternallyAuthorizedByThisCommand',
    'externalRoleIdentitiesAuthenticatedByThisCommand',
    'externalEvidenceRetrievedByThisCommand',
    'externalAuditRecordRetrievedByThisCommand', 'trustedTimeVerified',
    'latestCheckpointExternallyConfirmed', 'externalRollbackAnchorVerified',
    'globalConsumptionVerified', 'externalAuthorityReceiptVerified',
    'deploymentReceiptVerified', 'externalDeploymentAtomicityVerified',
    'externalFactsVerified'
  ], code);
  exactKeys(result.operations, [
    'coordinationIntentRowInserted', 'localIntentJournalOpenedReadOnly',
    'localIntentJournalOpenedWritable', 's17AuthorizationLedgerWritten',
    'syntheticDatabaseWritten', 'networkAccessPerformed',
    'externalSubmissionPerformed', 'deploymentPerformed', 'productionDataRead',
    'productionChildGateChanged'
  ], code);
  const digestKeys = [
    'journalIdSha256', 'intentIdSha256', 'intentRecordSha256',
    'requestFingerprintSha256', 'authorizationConsumptionDocumentSha256',
    'localReceiptSha256', 'ledgerIdSha256', 'consumerIdSha256',
    'targetEnvironmentSha256', 'trustPolicyIdSha256', 'trustPolicySha256',
    'revocationCheckpointSha256', 'subjectSha256', 'candidateBindingSha256',
    'implementationTreeSha256', 'configurationSha256', 'approvalEnvelopeSha256',
    'grantIdSha256', 'grantEnvelopeSha256'
  ];
  const consumedAt = parseCanonicalTimestamp(result.localConsumedAtObserved);
  const validUntil = parseCanonicalTimestamp(result.localVerificationValidUntil);
  const preparedAt = parseCanonicalTimestamp(result.preparedAtObserved);
  const falseChecks = [
    'currentExternalApprovalRevalidatedByThisCommand',
    'trustPolicyExternallyAuthorizedByThisCommand',
    'externalRoleIdentitiesAuthenticatedByThisCommand',
    'externalEvidenceRetrievedByThisCommand',
    'externalAuditRecordRetrievedByThisCommand', 'trustedTimeVerified',
    'latestCheckpointExternallyConfirmed', 'externalRollbackAnchorVerified',
    'globalConsumptionVerified', 'externalAuthorityReceiptVerified',
    'deploymentReceiptVerified', 'externalDeploymentAtomicityVerified',
    'externalFactsVerified'
  ];
  if (result.schemaVersion !== 1
      || result.profile !== 'synthetic-authority-coordination-intent'
      || result.result !== 'locally_prepared_unsubmitted'
      || result.outcome !== 'replayed'
      || result.authorityCoordinationStatus !== 'locally_prepared_unsubmitted'
      || digestKeys.some(key => !validDigest(result[key]))
      || !Number.isSafeInteger(result.trustPolicyRevision)
      || result.trustPolicyRevision < 1
      || !Number.isSafeInteger(result.revocationCheckpointSequence)
      || result.revocationCheckpointSequence < 1
      || !COMMIT.test(result.sourceCommit)
      || /^([0-9a-f])\1+$/.test(result.sourceCommit)
      || consumedAt >= validUntil || preparedAt < consumedAt
      || result.checks.testOnlyOverridesUsed !== testOnly
      || result.checks.historicalLocalAuthorizationReceiptBoundAtPreparation !== true
      || result.checks.historicalIntentRecovered !== true
      || result.checks.localReceiptRecoveryPerformedForThisCall !== false
      || result.checks.rawAuthorizationMaterialExcluded !== true
      || result.checks.journalIdentityBoundToSingleLedger !== false
      || result.checks.crossLedgerUniquenessOnlyWithinThisJournal !== true
      || result.checks.localClockMonotonicWithinThisJournal !== true
      || falseChecks.some(key => result.checks[key] !== false)
      || result.operations.coordinationIntentRowInserted !== false
      || result.operations.localIntentJournalOpenedReadOnly !== true
      || result.operations.localIntentJournalOpenedWritable !== false
      || Object.entries(result.operations).some(([key, value]) => (
        key !== 'localIntentJournalOpenedReadOnly' && value !== false
      ))
      || result.deploymentAuthorization !== 'not_granted'
      || result.productionChildGateState !== 'not_observed'
      || result.childUseAuthorization !== 'not_granted') {
    fail(code);
  }
  return Object.freeze({ ...result });
}

function localIntentBinding(result) {
  return Object.freeze({
    journalIdSha256: result.journalIdSha256,
    intentIdSha256: result.intentIdSha256,
    intentRecordSha256: result.intentRecordSha256,
    requestFingerprintSha256: result.requestFingerprintSha256,
    authorizationConsumptionDocumentSha256:
      result.authorizationConsumptionDocumentSha256,
    localReceiptSha256: result.localReceiptSha256,
    ledgerIdSha256: result.ledgerIdSha256,
    consumerIdSha256: result.consumerIdSha256,
    targetEnvironmentSha256: result.targetEnvironmentSha256,
    trustPolicyIdSha256: result.trustPolicyIdSha256,
    trustPolicySha256: result.trustPolicySha256,
    trustPolicyRevision: result.trustPolicyRevision,
    revocationCheckpointSequence: result.revocationCheckpointSequence,
    revocationCheckpointSha256: result.revocationCheckpointSha256,
    subjectSha256: result.subjectSha256,
    candidateBindingSha256: result.candidateBindingSha256,
    sourceCommit: result.sourceCommit,
    implementationTreeSha256: result.implementationTreeSha256,
    configurationSha256: result.configurationSha256,
    approvalEnvelopeSha256: result.approvalEnvelopeSha256,
    grantIdSha256: result.grantIdSha256,
    grantEnvelopeSha256: result.grantEnvelopeSha256
  });
}

function assessInternal(environment, document, options) {
  assertEnvironment(environment);
  const intentDocument = normalizeInput(document);
  const recover = options.testOnly === true
    ? (options.recoverIntent
      || coordination.recoverSyntheticAuthorityCoordinationIntentForTest)
    : coordination.recoverSyntheticAuthorityCoordinationIntent;
  if (typeof recover !== 'function') {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_S18_SOURCE_INVALID');
  }
  const recovered = normalizeRecoveredIntent(
    recover(environment, intentDocument),
    options.testOnly === true
  );
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-external-saga-readiness-blocker-report',
    result: 'external_integration_blocked',
    scope: 'local_read_only_blocker_report',
    readyForExternalIntegration: false,
    blockerSetCompleteness: 'minimum_known_non_exhaustive',
    localIntentStatus: 'locally_prepared_unsubmitted',
    localIntentBinding: localIntentBinding(recovered),
    blockingReasons: BLOCKING_REASONS,
    blockingReasonsSha256: canonicalHash({
      schemaVersion: 1,
      purpose: 'synthetic-external-saga-blocking-reasons',
      values: BLOCKING_REASONS
    }),
    requiredProtocolCapabilities: REQUIRED_PROTOCOL_CAPABILITIES,
    requiredProtocolCapabilitiesSha256: canonicalHash({
      schemaVersion: 1,
      purpose: 'synthetic-external-saga-required-protocol-capabilities',
      values: REQUIRED_PROTOCOL_CAPABILITIES
    }),
    checks: Object.freeze({
      testOnlyOverridesUsed: options.testOnly === true,
      historicalLocalCoordinationIntentRecovered: true,
      rawAuthorizationMaterialExcludedFromReport: true,
      inputDocumentPersistedByThisCommand: false,
      callerProvidedExternalFactsAccepted: false,
      overallDeploymentReadinessAssessed: false,
      approvedParentAclAndSameAccountProcessIsolationExternallyVerified: false,
      externalProtocolApproved: false,
      authorityTrustRootApproved: false,
      authorityAuthenticated: false,
      externalRoleIdentitiesAuthenticated: false,
      trustedTimeVerified: false,
      latestCheckpointExternallyConfirmed: false,
      globalReservationVerified: false,
      durableOutboxAtomicityVerified: false,
      globalConsumptionVerified: false,
      targetAdmissionVerified: false,
      fencingVerified: false,
      immutableDeploymentBindingVerified: false,
      externalSubmissionVerified: false,
      deploymentReceiptVerified: false,
      independentPlatformStateVerified: false,
      healthVerified: false,
      compensationAuthorized: false,
      rollbackSafetyVerified: false,
      externalFactsVerified: false
    }),
    operations: Object.freeze({
      s18IntentJournalOpenedReadOnly: true,
      s18IntentJournalWritten: false,
      credentialsRead: false,
      syntheticDatabaseWritten: false,
      localReadinessStateWritten: false,
      networkAccessPerformed: false,
      externalSubmissionPerformed: false,
      reservationPerformed: false,
      deploymentPerformed: false,
      compensationPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function assessSyntheticExternalSagaReadiness(environment, document) {
  return assessInternal(environment, document, {});
}

function assessSyntheticExternalSagaReadinessForTest(
  environment,
  document,
  options = {}
) {
  const allowed = Object.keys(options);
  if (allowed.some(key => key !== 'recoverIntent')) {
    fail('SYNTHETIC_EXTERNAL_SAGA_READINESS_INPUT_INVALID');
  }
  return assessInternal(environment, document, {
    testOnly: true,
    recoverIntent: options.recoverIntent
  });
}

function usage() {
  return [
    'Usage: node scripts/report-synthetic-external-saga-blockers.js',
    '',
    `Requires ${ACK_ENV}=${ACK}.`,
    'Reads one exact historical S18 intent and reports immutable external integration blockers.',
    'Exit status 0 only means the blocker report was generated; it does not mean ready.',
    'It accepts no endpoint, credential, trust root, authority receipt or success claim.',
    'It does not reserve, submit, access the network, deploy, compensate or grant child use.'
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
      const output = assessSyntheticExternalSagaReadiness(environment, document);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } finally {
      buffer.fill(0);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `Synthetic external saga blocker report failed (${safeErrorCode(error)}).\n`
    );
    return 1;
  }
}

module.exports = {
  ACK,
  ACK_ENV,
  BLOCKING_REASONS,
  MAX_STDIN_BYTES,
  REQUIRED_PROTOCOL_CAPABILITIES,
  SyntheticExternalSagaReadinessError,
  assessSyntheticExternalSagaReadiness,
  assessSyntheticExternalSagaReadinessForTest,
  canonicalHash,
  decodeCanonicalInput,
  parseArguments,
  readStdin,
  runCli,
  safeErrorCode,
  usage
};
