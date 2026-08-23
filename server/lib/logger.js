const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: { service: 'hefei-points', version: '2.5.0' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
      'password',
      'token',
      'reauthAssertion',
      'tokenHash',
      'idempotencyKey',
      '*.password',
      '*.token',
      '*.reauthAssertion',
      '*.tokenHash',
      '*.idempotencyKey'
    ],
    censor: '[REDACTED]'
  }
});

module.exports = logger;
