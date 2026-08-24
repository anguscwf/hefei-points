import { SessionDto } from '../network/ApiContracts';

export class EnvelopePhase {
  static readonly UNPAIRED: string = 'UNPAIRED';
  static readonly CLAIM_INTENT: string = 'CLAIM_INTENT';
  static readonly WAITING_GUARDIAN: string = 'WAITING_GUARDIAN';
  static readonly COMPLETE_RESULT_UNKNOWN: string = 'COMPLETE_RESULT_UNKNOWN';
  static readonly ACTIVE: string = 'ACTIVE';
  static readonly REFRESH_ISSUE_INTENT: string = 'REFRESH_ISSUE_INTENT';
  static readonly REFRESH_COMPLETE_INTENT: string = 'REFRESH_COMPLETE_INTENT';
}

export class SessionEnvelope {
  version: number = 1;
  revision: number = 0;
  phase: string = EnvelopePhase.UNPAIRED;
  devicePublicId: string = '';

  claimShortCode: string = '';
  claimIdempotencyKey: string = '';
  claimToken: string = '';
  proofExpiresAt: string = '';
  proofBindingId: string = '';
  completeSignature: string = '';
  completeIdempotencyKey: string = '';

  bindingId: string = '';
  sessionId: string = '';
  accessToken: string = '';
  accessExpiresAt: string = '';
  refreshToken: string = '';
  refreshExpiresAt: string = '';
  rotationCounter: number = 0;

  refreshIssueIdempotencyKey: string = '';
  refreshChallengeId: string = '';
  refreshProofExpiresAt: string = '';
  refreshSignature: string = '';
  refreshCompleteIdempotencyKey: string = '';
}

interface CompactEnvelope {
  v: number;
  r: number;
  p: string;
  d: string;
  sc: string;
  ci: string;
  ct: string;
  px: string;
  pb: string;
  cs: string;
  ck: string;
  b: string;
  s: string;
  a: string;
  ae: string;
  f: string;
  fe: string;
  n: number;
  ri: string;
  rc: string;
  rx: string;
  rs: string;
  rk: string;
}

function idempotencyKey(value: string): boolean {
  return /^[\x21-\x7e]{16,128}$/.test(value);
}

function resourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function signature(value: string): boolean {
  return /^[A-Za-z0-9_-]{86,96}$/.test(value) && value.length % 4 !== 1;
}

function allEmpty(values: Array<string>): boolean {
  for (let index: number = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string' || values[index].length !== 0) {
      return false;
    }
  }
  return true;
}

function pairingFieldsEmpty(value: SessionEnvelope): boolean {
  return allEmpty([
    value.claimShortCode,
    value.claimIdempotencyKey,
    value.claimToken,
    value.proofExpiresAt,
    value.proofBindingId,
    value.completeSignature,
    value.completeIdempotencyKey
  ]);
}

function sessionFieldsEmpty(value: SessionEnvelope): boolean {
  return allEmpty([
    value.bindingId,
    value.sessionId,
    value.accessToken,
    value.accessExpiresAt,
    value.refreshToken,
    value.refreshExpiresAt
  ]) && value.rotationCounter === 0;
}

function refreshFieldsEmpty(value: SessionEnvelope): boolean {
  return allEmpty([
    value.refreshIssueIdempotencyKey,
    value.refreshChallengeId,
    value.refreshProofExpiresAt,
    value.refreshSignature,
    value.refreshCompleteIdempotencyKey
  ]);
}

function sessionPresent(value: SessionEnvelope): boolean {
  return resourceId(value.bindingId) && resourceId(value.sessionId)
    && /^tg_access\.[A-Za-z0-9_-]{43}$/.test(value.accessToken)
    && /^tg_refresh\.[A-Za-z0-9_-]{43}$/.test(value.refreshToken)
    && Number.isFinite(Date.parse(value.accessExpiresAt))
    && Number.isFinite(Date.parse(value.refreshExpiresAt))
    && Date.parse(value.accessExpiresAt) < Date.parse(value.refreshExpiresAt)
    && Number.isSafeInteger(value.rotationCounter) && value.rotationCounter >= 0;
}

