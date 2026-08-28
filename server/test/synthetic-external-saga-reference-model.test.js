'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const readiness = require('../../scripts/support/synthetic-external-saga-readiness');
const model = require('../test-support/synthetic-external-saga-reference-model');
const { installLoopbackOnlyNetwork } = require('../test-support/loopback-only-network');

const projectRoot = path.resolve(__dirname, '..', '..');
const modelFile = path.join(
  projectRoot,
  'server',
  'test-support',
  'synthetic-external-saga-reference-model.js'
);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function requestId(kind, label) {
  return `synthetic-${kind}-${digest(label).slice(0, 32)}`;
}

function recoveredIntent(label = 'reference-source', overrides = {}) {
  const value = key => digest(`s19a-reference:${label}:${key}`);
  return {
    schemaVersion: 1,
    profile: 'synthetic-authority-coordination-intent',
    result: 'locally_prepared_unsubmitted',
    outcome: 'replayed',
    authorityCoordinationStatus: 'locally_prepared_unsubmitted',
    journalIdSha256: value('journal-id'),
    intentIdSha256: value('intent-id'),
    intentRecordSha256: value('intent-record'),
    requestFingerprintSha256: value('request-fingerprint'),
    authorizationConsumptionDocumentSha256: value('consumption-document'),
    localReceiptSha256: value('local-receipt'),
    ledgerIdSha256: value('ledger-id'),
    consumerIdSha256: value('consumer-id'),
    targetEnvironmentSha256: value('target-environment'),
    trustPolicyIdSha256: value('trust-policy-id'),
    trustPolicySha256: value('trust-policy'),
    trustPolicyRevision: 3,
    revocationCheckpointSequence: 27,
    revocationCheckpointSha256: value('checkpoint'),
    subjectSha256: value('subject'),
    candidateBindingSha256: value('candidate-binding'),
    sourceCommit: value('source-commit'),
    implementationTreeSha256: value('implementation-tree'),
    configurationSha256: value('configuration'),
    approvalEnvelopeSha256: value('approval-envelope'),
    grantIdSha256: value('grant-id'),
    grantEnvelopeSha256: value('grant-envelope'),
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

function blockedReadinessReport(label = 'reference-source') {
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
  const input = {
    schemaVersion: 1,
    purpose: 'synthetic_s19_external_integration_blocker_report',
    authorityCoordinationIntentDocument: intentDocument
  };
  return readiness.assessSyntheticExternalSagaReadinessForTest(
    {
      NODE_ENV: 'production',
      DEPLOYMENT_TIER: 'synthetic',
      [readiness.ACK_ENV]: readiness.ACK
    },
    input,
    { recoverIntent: () => recoveredIntent(label) }
  );
}

function participants(label = 'participants') {
  const result = {};
  for (const name of [
    'coordinator',
    'deployer',
    'target',
    'platformEventSource',
    'stateObserver',
    'healthObserver',
    'noEffectProofIssuer'
  ]) {
    result[name] = {
      modelActorIdSha256: digest(`${label}:${name}:actor`),
      faultDomainSha256: digest(`${label}:${name}:fault-domain`)
    };
  }
  return result;
}

function createDocument(label = 'base') {
  const report = blockedReadinessReport(label);
  const operation = {
    operationIdSha256: digest(`${label}:test-only-operation`),
    action: 'test_only_model_deploy_synthetic_once',
    artifactSha256: digest(`${label}:test-only-artifact`),
    configurationSha256: report.localIntentBinding.configurationSha256,
    secretVersionSha256: digest(`${label}:test-only-secret-version`),
    targetResourceSha256: report.localIntentBinding.targetEnvironmentSha256,
    preOperationTargetStateSha256: digest(`${label}:test-only-pre-operation-state`),
    expectedTargetStateSha256: digest(`${label}:test-only-expected-state`),
    fence: 1,
    operationFingerprintSha256: ''
  };
  operation.operationFingerprintSha256 = digest({
    schemaVersion: 1,
    purpose: 'synthetic_s19a_test_only_model_operation',
    readinessReportSha256: digest(report),
    operationIdSha256: operation.operationIdSha256,
    action: operation.action,
    artifactSha256: operation.artifactSha256,
    configurationSha256: operation.configurationSha256,
    secretVersionSha256: operation.secretVersionSha256,
    targetResourceSha256: operation.targetResourceSha256,
    preOperationTargetStateSha256: operation.preOperationTargetStateSha256,
    expectedTargetStateSha256: operation.expectedTargetStateSha256,
    fence: operation.fence
  });
  return {
    schemaVersion: 1,
    purpose: 'synthetic_s19a_test_only_external_saga_reference_trace',
    readinessReport: report,
    modelOperation: operation,
    modelParticipants: participants(label),
    events: []
  };
}

function event(document, sequence, eventType, actor, payload, suffix = '') {
  return {
    schemaVersion: 1,
    sequence,
    eventType,
    eventIdSha256: digest(`${eventType}:${sequence}:${suffix || 'default'}`),
    operationIdSha256: document.modelOperation.operationIdSha256,
    operationFingerprintSha256:
      document.modelOperation.operationFingerprintSha256,
    fence: document.modelOperation.fence,
    actor,
    actorIdSha256: document.modelParticipants[actor].modelActorIdSha256,
    faultDomainSha256: document.modelParticipants[actor].faultDomainSha256,
    payload
  };
}

function reservationEvent(document, sequence = 1, suffix = '') {
  return event(document, sequence, 'test_only_reservation_outbox_atomic_commit',
    'coordinator', {
      modelReservationRecordSha256: digest(`reservation:${suffix || sequence}`),
      modelOutboxRecordSha256: digest(`outbox:${suffix || sequence}`),
      modelCoordinatorTransactionSha256: digest(`transaction:${suffix || sequence}`),
      modeledAtomicCommit: true
    }, suffix);
}

function admissionEvent(document, sequence, suffix = '') {
  return event(document, sequence, 'test_only_target_admission_observed', 'target', {
    modelAdmissionRecordSha256: digest(`admission:${suffix || sequence}`),
    submittedByActorIdSha256:
      document.modelParticipants.deployer.modelActorIdSha256,
    modelAdmissionDisposition: 'admitted_for_reference_trace'
  }, suffix);
}

function platformEvent(document, sequence, admission, suffix = '') {
  return event(document, sequence, 'test_only_platform_change_event_observed',
    'platformEventSource', {
      modelPlatformEventSha256: digest(`platform:${suffix || sequence}`),
      modelAdmissionRecordSha256: admission.payload.modelAdmissionRecordSha256,
      reportedTargetStateSha256:
        document.modelOperation.expectedTargetStateSha256
    }, suffix);
}

function readEvent(document, sequence, platform, disposition = 'matches_expected', suffix = '') {
  return event(document, sequence, 'test_only_read_after_write_observed',
    'stateObserver', {
      modelReadObservationSha256: digest(`read:${suffix || sequence}`),
      modelPlatformEventSha256: platform.payload.modelPlatformEventSha256,
      observedTargetStateSha256: disposition === 'matches_expected'
        ? document.modelOperation.expectedTargetStateSha256
        : digest(`different-state:${suffix || sequence}`),
      observationDisposition: disposition
    }, suffix);
}

function healthEvent(document, sequence, disposition = 'healthy', suffix = '') {
  return event(document, sequence, 'test_only_health_observed', 'healthObserver', {
    modelHealthObservationSha256: digest(`health:${suffix || sequence}`),
    observedTargetStateSha256: document.modelOperation.expectedTargetStateSha256,
    healthDisposition: disposition
  }, suffix);
}

function unknownEvent(document, sequence, suffix = '') {
  return event(document, sequence, 'test_only_dispatch_result_unknown', 'deployer', {
    modelDispatchAttemptSha256: digest(`dispatch:${suffix || sequence}`),
    unknownDisposition: 'no_authoritative_outcome_observed'
  }, suffix);
}

function ackEvent(document, sequence, ackKind, actor = 'deployer') {
  return event(document, sequence, 'test_only_non_authoritative_ack_observed', actor, {
    modelAcknowledgementSha256: digest(`ack:${sequence}:${ackKind}:${actor}`),
    ackKind
  }, ackKind);
}

function noEffectEvent(document, sequence, overrides = {}) {
  return event(document, sequence, 'test_only_no_effect_proof_observed',
    'noEffectProofIssuer', {
      modelNoEffectProofSha256: digest(`no-effect:${sequence}`),
      proofScope: 'exact_operation_and_target',
      operationEffectStatus: 'not_applied',
      targetFenceHighWater: document.modelOperation.fence,
      fencesAtOrBelowHighWaterRejected: true,
      targetStateSha256: document.modelOperation.preOperationTargetStateSha256,
      ...overrides
    });
}

function assertCode(work, code) {
  assert.throws(work, error => {
    assert.equal(error && error.code, code);
    assert.equal(error && error.message, code);
    return true;
  });
}

function assertNeverAuthorizes(result) {
  assert.equal(result.readyForExternalIntegration, false);
  assert.equal(result.realDeploymentStatus, 'not_observed');
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.productionChildGateState, 'not_observed');
  assert.equal(result.childUseAuthorization, 'not_granted');
  assert.equal(result.checks.referenceModelNormative, false);
  assert.equal(result.checks.callerProvidedReportOriginAuthenticated, false);
  assert.equal(result.checks.approvedProtocolConformanceAssessed, false);
  assert.equal(result.checks.externalProtocolApproved, false);
  assert.equal(result.checks.externalProtocolConformanceVerified, false);
  assert.equal(result.checks.authorityTrustRootApproved, false);
  assert.equal(result.checks.externalRoleIdentitiesAuthenticated, false);
  assert.equal(result.checks.externalFactsVerified, false);
  for (const key of [
    'environmentRead',
    'currentTimeRead',
    'fileSystemAccessPerformed',
    'databaseAccessPerformed',
    'networkAccessPerformed',
    'externalSubmissionPerformed',
    'reservationPerformed',
    'deploymentPerformed',
    'compensationPerformed',
    'productionDataRead',
    'productionChildGateChanged'
  ]) assert.equal(result.operations[key], false, key);
}

test('S19a safety model 只返回非规范、非穷尽、零授权的内存参考结果', () => {
  const document = createDocument('fixed-output');
  const before = JSON.stringify(document);
  const restoreNetwork = installLoopbackOnlyNetwork();
  let result;
  try {
    result = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
  } finally {
    restoreNetwork();
  }
  assert.equal(JSON.stringify(document), before);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.profile, 'synthetic-s19a-test-only-external-saga-reference');
  assert.equal(result.scope, 'non_normative_test_only_reference');
  assert.equal(result.result, 'reference_trace_incomplete_no_positive_conclusion');
  assert.equal(result.referenceCoverage, 'minimum_selected_non_exhaustive');
  assert.equal(result.referenceState, 'test_only_intent_bound');
  assert.equal(result.traceDisposition, 'incomplete');
  assert.equal(result.selectedReferenceEvidenceSetComplete, false);
  assert.equal(result.uniqueEventCount, 0);
  assert.equal(result.replayedEventCount, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(result.operations), true);
  assertNeverAuthorizes(result);
});

