const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const candidate = require('../../scripts/support/synthetic-candidate-evidence');
const approval = require('../../scripts/support/synthetic-external-approval');
const preflight = require('../../scripts/preflight-synthetic-api');
const rootTools = require('../../scripts/support/synthetic-data-root-tools');
const bootstrap = require('../../scripts/support/synthetic-bootstrap');
const profile = require('../config/deployment-profile');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-approval-'));
const FIXED_TIMELINE = Object.freeze({
  now: '2026-08-28T02:10:00.000Z',
  keyNotBefore: '2026-08-28T00:00:00.000Z',
  keyNotAfter: '2026-08-29T00:00:00.000Z',
  policyIssuedAt: '2026-08-28T00:00:00.000Z',
  policyValidFrom: '2026-08-28T00:00:00.000Z',
  policyValidUntil: '2026-08-29T00:00:00.000Z',
  bootstrapLegalEffectiveAt: '2026-08-28T01:00:00.000Z',
  bootstrapAt: '2026-08-28T01:30:00.000Z',
  captureAt: '2026-08-28T02:00:00.000Z',
  attestationObservedAt: '2026-08-28T02:01:00.000Z',
  finalizedAt: '2026-08-28T02:05:00.000Z',
  gateVerifiedAt: '2026-08-28T02:06:00.000Z',
  approvalAt: '2026-08-28T02:07:00.000Z',
  grantAt: '2026-08-28T02:08:00.000Z',
  checkpointIssuedAt: '2026-08-28T02:09:00.000Z',
  grantExpiresAt: '2026-08-28T02:13:00.000Z',
  approvalExpiresAt: '2026-08-28T02:18:00.000Z',
  gateExpiresAt: '2026-08-28T02:20:00.000Z',
  attestationExpiresAt: '2026-08-28T02:25:00.000Z',
  checkpointValidUntil: '2026-08-28T03:00:00.000Z'
});
const now = new Date(FIXED_TIMELINE.now);

function liveTimeline(reference = new Date()) {
  const epoch = reference.getTime();
  const at = offset => new Date(epoch + offset).toISOString();
  return Object.freeze({
    now: at(0),
    keyNotBefore: at(-60 * 60 * 1000),
    keyNotAfter: at(24 * 60 * 60 * 1000),
    policyIssuedAt: at(-60 * 60 * 1000),
    policyValidFrom: at(-60 * 60 * 1000),
    policyValidUntil: at(24 * 60 * 60 * 1000),
    bootstrapLegalEffectiveAt: at(-30 * 60 * 1000),
    bootstrapAt: at(-20 * 60 * 1000),
    captureAt: at(-5 * 60 * 1000),
    attestationObservedAt: at(-4 * 60 * 1000),
    finalizedAt: at(-3 * 60 * 1000),
    gateVerifiedAt: at(-2 * 60 * 1000),
    approvalAt: at(-90 * 1000),
    grantAt: at(-60 * 1000),
    checkpointIssuedAt: at(-30 * 1000),
    grantExpiresAt: at(4 * 60 * 1000),
    approvalExpiresAt: at(8 * 60 * 1000),
    gateExpiresAt: at(10 * 60 * 1000),
    attestationExpiresAt: at(20 * 60 * 1000),
    checkpointValidUntil: at(30 * 60 * 1000)
  });
}

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function keyFixture(role, allowedGateIds, principalIdSha256, timeline) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  const keyId = digest(der);
  return {
    pair,
    record: {
      keyId,
      principalIdSha256,
      role,
      allowedGateIds,
      publicKeySpkiDerBase64url: der.toString('base64url'),
      notBefore: timeline.keyNotBefore,
      notAfter: timeline.keyNotAfter,
      status: 'active'
    }
  };
}

function signEnvelope(domain, payload, key) {
  const message = Buffer.concat([
    Buffer.from(`${domain}\0`, 'utf8'),
    Buffer.from(approval.canonicalJson(payload), 'utf8')
  ]);
  return {
    keyId: key.record.keyId,
    algorithm: 'Ed25519',
    payload,
    signatureBase64url: crypto.sign(null, message, key.pair.privateKey).toString('base64url')
  };
}

function s15Fixture(timeline = FIXED_TIMELINE) {
  const subjectSha256 = digest('S16 synthetic subject');
  const candidateBindingSha256 = digest('S16 synthetic candidate binding');
  const machineStateSha256 = digest('S16 synthetic machine state');
  const sourceCommit = digest('S16 synthetic source commit');
  const implementationTreeSha256 = digest('S16 synthetic implementation tree');
  const configurationSha256 = digest('S16 synthetic configuration');
  const rootContextSha256 = digest('S16 synthetic root context');
  const rolePrincipals = new Map();
  for (const [, role] of candidate.GATE_SPECS) {
    if (!rolePrincipals.has(role)) rolePrincipals.set(role, digest(`declarant ${role}`));
  }
  const externalAttestations = candidate.GATE_SPECS.map(([
    gateId,
    declarantRole,
    sourceType
  ]) => ({
    gateId,
    subjectSha256,
    evidenceReferenceSha256: digest(`opaque S15 reference ${gateId}`),
    declarantRole,
    sourceType,
    observedAt: timeline.attestationObservedAt,
    expiresAt: timeline.attestationExpiresAt,
    state: 'declared_satisfied_not_authenticated',
    signatureStatus: 'not_verified'
  }));
  const machineSubject = {
    schemaVersion: 1,
    subjectSha256,
    candidateBindingSha256,
    machineStateSha256,
    sourceCommit,
    implementationTreeSha256,
    bindings: {
      configurationSha256,
      rootContextSha256
    }
  };
  const s15FinalizeInput = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput: { syntheticFixture: true },
    machineSubject,
    externalAttestations
  };
  const s15FinalizedEvidence = {
    schemaVersion: 1,
    profile: 'synthetic-candidate-attestation-envelopes',
    result: 'attestation-envelopes-present',
    finalizedAt: timeline.finalizedAt,
    validUntil: timeline.attestationExpiresAt,
    subjectSha256,
    candidateBindingSha256,
    machineStateSha256,
    attestationSetSha256: approval.canonicalHash(externalAttestations),
    attestationCount: candidate.REQUIRED_GATE_IDS.length,
    requiredGateIds: candidate.REQUIRED_GATE_IDS,
    checks: {
      machineStateRevalidated: true,
      attestationAuthenticityVerified: false,
      externalFactsVerified: false
    },
    operations: {
      databaseOpenedReadOnly: true,
      networkAccessPerformed: false,
      deploymentPerformed: false
    },
    externalFactsVerifiedByThisCommand: false,
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  };
  return {
    rolePrincipals,
    s15FinalizeInput,
    s15FinalizedEvidence,
    sourceCommit,
    implementationTreeSha256,
    configurationSha256,
    rootContextSha256
  };
}

