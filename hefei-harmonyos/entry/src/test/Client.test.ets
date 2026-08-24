import { describe, expect, it } from '@ohos/hypium';
import {
  ApiTransport,
  ChildApiClient,
  ChildApiError,
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

      expect(transport.requests.length).assertEqual(6);
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

      expect(errors[0].outcomeUnknown).assertTrue();
      expect(errors[1].outcomeUnknown).assertTrue();
      expect(errors[2].outcomeUnknown).assertTrue();
      expect(errors[3].outcomeUnknown).assertTrue();
      expect(errors[4].outcomeUnknown).assertFalse();
      expect(errors[5].outcomeUnknown).assertFalse();
      expect(errors[0].code).assertEqual('PROTOCOL_ERROR');
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
