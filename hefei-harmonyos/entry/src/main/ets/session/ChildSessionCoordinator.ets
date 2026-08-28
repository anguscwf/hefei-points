import { ChildApiError } from '../network/ApiClient';
import {
  ClaimPairingRequest,
  ClaimPairingResponse,
  DEVICE_KEY_ALGORITHM,
  PairingCompletionResponse,
  PointRequestCreateRequest,
  PointRequestDto,
  PointRequestResponse,
  PointRequestsResponse,
  ProofDto,
  ProofResponse,
  RefreshResponse,
  RewardRuleDto,
  RewardRulesResponse,
  SessionDto,
  SummaryResponse,
  TransactionDto,
  TransactionsResponse,
  VerifiedProof,
  verifyProof
} from '../network/ApiContracts';
import { newDevicePublicId, newIdempotencyKey } from '../security/SecureRandom';
import {
  activeEnvelope,
  copyEnvelope,
  EnvelopePhase,
  SessionEnvelope,
  sessionFromEnvelope,
  unpairedEnvelope
} from './SessionEnvelope';
import {
  bodyFromPointRequestIntent,
  copyPointRequestIntent,
  createPointRequestIntent,
  emptyPointRequestIntent,
  PointRequestIntent,
  PointRequestIntentPhase
} from './PointRequestIntent';

const DEVICE_ALIAS: string = 'HarmonyOS 手机';
const REFRESH_THRESHOLD_MS: number = 4 * 60 * 1000;

export interface DeviceIdentityPort {
  exists(): Promise<boolean>;
  create(): Promise<void>;
  publicKeyBase64url(): Promise<string>;
  signBase64url(payload: Uint8Array): Promise<string>;
}

export interface SessionVaultPort {
  load(): Promise<SessionEnvelope | null>;
  saveVerified(value: SessionEnvelope): Promise<SessionEnvelope>;
}

export interface PointRequestVaultPort {
  load(): Promise<PointRequestIntent | null>;
  saveVerified(value: PointRequestIntent): Promise<PointRequestIntent>;
}

export interface ChildApiPort {
  claimPairing(body: ClaimPairingRequest,
    idempotencyKey: string): Promise<ClaimPairingResponse>;
  completePairing(claimToken: string, signatureBase64url: string,
    idempotencyKey: string, devicePublicId: string,
    proofBindingId: string): Promise<PairingCompletionResponse>;
  issueRefreshChallenge(bindingId: string, session: SessionDto,
    idempotencyKey: string): Promise<ProofResponse>;
  refreshSession(previous: SessionDto, challengeId: string,
    signatureBase64url: string, idempotencyKey: string): Promise<RefreshResponse>;
  getSummary(accessToken: string): Promise<SummaryResponse>;
  getTransactions(accessToken: string, limit: number,
    cursor: string): Promise<TransactionsResponse>;
  getRewardRules(accessToken: string, limit: number,
    cursor: string): Promise<RewardRulesResponse>;
  createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse>;
  getPointRequests(accessToken: string, limit: number,
    cursor: string): Promise<PointRequestsResponse>;
  getPointRequest(accessToken: string,
    pointRequestId: string): Promise<PointRequestResponse>;
}

export interface DeviceProofVerifierPort {
  verify(value: ProofDto, expectedPurpose: string,
    expectedBindingId: string, expectedSessionId: string): VerifiedProof;
}

export class StrictDeviceProofVerifier implements DeviceProofVerifierPort {
  verify(value: ProofDto, expectedPurpose: string,
    expectedBindingId: string, expectedSessionId: string): VerifiedProof {
    return verifyProof(value, expectedPurpose, expectedBindingId, expectedSessionId);
  }
}

export interface SecureIdPort {
  devicePublicId(): string;
  idempotencyKey(operation: string): string;
}

export class StrictSecureIdGenerator implements SecureIdPort {
  devicePublicId(): string {
    return newDevicePublicId();
  }

  idempotencyKey(operation: string): string {
    return newIdempotencyKey(operation);
  }
}

function stableErrorCode(error: Object): string {
  if (error instanceof ChildApiError) {
    return error.outcomeUnknown ? 'RESULT_UNKNOWN' : error.code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) {
    return error.message;
  }
  return 'LOCAL_SECURITY_ERROR';
}

function throwableError(error: Object): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error('LOCAL_SECURITY_ERROR');
}