function realS15Fixture(
  label,
  timeline = FIXED_TIMELINE,
  useCommittedProvenance = false
) {
  const parent = path.join(tempRoot, `approved-${label}`);
  const root = path.join(parent, `tangguan-synthetic-${label}`);
  const origin = `https://synthetic-${label}.example.com`;
  fs.mkdirSync(parent);
  const relationSha256 = digest(`synthetic relation ${label}`);
  const environment = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    SYNTHETIC_RUNTIME_ACK: profile.SYNTHETIC_RUNTIME_ACK,
    SYNTHETIC_APP_CREDENTIALS_ACK: profile.SYNTHETIC_APP_CREDENTIALS_ACK,
    SYNTHETIC_DATA_ACK: profile.SYNTHETIC_DATA_ACK,
    SYNTHETIC_DATASET_ID: `synthetic-candidate-${label}`,
    SYNTHETIC_DATA_ROOT_APPROVED_PARENT: parent,
    SYNTHETIC_DATA_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    SQLITE_FILE: path.join(root, 'data', 'hefei-points-synthetic.sqlite'),
    API_PUBLIC_ORIGIN: origin,
    LEGAL_PUBLIC_ORIGIN: origin,
    GUARDIAN_RELATION_DECLARATION_VERSION: `synthetic-relation-${label}`,
    GUARDIAN_RELATION_DECLARATION_SHA256: relationSha256,
    GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
      `${origin}/legal/guardian-relation-declaration/`
      + `synthetic-relation-${label}/${relationSha256}.html`,
    WX_APPID: `wx${digest(`appid ${label}`).slice(0, 16)}`,
    WX_APPSECRET: `synthetic-secret-${label}-${digest(label).slice(0, 16)}`,
    HARMONY_CHILD_ENABLED: 'true',
    CHILD_ENROLLMENT_ENABLED: 'true',
    DEVICE_PAIRING_ENABLED: 'true',
    POINT_REQUESTS_ENABLED: 'true',
    CHILD_DATA_RIGHTS_ENABLED: 'false',
    LEGACY_CHILD_LOGIN_ENABLED: 'false',
    LEGACY_CHILD_MANAGEMENT_ENABLED: 'false',
    PAIRING_CLIENT_IP_MODE: 'direct',
    TRUSTED_PROXIES: '',
    LOG_LEVEL: 'info',
    SYNTHETIC_CANDIDATE_EVIDENCE_ACK: candidate.ACK
  };
  const implementationFiles = [
    ...Array.from({ length: 26 }, (_, index) => ({
      path: `scripts/synthetic-s16-fixture-${String(index).padStart(2, '0')}.js`,
      sha256: digest(`${label} implementation ${index}`)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      path: `server/db/migrations/${String(index + 1).padStart(3, '0')}_fixture.sql`,
      sha256: digest(`${label} migration ${index}`)
    }))
  ];
  const provenance = useCommittedProvenance
    ? preflight.committedProvenance()
    : Object.freeze({
      sourceCommit: digest(`${label} source commit`),
      implementationIndexMatchesHead: true,
      implementationWorktreeMatchesHeadAfterEolNormalization: true,
      implementationTreeSha256: digest(`${label} implementation tree`),
      implementationFiles: Object.freeze(
        implementationFiles.map(value => Object.freeze(value))
      )
    });
  environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK = rootTools.PREPARE_ACK;
  rootTools.prepareSyntheticDataRoot(environment, { projectRoot });
  delete environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK;
  const s13PreBootstrap = rootTools.verifySyntheticDataRoot(environment, { projectRoot });
  const s12Preflight = preflight.evidenceFor(environment, provenance);
  const legalTexts = [
    'privacy_policy',
    'child_personal_information_rules',
    'child_user_agreement',
    'sensitive_information_notice'
  ].map((type, index) => ({
    type,
    version: `synthetic-${label}-${index + 1}`,
    contentSha256: digest(`${label} legal ${type}`)
  }));
  environment.SYNTHETIC_BOOTSTRAP_ACK = bootstrap.BOOTSTRAP_ACK;
  const s14Bootstrap = bootstrap.bootstrapFromDocument(environment, {
    schemaVersion: 1,
    requestId: `synthetic-bootstrap-${label}-0123456789abcdef`,
    datasetId: environment.SYNTHETIC_DATASET_ID,
    approvalReference: `synthetic-approval-${label}-abcdef`,
    candidateProvenance: {
      sourceCommit: provenance.sourceCommit,
      implementationTreeSha256: provenance.implementationTreeSha256,
      configurationSha256: s12Preflight.configurationSha256
    },
    administrator: {
      id: `synthetic_admin_${label}`,
      password: `S16!${label}-Synthetic-Approval-Aa9`,
      credentialPurpose: bootstrap.CREDENTIAL_PURPOSE
    },
    legalEvidence: {
      effectiveAt: timeline.bootstrapLegalEffectiveAt,
      texts: legalTexts
    }
  }, { projectRoot, now: new Date(timeline.bootstrapAt) });
  delete environment.SYNTHETIC_BOOTSTRAP_ACK;
  const captureInput = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_machine_capture',
    candidateId: `synthetic-candidate-${digest(`candidate ${label}`).slice(0, 32)}`,
    s12Preflight,
    s13PreBootstrap,
    s14Bootstrap
  };
  const provenanceProvider = useCommittedProvenance ? undefined : () => provenance;
  const machineSubject = candidate.captureMachineSubject(environment, captureInput, {
    projectRoot,
    ...(provenanceProvider ? { provenanceProvider } : {}),
    now: new Date(timeline.captureAt)
  });
  const rolePrincipals = new Map();
  for (const [, role] of candidate.GATE_SPECS) {
    if (!rolePrincipals.has(role)) rolePrincipals.set(role, digest(`declarant ${role}`));
  }
  const externalAttestations = candidate.GATE_SPECS.map(([
    gateId,
    declarantRole,
    sourceType
  ]) => ({
    gateId,
    subjectSha256: machineSubject.subjectSha256,
    evidenceReferenceSha256: digest(`real opaque reference ${gateId}`),
    declarantRole,
    sourceType,
    observedAt: timeline.attestationObservedAt,
    expiresAt: timeline.attestationExpiresAt,
    state: 'declared_satisfied_not_authenticated',
    signatureStatus: 'not_verified'
  }));
  const s15FinalizeInput = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput,
    machineSubject,
    externalAttestations
  };
  const s15FinalizedEvidence = candidate.finalizeAttestations(
    environment,
    s15FinalizeInput,
    {
      projectRoot,
      ...(provenanceProvider ? { provenanceProvider } : {}),
      now: new Date(timeline.finalizedAt)
    }
  );
  return {
    rolePrincipals,
    s15FinalizeInput,
    s15FinalizedEvidence,
    sourceCommit: provenance.sourceCommit,
    implementationTreeSha256: provenance.implementationTreeSha256,
    configurationSha256: s12Preflight.configurationSha256,
    rootContextSha256: machineSubject.bindings.rootContextSha256,
    environment,
    provenanceProvider
  };
}