export function validateEnvelope(value: SessionEnvelope): void {
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !/^[A-Za-z0-9_-]{22,86}$/.test(value.devicePublicId)) {
    throw new Error('LOCAL_STATE_CORRUPT');
  }
  if (value.phase === EnvelopePhase.UNPAIRED) {
    if (!pairingFieldsEmpty(value) || !sessionFieldsEmpty(value)
        || !refreshFieldsEmpty(value)) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  if (value.phase === EnvelopePhase.CLAIM_INTENT) {
    if (!/^\d{6}$/.test(value.claimShortCode) || !idempotencyKey(value.claimIdempotencyKey)
        || !allEmpty([
          value.claimToken,
          value.proofExpiresAt,
          value.proofBindingId,
          value.completeSignature,
          value.completeIdempotencyKey
        ])
        || !sessionFieldsEmpty(value) || !refreshFieldsEmpty(value)) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  if (value.phase === EnvelopePhase.WAITING_GUARDIAN
      || value.phase === EnvelopePhase.COMPLETE_RESULT_UNKNOWN) {
    if (!allEmpty([value.claimShortCode, value.claimIdempotencyKey])
        || !/^tg_claim\.[A-Za-z0-9_-]{43}$/.test(value.claimToken)
        || !Number.isFinite(Date.parse(value.proofExpiresAt))
        || !resourceId(value.proofBindingId)
        || !signature(value.completeSignature)
        || !idempotencyKey(value.completeIdempotencyKey)
        || !sessionFieldsEmpty(value) || !refreshFieldsEmpty(value)) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  if (!pairingFieldsEmpty(value) || !sessionPresent(value)) {
    throw new Error('LOCAL_STATE_CORRUPT');
  }
  if (value.phase === EnvelopePhase.ACTIVE) {
    if (!refreshFieldsEmpty(value)) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  if (value.phase === EnvelopePhase.REFRESH_ISSUE_INTENT) {
    if (!idempotencyKey(value.refreshIssueIdempotencyKey)
        || !allEmpty([
          value.refreshChallengeId,
          value.refreshProofExpiresAt,
          value.refreshSignature,
          value.refreshCompleteIdempotencyKey
        ])) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  if (value.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
    if (typeof value.refreshIssueIdempotencyKey !== 'string'
        || value.refreshIssueIdempotencyKey.length !== 0
        || !resourceId(value.refreshChallengeId)
        || !Number.isFinite(Date.parse(value.refreshProofExpiresAt))
        || !signature(value.refreshSignature)
        || !idempotencyKey(value.refreshCompleteIdempotencyKey)) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return;
  }
  throw new Error('LOCAL_STATE_CORRUPT');
}

export function serializeEnvelope(value: SessionEnvelope): string {
  validateEnvelope(value);
  const compact: CompactEnvelope = {
    v: value.version,
    r: value.revision,
    p: value.phase,
    d: value.devicePublicId,
    sc: value.claimShortCode,
    ci: value.claimIdempotencyKey,
    ct: value.claimToken,
    px: value.proofExpiresAt,
    pb: value.proofBindingId,
    cs: value.completeSignature,
    ck: value.completeIdempotencyKey,
    b: value.bindingId,
    s: value.sessionId,
    a: value.accessToken,
    ae: value.accessExpiresAt,
    f: value.refreshToken,
    fe: value.refreshExpiresAt,
    n: value.rotationCounter,
    ri: value.refreshIssueIdempotencyKey,
    rc: value.refreshChallengeId,
    rx: value.refreshProofExpiresAt,
    rs: value.refreshSignature,
    rk: value.refreshCompleteIdempotencyKey
  };
  return JSON.stringify(compact);
}

export function parseEnvelope(text: string): SessionEnvelope {
  const compact: CompactEnvelope = JSON.parse(text) as CompactEnvelope;
  const value: SessionEnvelope = new SessionEnvelope();
  value.version = compact.v;
  value.revision = compact.r;
  value.phase = compact.p;
  value.devicePublicId = compact.d;
  value.claimShortCode = compact.sc;
  value.claimIdempotencyKey = compact.ci;
  value.claimToken = compact.ct;
  value.proofExpiresAt = compact.px;
  value.proofBindingId = compact.pb;
  value.completeSignature = compact.cs;
  value.completeIdempotencyKey = compact.ck;
  value.bindingId = compact.b;
  value.sessionId = compact.s;
  value.accessToken = compact.a;
  value.accessExpiresAt = compact.ae;
  value.refreshToken = compact.f;
  value.refreshExpiresAt = compact.fe;
  value.rotationCounter = compact.n;
  value.refreshIssueIdempotencyKey = compact.ri;
  value.refreshChallengeId = compact.rc;
  value.refreshProofExpiresAt = compact.rx;
  value.refreshSignature = compact.rs;
  value.refreshCompleteIdempotencyKey = compact.rk;
  validateEnvelope(value);
  return value;
}

export function copyEnvelope(source: SessionEnvelope): SessionEnvelope {
  return parseEnvelope(serializeEnvelope(source));
}

export function unpairedEnvelope(devicePublicId: string): SessionEnvelope {
  const value: SessionEnvelope = new SessionEnvelope();
  value.devicePublicId = devicePublicId;
  validateEnvelope(value);
  return value;
}

export function activeEnvelope(devicePublicId: string, bindingId: string,
  session: SessionDto): SessionEnvelope {
  const value: SessionEnvelope = unpairedEnvelope(devicePublicId);
  value.phase = EnvelopePhase.ACTIVE;
  value.bindingId = bindingId;
  value.sessionId = session.id;
  value.accessToken = session.accessToken;
  value.accessExpiresAt = session.accessExpiresAt;
  value.refreshToken = session.refreshToken;
  value.refreshExpiresAt = session.refreshExpiresAt;
  value.rotationCounter = session.rotationCounter;
  validateEnvelope(value);
  return value;
}

export function sessionFromEnvelope(value: SessionEnvelope): SessionDto {
  if (!sessionPresent(value)) {
    throw new Error('LOCAL_STATE_CORRUPT');
  }
  return {
    id: value.sessionId,
    accessToken: value.accessToken,
    accessExpiresAt: value.accessExpiresAt,
    refreshToken: value.refreshToken,
    refreshExpiresAt: value.refreshExpiresAt,
    rotationCounter: value.rotationCounter
  };
}
