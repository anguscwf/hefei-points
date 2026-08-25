import { describe, expect, it } from '@ohos/hypium';
import { ApiEnvironment, isCanonicalHttpsOrigin } from '../main/ets/config/ApiEnvironment';
import {
  ApiTransport,
  ChildApiClient,
  ChildApiError,
  TransportRequest,
  TransportResponse
} from '../main/ets/network/ApiClient';
import {
  ClaimPairingRequest,
  ClaimPairingResponse,
  PairingCompletionResponse,
  parsePointRequestCreateRequest,
  PointRequestCreateRequest,
  PointRequestDto,
  PointRequestResponse,
  PointRequestsResponse,
  ProofDto,
  ProofResponse,
  RefreshResponse,
  RewardRulesResponse,
  SessionDto,
  SummaryResponse,
  TransactionsResponse,
  VerifiedProof
} from '../main/ets/network/ApiContracts';
import { DeviceIdentity } from '../main/ets/security/DeviceIdentity';
import { PointRequestVault } from '../main/ets/security/PointRequestVault';
import { SessionVault } from '../main/ets/security/SessionVault';
import {
  ChildApiPort,
  ChildSessionCoordinator,
  DeviceIdentityPort,
  DeviceProofVerifierPort,
  PointRequestVaultPort,
  SecureIdPort,
  SessionVaultPort
} from '../main/ets/session/ChildSessionCoordinator';
import {
  activeEnvelope,
  copyEnvelope,
  EnvelopePhase,
  SessionEnvelope,
  unpairedEnvelope
} from '../main/ets/session/SessionEnvelope';
import {
  copyPointRequestIntent,
  createPointRequestIntent,
  emptyPointRequestIntent,
  PointRequestIntent,
  PointRequestIntentPhase
} from '../main/ets/session/PointRequestIntent';

const DEVICE_PUBLIC_ID: string = 'devicepublicid0123456789';
const ACCESS_EXPIRES: string = '2098-12-01T00:00:00.000Z';
const REFRESH_EXPIRES: string = '2099-01-01T00:00:00.000Z';
const PROOF_EXPIRES: string = '2098-11-01T00:00:00.000Z';

class FailingTransport implements ApiTransport {
  readonly requests: Array<TransportRequest> = [];
  private readonly error: ChildApiError;

  constructor(error: ChildApiError) {
    this.error = error;
  }

  async request(value: TransportRequest): Promise<TransportResponse> {
    this.requests.push(value);
    throw this.error;
  }
}

class FailingApi implements ChildApiPort {
  readonly calls: Array<string> = [];
  private readonly error: ChildApiError;

  constructor(error: ChildApiError) {
    this.error = error;
  }

  async claimPairing(body: ClaimPairingRequest,
    idempotencyKey: string): Promise<ClaimPairingResponse> {
    this.calls.push(`claim|${JSON.stringify(body)}|${idempotencyKey}`);
    throw this.error;
  }

  async completePairing(claimToken: string, signatureBase64url: string,
    idempotencyKey: string, devicePublicId: string,
    proofBindingId: string): Promise<PairingCompletionResponse> {
    this.calls.push([
      'complete', claimToken, signatureBase64url, idempotencyKey,
      devicePublicId, proofBindingId
    ].join('|'));
    throw this.error;
  }

  async issueRefreshChallenge(bindingId: string, session: SessionDto,
    idempotencyKey: string): Promise<ProofResponse> {
    this.calls.push(`issue|${bindingId}|${session.refreshToken}|${idempotencyKey}`);
    throw this.error;
  }

  async refreshSession(previous: SessionDto, challengeId: string,
    signatureBase64url: string, idempotencyKey: string): Promise<RefreshResponse> {
    this.calls.push([
      'refresh', previous.refreshToken, challengeId,
      signatureBase64url, idempotencyKey
    ].join('|'));
    throw this.error;
  }

  async getSummary(accessToken: string): Promise<SummaryResponse> {
    this.calls.push(`summary|${accessToken}`);
    throw this.error;
  }

  async getTransactions(accessToken: string, limit: number,
    cursor: string): Promise<TransactionsResponse> {
    this.calls.push(`transactions|${accessToken}|${limit}|${cursor}`);
    throw this.error;
  }

  async getRewardRules(accessToken: string, limit: number,
    cursor: string): Promise<RewardRulesResponse> {
    this.calls.push(`rules|${accessToken}|${limit}|${cursor}`);
    throw this.error;
  }

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    this.calls.push(`point-create|${accessToken}|${bodyJson}|${idempotencyKey}`);
    throw this.error;
  }

  async getPointRequests(accessToken: string, limit: number,
    cursor: string): Promise<PointRequestsResponse> {
    this.calls.push(`point-list|${accessToken}|${limit}|${cursor}`);
    throw this.error;
  }
}

class FakeIdentity implements DeviceIdentityPort {
  async exists(): Promise<boolean> {
    return true;
  }

  async create(): Promise<void> {
    throw new Error('UNEXPECTED_CREATE');
  }

  async publicKeyBase64url(): Promise<string> {
    return 'A'.repeat(122);
  }

  async signBase64url(_payload: Uint8Array): Promise<string> {
    return 'S'.repeat(86);
  }
}

class FakeProofVerifier implements DeviceProofVerifierPort {
  verify(_value: ProofDto, expectedPurpose: string,
    expectedBindingId: string, expectedSessionId: string): VerifiedProof {
    return {
      purpose: expectedPurpose,
      bindingId: expectedBindingId.length > 0
        ? expectedBindingId : `device_${'d'.repeat(32)}`,
      sessionId: expectedSessionId,
      payload: new Uint8Array([1, 2, 3])
    };
  }
}

class FakeSecureIds implements SecureIdPort {
  private counter: number = 0;

  devicePublicId(): string {
    return DEVICE_PUBLIC_ID;
  }

  idempotencyKey(operation: string): string {
    this.counter += 1;
    return `hmos-${operation}-synthetic-${this.counter.toString().padStart(4, '0')}`;
  }
}

class FakeVault implements SessionVaultPort {
  value: SessionEnvelope;