test('S19a safety model 拒绝 production seam、caller 外部事实和 accessor 输入且不读敏感值', () => {
  const production = createDocument('production-source');
  production.readinessReport = structuredClone(production.readinessReport);
  production.readinessReport.checks.testOnlyOverridesUsed = false;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(production),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_PRODUCTION_SOURCE_REJECTED'
  );

  let reads = 0;
  const extra = createDocument('extra-caller-fact');
  Object.defineProperty(extra, 'endpoint', {
    enumerable: true,
    get() {
      reads += 1;
      return 'https://external.invalid';
    }
  });
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(extra),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_ARGUMENT_INVALID'
  );
  assert.equal(reads, 0);

  const rawIntent = createDocument('raw-intent');
  rawIntent.readinessReport = {
    ...rawIntent.readinessReport,
    authorityCoordinationIntentDocument: { secret: 'forbidden' }
  };
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(rawIntent),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_SOURCE_REPORT_INVALID'
  );

  const hiddenBinding = createDocument('hidden-report-binding');
  hiddenBinding.readinessReport = structuredClone(hiddenBinding.readinessReport);
  Object.defineProperty(
    hiddenBinding.readinessReport.localIntentBinding,
    'configurationSha256',
    {
      enumerable: false,
      value: hiddenBinding.readinessReport.localIntentBinding.configurationSha256
    }
  );
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(hiddenBinding),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_SOURCE_REPORT_INVALID'
  );
});