export class ChildSessionCoordinator {
  private readonly api: ChildApiPort;
  private readonly identity: DeviceIdentityPort;
  private readonly vault: SessionVaultPort;
  private readonly pointVault: PointRequestVaultPort;
  private readonly proofVerifier: DeviceProofVerifierPort;
  private readonly secureIds: SecureIdPort;
  private envelope: SessionEnvelope | null = null;
  private pointIntent: PointRequestIntent | null = null;
  private summaryValue: SummaryResponse | null = null;
  private transactionValues: Array<TransactionDto> = [];
  private nextCursorValue: string = '';
  private rewardRuleValues: Array<RewardRuleDto> = [];
  private rewardRuleRevisionValue: number = -1;
  private nextRewardRuleCursorValue: string = '';
  private pointRequestValues: Array<PointRequestDto> = [];
  private nextPointRequestCursorValue: string = '';
  private pointRequestDetailValue: PointRequestDto | null = null;
  private pointRequestDetailGeneration: number = 0;
  private operationGeneration: number = 0;
  private busyValue: boolean = false;
  private lockedValue: boolean = false;
  private statusCodeValue: string = 'BOOT';

  constructor(api: ChildApiPort, identity: DeviceIdentityPort, vault: SessionVaultPort,
    pointVault: PointRequestVaultPort, proofVerifier: DeviceProofVerifierPort,
    secureIds: SecureIdPort) {
    this.api = api;
    this.identity = identity;
    this.vault = vault;
    this.pointVault = pointVault;
    this.proofVerifier = proofVerifier;
    this.secureIds = secureIds;
  }

  get busy(): boolean {
    return this.busyValue;
  }

  get locked(): boolean {
    return this.lockedValue;
  }

  get statusCode(): string {
    return this.statusCodeValue;
  }

  get phase(): string {
    return this.envelope ? this.envelope.phase : 'BOOT';
  }

  get childName(): string {
    return this.summaryValue ? this.summaryValue.child.name : '';
  }

  get balance(): number {
    return this.summaryValue ? this.summaryValue.points.balance : 0;
  }

  get hasSummary(): boolean {
    return this.summaryValue !== null;
  }

  get transactions(): Array<TransactionDto> {
    return this.transactionValues.slice();
  }

  get hasMoreTransactions(): boolean {
    return this.nextCursorValue.length > 0;
  }

  get rewardRules(): Array<RewardRuleDto> {
    return this.rewardRuleValues.slice();
  }

  get hasMoreRewardRules(): boolean {
    return this.nextRewardRuleCursorValue.length > 0;
  }

  get pointRequests(): Array<PointRequestDto> {
    return this.pointRequestValues.slice();
  }

  get hasMorePointRequests(): boolean {
    return this.nextPointRequestCursorValue.length > 0;
  }

  get pointRequestDetail(): PointRequestDto | null {
    return this.pointRequestDetailValue;
  }

  get pointRequestPending(): boolean {
    return this.pointIntent !== null
      && this.pointIntent.phase === PointRequestIntentPhase.CREATE_INTENT;
  }

  private clearBusinessView(): void {
    this.summaryValue = null;
    this.transactionValues = [];
    this.nextCursorValue = '';
    this.rewardRuleValues = [];
    this.rewardRuleRevisionValue = -1;
    this.nextRewardRuleCursorValue = '';
    this.pointRequestValues = [];
    this.nextPointRequestCursorValue = '';
    this.pointRequestDetailGeneration += 1;
    this.pointRequestDetailValue = null;
  }

  lockForBackground(): void {
    this.operationGeneration += 1;
    this.clearBusinessView();
    this.statusCodeValue = 'BACKGROUND_LOCKED';
  }

