'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_EVENTS = 128;

const PURPOSE = 'synthetic_s19a_test_only_external_saga_reference_trace';
const PROFILE = 'synthetic-s19a-test-only-external-saga-reference';
const OPERATION_ACTION = 'test_only_model_deploy_synthetic_once';

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

const READINESS_BINDING_KEYS = Object.freeze([
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
]);

const READINESS_CHECK_KEYS = Object.freeze([
  'testOnlyOverridesUsed',
  'historicalLocalCoordinationIntentRecovered',
  'rawAuthorizationMaterialExcludedFromReport',
  'inputDocumentPersistedByThisCommand',
  'callerProvidedExternalFactsAccepted',
  'overallDeploymentReadinessAssessed',
  'approvedParentAclAndSameAccountProcessIsolationExternallyVerified',
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
]);

const READINESS_OPERATION_KEYS = Object.freeze([
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
]);

const PARTICIPANT_NAMES = Object.freeze([
  'coordinator',
  'deployer',
  'target',
  'platformEventSource',
  'stateObserver',
  'healthObserver',
  'noEffectProofIssuer'
]);

const EVENT_TYPES = Object.freeze(new Set([
  'test_only_reservation_outbox_atomic_commit',
  'test_only_dispatch_result_unknown',
  'test_only_non_authoritative_ack_observed',
  'test_only_target_admission_observed',
  'test_only_platform_change_event_observed',
  'test_only_read_after_write_observed',
  'test_only_health_observed',
  'test_only_no_effect_proof_observed'
]));

const NON_AUTHORITATIVE_ACK_KINDS = Object.freeze(new Set([
  'accepted',
  'delivery_ack',
  'http_2xx',
  'outbox_dispatched',
  'queued',
  'signed_ack'
]));

const ERROR_PREFIX = 'SYNTHETIC_S19A_TEST_SAGA_MODEL_';
const ERRORS = Object.freeze({
  ARGUMENT_INVALID: `${ERROR_PREFIX}ARGUMENT_INVALID`,
  SOURCE_REPORT_INVALID: `${ERROR_PREFIX}SOURCE_REPORT_INVALID`,
  PRODUCTION_SOURCE_REJECTED: `${ERROR_PREFIX}PRODUCTION_SOURCE_REJECTED`,
  TRACE_TOO_LARGE: `${ERROR_PREFIX}TRACE_TOO_LARGE`,
  TRACE_INVALID: `${ERROR_PREFIX}TRACE_INVALID`,
  EVENT_INVALID: `${ERROR_PREFIX}EVENT_INVALID`,
  BINDING_MISMATCH: `${ERROR_PREFIX}BINDING_MISMATCH`,
  PARTICIPANT_SEPARATION_INVALID: `${ERROR_PREFIX}PARTICIPANT_SEPARATION_INVALID`,
  SEQUENCE_INVALID: `${ERROR_PREFIX}SEQUENCE_INVALID`,
  REPLAY_CONFLICT: `${ERROR_PREFIX}REPLAY_CONFLICT`,
  TRANSITION_INVALID: `${ERROR_PREFIX}TRANSITION_INVALID`,
  UNKNOWN_STICKY: `${ERROR_PREFIX}UNKNOWN_STICKY`,
  NO_EFFECT_PROOF_INSUFFICIENT: `${ERROR_PREFIX}NO_EFFECT_PROOF_INSUFFICIENT`,
  CONTRADICTORY_EVIDENCE_UNRESOLVED:
    `${ERROR_PREFIX}CONTRADICTORY_EVIDENCE_UNRESOLVED`,
  COMPENSATION_PROTOCOL_UNAVAILABLE: `${ERROR_PREFIX}COMPENSATION_PROTOCOL_UNAVAILABLE`
});

class SyntheticS19aTestSagaModelError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticS19aTestSagaModelError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticS19aTestSagaModelError(code);
}

function assertDataRecord(value, expectedKeys, code) {
  if (!value || typeof value !== 'object' || types.isProxy(value)
      || Array.isArray(value)) fail(code);
  let prototype;
  let descriptors;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch (_) {
    fail(code);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (ownKeys.some(key => typeof key !== 'string')) fail(code);
  const actual = ownKeys.sort();
  const wanted = [...expectedKeys].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])
      || actual.some(key => !Object.hasOwn(descriptors[key], 'value')
        || descriptors[key].enumerable !== true)) {
    fail(code);
  }
  return value;
}

