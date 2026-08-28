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
const CLIENT_REQUEST_ID_PATTERN: RegExp = /^[A-Za-z0-9._:-]{8,128}$/;
const POINT_REQUEST_ID_PATTERN: RegExp = /^point_request_[a-f0-9]{32}$/;

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

export interface RewardRuleDto {
  id: string;
  categoryId: string;
  categoryLabel: string;
  label: string;
  unit: string;
  minPoints: number;
  defaultPoints: number;
  maxPoints: number;
}

export interface RewardRulePageDto {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RewardRulesResponse {
  success: boolean;
  revision: number;
  rewardRules: Array<RewardRuleDto>;
  page: RewardRulePageDto;
}

export interface PointRequestCreateRequest {
  clientRequestId: string;
  ruleId: string;
  requestedPoints: number;
  description: string;
}

export interface PointRequestRuleDto {
  id: string;
  categoryId: string;
  label: string;
  categoryLabel: string;
  unit: string;
  minPoints: number;
  defaultPoints: number;
  maxPoints: number;
  revision: number;
}

export interface PointRequestInfoDto {
  note: string;
  requestedAt: string;
  resubmittedAt: string | null;
}

export interface PointRequestDecisionDto {
  note: string | null;
  reviewedAt: string;
  transactionId: string | null;
}

export interface PointRequestDto {
  id: string;
  status: string;
  revision: number;
  rule: PointRequestRuleDto;
  requestedPoints: number;
  approvedPoints: number | null;
  description: string;
  occurredAt: string;
  duplicateSuspected: boolean;
  requestInfo: PointRequestInfoDto | null;
  decision: PointRequestDecisionDto | null;
  submittedAt: string;
  updatedAt: string;
  clientRequestId?: string;
}

export interface PointRequestResponse {
  success: boolean;
  pointRequest: PointRequestDto;
}

export interface PointRequestsResponse {
  success: boolean;
  pointRequests: Array<PointRequestDto>;
  nextCursor: string | null;
}

export interface PointRequestOperationReconcileRequest {
  pointRequestId: string;
  expectedRevision: number;
  description?: string;
}

export interface PointRequestOperationResultDto {
  fromStatus: string;
  toStatus: string;
  resultRevision: number;
  recordedAt: string;
}

export interface PointRequestOperationObservationDto {
  completionEventObserved: boolean;
  noEffectProven: boolean;
  currentResourceStateIncluded: boolean;
  safeToClearLocalIntent: boolean;
  sameLogicalOperationMayUseNewIdempotencyKey: boolean;
  retryDisposition: string;
}

export interface PointRequestOperationDto {
  action: string;
  pointRequestId: string;
  status: string;
  observation: PointRequestOperationObservationDto;
  result: PointRequestOperationResultDto | null;
}

export interface PointRequestOperationResponse {
  success: boolean;
  pointRequestOperation: PointRequestOperationDto;
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

function exactKeys(value: Object, allowed: Array<string>): boolean {
  const keys: Array<string> = Object.keys(value);
  for (let index: number = 0; index < keys.length; index += 1) {
    if (allowed.indexOf(keys[index]) < 0) {
      return false;
    }
  }
  return true;
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

function validateRewardRule(value: RewardRuleDto): void {
  requireCondition(exactKeys(value as Object, [
    'id', 'categoryId', 'categoryLabel', 'label', 'unit',
    'minPoints', 'defaultPoints', 'maxPoints'
  ]), 'PROTOCOL_ERROR');
  requireCondition(DATA_ID_PATTERN.test(value.id), 'PROTOCOL_ERROR');
  requireCondition(DATA_ID_PATTERN.test(value.categoryId), 'PROTOCOL_ERROR');
  requireCondition(validText(value.categoryLabel, 1, 30), 'PROTOCOL_ERROR');
  requireCondition(validText(value.label, 1, 50), 'PROTOCOL_ERROR');
  requireCondition(validText(value.unit, 0, 20), 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.minPoints) && value.minPoints >= 0,
    'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.defaultPoints)
    && value.defaultPoints >= value.minPoints, 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.maxPoints)
    && value.maxPoints >= value.defaultPoints && value.maxPoints <= 1000
    && value.maxPoints > 0, 'PROTOCOL_ERROR');
}

export function parseRewardRulesResponse(text: string): RewardRulesResponse {
  const value: RewardRulesResponse = JSON.parse(text) as RewardRulesResponse;
  requireCondition(exactKeys(value as Object, [
    'success', 'revision', 'rewardRules', 'page'
  ]), 'PROTOCOL_ERROR');
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.revision) && value.revision >= 0,
    'PROTOCOL_ERROR');
  requireCondition(Array.isArray(value.rewardRules) && value.rewardRules.length <= 50,
    'PROTOCOL_ERROR');
  const ruleIds: Array<string> = [];
  for (let index: number = 0; index < value.rewardRules.length; index += 1) {
    validateRewardRule(value.rewardRules[index]);
    requireCondition(ruleIds.indexOf(value.rewardRules[index].id) < 0, 'PROTOCOL_ERROR');
    ruleIds.push(value.rewardRules[index].id);
  }
  requireCondition(exactKeys(value.page as Object, [
    'limit', 'hasMore', 'nextCursor'
  ]), 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.page.limit) && value.page.limit >= 1
    && value.page.limit <= 50, 'PROTOCOL_ERROR');
  requireCondition(value.rewardRules.length <= value.page.limit, 'PROTOCOL_ERROR');
  requireCondition(typeof value.page.hasMore === 'boolean', 'PROTOCOL_ERROR');
  requireCondition(value.page.nextCursor === null
    || isCanonicalBase64url(value.page.nextCursor, 30, 300), 'PROTOCOL_ERROR');
  requireCondition(value.page.hasMore === (value.page.nextCursor !== null), 'PROTOCOL_ERROR');
  return value;
}

