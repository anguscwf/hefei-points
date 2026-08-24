import { describe, expect, it } from '@ohos/hypium';
import {
  ApiTransport,
  ChildApiClient,
  ChildApiError,
  isAllowedTransportRequest,
  TransportRequest,
  TransportResponse
} from '../main/ets/network/ApiClient';
import {
  ClaimPairingRequest,
  SessionDto
} from '../main/ets/network/ApiContracts';

class RecordingTransport implements ApiTransport {
  readonly requests: Array<TransportRequest> = [];

  async request(value: TransportRequest): Promise<TransportResponse> {
    this.requests.push(value);
    return { status: 200, body: '{}' };
  }
}

class FixedResponseTransport implements ApiTransport {
  private readonly response: TransportResponse;

  constructor(response: TransportResponse) {
    this.response = response;
  }

  async request(_value: TransportRequest): Promise<TransportResponse> {
    return this.response;
  }
}

async function captureProtocolError(operation: Promise<Object>): Promise<ChildApiError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof ChildApiError) {
      return error;
    }
    throw new Error('UNEXPECTED_TEST_ERROR');
  }
  throw new Error('EXPECTED_PROTOCOL_ERROR');
}

function syntheticSession(): SessionDto {
  return {
    id: `session_${'s'.repeat(32)}`,
    accessToken: `tg_access.${'a'.repeat(43)}`,
    accessExpiresAt: '2098-12-01T00:00:00.000Z',
    refreshToken: `tg_refresh.${'r'.repeat(43)}`,
    refreshExpiresAt: '2099-01-01T00:00:00.000Z',
    rotationCounter: 2
  };
}

