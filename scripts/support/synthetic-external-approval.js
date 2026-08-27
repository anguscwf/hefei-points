const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const candidate = require('./synthetic-candidate-evidence');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_STDIN_BYTES = 512 * 1024;
const MAX_POLICY_BYTES = 128 * 1024;
const ACK_ENV = 'SYNTHETIC_EXTERNAL_APPROVAL_ACK';
const ACK = 'verify-signatures-only-not-deployment-v1';
const POLICY_FILE_ENV = 'SYNTHETIC_APPROVAL_TRUST_POLICY_FILE';
const POLICY_PARENT_ENV = 'SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT';
const POLICY_SHA256_ENV = 'SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256';
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const POLICY_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const GRANT_TTL_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SYNTHETIC_ID = /^synthetic-[a-z0-9][a-z0-9_-]{15,94}$/;
const POLICY_ROLES = Object.freeze([
  'external_gate_verifier',
  'deployment_approver',
  'deployment_grant_issuer',
  'revocation_authority'
]);
const GATE_DOMAIN = 'tangguan.synthetic.external-gate-verification.v1';
const APPROVAL_DOMAIN = 'tangguan.synthetic.external-deployment-approval.v1';
const GRANT_DOMAIN = 'tangguan.synthetic.external-deployment-grant.v1';
const REVOCATION_DOMAIN = 'tangguan.synthetic.external-revocation-checkpoint.v1';

const STABLE_ERROR_CODES = new Set([
  'SYNTHETIC_EXTERNAL_APPROVAL_ARGUMENT_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_ACK_REQUIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_STDIN_REQUIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_INPUT_TOO_LARGE',
  'SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_SENSITIVE_INPUT',
  'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_CHANGED',
  'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE',
  'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE',
  'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_CHANGED',
  'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_KEY_REVOKED',
  'SYNTHETIC_EXTERNAL_APPROVAL_IDENTITY_REVOKED',
  'SYNTHETIC_EXTERNAL_APPROVAL_GATE_INCOMPLETE',
  'SYNTHETIC_EXTERNAL_APPROVAL_GATE_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_GATE_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_SIGNATURE_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_REVOKED',
  'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_INVALID',
  'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_EXPIRED',
  'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED',
  'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_TARGET_MISMATCH',
  'SYNTHETIC_EXTERNAL_APPROVAL_PRODUCTION_RESOURCE_REJECTED',
  'SYNTHETIC_EXTERNAL_APPROVAL_VERIFICATION_FAILED'
]);

class SyntheticExternalApprovalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyntheticExternalApprovalError';
    this.code = code;
  }
}

function fail(code) {
  throw new SyntheticExternalApprovalError(code);
}

function safeErrorCode(error) {
  return error && STABLE_ERROR_CODES.has(error.code)
    ? error.code
    : 'SYNTHETIC_EXTERNAL_APPROVAL_VERIFICATION_FAILED';
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

function exactKeys(value, expected, code) {
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

function parseCanonicalTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code);
  return epoch;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail('SYNTHETIC_EXTERNAL_APPROVAL_ARGUMENT_INVALID');
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  fail('SYNTHETIC_EXTERNAL_APPROVAL_ARGUMENT_INVALID');
}

function assertAck(environment) {
  if (!environment || typeof environment !== 'object') {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_PRODUCTION_RESOURCE_REJECTED');
  }
  if (environment[ACK_ENV] !== ACK) fail('SYNTHETIC_EXTERNAL_APPROVAL_ACK_REQUIRED');
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
    environment.GUARDIAN_RELATION_DECLARATION_VERSION,
    environment[POLICY_FILE_ENV],
    environment[POLICY_PARENT_ENV]
  ].filter(value => typeof value === 'string' && value.length >= 6);
}

function decodeCanonicalInput(buffer, environment = process.env) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_STDIN_REQUIRED');
  }
  if (buffer.length > MAX_STDIN_BYTES) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_TOO_LARGE');
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  }
  if (raw.endsWith('\n') && !raw.endsWith('\r\n')) raw = raw.slice(0, -1);
  if (!raw) fail('SYNTHETIC_EXTERNAL_APPROVAL_STDIN_REQUIRED');
  const sensitive = sensitiveValues(environment)
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  if ([...new Set(sensitive)].some(value => raw.includes(value))) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_SENSITIVE_INPUT');
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (_) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  }
  if (JSON.stringify(document) !== raw) fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  return document;
}

async function readStdin(stream) {
  if (!stream || stream.isTTY) fail('SYNTHETIC_EXTERNAL_APPROVAL_STDIN_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += input.length;
    if (size > MAX_STDIN_BYTES) {
      for (const prior of chunks) prior.fill(0);
      input.fill(0);
      fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(input));
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWindowsNetworkOrDevicePath(value) {
  return typeof value === 'string' && value.replaceAll('/', '\\').startsWith('\\\\');
}

function sameFilesystemPath(left, right) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function isCanonicalAbsolutePath(value) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && path.resolve(value) === value;
}

function assertUnlinkedPathSegments(filename, finalKind) {
  const root = path.parse(filename).root;
  const relative = path.relative(root, filename);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let metadata;
    try {
      metadata = fs.lstatSync(current, { bigint: true });
    } catch (_) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE');
    }
    const last = index === segments.length - 1;
    if (metadata.isSymbolicLink()
        || (!last && !metadata.isDirectory())
        || (last && finalKind === 'directory' && !metadata.isDirectory())
        || (last && finalKind === 'file' && !metadata.isFile())) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE');
    }
  }
}

function fileSnapshot(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mode: String(metadata.mode),
    nlink: String(metadata.nlink),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs)
  });
}