test('S19a safety model 锁定 readiness/operation/participant 摘要和故障域隔离', () => {
  const operationDrift = createDocument('operation-drift');
  operationDrift.modelOperation.configurationSha256 = digest('drifted-config');
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(operationDrift),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_BINDING_MISMATCH'
  );

  const participantCollision = createDocument('participant-collision');
  participantCollision.modelParticipants.healthObserver.faultDomainSha256 =
    participantCollision.modelParticipants.stateObserver.faultDomainSha256;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(participantCollision),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_PARTICIPANT_SEPARATION_INVALID'
  );

  const reportDrift = createDocument('report-drift');
  reportDrift.readinessReport = structuredClone(reportDrift.readinessReport);
  reportDrift.readinessReport.checks.globalReservationVerified = true;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(reportDrift),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_SOURCE_REPORT_INVALID'
  );
});

test('S19a forward shape 必须依次具备原子参考事件、admission、平台事件、独立读和健康观察', () => {
  const document = createDocument('forward-shape');
  const reservation = reservationEvent(document, 1);
  const admission = admissionEvent(document, 2);
  const platform = platformEvent(document, 3, admission);
  const read = readEvent(document, 4, platform);
  const health = healthEvent(document, 5);
  const expectedStates = [
    'test_only_intent_bound',
    'test_only_forward_dispatchable',
    'test_only_forward_admitted',
    'test_only_platform_event_observed',
    'test_only_effect_confirmed',
    'test_only_forward_trace_complete'
  ];
  const all = [reservation, admission, platform, read, health];
  for (let count = 0; count <= all.length; count += 1) {
    document.events = all.slice(0, count);
    const result = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
    assert.equal(result.referenceState, expectedStates[count]);
    assert.equal(result.selectedReferenceEvidenceSetComplete, count === all.length);
    assertNeverAuthorizes(result);
  }
  const complete = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
  assert.equal(complete.traceDisposition, 'modeled_forward_shape_complete');
  assert.equal(complete.checks.referenceReservationOutboxAtomicEventModeled, true);
  assert.equal(complete.checks.referenceTargetAdmissionModeled, true);
  assert.equal(complete.checks.referencePlatformEventModeled, true);
  assert.equal(complete.checks.referenceIndependentReadAfterWriteModeled, true);
  assert.equal(complete.checks.referenceIndependentHealthModeled, true);
  assert.equal(complete.checks.globalReservationVerified, false);
  assert.equal(complete.checks.durableOutboxAtomicityVerified, false);
  assert.equal(complete.checks.targetAdmissionVerified, false);
  assert.equal(complete.checks.healthVerified, false);
});

