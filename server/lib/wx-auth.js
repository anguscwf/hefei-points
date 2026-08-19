const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const logger = require('./logger');

// ============== 微信配置 ==============
const WX_APPID = process.env.WX_APPID || 'wx90237ce600b51eea';
const WX_APPSECRET = process.env.WX_APPSECRET || (() => {
  try {
    const envFile = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^WX_APPSECRET=(.+)$/);
        if (m) return m[1].trim();
      }
    }
  } catch (e) {}
  logger.warn({ event: 'config.wx_secret_missing' }, 'WX_APPSECRET is missing; wx-login is unavailable');
  return '';
})();

// ============== 微信 code2session ==============
function wxCode2Session(code) {
  return new Promise((resolve, reject) => {
    if (!WX_APPSECRET) {
      return reject(new Error('WX_APPSECRET 未配置'));
    }
    const params = querystring.stringify({
      appid: WX_APPID,
      secret: WX_APPSECRET,
      js_code: code,
      grant_type: 'authorization_code'
    });
    const url = `https://api.weixin.qq.com/sns/jscode2session?${params}`;

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.errcode && data.errcode !== 0) {
            reject(new Error(`微信接口返回错误 ${data.errcode}: ${data.errmsg}`));
          } else if (!data.openid) {
            reject(new Error('微信返回缺少 openid'));
          } else {
            resolve({ openid: data.openid, session_key: data.session_key, unionid: data.unionid });
          }
        } catch (e) {
          reject(new Error('微信返回非 JSON：' + body.slice(0, 100)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('请求微信失败：' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求微信超时')); });
  });
}

module.exports = {
  WX_APPID,
  WX_APPSECRET,
  wxCode2Session
};