function readTrustPolicyFile(environment) {
  const filename = environment && environment[POLICY_FILE_ENV];
  const approvedParent = environment && environment[POLICY_PARENT_ENV];
  const expectedSha256 = environment && environment[POLICY_SHA256_ENV];
  if (typeof filename !== 'string' || typeof approvedParent !== 'string'
      || !validDigest(expectedSha256)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE');
  }
  if (!isCanonicalAbsolutePath(filename)
      || !isCanonicalAbsolutePath(approvedParent)
      || isWindowsNetworkOrDevicePath(filename)
      || isWindowsNetworkOrDevicePath(approvedParent)
      || !sameFilesystemPath(
        path.parse(filename).root,
        path.parse(PROJECT_ROOT).root
      )
      || !sameFilesystemPath(
        path.parse(approvedParent).root,
        path.parse(PROJECT_ROOT).root
      )
      || path.dirname(filename) !== approvedParent) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE');
  }
  assertUnlinkedPathSegments(approvedParent, 'directory');
  assertUnlinkedPathSegments(filename, 'file');
  let parentReal;
  let fileReal;
  let parentMetadata;
  let pathMetadata;
  try {
    parentMetadata = fs.lstatSync(approvedParent, { bigint: true });
    pathMetadata = fs.lstatSync(filename, { bigint: true });
    parentReal = fs.realpathSync.native(approvedParent);
    fileReal = fs.realpathSync.native(filename);
  } catch (_) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE');
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || !pathMetadata.isFile() || pathMetadata.isSymbolicLink()
      || pathMetadata.nlink !== 1n || pathMetadata.size <= 0n
      || pathMetadata.size > BigInt(MAX_POLICY_BYTES)
      || path.dirname(fileReal) !== parentReal
      || !sameFilesystemPath(parentReal, approvedParent)
      || !sameFilesystemPath(fileReal, filename)
      || isWithin(fs.realpathSync.native(PROJECT_ROOT), fileReal)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE');
  }
  const dataRoot = environment.SYNTHETIC_DATA_ROOT;
  if (typeof dataRoot === 'string' && path.isAbsolute(dataRoot)) {
    if (isWindowsNetworkOrDevicePath(dataRoot)
        || !isCanonicalAbsolutePath(dataRoot)
        || !sameFilesystemPath(
          path.parse(dataRoot).root,
          path.parse(PROJECT_ROOT).root
        )
        || isWithin(dataRoot, filename)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE');
    }
  }
  if (process.platform !== 'win32' && (Number(pathMetadata.mode) & 0o022) !== 0) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_UNSAFE');
  }
  const before = fileSnapshot(pathMetadata);
  let descriptor;
  let raw;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filename, flags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
        || canonicalJson(fileSnapshot(opened)) !== canonicalJson(before)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_CHANGED');
    }
    raw = fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof SyntheticExternalApprovalError) throw error;
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_ROOT_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
  try {
    const after = fs.lstatSync(filename, { bigint: true });
    if (canonicalJson(fileSnapshot(after)) !== canonicalJson(before)
        || fs.realpathSync.native(filename) !== fileReal) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_CHANGED');
    }
    if (sha256(raw) !== expectedSha256) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch (_) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID');
    }
    let policy;
    try {
      policy = JSON.parse(text);
    } catch (_) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID');
    }
    if (JSON.stringify(policy) !== text) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID');
    }
    return Object.freeze({
      filename,
      approvedParent,
      fileReal,
      snapshot: before,
      policySha256: expectedSha256,
      policy
    });
  } finally {
    raw.fill(0);
  }
}

function decodeBase64Url(value, expectedLength, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(code);
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch (_) {
    fail(code);
  }
  if (decoded.length !== expectedLength || decoded.toString('base64url') !== value) fail(code);
  return decoded;
}

function sortedUniqueDigests(value, code) {
  if (!Array.isArray(value) || value.some(item => !validDigest(item))) fail(code);
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) fail(code);
  }
  return value;
}

