import { ChildApiError } from '../network/ApiClient';
import {
  ClaimPairingRequest,
  ClaimPairingResponse,
  DEVICE_KEY_ALGORITHM,
  PairingCompletionResponse,
  ProofDto,
  ProofResponse,
  RefreshResponse,
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
  private readonly proofVerifier: DeviceProofVerifierPort;
  private readonly secureIds: SecureIdPort;
  private envelope: SessionEnvelope | null = null;
  private summaryValue: SummaryResponse | null = null;
  private transactionValues: Array<TransactionDto> = [];
  private nextCursorValue: string = '';
  private operationGeneration: number = 0;
  private busyValue: boolean = false;
  private lockedValue: boolean = false;
  private statusCodeValue: string = 'BOOT';

  constructor(api: ChildApiPort, identity: DeviceIdentityPort, vault: SessionVaultPort,
    proofVerifier: DeviceProofVerifierPort, secureIds: SecureIdPort) {
    this.api = api;
    this.identity = identity;
    this.vault = vault;
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

  private clearBusinessView(): void {
    this.summaryValue = null;
    this.transactionValues = [];
    this.nextCursorValue = '';
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
    return 'READY';
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

  private async resetToUnpaired(): Promise<void> {
    const current: SessionEnvelope = this.requireEnvelope();
    const next: SessionEnvelope = unpairedEnvelope(current.devicePublicId);
    next.revision = current.revision;
    this.envelope = await this.vault.saveVerified(next);
    this.clearBusinessView();
  }

  private async handleFailure(error: Object, pairingOperation: boolean = false): Promise<void> {
    const code: string = stableErrorCode(error);
    if (code === 'SESSION_REVOKED' || code === 'CONSENT_REQUIRED'
        || (pairingOperation && (code === 'PAIRING_CODE_INVALID'
          || code === 'PAIRING_CLAIM_INVALID'
          || code === 'PAIRING_EXPIRED' || code === 'CHALLENGE_EXPIRED'))) {
      try {
        await this.resetToUnpaired();
        this.statusCodeValue = code;
        return;
      } catch (_) {
        this.lockedValue = true;
        this.statusCodeValue = 'LOCAL_STATE_COMMIT_FAILED';
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
    let pairingOperation: boolean = false;
    try {
      const current: SessionEnvelope = this.requireEnvelope();
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
        this.statusCodeValue = 'READY';
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

  async refreshSelf(): Promise<void> {
    if (this.busyValue || this.lockedValue) {
      return;
    }
    this.busyValue = true;
    const generation: number = this.operationGeneration;
    try {
      const current: SessionEnvelope = this.requireEnvelope();
      if (current.phase !== EnvelopePhase.ACTIVE
          && current.phase !== EnvelopePhase.REFRESH_ISSUE_INTENT
          && current.phase !== EnvelopePhase.REFRESH_COMPLETE_INTENT) {
        throw new Error('PAIRING_REQUIRED');
      }
      const summary: SummaryResponse = await this.summaryWithOneRefresh();
      const transactions: TransactionsResponse = await this.transactionsWithOneRefresh('');
      if (generation !== this.operationGeneration) {
        return;
      }
      this.summaryValue = summary;
      this.transactionValues = transactions.transactions;
      this.nextCursorValue = transactions.page.nextCursor === null
        ? '' : transactions.page.nextCursor;
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
}