export default function clientTests(): void {
  describe('Harmony child API wire contract', () => {
    it('uses the exact route, credential and idempotency matrix', 0, async () => {
      const transport: RecordingTransport = new RecordingTransport();
      const client: ChildApiClient = new ChildApiClient(transport);
      const claim: ClaimPairingRequest = {
        shortCode: '123456',
        devicePublicId: 'devicepublicid0123456789',
        deviceAlias: 'HarmonyOS 手机',
        publicKey: {
          algorithm: 'ECDSA_P256_SHA256',
          spkiBase64url: 'P'.repeat(122)
        }
      };
      const session: SessionDto = syntheticSession();
      const errors: Array<ChildApiError> = [];

      errors.push(await captureProtocolError(client.claimPairing(claim, 'claim-idempotency-0001')));
      errors.push(await captureProtocolError(client.completePairing(
        `tg_claim.${'c'.repeat(43)}`,
        'S'.repeat(86),
        'complete-idempotency-0001',
        claim.devicePublicId,
        `device_${'d'.repeat(32)}`
      )));
      errors.push(await captureProtocolError(client.issueRefreshChallenge(
        `device_${'d'.repeat(32)}`,
        session,
        'issue-idempotency-0001'
      )));
      errors.push(await captureProtocolError(client.refreshSession(
        session,
        `refresh_proof_${'p'.repeat(32)}`,
        'Q'.repeat(86),
        'refresh-idempotency-0001'
      )));
      errors.push(await captureProtocolError(client.getSummary(session.accessToken)));
      errors.push(await captureProtocolError(client.getTransactions(
        session.accessToken,
        20,
        'A'.repeat(92)
      )));
      errors.push(await captureProtocolError(client.getRewardRules(
        session.accessToken,
        50,
        'B'.repeat(120)
      )));
      errors.push(await captureProtocolError(client.createPointRequest(
        session.accessToken,
        JSON.stringify({
          clientRequestId: 'hmos-point-client-synthetic-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成文字申报'
        }),
        'point-create-idempotency-0001'
      )));
      errors.push(await captureProtocolError(client.getPointRequests(
        session.accessToken,
        20,
        'C'.repeat(120)
      )));

      expect(transport.requests.length).assertEqual(9);
      expect(transport.requests[0].method).assertEqual('POST');
      expect(transport.requests[0].path).assertEqual('/api/v2/device-pairings/claim-by-code');
      expect(transport.requests[0].body).assertContain('"shortCode":"123456"');
      expect(transport.requests[0].bearer).assertEqual('');
      expect(transport.requests[0].idempotencyKey).assertEqual('claim-idempotency-0001');
      expect(transport.requests[0].mutating).assertTrue();

      expect(transport.requests[1].path).assertEqual('/api/v2/device-pairings/claim/complete');
      expect(transport.requests[1].method).assertEqual('POST');
      expect(transport.requests[1].body).assertEqual(`{"signatureBase64url":"${'S'.repeat(86)}"}`);
      expect(transport.requests[1].bearer).assertEqual(`tg_claim.${'c'.repeat(43)}`);
      expect(transport.requests[1].idempotencyKey).assertEqual('complete-idempotency-0001');
      expect(transport.requests[1].mutating).assertTrue();

      expect(transport.requests[2].path).assertEqual(
        `/api/v2/devices/device_${'d'.repeat(32)}/session-challenges`
      );
      expect(transport.requests[2].method).assertEqual('POST');
      expect(transport.requests[2].body).assertEqual('');
      expect(transport.requests[2].bearer).assertEqual(session.refreshToken);
      expect(transport.requests[2].idempotencyKey).assertEqual('issue-idempotency-0001');
      expect(transport.requests[2].mutating).assertTrue();

      expect(transport.requests[3].path).assertEqual('/api/v2/device-sessions/refresh');
      expect(transport.requests[3].method).assertEqual('POST');
      expect(transport.requests[3].body).assertContain(`"challengeId":"refresh_proof_${'p'.repeat(32)}"`);
      expect(transport.requests[3].body).assertContain(`"signatureBase64url":"${'Q'.repeat(86)}"`);
      expect(transport.requests[3].bearer).assertEqual(session.refreshToken);
      expect(transport.requests[3].idempotencyKey).assertEqual('refresh-idempotency-0001');
      expect(transport.requests[3].mutating).assertTrue();

      expect(transport.requests[4].method).assertEqual('GET');
      expect(transport.requests[4].path).assertEqual('/api/v2/me/summary');
      expect(transport.requests[4].bearer).assertEqual(session.accessToken);
      expect(transport.requests[4].idempotencyKey).assertEqual('');
      expect(transport.requests[4].mutating).assertFalse();

      expect(transport.requests[5].method).assertEqual('GET');
      expect(transport.requests[5].path).assertEqual(
        `/api/v2/me/transactions?limit=20&cursor=${'A'.repeat(92)}`
      );
      expect(transport.requests[5].bearer).assertEqual(session.accessToken);
      expect(transport.requests[5].idempotencyKey).assertEqual('');
      expect(transport.requests[5].mutating).assertFalse();

      expect(transport.requests[6].method).assertEqual('GET');
      expect(transport.requests[6].path).assertEqual(
        `/api/v2/me/reward-rules?limit=50&cursor=${'B'.repeat(120)}`
      );
      expect(transport.requests[6].bearer).assertEqual(session.accessToken);
      expect(transport.requests[6].idempotencyKey).assertEqual('');
      expect(transport.requests[6].mutating).assertFalse();

      expect(transport.requests[7].method).assertEqual('POST');
      expect(transport.requests[7].path).assertEqual('/api/v2/point-requests');
      expect(transport.requests[7].body).assertContain('"ruleId":"reward_synthetic"');
      expect(transport.requests[7].bearer).assertEqual(session.accessToken);
      expect(transport.requests[7].idempotencyKey)
        .assertEqual('point-create-idempotency-0001');
      expect(transport.requests[7].mutating).assertTrue();

      expect(transport.requests[8].method).assertEqual('GET');
      expect(transport.requests[8].path).assertEqual(
        `/api/v2/me/point-requests?limit=20&cursor=${'C'.repeat(120)}`
      );
      expect(transport.requests[8].bearer).assertEqual(session.accessToken);
      expect(transport.requests[8].idempotencyKey).assertEqual('');
      expect(transport.requests[8].mutating).assertFalse();

      expect(errors[0].outcomeUnknown).assertTrue();
      expect(errors[1].outcomeUnknown).assertTrue();
      expect(errors[2].outcomeUnknown).assertTrue();
      expect(errors[3].outcomeUnknown).assertTrue();
      expect(errors[4].outcomeUnknown).assertFalse();
      expect(errors[5].outcomeUnknown).assertFalse();
      expect(errors[6].outcomeUnknown).assertFalse();
      expect(errors[7].outcomeUnknown).assertTrue();
      expect(errors[8].outcomeUnknown).assertFalse();
      expect(errors[0].code).assertEqual('PROTOCOL_ERROR');
    });

    it('allows child point creation only through the exact POST matrix', 0, () => {
      const session: SessionDto = syntheticSession();
      const create: TransportRequest = {
        method: 'POST',
        path: '/api/v2/point-requests',
        body: '{"synthetic":true}',
        bearer: session.accessToken,
        idempotencyKey: 'point-create-idempotency-0001',
        mutating: true
      };
      expect(isAllowedTransportRequest(create)).assertTrue();
      expect(isAllowedTransportRequest({
        method: 'GET',
        path: create.path,
        body: '',
        bearer: session.accessToken,
        idempotencyKey: '',
        mutating: false
      })).assertFalse();
      expect(isAllowedTransportRequest({
        method: 'POST',
        path: create.path,
        body: create.body,
        bearer: session.accessToken,
        idempotencyKey: '',
        mutating: true
      })).assertFalse();
      expect(isAllowedTransportRequest({
        method: 'POST',
        path: create.path,
        body: create.body,
        bearer: session.accessToken,
        idempotencyKey: create.idempotencyKey,
        mutating: false
      })).assertFalse();
      expect(isAllowedTransportRequest({
        method: 'GET',
        path: '/api/v2/point-requests?limit=20',
        body: '',
        bearer: session.accessToken,
        idempotencyKey: '',
        mutating: false
      })).assertFalse();
      expect(isAllowedTransportRequest({
        method: 'POST',
        path: '/api/v2/me/point-requests?limit=20',
        body: create.body,
        bearer: session.accessToken,
        idempotencyKey: create.idempotencyKey,
        mutating: true
      })).assertFalse();
      expect(isAllowedTransportRequest({
        method: 'POST',
        path: '/api/v2/device-sessions/refresh',
        body: '{"synthetic":true}',
        bearer: session.accessToken,
        idempotencyKey: 'refresh-idempotency-0001',
        mutating: true
      })).assertFalse();
    });

    it('treats a malformed mutation error response as outcome unknown', 0, async () => {
      const client: ChildApiClient = new ChildApiClient(new FixedResponseTransport({
        status: 409,
        body: '<synthetic-invalid-error>'
      }));
      const error: ChildApiError = await captureProtocolError(client.createPointRequest(
        `tg_access.${'a'.repeat(43)}`,
        JSON.stringify({
          clientRequestId: 'hmos-point-client-synthetic-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成文字申报'
        }),
        'point-create-idempotency-0001'
      ));

      expect(error.code).assertEqual('PROTOCOL_ERROR');
      expect(error.outcomeUnknown).assertTrue();
      expect(error.transient).assertTrue();
    });

    it('keeps a rate-limited point mutation outcome unknown for exact replay', 0, async () => {
      const client: ChildApiClient = new ChildApiClient(new FixedResponseTransport({
        status: 429,
        body: '{"success":false,"code":"RATE_LIMITED","message":"synthetic"}'
      }));
      const error: ChildApiError = await captureProtocolError(client.createPointRequest(
        `tg_access.${'a'.repeat(43)}`,
        JSON.stringify({
          clientRequestId: 'hmos-point-client-rate-limit-0001',
          ruleId: 'reward_synthetic',
          requestedPoints: 4,
          description: '合成限流重放'
        }),
        'point-create-rate-limit-key-0001'
      ));

      expect(error.code).assertEqual('SERVER_UNAVAILABLE');
      expect(error.status).assertEqual(429);
      expect(error.outcomeUnknown).assertTrue();
      expect(error.transient).assertTrue();
    });

    it('rejects a non-canonical transaction cursor before transport', 0, async () => {
      const transport: RecordingTransport = new RecordingTransport();
      const client: ChildApiClient = new ChildApiClient(transport);

      const error: ChildApiError = await captureProtocolError(
        client.getTransactions(`tg_access.${'a'.repeat(43)}`, 20, 'bad/cursor')
      );

      expect(error.code).assertEqual('LOCAL_REQUEST_INVALID');
      expect(error.outcomeUnknown).assertFalse();
      expect(transport.requests.length).assertEqual(0);
    });
  });
}
