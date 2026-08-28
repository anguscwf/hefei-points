const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-candidate-'));
const profile = require('../config/deployment-profile');
const { hashPwd } = require('../lib/password');
const preflight = require('../../scripts/preflight-synthetic-api');
const rootTools = require('../../scripts/support/synthetic-data-root-tools');
const bootstrap = require('../../scripts/support/synthetic-bootstrap');
const candidate = require('../../scripts/support/synthetic-candidate-evidence');

const captureNow = new Date('2026-08-28T01:00:00.000Z');
const finalizeNow = new Date('2026-08-28T01:05:00.000Z');
const expectedGateSpecs = Object.freeze([
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
const expectedGateIds = Object.freeze(expectedGateSpecs.map(([gateId]) => gateId));

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
    ...Array.from({ length: 31 }, (_, index) => ({
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

function fixture(
  label,
  selectedProvenance = provenanceFor(label),
  environmentOverrides = {}
) {
  const environment = environmentFor(label, environmentOverrides);
  const provenance = selectedProvenance;
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
    's14BootstrapEvidenceSha256', 'rootContextSha256',
    'databaseSnapshotSha256', 'configurationSha256', 'markerSha256',
    'datasetIdSha256', 'deploymentFingerprintSha256',
    'schemaFingerprintSha256', 'requestFingerprintSha256',
    'approvalReferenceSha256', 'administratorIdSha256', 'legalEvidenceSha256'
  ]);
  assert.equal(subject.profile, 'synthetic-candidate-machine-subject');
  assert.equal(subject.result, 'offline-machine-evidence-validated');
  assert.equal(subject.implementationFileCount, 41);
  assert.equal(subject.migrationCount, 10);
  assert.equal(subject.checks.bootstrapSourceCommitBound, true);
  assert.equal(subject.checks.currentDatabasePristine, true);
  assert.equal(subject.checks.historicalSequenceVerified, false);
  assert.equal(subject.checks.trustedProxyAllowlistBound, true);
  assert.equal(subject.checks.runtimeSecretIdentityBound, true);
  assert.equal(subject.checks.runtimeSecretIndependenceVerified, false);
  assert.equal(subject.checks.localClockExternallyTrusted, false);
  assert.equal(subject.operations.readOnlyGitSubprocessStarted, true);
  assert.equal(subject.operations.databaseOpenedReadOnly, true);
  assert.equal(subject.operations.syntheticDatabaseWritten, false);
  assert.equal(subject.operations.inMemoryReferenceDatabaseCreated, true);
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
  assert.equal(result.attestationCount, expectedGateIds.length);
  assert.deepEqual(candidate.GATE_SPECS, expectedGateSpecs);
  assert.deepEqual(result.requiredGateIds, expectedGateIds);
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

test('同数量代理替换或 AppSecret 轮换都会破坏候选配置绑定', () => {
  const provenance = provenanceFor('sensitive-binding');
  const proxy = fixture('sensitive-binding', provenance, {
    PAIRING_CLIENT_IP_MODE: 'trusted_proxy',
    TRUSTED_PROXIES: '192.0.2.10/32'
  });
  proxy.environment.TRUSTED_PROXIES = '198.51.100.20/32';
  assertCode(
    () => capture(proxy),
    'SYNTHETIC_CANDIDATE_BINDING_MISMATCH'
  );

  const secret = fixture('secret-binding');
  secret.environment.WX_APPSECRET = `synthetic-secret-rotated-${digest('rotated').slice(0, 16)}`;
  assertCode(
    () => capture(secret),
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
    ['password-rotation', value => {
      const db = new DatabaseSync(value.environment.SQLITE_FILE);
      try {
        db.prepare(`UPDATE users SET password = ? WHERE role = 'admin'`)
          .run(hashPwd('S15!Rotated-Synthetic-Password-Aa9'));
      } finally { db.close(); }
    }],
    ['secret-sidecar', value => {
      fs.writeFileSync(path.join(value.environment.DATA_DIR, '.secret'), digest('runtime secret'));
    }],
    ['old-receipt-schema', value => {
      const db = new DatabaseSync(value.environment.SQLITE_FILE);
      try {
        db.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TRIGGER trg_synthetic_bootstrap_receipt_once;
          DROP TRIGGER trg_synthetic_bootstrap_receipt_seed_guard;
          DROP TRIGGER trg_synthetic_bootstrap_receipt_no_update;
          DROP TRIGGER trg_synthetic_bootstrap_receipt_no_delete;
          ALTER TABLE synthetic_bootstrap_receipts RENAME TO obsolete_s14_receipt;
          CREATE TABLE synthetic_bootstrap_receipts (
            singleton_id INTEGER PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            status TEXT NOT NULL
          );
          INSERT INTO synthetic_bootstrap_receipts VALUES (1, 1, 'completed');
          DROP TABLE obsolete_s14_receipt;
        `);
      } finally { db.close(); }
    }]
  ];
  for (const [label, mutate] of cases) {
    const value = fixture(label);
    mutate(value);
    assertCode(() => capture(value), 'SYNTHETIC_CANDIDATE_STATE_ADVANCED');
  }
});

test('声明缺失、乱序、重复引用、跨 subject、过期或伪称已验签均拒绝', () => {
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
  const duplicateEvidenceReference = structuredClone(base);
  duplicateEvidenceReference.externalAttestations[1].evidenceReferenceSha256 =
    duplicateEvidenceReference.externalAttestations[0].evidenceReferenceSha256;
  assertCode(
    () => candidate.finalizeAttestations(
      value.environment,
      duplicateEvidenceReference,
      options
    ),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const wrongSubject = structuredClone(base);
  wrongSubject.externalAttestations[0].subjectSha256 = digest('another subject');
  assertCode(
    () => candidate.finalizeAttestations(value.environment, wrongSubject, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const beforeCapture = structuredClone(base);
  beforeCapture.externalAttestations[0].observedAt = '2026-08-28T00:59:59.999Z';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, beforeCapture, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const beyondClockSkew = structuredClone(base);
  beyondClockSkew.externalAttestations[0].observedAt = '2026-08-28T01:10:00.001Z';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, beyondClockSkew, options),
    'SYNTHETIC_CANDIDATE_ATTESTATION_INVALID'
  );
  const excessiveTtl = structuredClone(base);
  excessiveTtl.externalAttestations[0].expiresAt = '2026-08-29T01:01:00.001Z';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, excessiveTtl, options),
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
  const afterSubjectExpiry = structuredClone(base);
  afterSubjectExpiry.externalAttestations[0].observedAt =
    '2026-08-28T01:30:01.000Z';
  afterSubjectExpiry.externalAttestations[0].expiresAt =
    '2026-08-28T01:40:00.000Z';
  assertCode(
    () => candidate.finalizeAttestations(value.environment, afterSubjectExpiry, {
      ...options,
      now: new Date('2026-08-28T01:29:00.000Z')
    }),
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

test('SQLite 同 inode 原地写入与跨物理根复制都不能复用 machine subject', () => {
  const raced = fixture('database-race');
  assertCode(
    () => candidate.captureMachineSubject(raced.environment, raced.captureInput, {
      projectRoot,
      provenanceProvider: raced.provenanceProvider,
      now: captureNow,
      onPhase(phase) {
        if (phase !== 'afterDatabaseReadOnlyValidation') return;
        const db = new DatabaseSync(raced.environment.SQLITE_FILE);
        try {
          db.prepare(`UPDATE users SET tokens_valid_after = 1 WHERE role = 'admin'`).run();
        } finally { db.close(); }
      }
    }),
    'SYNTHETIC_CANDIDATE_SOURCE_CHANGED'
  );

  const original = fixture('physical-root');
  const subject = capture(original);
  const copiedParent = path.join(tempRoot, 'approved-physical-copy');
  const copiedRoot = path.join(copiedParent, 'tangguan-synthetic-physical-copy');
  fs.mkdirSync(copiedParent);
  fs.cpSync(original.environment.SYNTHETIC_DATA_ROOT, copiedRoot, { recursive: true });
  const copiedEnvironment = {
    ...original.environment,
    SYNTHETIC_DATA_ROOT_APPROVED_PARENT: copiedParent,
    SYNTHETIC_DATA_ROOT: copiedRoot,
    DATA_DIR: path.join(copiedRoot, 'data'),
    SQLITE_FILE: path.join(copiedRoot, 'data', 'hefei-points-synthetic.sqlite')
  };
  assertCode(
    () => candidate.finalizeAttestations(copiedEnvironment, {
      schemaVersion: 1,
      purpose: 'synthetic_candidate_attestation_finalize',
      captureInput: original.captureInput,
      machineSubject: subject,
      externalAttestations: attestationsFor(subject)
    }, {
      projectRoot,
      provenanceProvider: original.provenanceProvider,
      now: finalizeNow
    }),
    'SYNTHETIC_CANDIDATE_SOURCE_CHANGED'
  );
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
  const sensitivePath = { ...input, extra: environment.SYNTHETIC_DATA_ROOT };
  assertCode(
    () => candidate.decodeCanonicalInput(
      Buffer.from(JSON.stringify(sensitivePath)),
      environment
    ),
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

test('真实 CLI 失败保持空 stdout、单行稳定码且 help 明示不授权', async () => {
  const environment = environmentFor('cli-errors');
  const script = path.join(projectRoot, 'scripts', 'capture-synthetic-candidate-evidence.js');
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  for (const [args, input, code] of [
    [['--unknown'], '', 'SYNTHETIC_CANDIDATE_ARGUMENT_INVALID'],
    [[], '', 'SYNTHETIC_CANDIDATE_STDIN_REQUIRED'],
    [[], '{"schemaVersion":1}\r\n', 'SYNTHETIC_CANDIDATE_INPUT_INVALID'],
    [[], 'x'.repeat(candidate.MAX_STDIN_BYTES + 1),
      'SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE']
  ]) {
    const result = run(args, input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `Synthetic candidate evidence failed (${code}).\n`
    );
    assert.equal(result.stderr.includes(environment.SYNTHETIC_DATA_ROOT), false);
  }
  const help = run(['--help'], '');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /does not persist evidence, access the network, deploy/);
  assert.match(help.stdout, /does not .*grant use/i);
  await assert.rejects(
    candidate.readStdin({ isTTY: true }),
    error => error.code === 'SYNTHETIC_CANDIDATE_STDIN_REQUIRED'
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

test('真实两阶段 CLI 使用已提交 provenance 且只输出单行脱敏 JSON', () => {
  const fakeDirectory = path.join(tempRoot, 'real-cli-fake-git');
  const fakeGit = path.join(fakeDirectory, process.platform === 'win32' ? 'git.exe' : 'git');
  fs.mkdirSync(fakeDirectory);
  fs.writeFileSync(fakeGit, 'synthetic non-executable sentinel', { flag: 'wx' });
  const originalPath = process.env.PATH;
  let committed;
  try {
    process.env.PATH = `${fakeDirectory}${path.delimiter}${originalPath}`;
    committed = preflight.committedProvenance();
  } finally {
    process.env.PATH = originalPath;
  }
  const value = fixture('real-cli', committed);
  const childEnvironment = {
    ...process.env,
    ...value.environment,
    PATH: `${fakeDirectory}${path.delimiter}${process.env.PATH}`
  };
  const captureResult = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'capture-synthetic-candidate-evidence.js')
  ], {
    cwd: projectRoot,
    env: childEnvironment,
    input: `${JSON.stringify(value.captureInput)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000
  });
  assert.equal(captureResult.status, 0, captureResult.stderr);
  assert.equal(captureResult.stderr, '');
  assert.match(captureResult.stdout, /^\{[^\r\n]+\}\r?\n$/);
  const subject = JSON.parse(captureResult.stdout);
  assert.equal(subject.sourceCommit, committed.sourceCommit);
  assert.equal(subject.deploymentAuthorization, 'not_granted');

  const finalizeInput = {
    schemaVersion: 1,
    purpose: 'synthetic_candidate_attestation_finalize',
    captureInput: value.captureInput,
    machineSubject: subject,
    externalAttestations: candidate.GATE_SPECS.map(([
      gateId, declarantRole, sourceType
    ]) => ({
      gateId,
      subjectSha256: subject.subjectSha256,
      evidenceReferenceSha256: digest(`real cli opaque evidence ${gateId}`),
      declarantRole,
      sourceType,
      observedAt: new Date(Date.parse(subject.capturedAt) + 1000).toISOString(),
      expiresAt: new Date(Date.parse(subject.capturedAt) + (20 * 60 * 1000)).toISOString(),
      state: 'declared_satisfied_not_authenticated',
      signatureStatus: 'not_verified'
    }))
  };
  const finalizeResult = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'finalize-synthetic-candidate-evidence.js')
  ], {
    cwd: projectRoot,
    env: childEnvironment,
    input: `${JSON.stringify(finalizeInput)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000
  });
  assert.equal(finalizeResult.status, 0, finalizeResult.stderr);
  assert.equal(finalizeResult.stderr, '');
  assert.match(finalizeResult.stdout, /^\{[^\r\n]+\}\r?\n$/);
  const finalized = JSON.parse(finalizeResult.stdout);
  assert.equal(finalized.result, 'attestation-envelopes-present');
  assert.equal(finalized.externalFactsVerifiedByThisCommand, false);
  assert.equal(finalized.deploymentAuthorization, 'not_granted');
  assert.equal(fs.readFileSync(fakeGit, 'utf8'), 'synthetic non-executable sentinel');
  const combined = captureResult.stdout + finalizeResult.stdout;
  for (const forbidden of [
    value.environment.API_PUBLIC_ORIGIN,
    value.environment.WX_APPID,
    value.environment.WX_APPSECRET,
    value.environment.SYNTHETIC_DATASET_ID,
    value.environment.SYNTHETIC_DATA_ROOT,
    value.environment.SQLITE_FILE
  ]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
    assert.equal(
      combined.includes(JSON.stringify(forbidden).slice(1, -1)),
      false,
      forbidden
    );
  }
  assert.equal(subject.implementationFileCount, 41);
});