function validateTrustPolicy(context, now) {
  const code = 'SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_INVALID';
  const { policy, policySha256 } = context;
  exactKeys(policy, [
    'schemaVersion', 'purpose', 'policyIdSha256', 'revision', 'issuedAt',
    'validFrom', 'validUntil', 'keys'
  ], code);
  const issuedAt = parseCanonicalTimestamp(policy.issuedAt, code);
  const validFrom = parseCanonicalTimestamp(policy.validFrom, code);
  const validUntil = parseCanonicalTimestamp(policy.validUntil, code);
  if (policy.schemaVersion !== 1
      || policy.purpose !== 'synthetic_external_approval_trust_policy'
      || !validDigest(policy.policyIdSha256)
      || !Number.isSafeInteger(policy.revision) || policy.revision < 1
      || issuedAt > validFrom || issuedAt > now + CLOCK_SKEW_MS
      || validFrom > now || validUntil <= now
      || validUntil - validFrom > POLICY_TTL_MS) {
    if (validUntil <= now) fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_EXPIRED');
    fail(code);
  }
  if (!Array.isArray(policy.keys) || policy.keys.length < 4 || policy.keys.length > 64) {
    fail(code);
  }
  const keys = new Map();
  const publicKeys = new Set();
  const principalRoles = new Map();
  const coveredGates = new Set();
  let priorKeyId = '';
  for (const value of policy.keys) {
    exactKeys(value, [
      'keyId', 'principalIdSha256', 'role', 'allowedGateIds',
      'publicKeySpkiDerBase64url', 'notBefore', 'notAfter', 'status'
    ], code);
    if (!validDigest(value.keyId) || !validDigest(value.principalIdSha256)
        || !POLICY_ROLES.includes(value.role) || value.status !== 'active'
        || value.keyId <= priorKeyId) fail(code);
    priorKeyId = value.keyId;
    const notBefore = parseCanonicalTimestamp(value.notBefore, code);
    const notAfter = parseCanonicalTimestamp(value.notAfter, code);
    if (notBefore < validFrom || notAfter > validUntil || notBefore > now
        || notAfter <= now) fail(code);
    const der = decodeBase64Url(value.publicKeySpkiDerBase64url, 44, code);
    if (sha256(der) !== value.keyId || publicKeys.has(value.keyId)) fail(code);
    let publicKey;
    try {
      publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ed25519'
          || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
            !== value.publicKeySpkiDerBase64url) fail(code);
    } catch (error) {
      if (error instanceof SyntheticExternalApprovalError) throw error;
      fail(code);
    } finally {
      der.fill(0);
    }
    publicKeys.add(value.keyId);
    const priorRole = principalRoles.get(value.principalIdSha256);
    if (priorRole && priorRole !== value.role) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
    }
    principalRoles.set(value.principalIdSha256, value.role);
    if (!Array.isArray(value.allowedGateIds)) fail(code);
    const expectedOrder = candidate.REQUIRED_GATE_IDS
      .filter(gateId => value.allowedGateIds.includes(gateId));
    if (canonicalJson(expectedOrder) !== canonicalJson(value.allowedGateIds)) fail(code);
    if (value.role === 'external_gate_verifier') {
      if (value.allowedGateIds.length === 0) fail(code);
      for (const gateId of value.allowedGateIds) coveredGates.add(gateId);
    } else if (value.allowedGateIds.length !== 0) {
      fail(code);
    }
    keys.set(value.keyId, Object.freeze({ ...value, notBefore, notAfter, publicKey }));
  }
  if (candidate.REQUIRED_GATE_IDS.some(gateId => !coveredGates.has(gateId))
      || ![...keys.values()].some(value => value.role === 'deployment_approver')
      || ![...keys.values()].some(value => value.role === 'deployment_grant_issuer')
      || ![...keys.values()].some(value => value.role === 'revocation_authority')) {
    fail(code);
  }
  return Object.freeze({
    policy,
    policySha256,
    keys,
    validUntil
  });
}

function verifyEnvelope(envelope, policyState, role, domain, code, revocationState) {
  exactKeys(envelope, ['keyId', 'algorithm', 'payload', 'signatureBase64url'], code);
  if (envelope.algorithm !== 'Ed25519') fail(code);
  const key = policyState.keys.get(envelope.keyId);
  if (!key || key.role !== role) fail(code);
  if (revocationState && revocationState.revokedKeyIds.has(key.keyId)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_KEY_REVOKED');
  }
  if (revocationState && revocationState.revokedPrincipalIds.has(key.principalIdSha256)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_IDENTITY_REVOKED');
  }
  const signature = decodeBase64Url(envelope.signatureBase64url, 64, code);
  const message = Buffer.concat([
    Buffer.from(`${domain}\0`, 'utf8'),
    Buffer.from(canonicalJson(envelope.payload), 'utf8')
  ]);
  let valid = false;
  try {
    valid = crypto.verify(null, message, key.publicKey, signature);
  } catch (_) {
    valid = false;
  } finally {
    signature.fill(0);
    message.fill(0);
  }
  if (!valid) fail('SYNTHETIC_EXTERNAL_APPROVAL_SIGNATURE_INVALID');
  return key;
}

function validateRevocationCheckpoint(envelope, policyState, now) {
  const code = 'SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID';
  const key = verifyEnvelope(
    envelope,
    policyState,
    'revocation_authority',
    REVOCATION_DOMAIN,
    code
  );
  const payload = envelope.payload;
  exactKeys(payload, [
    'schemaVersion', 'purpose', 'policySha256', 'sequence', 'issuedAt',
    'validUntil', 'revokedKeyIds', 'revokedPrincipalIdsSha256',
    'revokedApprovalIdsSha256', 'revokedGrantIdsSha256'
  ], code);
  const issuedAt = parseCanonicalTimestamp(payload.issuedAt, code);
  const validUntil = parseCanonicalTimestamp(payload.validUntil, code);
  const policyIssuedAt = parseCanonicalTimestamp(policyState.policy.issuedAt, code);
  if (payload.schemaVersion !== 1
      || payload.purpose !== 'synthetic_external_revocation_checkpoint'
      || payload.policySha256 !== policyState.policySha256
      || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1
      || issuedAt < policyIssuedAt || issuedAt > now
      || validUntil <= issuedAt || validUntil <= now
      || validUntil > policyState.validUntil
      || validUntil - issuedAt > CHECKPOINT_TTL_MS
      || issuedAt < key.notBefore || issuedAt >= key.notAfter || now >= key.notAfter) {
    if (validUntil <= now) fail('SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_EXPIRED');
    fail(code);
  }
  const revokedKeyIds = new Set(sortedUniqueDigests(payload.revokedKeyIds, code));
  const revokedPrincipalIds = new Set(sortedUniqueDigests(
    payload.revokedPrincipalIdsSha256,
    code
  ));
  const revokedApprovalIds = new Set(sortedUniqueDigests(
    payload.revokedApprovalIdsSha256,
    code
  ));
  const revokedGrantIds = new Set(sortedUniqueDigests(
    payload.revokedGrantIdsSha256,
    code
  ));
  if (revokedKeyIds.has(key.keyId)
      || revokedPrincipalIds.has(key.principalIdSha256)) fail(code);
  return Object.freeze({
    checkpointSha256: canonicalHash(envelope),
    sequence: payload.sequence,
    issuedAt,
    validUntil,
    keyNotAfter: key.notAfter,
    authorityPrincipalIdSha256: key.principalIdSha256,
    revokedKeyIds,
    revokedPrincipalIds,
    revokedApprovalIds,
    revokedGrantIds
  });
}

