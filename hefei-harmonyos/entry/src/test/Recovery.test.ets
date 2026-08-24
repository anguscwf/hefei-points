import { describe, expect, it } from '@ohos/hypium';
import { ApiEnvironment } from '../main/ets/config/ApiEnvironment';
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
  ProofDto,
  ProofResponse,
  RefreshResponse,
  SessionDto,
  SummaryResponse,
  TransactionsResponse,
  VerifiedProof
} from '../main/ets/network/ApiContracts';
import { DeviceIdentity } from '../main/ets/security/DeviceIdentity';
import { SessionVault } from '../main/ets/security/SessionVault';
import {
  ChildApiPort,
  ChildSessionCoordinator,
  DeviceIdentityPort,
  DeviceProofVerifierPort,
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
}

async function initializedCoordinator(api: ChildApiPort,
  vault: FakeVault): Promise<ChildSessionCoordinator> {
  const coordinator: ChildSessionCoordinator = new ChildSessionCoordinator(
    api,
    new FakeIdentity(),
    vault,
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

    it('keeps production networking disabled and compiles security adapters', 0, () => {
      const identity: DeviceIdentity = new DeviceIdentity();
      const vault: SessionVault = new SessionVault();
      const transport: FailingTransport = new FailingTransport(
        new ChildApiError('SYNTHETIC_FAILURE', 0, false, false)
      );
      const api: ChildApiClient = new ChildApiClient(transport);
      expect(identity instanceof DeviceIdentity).assertTrue();
      expect(vault instanceof SessionVault).assertTrue();
      expect(api instanceof ChildApiClient).assertTrue();
      expect(ApiEnvironment.NETWORK_ENABLED).assertFalse();
    });
  });
}
