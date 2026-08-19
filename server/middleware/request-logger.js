const crypto = require('crypto');
const logger = require('../lib/logger');

module.exports = function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  req.log = logger.child({ requestId });
  res.set('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    req.log.info({
      event: 'http.request',
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      remoteAddress: req.ip
    }, 'request completed');
  });
  next();
};