function validateS15Evidence(document, environment, nowDate, options) {
  const provided = document.s15FinalizedEvidence;
  exactKeys(provided, [
    'schemaVersion', 'profile', 'result', 'finalizedAt', 'validUntil',
    'subjectSha256', 'candidateBindingSha256', 'machineStateSha256',
    'attestationSetSha256', 'attestationCount', 'requiredGateIds', 'checks',
    'operations', 'externalFactsVerifiedByThisCommand',
    'deploymentAuthorization', 'productionChildGateState',
    'childUseAuthorization'
  ], 'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID');
  const finalizedAt = parseCanonicalTimestamp(
    provided.finalizedAt,
    'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID'
  );
  const validUntil = parseCanonicalTimestamp(
    provided.validUntil,
    'SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID'
  );
  if (provided.schemaVersion !== 1
      || provided.profile !== 'synthetic-candidate-attestation-envelopes'
      || provided.result !== 'attestation-envelopes-present'
      || provided.attestationCount !== candidate.REQUIRED_GATE_IDS.length
      || canonicalJson(provided.requiredGateIds) !== canonicalJson(candidate.REQUIRED_GATE_IDS)
      || !validDigest(provided.subjectSha256)
      || !validDigest(provided.candidateBindingSha256)
      || !validDigest(provided.machineStateSha256)
      || !validDigest(provided.attestationSetSha256)
      || finalizedAt > nowDate.getTime() + CLOCK_SKEW_MS
      || provided.externalFactsVerifiedByThisCommand !== false
      || provided.deploymentAuthorization !== 'not_granted'
      || provided.productionChildGateState !== 'not_observed'
      || provided.childUseAuthorization !== 'not_granted') {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID');
  }
  if (validUntil <= nowDate.getTime()) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_EXPIRED');
  }
  const finalizer = options.candidateFinalizer || candidate.finalizeAttestations;
  function runFinalizer(at) {
    try {
      return finalizer(environment, document.s15FinalizeInput, {
        ...options,
        now: at
      });
    } catch (error) {
      if (error && error.code === 'SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED') {
        fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_EXPIRED');
      }
      if (error && error.code === 'SYNTHETIC_CANDIDATE_SOURCE_CHANGED') {
        fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_CHANGED');
      }
      if (error && /^SYNTHETIC_CANDIDATE_/.test(error.code || '')) {
        fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID');
      }
      fail('SYNTHETIC_EXTERNAL_APPROVAL_VERIFICATION_FAILED');
    }
  }
  const historical = runFinalizer(new Date(finalizedAt));
  if (canonicalJson(historical) !== canonicalJson(provided)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_CHANGED');
  }
  const live = runFinalizer(nowDate);
  const { finalizedAt: liveFinalizedAt, ...liveStable } = live;
  const { finalizedAt: providedFinalizedAt, ...providedStable } = provided;
  if (liveFinalizedAt !== nowDate.toISOString()
      || providedFinalizedAt !== new Date(finalizedAt).toISOString()
      || canonicalJson(liveStable) !== canonicalJson(providedStable)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_CHANGED');
  }
  const input = document.s15FinalizeInput;
  if (!input || !Array.isArray(input.externalAttestations)
      || canonicalHash(input.externalAttestations) !== provided.attestationSetSha256) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID');
  }
  const subject = input.machineSubject;
  if (!subject || subject.subjectSha256 !== provided.subjectSha256
      || subject.candidateBindingSha256 !== provided.candidateBindingSha256
      || subject.machineStateSha256 !== provided.machineStateSha256
      || !validDigest(subject.implementationTreeSha256)
      || !validDigest(subject.bindings && subject.bindings.configurationSha256)
      || !validDigest(subject.bindings && subject.bindings.rootContextSha256)
      || typeof subject.sourceCommit !== 'string' || !COMMIT.test(subject.sourceCommit)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_S15_SOURCE_INVALID');
  }
  return Object.freeze({
    input,
    evidence: provided,
    finalizedAt,
    validUntil,
    finalizedEvidenceSha256: canonicalHash(provided),
    subject
  });
}

function targetEnvironmentSha256(s15) {
  return canonicalHash({
    schemaVersion: 1,
    deploymentTier: 'synthetic',
    sourceCommit: s15.subject.sourceCommit,
    implementationTreeSha256: s15.subject.implementationTreeSha256,
    candidateBindingSha256: s15.evidence.candidateBindingSha256,
    rootContextSha256: s15.subject.bindings.rootContextSha256,
    configurationSha256: s15.subject.bindings.configurationSha256
  });
}

function assertKeyCurrent(key, at, now, code) {
  if (at < key.notBefore || at >= key.notAfter || now >= key.notAfter) fail(code);
}