test('S19a queued/accepted/2xx/delivery/signed ack 全部不能推进参考状态', () => {
  const document = createDocument('acks-do-not-confirm');
  document.events = [reservationEvent(document, 1)];
  let sequence = 2;
  for (const ackKind of [
    'accepted',
    'delivery_ack',
    'http_2xx',
    'outbox_dispatched',
    'queued',
    'signed_ack'
  ]) {
    document.events.push(ackEvent(document, sequence, ackKind));
    sequence += 1;
  }
  const result = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
  assert.equal(result.referenceState, 'test_only_forward_dispatchable');
  assert.equal(result.traceDisposition, 'incomplete');
  assert.equal(result.selectedReferenceEvidenceSetComplete, false);
  assert.equal(result.checks.nonAuthoritativeAcknowledgementCount, 6);
  assertNeverAuthorizes(result);
});

test('S19a UNKNOWN 粘滞但只允许同 operation/fence 的完整正向观察链形成 test-only shape', () => {
  const document = createDocument('unknown-forward-reconciliation');
  const admission = admissionEvent(document, 3, 'late');
  const platform = platformEvent(document, 4, admission, 'late');
  document.events = [
    reservationEvent(document, 1),
    unknownEvent(document, 2),
    admission,
    platform,
    readEvent(document, 5, platform, 'matches_expected', 'late'),
    healthEvent(document, 6, 'healthy', 'late')
  ];
  const result = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
  assert.equal(result.referenceState, 'test_only_forward_trace_complete');
  assert.equal(result.traceDisposition, 'modeled_forward_shape_complete');
  assert.equal(result.checks.referenceUnknownStickyModelApplied, true);
  assert.equal(result.checks.realExternalUnknownReconciledByThisModel, false);
  assertNeverAuthorizes(result);

  const changedFence = structuredClone(document);
  changedFence.events[2].fence = 2;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(changedFence),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_BINDING_MISMATCH'
  );
});