  async initialize(): Promise<void> {
    if (this.busyValue) {
      return;
    }
    this.busyValue = true;
    this.clearBusinessView();
    try {
      const stored: SessionEnvelope | null = await this.vault.load();
      const storedPointIntent: PointRequestIntent | null = await this.pointVault.load();
      const keyExists: boolean = await this.identity.exists();
      if (stored === null) {
        if (keyExists) {
          throw new Error('LOCAL_STATE_CORRUPT');
        }
        await this.identity.create();
        this.envelope = await this.vault.saveVerified(
          unpairedEnvelope(this.secureIds.devicePublicId())
        );
      } else {
        if (!keyExists) {
          throw new Error('DEVICE_KEY_MISSING');
        }
        await this.identity.publicKeyBase64url();
        this.envelope = stored;
      }
      this.pointIntent = storedPointIntent === null
        ? await this.pointVault.saveVerified(emptyPointRequestIntent())
        : storedPointIntent;
      this.assertPointIntentBinding();
      this.lockedValue = false;
      this.statusCodeValue = this.statusForPhase();
    } catch (error) {
      this.lockedValue = true;
      this.statusCodeValue = stableErrorCode(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  private statusForPhase(): string {
    if (!this.envelope) {
      return 'BOOT';
    }
    if (this.envelope.phase === EnvelopePhase.UNPAIRED) {
      return 'UNPAIRED';
    }
    if (this.envelope.phase === EnvelopePhase.CLAIM_INTENT) {
      return 'CLAIM_RESULT_UNKNOWN';
    }
    if (this.envelope.phase === EnvelopePhase.WAITING_GUARDIAN) {
      return 'WAITING_GUARDIAN';
    }
    if (this.envelope.phase === EnvelopePhase.COMPLETE_RESULT_UNKNOWN) {
      return 'RESULT_UNKNOWN';
    }
    if (this.envelope.phase === EnvelopePhase.REFRESH_ISSUE_INTENT
        || this.envelope.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
      return 'SESSION_RECOVERY_REQUIRED';
    }
    if (this.pointRequestPending) {
      return 'POINT_REQUEST_RESULT_UNKNOWN';
    }
    return 'READY';
  }

  private assertPointIntentBinding(): void {
    if (!this.pointRequestPending) {
      return;
    }
    const current: SessionEnvelope = this.requireEnvelope();
    if (current.phase !== EnvelopePhase.ACTIVE
        && current.phase !== EnvelopePhase.REFRESH_ISSUE_INTENT
        && current.phase !== EnvelopePhase.REFRESH_COMPLETE_INTENT) {
      throw new Error('LOCAL_POINT_INTENT_SCOPE_MISMATCH');
    }
    if (!this.pointIntent || this.pointIntent.bindingId !== current.bindingId) {
      throw new Error('LOCAL_POINT_INTENT_SCOPE_MISMATCH');
    }
  }

  private requireEnvelope(): SessionEnvelope {
    if (!this.envelope || this.lockedValue) {
      throw new Error('LOCAL_STATE_UNAVAILABLE');
    }
    return this.envelope;
  }

  private async commit(next: SessionEnvelope): Promise<SessionEnvelope> {
    const current: SessionEnvelope = this.requireEnvelope();
    next.revision = current.revision;
    const committed: SessionEnvelope = await this.vault.saveVerified(next);
    this.envelope = committed;
    return committed;
  }

  private requirePointIntent(): PointRequestIntent {
    if (!this.pointIntent || this.lockedValue) {
      throw new Error('LOCAL_POINT_INTENT_UNAVAILABLE');
    }
    return this.pointIntent;
  }

  private async commitPointIntent(next: PointRequestIntent): Promise<PointRequestIntent> {
    const current: PointRequestIntent = this.requirePointIntent();
    next.revision = current.revision;
    const committed: PointRequestIntent = await this.pointVault.saveVerified(next);
    this.pointIntent = committed;
    return committed;
  }

  private async clearPointIntent(): Promise<void> {
    const current: PointRequestIntent = this.requirePointIntent();
    if (current.phase === PointRequestIntentPhase.EMPTY) {
      return;
    }
    const empty: PointRequestIntent = emptyPointRequestIntent();
    empty.revision = current.revision;
    await this.commitPointIntent(empty);
  }

  private async resetToUnpaired(): Promise<void> {
    const current: SessionEnvelope = this.requireEnvelope();
    await this.clearPointIntent();
    const next: SessionEnvelope = unpairedEnvelope(current.devicePublicId);
    next.revision = current.revision;
    this.envelope = await this.vault.saveVerified(next);
    this.clearBusinessView();
  }

  private async handleFailure(error: Object, pairingOperation: boolean = false): Promise<void> {
    const code: string = stableErrorCode(error);
    if (code.startsWith('LOCAL_POINT_INTENT_')
        || code === 'POINT_REQUEST_RECONCILIATION_CONFLICT') {
      this.clearBusinessView();
      this.lockedValue = true;
      this.statusCodeValue = code;
      return;
    }
    if (code === 'FEATURE_DISABLED' || code === 'CHILD_PROCESSING_BLOCKED'
        || code === 'CHILD_DATA_INCOMPLETE') {
      this.clearBusinessView();
      this.statusCodeValue = code;
      return;
    }
    if (code === 'SESSION_REVOKED' || code === 'CONSENT_REQUIRED'
        || (pairingOperation && (code === 'PAIRING_CODE_INVALID'
          || code === 'PAIRING_CLAIM_INVALID'
          || code === 'PAIRING_EXPIRED' || code === 'CHALLENGE_EXPIRED'))) {
      try {
        await this.resetToUnpaired();
        this.statusCodeValue = code;
        return;
      } catch (resetError) {
        this.lockedValue = true;
        const resetCode: string = stableErrorCode(resetError as Object);
        this.statusCodeValue = resetCode.startsWith('LOCAL_POINT_INTENT_')
          ? resetCode : 'LOCAL_STATE_COMMIT_FAILED';
        return;
      }
    }
    this.statusCodeValue = code;
  }

  async beginPairing(shortCode: string): Promise<void> {
    if (this.busyValue || this.lockedValue) {
      return;
    }
    this.busyValue = true;
    try {
      const current: SessionEnvelope = this.requireEnvelope();
      if (current.phase !== EnvelopePhase.UNPAIRED || !/^\d{6}$/.test(shortCode)) {
        throw new Error('VALIDATION_ERROR');
      }
      const intent: SessionEnvelope = copyEnvelope(current);
      intent.phase = EnvelopePhase.CLAIM_INTENT;
      intent.claimShortCode = shortCode;
      intent.claimIdempotencyKey = this.secureIds.idempotencyKey('pair-claim');
      await this.commit(intent);
      await this.continuePairingClaimInternal();
    } catch (error) {
      await this.handleFailure(error as Object, true);
    } finally {
      this.busyValue = false;
    }
  }

  async continuePendingAction(): Promise<void> {
    if (this.busyValue || this.lockedValue) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    let pairingOperation: boolean = false;
    try {
      let current: SessionEnvelope = this.requireEnvelope();
      if (current.phase === EnvelopePhase.CLAIM_INTENT) {
        pairingOperation = true;
        await this.continuePairingClaimInternal();
      } else if (current.phase === EnvelopePhase.WAITING_GUARDIAN
          || current.phase === EnvelopePhase.COMPLETE_RESULT_UNKNOWN) {
        pairingOperation = true;
        await this.completePairingInternal();
      } else if (current.phase === EnvelopePhase.REFRESH_ISSUE_INTENT
          || current.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
        await this.ensureFreshSessionInternal(true);
        current = this.requireEnvelope();
        if (this.pointRequestPending) {
          const recovered: PointRequestDto | null = await this.sendPointRequestIntent();
          if (generation === this.operationGeneration) {
            this.applyRecoveredPointRequest(recovered);
          }
        } else if (generation === this.operationGeneration) {
          this.statusCodeValue = 'READY';
        }
      } else if (current.phase === EnvelopePhase.ACTIVE && this.pointRequestPending) {
        const recovered: PointRequestDto | null = await this.sendPointRequestIntent();
        if (generation === this.operationGeneration) {
          this.applyRecoveredPointRequest(recovered);
        }
      } else {
        throw new Error('LOCAL_STATE_CONFLICT');
      }
    } catch (error) {
      await this.handleFailure(error as Object, pairingOperation);
    } finally {
      this.busyValue = false;
    }
  }

  private async continuePairingClaimInternal(): Promise<void> {
    const current: SessionEnvelope = this.requireEnvelope();
    if (current.phase !== EnvelopePhase.CLAIM_INTENT) {
      throw new Error('LOCAL_STATE_CONFLICT');
    }
    const publicKey: string = await this.identity.publicKeyBase64url();
    const body: ClaimPairingRequest = {
      shortCode: current.claimShortCode,
      devicePublicId: current.devicePublicId,
      deviceAlias: DEVICE_ALIAS,
      publicKey: {
        algorithm: DEVICE_KEY_ALGORITHM,
        spkiBase64url: publicKey
      }
    };
    const response: ClaimPairingResponse = await this.api.claimPairing(
      body,
      current.claimIdempotencyKey
    );
    const proof: VerifiedProof = this.proofVerifier.verify(
      response.proof,
      'pairing_completion',
      '',
      ''
    );
    const signature: string = await this.identity.signBase64url(proof.payload);
    const next: SessionEnvelope = copyEnvelope(current);
    next.phase = EnvelopePhase.WAITING_GUARDIAN;
    next.claimShortCode = '';
    next.claimIdempotencyKey = '';
    next.claimToken = response.claimId;
    next.proofExpiresAt = response.proof.expiresAt;
    next.proofBindingId = proof.bindingId;
    next.completeSignature = signature;
    next.completeIdempotencyKey = this.secureIds.idempotencyKey('pair-complete');
    await this.commit(next);
    this.statusCodeValue = 'WAITING_GUARDIAN';
  }

  private async completePairingInternal(): Promise<void> {
    const current: SessionEnvelope = this.requireEnvelope();
    if (current.phase !== EnvelopePhase.WAITING_GUARDIAN
        && current.phase !== EnvelopePhase.COMPLETE_RESULT_UNKNOWN) {
      throw new Error('LOCAL_STATE_CONFLICT');
    }
    try {
      const response: PairingCompletionResponse = await this.api.completePairing(
        current.claimToken,
        current.completeSignature,
        current.completeIdempotencyKey,
        current.devicePublicId,
        current.proofBindingId
      );
      const next: SessionEnvelope = activeEnvelope(
        current.devicePublicId,
        response.device.id,
        response.session
      );
      next.revision = current.revision;
      await this.commit(next);
      this.statusCodeValue = 'READY';
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'PAIRING_STATE_CONFLICT') {
        this.statusCodeValue = 'WAITING_GUARDIAN';
        return;
      }
      if (error instanceof ChildApiError && error.outcomeUnknown) {
        const unknown: SessionEnvelope = copyEnvelope(current);
        unknown.phase = EnvelopePhase.COMPLETE_RESULT_UNKNOWN;
        await this.commit(unknown);
      }
      throw throwableError(error as Object);
    }
  }

  private async beginRefreshIntent(): Promise<SessionEnvelope> {
    const current: SessionEnvelope = this.requireEnvelope();
    if (current.phase !== EnvelopePhase.ACTIVE) {
      throw new Error('LOCAL_STATE_CONFLICT');
    }
    const next: SessionEnvelope = copyEnvelope(current);
    next.phase = EnvelopePhase.REFRESH_ISSUE_INTENT;
    next.refreshIssueIdempotencyKey = this.secureIds.idempotencyKey('refresh-issue');
    return this.commit(next);
  }

  private async issueRefreshInternal(current: SessionEnvelope): Promise<SessionEnvelope> {
    const session: SessionDto = sessionFromEnvelope(current);
    try {
      const response: ProofResponse = await this.api.issueRefreshChallenge(
        current.bindingId,
        session,
        current.refreshIssueIdempotencyKey
      );
      const proof: VerifiedProof = this.proofVerifier.verify(
        response.proof,
        'session_refresh',
        current.bindingId,
        current.sessionId
      );
      const signature: string = await this.identity.signBase64url(proof.payload);
      const next: SessionEnvelope = copyEnvelope(current);
      next.phase = EnvelopePhase.REFRESH_COMPLETE_INTENT;
      next.refreshIssueIdempotencyKey = '';
      next.refreshChallengeId = response.proof.challengeId;
      next.refreshProofExpiresAt = response.proof.expiresAt;
      next.refreshSignature = signature;
      next.refreshCompleteIdempotencyKey = this.secureIds.idempotencyKey('refresh-complete');
      return this.commit(next);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'REFRESH_TOO_EARLY'
          && Date.parse(current.accessExpiresAt) > Date.now()) {
        const active: SessionEnvelope = copyEnvelope(current);
        active.phase = EnvelopePhase.ACTIVE;
        active.refreshIssueIdempotencyKey = '';
        return this.commit(active);
      }
      if (error instanceof ChildApiError && error.code === 'CHALLENGE_EXPIRED') {
        await this.restartRefreshIssue(current);
        throw new Error('SESSION_RECOVERY_REQUIRED');
      }
      throw throwableError(error as Object);
    }
  }

  private async restartRefreshIssue(current: SessionEnvelope): Promise<void> {
    const next: SessionEnvelope = copyEnvelope(current);
    next.phase = EnvelopePhase.REFRESH_ISSUE_INTENT;
    next.refreshIssueIdempotencyKey = this.secureIds.idempotencyKey('refresh-issue');
    next.refreshChallengeId = '';
    next.refreshProofExpiresAt = '';
    next.refreshSignature = '';
    next.refreshCompleteIdempotencyKey = '';
    await this.commit(next);
  }

  private async finishRefreshInternal(current: SessionEnvelope): Promise<SessionEnvelope> {
    const previous: SessionDto = sessionFromEnvelope(current);
    try {
      const response: RefreshResponse = await this.api.refreshSession(
        previous,
        current.refreshChallengeId,
        current.refreshSignature,
        current.refreshCompleteIdempotencyKey
      );
      const next: SessionEnvelope = activeEnvelope(
        current.devicePublicId,
        current.bindingId,
        response.session
      );
      next.revision = current.revision;
      return this.commit(next);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'CHALLENGE_EXPIRED') {
        await this.restartRefreshIssue(current);
        throw new Error('SESSION_RECOVERY_REQUIRED');
      }
      throw throwableError(error as Object);
    }
  }