function validateGateVerifications(envelopes, policyState, revocationState, s15, now) {
  if (!Array.isArray(envelopes)
      || envelopes.length !== candidate.GATE_SPECS.length) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_GATE_INCOMPLETE');
  }
  const code = 'SYNTHETIC_EXTERNAL_APPROVAL_GATE_INVALID';
  const targetSha256 = targetEnvironmentSha256(s15);
  const declarantRoles = new Map();
  const declarantPrincipals = new Set();
  const verifierPrincipals = new Set();
  const verificationRecords = new Set();
  let latestVerifiedAt = Number.NEGATIVE_INFINITY;
  let earliestExpiry = s15.validUntil;
  let earliestKeyNotAfter = Number.POSITIVE_INFINITY;
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const key = verifyEnvelope(
      envelope,
      policyState,
      'external_gate_verifier',
      GATE_DOMAIN,
      code,
      revocationState
    );
    const payload = envelope.payload;
    exactKeys(payload, [
      'schemaVersion', 'purpose', 'policySha256', 'subjectSha256',
      'candidateBindingSha256', 'machineStateSha256',
      's15FinalizedEvidenceSha256', 'attestationSetSha256',
      'targetEnvironmentSha256', 'gateId', 'evidenceReferenceSha256',
      'evidenceContentSha256', 'authorityRecordSha256',
      'verificationRecordSha256', 'declarantRole', 'sourceType',
      'declarantPrincipalIdSha256', 'verifierPrincipalIdSha256',
      'observedAt', 'verifiedAt', 'expiresAt', 'identityStatus',
      'evidenceStatus', 'factStatus'
    ], code);
    const [gateId, declarantRole, sourceType] = candidate.GATE_SPECS[index];
    const attestation = s15.input.externalAttestations[index];
    const observedAt = parseCanonicalTimestamp(payload.observedAt, code);
    const verifiedAt = parseCanonicalTimestamp(payload.verifiedAt, code);
    const expiresAt = parseCanonicalTimestamp(payload.expiresAt, code);
    if (revocationState.revokedPrincipalIds.has(payload.declarantPrincipalIdSha256)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_IDENTITY_REVOKED');
    }
    if (payload.schemaVersion !== 1
        || payload.purpose !== 'synthetic_external_gate_verification'
        || payload.policySha256 !== policyState.policySha256
        || payload.subjectSha256 !== s15.evidence.subjectSha256
        || payload.candidateBindingSha256 !== s15.evidence.candidateBindingSha256
        || payload.machineStateSha256 !== s15.evidence.machineStateSha256
        || payload.s15FinalizedEvidenceSha256 !== s15.finalizedEvidenceSha256
        || payload.attestationSetSha256 !== s15.evidence.attestationSetSha256
        || payload.targetEnvironmentSha256 !== targetSha256
        || payload.gateId !== gateId || payload.gateId !== attestation.gateId
        || payload.evidenceReferenceSha256 !== attestation.evidenceReferenceSha256
        || !validDigest(payload.evidenceContentSha256)
        || !validDigest(payload.authorityRecordSha256)
        || !validDigest(payload.verificationRecordSha256)
        || verificationRecords.has(payload.verificationRecordSha256)
        || payload.declarantRole !== declarantRole
        || payload.declarantRole !== attestation.declarantRole
        || payload.sourceType !== sourceType || payload.sourceType !== attestation.sourceType
        || !validDigest(payload.declarantPrincipalIdSha256)
        || payload.verifierPrincipalIdSha256 !== key.principalIdSha256
        || payload.declarantPrincipalIdSha256 === payload.verifierPrincipalIdSha256
        || payload.declarantPrincipalIdSha256
          === revocationState.authorityPrincipalIdSha256
        || !key.allowedGateIds.includes(gateId)
        || payload.observedAt !== attestation.observedAt
        || observedAt > verifiedAt || verifiedAt < s15.finalizedAt
        || verifiedAt > now + CLOCK_SKEW_MS
        || expiresAt <= now || expiresAt <= verifiedAt
        || expiresAt > s15.validUntil
        || expiresAt > Date.parse(attestation.expiresAt)
        || payload.identityStatus !== 'authenticated_by_external_authority'
        || payload.evidenceStatus !== 'retrieved_and_verified_by_external_connector'
        || payload.factStatus !== 'verified_satisfied') {
      if (expiresAt <= now) fail('SYNTHETIC_EXTERNAL_APPROVAL_GATE_EXPIRED');
      if (payload.declarantPrincipalIdSha256
          === revocationState.authorityPrincipalIdSha256) {
        fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
      }
      fail(code);
    }
    assertKeyCurrent(key, verifiedAt, now, code);
    const priorRole = declarantRoles.get(payload.declarantPrincipalIdSha256);
    if (priorRole && priorRole !== declarantRole) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
    }
    declarantRoles.set(payload.declarantPrincipalIdSha256, declarantRole);
    declarantPrincipals.add(payload.declarantPrincipalIdSha256);
    verifierPrincipals.add(payload.verifierPrincipalIdSha256);
    verificationRecords.add(payload.verificationRecordSha256);
    latestVerifiedAt = Math.max(latestVerifiedAt, verifiedAt);
    earliestExpiry = Math.min(earliestExpiry, expiresAt);
    earliestKeyNotAfter = Math.min(earliestKeyNotAfter, key.notAfter);
  }
  for (const principal of declarantPrincipals) {
    if (verifierPrincipals.has(principal)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
    }
  }
  return Object.freeze({
    targetEnvironmentSha256: targetSha256,
    gateVerificationSetSha256: canonicalHash(envelopes),
    declarantPrincipals,
    verifierPrincipals,
    latestVerifiedAt,
    earliestExpiry,
    earliestKeyNotAfter
  });
}

