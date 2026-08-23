const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: { service: 'hefei-points', version: '2.5.0' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'authorization',
      'headers.authorization',
      "headers['idempotency-key']",
      'req.headers.authorization',
      "req.headers['idempotency-key']",
      'password',
      'token',
      'reauthAssertion',
      'accessToken',
      'refreshToken',
      'shortCode',
      'pairingChallenge',
      'claimId',
      'claimToken',
      'challenge',
      'signingPayload',
      'signatureBase64url',
      'devicePublicId',
      'devicePublicKeySpki',
      'spkiBase64url',
      'tokenHash',
      'idempotencyKey',
      '*.password',
      '*.token',
      '*.reauthAssertion',
      '*.accessToken',
      '*.refreshToken',
      '*.shortCode',
      '*.pairingChallenge',
      '*.claimId',
      '*.claimToken',
      '*.challenge',
      '*.signingPayload',
      '*.signatureBase64url',
      '*.devicePublicId',
      '*.devicePublicKeySpki',
      '*.spkiBase64url',
      '*.tokenHash',
      '*.idempotencyKey',
      'body.publicKey.spkiBase64url',
      'body.session.accessToken',
      'body.session.refreshToken',
      'body.proof.challenge',
      'body.proof.signingPayload',
      "body.headers['idempotency-key']"
    ],
    censor: '[REDACTED]'
  }
});

module.exports = logger;