test('S19a no-effect 只认带 fence high-water 的固定 test-only shape 且不认证权威证明', () => {
  const document = createDocument('no-effect-shape');
  document.events = [
    reservationEvent(document, 1),
    unknownEvent(document, 2),
    noEffectEvent(document, 3)
  ];
  const result = model.inspectSyntheticExternalSagaReferenceTraceForTest(document);
  assert.equal(result.referenceState, 'test_only_modeled_no_effect_shape_complete');
  assert.equal(result.traceDisposition, 'modeled_no_effect_shape_complete');
  assert.equal(result.selectedReferenceEvidenceSetComplete, true);
  assert.equal(result.checks.referenceNoEffectProofShapeModeled, true);
  assert.equal(result.checks.authoritativeNoEffectProofVerified, false);
  assertNeverAuthorizes(result);

  for (const overrides of [
    { proofScope: 'target_only' },
    { operationEffectStatus: 'unknown' },
    { targetFenceHighWater: 0 },
    { fencesAtOrBelowHighWaterRejected: false },
    { targetStateSha256: digest('not-the-pre-operation-state') }
  ]) {
    const invalid = createDocument(`invalid-no-effect-${Object.keys(overrides)[0]}`);
    invalid.events = [
      reservationEvent(invalid, 1),
      unknownEvent(invalid, 2),
      noEffectEvent(invalid, 3, overrides)
    ];
    const expectedCode = overrides.targetFenceHighWater === 0
      ? 'SYNTHETIC_S19A_TEST_SAGA_MODEL_EVENT_INVALID'
      : 'SYNTHETIC_S19A_TEST_SAGA_MODEL_NO_EFFECT_PROOF_INSUFFICIENT';
    assertCode(
      () => model.inspectSyntheticExternalSagaReferenceTraceForTest(invalid),
      expectedCode
    );
  }
});

