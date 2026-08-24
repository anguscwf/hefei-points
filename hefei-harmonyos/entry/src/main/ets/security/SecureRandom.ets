import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { base64urlEncode } from './Encoding';

export function randomBase64url(byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new Error('RANDOM_LENGTH_INVALID');
  }
  try {
    const random: cryptoFramework.Random = cryptoFramework.createRandom();
    return base64urlEncode(random.generateRandomSync(byteLength).data);
  } catch (_) {
    throw new Error('SECURE_RANDOM_UNAVAILABLE');
  }
}

export function newDevicePublicId(): string {
  return randomBase64url(24);
}

export function newIdempotencyKey(operation: string): string {
  if (!/^[a-z0-9-]{3,24}$/.test(operation)) {
    throw new Error('IDEMPOTENCY_OPERATION_INVALID');
  }
  return `hmos-${operation}-${randomBase64url(24)}`;
}