function fixture(label, overrides = {}) {
  const timeline = overrides.timeline || FIXED_TIMELINE;
  const s15 = overrides.s15 || s15Fixture(timeline);
  const verifierPrincipal = digest(`${label} external verifier principal`);
  const approvalPrincipal = overrides.approvalPrincipal
    || digest(`${label} independent approval principal`);
  const grantPrincipal = overrides.grantPrincipal
    || digest(`${label} independent grant principal`);
  const revocationPrincipal = overrides.revocationPrincipal
    || digest(`${label} independent revocation principal`);
  const verifierKey = keyFixture(
    'external_gate_verifier',
    [...candidate.REQUIRED_GATE_IDS],
    verifierPrincipal,
    timeline
  );
  const approvalKey = keyFixture(
    'deployment_approver', [], approvalPrincipal, timeline
  );
  const grantKey = keyFixture(
    'deployment_grant_issuer', [], grantPrincipal, timeline
  );
  const revocationKey = keyFixture(
    'revocation_authority', [], revocationPrincipal, timeline
  );
  const keys = [
    verifierKey.record,
    approvalKey.record,
    grantKey.record,
    revocationKey.record
  ]
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
  const approvalId = `synthetic-approval-${digest(`${label} approval`).slice(0, 32)}`;
  const grantId = `synthetic-grant-${digest(`${label} grant`).slice(0, 32)}`;
  const policy = {
    schemaVersion: 1,
    purpose: 'synthetic_external_approval_trust_policy',
    policyIdSha256: digest(`${label} policy identity`),
    revision: 7,
    issuedAt: timeline.policyIssuedAt,
    validFrom: timeline.policyValidFrom,
    validUntil: timeline.policyValidUntil,
    keys
  };
  if (overrides.mutatePolicy) overrides.mutatePolicy(policy, {
    verifierKey,
    approvalKey,
    grantKey,
    revocationKey
  });
  const policyParent = overrides.policyParent
    || path.join(tempRoot, `policy-${label}`);
  fs.mkdirSync(policyParent, { recursive: true });
  const policyFile = path.join(policyParent, 'trust-policy.json');
  const policyRaw = JSON.stringify(policy);
  fs.writeFileSync(policyFile, policyRaw, { mode: 0o600 });
  const policySha256 = digest(policyRaw);
  const environment = {
    ...(overrides.environment || {}),
    SYNTHETIC_EXTERNAL_APPROVAL_ACK: approval.ACK,
    SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT: policyParent,
    SYNTHETIC_APPROVAL_TRUST_POLICY_FILE: policyFile,
    SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256: policySha256
  };
  const revocationPayload = {
    schemaVersion: 1,
    purpose: 'synthetic_external_revocation_checkpoint',
    policySha256,
    sequence: 9,
    issuedAt: timeline.checkpointIssuedAt,
    validUntil: timeline.checkpointValidUntil,
    revokedKeyIds: [...(overrides.revokedKeyIds || [])].sort(),
    revokedPrincipalIdsSha256: [
      ...(overrides.revokedPrincipalIdsSha256 || [])
    ].sort(),
    revokedApprovalIdsSha256: [
      ...(overrides.revokeApproval ? [digest(approvalId)] : [])
    ].sort(),
    revokedGrantIdsSha256: [
      ...(overrides.revokeGrant ? [digest(grantId)] : [])
    ].sort()
  };
  if (overrides.mutateRevocation) overrides.mutateRevocation(revocationPayload, {
    verifierKey,
    approvalKey,
    grantKey,
    revocationKey
  });
  const signedRevocationCheckpoint = signEnvelope(
    approval.REVOCATION_DOMAIN,
    revocationPayload,
    revocationKey
  );
  const s15FinalizedEvidenceSha256 = approval.canonicalHash(s15.s15FinalizedEvidence);
  const targetEnvironmentSha256 = approval.canonicalHash({
    schemaVersion: 1,
    deploymentTier: 'synthetic',
    sourceCommit: s15.sourceCommit,
    implementationTreeSha256: s15.implementationTreeSha256,
    candidateBindingSha256: s15.s15FinalizedEvidence.candidateBindingSha256,
    rootContextSha256: s15.rootContextSha256,
    configurationSha256: s15.configurationSha256
  });
  const signedGateVerifications = candidate.GATE_SPECS.map(([
    gateId,
    declarantRole,
    sourceType
  ], index) => {
    const attestation = s15.s15FinalizeInput.externalAttestations[index];
    return signEnvelope(approval.GATE_DOMAIN, {
      schemaVersion: 1,
      purpose: 'synthetic_external_gate_verification',
      policySha256,
      subjectSha256: s15.s15FinalizedEvidence.subjectSha256,
      candidateBindingSha256: s15.s15FinalizedEvidence.candidateBindingSha256,
      machineStateSha256: s15.s15FinalizedEvidence.machineStateSha256,
      s15FinalizedEvidenceSha256,
      attestationSetSha256: s15.s15FinalizedEvidence.attestationSetSha256,
      targetEnvironmentSha256,
      gateId,
      evidenceReferenceSha256: attestation.evidenceReferenceSha256,
      evidenceContentSha256: digest(`${label} evidence content ${gateId}`),
      authorityRecordSha256: digest(`${label} authority record ${gateId}`),
      verificationRecordSha256: digest(`${label} verification record ${gateId}`),
      declarantRole,
      sourceType,
      declarantPrincipalIdSha256: s15.rolePrincipals.get(declarantRole),
      verifierPrincipalIdSha256: verifierPrincipal,
      observedAt: attestation.observedAt,
      verifiedAt: timeline.gateVerifiedAt,
      expiresAt: timeline.gateExpiresAt,
      identityStatus: 'authenticated_by_external_authority',
      evidenceStatus: 'retrieved_and_verified_by_external_connector',
      factStatus: 'verified_satisfied'
    }, verifierKey);
  });
  const gateVerificationSetSha256 = approval.canonicalHash(signedGateVerifications);
  const signedDeploymentApproval = signEnvelope(approval.APPROVAL_DOMAIN, {
    schemaVersion: 1,
    purpose: 'synthetic_external_deployment_approval',
    policySha256,
    subjectSha256: s15.s15FinalizedEvidence.subjectSha256,
    candidateBindingSha256: s15.s15FinalizedEvidence.candidateBindingSha256,
    machineStateSha256: s15.s15FinalizedEvidence.machineStateSha256,
    s15FinalizedEvidenceSha256,
    attestationSetSha256: s15.s15FinalizedEvidence.attestationSetSha256,
    gateVerificationSetSha256,
    targetEnvironmentSha256,
    approvalId,
    approverPrincipalIdSha256: approvalPrincipal,
    approvedAt: timeline.approvalAt,
    notBefore: timeline.approvalAt,
    expiresAt: timeline.approvalExpiresAt,
    decision: 'approved',
    scope: 'single_synthetic_api_deployment',
    auditRecordSha256: digest(`${label} immutable external approval audit record`),
    productionChildGateChangeAuthorization: 'not_granted',
    childUseAuthorization: 'not_granted'
  }, approvalKey);
  const approvalEnvelopeSha256 = approval.canonicalHash(signedDeploymentApproval);
  const signedDeploymentGrant = signEnvelope(approval.GRANT_DOMAIN, {
    schemaVersion: 1,
    purpose: 'synthetic_external_deployment_grant',
    policySha256,
    subjectSha256: s15.s15FinalizedEvidence.subjectSha256,
    candidateBindingSha256: s15.s15FinalizedEvidence.candidateBindingSha256,
    machineStateSha256: s15.s15FinalizedEvidence.machineStateSha256,
    sourceCommit: s15.sourceCommit,
    implementationTreeSha256: s15.implementationTreeSha256,
    configurationSha256: s15.configurationSha256,
    s15FinalizedEvidenceSha256,
    attestationSetSha256: s15.s15FinalizedEvidence.attestationSetSha256,
    gateVerificationSetSha256,
    approvalEnvelopeSha256,
    targetEnvironmentSha256,
    grantId,
    grantIssuerPrincipalIdSha256: grantPrincipal,
    consumerIdSha256: digest(`${label} external atomic deployment consumer`),
    issuedAt: timeline.grantAt,
    notBefore: timeline.grantAt,
    expiresAt: timeline.grantExpiresAt,
    action: 'deploy_synthetic_once',
    scope: 'single_synthetic_api_deployment',
    consumptionMode: 'external_atomic_single_use_required',
    productionChildGateChangeAuthorization: 'not_granted',
    childUseAuthorization: 'not_granted'
  }, grantKey);
  const document = {
    schemaVersion: 1,
    purpose: 'synthetic_external_approval_verify',
    s15FinalizeInput: s15.s15FinalizeInput,
    s15FinalizedEvidence: s15.s15FinalizedEvidence,
    signedRevocationCheckpoint,
    signedGateVerifications,
    signedDeploymentApproval,
    signedDeploymentGrant
  };
  const originalInput = approval.canonicalJson(document.s15FinalizeInput);
  const candidateFinalizer = overrides.useRealFinalizer
    ? undefined
    : (_environment, input, finalizerOptions = {}) => {
    if (approval.canonicalJson(input) !== originalInput) {
      const error = new Error('synthetic S15 fixture changed');
      error.code = 'SYNTHETIC_CANDIDATE_SOURCE_CHANGED';
      throw error;
    }
    return {
      ...s15.s15FinalizedEvidence,
      finalizedAt: finalizerOptions.now.toISOString()
    };
    };
  return {
    environment,
    document,
    policy,
    policyFile,
    policyRaw,
    policySha256,
    keys: { verifierKey, approvalKey, grantKey, revocationKey },
    principals: {
      verifierPrincipal,
      approvalPrincipal,
      grantPrincipal,
      revocationPrincipal
    },
    candidateFinalizer,
    verificationOptions: overrides.verificationOptions || {}
  };
}

