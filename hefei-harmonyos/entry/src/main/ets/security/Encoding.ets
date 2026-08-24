import { util } from '@kit.ArkTS';

const BASE64URL_PATTERN: RegExp = /^[A-Za-z0-9_-]+$/;
const P256_SPKI_PREFIX: Array<number> = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01,
  0x07, 0x03, 0x42, 0x00, 0x04
];

export function utf8Encode(value: string): Uint8Array {
  const encoder: util.TextEncoder = new util.TextEncoder();
  return encoder.encodeInto(value);
}

export function utf8Decode(value: Uint8Array): string {
  const decoder: util.TextDecoder = util.TextDecoder.create('utf-8', {
    fatal: true,
    ignoreBOM: true
  });
  return decoder.decodeToString(value);
}

export function base64urlEncode(value: Uint8Array): string {
  const helper: util.Base64Helper = new util.Base64Helper();
  return helper.encodeToStringSync(value, util.Type.BASIC_URL_SAFE).replace(/=+$/g, '');
}

export function base64urlDecode(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error('BASE64URL_INVALID');
  }
  const remainder: number = value.length % 4;
  if (remainder === 1) {
    throw new Error('BASE64URL_INVALID');
  }
  const padding: string = remainder === 0 ? '' : remainder === 2 ? '==' : '=';
  const helper: util.Base64Helper = new util.Base64Helper();
  const decoded: Uint8Array = helper.decodeSync(`${value}${padding}`, util.Type.BASIC_URL_SAFE);
  if (base64urlEncode(decoded) !== value) {
    throw new Error('BASE64URL_NON_CANONICAL');
  }
  return decoded;
}

export function isCanonicalBase64url(value: string, minBytes: number, maxBytes: number): boolean {
  try {
    const decoded: Uint8Array = base64urlDecode(value);
    return decoded.length >= minBytes && decoded.length <= maxBytes;
  } catch (_) {
    return false;
  }
}

export function assertP256Spki(value: Uint8Array): void {
  if (value.length !== 91) {
    throw new Error('DEVICE_KEY_INVALID');
  }
  for (let index: number = 0; index < P256_SPKI_PREFIX.length; index += 1) {
    if (value[index] !== P256_SPKI_PREFIX[index]) {
      throw new Error('DEVICE_KEY_INVALID');
    }
  }
}

function canonicalInteger(raw: Uint8Array): Uint8Array {
  let start: number = 0;
  while (start < raw.length - 1 && raw[start] === 0) {
    start += 1;
  }
  const needsPositivePrefix: boolean = (raw[start] & 0x80) !== 0;
  const result: Uint8Array = new Uint8Array(raw.length - start + (needsPositivePrefix ? 1 : 0));
  const offset: number = needsPositivePrefix ? 1 : 0;
  for (let index: number = start; index < raw.length; index += 1) {
    result[offset + index - start] = raw[index];
  }
  return result;
}

function isCanonicalDerSignature(value: Uint8Array): boolean {
  if (value.length < 64 || value.length > 72 || value[0] !== 0x30 || value[1] !== value.length - 2) {
    return false;
  }
  if (value[2] !== 0x02) {
    return false;
  }
  const rLength: number = value[3];
  const sTagIndex: number = 4 + rLength;
  if (rLength < 1 || rLength > 33 || sTagIndex + 2 > value.length || value[sTagIndex] !== 0x02) {
    return false;
  }
  const sLength: number = value[sTagIndex + 1];
  if (sLength < 1 || sLength > 33 || sTagIndex + 2 + sLength !== value.length) {
    return false;
  }
  const rStart: number = 4;
  const sStart: number = sTagIndex + 2;
  if ((value[rStart] & 0x80) !== 0 || (value[sStart] & 0x80) !== 0) {
    return false;
  }
  if ((rLength > 1 && value[rStart] === 0 && (value[rStart + 1] & 0x80) === 0)
      || (sLength > 1 && value[sStart] === 0 && (value[sStart + 1] & 0x80) === 0)) {
    return false;
  }
  let rNonZero: boolean = false;
  let sNonZero: boolean = false;
  for (let index: number = 0; index < rLength; index += 1) {
    rNonZero = rNonZero || value[rStart + index] !== 0;
  }
  for (let index: number = 0; index < sLength; index += 1) {
    sNonZero = sNonZero || value[sStart + index] !== 0;
  }
  if (!rNonZero || !sNonZero) {
    return false;
  }
  return true;
}

export function normalizeEcdsaSignature(value: Uint8Array): Uint8Array {
  if (isCanonicalDerSignature(value)) {
    return value;
  }
  if (value.length !== 64) {
    throw new Error('DEVICE_SIGNATURE_INVALID');
  }
  const r: Uint8Array = canonicalInteger(value.slice(0, 32));
  const s: Uint8Array = canonicalInteger(value.slice(32, 64));
  const sequenceLength: number = 4 + r.length + s.length;
  const der: Uint8Array = new Uint8Array(sequenceLength + 2);
  der[0] = 0x30;
  der[1] = sequenceLength;
  der[2] = 0x02;
  der[3] = r.length;
  der.set(r, 4);
  const sOffset: number = 4 + r.length;
  der[sOffset] = 0x02;
  der[sOffset + 1] = s.length;
  der.set(s, sOffset + 2);
  if (!isCanonicalDerSignature(der)) {
    throw new Error('DEVICE_SIGNATURE_INVALID');
  }
  return der;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference: number = 0;
  for (let index: number = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
