import { describe, expect, it } from '@ohos/hypium';
import { normalizeEcdsaSignature, utf8Encode } from '../main/ets/security/Encoding';
import {
  parsePointRequestCreateRequest,
  parsePointRequestResponse,
  parseRewardRulesResponse,
  PointRequestCreateRequest,
  PointRequestDto,
  PointRequestResponse,
  PointRequestRuleDto,
  RewardRuleDto,
  RewardRulePageDto,
  RewardRulesResponse,
  parseSummaryResponse,
  parseTransactionsResponse,
  SummaryResponse,
  TransactionDto,
  TransactionPageDto,
  TransactionsResponse,
  verifySigningPayloadText
} from '../main/ets/network/ApiContracts';
import {
  copyEnvelope,
  EnvelopePhase,
  serializeEnvelope,
  SessionEnvelope,
  unpairedEnvelope
} from '../main/ets/session/SessionEnvelope';
import {
  copyPointRequestIntent,
  createPointRequestIntent,
  parsePointRequestIntent,
  PointRequestIntent,
  serializePointRequestIntent
} from '../main/ets/session/PointRequestIntent';

const DEVICE_PUBLIC_ID: string = 'devicepublicid0123456789';
const FUTURE: string = '2099-01-01T00:00:00.000Z';

function proofText(): string {
  const challengeId: string = `proof_${'a'.repeat(32)}`;
  const challenge: string = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
  return [
    'tangguan-device-proof-v1',
    'purpose=pairing_completion',
    `challengeId=${challengeId}`,
    `challenge=${challenge}`,
    `deviceBindingId=device_${'b'.repeat(32)}`,
    'sessionId='
  ].join('\n');
}