function verify(value, extra = {}) {
  return approval.verifySyntheticExternalApprovalForTest(value.environment, value.document, {
    now,
    completedAt: now,
    ...value.verificationOptions,
    candidateFinalizer: value.candidateFinalizer,
    ...extra
  });
}

function verifyCheckpoint(value, extra = {}) {
  return approval.verifySyntheticRevocationCheckpointForTest(
    value.environment,
    value.document.signedRevocationCheckpoint,
    {
      now,
      completedAt: now,
      ...extra
    }
  );
}

function assertCode(work, code) {
  assert.throws(work, error => error instanceof approval.SyntheticExternalApprovalError
    && error.code === code);
}

test('S16 只验证钉住策略下的签名束并保持部署与儿童授权关闭', () => {
  const value = fixture('success');
  const result = verify(value);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.result, 'signed-bundle-valid-against-provided-policy-unconsumed');
  assert.equal(result.trustPolicyIdSha256, value.policy.policyIdSha256);
  assert.equal(
    result.consumerIdSha256,
    value.document.signedDeploymentGrant.payload.consumerIdSha256
  );
  assert.equal(
    result.sourceCommit,
    value.document.s15FinalizeInput.machineSubject.sourceCommit
  );
  assert.equal(
    result.implementationTreeSha256,
    value.document.s15FinalizeInput.machineSubject.implementationTreeSha256
  );
  assert.equal(
    result.configurationSha256,
    value.document.s15FinalizeInput.machineSubject.bindings.configurationSha256
  );
  assert.equal(result.gateVerificationCount, 19);
  assert.deepEqual(result.requiredGateIds, candidate.REQUIRED_GATE_IDS);
  assert.equal(result.checks.testOnlyOverridesUsed, true);
  assert.equal(result.checks.currentMachineStateRevalidated, false);
  assert.equal(result.operations.readOnlyGitSubprocessStarted, false);
  assert.equal(result.operations.databaseOpenedReadOnly, false);
  assert.equal(result.checks.ed25519Only, true);
  assert.equal(result.checks.domainSeparatedSignaturesVerifiedAgainstProvidedPolicy, true);
  assert.equal(result.checks.revocationCheckpointCoversSignedArtifacts, true);
  assert.equal(result.checks.revocationAuthorityDutySeparationChecked, true);
  assert.equal(result.checks.trustPolicyExternallyAuthorizedByThisCommand, false);
  assert.equal(result.checks.externalIdentityProofRetrievedByThisCommand, false);
  assert.equal(result.checks.externalEvidenceContentRetrievedByThisCommand, false);
  assert.equal(result.checks.externalAuditRecordRetrievedByThisCommand, false);
  assert.equal(result.checks.trustedTimeVerified, false);
  assert.equal(result.checks.revocationCheckpointMonotonicityExternallyVerified, false);
  assert.equal(result.checks.approvalNonRepudiationEstablished, false);
  assert.equal(result.checks.authorizationConsumptionVerified, false);
  assert.equal(result.checks.replayProtectionPersisted, false);
  assert.equal(result.declarantIdentitiesAuthenticatedByThisCommand, false);
  assert.equal(result.authoritativeEvidenceVerifiedByThisCommand, false);
  assert.equal(result.externalFactsVerifiedByThisCommand, false);
  assert.equal(result.deploymentGrantStatus,
    'signature_valid_against_provided_policy_unconsumed');
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.productionChildGateState, 'not_observed');
  assert.equal(result.childUseAuthorization, 'not_granted');
  const raw = JSON.stringify(result);
  for (const forbidden of [
    value.policyFile,
    value.policyRaw,
    value.keys.verifierKey.record.publicKeySpkiDerBase64url,
    value.document.signedGateVerifications[0].signatureBase64url,
    value.document.signedDeploymentApproval.signatureBase64url,
    value.document.signedDeploymentGrant.signatureBase64url
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
});

