import { base64urlDecode, isCanonicalBase64url, utf8Decode } from '../security/Encoding';

export const DEVICE_KEY_ALGORITHM: string = 'ECDSA_P256_SHA256';

const RESOURCE_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{8,128}$/;
const DATA_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,128}$/;
const CHILD_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{2,64}$/;
const DEVICE_PUBLIC_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{22,86}$/;
const CLAIM_TOKEN_PATTERN: RegExp = /^tg_claim\.[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_PATTERN: RegExp = /^tg_access\.[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_PATTERN: RegExp = /^tg_refresh\.[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN: RegExp = /^[0-9a-f]{64}$/;
const API_CODE_PATTERN: RegExp = /^[A-Z][A-Z0-9_]{2,63}$/;

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface DevicePublicKeyDto {
  algorithm: string;
  spkiBase64url: string;
}

export interface ClaimPairingRequest {
  shortCode: string;
  devicePublicId: string;
  deviceAlias: string;
  publicKey: DevicePublicKeyDto;
}

export interface ProofDto {
  algorithm: string;
  challengeId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: string;
}

export interface ClaimPairingResponse {
  success: boolean;
  claimId: string;
  proof: ProofDto;
}

export interface DeviceKeySummaryDto {
  algorithm: string;
  sha256: string;
}

export interface DeviceDto {
  id: string;
  childId: string;
  publicId: string;
  alias: string;
  publicKey: DeviceKeySummaryDto;
  status: string;
  revision: number;
  claimedAt: string;
  activatedAt?: string;
  revokedAt?: string;
}

export interface SessionDto {
  id: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  rotationCounter: number;
}

export interface PairingCompletionResponse {
  success: boolean;
  device: DeviceDto;
  session: SessionDto;
}

export interface ProofResponse {
  success: boolean;
  proof: ProofDto;
}

export interface RefreshResponse {
  success: boolean;
  session: SessionDto;
}

export interface ChildDto {
  id: string;
  name: string;
}

export interface PointsDto {
  balance: number;
}

export interface SummaryResponse {
  success: boolean;
  child: ChildDto;
  points: PointsDto;
}

export interface TransactionDto {
  id: string;
  occurredAt: string;
  amount: number;
  reason: string;
  ruleId: string | null;
  categoryId: string | null;
}

export interface TransactionPageDto {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface TransactionsResponse {
  success: boolean;
  transactions: Array<TransactionDto>;
  page: TransactionPageDto;
}

export interface ApiErrorDto {
  success: boolean;
  code: string;
  message: string;
  requestId?: string;
  field?: string;
}

export interface VerifiedProof {
  purpose: string;
  bindingId: string;
  sessionId: string;
  payload: Uint8Array;
}

export interface VerifiedProofContext {
  purpose: string;
  bindingId: string;
  sessionId: string;
}

function requireCondition(condition: boolean, code: string): void {
  if (!condition) {
    throw new ContractError(code);
  }
}

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length >= 20 && value.length <= 35
    && Number.isFinite(Date.parse(value));
}

function validText(value: string, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validateClaimRequest(value: ClaimPairingRequest): void {
  requireCondition(/^\d{6}$/.test(value.shortCode), 'VALIDATION_ERROR');
  requireCondition(DEVICE_PUBLIC_ID_PATTERN.test(value.devicePublicId), 'VALIDATION_ERROR');
  requireCondition(validText(value.deviceAlias, 1, 40), 'VALIDATION_ERROR');
  requireCondition(value.publicKey.algorithm === DEVICE_KEY_ALGORITHM, 'DEVICE_KEY_INVALID');
  requireCondition(/^[A-Za-z0-9_-]{122}$/.test(value.publicKey.spkiBase64url),
    'DEVICE_KEY_INVALID');
}

export function validateSession(value: SessionDto): void {
  requireCondition(RESOURCE_ID_PATTERN.test(value.id), 'PROTOCOL_ERROR');
  requireCondition(ACCESS_TOKEN_PATTERN.test(value.accessToken), 'PROTOCOL_ERROR');
  requireCondition(REFRESH_TOKEN_PATTERN.test(value.refreshToken), 'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.accessExpiresAt), 'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.refreshExpiresAt), 'PROTOCOL_ERROR');
  requireCondition(Date.parse(value.accessExpiresAt) < Date.parse(value.refreshExpiresAt), 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.rotationCounter) && value.rotationCounter >= 0,
    'PROTOCOL_ERROR');
}

export function verifyProof(value: ProofDto, expectedPurpose: string,
  expectedBindingId: string = '', expectedSessionId: string = ''): VerifiedProof {
  requireCondition(value.algorithm === DEVICE_KEY_ALGORITHM, 'PROTOCOL_ERROR');
  requireCondition(RESOURCE_ID_PATTERN.test(value.challengeId), 'PROTOCOL_ERROR');
  requireCondition(isCanonicalBase64url(value.challenge, 32, 32), 'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.expiresAt), 'PROTOCOL_ERROR');
  requireCondition(Date.parse(value.expiresAt) > Date.now(), 'CHALLENGE_EXPIRED');
  const payload: Uint8Array = base64urlDecode(value.signingPayload);
  requireCondition(payload.length >= 120 && payload.length <= 512, 'PROTOCOL_ERROR');
  const text: string = utf8Decode(payload);
  const context: VerifiedProofContext = verifySigningPayloadText(
    text,
    expectedPurpose,
    value.challengeId,
    value.challenge,
    expectedBindingId,
    expectedSessionId
  );
  return {
    purpose: context.purpose,
    bindingId: context.bindingId,
    sessionId: context.sessionId,
    payload
  };
}

export function verifySigningPayloadText(text: string, expectedPurpose: string,
  challengeId: string, challenge: string, expectedBindingId: string = '',
  expectedSessionId: string = ''): VerifiedProofContext {
  requireCondition(text.indexOf('\r') === -1, 'PROTOCOL_ERROR');
  const lines: Array<string> = text.split('\n');
  requireCondition(lines.length === 6, 'PROTOCOL_ERROR');
  requireCondition(lines[0] === 'tangguan-device-proof-v1', 'PROTOCOL_ERROR');
  requireCondition(lines[1] === `purpose=${expectedPurpose}`, 'PROTOCOL_ERROR');
  requireCondition(lines[2] === `challengeId=${challengeId}`, 'PROTOCOL_ERROR');
  requireCondition(lines[3] === `challenge=${challenge}`, 'PROTOCOL_ERROR');
  requireCondition(lines[4].startsWith('deviceBindingId='), 'PROTOCOL_ERROR');
  requireCondition(lines[5].startsWith('sessionId='), 'PROTOCOL_ERROR');
  const bindingId: string = lines[4].substring('deviceBindingId='.length);
  const sessionId: string = lines[5].substring('sessionId='.length);
  requireCondition(RESOURCE_ID_PATTERN.test(bindingId), 'PROTOCOL_ERROR');
  requireCondition(expectedBindingId.length === 0 || bindingId === expectedBindingId, 'PROTOCOL_ERROR');
  requireCondition(sessionId === expectedSessionId, 'PROTOCOL_ERROR');
  return { purpose: expectedPurpose, bindingId, sessionId };
}

export function parseClaimResponse(text: string): ClaimPairingResponse {
  const value: ClaimPairingResponse = JSON.parse(text) as ClaimPairingResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(CLAIM_TOKEN_PATTERN.test(value.claimId), 'PROTOCOL_ERROR');
  verifyProof(value.proof, 'pairing_completion');
  return value;
}

export function parseCompletionResponse(text: string, devicePublicId: string,
  proofBindingId: string): PairingCompletionResponse {
  const value: PairingCompletionResponse = JSON.parse(text) as PairingCompletionResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(RESOURCE_ID_PATTERN.test(value.device.id), 'PROTOCOL_ERROR');
  requireCondition(value.device.id === proofBindingId, 'PROTOCOL_ERROR');
  requireCondition(CHILD_ID_PATTERN.test(value.device.childId), 'PROTOCOL_ERROR');
  requireCondition(value.device.publicId === devicePublicId, 'PROTOCOL_ERROR');
  requireCondition(validText(value.device.alias, 1, 40), 'PROTOCOL_ERROR');
  requireCondition(value.device.status === 'active', 'PROTOCOL_ERROR');
  requireCondition(value.device.publicKey.algorithm === DEVICE_KEY_ALGORITHM,
    'PROTOCOL_ERROR');
  requireCondition(SHA256_PATTERN.test(value.device.publicKey.sha256), 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.device.revision) && value.device.revision >= 0,
    'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.device.claimedAt), 'PROTOCOL_ERROR');
  validateSession(value.session);
  requireCondition(value.session.rotationCounter === 0, 'PROTOCOL_ERROR');
  return value;
}

export function parseProofResponse(text: string, bindingId: string,
  sessionId: string): ProofResponse {
  const value: ProofResponse = JSON.parse(text) as ProofResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  verifyProof(value.proof, 'session_refresh', bindingId, sessionId);
  return value;
}

export function parseRefreshResponse(text: string, previous: SessionDto): RefreshResponse {
  const value: RefreshResponse = JSON.parse(text) as RefreshResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  validateSession(value.session);
  requireCondition(value.session.rotationCounter === previous.rotationCounter + 1, 'PROTOCOL_ERROR');
  requireCondition(value.session.id !== previous.id, 'PROTOCOL_ERROR');
  requireCondition(value.session.accessToken !== previous.accessToken, 'PROTOCOL_ERROR');
  requireCondition(value.session.refreshToken !== previous.refreshToken, 'PROTOCOL_ERROR');
  requireCondition(value.session.refreshExpiresAt === previous.refreshExpiresAt, 'PROTOCOL_ERROR');
  return value;
}

export function parseSummaryResponse(text: string): SummaryResponse {
  const value: SummaryResponse = JSON.parse(text) as SummaryResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(CHILD_ID_PATTERN.test(value.child.id), 'PROTOCOL_ERROR');
  requireCondition(validText(value.child.name, 1, 80), 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.points.balance), 'PROTOCOL_ERROR');
  return value;
}

export function parseTransactionsResponse(text: string): TransactionsResponse {
  const value: TransactionsResponse = JSON.parse(text) as TransactionsResponse;
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(Array.isArray(value.transactions), 'PROTOCOL_ERROR');
  requireCondition(value.transactions.length <= 50, 'PROTOCOL_ERROR');
  for (let index: number = 0; index < value.transactions.length; index += 1) {
    const item: TransactionDto = value.transactions[index];
    requireCondition(DATA_ID_PATTERN.test(item.id), 'PROTOCOL_ERROR');
    requireCondition(validTimestamp(item.occurredAt), 'PROTOCOL_ERROR');
    requireCondition(Number.isSafeInteger(item.amount) && item.amount !== 0, 'PROTOCOL_ERROR');
    requireCondition(validText(item.reason, 1, 300), 'PROTOCOL_ERROR');
    requireCondition(item.ruleId === null || DATA_ID_PATTERN.test(item.ruleId), 'PROTOCOL_ERROR');
    requireCondition(item.categoryId === null || DATA_ID_PATTERN.test(item.categoryId),
      'PROTOCOL_ERROR');
  }
  requireCondition(Number.isSafeInteger(value.page.limit) && value.page.limit >= 1
    && value.page.limit <= 50, 'PROTOCOL_ERROR');
  requireCondition(typeof value.page.hasMore === 'boolean', 'PROTOCOL_ERROR');
  requireCondition(value.page.nextCursor === null
    || isCanonicalBase64url(value.page.nextCursor, 69, 69), 'PROTOCOL_ERROR');
  requireCondition(value.page.hasMore === (value.page.nextCursor !== null), 'PROTOCOL_ERROR');
  return value;
}

export function parseApiErrorCode(text: string): string {
  try {
    const value: ApiErrorDto = JSON.parse(text) as ApiErrorDto;
    if (value.success === false && API_CODE_PATTERN.test(value.code)) {
      return value.code;
    }
  } catch (_) {
    return 'PROTOCOL_ERROR';
  }
  return 'PROTOCOL_ERROR';
}