test('S19a 矛盾 read 进入 UNKNOWN；unhealthy 只阻断为补偿协议缺失且绝不自动回滚', () => {
  const mismatch = createDocument('read-mismatch');
  const mismatchAdmission = admissionEvent(mismatch, 2);
  const mismatchPlatform = platformEvent(mismatch, 3, mismatchAdmission);
  mismatch.events = [
    reservationEvent(mismatch, 1),
    mismatchAdmission,
    mismatchPlatform,
    readEvent(mismatch, 4, mismatchPlatform, 'does_not_match_expected')
  ];
  const unknown = model.inspectSyntheticExternalSagaReferenceTraceForTest(mismatch);
  assert.equal(unknown.referenceState, 'test_only_contradictory_observation_sticky');
  assert.equal(unknown.result, 'reference_trace_blocked_no_positive_conclusion');
  assert.equal(unknown.selectedReferenceEvidenceSetComplete, false);
  assert.equal(unknown.operations.compensationPerformed, false);

  const contradictionThenNoEffect = structuredClone(mismatch);
  contradictionThenNoEffect.events.push(noEffectEvent(contradictionThenNoEffect, 5));
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(
      contradictionThenNoEffect
    ),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_CONTRADICTORY_EVIDENCE_UNRESOLVED'
  );

  const contradictionThenAdmission = structuredClone(mismatch);
  contradictionThenAdmission.events.push(
    admissionEvent(contradictionThenAdmission, 5, 'second-admission')
  );
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(
      contradictionThenAdmission
    ),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_UNKNOWN_STICKY'
  );

  const unhealthy = createDocument('unhealthy');
  const admission = admissionEvent(unhealthy, 2);
  const platform = platformEvent(unhealthy, 3, admission);
  unhealthy.events = [
    reservationEvent(unhealthy, 1),
    admission,
    platform,
    readEvent(unhealthy, 4, platform),
    healthEvent(unhealthy, 5, 'unhealthy')
  ];
  const blocked = model.inspectSyntheticExternalSagaReferenceTraceForTest(unhealthy);
  assert.equal(blocked.referenceState, 'test_only_compensation_protocol_required');
  assert.equal(blocked.traceDisposition, 'compensation_protocol_required');
  assert.equal(blocked.checks.compensationProtocolAvailable, false);
  assert.equal(blocked.checks.compensationAuthorized, false);
  assert.equal(blocked.operations.compensationPerformed, false);

  unhealthy.events.push({
    ...ackEvent(unhealthy, 6, 'queued'),
    eventType: 'test_only_compensation_requested'
  });
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(unhealthy),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_COMPENSATION_PROTOCOL_UNAVAILABLE'
  );
});

test('S19a sequence/event replay 幂等；冲突 replay、gap、跨 actor/binding 稳定拒绝', () => {
  const replay = createDocument('replay');
  const reservation = reservationEvent(replay, 1);
  replay.events = [reservation, structuredClone(reservation), structuredClone(reservation)];
  const replayed = model.inspectSyntheticExternalSagaReferenceTraceForTest(replay);
  assert.equal(replayed.referenceState, 'test_only_forward_dispatchable');
  assert.equal(replayed.uniqueEventCount, 1);
  assert.equal(replayed.replayedEventCount, 2);

  const conflict = createDocument('replay-conflict');
  const first = reservationEvent(conflict, 1);
  const second = structuredClone(first);
  second.payload.modelOutboxRecordSha256 = digest('different-outbox');
  conflict.events = [first, second];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(conflict),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_REPLAY_CONFLICT'
  );

  const hiddenConflict = createDocument('hidden-replay-conflict');
  const hiddenFirst = reservationEvent(hiddenConflict, 1);
  const hiddenSecond = structuredClone(hiddenFirst);
  Object.defineProperty(hiddenFirst.payload, 'modelOutboxRecordSha256', {
    enumerable: false,
    value: digest('hidden-outbox-one')
  });
  Object.defineProperty(hiddenSecond.payload, 'modelOutboxRecordSha256', {
    enumerable: false,
    value: digest('hidden-outbox-two')
  });
  hiddenConflict.events = [hiddenFirst, hiddenSecond];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(hiddenConflict),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_EVENT_INVALID'
  );

  const gap = createDocument('sequence-gap');
  gap.events = [reservationEvent(gap, 2)];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(gap),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_SEQUENCE_INVALID'
  );

  const wrongActor = createDocument('wrong-actor');
  const wrongAdmission = admissionEvent(wrongActor, 2);
  wrongAdmission.actor = 'coordinator';
  wrongAdmission.actorIdSha256 =
    wrongActor.modelParticipants.coordinator.modelActorIdSha256;
  wrongAdmission.faultDomainSha256 =
    wrongActor.modelParticipants.coordinator.faultDomainSha256;
  wrongActor.events = [reservationEvent(wrongActor, 1), wrongAdmission];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(wrongActor),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_BINDING_MISMATCH'
  );
});