export default function protocolTests(): void {
  describe('Harmony child protocol contracts', () => {
    it('verifies the exact six-line server signing payload', 0, () => {
      const challengeId: string = `proof_${'a'.repeat(32)}`;
      const challenge: string = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
      const verified = verifySigningPayloadText(
        proofText(),
        'pairing_completion',
        challengeId,
        challenge
      );
      expect(verified.bindingId).assertEqual(`device_${'b'.repeat(32)}`);
      expect(verified.sessionId).assertEqual('');
    });

    it('normalizes raw P-256 signatures to strict non-zero DER', 0, () => {
      const raw: Uint8Array = new Uint8Array(64);
      raw.fill(1, 0, 32);
      raw.fill(2, 32, 64);
      const der: Uint8Array = normalizeEcdsaSignature(raw);
      expect(der[0]).assertEqual(0x30);
      expect(der.length).assertEqual(70);

      let rejected: boolean = false;
      try {
        normalizeEcdsaSignature(new Uint8Array(64));
      } catch (_) {
        rejected = true;
      }
      expect(rejected).assertTrue();
    });

    it('accepts legacy short transaction and rule identifiers', 0, () => {
      const transaction: TransactionDto = {
        id: 'x',
        occurredAt: '2026-08-25T00:00:00.000Z',
        amount: 1,
        reason: '合成流水',
        ruleId: 'r',
        categoryId: 'c'
      };
      const page: TransactionPageDto = { limit: 20, hasMore: false, nextCursor: null };
      const input: TransactionsResponse = {
        success: true,
        transactions: [transaction],
        page
      };
      const response: TransactionsResponse = parseTransactionsResponse(JSON.stringify(input));
      expect(response.transactions[0].id).assertEqual('x');
      expect(response.transactions[0].ruleId).assertEqual('r');
    });

    it('accepts a two-character child identifier from the existing identity domain', 0, () => {
      const input: SummaryResponse = {
        success: true,
        child: { id: 'c1', name: '合成孩子' },
        points: { balance: 8 }
      };
      const summary: SummaryResponse = parseSummaryResponse(JSON.stringify(input));
      expect(summary.child.id).assertEqual('c1');
      expect(summary.points.balance).assertEqual(8);
    });

    it('round-trips the complete pairing recovery intent without losing bytes', 0, () => {
      const value: SessionEnvelope = unpairedEnvelope(DEVICE_PUBLIC_ID);
      value.phase = EnvelopePhase.COMPLETE_RESULT_UNKNOWN;
      value.claimToken = `tg_claim.${'c'.repeat(43)}`;
      value.proofExpiresAt = FUTURE;
      value.proofBindingId = `device_${'d'.repeat(32)}`;
      value.completeSignature = 'S'.repeat(86);
      value.completeIdempotencyKey = 'pair-complete-0001';
      const restored: SessionEnvelope = copyEnvelope(value);
      expect(serializeEnvelope(restored)).assertEqual(serializeEnvelope(value));
      expect(restored.completeSignature).assertEqual(value.completeSignature);
      expect(restored.completeIdempotencyKey).assertEqual(value.completeIdempotencyKey);
    });

    it('rejects credentials carried in an unrelated local state phase', 0, () => {
      const value: SessionEnvelope = unpairedEnvelope(DEVICE_PUBLIC_ID);
      value.accessToken = `tg_access.${'a'.repeat(43)}`;
      let rejected: boolean = false;
      try {
        serializeEnvelope(value);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'LOCAL_STATE_CORRUPT';
      }
      expect(rejected).assertTrue();
    });

    it('strictly parses paged reward rules and rejects identity leakage', 0, () => {
      const rule: RewardRuleDto = {
        id: 'reward_synthetic',
        categoryId: 'category_synthetic',
        categoryLabel: '合成分类',
        label: '合成任务',
        unit: '每次',
        minPoints: 1,
        defaultPoints: 4,
        maxPoints: 8
      };
      const page: RewardRulePageDto = { limit: 50, hasMore: false, nextCursor: null };
      const input: RewardRulesResponse = {
        success: true,
        revision: 2,
        rewardRules: [rule],
        page
      };
      const response: RewardRulesResponse = parseRewardRulesResponse(JSON.stringify(input));
      expect(response.rewardRules[0].id).assertEqual('reward_synthetic');

      let rejected: boolean = false;
      try {
        parseRewardRulesResponse([
          '{"success":true,"revision":2,"rewardRules":[],',
          '"page":{"limit":50,"hasMore":false,"nextCursor":null},',
          '"familyId":"synthetic-family"}'
        ].join(''));
      } catch (_) {
        rejected = true;
      }
      expect(rejected).assertTrue();
    });

    it('persists a binding-scoped exact point request within the secure byte budget', 0, () => {
      const requestInput: PointRequestCreateRequest = {
        clientRequestId: 'hmos-point-client-synthetic-0001',
        ruleId: 'reward_synthetic',
        requestedPoints: 4,
        description: '合'.repeat(120)
      };
      const body: PointRequestCreateRequest = parsePointRequestCreateRequest(
        JSON.stringify(requestInput)
      );
      const intent: PointRequestIntent = createPointRequestIntent(
        `device_${'d'.repeat(32)}`,
        body,
        'point-create-idempotency-0001'
      );
      const restored: PointRequestIntent = copyPointRequestIntent(intent);
      expect(restored.bindingId).assertEqual(intent.bindingId);
      expect(restored.bodyJson).assertEqual(intent.bodyJson);
      expect(restored.idempotencyKey).assertEqual(intent.idempotencyKey);
      expect(utf8Encode(serializePointRequestIntent(restored)).length < 1024).assertTrue();

      const escapedBody: PointRequestCreateRequest = {
        clientRequestId: 'c'.repeat(128),
        ruleId: 'r'.repeat(128),
        requestedPoints: 1000,
        description: String.fromCharCode(92, 34).repeat(60)
      };
      const escapedIntent: PointRequestIntent = createPointRequestIntent(
        'b'.repeat(128), escapedBody, 'k'.repeat(128)
      );
      expect(utf8Encode(serializePointRequestIntent(escapedIntent)).length < 1024).assertTrue();

      let rejectedUnknownField: boolean = false;
      try {
        const serialized: string = serializePointRequestIntent(restored);
        parsePointRequestIntent(`${serialized.substring(0, serialized.length - 1)},"x":1}`);
      } catch (_) {
        rejectedUnknownField = true;
      }
      expect(rejectedUnknownField).assertTrue();
    });

    it('requires a created point request to echo the originating client request', 0, () => {
      const clientRequestId: string = 'hmos-point-client-synthetic-0001';
      const rule: PointRequestRuleDto = {
        id: 'reward_synthetic',
        categoryId: 'category_synthetic',
        label: '合成任务',
        categoryLabel: '合成分类',
        unit: '每次',
        minPoints: 1,
        defaultPoints: 4,
        maxPoints: 8,
        revision: 2
      };
      const pointRequest: PointRequestDto = {
        id: `point_request_${'1'.repeat(32)}`,
        status: 'pending',
        revision: 0,
        rule,
        requestedPoints: 4,
        approvedPoints: null,
        description: '合成文字申报',
        occurredAt: '2026-08-25T00:00:00.000Z',
        duplicateSuspected: false,
        requestInfo: null,
        decision: null,
        submittedAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
        clientRequestId
      };
      const input: PointRequestResponse = {
        success: true,
        pointRequest
      };
      const response: PointRequestResponse = parsePointRequestResponse(
        JSON.stringify(input), clientRequestId
      );
      expect(response.pointRequest.clientRequestId).assertEqual(clientRequestId);

      let rejectedWrongClient: boolean = false;
      try {
        parsePointRequestResponse(JSON.stringify(input), 'hmos-point-client-different-0001');
      } catch (_) {
        rejectedWrongClient = true;
      }
      expect(rejectedWrongClient).assertTrue();

      let rejectedIdentityLeak: boolean = false;
      try {
        const leaked: string = JSON.stringify(input).replace(
          '"success":true', '"success":true,"childId":"synthetic-child"'
        );
        parsePointRequestResponse(leaked, clientRequestId);
      } catch (_) {
        rejectedIdentityLeak = true;
      }
      expect(rejectedIdentityLeak).assertTrue();
    });
  });
}
