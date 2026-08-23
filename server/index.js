const express = require('express');
const helmet = require('helmet');
const path = require('path');
const env = require('./config/env');
const logger = require('./lib/logger');
const { authLimiter, apiLimiter } = require('./middleware/rate-limit');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Forwarded addresses affect authentication throttles and pairing lockouts.
  // Trust none by default; deployments must name their actual proxy CIDRs/IPs.
  app.set('trust proxy', env.trustedProxies);

  // 现有 Web 页面使用内联脚本；暂不启用默认 CSP，其余 Helmet 安全头正常生效。
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(require('./middleware/cache-control'));
  app.use(require('./middleware/request-logger'));
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(require('./routes/health'));

  app.use(['/api/auth', '/api/wx-login', '/api/wx-bind', '/api/v2/reauth-assertions'], authLimiter);
  app.use('/api', apiLimiter);

  require('./config/defaults').initData();

  app.use('/api', require('./routes/auth'));
  app.use('/api', require('./routes/points'));
  app.use('/api', require('./routes/history'));
  app.use('/api', require('./routes/family'));
  app.use('/api', require('./routes/config'));
  app.use('/api', require('./routes/backup'));
  app.use('/api', require('./routes/v2-guardian-consents'));
  app.use('/api', require('./routes/v2-device-pairing-sessions'));
  app.use('/api', require('./routes/v2-child-self'));
  app.use('/api', require('./routes/v2-point-requests'));
  app.use('/api', require('./routes/v2-data-rights'));

  app.use((req, res) => {
    const v2 = req.originalUrl.split('?')[0].startsWith('/api/v2/');
    const body = { success: false, message: '接口不存在' };
    if (v2) {
      body.code = 'NOT_FOUND';
      if (req.requestId) body.requestId = req.requestId;
    }
    res.status(404).json(body);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const pathOnly = req.originalUrl.split('?')[0];
    const v2 = pathOnly.startsWith('/api/v2/');
    const invalidJson = error.type === 'entity.parse.failed';
    const tooLarge = error.type === 'entity.too.large' || error.status === 413;
    const status = invalidJson ? 400 : (tooLarge ? 413 : 500);
    const code = invalidJson
      ? 'INVALID_JSON'
      : (tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR');
    const message = invalidJson
      ? '请求 JSON 格式错误'
      : (tooLarge ? '请求内容过大' : '服务器内部错误');
    (req.log || logger).error({
      event: 'http.error',
      method: req.method,
      path: pathOnly,
      errorType: error.type || 'unexpected'
    }, 'request failed');
    const body = { success: false, message };
    if (v2) {
      body.code = code;
      if (req.requestId) body.requestId = req.requestId;
    }
    return res.status(status).json(body);
  });
  return app;
}

function start() {
  const app = createApp();
  return app.listen(env.port, '0.0.0.0', () => {
    logger.info({ event: 'server.started', port: env.port, environment: env.nodeEnv }, 'server started');
  });
}

if (require.main === module) start();

module.exports = { createApp, start };