  constructor(value: SessionEnvelope) {
    this.value = copyEnvelope(value);
  }

  async load(): Promise<SessionEnvelope | null> {
    return copyEnvelope(this.value);
  }

  async saveVerified(value: SessionEnvelope): Promise<SessionEnvelope> {
    if (value.revision !== this.value.revision) {
      throw new Error('LOCAL_STATE_CONFLICT');
    }
    const committed: SessionEnvelope = copyEnvelope(value);
    committed.revision += 1;
    this.value = copyEnvelope(committed);
    return copyEnvelope(committed);
  }
}

class FakePointVault implements PointRequestVaultPort {
  value: PointRequestIntent;

  constructor(value: PointRequestIntent = emptyPointRequestIntent()) {
    this.value = copyPointRequestIntent(value);
  }

  async load(): Promise<PointRequestIntent | null> {
    return copyPointRequestIntent(this.value);
  }

  async saveVerified(value: PointRequestIntent): Promise<PointRequestIntent> {
    if (value.revision !== this.value.revision) {
      throw new Error('LOCAL_POINT_INTENT_CONFLICT');
    }
    const committed: PointRequestIntent = copyPointRequestIntent(value);
    committed.revision += 1;
    this.value = copyPointRequestIntent(committed);
    return copyPointRequestIntent(committed);
  }
}

function activeSession(): SessionDto {
  return {
    id: `session_${'s'.repeat(32)}`,
    accessToken: `tg_access.${'a'.repeat(43)}`,
    accessExpiresAt: ACCESS_EXPIRES,
    refreshToken: `tg_refresh.${'r'.repeat(43)}`,
    refreshExpiresAt: REFRESH_EXPIRES,
    rotationCounter: 4
  };
}

function syntheticProof(purpose: string): ProofDto {
  return {
    algorithm: 'ECDSA_P256_SHA256',
    challengeId: `${purpose}_${'p'.repeat(32)}`,
    challenge: 'C'.repeat(43),
    signingPayload: 'U'.repeat(160),
    expiresAt: PROOF_EXPIRES
  };
}

function syntheticPointRequest(body: PointRequestCreateRequest): PointRequestDto {
  return {
    id: `point_request_${'1'.repeat(32)}`,
    status: 'pending',
    revision: 0,
    rule: {
      id: body.ruleId,
      categoryId: 'category_synthetic',
      label: '合成任务',
      categoryLabel: '合成分类',
      unit: '每次',
      minPoints: 1,
      defaultPoints: 4,
      maxPoints: 8,
      revision: 1
    },
    requestedPoints: body.requestedPoints,
    approvedPoints: null,
    description: body.description,
    occurredAt: '2026-08-25T00:00:00.000Z',
    duplicateSuspected: false,
    requestInfo: null,
    decision: null,
    submittedAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    clientRequestId: body.clientRequestId
  };
}

class SuccessfulApi implements ChildApiPort {
  readonly calls: Array<string> = [];

  async claimPairing(body: ClaimPairingRequest,
    idempotencyKey: string): Promise<ClaimPairingResponse> {
    this.calls.push(`claim|${body.shortCode}|${body.devicePublicId}|${idempotencyKey}`);
    return {
      success: true,
      claimId: `tg_claim.${'c'.repeat(43)}`,
      proof: syntheticProof('pairing')
    };
  }

  async completePairing(claimToken: string, signatureBase64url: string,
    idempotencyKey: string, devicePublicId: string,
    proofBindingId: string): Promise<PairingCompletionResponse> {
    this.calls.push([
      'complete', claimToken, signatureBase64url, idempotencyKey,
      devicePublicId, proofBindingId
    ].join('|'));
    const session: SessionDto = activeSession();
    session.rotationCounter = 0;
    return {
      success: true,
      device: {
        id: proofBindingId,
        childId: 'c1',
        publicId: devicePublicId,
        alias: 'HarmonyOS 手机',
        publicKey: { algorithm: 'ECDSA_P256_SHA256', sha256: 'a'.repeat(64) },
        status: 'active',
        revision: 1,
        claimedAt: '2026-08-25T00:00:00.000Z',
        activatedAt: '2026-08-25T00:01:00.000Z'
      },
      session
    };
  }

  async issueRefreshChallenge(bindingId: string, session: SessionDto,
    idempotencyKey: string): Promise<ProofResponse> {
    this.calls.push(`issue|${bindingId}|${session.refreshToken}|${idempotencyKey}`);
    return { success: true, proof: syntheticProof('refresh') };
  }

  async refreshSession(previous: SessionDto, challengeId: string,
    signatureBase64url: string, idempotencyKey: string): Promise<RefreshResponse> {
    this.calls.push([
      'refresh', previous.refreshToken, challengeId,
      signatureBase64url, idempotencyKey
    ].join('|'));
    return {
      success: true,
      session: {
        id: `session_${'n'.repeat(32)}`,
        accessToken: `tg_access.${'n'.repeat(43)}`,
        accessExpiresAt: '2098-12-02T00:00:00.000Z',
        refreshToken: `tg_refresh.${'m'.repeat(43)}`,
        refreshExpiresAt: previous.refreshExpiresAt,
        rotationCounter: previous.rotationCounter + 1
      }
    };
  }

  async getSummary(accessToken: string): Promise<SummaryResponse> {
    this.calls.push(`summary|${accessToken}`);
    return {
      success: true,
      child: { id: 'c1', name: '合成孩子' },
      points: { balance: 18 }
    };
  }

  async getTransactions(accessToken: string, limit: number,
    cursor: string): Promise<TransactionsResponse> {
    this.calls.push(`transactions|${accessToken}|${limit}|${cursor}`);
    return {
      success: true,
      transactions: [],
      page: { limit, hasMore: false, nextCursor: null }
    };
  }