function validateApproval(envelope, policyState, revocationState, s15, gates, now) {
  const code = 'SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_INVALID';
  const key = verifyEnvelope(
    envelope,
    policyState,
    'deployment_approver',
    APPROVAL_DOMAIN,
    code,
    revocationState
  );
  const payload = envelope.payload;
  exactKeys(payload, [
    'schemaVersion', 'purpose', 'policySha256', 'subjectSha256',
    'candidateBindingSha256', 'machineStateSha256',
    's15FinalizedEvidenceSha256', 'attestationSetSha256',
    'gateVerificationSetSha256', 'targetEnvironmentSha256', 'approvalId',
    'approverPrincipalIdSha256', 'approvedAt', 'notBefore', 'expiresAt',
    'decision', 'scope', 'auditRecordSha256',
    'productionChildGateChangeAuthorization', 'childUseAuthorization'
  ], code);
  const approvedAt = parseCanonicalTimestamp(payload.approvedAt, code);
  const notBefore = parseCanonicalTimestamp(payload.notBefore, code);
  const expiresAt = parseCanonicalTimestamp(payload.expiresAt, code);
  const approvalIdSha256 = typeof payload.approvalId === 'string'
    ? sha256(Buffer.from(payload.approvalId, 'utf8'))
    : '';
  if (revocationState.revokedApprovalIds.has(approvalIdSha256)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_REVOKED');
  }
  if (payload.schemaVersion !== 1
      || payload.purpose !== 'synthetic_external_deployment_approval'
      || payload.policySha256 !== policyState.policySha256
      || payload.subjectSha256 !== s15.evidence.subjectSha256
      || payload.candidateBindingSha256 !== s15.evidence.candidateBindingSha256
      || payload.machineStateSha256 !== s15.evidence.machineStateSha256
      || payload.s15FinalizedEvidenceSha256 !== s15.finalizedEvidenceSha256
      || payload.attestationSetSha256 !== s15.evidence.attestationSetSha256
      || payload.gateVerificationSetSha256 !== gates.gateVerificationSetSha256
      || payload.targetEnvironmentSha256 !== gates.targetEnvironmentSha256
      || typeof payload.approvalId !== 'string' || !SYNTHETIC_ID.test(payload.approvalId)
      || !validDigest(approvalIdSha256)
      || payload.approverPrincipalIdSha256 !== key.principalIdSha256
      || gates.declarantPrincipals.has(payload.approverPrincipalIdSha256)
      || gates.verifierPrincipals.has(payload.approverPrincipalIdSha256)
      || approvedAt < gates.latestVerifiedAt || approvedAt > now + CLOCK_SKEW_MS
      || notBefore < approvedAt || notBefore > now
      || expiresAt <= now || expiresAt <= notBefore
      || expiresAt - notBefore > APPROVAL_TTL_MS
      || expiresAt > gates.earliestExpiry
      || payload.decision !== 'approved'
      || payload.scope !== 'single_synthetic_api_deployment'
      || !validDigest(payload.auditRecordSha256)
      || payload.productionChildGateChangeAuthorization !== 'not_granted'
      || payload.childUseAuthorization !== 'not_granted') {
    if (expiresAt <= now) fail('SYNTHETIC_EXTERNAL_APPROVAL_APPROVAL_EXPIRED');
    if (gates.declarantPrincipals.has(payload.approverPrincipalIdSha256)
        || gates.verifierPrincipals.has(payload.approverPrincipalIdSha256)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
    }
    fail(code);
  }
  assertKeyCurrent(key, approvedAt, now, code);
  return Object.freeze({
    approvalIdSha256,
    approvalEnvelopeSha256: canonicalHash(envelope),
    approverPrincipalIdSha256: payload.approverPrincipalIdSha256,
    approvedAt,
    expiresAt,
    keyNotAfter: key.notAfter
  });
}

