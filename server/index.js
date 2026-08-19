const express = require('express');
const helmet = require('helmet');
const path = require('path');
const env = require('./config/env');
const logger = require('./lib/logger');
const { authLimiter, apiLimiter } = require('./middleware/rate-limit');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 现有 Web 页面使用内联脚本；暂不启用默认 CSP，其余 Helmet 安全头正常生效。
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(require('./middleware/cache-control'));
  app.use(require('./middleware/request-logger'));
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(require('./routes/health'));

  app.use(['/api/auth', '/api/wx-login', '/api/wx-bind'], authLimiter);
  app.use('/api', apiLimiter);

  require('./config/defaults').initData();

  app.use('/api', require('./routes/auth'));
  app.use('/api', require('./routes/points'));
  app.use('/api', require('./routes/history'));
  app.use('/api', require('./routes/family'));
  app.use('/api', require('./routes/config'));
  app.use('/api', require('./routes/backup'));

  app.use((req, res) => {
    res.status(404).json({ success: false, message: '接口不存在' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    (req.log || logger).error({ event: 'http.error', method: req.method, path: req.originalUrl.split('?')[0], error: error.message }, 'request failed');
    const status = error.type === 'entity.parse.failed' ? 400 : 500;
    return res.status(status).json({ success: false, message: status === 400 ? '请求 JSON 格式错误' : '服务器内部错误' });
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
