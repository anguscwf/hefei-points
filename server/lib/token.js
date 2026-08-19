const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('../db/connection');
const { users } = require('../db/repositories');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
let TOKEN_SECRET;
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    TOKEN_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, TOKEN_SECRET, 'utf8');
  }
} catch (e) {
  TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
}

// ============== Token 工具 ==============
function signToken(userId, role, familyId) {
  const ts = Date.now();
  const payload = `${userId}.${role}.${familyId || 'default'}.${ts}`;
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
  return `hefei.${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  // 兼容 v3 token（4段）和 v4 token（5段）
  if (parts.length === 5 && parts[0] === 'hefei') {
    // v3: hefei.userId.role.ts.sig
    const [_, userId, role, ts, sig] = parts;
    const payload = `${userId}.${role}.${ts}`;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    const issuedAt = Number(ts);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Date.now() + 60_000) return null;
    const age = Date.now() - issuedAt;
    if (age > 30 * 24 * 60 * 60 * 1000) return null;
    const user = users.findById(userId);
    if (user && issuedAt <= user.tokensValidAfter) return null;
    return user ? { ...user, familyId: user.familyId || 'default' } : null;
  } else if (parts.length === 6 && parts[0] === 'hefei') {
    // v4: hefei.userId.role.familyId.ts.sig
    const [_, userId, role, familyId, ts, sig] = parts;
    const payload = `${userId}.${role}.${familyId}.${ts}`;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    const issuedAt = Number(ts);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Date.now() + 60_000) return null;
    const age = Date.now() - issuedAt;
    if (age > 30 * 24 * 60 * 60 * 1000) return null;
    const user = users.findById(userId);
    if (user && issuedAt <= user.tokensValidAfter) return null;
    // Token 中的 role/familyId 仅参与旧 Token 签名兼容，不作为当前权限来源。
    // 用户被踢出、离开或转移家庭后，立即采用数据库中的最新身份。
    return user ? { ...user, familyId: user.familyId || 'default' } : null;
  }
  return null;
}

function requireRole(token, allowedRoles) {
  const user = verifyToken(token);
  if (!user) return null;
  return allowedRoles.includes(user.role) ? user : null;
}

function getToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.body?.token || req.query?.token || '';
}

// ============== 密码哈希（scrypt + salt，兼容旧SHA256） ==============
function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPwd(pwd, stored) {
  if (!stored.includes(':')) {
    // 旧格式（纯SHA256）兼容：验证通过后由调用方静默升级
    return crypto.createHash('sha256').update(pwd).digest('hex') === stored;
  }
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pwd, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}
function isHashed(pwd) {
  return pwd && (pwd.includes(':') || (pwd.length === 64 && /^[a-f0-9]{64}$/.test(pwd)));
}

module.exports = {
  TOKEN_SECRET,
  signToken,
  verifyToken,
  requireRole,
  getToken,
  hashPwd,
  verifyPwd,
  isHashed
};