test('checkpoint 生产 API 二读策略并返回冻结的安全摘要副本', () => {
  const value = fixture('checkpoint-production-api', { timeline: liveTimeline() });
  const payload = value.document.signedRevocationCheckpoint.payload;
  const policyDirectoryBefore = fs.readdirSync(path.dirname(value.policyFile));
  const policyBytesBefore = fs.readFileSync(value.policyFile);
  const result = approval.verifySyntheticRevocationCheckpoint(
    value.environment,
    value.document.signedRevocationCheckpoint
  );
  const policyBytesAfter = fs.readFileSync(value.policyFile);

  assert.equal(result.schemaVersion, 1);
  assert.equal(
    result.result,
    'revocation-checkpoint-valid-against-provided-policy-not-authoritative-latest'
  );
  assert.equal(result.trustPolicyIdSha256, value.policy.policyIdSha256);
  assert.equal(result.trustPolicySha256, value.policySha256);
  assert.equal(result.trustPolicyRevision, value.policy.revision);
  assert.equal(result.revocationCheckpointSha256,
    approval.canonicalHash(value.document.signedRevocationCheckpoint));
  assert.equal(result.revocationCheckpointSequence, payload.sequence);
  assert.equal(result.revocationCheckpointIssuedAt, payload.issuedAt);
  assert.equal(result.revocationCheckpointValidUntil, payload.validUntil);
  assert.equal(
    result.revocationAuthorityPrincipalIdSha256,
    value.principals.revocationPrincipal
  );
  assert.deepEqual(result.revokedKeyIds, payload.revokedKeyIds);
  assert.deepEqual(
    result.revokedPrincipalIdsSha256,
    payload.revokedPrincipalIdsSha256
  );
  assert.deepEqual(
    result.revokedApprovalIdsSha256,
    payload.revokedApprovalIdsSha256
  );
  assert.deepEqual(result.revokedGrantIdsSha256, payload.revokedGrantIdsSha256);
  assert.notEqual(result.revokedKeyIds, payload.revokedKeyIds);
  assert.notEqual(result.revokedPrincipalIdsSha256, payload.revokedPrincipalIdsSha256);
  assert.notEqual(result.revokedApprovalIdsSha256, payload.revokedApprovalIdsSha256);
  assert.notEqual(result.revokedGrantIdsSha256, payload.revokedGrantIdsSha256);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(result.operations), true);
  assert.equal(Object.isFrozen(result.revokedKeyIds), true);
  assert.equal(Object.isFrozen(result.revokedPrincipalIdsSha256), true);
  assert.equal(Object.isFrozen(result.revokedApprovalIdsSha256), true);
  assert.equal(Object.isFrozen(result.revokedGrantIdsSha256), true);
  assert.equal(result.checks.testOnlyOverridesUsed, false);
  assert.equal(result.checks.productionPolicyReadPathUsed, true);
  assert.equal(result.checks.trustPolicyFileStableDuringVerification, true);
  assert.equal(result.checks.trustPolicyExternallyAuthorizedByThisCommand, false);
  assert.equal(result.checks.revocationAuthorityIdentityAuthenticatedByThisCommand, false);
  assert.equal(result.checks.revocationCheckpointLatestAtAuthorityVerified, false);
  assert.equal(result.checks.trustedTimeVerified, false);
  assert.equal(result.operations.trustPolicyFileReadOnly, true);
  assert.equal(result.operations.networkAccessPerformedByVerifier, false);
  assert.equal(result.operations.fileWritePerformedByVerifier, false);
  assert.equal(result.operations.databaseWritePerformedByVerifier, false);
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.productionChildGateState, 'not_observed');
  assert.equal(result.childUseAuthorization, 'not_granted');
  assert.deepEqual(fs.readdirSync(path.dirname(value.policyFile)), policyDirectoryBefore);
  assert.deepEqual(policyBytesAfter, policyBytesBefore);
  const raw = JSON.stringify(result);
  for (const forbidden of [
    value.policyFile,
    value.policyRaw,
    value.keys.revocationKey.record.publicKeySpkiDerBase64url,
    value.document.signedRevocationCheckpoint.signatureBase64url
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
});

test('checkpoint 测试 seam 明示非生产并保持外部权威与可信时间未验证', () => {
  const value = fixture('checkpoint-test-seam');
  const result = verifyCheckpoint(value);
  assert.equal(result.checks.testOnlyOverridesUsed, true);
  assert.equal(result.checks.productionPolicyReadPathUsed, false);
  assert.equal(result.checks.trustPolicyFileStableDuringVerification, false);
  assert.equal(result.operations.trustPolicyFileReadOnly, false);
  assert.equal(result.checks.trustPolicyExternallyAuthorizedByThisCommand, false);
  assert.equal(result.checks.revocationCheckpointLatestAtAuthorityVerified, false);
  assert.equal(result.checks.trustedTimeVerified, false);
  assert.equal(result.deploymentAuthorization, 'not_granted');
});

test('checkpoint API 拒绝未来、完成时过期和错误 Ed25519 签名', () => {
  const missingAck = fixture('checkpoint-api-missing-ack');
  delete missingAck.environment.SYNTHETIC_EXTERNAL_APPROVAL_ACK;
  assertCode(
    () => verifyCheckpoint(missingAck),
    'SYNTHETIC_EXTERNAL_APPROVAL_ACK_REQUIRED'
  );

  const future = fixture('checkpoint-api-future', {
    mutateRevocation(checkpointValue) {
      checkpointValue.issuedAt = '2026-08-28T02:10:00.001Z';
    }
  });
  assertCode(
    () => verifyCheckpoint(future),
    'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID'
  );

  const expired = fixture('checkpoint-api-completion-expired');
  assertCode(
    () => verifyCheckpoint(expired, {
      completedAt: new Date(expired.document.signedRevocationCheckpoint.payload.validUntil)
    }),
    'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_EXPIRED'
  );

  const signature = fixture('checkpoint-api-signature-invalid');
  const encoded = signature.document.signedRevocationCheckpoint.signatureBase64url;
  signature.document.signedRevocationCheckpoint.signatureBase64url =
    `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`;
  assertCode(
    () => verifyCheckpoint(signature),
    'SYNTHETIC_EXTERNAL_APPROVAL_SIGNATURE_INVALID'
  );
});

test('checkpoint API 在第二次策略读取发生漂移时 fail closed', () => {
  const value = fixture('checkpoint-api-policy-drift');
  assertCode(
    () => approval.verifySyntheticRevocationCheckpointForTest(
      value.environment,
      value.document.signedRevocationCheckpoint,
      {
        now,
        completedAt: now,
        afterFirstPolicyRead() {
          fs.writeFileSync(value.policyFile, `${value.policyRaw} `, { mode: 0o600 });
        }
      }
    ),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_CHANGED'
  );
});

