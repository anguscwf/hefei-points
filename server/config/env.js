const path = require('path');

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const rawPort = process.env.PORT || (nodeEnv === 'production' ? '3001' : '3002');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1-65535 的整数');
  const trustedProxies = String(process.env.TRUSTED_PROXIES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const pairingClientIpMode = String(process.env.PAIRING_CLIENT_IP_MODE || '').trim();
  if (pairingClientIpMode && !['direct', 'trusted_proxy'].includes(pairingClientIpMode)) {
    throw new Error('PAIRING_CLIENT_IP_MODE 只能是 direct 或 trusted_proxy');
  }
  if (pairingClientIpMode === 'trusted_proxy' && trustedProxies.length === 0) {
    throw new Error('trusted_proxy 模式必须配置 TRUSTED_PROXIES');
  }

  if (nodeEnv === 'production') {
    const missing = ['DATA_DIR', 'WX_APPSECRET'].filter(name => !process.env[name]);
    if (missing.length) throw new Error(`生产环境缺少关键变量：${missing.join(', ')}`);
    if (enabled(process.env.DEVICE_PAIRING_ENABLED) && !pairingClientIpMode) {
      throw new Error('生产开启设备配对前必须显式配置 PAIRING_CLIENT_IP_MODE');
    }
  }

  process.env.NODE_ENV = nodeEnv;
  process.env.PORT = String(port);
  process.env.DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
  return {
    nodeEnv,
    port,
    dataDir: process.env.DATA_DIR,
    trustedProxies: pairingClientIpMode === 'trusted_proxy' ? trustedProxies : false,
    pairingClientIpMode: pairingClientIpMode || 'unconfigured'
  };
}

module.exports = loadEnv();