  async getRewardRules(accessToken: string, limit: number,
    cursor: string): Promise<RewardRulesResponse> {
    this.calls.push(`rules|${accessToken}|${limit}|${cursor}`);
    return {
      success: true,
      revision: 1,
      rewardRules: [{
        id: 'reward_synthetic',
        categoryId: 'category_synthetic',
        categoryLabel: '合成分类',
        label: '合成任务',
        unit: '每次',
        minPoints: 1,
        defaultPoints: 4,
        maxPoints: 8
      }],
      page: { limit, hasMore: false, nextCursor: null }
    };
  }

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    this.calls.push(`point-create|${accessToken}|${bodyJson}|${idempotencyKey}`);
    const body: PointRequestCreateRequest = parsePointRequestCreateRequest(bodyJson);
    return {
      success: true,
      pointRequest: syntheticPointRequest(body)
    };
  }

  async getPointRequests(accessToken: string, limit: number,
    cursor: string): Promise<PointRequestsResponse> {
    this.calls.push(`point-list|${accessToken}|${limit}|${cursor}`);
    return { success: true, pointRequests: [], nextCursor: null };
  }
}

class PointCreateFailingApi extends SuccessfulApi {
  private readonly failure: ChildApiError;

  constructor(failure: ChildApiError) {
    super();
    this.failure = failure;
  }

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    this.calls.push(`point-create|${accessToken}|${bodyJson}|${idempotencyKey}`);
    throw this.failure;
  }
}

class FailOncePointApi extends SuccessfulApi {
  private failed: boolean = false;

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    this.calls.push(`point-create|${accessToken}|${bodyJson}|${idempotencyKey}`);
    if (!this.failed) {
      this.failed = true;
      throw new ChildApiError('FEATURE_DISABLED', 403, false, false);
    }
    return {
      success: true,
      pointRequest: syntheticPointRequest(parsePointRequestCreateRequest(bodyJson))
    };
  }
}

class ProcessingBlockedRulesApi extends SuccessfulApi {
  private rulesReadCount: number = 0;

  async getRewardRules(accessToken: string, limit: number,
    cursor: string): Promise<RewardRulesResponse> {
    this.rulesReadCount += 1;
    if (this.rulesReadCount > 1) {
      this.calls.push(`rules|${accessToken}|${limit}|${cursor}`);
      throw new ChildApiError('CHILD_PROCESSING_BLOCKED', 409, false, false);
    }
    const response: RewardRulesResponse = await super.getRewardRules(
      accessToken, limit, cursor
    );
    response.page.hasMore = true;
    response.page.nextCursor = 'R'.repeat(120);
    return response;
  }
}

class RefreshStaleApi extends SuccessfulApi {
  async issueRefreshChallenge(bindingId: string, session: SessionDto,
    idempotencyKey: string): Promise<ProofResponse> {
    this.calls.push(`issue|${bindingId}|${session.refreshToken}|${idempotencyKey}`);
    throw new ChildApiError('IDEMPOTENCY_REPLAY_STALE', 409, false, false);
  }
}

class PersistOrderApi extends SuccessfulApi {
  private readonly pointVault: FakePointVault;
  observedPersistedIntent: boolean = false;

  constructor(pointVault: FakePointVault) {
    super();
    this.pointVault = pointVault;
  }

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    if (this.pointVault.value.phase !== PointRequestIntentPhase.CREATE_INTENT
        || this.pointVault.value.bodyJson !== bodyJson
        || this.pointVault.value.idempotencyKey !== idempotencyKey) {
      throw new Error('POINT_INTENT_NOT_PERSISTED_BEFORE_SEND');
    }
    this.observedPersistedIntent = true;
    return super.createPointRequest(accessToken, bodyJson, idempotencyKey);
  }
}

class ResponseLostPointApi extends SuccessfulApi {
  createdValue: PointRequestDto | null = null;

  async createPointRequest(accessToken: string, bodyJson: string,
    idempotencyKey: string): Promise<PointRequestResponse> {
    this.calls.push(`point-create|${accessToken}|${bodyJson}|${idempotencyKey}`);
    this.createdValue = syntheticPointRequest(parsePointRequestCreateRequest(bodyJson));
    throw new ChildApiError('NETWORK_UNAVAILABLE', 0, true, true);
  }

  async getPointRequests(accessToken: string, limit: number,
    cursor: string): Promise<PointRequestsResponse> {
    this.calls.push(`point-list|${accessToken}|${limit}|${cursor}`);
    return {
      success: true,
      pointRequests: this.createdValue === null ? [] : [this.createdValue],
      nextCursor: null
    };
  }
}

class RejectingPointClearVault extends FakePointVault {
  async saveVerified(value: PointRequestIntent): Promise<PointRequestIntent> {
    if (this.value.phase === PointRequestIntentPhase.CREATE_INTENT
        && value.phase === PointRequestIntentPhase.EMPTY) {
      throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
    }
    return super.saveVerified(value);
  }
}

class RejectingPointCreateVault extends FakePointVault {
  async saveVerified(value: PointRequestIntent): Promise<PointRequestIntent> {
    if (this.value.phase === PointRequestIntentPhase.EMPTY
        && value.phase === PointRequestIntentPhase.CREATE_INTENT) {
      throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
    }
    return super.saveVerified(value);
  }
}

async function initializedCoordinator(api: ChildApiPort,
  vault: FakeVault, pointVault: FakePointVault = new FakePointVault()): Promise<ChildSessionCoordinator> {
  const coordinator: ChildSessionCoordinator = new ChildSessionCoordinator(
    api,
    new FakeIdentity(),
    vault,
    pointVault,
    new FakeProofVerifier(),
    new FakeSecureIds()
  );
  await coordinator.initialize();
  return coordinator;
}