export function parsePointRequestCreateRequest(text: string): PointRequestCreateRequest {
  const value: PointRequestCreateRequest = JSON.parse(text) as PointRequestCreateRequest;
  requireCondition(exactKeys(value as Object, [
    'clientRequestId', 'ruleId', 'requestedPoints', 'description'
  ]) && Object.keys(value as Object).length === 4, 'VALIDATION_ERROR');
  requireCondition(CLIENT_REQUEST_ID_PATTERN.test(value.clientRequestId), 'VALIDATION_ERROR');
  requireCondition(DATA_ID_PATTERN.test(value.ruleId), 'VALIDATION_ERROR');
  requireCondition(Number.isSafeInteger(value.requestedPoints)
    && value.requestedPoints >= 1 && value.requestedPoints <= 1000, 'VALIDATION_ERROR');
  requireCondition(validText(value.description, 1, 300), 'VALIDATION_ERROR');
  return value;
}

export function parsePointRequestOperationReconcileRequest(text: string,
  action: string): PointRequestOperationReconcileRequest {
  const value: PointRequestOperationReconcileRequest =
    JSON.parse(text) as PointRequestOperationReconcileRequest;
  const allowed: Array<string> = action === 'resubmit'
    ? ['pointRequestId', 'expectedRevision', 'description']
    : action === 'cancel'
      ? ['pointRequestId', 'expectedRevision']
      : [];
  requireCondition(allowed.length > 0 && exactKeys(value as Object, allowed)
    && Object.keys(value as Object).length === allowed.length, 'VALIDATION_ERROR');
  requireCondition(POINT_REQUEST_ID_PATTERN.test(value.pointRequestId), 'VALIDATION_ERROR');
  requireCondition(Number.isSafeInteger(value.expectedRevision)
    && value.expectedRevision >= 0 && value.expectedRevision < Number.MAX_SAFE_INTEGER,
  'VALIDATION_ERROR');
  if (action === 'resubmit') {
    requireCondition(value.description !== undefined
      && validText(value.description, 1, 300)
      && value.description === value.description.trim().normalize('NFC'), 'VALIDATION_ERROR');
  }
  return value;
}

function validatePointRequestRule(value: PointRequestRuleDto): void {
  requireCondition(exactKeys(value as Object, [
    'id', 'categoryId', 'label', 'categoryLabel', 'unit',
    'minPoints', 'defaultPoints', 'maxPoints', 'revision'
  ]), 'PROTOCOL_ERROR');
  validateRewardRule({
    id: value.id,
    categoryId: value.categoryId,
    categoryLabel: value.categoryLabel,
    label: value.label,
    unit: value.unit,
    minPoints: value.minPoints,
    defaultPoints: value.defaultPoints,
    maxPoints: value.maxPoints
  });
  requireCondition(Number.isSafeInteger(value.revision) && value.revision >= 0,
    'PROTOCOL_ERROR');
}