function validateGrant(envelope, policyState, revocationState, s15, gates, approval, now) {
  const code = 'SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_INVALID';
  const key = verifyEnvelope(
    envelope,
    policyState,
    'deployment_grant_issuer',
    GRANT_DOMAIN,
    code,
    revocationState
  );
  const payload = envelope.payload;
  exactKeys(payload, [
    'schemaVersion', 'purpose', 'policySha256', 'subjectSha256',
    'candidateBindingSha256', 'machineStateSha256', 'sourceCommit',
    'implementationTreeSha256', 'configurationSha256',
    's15FinalizedEvidenceSha256', 'attestationSetSha256',
    'gateVerificationSetSha256', 'approvalEnvelopeSha256',
    'targetEnvironmentSha256', 'grantId', 'grantIssuerPrincipalIdSha256',
    'consumerIdSha256', 'issuedAt', 'notBefore', 'expiresAt', 'action',
    'scope', 'consumptionMode', 'productionChildGateChangeAuthorization',
    'childUseAuthorization'
  ], code);
  const issuedAt = parseCanonicalTimestamp(payload.issuedAt, code);
  const notBefore = parseCanonicalTimestamp(payload.notBefore, code);
  const expiresAt = parseCanonicalTimestamp(payload.expiresAt, code);
  const grantIdSha256 = typeof payload.grantId === 'string'
    ? sha256(Buffer.from(payload.grantId, 'utf8'))
    : '';
  if (revocationState.revokedGrantIds.has(grantIdSha256)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_REVOKED');
  }
  if (payload.schemaVersion !== 1
      || payload.purpose !== 'synthetic_external_deployment_grant'
      || payload.policySha256 !== policyState.policySha256
      || payload.subjectSha256 !== s15.evidence.subjectSha256
      || payload.candidateBindingSha256 !== s15.evidence.candidateBindingSha256
      || payload.machineStateSha256 !== s15.evidence.machineStateSha256
      || payload.sourceCommit !== s15.subject.sourceCommit
      || payload.implementationTreeSha256 !== s15.subject.implementationTreeSha256
      || payload.configurationSha256 !== s15.subject.bindings.configurationSha256
      || payload.s15FinalizedEvidenceSha256 !== s15.finalizedEvidenceSha256
      || payload.attestationSetSha256 !== s15.evidence.attestationSetSha256
      || payload.gateVerificationSetSha256 !== gates.gateVerificationSetSha256
      || payload.approvalEnvelopeSha256 !== approval.approvalEnvelopeSha256
      || payload.targetEnvironmentSha256 !== gates.targetEnvironmentSha256
      || typeof payload.grantId !== 'string' || !SYNTHETIC_ID.test(payload.grantId)
      || !validDigest(grantIdSha256)
      || payload.grantIssuerPrincipalIdSha256 !== key.principalIdSha256
      || payload.grantIssuerPrincipalIdSha256 === approval.approverPrincipalIdSha256
      || gates.declarantPrincipals.has(payload.grantIssuerPrincipalIdSha256)
      || gates.verifierPrincipals.has(payload.grantIssuerPrincipalIdSha256)
      || !validDigest(payload.consumerIdSha256)
      || issuedAt < approval.approvedAt || issuedAt > now + CLOCK_SKEW_MS
      || notBefore < issuedAt || notBefore > now
      || expiresAt <= now || expiresAt <= notBefore
      || expiresAt - notBefore > GRANT_TTL_MS
      || expiresAt > approval.expiresAt
      || payload.action !== 'deploy_synthetic_once'
      || payload.scope !== 'single_synthetic_api_deployment'
      || payload.consumptionMode !== 'external_atomic_single_use_required'
      || payload.productionChildGateChangeAuthorization !== 'not_granted'
      || payload.childUseAuthorization !== 'not_granted') {
    if (expiresAt <= now) fail('SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_EXPIRED');
    if (payload.targetEnvironmentSha256 !== gates.targetEnvironmentSha256
        || payload.sourceCommit !== s15.subject.sourceCommit
        || payload.implementationTreeSha256 !== s15.subject.implementationTreeSha256
        || payload.configurationSha256 !== s15.subject.bindings.configurationSha256) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_TARGET_MISMATCH');
    }
    if (payload.grantIssuerPrincipalIdSha256 === approval.approverPrincipalIdSha256
        || gates.declarantPrincipals.has(payload.grantIssuerPrincipalIdSha256)
        || gates.verifierPrincipals.has(payload.grantIssuerPrincipalIdSha256)) {
      fail('SYNTHETIC_EXTERNAL_APPROVAL_DUTY_SEPARATION_INVALID');
    }
    fail(code);
  }
  assertKeyCurrent(key, issuedAt, now, code);
  return Object.freeze({
    grantIdSha256,
    grantEnvelopeSha256: canonicalHash(envelope),
    issuedAt,
    expiresAt,
    keyNotAfter: key.notAfter
  });
}

const TEST_ONLY_OVERRIDE = Symbol('synthetic-external-approval-test-only-override');

