const crypto = require('crypto');

const { TOKEN_SECRET } = require('./token');

const DEVICE_KEY_ALGORITHM = 'ECDSA_P256_SHA256';
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ACCESS_TOKEN = /^tg_access\.[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN = /^tg_refresh\.[A-Za-z0-9_-]{43}$/;
const CLAIM_TOKEN = /^tg_claim\.[A-Za-z0-9_-]{43}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(domain, value, encoding = 'hex') {
  return crypto.createHmac('sha256', TOKEN_SECRET)
    .update(`tangguan-device-v1\0${domain}\0`, 'utf8')
    .update(String(value), 'utf8')
    .digest(encoding);
}

function deriveSecret(domain, value) {
  return hmac(domain, value, 'base64url');
}

function deriveShortCode(pairingId) {
  let counter = 0;
  const unbiasedLimit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  while (counter < 32) {
    const digest = crypto.createHmac('sha256', TOKEN_SECRET)
      .update(`tangguan-device-v1\0pairing-short-code\0${pairingId}\0${counter}`, 'utf8')
      .digest();
    const candidate = digest.readUInt32BE(0);
    if (candidate < unbiasedLimit) return String(candidate % 1_000_000).padStart(6, '0');
    counter += 1;
  }
  throw new Error('unable to derive pairing code');
}

function shortCodeHmac(shortCode) {
  return hmac('pairing-short-code-lookup', shortCode);
}

function deriveParentChallenge(pairingId) {
  return deriveSecret('pairing-parent-challenge', pairingId);
}

function deriveClaimToken(pairingId, idempotencyKeyHash) {
  return `tg_claim.${deriveSecret('pairing-claim-token', `${pairingId}:${idempotencyKeyHash}`)}`;
}

function deriveProofChallenge(challengeId) {
  return deriveSecret('device-proof-challenge', challengeId);
}

function signingPayload({ purpose, challengeId, challenge, deviceBindingId, sessionId = '' }) {
  const message = [
    'tangguan-device-proof-v1',
    `purpose=${purpose}`,
    `challengeId=${challengeId}`,
    `challenge=${challenge}`,
    `deviceBindingId=${deviceBindingId}`,
    `sessionId=${sessionId}`
  ].join('\n');
  return Buffer.from(message, 'utf8');
}

function canonicalBase64url(value, { minBytes, maxBytes, field }) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    const error = new TypeError(`${field} is not canonical base64url`);
    error.field = field;
    throw error;
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value
      || decoded.length < minBytes || decoded.length > maxBytes) {
    const error = new TypeError(`${field} is not canonical base64url`);
    error.field = field;
    throw error;
  }
  return decoded;
}

function parseDevicePublicKey(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.algorithm !== DEVICE_KEY_ALGORITHM) {
    throw new TypeError('unsupported device public key algorithm');
  }
  const der = canonicalBase64url(input.spkiBase64url, {
    minBytes: 80,
    maxBytes: 160,
    field: 'publicKey.spkiBase64url'
  });
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
    throw new TypeError('device public key must use P-256');
  }
  const canonicalDer = key.export({ format: 'der', type: 'spki' });
  if (der.length !== canonicalDer.length || !crypto.timingSafeEqual(der, canonicalDer)) {
    throw new TypeError('device public key is not canonical SPKI');
  }
  return {
    algorithm: DEVICE_KEY_ALGORITHM,
    spkiBase64url: canonicalDer.toString('base64url'),
    sha256: sha256(canonicalDer),
    key
  };
}

function publicKeyObject(spkiBase64url) {
  const der = Buffer.from(spkiBase64url, 'base64url');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function verifyDeviceSignature({ publicKeySpki, payload, signatureBase64url }) {
  try {
    const signature = canonicalBase64url(signatureBase64url, {
      minBytes: 64,
      maxBytes: 80,
      field: 'signatureBase64url'
    });
    return crypto.verify('sha256', payload, publicKeyObject(publicKeySpki), signature);
  } catch (_) {
    return false;
  }
}

function deriveAccessToken(sessionId) {
  return `tg_access.${deriveSecret('session-access-token', sessionId)}`;
}

function deriveRefreshToken(sessionId) {
  return `tg_refresh.${deriveSecret('session-refresh-token', sessionId)}`;
}

function digestCredential(value) {
  return sha256(Buffer.from(String(value), 'utf8'));
}

function timingSafeHexEqual(left, right) {
  if (!HEX_SHA256.test(String(left)) || !HEX_SHA256.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

module.exports = {
  DEVICE_KEY_ALGORITHM,
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CLAIM_TOKEN,
  sha256,
  hmac,
  deriveSecret,
  deriveShortCode,
  shortCodeHmac,
  deriveParentChallenge,
  deriveClaimToken,
  deriveProofChallenge,
  signingPayload,
  parseDevicePublicKey,
  verifyDeviceSignature,
  deriveAccessToken,
  deriveRefreshToken,
  digestCredential,
  timingSafeHexEqual
};