function validatePointRequest(value: PointRequestDto): void {
  requireCondition(exactKeys(value as Object, [
    'id', 'status', 'revision', 'rule', 'requestedPoints', 'approvedPoints',
    'description', 'occurredAt', 'duplicateSuspected', 'requestInfo', 'decision',
    'submittedAt', 'updatedAt', 'clientRequestId'
  ]), 'PROTOCOL_ERROR');
  requireCondition(POINT_REQUEST_ID_PATTERN.test(value.id), 'PROTOCOL_ERROR');
  requireCondition(['pending', 'needs_info', 'approved', 'rejected', 'cancelled']
    .indexOf(value.status) >= 0, 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(value.revision) && value.revision >= 0,
    'PROTOCOL_ERROR');
  validatePointRequestRule(value.rule);
  requireCondition(Number.isSafeInteger(value.requestedPoints)
    && value.requestedPoints >= 1 && value.requestedPoints <= 1000
    && value.requestedPoints >= value.rule.minPoints
    && value.requestedPoints <= value.rule.maxPoints, 'PROTOCOL_ERROR');
  requireCondition(value.approvedPoints === null
    || (Number.isSafeInteger(value.approvedPoints) && value.approvedPoints >= value.rule.minPoints
      && value.approvedPoints <= value.rule.maxPoints && value.approvedPoints > 0),
  'PROTOCOL_ERROR');
  requireCondition((value.status === 'approved') === (value.approvedPoints !== null),
    'PROTOCOL_ERROR');
  requireCondition(validText(value.description, 1, 300), 'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.occurredAt), 'PROTOCOL_ERROR');
  requireCondition(typeof value.duplicateSuspected === 'boolean', 'PROTOCOL_ERROR');
  if (value.requestInfo !== null) {
    requireCondition(exactKeys(value.requestInfo as Object, [
      'note', 'requestedAt', 'resubmittedAt'
    ]), 'PROTOCOL_ERROR');
    requireCondition(validText(value.requestInfo.note, 1, 300), 'PROTOCOL_ERROR');
    requireCondition(validTimestamp(value.requestInfo.requestedAt), 'PROTOCOL_ERROR');
    requireCondition(value.requestInfo.resubmittedAt === null
      || validTimestamp(value.requestInfo.resubmittedAt), 'PROTOCOL_ERROR');
  }
  if (value.decision !== null) {
    requireCondition(exactKeys(value.decision as Object, [
      'note', 'reviewedAt', 'transactionId'
    ]), 'PROTOCOL_ERROR');
    requireCondition(value.decision.note === null
      || validText(value.decision.note, 1, 300), 'PROTOCOL_ERROR');
    requireCondition(validTimestamp(value.decision.reviewedAt), 'PROTOCOL_ERROR');
    requireCondition(value.decision.transactionId === null
      || DATA_ID_PATTERN.test(value.decision.transactionId), 'PROTOCOL_ERROR');
    requireCondition((value.status === 'approved')
      === (value.decision.transactionId !== null), 'PROTOCOL_ERROR');
  }
  requireCondition(['approved', 'rejected'].indexOf(value.status) >= 0
    === (value.decision !== null), 'PROTOCOL_ERROR');
  requireCondition(validTimestamp(value.submittedAt) && validTimestamp(value.updatedAt),
    'PROTOCOL_ERROR');
  requireCondition(value.clientRequestId === undefined
    || CLIENT_REQUEST_ID_PATTERN.test(value.clientRequestId), 'PROTOCOL_ERROR');
}

export function parsePointRequestResponse(text: string,
  expectedClientRequestId: string): PointRequestResponse {
  const value: PointRequestResponse = JSON.parse(text) as PointRequestResponse;
  requireCondition(exactKeys(value as Object, ['success', 'pointRequest']), 'PROTOCOL_ERROR');
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  validatePointRequest(value.pointRequest);
  requireCondition(value.pointRequest.clientRequestId === expectedClientRequestId,
    'PROTOCOL_ERROR');
  return value;
}

export function parsePointRequestDetailResponse(text: string,
  expectedPointRequestId: string): PointRequestResponse {
  const value: PointRequestResponse = JSON.parse(text) as PointRequestResponse;
  requireCondition(exactKeys(value as Object, ['success', 'pointRequest']), 'PROTOCOL_ERROR');
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  validatePointRequest(value.pointRequest);
  requireCondition(value.pointRequest.id === expectedPointRequestId, 'PROTOCOL_ERROR');
  return value;
}

export function parsePointRequestOperationResponse(text: string, expectedAction: string,
  expectedRequest: PointRequestOperationReconcileRequest): PointRequestOperationResponse {
  const value: PointRequestOperationResponse = JSON.parse(text) as PointRequestOperationResponse;
  requireCondition(exactKeys(value as Object, ['success', 'pointRequestOperation'])
    && Object.keys(value as Object).length === 2, 'PROTOCOL_ERROR');
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  const operation: PointRequestOperationDto = value.pointRequestOperation;
  requireCondition(exactKeys(operation as Object, [
    'action', 'pointRequestId', 'status', 'observation', 'result'
  ]) && Object.keys(operation as Object).length === 5, 'PROTOCOL_ERROR');
  requireCondition((expectedAction === 'resubmit' || expectedAction === 'cancel')
    && operation.action === expectedAction, 'PROTOCOL_ERROR');
  requireCondition(POINT_REQUEST_ID_PATTERN.test(expectedRequest.pointRequestId)
    && operation.pointRequestId === expectedRequest.pointRequestId, 'PROTOCOL_ERROR');
  requireCondition(operation.status === 'not_observed' || operation.status === 'completed',
    'PROTOCOL_ERROR');
  const observation: PointRequestOperationObservationDto = operation.observation;
  requireCondition(exactKeys(observation as Object, [
    'completionEventObserved', 'noEffectProven', 'currentResourceStateIncluded',
    'safeToClearLocalIntent', 'sameLogicalOperationMayUseNewIdempotencyKey',
    'retryDisposition'
  ]) && Object.keys(observation as Object).length === 6, 'PROTOCOL_ERROR');
  requireCondition(observation.noEffectProven === false
    && observation.currentResourceStateIncluded === false
    && observation.sameLogicalOperationMayUseNewIdempotencyKey === false,
  'PROTOCOL_ERROR');
  if (operation.status === 'not_observed') {
    requireCondition(operation.result === null
      && observation.completionEventObserved === false
      && observation.safeToClearLocalIntent === false
      && observation.retryDisposition === 'retry_exact_original_only', 'PROTOCOL_ERROR');
    return value;
  }
  requireCondition(operation.result !== null
    && observation.completionEventObserved === true
    && observation.safeToClearLocalIntent === true
    && observation.retryDisposition === 'read_current_detail_do_not_repeat',
  'PROTOCOL_ERROR');
  const result: PointRequestOperationResultDto =
    operation.result as PointRequestOperationResultDto;
  requireCondition(exactKeys(result as Object, [
    'fromStatus', 'toStatus', 'resultRevision', 'recordedAt'
  ]) && Object.keys(result as Object).length === 4, 'PROTOCOL_ERROR');
  const transitionValid: boolean = expectedAction === 'resubmit'
    ? result.fromStatus === 'needs_info' && result.toStatus === 'pending'
    : (result.fromStatus === 'pending' || result.fromStatus === 'needs_info')
      && result.toStatus === 'cancelled';
  requireCondition(transitionValid, 'PROTOCOL_ERROR');
  requireCondition(Number.isSafeInteger(result.resultRevision)
    && result.resultRevision === expectedRequest.expectedRevision + 1
    && validTimestamp(result.recordedAt), 'PROTOCOL_ERROR');
  return value;
}

export function parsePointRequestsResponse(text: string): PointRequestsResponse {
  const value: PointRequestsResponse = JSON.parse(text) as PointRequestsResponse;
  requireCondition(exactKeys(value as Object, [
    'success', 'pointRequests', 'nextCursor'
  ]), 'PROTOCOL_ERROR');
  requireCondition(value.success === true, 'PROTOCOL_ERROR');
  requireCondition(Array.isArray(value.pointRequests) && value.pointRequests.length <= 50,
    'PROTOCOL_ERROR');
  const requestIds: Array<string> = [];
  for (let index: number = 0; index < value.pointRequests.length; index += 1) {
    validatePointRequest(value.pointRequests[index]);
    requireCondition(requestIds.indexOf(value.pointRequests[index].id) < 0, 'PROTOCOL_ERROR');
    requestIds.push(value.pointRequests[index].id);
  }
  requireCondition(value.nextCursor === null
    || isCanonicalBase64url(value.nextCursor, 30, 300), 'PROTOCOL_ERROR');
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
