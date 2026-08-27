const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-candidate-'));
const profile = require('../config/deployment-profile');
const preflight = require('../../scripts/preflight-synthetic-api');
const rootTools = require('../../scripts/support/synthetic-data-root-tools');
const bootstrap = require('../../scripts/support/synthetic-bootstrap');
const candidate = require('../../scripts/support/synthetic-candidate-evidence');

const captureNow = new Date('2026-08-28T01:00:00.000Z');
const finalizeNow = new Date('2026-08-28T01:05:00.000Z');

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function environmentFor(label, overrides = {}) {
  const parent = path.join(tempRoot, `approved-${label}`);
  const root = path.join(parent, `tangguan-synthetic-${label}`);
  const origin = `https://synthetic-${label}.example.com`;
  fs.mkdirSync(parent, { recursive: false });
  const relationSha256 = digest(`synthetic relation ${label}`);
  return {
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
    SYNTHETIC_CANDIDATE_EVIDENCE_ACK: candidate.ACK,
    ...overrides
  };
}

function provenanceFor(label) {
  const implementationFiles = [
    ...Array.from({ length: 24 }, (_, index) => ({
      path: `scripts/synthetic-fixture-${String(index).padStart(2, '0')}.js`,
      sha256: digest(`${label} implementation ${index}`)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      path: `server/db/migrations/${String(index + 1).padStart(3, '0')}_fixture.sql`,
      sha256: digest(`${label} migration ${index}`)
    }))
  ];
  return Object.freeze({
    sourceCommit: digest(`${label} source commit`),
    implementationIndexMatchesHead: true,
    implementationWorktreeMatchesHeadAfterEolNormalization: true,
    implementationTreeSha256: digest(`${label} implementation tree`),
    implementationFiles: Object.freeze(
      implementationFiles.map(value => Object.freeze(value))
    )
  });
}

function legalTexts(label) {
  return [
    'privacy_policy',
    'child_personal_information_rules',
    'child_user_agreement',
    'sensitive_information_notice'
  ].map((type, index) => ({
    type,
    version: `synthetic-${label}-${index + 1}`,
    contentSha256: digest(`${label} legal ${type}`)
  }));
}

function fixture(label) {
  const environment = environmentFor(label);
  const provenance = provenanceFor(label);
  environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK = rootTools.PREPARE_ACK;
  rootTools.prepareSyntheticDataRoot(environment, { projectRoot });
  delete environment.SYNTHETIC_DATA_ROOT_PREPARE_ACK;
  const s13PreBootstrap = rootTools.verifySyntheticDataRoot(environment, { projectRoot });
  const s12Preflight = preflight.evidenceFor(environment, provenance);
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
      password: `S15!${label}-Synthetic-Candidate-Aa9`,
      credentialPurpose: bootstrap.CREDENTIAL_PURPOSE
    },
    legalEvidence: {
      effectiveAt: '2026-08-28T00:00:00.000Z',
      texts: legalTexts(label)
    }
  }, { projectRoot, now: new Date('2026-08-28T00:30:00.000Z') });
  delete environment.SYNTHETIC_BOOTSTRAP_ACK;
  const captureInput = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_machine_capture',
    candidateId: `synthetic-candidate-${digest(`candidate id ${label}`).slice(0, 32)}`,
    s12Preflight,
    s13PreBootstrap,
    s14Bootstrap
  };
  const provenanceProvider = () => provenance;
  return { environment, provenance, provenanceProvider, captureInput };
}

function attestationsFor(subject) {
  return candidate.GATE_SPECS.map(([gateId, declarantRole, sourceType]) => ({
    gateId,
    subjectSha256: subject.subjectSha256,
    evidenceReferenceSha256: digest(`random opaque evidence ${gateId}`),
    declarantRole,
    sourceType,
    observedAt: '2026-08-28T01:01:00.000Z',
    expiresAt: '2026-08-29T00:01:00.000Z',
    state: 'declared_satisfied_not_authenticated',
    signatureStatus: 'not_verified'
  }));
}

function capture(value, overrides = {}) {
  return candidate.captureMachineSubject(value.environment, value.captureInput, {
    projectRoot,
    provenanceProvider: value.provenanceProvider,
    now: captureNow,
    ...overrides
  });
}