export default function recoveryTests(): void {
  describe('Harmony child durable recovery', () => {
    it('persists the pairing proof before guardian completion and activates exactly once', 0,
      async () => {
        const vault: FakeVault = new FakeVault(unpairedEnvelope(DEVICE_PUBLIC_ID));
        const api: SuccessfulApi = new SuccessfulApi();
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(api, vault);

        await coordinator.beginPairing('123456');

        expect(coordinator.phase).assertEqual(EnvelopePhase.WAITING_GUARDIAN);
        expect(vault.value.claimShortCode).assertEqual('');
        expect(vault.value.claimIdempotencyKey).assertEqual('');
        expect(vault.value.claimToken).assertEqual(`tg_claim.${'c'.repeat(43)}`);
        expect(vault.value.completeSignature).assertEqual('S'.repeat(86));
        expect(vault.value.completeIdempotencyKey.length >= 16).assertTrue();
        expect(api.calls[0]).assertContain('claim|123456');

        await coordinator.continuePendingAction();

        expect(coordinator.phase).assertEqual(EnvelopePhase.ACTIVE);
        expect(coordinator.statusCode).assertEqual('READY');
        expect(vault.value.accessToken).assertEqual(`tg_access.${'a'.repeat(43)}`);
        expect(vault.value.refreshToken).assertEqual(`tg_refresh.${'r'.repeat(43)}`);
        expect(vault.value.claimToken).assertEqual('');
        expect(vault.value.completeSignature).assertEqual('');
        expect(api.calls.length).assertEqual(2);
        expect(api.calls[1]).assertContain(`complete|tg_claim.${'c'.repeat(43)}`);
      });

    it('rotates the exact old refresh credential and clears durable recovery fields', 0,
      async () => {
        const previous: SessionDto = activeSession();
        previous.accessExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
        const active: SessionEnvelope = activeEnvelope(
          DEVICE_PUBLIC_ID,
          `device_${'d'.repeat(32)}`,
          previous
        );
        const vault: FakeVault = new FakeVault(active);
        const api: SuccessfulApi = new SuccessfulApi();
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(api, vault);

        await coordinator.refreshSelf();

        expect(coordinator.phase).assertEqual(EnvelopePhase.ACTIVE);
        expect(coordinator.statusCode).assertEqual('READY');
        expect(coordinator.hasSummary).assertTrue();
        expect(vault.value.accessToken).assertEqual(`tg_access.${'n'.repeat(43)}`);
        expect(vault.value.refreshToken).assertEqual(`tg_refresh.${'m'.repeat(43)}`);
        expect(vault.value.refreshExpiresAt).assertEqual(REFRESH_EXPIRES);
        expect(vault.value.rotationCounter).assertEqual(5);
        expect(vault.value.refreshIssueIdempotencyKey).assertEqual('');
        expect(vault.value.refreshChallengeId).assertEqual('');
        expect(vault.value.refreshSignature).assertEqual('');
        expect(api.calls.join('\n')).assertContain(`issue|device_${'d'.repeat(32)}`);
        expect(api.calls.join('\n')).assertContain(`refresh|tg_refresh.${'r'.repeat(43)}`);
        expect(api.calls.join('\n')).assertContain(`summary|tg_access.${'n'.repeat(43)}`);
        expect(api.calls.join('\n')).assertContain('transactions|');
      });

    it('keeps the original pairing claim request across process restarts', 0, async () => {
      const intent: SessionEnvelope = unpairedEnvelope(DEVICE_PUBLIC_ID);
      intent.phase = EnvelopePhase.CLAIM_INTENT;
      intent.claimShortCode = '123456';
      intent.claimIdempotencyKey = 'pair-claim-key-0001';
      const vault: FakeVault = new FakeVault(intent);
      const api: FailingApi = new FailingApi(
        new ChildApiError('NETWORK_UNAVAILABLE', 0, true, true)
      );

      const first: ChildSessionCoordinator = await initializedCoordinator(api, vault);
      await first.continuePendingAction();
      const second: ChildSessionCoordinator = await initializedCoordinator(api, vault);
      await second.continuePendingAction();

      expect(api.calls.length).assertEqual(2);
      expect(api.calls[0]).assertEqual(api.calls[1]);
      expect(vault.value.phase).assertEqual(EnvelopePhase.CLAIM_INTENT);
      expect(second.statusCode).assertEqual('RESULT_UNKNOWN');
    });

    it('replays refresh with the exact old credential, proof and idempotency key', 0, async () => {
      const intent: SessionEnvelope = activeEnvelope(
        DEVICE_PUBLIC_ID,
        `device_${'d'.repeat(32)}`,
        activeSession()
      );
      intent.phase = EnvelopePhase.REFRESH_COMPLETE_INTENT;
      intent.refreshChallengeId = `refresh_proof_${'p'.repeat(32)}`;
      intent.refreshProofExpiresAt = '2020-01-01T00:00:00.000Z';
      intent.refreshSignature = 'Q'.repeat(86);
      intent.refreshCompleteIdempotencyKey = 'refresh-complete-0001';
      const vault: FakeVault = new FakeVault(intent);
      const api: FailingApi = new FailingApi(
        new ChildApiError('SERVER_UNAVAILABLE', 503, true, true)
      );

      const first: ChildSessionCoordinator = await initializedCoordinator(api, vault);
      await first.continuePendingAction();
      const second: ChildSessionCoordinator = await initializedCoordinator(api, vault);
      await second.continuePendingAction();

      expect(api.calls.length).assertEqual(2);
      expect(api.calls[0]).assertEqual(api.calls[1]);
      expect(api.calls[0]).assertContain(`tg_refresh.${'r'.repeat(43)}`);
      expect(vault.value.phase).assertEqual(EnvelopePhase.REFRESH_COMPLETE_INTENT);
      expect(second.statusCode).assertEqual('RESULT_UNKNOWN');
    });

    it('replays an expired pairing completion when the server result is unknown', 0,
      async () => {
        const intent: SessionEnvelope = unpairedEnvelope(DEVICE_PUBLIC_ID);
        intent.phase = EnvelopePhase.COMPLETE_RESULT_UNKNOWN;
        intent.claimToken = `tg_claim.${'c'.repeat(43)}`;
        intent.proofExpiresAt = '2020-01-01T00:00:00.000Z';
        intent.proofBindingId = `device_${'d'.repeat(32)}`;
        intent.completeSignature = 'S'.repeat(86);
        intent.completeIdempotencyKey = 'pair-complete-exact-0001';
        const vault: FakeVault = new FakeVault(intent);
        const api: FailingApi = new FailingApi(
          new ChildApiError('NETWORK_UNAVAILABLE', 0, true, true)
        );
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(api, vault);

        await coordinator.continuePendingAction();

        expect(api.calls.length).assertEqual(1);
        expect(api.calls[0]).assertContain('pair-complete-exact-0001');
        expect(vault.value.phase).assertEqual(EnvelopePhase.COMPLETE_RESULT_UNKNOWN);
        expect(coordinator.statusCode).assertEqual('RESULT_UNKNOWN');
      });

    it('uses a new challenge idempotency key after definitive refresh expiry', 0,
      async () => {
        const issue: SessionEnvelope = activeEnvelope(
          DEVICE_PUBLIC_ID,
          `device_${'d'.repeat(32)}`,
          activeSession()
        );
        issue.phase = EnvelopePhase.REFRESH_ISSUE_INTENT;
        issue.refreshIssueIdempotencyKey = 'refresh-issue-expired-0001';
        const issueVault: FakeVault = new FakeVault(issue);
        const issueApi: FailingApi = new FailingApi(
          new ChildApiError('CHALLENGE_EXPIRED', 410, false, false)
        );
        const issueCoordinator: ChildSessionCoordinator = await initializedCoordinator(
          issueApi,
          issueVault
        );

        await issueCoordinator.continuePendingAction();

        expect(issueVault.value.phase).assertEqual(EnvelopePhase.REFRESH_ISSUE_INTENT);
        expect(issueVault.value.refreshIssueIdempotencyKey
          !== 'refresh-issue-expired-0001').assertTrue();
        expect(issueCoordinator.statusCode).assertEqual('SESSION_RECOVERY_REQUIRED');

        const complete: SessionEnvelope = activeEnvelope(
          DEVICE_PUBLIC_ID,
          `device_${'d'.repeat(32)}`,
          activeSession()
        );
        complete.phase = EnvelopePhase.REFRESH_COMPLETE_INTENT;
        complete.refreshChallengeId = `refresh_proof_${'p'.repeat(32)}`;
        complete.refreshProofExpiresAt = '2020-01-01T00:00:00.000Z';
        complete.refreshSignature = 'Q'.repeat(86);
        complete.refreshCompleteIdempotencyKey = 'refresh-complete-expired-0001';
        const completeVault: FakeVault = new FakeVault(complete);
        const completeApi: FailingApi = new FailingApi(
          new ChildApiError('CHALLENGE_EXPIRED', 410, false, false)
        );
        const completeCoordinator: ChildSessionCoordinator = await initializedCoordinator(
          completeApi,
          completeVault
        );

        await completeCoordinator.continuePendingAction();

        expect(completeApi.calls.length).assertEqual(1);
        expect(completeVault.value.phase).assertEqual(EnvelopePhase.REFRESH_ISSUE_INTENT);
        expect(completeVault.value.refreshChallengeId).assertEqual('');
        expect(completeVault.value.refreshSignature).assertEqual('');
        expect(completeCoordinator.statusCode).assertEqual('SESSION_RECOVERY_REQUIRED');
      });

    it('returns a definitively invalid short code to the unpaired state', 0, async () => {
      const intent: SessionEnvelope = unpairedEnvelope(DEVICE_PUBLIC_ID);
      intent.phase = EnvelopePhase.CLAIM_INTENT;
      intent.claimShortCode = '123456';
      intent.claimIdempotencyKey = 'pair-claim-invalid-0001';
      const vault: FakeVault = new FakeVault(intent);
      const api: FailingApi = new FailingApi(
        new ChildApiError('PAIRING_CODE_INVALID', 404, false, false)
      );
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(api, vault);

      await coordinator.continuePendingAction();

      expect(coordinator.phase).assertEqual(EnvelopePhase.UNPAIRED);
      expect(coordinator.statusCode).assertEqual('PAIRING_CODE_INVALID');
      expect(vault.value.claimShortCode).assertEqual('');
      expect(vault.value.claimIdempotencyKey).assertEqual('');
    });

    it('clears the local device session when guardian authorization is revoked', 0, async () => {
      const active: SessionEnvelope = activeEnvelope(
        DEVICE_PUBLIC_ID,
        `device_${'d'.repeat(32)}`,
        activeSession()
      );
      const vault: FakeVault = new FakeVault(active);
      const api: FailingApi = new FailingApi(
        new ChildApiError('SESSION_REVOKED', 401, false, false)
      );
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(api, vault);

      await coordinator.refreshSelf();

      expect(coordinator.phase).assertEqual(EnvelopePhase.UNPAIRED);
      expect(coordinator.statusCode).assertEqual('SESSION_REVOKED');
      expect(vault.value.accessToken).assertEqual('');
      expect(vault.value.refreshToken).assertEqual('');
      expect(api.calls[0]).assertContain('summary|');
    });

    it('persists point creation before transport and clears it only after a strict response', 0,
      async () => {
        const vault: FakeVault = new FakeVault(activeEnvelope(
          DEVICE_PUBLIC_ID, `device_${'d'.repeat(32)}`, activeSession()
        ));
        const pointVault: FakePointVault = new FakePointVault();
        const api: PersistOrderApi = new PersistOrderApi(pointVault);
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          api, vault, pointVault
        );
        await coordinator.refreshSelf();
        const first: Promise<void> = coordinator.submitPointRequest(
          'reward_synthetic', 4, '合成文字申报'
        );
        const doubleTap: Promise<void> = coordinator.submitPointRequest(
          'reward_synthetic', 4, '合成文字申报'
        );
        await first;
        await doubleTap;

        expect(coordinator.statusCode).assertEqual('POINT_REQUEST_SUBMITTED');
        expect(coordinator.pointRequests.length).assertEqual(1);
        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
        expect(api.observedPersistedIntent).assertTrue();
        expect(api.calls.join('\n')).assertContain('point-list|');
        expect(api.calls.join('\n')).assertContain('point-create|');
        expect(api.calls.join('\n')).assertContain('"description":"合成文字申报"');
        expect(api.calls.filter((value: string) => value.startsWith('point-create|')).length)
          .assertEqual(1);
      });

    it('reconciles a response-lost create after restart without a second POST', 0, async () => {
      const bindingId: string = `device_${'d'.repeat(32)}`;
      const body: PointRequestCreateRequest = {
        clientRequestId: 'hmos-point-client-response-lost-0001',
        ruleId: 'reward_synthetic',
        requestedPoints: 4,
        description: '合成响应丢失恢复说明'
      };
      const intent: PointRequestIntent = createPointRequestIntent(
        bindingId, body, 'point-create-response-lost-key-0001'
      );
      const pointVault: FakePointVault = new FakePointVault(intent);
      const vault: FakeVault = new FakeVault(activeEnvelope(
        DEVICE_PUBLIC_ID, bindingId, activeSession()
      ));
      const api: ResponseLostPointApi = new ResponseLostPointApi();

      const first: ChildSessionCoordinator = await initializedCoordinator(
        api, vault, pointVault
      );
      await first.continuePendingAction();
      expect(first.statusCode).assertEqual('RESULT_UNKNOWN');
      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);

      const restarted: ChildSessionCoordinator = await initializedCoordinator(
        api, vault, pointVault
      );
      await restarted.continuePendingAction();

      expect(api.calls.filter((value: string) => value.startsWith('point-create|')).length)
        .assertEqual(1);
      expect(restarted.pointRequests.length).assertEqual(1);
      expect(restarted.statusCode).assertEqual('POINT_REQUEST_SUBMITTED');
      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
    });

    it('keeps the exact point intent when reconciliation cannot prove the prior result', 0,
      async () => {
        const failures: Array<ChildApiError> = [
          new ChildApiError('PROTOCOL_ERROR', 200, false, false),
          new ChildApiError('VALIDATION_ERROR', 400, false, false)
        ];
        for (let index: number = 0; index < failures.length; index += 1) {
          const bindingId: string = `device_${String(index).repeat(32)}`;
          const intent: PointRequestIntent = createPointRequestIntent(
            bindingId,
            {
              clientRequestId: `hmos-point-client-barrier-000${index}`,
              ruleId: 'reward_synthetic',
              requestedPoints: 4,
              description: `合成临时阻断恢复说明${index}`
            },
            `point-create-barrier-key-000${index}`
          );
          const pointVault: FakePointVault = new FakePointVault(intent);
          const api: FailingApi = new FailingApi(failures[index]);
          const coordinator: ChildSessionCoordinator = await initializedCoordinator(
            api,
            new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
            pointVault
          );

          await coordinator.continuePendingAction();

          expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
          expect(pointVault.value.bodyJson).assertEqual(intent.bodyJson);
          expect(pointVault.value.idempotencyKey).assertEqual(intent.idempotencyKey);
          expect(api.calls.filter((value: string) => value.startsWith('point-create|')).length)
            .assertEqual(0);
        }
      });

    it('keeps the exact point intent on temporary mutation barriers', 0, async () => {
      const failures: Array<ChildApiError> = [
        new ChildApiError('FEATURE_DISABLED', 403, false, false),
        new ChildApiError('SERVER_UNAVAILABLE', 429, true, true),
        new ChildApiError('CHILD_DATA_INCOMPLETE', 409, false, false)
      ];
      for (let index: number = 0; index < failures.length; index += 1) {
        const bindingId: string = `device_${String(index + 2).repeat(32)}`;
        const intent: PointRequestIntent = createPointRequestIntent(
          bindingId,
          {
            clientRequestId: `hmos-point-client-write-barrier-${index}`,
            ruleId: 'reward_synthetic',
            requestedPoints: 4,
            description: `合成写入临时阻断说明${index}`
          },
          `point-create-write-barrier-${index}`
        );
        const pointVault: FakePointVault = new FakePointVault(intent);
        const api: PointCreateFailingApi = new PointCreateFailingApi(failures[index]);
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          api,
          new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
          pointVault
        );

        await coordinator.continuePendingAction();

        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
        expect(pointVault.value.bodyJson).assertEqual(intent.bodyJson);
        expect(pointVault.value.idempotencyKey).assertEqual(intent.idempotencyKey);
        expect(api.calls.filter((value: string) => value.startsWith('point-create|')).length)
          .assertEqual(1);
      }
    });

    it('reuses the exact point body and key after a feature gate reopens', 0, async () => {
      const bindingId: string = `device_${'d'.repeat(32)}`;
      const intent: PointRequestIntent = createPointRequestIntent(
        bindingId,
        {
          clientRequestId: 'hmos-point-client-gate-reopen-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成功能门恢复说明'
        },
        'point-create-gate-reopen-key-0001'
      );
      const pointVault: FakePointVault = new FakePointVault(intent);
      const api: FailOncePointApi = new FailOncePointApi();
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(
        api,
        new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
        pointVault
      );

      await coordinator.continuePendingAction();
      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
      await coordinator.continuePendingAction();

      const creates: Array<string> = api.calls.filter(
        (value: string) => value.startsWith('point-create|')
      );
      expect(creates.length).assertEqual(2);
      expect(creates[0]).assertEqual(creates[1]);
      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
      expect(coordinator.statusCode).assertEqual('POINT_REQUEST_SUBMITTED');
    });

    it('locks unresolved idempotency conflicts without clearing the original intent', 0,
      async () => {
        const codes: Array<string> = [
          'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_UNAVAILABLE'
        ];
        for (let index: number = 0; index < codes.length; index += 1) {
          const bindingId: string = `device_${String(index + 5).repeat(32)}`;
          const intent: PointRequestIntent = createPointRequestIntent(
            bindingId,
            {
              clientRequestId: `hmos-point-client-conflict-000${index}`,
              ruleId: 'reward_synthetic',
              requestedPoints: 4,
              description: `合成幂等冲突说明${index}`
            },
            `point-create-conflict-key-000${index}`
          );
          const pointVault: FakePointVault = new FakePointVault(intent);
          const api: PointCreateFailingApi = new PointCreateFailingApi(
            new ChildApiError(codes[index], 409, false, false)
          );
          const coordinator: ChildSessionCoordinator = await initializedCoordinator(
            api,
            new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
            pointVault
          );

          await coordinator.continuePendingAction();

          expect(coordinator.locked).assertTrue();
          expect(coordinator.statusCode).assertEqual('POINT_REQUEST_RECONCILIATION_CONFLICT');
          expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
          expect(pointVault.value.bodyJson).assertEqual(intent.bodyJson);
          expect(pointVault.value.idempotencyKey).assertEqual(intent.idempotencyKey);
        }
      });

    it('clears only a stale result returned by the point create operation itself', 0,
      async () => {
        const bindingId: string = `device_${'d'.repeat(32)}`;
        const intent: PointRequestIntent = createPointRequestIntent(
          bindingId,
          {
            clientRequestId: 'hmos-point-client-create-stale-0001',
            ruleId: 'reward_synthetic',
            requestedPoints: 4,
            description: '合成申报状态已推进说明'
          },
          'point-create-stale-key-0001'
        );
        const pointVault: FakePointVault = new FakePointVault(intent);
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          new PointCreateFailingApi(
            new ChildApiError('IDEMPOTENCY_REPLAY_STALE', 409, false, false)
          ),
          new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
          pointVault
        );

        await coordinator.continuePendingAction();

        expect(coordinator.locked).assertFalse();
        expect(coordinator.statusCode).assertEqual('POINT_REQUEST_RECONCILED');
        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
      });

    it('does not dispatch when the point intent cannot be persisted and verified', 0,
      async () => {
        const pointVault: RejectingPointCreateVault = new RejectingPointCreateVault();
        const api: SuccessfulApi = new SuccessfulApi();
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          api,
          new FakeVault(activeEnvelope(
            DEVICE_PUBLIC_ID, `device_${'d'.repeat(32)}`, activeSession()
          )),
          pointVault
        );
        await coordinator.refreshSelf();
        const callCount: number = api.calls.length;

        await coordinator.submitPointRequest('reward_synthetic', 4, '合成不可持久化说明');

        expect(coordinator.locked).assertTrue();
        expect(coordinator.statusCode).assertEqual('LOCAL_POINT_INTENT_COMMIT_FAILED');
        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
        expect(api.calls.length).assertEqual(callCount);
      });

    it('never restores point request data after a recovery response returns in background', 0,
      async () => {
        const bindingId: string = `device_${'d'.repeat(32)}`;
        const intent: PointRequestIntent = createPointRequestIntent(
          bindingId,
          {
            clientRequestId: 'hmos-point-client-background-0001',
            ruleId: 'reward_synthetic',
            requestedPoints: 4,
            description: '合成后台恢复说明'
          },
          'point-create-background-key-0001'
        );
        const pointVault: FakePointVault = new FakePointVault(intent);
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          new SuccessfulApi(),
          new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, activeSession())),
          pointVault
        );

        const recovery: Promise<void> = coordinator.continuePendingAction();
        coordinator.lockForBackground();
        await recovery;

        expect(coordinator.statusCode).assertEqual('BACKGROUND_LOCKED');
        expect(coordinator.hasSummary).assertFalse();
        expect(coordinator.transactions.length).assertEqual(0);
        expect(coordinator.rewardRules.length).assertEqual(0);
        expect(coordinator.pointRequests.length).assertEqual(0);
        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
      });

    it('clears all child business data when privacy processing blocks pagination', 0,
      async () => {
        const api: ProcessingBlockedRulesApi = new ProcessingBlockedRulesApi();
        const coordinator: ChildSessionCoordinator = await initializedCoordinator(
          api,
          new FakeVault(activeEnvelope(
            DEVICE_PUBLIC_ID, `device_${'d'.repeat(32)}`, activeSession()
          ))
        );
        await coordinator.refreshSelf();
        expect(coordinator.hasSummary).assertTrue();
        expect(coordinator.rewardRules.length).assertEqual(1);
        expect(coordinator.hasMoreRewardRules).assertTrue();

        await coordinator.loadMoreRewardRules();

        expect(coordinator.statusCode).assertEqual('CHILD_PROCESSING_BLOCKED');
        expect(coordinator.hasSummary).assertFalse();
        expect(coordinator.transactions.length).assertEqual(0);
        expect(coordinator.rewardRules.length).assertEqual(0);
        expect(coordinator.pointRequests.length).assertEqual(0);
      });

    it('replays the exact binding-scoped point body and key across process restarts', 0,
      async () => {
        const bindingId: string = `device_${'d'.repeat(32)}`;
        const body: PointRequestCreateRequest = {
          clientRequestId: 'hmos-point-client-synthetic-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成重启恢复说明'
        };
        const intent: PointRequestIntent = createPointRequestIntent(
          bindingId, body, 'point-create-exact-key-0001'
        );
        const pointVault: FakePointVault = new FakePointVault(intent);
        const vault: FakeVault = new FakeVault(activeEnvelope(
          DEVICE_PUBLIC_ID, bindingId, activeSession()
        ));
        const api: PointCreateFailingApi = new PointCreateFailingApi(
          new ChildApiError('NETWORK_UNAVAILABLE', 0, true, true)
        );

        const first: ChildSessionCoordinator = await initializedCoordinator(
          api, vault, pointVault
        );
        await first.continuePendingAction();
        const second: ChildSessionCoordinator = await initializedCoordinator(
          api, vault, pointVault
        );
        await second.continuePendingAction();

        const creates: Array<string> = api.calls.filter(
          (value: string) => value.startsWith('point-create|')
        );
        expect(creates.length).assertEqual(2);
        expect(creates[0]).assertEqual(creates[1]);
        expect(creates[0]).assertContain(intent.bodyJson);
        expect(creates[0]).assertContain(intent.idempotencyKey);
        expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
        expect(second.statusCode).assertEqual('RESULT_UNKNOWN');
      });

    it('never clears a point intent for a stale refresh idempotency result', 0, async () => {
      const session: SessionDto = activeSession();
      session.accessExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
      const bindingId: string = `device_${'d'.repeat(32)}`;
      const intent: PointRequestIntent = createPointRequestIntent(
        bindingId,
        {
          clientRequestId: 'hmos-point-client-refresh-stale-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成刷新幂等陈旧说明'
        },
        'point-create-refresh-stale-key-0001'
      );
      const pointVault: FakePointVault = new FakePointVault(intent);
      const api: RefreshStaleApi = new RefreshStaleApi();
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(
        api,
        new FakeVault(activeEnvelope(DEVICE_PUBLIC_ID, bindingId, session)),
        pointVault
      );

      await coordinator.continuePendingAction();

      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
      expect(pointVault.value.bodyJson).assertEqual(intent.bodyJson);
      expect(pointVault.value.idempotencyKey).assertEqual(intent.idempotencyKey);
      expect(api.calls.filter((value: string) => value.startsWith('point-list|')).length)
        .assertEqual(0);
      expect(api.calls.filter((value: string) => value.startsWith('point-create|')).length)
        .assertEqual(0);
    });

    it('finishes refresh recovery before replaying the original point intent', 0, async () => {
      const session: SessionDto = activeSession();
      session.accessExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
      const bindingId: string = `device_${'d'.repeat(32)}`;
      const vault: FakeVault = new FakeVault(activeEnvelope(
        DEVICE_PUBLIC_ID, bindingId, session
      ));
      const pointVault: FakePointVault = new FakePointVault(createPointRequestIntent(
        bindingId,
        {
          clientRequestId: 'hmos-point-client-refresh-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成刷新后申报'
        },
        'point-create-refresh-key-0001'
      ));
      const api: SuccessfulApi = new SuccessfulApi();
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(
        api, vault, pointVault
      );

      await coordinator.continuePendingAction();

      const calls: string = api.calls.join('\n');
      expect(calls.indexOf('issue|') < calls.indexOf('refresh|')).assertTrue();
      expect(calls.indexOf('refresh|') < calls.indexOf('point-list|')).assertTrue();
      expect(calls.indexOf('point-list|') < calls.indexOf('point-create|')).assertTrue();
      expect(pointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
      expect(vault.value.rotationCounter).assertEqual(5);
    });

    it('never replays an old point intent under a different device binding', 0, async () => {
      const intent: PointRequestIntent = createPointRequestIntent(
        `device_${'x'.repeat(32)}`,
        {
          clientRequestId: 'hmos-point-client-scope-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成旧绑定说明'
        },
        'point-create-scope-key-0001'
      );
      const api: SuccessfulApi = new SuccessfulApi();
      const coordinator: ChildSessionCoordinator = await initializedCoordinator(
        api,
        new FakeVault(activeEnvelope(
          DEVICE_PUBLIC_ID, `device_${'d'.repeat(32)}`, activeSession()
        )),
        new FakePointVault(intent)
      );

      expect(coordinator.locked).assertTrue();
      expect(coordinator.statusCode).assertEqual('LOCAL_POINT_INTENT_SCOPE_MISMATCH');
      expect(api.calls.length).assertEqual(0);
    });

    it('clears point intent before revoked session and locks if secure clearing fails', 0,
      async () => {
        const bindingId: string = `device_${'d'.repeat(32)}`;
        const intent: PointRequestIntent = createPointRequestIntent(
          bindingId,
          {
            clientRequestId: 'hmos-point-client-revoked-0001',
            ruleId: 'reward_synthetic',
            requestedPoints: 4,
            description: '合成撤权说明'
          },
          'point-create-revoked-key-0001'
        );
        const revokedApi: FailingApi = new FailingApi(
          new ChildApiError('SESSION_REVOKED', 401, false, false)
        );
        const firstVault: FakeVault = new FakeVault(activeEnvelope(
          DEVICE_PUBLIC_ID, bindingId, activeSession()
        ));
        const firstPointVault: FakePointVault = new FakePointVault(intent);
        const cleared: ChildSessionCoordinator = await initializedCoordinator(
          revokedApi, firstVault, firstPointVault
        );
        await cleared.continuePendingAction();
        expect(firstPointVault.value.phase).assertEqual(PointRequestIntentPhase.EMPTY);
        expect(firstVault.value.phase).assertEqual(EnvelopePhase.UNPAIRED);

        const blockedVault: FakeVault = new FakeVault(activeEnvelope(
          DEVICE_PUBLIC_ID, bindingId, activeSession()
        ));
        const blockedPointVault: RejectingPointClearVault = new RejectingPointClearVault(intent);
        const blocked: ChildSessionCoordinator = await initializedCoordinator(
          revokedApi, blockedVault, blockedPointVault
        );
        await blocked.continuePendingAction();
        expect(blocked.locked).assertTrue();
        expect(blocked.statusCode).assertEqual('LOCAL_POINT_INTENT_COMMIT_FAILED');
        expect(blockedVault.value.phase).assertEqual(EnvelopePhase.ACTIVE);
        expect(blockedPointVault.value.phase).assertEqual(PointRequestIntentPhase.CREATE_INTENT);
      });

    it('enforces the tracked or approved synthetic environment boundary', 0, () => {
      const identity: DeviceIdentity = new DeviceIdentity();
      const vault: SessionVault = new SessionVault();
      const pointVault: PointRequestVault = new PointRequestVault();
      const transport: FailingTransport = new FailingTransport(
        new ChildApiError('SYNTHETIC_FAILURE', 0, false, false)
      );
      const api: ChildApiClient = new ChildApiClient(transport);
      expect(identity instanceof DeviceIdentity).assertTrue();
      expect(vault instanceof SessionVault).assertTrue();
      expect(pointVault instanceof PointRequestVault).assertTrue();
      expect(api instanceof ChildApiClient).assertTrue();
      if (ApiEnvironment.PROFILE === 'synthetic-approved') {
        expect(ApiEnvironment.NETWORK_ENABLED).assertTrue();
        expect(isCanonicalHttpsOrigin(ApiEnvironment.API_ORIGIN)).assertTrue();
        ApiEnvironment.assertUsable();
      } else {
        expect(ApiEnvironment.PROFILE).assertEqual('develop-blocked');
        expect(ApiEnvironment.NETWORK_ENABLED).assertFalse();
        expect(ApiEnvironment.API_ORIGIN.endsWith('.invalid')).assertTrue();
      }
    });
  });
}