test('输入公钥不能替代独立策略文件，且拒绝额外字段或非 canonical JSON', () => {
  const value = fixture('untrusted-key');
  assertCode(
    () => approval.verifySyntheticExternalApprovalForTest(value.environment, {
      ...value.document,
      attackerPublicKey: value.keys.verifierKey.record.publicKeySpkiDerBase64url
    }, { now, candidateFinalizer: value.candidateFinalizer }),
    'SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID'
  );
  for (const raw of [
    `${JSON.stringify(value.document)}\r\n`,
    ` ${JSON.stringify(value.document)}`,
    `${JSON.stringify(value.document)}\n\n`
  ]) {
    assertCode(
      () => approval.decodeCanonicalInput(Buffer.from(raw), value.environment),
      'SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID'
    );
  }
});

test('逐门签名强绑定 subject、候选、集合、证据与目标环境', () => {
  const mutations = [
    ['subjectSha256', digest('changed subject')],
    ['candidateBindingSha256', digest('changed candidate')],
    ['attestationSetSha256', digest('changed attestation set')],
    ['evidenceReferenceSha256', digest('changed evidence reference')],
    ['evidenceContentSha256', digest('changed evidence content')],
    ['targetEnvironmentSha256', digest('changed target')],
    ['factStatus', 'unverified']
  ];
  for (const [field, changed] of mutations) {
    const value = fixture(`gate-mutation-${field}`);
    value.document.signedGateVerifications[0].payload[field] = changed;
    assertCode(() => verify(value), 'SYNTHETIC_EXTERNAL_APPROVAL_SIGNATURE_INVALID');
  }
});

test('逐门记录即使由正确核验密钥重签也不能绕过语义约束', () => {
  const mutations = [
    ['gateId', (_payload, value) => (
      value.document.signedGateVerifications[1].payload.gateId
    )],
    ['declarantRole', () => 'unexpected_role'],
    ['sourceType', () => 'unexpected_source'],
    ['evidenceReferenceSha256', () => digest('wrong evidence reference')],
    ['verifierPrincipalIdSha256', payload => payload.declarantPrincipalIdSha256],
    ['verificationRecordSha256', (_payload, value) => (
      value.document.signedGateVerifications[1].payload.verificationRecordSha256
    )],
    ['identityStatus', () => 'not_authenticated'],
    ['evidenceStatus', () => 'not_retrieved'],
    ['factStatus', () => 'unverified'],
    ['verifiedAt', () => '2026-08-28T02:04:59.999Z']
  ];
  for (const [field, changed] of mutations) {
    const value = fixture(`gate-semantic-${field}`);
    const payload = value.document.signedGateVerifications[0].payload;
    payload[field] = changed(payload, value);
    value.document.signedGateVerifications[0] = signEnvelope(
      approval.GATE_DOMAIN,
      payload,
      value.keys.verifierKey
    );
    assertCode(() => verify(value), 'SYNTHETIC_EXTERNAL_APPROVAL_GATE_INVALID');
  }
});

test('固定 Ed25519、keyId/SPKI 和签名用途，拒绝算法或角色混淆', () => {
  const algorithm = fixture('algorithm-confusion');
  algorithm.document.signedGateVerifications[0].algorithm = 'EdDSA';
  assertCode(() => verify(algorithm), 'SYNTHETIC_EXTERNAL_APPROVAL_GATE_INVALID');

  const role = fixture('role-confusion');
  role.document.signedDeploymentApproval.keyId = role.keys.verifierKey.record.keyId;
  assertCode(() => verify(role), 'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_INVALID');

  const malformed = fixture('malformed-key', {
    mutatePolicy(policy) {
      policy.keys[0].keyId = digest('wrong key id');
      policy.keys.sort((left, right) => left.keyId.localeCompare(right.keyId));
    }
  });
  assertCode(() => verify(malformed), 'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID');
});

test('审批人、grant 签发人与声明人/核验人按 principal 强制隔离', () => {
  const declarant = digest('declarant application_operator');
  const approvalOverlap = fixture('approval-overlap', { approvalPrincipal: declarant });
  assertCode(
    () => verify(approvalOverlap),
    'SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID'
  );

  const overlapLabel = 'grant-overlap-principal';
  const changed = fixture(overlapLabel, {
    grantPrincipal: digest(`${overlapLabel} external verifier principal`)
  });
  assertCode(
    () => verify(changed),
    'SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID'
  );

  const revocationOverlap = fixture('revocation-overlap', {
    revocationPrincipal: declarant
  });
  assertCode(
    () => verify(revocationOverlap),
    'SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID'
  );
});

test('撤销的审批或 grant 即使签名正确也 fail closed', () => {
  const revokedApproval = fixture('revoked-approval', { revokeApproval: true });
  assertCode(
    () => verify(revokedApproval),
    'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_REVOKED'
  );
  const revokedGrant = fixture('revoked-grant', { revokeGrant: true });
  assertCode(
    () => verify(revokedGrant),
    'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED'
  );

  const revokedVerifierKey = fixture('revoked-verifier-key', {
    mutateRevocation(checkpointValue, { verifierKey }) {
      checkpointValue.revokedKeyIds = [verifierKey.record.keyId];
    }
  });
  assertCode(
    () => verify(revokedVerifierKey),
    'SYNTHETIC_EXTERNAL_APPROVAL_KEY_REVOKED'
  );

  const revokedVerifierPrincipal = fixture('revoked-verifier-principal', {
    mutateRevocation(checkpointValue, { verifierKey }) {
      checkpointValue.revokedPrincipalIdsSha256 = [
        verifierKey.record.principalIdSha256
      ];
    }
  });
  assertCode(
    () => verify(revokedVerifierPrincipal),
    'SYNTHETIC_EXTERNAL_APPROVAL_IDENTITY_REVOKED'
  );
});

test('签发后的新 checkpoint 可选择性撤销旧 grant 而不改写稳定 policy', () => {
  const value = fixture('post-issuance-revocation');
  const policySha256 = value.policySha256;
  const revokedGrantIdSha256 = digest(
    value.document.signedDeploymentGrant.payload.grantId
  );
  value.document.signedRevocationCheckpoint.payload = {
    ...value.document.signedRevocationCheckpoint.payload,
    sequence: value.document.signedRevocationCheckpoint.payload.sequence + 1,
    issuedAt: '2026-08-28T02:09:00.000Z',
    revokedGrantIdsSha256: [revokedGrantIdSha256]
  };
  value.document.signedRevocationCheckpoint = signEnvelope(
    approval.REVOCATION_DOMAIN,
    value.document.signedRevocationCheckpoint.payload,
    value.keys.revocationKey
  );
  assert.equal(value.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256, policySha256);
  assertCode(
    () => verify(value),
    'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED'
  );
});