test('S19a 不接受拆分 reservation/outbox、乱序观察或终态后的新事件', () => {
  const ackBeforeReservation = createDocument('ack-before-reservation');
  ackBeforeReservation.events = [ackEvent(ackBeforeReservation, 1, 'http_2xx')];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(
      ackBeforeReservation
    ),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRANSITION_INVALID'
  );

  const split = createDocument('split-reservation');
  split.events = [{
    ...reservationEvent(split, 1),
    eventType: 'test_only_reservation_only_recorded'
  }];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(split),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_EVENT_INVALID'
  );

  const outOfOrder = createDocument('out-of-order');
  const admission = admissionEvent(outOfOrder, 2);
  outOfOrder.events = [
    reservationEvent(outOfOrder, 1),
    platformEvent(outOfOrder, 2, admission)
  ];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(outOfOrder),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRANSITION_INVALID'
  );

  const terminal = createDocument('terminal-extra-event');
  const terminalAdmission = admissionEvent(terminal, 2);
  const terminalPlatform = platformEvent(terminal, 3, terminalAdmission);
  terminal.events = [
    reservationEvent(terminal, 1),
    terminalAdmission,
    terminalPlatform,
    readEvent(terminal, 4, terminalPlatform),
    healthEvent(terminal, 5),
    ackEvent(terminal, 6, 'http_2xx')
  ];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(terminal),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRANSITION_INVALID'
  );
});

test('S19a 限制 trace 规模并拒绝非普通对象、accessor 数组和未知字段', () => {
  const tooLarge = createDocument('too-large');
  const first = ackEvent(tooLarge, 1, 'queued');
  tooLarge.events = Array.from({ length: 129 }, (_, index) => ({
    ...first,
    sequence: index + 1,
    eventIdSha256: digest(`too-large:${index}`)
  }));
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(tooLarge),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRACE_TOO_LARGE'
  );

  const customPrototype = createDocument('custom-prototype');
  customPrototype.modelOperation = Object.assign(
    Object.create({ inherited: true }),
    customPrototype.modelOperation
  );
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(customPrototype),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRACE_INVALID'
  );

  const accessorArray = createDocument('accessor-array');
  const events = [];
  Object.defineProperty(events, '0', {
    enumerable: true,
    get() {
      throw new Error('must not read accessor');
    }
  });
  events.length = 1;
  accessorArray.events = events;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(accessorArray),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRACE_INVALID'
  );

  let proxyTraps = 0;
  const proxied = createDocument('proxied-operation');
  proxied.modelOperation = new Proxy(proxied.modelOperation, {
    get(target, key, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(proxied),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRACE_INVALID'
  );
  assert.equal(proxyTraps, 0);

  let scalarProxyTraps = 0;
  const scalarProxy = new Proxy({}, {
    ownKeys() {
      scalarProxyTraps += 1;
      return [];
    },
    get() {
      scalarProxyTraps += 1;
      return undefined;
    }
  });
  const proxiedAction = createDocument('proxied-action');
  proxiedAction.modelOperation.action = scalarProxy;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(proxiedAction),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_BINDING_MISMATCH'
  );
  assert.equal(scalarProxyTraps, 0);

  const cyclicAction = createDocument('cyclic-action');
  const cycle = {};
  cycle.self = cycle;
  cyclicAction.modelOperation.action = cycle;
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(cyclicAction),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_BINDING_MISMATCH'
  );

  const proxiedScalar = createDocument('proxied-payload-scalar');
  const proxiedReservation = reservationEvent(proxiedScalar, 1);
  proxiedReservation.payload.modeledAtomicCommit = scalarProxy;
  proxiedScalar.events = [proxiedReservation];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(proxiedScalar),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRANSITION_INVALID'
  );
  assert.equal(scalarProxyTraps, 0);

  const bigintScalar = createDocument('bigint-payload-scalar');
  const bigintReservation = reservationEvent(bigintScalar, 1);
  bigintReservation.payload.modeledAtomicCommit = 1n;
  bigintScalar.events = [bigintReservation];
  assertCode(
    () => model.inspectSyntheticExternalSagaReferenceTraceForTest(bigintScalar),
    'SYNTHETIC_S19A_TEST_SAGA_MODEL_TRANSITION_INVALID'
  );
});