function assertCode(work, code) {
  assert.throws(work, error => error instanceof candidate.SyntheticCandidateError
    && error.code === code);
}

test('候选机器 subject 精确绑定 S12/S13/S14 与实时只读最小数据库', () => {
  const value = fixture('success');
  const subject = capture(value);
  assert.deepEqual(Object.keys(subject), [
    'schemaVersion', 'profile', 'result', 'capturedAt', 'validUntil',
    'candidateIdSha256', 'sourceCommit', 'implementationTreeSha256',
    'implementationFileCount', 'migrationCount', 'candidateBindingSha256',
    'machineStateSha256', 'bindings', 'checks', 'operations',
    'externalFactsVerifiedByThisCommand', 'deploymentAuthorization',
    'productionChildGateState', 'childUseAuthorization', 'subjectSha256'
  ]);
  assert.deepEqual(Object.keys(subject.bindings), [
    's12EvidenceSha256', 's13PreBootstrapEvidenceSha256',
    's14BootstrapEvidenceSha256', 'configurationSha256', 'markerSha256',
    'datasetIdSha256', 'deploymentFingerprintSha256',
    'schemaFingerprintSha256', 'requestFingerprintSha256',
    'approvalReferenceSha256', 'administratorIdSha256', 'legalEvidenceSha256'
  ]);
  assert.equal(subject.profile, 'synthetic-candidate-machine-subject');
  assert.equal(subject.result, 'offline-machine-evidence-validated');
  assert.equal(subject.implementationFileCount, 34);
  assert.equal(subject.migrationCount, 10);
  assert.equal(subject.checks.bootstrapSourceCommitBound, true);
  assert.equal(subject.checks.currentDatabasePristine, true);
  assert.equal(subject.checks.historicalSequenceVerified, false);
  assert.equal(subject.checks.runtimeSecretIdentityVerified, false);
  assert.equal(subject.checks.localClockExternallyTrusted, false);
  assert.equal(subject.operations.readOnlyGitSubprocessStarted, true);
  assert.equal(subject.operations.databaseOpenedReadOnly, true);
  assert.equal(subject.operations.databaseWritten, false);
  assert.equal(subject.externalFactsVerifiedByThisCommand, false);
  assert.equal(subject.deploymentAuthorization, 'not_granted');
  assert.equal(subject.productionChildGateState, 'not_observed');
  assert.equal(subject.childUseAuthorization, 'not_granted');
  const { subjectSha256, ...core } = subject;
  assert.equal(subjectSha256, candidate.canonicalHash(core));
  assert.deepEqual(fs.readdirSync(value.environment.DATA_DIR), [
    'hefei-points-synthetic.sqlite'
  ]);

  const raw = JSON.stringify(subject);
  for (const forbidden of [
    value.environment.API_PUBLIC_ORIGIN,
    value.environment.WX_APPID,
    value.environment.WX_APPSECRET,
    value.environment.SYNTHETIC_DATASET_ID,
    value.environment.SYNTHETIC_DATA_ROOT,
    value.environment.DATA_DIR,
    value.environment.SQLITE_FILE,
    value.environment.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL,
    value.captureInput.candidateId
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
});

test('齐全外部声明只形成未认证信封，不授予部署或儿童使用', () => {
  const value = fixture('finalize');
  const subject = capture(value);
  const result = candidate.finalizeAttestations(value.environment, {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput: value.captureInput,
    machineSubject: subject,
    externalAttestations: attestationsFor(subject)
  }, {
    projectRoot,
    provenanceProvider: value.provenanceProvider,
    now: finalizeNow
  });
  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'profile', 'result', 'finalizedAt', 'validUntil',
    'subjectSha256', 'candidateBindingSha256', 'machineStateSha256',
    'attestationSetSha256', 'attestationCount', 'requiredGateIds', 'checks',
    'operations', 'externalFactsVerifiedByThisCommand',
    'deploymentAuthorization', 'productionChildGateState',
    'childUseAuthorization'
  ]);
  assert.equal(result.result, 'attestation-envelopes-present');
  assert.equal(result.attestationCount, candidate.REQUIRED_GATE_IDS.length);
  assert.deepEqual(result.requiredGateIds, candidate.REQUIRED_GATE_IDS);
  assert.equal(result.checks.machineStateRevalidated, true);
  assert.equal(result.checks.attestationAuthenticityVerified, false);
  assert.equal(result.checks.externalFactsVerified, false);
  assert.equal(result.externalFactsVerifiedByThisCommand, false);
  assert.equal(result.deploymentAuthorization, 'not_granted');
  assert.equal(result.childUseAuthorization, 'not_granted');
  assert.equal(result.validUntil, subject.validUntil);
});