test('审批与 grant 的时效、作用域和目标绑定不能扩张', () => {
  const expired = fixture('expired-grant');
  expired.document.signedDeploymentGrant.payload.expiresAt = '2026-08-28T02:10:00.000Z';
  expired.document.signedDeploymentGrant = signEnvelope(
    approval.GRANT_DOMAIN,
    expired.document.signedDeploymentGrant.payload,
    expired.keys.grantKey
  );
  assertCode(
    () => verify(expired),
    'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_EXPIRED'
  );

  const target = fixture('target-mismatch');
  target.document.signedDeploymentGrant.payload.targetEnvironmentSha256 = digest('other target');
  target.document.signedDeploymentGrant = signEnvelope(
    approval.GRANT_DOMAIN,
    target.document.signedDeploymentGrant.payload,
    target.keys.grantKey
  );
  assertCode(
    () => verify(target),
    'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_TARGET_MISMATCH'
  );

  const child = fixture('child-escalation');
  child.document.signedDeploymentApproval.payload.childUseAuthorization = 'granted';
  child.document.signedDeploymentApproval = signEnvelope(
    approval.APPROVAL_DOMAIN,
    child.document.signedDeploymentApproval.payload,
    child.keys.approvalKey
  );
  assertCode(
    () => verify(child),
    'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_INVALID'
  );

  const approvalScope = fixture('approval-scope');
  approvalScope.document.signedDeploymentApproval.payload.scope =
    'all_synthetic_deployments';
  approvalScope.document.signedDeploymentApproval = signEnvelope(
    approval.APPROVAL_DOMAIN,
    approvalScope.document.signedDeploymentApproval.payload,
    approvalScope.keys.approvalKey
  );
  assertCode(
    () => verify(approvalScope),
    'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_INVALID'
  );

  for (const [field, changed] of [
    ['action', 'deploy_production'],
    ['consumptionMode', 'reusable']
  ]) {
    const grant = fixture(`grant-${field}`);
    grant.document.signedDeploymentGrant.payload[field] = changed;
    grant.document.signedDeploymentGrant = signEnvelope(
      approval.GRANT_DOMAIN,
      grant.document.signedDeploymentGrant.payload,
      grant.keys.grantKey
    );
    assertCode(
      () => verify(grant),
      'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_INVALID'
    );
  }

  const completion = fixture('completion-expired');
  assertCode(
    () => verify(completion, {
      completedAt: new Date('2026-08-28T02:13:00.000Z')
    }),
    'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_EXPIRED'
  );
});

test('每次验证先重跑 S15，当前来源漂移或过期不能沿用签名束', () => {
  const exactTimes = fixture('s15-exact-times');
  const finalizer = exactTimes.candidateFinalizer;
  const calls = [];
  approval.verifySyntheticExternalApprovalForTest(
    exactTimes.environment,
    exactTimes.document,
    {
      now,
      completedAt: now,
      candidateFinalizer(environment, input, options) {
        calls.push(options.now.toISOString());
        return finalizer(environment, input, options);
      }
    }
  );
  assert.deepEqual(calls, [
    exactTimes.document.s15FinalizedEvidence.finalizedAt,
    now.toISOString()
  ]);

  const changed = fixture('s15-changed');
  changed.document.s15FinalizeInput.captureInput.syntheticFixture = false;
  assertCode(
    () => verify(changed),
    'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_CHANGED'
  );

  const expired = fixture('s15-expired');
  assertCode(
    () => approval.verifySyntheticExternalApprovalForTest(expired.environment, expired.document, {
      now: new Date('2026-08-28T02:25:00.000Z'),
      completedAt: new Date('2026-08-28T02:25:00.000Z'),
      candidateFinalizer: expired.candidateFinalizer
    }),
    'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_EXPIRED'
  );
});

test('信任策略必须来自独立固定文件且两次读取保持钉住', () => {
  const missing = fixture('missing-policy');
  delete missing.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256;
  assertCode(
    () => verify(missing),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE'
  );

  const changed = fixture('policy-change-race');
  const finalizer = changed.candidateFinalizer;
  assertCode(
    () => approval.verifySyntheticExternalApprovalForTest(changed.environment, changed.document, {
      now,
      completedAt: now,
      candidateFinalizer(environment, input, options) {
        const result = finalizer(environment, input, options);
        fs.writeFileSync(changed.policyFile, `${changed.policyRaw} `, { mode: 0o600 });
        return result;
      }
    }),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID'
  );

  for (const networkPath of [
    '\\\\synthetic-host\\share\\trust-policy.json',
    '\\\\?\\UNC\\synthetic-host\\share\\trust-policy.json'
  ]) {
    const network = fixture(`network-${digest(networkPath).slice(0, 8)}`);
    network.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE = networkPath;
    network.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT =
      path.win32.dirname(networkPath);
    assertCode(
      () => verify(network),
      'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
    );
  }

  const networkDataRoot = fixture('network-data-root');
  networkDataRoot.environment.SYNTHETIC_DATA_ROOT =
    '\\\\synthetic-host\\share\\synthetic-data-root';
  assertCode(
    () => verify(networkDataRoot),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
  );
});

test('信任策略路径的任一祖先 junction 或 symlink 都在读取前拒绝', t => {
  const physicalAncestor = path.join(tempRoot, 'policy-physical-ancestor');
  const physicalParent = path.join(physicalAncestor, 'approved');
  const value = fixture('linked-policy-ancestor', { policyParent: physicalParent });
  const linkedAncestor = path.join(tempRoot, 'policy-linked-ancestor');
  try {
    fs.symlinkSync(
      physicalAncestor,
      linkedAncestor,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error && error.code)) {
      t.diagnostic('当前平台不能创建 junction/symlink；运行时逐段拒绝仍由代码检查');
      return;
    }
    throw error;
  }
  const linkedParent = path.join(linkedAncestor, 'approved');
  value.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT = linkedParent;
  value.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE =
    path.join(linkedParent, 'trust-policy.json');
  assertCode(
    () => verify(value),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
  );
});

test('信任策略与数据根只接受无 dot-segment 的 canonical 绝对路径', () => {
  const policyAlias = fixture('policy-dot-segment');
  const canonicalParent = policyAlias.environment
    .SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT;
  const aliasedParent = `${path.dirname(canonicalParent)}${path.sep}.`
    + `${path.sep}${path.basename(canonicalParent)}`;
  policyAlias.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT =
    aliasedParent;
  policyAlias.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE =
    `${aliasedParent}${path.sep}trust-policy.json`;
  assertCode(
    () => verify(policyAlias),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
  );

  const dataRootAlias = fixture('data-root-dot-segment');
  dataRootAlias.environment.SYNTHETIC_DATA_ROOT =
    `${tempRoot}${path.sep}.${path.sep}synthetic-data-root`;
  assertCode(
    () => verify(dataRootAlias),
    'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
  );

  if (process.platform === 'win32') {
    const mixed = fixture('policy-mixed-separators');
    mixed.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT =
      mixed.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT
        .replaceAll('\\', '/');
    mixed.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE =
      mixed.environment.SYNTHETIC_APPROVAL_TRUST_POLICY_FILE.replaceAll('\\', '/');
    assertCode(
      () => verify(mixed),
      'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE'
    );
  }
});