  private async ensureFreshSessionInternal(force: boolean = false): Promise<SessionDto> {
    let current: SessionEnvelope = this.requireEnvelope();
    if (current.phase === EnvelopePhase.ACTIVE) {
      const accessRemaining: number = Date.parse(current.accessExpiresAt) - Date.now();
      if (!force && accessRemaining > REFRESH_THRESHOLD_MS) {
        return sessionFromEnvelope(current);
      }
      current = await this.beginRefreshIntent();
    }
    if (current.phase === EnvelopePhase.REFRESH_ISSUE_INTENT) {
      current = await this.issueRefreshInternal(current);
      if (current.phase === EnvelopePhase.ACTIVE) {
        return sessionFromEnvelope(current);
      }
    }
    if (current.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
      current = await this.finishRefreshInternal(current);
      return sessionFromEnvelope(current);
    }
    throw new Error('SESSION_RECOVERY_REQUIRED');
  }

  private async summaryWithOneRefresh(): Promise<SummaryResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.api.getSummary(session.accessToken);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.api.getSummary(session.accessToken);
      }
      throw throwableError(error as Object);
    }
  }

  private async transactionsWithOneRefresh(cursor: string): Promise<TransactionsResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.api.getTransactions(session.accessToken, 20, cursor);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.api.getTransactions(session.accessToken, 20, cursor);
      }
      throw throwableError(error as Object);
    }
  }

  private async rewardRulesWithOneRefresh(cursor: string): Promise<RewardRulesResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.api.getRewardRules(session.accessToken, 50, cursor);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.api.getRewardRules(session.accessToken, 50, cursor);
      }
      throw throwableError(error as Object);
    }
  }

  private async pointRequestsWithOneRefresh(cursor: string,
    limit: number = 20): Promise<PointRequestsResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.api.getPointRequests(session.accessToken, limit, cursor);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.api.getPointRequests(session.accessToken, limit, cursor);
      }
      throw throwableError(error as Object);
    }
  }

  private async pointRequestDetailWithOneRefresh(
    pointRequestId: string): Promise<PointRequestResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.api.getPointRequest(session.accessToken, pointRequestId);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.api.getPointRequest(session.accessToken, pointRequestId);
      }
      throw throwableError(error as Object);
    }
  }

  private samePointRequestIdentity(current: PointRequestDto,
    latest: PointRequestDto): boolean {
    return current.id === latest.id
      && current.rule.id === latest.rule.id
      && current.rule.categoryId === latest.rule.categoryId
      && current.rule.label === latest.rule.label
      && current.rule.categoryLabel === latest.rule.categoryLabel
      && current.rule.unit === latest.rule.unit
      && current.rule.minPoints === latest.rule.minPoints
      && current.rule.defaultPoints === latest.rule.defaultPoints
      && current.rule.maxPoints === latest.rule.maxPoints
      && current.rule.revision === latest.rule.revision
      && current.requestedPoints === latest.requestedPoints
      && current.occurredAt === latest.occurredAt
      && current.duplicateSuspected === latest.duplicateSuspected
      && current.submittedAt === latest.submittedAt
      && current.clientRequestId === latest.clientRequestId;
  }

  private assertPointRequestDetailAdvance(current: PointRequestDto,
    latest: PointRequestDto): void {
    if (!this.samePointRequestIdentity(current, latest)
        || latest.revision < current.revision) {
      throw new Error('PROTOCOL_ERROR');
    }
    if (latest.revision === current.revision) {
      if (latest.status !== current.status
          || latest.approvedPoints !== current.approvedPoints
          || latest.description !== current.description
          || latest.updatedAt !== current.updatedAt
          || JSON.stringify(latest.requestInfo) !== JSON.stringify(current.requestInfo)
          || JSON.stringify(latest.decision) !== JSON.stringify(current.decision)) {
        throw new Error('PROTOCOL_ERROR');
      }
      return;
    }
    if (current.status === 'approved' || current.status === 'rejected'
        || current.status === 'cancelled' || latest.updatedAt <= current.updatedAt) {
      throw new Error('PROTOCOL_ERROR');
    }
  }

  private pointRequestMatchesIntent(value: PointRequestDto,
    body: PointRequestCreateRequest): boolean {
    return value.clientRequestId === body.clientRequestId
      && value.rule.id === body.ruleId
      && value.requestedPoints === body.requestedPoints
      && value.description === body.description;
  }

  private async createPointRequestWithOneRefresh(
    intent: PointRequestIntent): Promise<PointRequestResponse> {
    let session: SessionDto = await this.ensureFreshSessionInternal(false);
    try {
      return await this.dispatchPointRequest(
        session.accessToken, intent.bodyJson, intent.idempotencyKey
      );
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'ACCESS_TOKEN_EXPIRED') {
        session = await this.ensureFreshSessionInternal(true);
        return this.dispatchPointRequest(
          session.accessToken, intent.bodyJson, intent.idempotencyKey
        );
      }
      throw throwableError(error as Object);
    }
  }

  private async dispatchPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    try {
      return await this.api.createPointRequest(accessToken, bodyJson, idempotencyKey);
    } catch (error) {
      if (error instanceof ChildApiError && error.code === 'IDEMPOTENCY_REPLAY_STALE') {
        throw new ChildApiError('POINT_REQUEST_REPLAY_STALE', error.status, false, false);
      }
      throw throwableError(error as Object);
    }
  }

  private preservePointIntent(error: ChildApiError): boolean {
    return error.outcomeUnknown || error.transient
      || error.code === 'FEATURE_DISABLED'
      || error.code === 'LOCAL_ENVIRONMENT_DISABLED'
      || error.code === 'CHILD_PROCESSING_BLOCKED'
      || error.code === 'CHILD_DATA_INCOMPLETE'
      || error.code === 'PROTOCOL_ERROR'
      || error.code === 'ACCESS_TOKEN_EXPIRED';
  }

  private async sendPointRequestIntent(): Promise<PointRequestDto | null> {
    this.assertPointIntentBinding();
    const intent: PointRequestIntent = copyPointRequestIntent(this.requirePointIntent());
    const body: PointRequestCreateRequest = bodyFromPointRequestIntent(intent);
    let createAttempted: boolean = false;
    try {
      const mine: PointRequestsResponse = await this.pointRequestsWithOneRefresh('', 50);
      const matching: PointRequestDto | undefined = mine.pointRequests.find(
        (value: PointRequestDto) => value.clientRequestId === body.clientRequestId
      );
      if (matching !== undefined) {
        if (!this.pointRequestMatchesIntent(matching, body)) {
          throw new Error('POINT_REQUEST_RECONCILIATION_CONFLICT');
        }
        await this.clearPointIntent();
        return matching;
      }

      createAttempted = true;
      const response: PointRequestResponse = await this.createPointRequestWithOneRefresh(intent);
      if (!this.pointRequestMatchesIntent(response.pointRequest, body)) {
        throw new Error('POINT_REQUEST_RECONCILIATION_CONFLICT');
      }
      await this.clearPointIntent();
      return response.pointRequest;
    } catch (error) {
      if (error instanceof ChildApiError
          && (error.code === 'IDEMPOTENCY_CONFLICT'
            || error.code === 'IDEMPOTENCY_RESULT_UNAVAILABLE')) {
        throw new Error('POINT_REQUEST_RECONCILIATION_CONFLICT');
      }
      if (error instanceof ChildApiError && error.code === 'POINT_REQUEST_REPLAY_STALE') {
        await this.clearPointIntent();
        return null;
      }
      if (error instanceof ChildApiError && createAttempted
          && !this.preservePointIntent(error)) {
        await this.clearPointIntent();
      }
      throw throwableError(error as Object);
    }
  }

  private applyRecoveredPointRequest(value: PointRequestDto | null): void {
    if (value !== null) {
      this.pointRequestValues = [value].concat(
        this.pointRequestValues.filter((item: PointRequestDto) => item.id !== value.id)
      );
      this.statusCodeValue = 'POINT_REQUEST_SUBMITTED';
    } else {
      this.statusCodeValue = 'POINT_REQUEST_RECONCILED';
    }
  }

  async submitPointRequest(ruleId: string, requestedPoints: number,
    description: string): Promise<void> {
    if (this.busyValue || this.lockedValue || this.pointRequestPending) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    try {
      const rule: RewardRuleDto | undefined = this.rewardRuleValues.find(
        (value: RewardRuleDto) => value.id === ruleId
      );
      const normalizedDescription: string = description.trim().normalize('NFC');
      if (rule === undefined || !Number.isSafeInteger(requestedPoints)
          || requestedPoints < rule.minPoints || requestedPoints > rule.maxPoints
          || requestedPoints <= 0 || normalizedDescription.length < 1
          || normalizedDescription.length > 120
          || /[\u0000-\u001f\u007f]/.test(normalizedDescription)) {
        throw new Error('VALIDATION_ERROR');
      }
      await this.ensureFreshSessionInternal(false);
      const current: SessionEnvelope = this.requireEnvelope();
      if (current.phase !== EnvelopePhase.ACTIVE) {
        throw new Error('SESSION_RECOVERY_REQUIRED');
      }
      const body: PointRequestCreateRequest = {
        clientRequestId: this.secureIds.idempotencyKey('point-client'),
        ruleId: rule.id,
        requestedPoints,
        description: normalizedDescription
      };
      const intent: PointRequestIntent = createPointRequestIntent(
        current.bindingId,
        body,
        this.secureIds.idempotencyKey('point-create')
      );
      intent.revision = this.requirePointIntent().revision;
      await this.commitPointIntent(intent);
      const created: PointRequestDto | null = await this.sendPointRequestIntent();
      if (generation !== this.operationGeneration) {
        return;
      }
      this.applyRecoveredPointRequest(created);
    } catch (error) {
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  async refreshSelf(): Promise<void> {
    if (this.busyValue || this.lockedValue) {
      return;
    }
    this.busyValue = true;
    this.pointRequestDetailGeneration += 1;
    this.pointRequestDetailValue = null;
    const generation: number = this.operationGeneration;
    try {
      const current: SessionEnvelope = this.requireEnvelope();
      if (current.phase !== EnvelopePhase.ACTIVE
          && current.phase !== EnvelopePhase.REFRESH_ISSUE_INTENT
          && current.phase !== EnvelopePhase.REFRESH_COMPLETE_INTENT) {
        throw new Error('PAIRING_REQUIRED');
      }
      if (this.pointRequestPending) {
        throw new Error('POINT_REQUEST_RECOVERY_REQUIRED');
      }
      const summary: SummaryResponse = await this.summaryWithOneRefresh();
      const transactions: TransactionsResponse = await this.transactionsWithOneRefresh('');
      const rewardRules: RewardRulesResponse = await this.rewardRulesWithOneRefresh('');
      const pointRequests: PointRequestsResponse = await this.pointRequestsWithOneRefresh('');
      if (generation !== this.operationGeneration) {
        return;
      }
      this.summaryValue = summary;
      this.transactionValues = transactions.transactions;
      this.nextCursorValue = transactions.page.nextCursor === null
        ? '' : transactions.page.nextCursor;
      this.rewardRuleValues = rewardRules.rewardRules;
      this.rewardRuleRevisionValue = rewardRules.revision;
      this.nextRewardRuleCursorValue = rewardRules.page.nextCursor === null
        ? '' : rewardRules.page.nextCursor;
      this.pointRequestValues = pointRequests.pointRequests;
      this.nextPointRequestCursorValue = pointRequests.nextCursor === null
        ? '' : pointRequests.nextCursor;
      this.statusCodeValue = 'READY';
    } catch (error) {
      this.clearBusinessView();
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  async loadMoreTransactions(): Promise<void> {
    if (this.busyValue || this.lockedValue || this.nextCursorValue.length === 0) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    const cursor: string = this.nextCursorValue;
    try {
      const response: TransactionsResponse = await this.transactionsWithOneRefresh(cursor);
      if (generation !== this.operationGeneration) {
        return;
      }
      this.transactionValues = this.transactionValues.concat(response.transactions);
      this.nextCursorValue = response.page.nextCursor === null ? '' : response.page.nextCursor;
      this.statusCodeValue = 'READY';
    } catch (error) {
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  async loadMoreRewardRules(): Promise<void> {
    if (this.busyValue || this.lockedValue || this.nextRewardRuleCursorValue.length === 0) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    const cursor: string = this.nextRewardRuleCursorValue;
    try {
      let response: RewardRulesResponse;
      try {
        response = await this.rewardRulesWithOneRefresh(cursor);
        if (response.revision !== this.rewardRuleRevisionValue) {
          throw new ChildApiError('REWARD_RULES_CHANGED', 409, false, false);
        }
      } catch (error) {
        if (!(error instanceof ChildApiError) || error.code !== 'REWARD_RULES_CHANGED') {
          throw throwableError(error as Object);
        }
        response = await this.rewardRulesWithOneRefresh('');
        this.rewardRuleValues = [];
      }
      if (generation !== this.operationGeneration) {
        return;
      }
      this.rewardRuleValues = this.rewardRuleValues.concat(response.rewardRules);
      this.rewardRuleRevisionValue = response.revision;
      this.nextRewardRuleCursorValue = response.page.nextCursor === null
        ? '' : response.page.nextCursor;
      this.statusCodeValue = 'READY';
    } catch (error) {
      this.rewardRuleValues = [];
      this.rewardRuleRevisionValue = -1;
      this.nextRewardRuleCursorValue = '';
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  async loadMorePointRequests(): Promise<void> {
    if (this.busyValue || this.lockedValue || this.nextPointRequestCursorValue.length === 0) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    const cursor: string = this.nextPointRequestCursorValue;
    try {
      const response: PointRequestsResponse = await this.pointRequestsWithOneRefresh(cursor);
      if (generation !== this.operationGeneration) {
        return;
      }
      this.pointRequestValues = this.pointRequestValues.concat(response.pointRequests);
      this.nextPointRequestCursorValue = response.nextCursor === null
        ? '' : response.nextCursor;
      this.statusCodeValue = 'READY';
    } catch (error) {
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  async loadPointRequestDetail(pointRequestId: string): Promise<void> {
    if (this.busyValue || this.lockedValue || this.pointRequestPending) {
      return;
    }
    this.pointRequestDetailGeneration += 1;
    const detailGeneration: number = this.pointRequestDetailGeneration;
    this.pointRequestDetailValue = null;
    const visible: Array<PointRequestDto> = this.pointRequestValues.filter(
      (value: PointRequestDto) => value.id === pointRequestId
    );
    if (!/^point_request_[a-f0-9]{32}$/.test(pointRequestId) || visible.length !== 1) {
      this.statusCodeValue = 'LOCAL_REQUEST_INVALID';
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    try {
      const response: PointRequestResponse = await this.pointRequestDetailWithOneRefresh(
        pointRequestId
      );
      if (generation !== this.operationGeneration
          || detailGeneration !== this.pointRequestDetailGeneration) {
        return;
      }
      const currentVisible: Array<PointRequestDto> = this.pointRequestValues.filter(
        (value: PointRequestDto) => value.id === pointRequestId
      );
      if (currentVisible.length !== 1) {
        throw new Error('LOCAL_REQUEST_INVALID');
      }
      this.assertPointRequestDetailAdvance(currentVisible[0], response.pointRequest);
      this.pointRequestValues = this.pointRequestValues.map((value: PointRequestDto) =>
        value.id === pointRequestId ? response.pointRequest : value
      );
      this.pointRequestDetailValue = response.pointRequest;
      this.statusCodeValue = 'POINT_REQUEST_DETAIL_CURRENT';
    } catch (error) {
      this.pointRequestDetailValue = null;
      await this.handleFailure(error as Object);
    } finally {
      this.busyValue = false;
    }
  }

  dismissPointRequestDetail(): void {
    this.pointRequestDetailGeneration += 1;
    this.pointRequestDetailValue = null;
    if (this.statusCodeValue === 'POINT_REQUEST_DETAIL_CURRENT') {
      this.statusCodeValue = 'READY';
    }
  }
}