function verifySyntheticExternalApprovalInternal(environment, document, options) {
  assertAck(environment);
  exactKeys(document, [
    'schemaVersion', 'purpose', 's15FinalizeInput', 's15FinalizedEvidence',
    'signedRevocationCheckpoint', 'signedGateVerifications', 'signedDeploymentApproval',
    'signedDeploymentGrant'
  ], 'SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  if (document.schemaVersion !== 1
      || document.purpose !== 'synthetic_external_approval_verify') {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  }
  const nowDate = options.now instanceof Date ? options.now : new Date();
  const now = nowDate.getTime();
  if (!Number.isFinite(now)) fail('SYNTHETIC_EXTERNAL_APPROVAL_INPUT_INVALID');
  const firstPolicyContext = readTrustPolicyFile(environment);
  const policyState = validateTrustPolicy(firstPolicyContext, now);
  const revocationState = validateRevocationCheckpoint(
    document.signedRevocationCheckpoint,
    policyState,
    now
  );
  const s15 = validateS15Evidence(document, environment, nowDate, options);
  const gates = validateGateVerifications(
    document.signedGateVerifications,
    policyState,
    revocationState,
    s15,
    now
  );
  const approval = validateApproval(
    document.signedDeploymentApproval,
    policyState,
    revocationState,
    s15,
    gates,
    now
  );
  const grant = validateGrant(
    document.signedDeploymentGrant,
    policyState,
    revocationState,
    s15,
    gates,
    approval,
    now
  );
  if (revocationState.issuedAt < Math.max(
    gates.latestVerifiedAt,
    approval.approvedAt,
    grant.issuedAt
  )) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_REVOCATION_INVALID');
  }
  const secondPolicyContext = readTrustPolicyFile(environment);
  if (canonicalJson(firstPolicyContext.snapshot) !== canonicalJson(secondPolicyContext.snapshot)
      || firstPolicyContext.fileReal !== secondPolicyContext.fileReal
      || firstPolicyContext.policySha256 !== secondPolicyContext.policySha256
      || canonicalJson(firstPolicyContext.policy) !== canonicalJson(secondPolicyContext.policy)) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_TRUST_POLICY_CHANGED');
  }
  const validUntil = Math.min(
    s15.validUntil,
    policyState.validUntil,
    revocationState.validUntil,
    revocationState.keyNotAfter,
    gates.earliestExpiry,
    gates.earliestKeyNotAfter,
    approval.expiresAt,
    approval.keyNotAfter,
    grant.expiresAt,
    grant.keyNotAfter
  );
  const completedDate = options.completedAt instanceof Date ? options.completedAt : new Date();
  const completedAt = completedDate.getTime();
  if (!Number.isFinite(completedAt) || completedAt < now) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_VERIFICATION_FAILED');
  }
  if (completedAt >= validUntil) {
    fail('SYNTHETIC_EXTERNAL_APPROVAL_AUTHORIZATION_EXPIRED');
  }
  const testOnlyOverridesUsed = options[TEST_ONLY_OVERRIDE] === true;
  return Object.freeze({
    schemaVersion: 1,
    profile: 'synthetic-external-approval-verification',
    result: 'signed-bundle-valid-against-provided-policy-unconsumed',
    verifiedAt: completedDate.toISOString(),
    validUntil: new Date(validUntil).toISOString(),
    subjectSha256: s15.evidence.subjectSha256,
    candidateBindingSha256: s15.evidence.candidateBindingSha256,
    machineStateSha256: s15.evidence.machineStateSha256,
    s15FinalizedEvidenceSha256: s15.finalizedEvidenceSha256,
    attestationSetSha256: s15.evidence.attestationSetSha256,
    gateVerificationSetSha256: gates.gateVerificationSetSha256,
    targetEnvironmentSha256: gates.targetEnvironmentSha256,
    trustPolicySha256: policyState.policySha256,
    trustPolicyRevision: policyState.policy.revision,
    revocationCheckpointSha256: revocationState.checkpointSha256,
    revocationCheckpointSequence: revocationState.sequence,
    approvalIdSha256: approval.approvalIdSha256,
    approvalEnvelopeSha256: approval.approvalEnvelopeSha256,
    grantIdSha256: grant.grantIdSha256,
    grantEnvelopeSha256: grant.grantEnvelopeSha256,
    gateVerificationCount: candidate.REQUIRED_GATE_IDS.length,
    requiredGateIds: candidate.REQUIRED_GATE_IDS,
    checks: Object.freeze({
      testOnlyOverridesUsed,
      currentMachineStateRevalidated: !testOnlyOverridesUsed,
      s15EnvelopeRevalidated: !testOnlyOverridesUsed,
      trustPolicyDigestPinnedByEnvironment: true,
      trustPolicyFileStableDuringVerification: true,
      ed25519Only: true,
      domainSeparatedSignaturesVerifiedAgainstProvidedPolicy: true,
      revocationCheckpointSignatureVerifiedAgainstProvidedPolicy: true,
      revocationCheckpointCoversSignedArtifacts: true,
      declarantVerifierDutySeparationChecked: true,
      revocationAuthorityDutySeparationChecked: true,
      deploymentApproverDutySeparationChecked: true,
      grantIssuerDutySeparationChecked: true,
      targetEnvironmentBound: true,
      localFreshnessWindowChecked: true,
      trustPolicyExternallyAuthorizedByThisCommand: false,
      externalIdentityProofRetrievedByThisCommand: false,
      externalEvidenceContentRetrievedByThisCommand: false,
      externalAuditRecordRetrievedByThisCommand: false,
      trustedTimeVerified: false,
      revocationCheckpointMonotonicityExternallyVerified: false,
      approvalNonRepudiationEstablished: false,
      authorizationConsumptionVerified: false,
      replayProtectionPersisted: false
    }),
    operations: Object.freeze({
      trustPolicyFileReadOnly: true,
      readOnlyGitSubprocessStarted: !testOnlyOverridesUsed,
      databaseOpenedReadOnly: !testOnlyOverridesUsed,
      syntheticDatabaseWritten: false,
      networkAccessPerformed: false,
      deploymentPerformed: false,
      productionDataRead: false,
      productionChildGateChanged: false
    }),
    declarantIdentitiesAuthenticatedByThisCommand: false,
    authoritativeEvidenceVerifiedByThisCommand: false,
    externalFactsVerifiedByThisCommand: false,
    deploymentGrantStatus: 'signature_valid_against_provided_policy_unconsumed',
    deploymentAuthorization: 'not_granted',
    productionChildGateState: 'not_observed',
    childUseAuthorization: 'not_granted'
  });
}

function verifySyntheticExternalApproval(environment, document) {
  return verifySyntheticExternalApprovalInternal(environment, document, {});
}

function verifySyntheticExternalApprovalForTest(environment, document, options = {}) {
  return verifySyntheticExternalApprovalInternal(environment, document, {
    ...options,
    [TEST_ONLY_OVERRIDE]: true
  });
}

function usage() {
  return [
    'Usage: npm run verify:synthetic-external-approval',
    '',
    `Requires ${ACK_ENV}=${ACK}.`,
    `Requires ${POLICY_FILE_ENV}, ${POLICY_PARENT_ENV} and ${POLICY_SHA256_ENV}.`,
    'Reads one canonical JSON document from non-TTY stdin and a pinned public trust policy.',
    'It revalidates S15, verifies only Ed25519 signature envelopes and writes one redacted line.',
    'It does not fetch identity/evidence/audit facts, trust local time, persist replay state,',
    'consume a deployment grant, access the network, deploy or grant production/child use.'
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
      const output = verifySyntheticExternalApproval(environment, document);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } finally {
      buffer.fill(0);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Synthetic external approval verification failed (${safeErrorCode(error)}).\n`);
    return 1;
  }
}

module.exports = {
  ACK,
  ACK_ENV,
  APPROVAL_DOMAIN,
  APPROVAL_TTL_MS,
  CLOCK_SKEW_MS,
  GATE_DOMAIN,
  GRANT_DOMAIN,
  GRANT_TTL_MS,
  MAX_POLICY_BYTES,
  MAX_STDIN_BYTES,
  POLICY_FILE_ENV,
  POLICY_PARENT_ENV,
  POLICY_SHA256_ENV,
  POLICY_TTL_MS,
  REVOCATION_DOMAIN,
  SyntheticExternalApprovalError,
  canonicalHash,
  canonicalJson,
  decodeCanonicalInput,
  parseArguments,
  readStdin,
  runCli,
  safeErrorCode,
  usage,
  verifySyntheticExternalApproval,
  verifySyntheticExternalApprovalForTest
};