test('输出有效期截断到撤销 checkpoint 与实际使用密钥的最早失效点', () => {
  const checkpoint = fixture('checkpoint-short', {
    mutateRevocation(checkpointValue) {
      checkpointValue.validUntil = '2026-08-28T02:11:00.000Z';
    }
  });
  assert.equal(verify(checkpoint).validUntil, '2026-08-28T02:11:00.000Z');

  const key = fixture('grant-key-short', {
    mutatePolicy(_policy, { grantKey }) {
      grantKey.record.notAfter = '2026-08-28T02:11:30.000Z';
    }
  });
  assert.equal(verify(key).validUntil, '2026-08-28T02:11:30.000Z');
});

test('撤销 checkpoint 必须先签发再到期', () => {
  for (const validUntil of [
    '2026-08-28T02:15:00.000Z',
    '2026-08-28T02:14:59.999Z'
  ]) {
    const value = fixture(`checkpoint-order-${validUntil.slice(-5)}`, {
      mutateRevocation(checkpointValue) {
        checkpointValue.issuedAt = '2026-08-28T02:15:00.000Z';
        checkpointValue.validUntil = validUntil;
      }
    });
    assertCode(
      () => verify(value),
      'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID'
    );
  }

  const stale = fixture('checkpoint-before-grant', {
    mutateRevocation(checkpointValue) {
      checkpointValue.issuedAt = '2026-08-28T02:07:59.999Z';
    }
  });
  assertCode(
    () => verify(stale),
    'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID'
  );

  const future = fixture('checkpoint-in-future', {
    mutateRevocation(checkpointValue) {
      checkpointValue.issuedAt = '2026-08-28T02:10:00.001Z';
    }
  });
  assertCode(
    () => verify(future),
    'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID'
  );
});

test('真实 S12-S15 合成根在 S16 验证时重跑只读状态且不产生 sidecar', () => {
  const s15 = realS15Fixture('realintegration');
  const value = fixture('real-integration-bundle', {
    s15,
    environment: s15.environment,
    useRealFinalizer: true,
    verificationOptions: {
      projectRoot,
      provenanceProvider: s15.provenanceProvider
    }
  });
  const databaseBefore = fs.readFileSync(s15.environment.SQLITE_FILE);
  const metadataBefore = fs.statSync(s15.environment.SQLITE_FILE, { bigint: true });
  const result = verify(value);
  const databaseAfter = fs.readFileSync(s15.environment.SQLITE_FILE);
  const metadataAfter = fs.statSync(s15.environment.SQLITE_FILE, { bigint: true });
  assert.equal(result.checks.testOnlyOverridesUsed, true);
  assert.equal(result.checks.currentMachineStateRevalidated, false);
  assert.equal(result.operations.databaseOpenedReadOnly, false);
  assert.equal(result.operations.syntheticDatabaseWritten, false);
  assert.deepEqual(databaseAfter, databaseBefore);
  assert.equal(metadataAfter.size, metadataBefore.size);
  assert.equal(metadataAfter.mtimeNs, metadataBefore.mtimeNs);
  assert.deepEqual(fs.readdirSync(s15.environment.DATA_DIR), [
    'hefei-points-synthetic.sqlite'
  ]);
});

test('32 次确定性重复验证结果一致且不产生消费状态', async () => {
  const value = fixture('concurrent');
  const directoryBefore = fs.readdirSync(path.dirname(value.policyFile));
  const first = verify(value);
  const results = await Promise.all(Array.from({ length: 32 }, async () => verify(value)));
  for (const result of results) assert.deepEqual(result, first);
  assert.deepEqual(fs.readdirSync(path.dirname(value.policyFile)), directoryBefore);
  assert.equal(first.checks.authorizationConsumptionVerified, false);
  assert.equal(first.checks.replayProtectionPersisted, false);
  assert.equal(first.deploymentAuthorization, 'not_granted');
});

test('真实成功 CLI 无测试替身地重验 committed S12-S15 且只读脱敏', () => {
  const timeline = liveTimeline();
  const s15 = realS15Fixture('realclisuccess', timeline, true);
  const value = fixture('real-cli-success-bundle', {
    timeline,
    s15,
    environment: s15.environment,
    useRealFinalizer: true
  });
  const script = path.join(projectRoot, 'scripts', 'verify-synthetic-external-approval.js');
  const databaseBefore = fs.readFileSync(s15.environment.SQLITE_FILE);
  const metadataBefore = fs.statSync(s15.environment.SQLITE_FILE, { bigint: true });
  const result = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: `${JSON.stringify(value.document)}\n`,
    env: { ...process.env, ...value.environment },
    timeout: 45000,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.checks.testOnlyOverridesUsed, false);
  assert.equal(output.checks.currentMachineStateRevalidated, true);
  assert.equal(output.checks.s15EnvelopeRevalidated, true);
  assert.equal(output.operations.readOnlyGitSubprocessStarted, true);
  assert.equal(output.operations.databaseOpenedReadOnly, true);
  assert.equal(output.operations.syntheticDatabaseWritten, false);
  assert.equal(output.operations.networkAccessPerformed, false);
  assert.equal(output.operations.deploymentPerformed, false);
  assert.equal(output.deploymentGrantStatus,
    'signature_valid_against_provided_policy_unconsumed');
  assert.equal(output.deploymentAuthorization, 'not_granted');
  assert.equal(output.productionChildGateState, 'not_observed');
  assert.equal(output.childUseAuthorization, 'not_granted');
  assert.equal(output.trustPolicySha256, value.policySha256);
  const raw = result.stdout;
  for (const forbidden of [
    value.policyFile,
    value.policyRaw,
    value.document.signedRevocationCheckpoint.signatureBase64url,
    value.document.signedGateVerifications[0].signatureBase64url,
    value.document.signedDeploymentApproval.signatureBase64url,
    value.document.signedDeploymentApproval.payload.approvalId,
    value.document.signedDeploymentGrant.signatureBase64url,
    value.document.signedDeploymentGrant.payload.grantId
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
  const databaseAfter = fs.readFileSync(s15.environment.SQLITE_FILE);
  const metadataAfter = fs.statSync(s15.environment.SQLITE_FILE, { bigint: true });
  assert.deepEqual(databaseAfter, databaseBefore);
  assert.equal(metadataAfter.size, metadataBefore.size);
  assert.equal(metadataAfter.mtimeNs, metadataBefore.mtimeNs);
  assert.deepEqual(fs.readdirSync(s15.environment.DATA_DIR), [
    'hefei-points-synthetic.sqlite'
  ]);
});

test('真实 CLI help 与失败只输出稳定、单行、脱敏结果', () => {
  const script = path.join(projectRoot, 'scripts', 'verify-synthetic-external-approval.js');
  const help = spawnSync(process.execPath, [script, '--help'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /does not fetch identity\/evidence\/audit facts/);
  assert.equal(help.stderr, '');

  const failure = spawnSync(process.execPath, [script, '--unexpected'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(
    failure.stderr,
    'Synthetic external approval verification failed '
      + '(SYNTHETIC_EXTERNAL_APPROVAL_ARGUMENT_INVALID).\n'
  );
  assert.equal(failure.stderr.trim().split(/\r?\n/).length, 1);
});