function assertDataArray(value, code, maximumLength, limitCode = code) {
  if (types.isProxy(value) || !Array.isArray(value)) fail(code);
  let prototype;
  let lengthDescriptor;
  let length;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    length = lengthDescriptor && lengthDescriptor.value;
  } catch (_) {
    fail(code);
  }
  if (prototype !== Array.prototype || !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(length) || length < 0) fail(code);
  if (maximumLength !== undefined && length > maximumLength) fail(limitCode);
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (_) {
    fail(code);
  }
  const expectedKeys = new Set([
    ...Array.from({ length }, (_, index) => String(index)),
    'length'
  ]);
  if (ownKeys.length !== expectedKeys.size
      || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.has(key))) fail(code);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || descriptor.enumerable !== true) fail(code);
  }
  return value;
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

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value)
    && !/^([0-9a-f])\1{63}$/.test(value);
}

function assertDigest(value, code) {
  if (!validDigest(value)) fail(code);
}

function assertSafePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
}

function sameArray(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validateReadinessReport(report) {
  const code = ERRORS.SOURCE_REPORT_INVALID;
  assertDataRecord(report, [
    'schemaVersion',
    'profile',
    'result',
    'scope',
    'readyForExternalIntegration',
    'blockerSetCompleteness',
    'localIntentStatus',
    'localIntentBinding',
    'blockingReasons',
    'blockingReasonsSha256',
    'requiredProtocolCapabilities',
    'requiredProtocolCapabilitiesSha256',
    'checks',
    'operations',
    'deploymentAuthorization',
    'productionChildGateState',
    'childUseAuthorization'
  ], code);
  assertDataRecord(report.localIntentBinding, READINESS_BINDING_KEYS, code);
  assertDataRecord(report.checks, READINESS_CHECK_KEYS, code);
  assertDataRecord(report.operations, READINESS_OPERATION_KEYS, code);
  assertDataArray(report.blockingReasons, code, BLOCKING_REASONS.length);
  assertDataArray(
    report.requiredProtocolCapabilities,
    code,
    REQUIRED_PROTOCOL_CAPABILITIES.length
  );

  if (report.checks.testOnlyOverridesUsed === false) {
    fail(ERRORS.PRODUCTION_SOURCE_REJECTED);
  }

  const digestBindingKeys = READINESS_BINDING_KEYS.filter(key => ![
    'trustPolicyRevision',
    'revocationCheckpointSequence',
    'sourceCommit'
  ].includes(key));
  for (const key of digestBindingKeys) assertDigest(report.localIntentBinding[key], code);
  assertSafePositiveInteger(report.localIntentBinding.trustPolicyRevision, code);
  assertSafePositiveInteger(report.localIntentBinding.revocationCheckpointSequence, code);
  if (typeof report.localIntentBinding.sourceCommit !== 'string'
      || !COMMIT.test(report.localIntentBinding.sourceCommit)
      || /^([0-9a-f])\1+$/.test(report.localIntentBinding.sourceCommit)) fail(code);

  const trueChecks = new Set([
    'testOnlyOverridesUsed',
    'historicalLocalCoordinationIntentRecovered',
    'rawAuthorizationMaterialExcludedFromReport'
  ]);
  if (report.schemaVersion !== 1
      || report.profile !== 'synthetic-external-saga-readiness-blocker-report'
      || report.result !== 'external_integration_blocked'
      || report.scope !== 'local_read_only_blocker_report'
      || report.readyForExternalIntegration !== false
      || report.blockerSetCompleteness !== 'minimum_known_non_exhaustive'
      || report.localIntentStatus !== 'locally_prepared_unsubmitted'
      || !sameArray(report.blockingReasons, BLOCKING_REASONS)
      || !sameArray(report.requiredProtocolCapabilities, REQUIRED_PROTOCOL_CAPABILITIES)
      || report.blockingReasonsSha256 !== canonicalHash({
        schemaVersion: 1,
        purpose: 'synthetic-external-saga-blocking-reasons',
        values: BLOCKING_REASONS
      })
      || report.requiredProtocolCapabilitiesSha256 !== canonicalHash({
        schemaVersion: 1,
        purpose: 'synthetic-external-saga-required-protocol-capabilities',
        values: REQUIRED_PROTOCOL_CAPABILITIES
      })
      || READINESS_CHECK_KEYS.some(key => (
        report.checks[key] !== trueChecks.has(key)
      ))
      || report.operations.s18IntentJournalOpenedReadOnly !== true
      || READINESS_OPERATION_KEYS.slice(1).some(key => report.operations[key] !== false)
      || report.deploymentAuthorization !== 'not_granted'
      || report.productionChildGateState !== 'not_observed'
      || report.childUseAuthorization !== 'not_granted') {
    fail(code);
  }
  return canonicalHash(report);
}

function validateOperation(operation, readinessReportSha256, readinessReport) {
  const code = ERRORS.TRACE_INVALID;
  assertDataRecord(operation, [
    'operationIdSha256',
    'action',
    'artifactSha256',
    'configurationSha256',
    'secretVersionSha256',
    'targetResourceSha256',
    'preOperationTargetStateSha256',
    'expectedTargetStateSha256',
    'fence',
    'operationFingerprintSha256'
  ], code);
  for (const key of [
    'operationIdSha256',
    'artifactSha256',
    'configurationSha256',
    'secretVersionSha256',
    'targetResourceSha256',
    'preOperationTargetStateSha256',
    'expectedTargetStateSha256',
    'operationFingerprintSha256'
  ]) assertDigest(operation[key], code);
  assertSafePositiveInteger(operation.fence, code);
  if (operation.action !== OPERATION_ACTION) fail(ERRORS.BINDING_MISMATCH);
  const expectedFingerprint = canonicalHash({
    schemaVersion: 1,
    purpose: 'synthetic_s19a_test_only_model_operation',
    readinessReportSha256,
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
  if (operation.configurationSha256
        !== readinessReport.localIntentBinding.configurationSha256
      || operation.targetResourceSha256
        !== readinessReport.localIntentBinding.targetEnvironmentSha256
      || operation.operationFingerprintSha256 !== expectedFingerprint) {
    fail(ERRORS.BINDING_MISMATCH);
  }
}

function validateParticipants(participants) {
  const code = ERRORS.TRACE_INVALID;
  assertDataRecord(participants, PARTICIPANT_NAMES, code);
  const actorIds = [];
  const faultDomains = [];
  for (const name of PARTICIPANT_NAMES) {
    assertDataRecord(participants[name], [
      'modelActorIdSha256',
      'faultDomainSha256'
    ], code);
    assertDigest(participants[name].modelActorIdSha256, code);
    assertDigest(participants[name].faultDomainSha256, code);
    actorIds.push(participants[name].modelActorIdSha256);
    faultDomains.push(participants[name].faultDomainSha256);
  }
  if (new Set(actorIds).size !== actorIds.length
      || new Set(faultDomains).size !== faultDomains.length) {
    fail(ERRORS.PARTICIPANT_SEPARATION_INVALID);
  }
}

function eventBaseKeys() {
  return [
    'schemaVersion',
    'sequence',
    'eventType',
    'eventIdSha256',
    'operationIdSha256',
    'operationFingerprintSha256',
    'fence',
    'actor',
    'actorIdSha256',
    'faultDomainSha256',
    'payload'
  ];
}

function validateEventShape(event) {
  const code = ERRORS.EVENT_INVALID;
  assertDataRecord(event, eventBaseKeys(), code);
  if (event.schemaVersion !== 1
      || typeof event.eventType !== 'string'
      || typeof event.actor !== 'string'
      || !PARTICIPANT_NAMES.includes(event.actor)) fail(code);
  if (/compensat|rollback|release|refund|grant_reuse/i.test(event.eventType)) {
    fail(ERRORS.COMPENSATION_PROTOCOL_UNAVAILABLE);
  }
  if (!EVENT_TYPES.has(event.eventType)) fail(code);
  assertSafePositiveInteger(event.sequence, code);
  assertSafePositiveInteger(event.fence, code);
  for (const key of [
    'eventIdSha256',
    'operationIdSha256',
    'operationFingerprintSha256',
    'actorIdSha256',
    'faultDomainSha256'
  ]) assertDigest(event[key], code);

  const payloadKeys = {
    test_only_reservation_outbox_atomic_commit: [
      'modelReservationRecordSha256',
      'modelOutboxRecordSha256',
      'modelCoordinatorTransactionSha256',
      'modeledAtomicCommit'
    ],
    test_only_dispatch_result_unknown: [
      'modelDispatchAttemptSha256',
      'unknownDisposition'
    ],
    test_only_non_authoritative_ack_observed: [
      'modelAcknowledgementSha256',
      'ackKind'
    ],
    test_only_target_admission_observed: [
      'modelAdmissionRecordSha256',
      'submittedByActorIdSha256',
      'modelAdmissionDisposition'
    ],
    test_only_platform_change_event_observed: [
      'modelPlatformEventSha256',
      'modelAdmissionRecordSha256',
      'reportedTargetStateSha256'
    ],
    test_only_read_after_write_observed: [
      'modelReadObservationSha256',
      'modelPlatformEventSha256',
      'observedTargetStateSha256',
      'observationDisposition'
    ],
    test_only_health_observed: [
      'modelHealthObservationSha256',
      'observedTargetStateSha256',
      'healthDisposition'
    ],
    test_only_no_effect_proof_observed: [
      'modelNoEffectProofSha256',
      'proofScope',
      'operationEffectStatus',
      'targetFenceHighWater',
      'fencesAtOrBelowHighWaterRejected',
      'targetStateSha256'
    ]
  };
  assertDataRecord(event.payload, payloadKeys[event.eventType], code);
  for (const [key, value] of Object.entries(event.payload)) {
    if (key.endsWith('Sha256')) assertDigest(value, code);
  }
  if (event.eventType === 'test_only_reservation_outbox_atomic_commit'
      && event.payload.modeledAtomicCommit !== true) {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_dispatch_result_unknown'
      && event.payload.unknownDisposition
        !== 'no_authoritative_outcome_observed') {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_non_authoritative_ack_observed'
      && !NON_AUTHORITATIVE_ACK_KINDS.has(event.payload.ackKind)) {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_target_admission_observed'
      && event.payload.modelAdmissionDisposition
        !== 'admitted_for_reference_trace') {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_read_after_write_observed'
      && !['matches_expected', 'does_not_match_expected']
        .includes(event.payload.observationDisposition)) {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_health_observed'
      && !['healthy', 'unhealthy'].includes(event.payload.healthDisposition)) {
    fail(ERRORS.TRANSITION_INVALID);
  }
  if (event.eventType === 'test_only_no_effect_proof_observed') {
    assertSafePositiveInteger(event.payload.targetFenceHighWater, code);
    if (event.payload.proofScope !== 'exact_operation_and_target'
        || event.payload.operationEffectStatus !== 'not_applied'
        || event.payload.fencesAtOrBelowHighWaterRejected !== true) {
      fail(ERRORS.NO_EFFECT_PROOF_INSUFFICIENT);
    }
  }
}

function expectedActor(eventType) {
  return {
    test_only_reservation_outbox_atomic_commit: 'coordinator',
    test_only_dispatch_result_unknown: 'deployer',
    test_only_target_admission_observed: 'target',
    test_only_platform_change_event_observed: 'platformEventSource',
    test_only_read_after_write_observed: 'stateObserver',
    test_only_health_observed: 'healthObserver',
    test_only_no_effect_proof_observed: 'noEffectProofIssuer'
  }[eventType];
}

function isUnknownState(state) {
  return [
    'test_only_dispatch_unknown_sticky',
    'test_only_contradictory_observation_sticky',
    'test_only_unknown_admission_observed',
    'test_only_unknown_platform_event_observed'
  ].includes(state);
}

function assertEventBinding(event, operation, participants) {
  if (event.operationIdSha256 !== operation.operationIdSha256
      || event.operationFingerprintSha256 !== operation.operationFingerprintSha256
      || event.fence !== operation.fence) fail(ERRORS.BINDING_MISMATCH);
  const requiredActor = expectedActor(event.eventType);
  if (requiredActor) {
    const participant = participants[requiredActor];
    if (event.actor !== requiredActor
        || event.actorIdSha256 !== participant.modelActorIdSha256
        || event.faultDomainSha256 !== participant.faultDomainSha256) {
      fail(ERRORS.BINDING_MISMATCH);
    }
    return;
  }
  if (event.eventType === 'test_only_non_authoritative_ack_observed') {
    if (!['coordinator', 'deployer', 'target'].includes(event.actor)) {
      fail(ERRORS.BINDING_MISMATCH);
    }
    const participant = participants[event.actor];
    if (event.actorIdSha256 !== participant.modelActorIdSha256
        || event.faultDomainSha256 !== participant.faultDomainSha256) {
      fail(ERRORS.BINDING_MISMATCH);
    }
  }
}

function transition(state, event, context) {
  const { operation, participants, evidence } = context;
  const payload = event.payload;
  if (event.eventType === 'test_only_non_authoritative_ack_observed') {
    if (!NON_AUTHORITATIVE_ACK_KINDS.has(payload.ackKind)
        || state === 'test_only_intent_bound'
        || state === 'test_only_forward_trace_complete'
        || state === 'test_only_modeled_no_effect_shape_complete'
        || state === 'test_only_compensation_protocol_required') {
      fail(ERRORS.TRANSITION_INVALID);
    }
    evidence.nonAuthoritativeAcknowledgements += 1;
    return state;
  }

  if (state === 'test_only_forward_trace_complete'
      || state === 'test_only_modeled_no_effect_shape_complete'
      || state === 'test_only_compensation_protocol_required') {
    fail(state === 'test_only_compensation_protocol_required'
      ? ERRORS.COMPENSATION_PROTOCOL_UNAVAILABLE
      : ERRORS.TRANSITION_INVALID);
  }

  if (event.eventType === 'test_only_reservation_outbox_atomic_commit') {
    if (isUnknownState(state)) fail(ERRORS.UNKNOWN_STICKY);
    if (state !== 'test_only_intent_bound'
        || payload.modeledAtomicCommit !== true) fail(ERRORS.TRANSITION_INVALID);
    evidence.reservationOutboxAtomicEvent = true;
    evidence.modelAdmissionRecordSha256 = null;
    evidence.modelPlatformEventSha256 = null;
    return 'test_only_forward_dispatchable';
  }

  if (event.eventType === 'test_only_dispatch_result_unknown') {
    if (state !== 'test_only_forward_dispatchable'
        || payload.unknownDisposition !== 'no_authoritative_outcome_observed') {
      fail(ERRORS.TRANSITION_INVALID);
    }
    evidence.unknownSticky = true;
    evidence.dispatchUnknownEligibleForNoEffect = true;
    return 'test_only_dispatch_unknown_sticky';
  }

  if (event.eventType === 'test_only_target_admission_observed') {
    if (!['test_only_forward_dispatchable',
      'test_only_dispatch_unknown_sticky'].includes(state)
        || payload.submittedByActorIdSha256
          !== participants.deployer.modelActorIdSha256
        || payload.modelAdmissionDisposition !== 'admitted_for_reference_trace') {
      fail(isUnknownState(state)
        ? ERRORS.UNKNOWN_STICKY
        : ERRORS.TRANSITION_INVALID);
    }
    evidence.targetAdmission = true;
    evidence.dispatchUnknownEligibleForNoEffect = false;
    evidence.modelAdmissionRecordSha256 = payload.modelAdmissionRecordSha256;
    return state === 'test_only_dispatch_unknown_sticky'
      ? 'test_only_unknown_admission_observed'
      : 'test_only_forward_admitted';
  }

  if (event.eventType === 'test_only_platform_change_event_observed') {
    if (!['test_only_forward_admitted', 'test_only_unknown_admission_observed'].includes(state)
        || payload.modelAdmissionRecordSha256
          !== evidence.modelAdmissionRecordSha256
        || payload.reportedTargetStateSha256
          !== operation.expectedTargetStateSha256) fail(ERRORS.TRANSITION_INVALID);
    evidence.platformEvent = true;
    evidence.modelPlatformEventSha256 = payload.modelPlatformEventSha256;
    return state === 'test_only_unknown_admission_observed'
      ? 'test_only_unknown_platform_event_observed'
      : 'test_only_platform_event_observed';
  }

  if (event.eventType === 'test_only_read_after_write_observed') {
    if (!['test_only_platform_event_observed',
      'test_only_unknown_platform_event_observed'].includes(state)
        || payload.modelPlatformEventSha256
          !== evidence.modelPlatformEventSha256
        || !['matches_expected', 'does_not_match_expected']
          .includes(payload.observationDisposition)) fail(ERRORS.TRANSITION_INVALID);
    if (payload.observationDisposition === 'does_not_match_expected'
        || payload.observedTargetStateSha256
          !== operation.expectedTargetStateSha256) {
      evidence.unknownSticky = true;
      evidence.dispatchUnknownEligibleForNoEffect = false;
      return 'test_only_contradictory_observation_sticky';
    }
    evidence.independentRead = true;
    return 'test_only_effect_confirmed';
  }

  if (event.eventType === 'test_only_health_observed') {
    if (state !== 'test_only_effect_confirmed'
        || !['healthy', 'unhealthy'].includes(payload.healthDisposition)
        || payload.observedTargetStateSha256
          !== operation.expectedTargetStateSha256) fail(ERRORS.TRANSITION_INVALID);
    evidence.independentHealth = true;
    if (payload.healthDisposition === 'unhealthy') {
      evidence.compensationProtocolRequired = true;
      return 'test_only_compensation_protocol_required';
    }
    return 'test_only_forward_trace_complete';
  }

  if (event.eventType === 'test_only_no_effect_proof_observed') {
    if (state === 'test_only_contradictory_observation_sticky') {
      fail(ERRORS.CONTRADICTORY_EVIDENCE_UNRESOLVED);
    }
    if (state !== 'test_only_dispatch_unknown_sticky'
        || evidence.dispatchUnknownEligibleForNoEffect !== true
        || evidence.targetAdmission || evidence.platformEvent
        || evidence.independentRead || evidence.independentHealth) {
      fail(isUnknownState(state) ? ERRORS.UNKNOWN_STICKY : ERRORS.TRANSITION_INVALID);
    }
    if (payload.proofScope !== 'exact_operation_and_target'
        || payload.operationEffectStatus !== 'not_applied'
        || payload.targetFenceHighWater < operation.fence
        || payload.fencesAtOrBelowHighWaterRejected !== true
        || payload.targetStateSha256
          !== operation.preOperationTargetStateSha256) {
      fail(ERRORS.NO_EFFECT_PROOF_INSUFFICIENT);
    }
    evidence.modeledNoEffectShape = true;
    return 'test_only_modeled_no_effect_shape_complete';
  }

  fail(ERRORS.EVENT_INVALID);
}

function dispositionFor(state) {
  if (state === 'test_only_forward_trace_complete') {
    return 'modeled_forward_shape_complete';
  }
  if (state === 'test_only_modeled_no_effect_shape_complete') {
    return 'modeled_no_effect_shape_complete';
  }
  if (isUnknownState(state)) return 'sticky_unknown';
  if (state === 'test_only_compensation_protocol_required') {
    return 'compensation_protocol_required';
  }
  return 'incomplete';
}

function resultForDisposition(disposition) {
  if (['modeled_forward_shape_complete',
    'modeled_no_effect_shape_complete'].includes(disposition)) {
    return 'no_modeled_safety_violation_detected';
  }
  if (['sticky_unknown', 'compensation_protocol_required'].includes(disposition)) {
    return 'reference_trace_blocked_no_positive_conclusion';
  }
  return 'reference_trace_incomplete_no_positive_conclusion';
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function inspectSyntheticExternalSagaReferenceTraceForTest(document) {
  const inputCode = ERRORS.ARGUMENT_INVALID;
  assertDataRecord(document, [
    'schemaVersion',
    'purpose',
    'readinessReport',
    'modelOperation',
    'modelParticipants',
    'events'
  ], inputCode);
  if (document.schemaVersion !== 1 || document.purpose !== PURPOSE) fail(inputCode);
  const readinessReportSha256 = validateReadinessReport(document.readinessReport);
  validateOperation(document.modelOperation, readinessReportSha256, document.readinessReport);
  validateParticipants(document.modelParticipants);
  assertDataArray(
    document.events,
    ERRORS.TRACE_INVALID,
    MAX_EVENTS,
    ERRORS.TRACE_TOO_LARGE
  );

  let state = 'test_only_intent_bound';
  let highestSequence = 0;
  let replayedEventCount = 0;
  const sequenceHashes = new Map();
  const eventIds = new Map();
  const evidence = {
    reservationOutboxAtomicEvent: false,
    targetAdmission: false,
    platformEvent: false,
    independentRead: false,
    independentHealth: false,
    unknownSticky: false,
    modeledNoEffectShape: false,
    compensationProtocolRequired: false,
    dispatchUnknownEligibleForNoEffect: false,
    nonAuthoritativeAcknowledgements: 0,
    modelAdmissionRecordSha256: null,
    modelPlatformEventSha256: null
  };

  for (const event of document.events) {
    validateEventShape(event);
    const eventHash = canonicalHash(event);
    if (sequenceHashes.has(event.sequence)) {
      if (sequenceHashes.get(event.sequence) !== eventHash) fail(ERRORS.REPLAY_CONFLICT);
      replayedEventCount += 1;
      continue;
    }
    if (event.sequence !== highestSequence + 1) fail(ERRORS.SEQUENCE_INVALID);
    if (eventIds.has(event.eventIdSha256)) fail(ERRORS.REPLAY_CONFLICT);
    sequenceHashes.set(event.sequence, eventHash);
    eventIds.set(event.eventIdSha256, event.sequence);
    highestSequence = event.sequence;
    assertEventBinding(event, document.modelOperation, document.modelParticipants);
    state = transition(state, event, {
      operation: document.modelOperation,
      participants: document.modelParticipants,
      evidence
    });
  }

  const traceDisposition = dispositionFor(state);
  const selectedReferenceEvidenceSetComplete = [
    'modeled_forward_shape_complete',
    'modeled_no_effect_shape_complete'
  ].includes(traceDisposition);
  const output = {
    schemaVersion: 1,
    profile: PROFILE,
    scope: 'non_normative_test_only_reference',
    result: resultForDisposition(traceDisposition),
    referenceCoverage: 'minimum_selected_non_exhaustive',
    referenceState: state,
    traceDisposition,
    selectedReferenceEvidenceSetComplete,
    readinessReportSha256,
    modelOperationIdSha256: document.modelOperation.operationIdSha256,
    modelOperationFingerprintSha256:
      document.modelOperation.operationFingerprintSha256,
    modelFence: document.modelOperation.fence,
    uniqueEventCount: sequenceHashes.size,
    replayedEventCount,
    checks: {
      testOnlyReadinessSourceShapeBound: true,
      callerProvidedReportOriginAuthenticated: false,
      referenceModelNormative: false,
      approvedProtocolConformanceAssessed: false,
      externalProtocolApproved: false,
      externalProtocolConformanceVerified: false,
      authorityTrustRootApproved: false,
      externalRoleIdentitiesAuthenticated: false,
      externalFactsVerified: false,
      referenceReservationOutboxAtomicEventModeled:
        evidence.reservationOutboxAtomicEvent,
      referenceTargetAdmissionModeled: evidence.targetAdmission,
      referencePlatformEventModeled: evidence.platformEvent,
      referenceIndependentReadAfterWriteModeled: evidence.independentRead,
      referenceIndependentHealthModeled: evidence.independentHealth,
      referenceUnknownStickyModelApplied: evidence.unknownSticky,
      referenceNoEffectProofShapeModeled: evidence.modeledNoEffectShape,
      referenceCompensationProtocolRequired:
        evidence.compensationProtocolRequired,
      nonAuthoritativeAcknowledgementCount:
        evidence.nonAuthoritativeAcknowledgements,
      authoritativeNoEffectProofVerified: false,
      realExternalUnknownReconciledByThisModel: false,
      globalReservationVerified: false,
      durableOutboxAtomicityVerified: false,
      globalConsumptionVerified: false,
      targetAdmissionVerified: false,
      targetFenceEnforcementVerified: false,
      immutableDeploymentBindingVerified: false,
      independentPlatformStateVerified: false,
      independentReadAfterWriteVerified: false,
      healthVerified: false,
      trustedTimeVerified: false,
      latestCheckpointExternallyConfirmed: false,
      deploymentReceiptVerified: false,
      compensationProtocolAvailable: false,
      compensationAuthorized: false,
      rollbackSafetyVerified: false,
      originalGrantReusable: false
    },
    operations: {
      inMemoryReferenceTraceReduced: true,
      environmentRead: false,
      currentTimeRead: false,
      fileSystemAccessPerformed: false,
      databaseAccessPerformed: false,
      networkAccessPerformed: false,
      externalSubmissionPerformed: false,
      reservationPerformed: false,
      deploymentPerformed: false,
      compensationPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    },
    readyForExternalIntegration: false,
    realDeploymentStatus: 'not_observed',
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  };
  return deepFreeze(output);
}

module.exports = {
  SyntheticS19aTestSagaModelError,
  inspectSyntheticExternalSagaReferenceTraceForTest
};