test('三阶段证据、来源提交和当前配置不能跨候选混搭', () => {
  const left = fixture('mix-left');
  const right = fixture('mix-right');
  for (const key of ['s12Preflight', 's13PreBootstrap', 's14Bootstrap']) {
    const changed = structuredClone(left.captureInput);
    changed[key] = right.captureInput[key];
    assertCode(
      () => candidate.captureMachineSubject(left.environment, changed, {
        projectRoot,
        provenanceProvider: left.provenanceProvider,
        now: captureNow
      }),
      'SYNTHETIC_CANDIDATE_BINDING_MISMATCH'
    );
  }
  assertCode(
    () => candidate.captureMachineSubject(left.environment, left.captureInput, {
      projectRoot,
      provenanceProvider: right.provenanceProvider,
      now: captureNow
    }),
    'SYNTHETIC_CANDIDATE_BINDING_MISMATCH'
  );
});

test('数据库出现业务行、凭据演进或运行 sidecar 后候选状态 fail closed', () => {
  const cases = [
    ['business-row', value => {
      const db = new DatabaseSync(value.environment.SQLITE_FILE);
      try {
        db.prepare(`
          INSERT INTO rules (family_id, revision, data_json, updated_at)
          VALUES ('default', 1, '{}', ?)
        `).run('2026-08-28T01:00:00.000Z');
      } finally { db.close(); }
    }],
    ['credential-state', value => {
      const db = new DatabaseSync(value.environment.SQLITE_FILE);
      try {
        db.prepare(`UPDATE users SET tokens_valid_after = 1 WHERE role = 'admin'`).run();
      } finally { db.close(); }
    }],
    ['secret-sidecar', value => {
      fs.writeFileSync(path.join(value.environment.DATA_DIR, '.secret'), digest('runtime secret'));
    }]
  ];
  for (const [label, mutate] of cases) {
    const value = fixture(label);
    mutate(value);
    assertCode(() => capture(value), 'SYNTHETIC_CANDIDATE_STATE_ADVANCED');
  }
});

