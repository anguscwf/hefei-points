const path = require('path');

function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const rawPort = process.env.PORT || (nodeEnv === 'production' ? '3001' : '3002');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1-65535 的整数');

  if (nodeEnv === 'production') {
    const missing = ['DATA_DIR', 'WX_APPSECRET'].filter(name => !process.env[name]);
    if (missing.length) throw new Error(`生产环境缺少关键变量：${missing.join(', ')}`);
  }

  process.env.NODE_ENV = nodeEnv;
  process.env.PORT = String(port);
  process.env.DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
  return { nodeEnv, port, dataDir: process.env.DATA_DIR };
}

module.exports = loadEnv();
