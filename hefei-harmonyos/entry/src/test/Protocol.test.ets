import { describe, expect, it } from '@ohos/hypium';
import { normalizeEcdsaSignature } from '../main/ets/security/Encoding';
import {
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
  });
}