test('声明缺失、乱序、跨 subject、过期或伪称已验签均拒绝', () => {
  const value = fixture('attestation-reject');
  const subject = capture(value);
  const base = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput: value.captureInput,
    machineSubject: subject,
    externalAttestations: attestationsFor(subject)
  };
  const options = {
    projectRoot,
    provenanceProvider: value.provenanceProvider,
    now: finalizeNow
  };
  const missing = structuredClone(base);
  missing.externalAttestations.pop();
  assertCode(
    () => candidate.finalizeAttestations(value.environment, missing, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INCOMPLETE'
  );
  const reordered = structuredClone(base);
  [reordered.externalAttestations[0], reordered.externalAttestations[1]] = [
    reordered.externalAttestations[1], reordered.externalAttestations[0]
  ];
  assertCode(
    () => candidate.finalizeAttestations(value.environment, reordered, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const wrongSubject = structuredClone(base);
  wrongSubject.externalAttestations[0].subjectSha256 = digest('another subject');
  assertCode(
    () => candidate.finalizeAttestations(value.environment, wrongSubject, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const expired = structuredClone(base);
  expired.externalAttestations[0].expiresAt = '2026-08-28T01:04:00.000Z';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, expired, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED'
  );
  const forged = structuredClone(base);
  forged.externalAttestations[0].signatureStatus = 'verified';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, forged, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
});

test('Phase B 重新核验机器状态且拒绝过期或被改写的 subject', () => {
  const value = fixture('subject-reject');
  const subject = capture(value);
  const document = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput: value.captureInput,
    machineSubject: subject,
    externalAttestations: attestationsFor(subject)
  };
  const tampered = structuredClone(document);
  tampered.machineSubject.checks.historicalSequenceVerified = true;
  assertCode(
    () => candidate.finalizeAttestations(value.environment, tampered, {
      projectRoot,
      provenanceProvider: value.provenanceProvider,
      now: finalizeNow
    }),
    'SYNTHETIC_CANDIDATE_SOURCE_INVALID'
  );
  assertCode(
    () => candidate.finalizeAttestations(value.environment, document, {
      projectRoot,
      provenanceProvider: value.provenanceProvider,
      now: new Date('2026-08-28T01:31:00.000Z')
    }),
    'SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED'
  );

  const advanced = fixture('phase-b-advanced');
  const advancedSubject = capture(advanced);
  const db = new DatabaseSync(advanced.environment.SQLITE_FILE);
  try {
    db.prepare(`UPDATE users SET tokens_valid_after = 1 WHERE role = 'admin'`).run();
  } finally { db.close(); }
  assertCode(
    () => candidate.finalizeAttestations(advanced.environment, {
      schemaVersion: 1,
      purpose: 'synthetic_candidate_attestation_finalize',
      captureInput: advanced.captureInput,
      machineSubject: advancedSubject,
      externalAttestations: attestationsFor(advancedSubject)
    }, {
      projectRoot,
      provenanceProvider: advanced.provenanceProvider,
      now: finalizeNow
    }),
    'SYNTHETIC_CANDIDATE_STATE_ADVANCED'
  );
});

test('两轮来源漂移失败，重复只读采集不产生 sidecar', () => {
  const value = fixture('source-drift');
  let calls = 0;
  const driftingProvider = () => ({
    ...value.provenance,
    sourceCommit: (calls += 1) === 1
      ? value.provenance.sourceCommit
      : digest('changed source commit')
  });
  assertCode(
    () => candidate.captureMachineSubject(value.environment, value.captureInput, {
      projectRoot,
      provenanceProvider: driftingProvider,
      now: captureNow
    }),
    'SYNTHETIC_CANDIDATE_SOURCE_CHANGED'
  );
  for (let index = 0; index < 8; index += 1) {
    assert.equal(capture(value).machineStateSha256, capture(value).machineStateSha256);
  }
  assert.deepEqual(fs.readdirSync(value.environment.DATA_DIR), [
    'hefei-points-synthetic.sqlite'
  ]);
});

test('canonical stdin、ACK 与敏感明文边界返回稳定错误', () => {
  const environment = environmentFor('canonical');
  const input = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_machine_capture',
    candidateId: `synthetic-candidate-${digest('canonical candidate id').slice(0, 32)}`,
    s12Preflight: {},
    s13PreBootstrap: {},
    s14Bootstrap: {}
  };
  const raw = JSON.stringify(input);
  assert.deepEqual(candidate.decodeCanonicalInput(Buffer.from(`${raw}\n`), environment), input);
  for (const invalid of [
    '', `${raw}\r\n`, ` ${raw}`, `${raw} `, JSON.stringify(input, null, 2),
    `${raw}\n${raw}`
  ]) {
    assertCode(
      () => candidate.decodeCanonicalInput(Buffer.from(invalid), environment),
      invalid === ''
        ? 'SYNTHETIC_CANDIDATE_STDIN_REQUIRED'
        : 'SYNTHETIC_CANDIDATE_INPUT_INVALID'
    );
  }
  const sensitive = structuredClone(input);
  sensitive.candidateId = environment.WX_APPSECRET;
  assertCode(
    () => candidate.decodeCanonicalInput(Buffer.from(JSON.stringify(sensitive)), environment),
    'SYNTHETIC_CANDIDATE_SENSITIVE_INPUT'
  );
  const withoutAck = { ...environment };
  delete withoutAck.SYNTHETIC_CANDIDATE_EVIDENCE_ACK;
  assertCode(
    () => candidate.captureMachineSubject(withoutAck, input, { now: captureNow }),
    'SYNTHETIC_CANDIDATE_ACK_REQUIRED'
  );
  assertCode(
    () => candidate.decodeCanonicalInput(Buffer.alloc(candidate.MAX_STDIN_BYTES + 1), environment),
    'SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE'
  );
});

test('生产 profile 不能进入候选证据命令', () => {
  const value = fixture('production-reject');
  const environment = {
    ...value.environment,
    DEPLOYMENT_TIER: 'production'
  };
  assertCode(
    () => candidate.captureMachineSubject(environment, value.captureInput, {
      projectRoot,
      provenanceProvider: value.provenanceProvider,
      now: captureNow
    }),
    'SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED'
  );
});