test('S19a 生产依赖图静态隔离：零文件/SQLite/时间/环境/网络/CLI/迁移 011', () => {
  const source = fs.readFileSync(modelFile, 'utf8');
  for (const pattern of [
    /require\(['"]node:(?:fs|sqlite|os|path|http|https|net|tls|dns|dgram|child_process|worker_threads|timers)/,
    /process\.env/,
    /\bDate\b/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bDatabaseSync\b/
  ]) assert.doesNotMatch(source, pattern);
  assert.deepEqual(
    [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2]),
    ['node:crypto', 'node:util']
  );

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json')));
  assert.equal(
    Object.entries(packageJson.scripts).some(([key, value]) => (
      key.includes('s19a') || String(value).includes('saga-reference-model')
    )),
    false
  );
  assert.equal(fs.existsSync(path.join(
    projectRoot,
    'scripts',
    'synthetic-external-saga-reference-model.js'
  )), false);
  assert.equal(fs.existsSync(path.join(
    projectRoot,
    'server',
    'db',
    'migrations',
    '011_external_saga.sql'
  )), false);
  const migrations = fs.readdirSync(path.join(projectRoot, 'server', 'db', 'migrations'))
    .filter(filename => filename.endsWith('.sql'));
  assert.equal(migrations.length, 10);

  const forbiddenImport = 'synthetic-external-saga-reference-model';
  const productionFiles = [];
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
      productionFiles.push(path.join(projectRoot, entry.name));
    }
  }
  for (const root of [path.join(projectRoot, 'scripts'), path.join(projectRoot, 'server')]) {
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (['test', 'test-support'].includes(entry.name)) continue;
          visit(filename);
        } else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
          productionFiles.push(filename);
        }
      }
    };
    visit(root);
  }
  assert.deepEqual(
    productionFiles.filter(filename => (
      fs.readFileSync(filename, 'utf8').includes(forbiddenImport)
    )),
    []
  );
  assert.deepEqual(Object.keys(model).sort(), [
    'SyntheticS19aTestSagaModelError',
    'inspectSyntheticExternalSagaReferenceTraceForTest'
  ]);
});

test('S19a 反复求值无文件副作用且 S19 readiness 前后仍固定 blocked', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-s19a-pure-'));
  try {
    const document = createDocument('repeat-pure');
    document.events = [reservationEvent(document, 1), unknownEvent(document, 2)];
    const before = fs.readdirSync(temporary);
    const readinessBefore = JSON.stringify(document.readinessReport);
    let serialized;
    const restoreNetwork = installLoopbackOnlyNetwork();
    try {
      for (let index = 0; index < 100; index += 1) {
        const current = JSON.stringify(
          model.inspectSyntheticExternalSagaReferenceTraceForTest(document)
        );
        if (serialized === undefined) serialized = current;
        assert.equal(current, serialized);
      }
    } finally {
      restoreNetwork();
    }
    assert.deepEqual(fs.readdirSync(temporary), before);
    assert.equal(JSON.stringify(document.readinessReport), readinessBefore);
    assert.equal(document.readinessReport.result, 'external_integration_blocked');
    assert.equal(document.readinessReport.readyForExternalIntegration, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
