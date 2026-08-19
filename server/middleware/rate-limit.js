const AUTH_PATHS = new Set(['/auth', '/wx-login', '/wx-bind']);

function createLimiter({ windowMs, max, message, key }) {
  const attempts = new Map();
  return function limit(req, res, next) {
    const now = Date.now();
    const id = key ? key(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    let entry = attempts.get(id);
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
    entry.count++;
    attempts.set(id, entry);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) return res.status(429).json({ success: false, message });

    if (attempts.size > 1000 || Math.random() < 0.01) {
      for (const [attemptKey, value] of attempts) if (now >= value.resetAt) attempts.delete(attemptKey);
    }
    next();
  };
}

const authLimiter = createLimiter({
  windowMs: 60_000,
  max: 10,
  message: '登录尝试过于频繁，请稍后再试',
  key: req => `${req.ip || req.socket.remoteAddress || 'unknown'}:${String(req.body?.userId || '').toLowerCase()}`
});

const ordinaryApiLimiter = createLimiter({
  windowMs: 60_000,
  max: 60,
  message: '请求过于频繁，请稍后再试'
});

function apiLimiter(req, res, next) {
  if (AUTH_PATHS.has(req.path)) return next();
  return ordinaryApiLimiter(req, res, next);
}

const joinRateLimit = createLimiter({
  windowMs: 60 * 60_000,
  max: 10,
  message: '加入家庭尝试次数过多，1小时后再试',
  key: req => {
    const { verifyToken, getToken } = require('../lib/token');
    const user = verifyToken(getToken(req));
    return user?.id || req.ip || req.socket.remoteAddress || 'unknown';
  }
});

module.exports = { authLimiter, apiLimiter, joinRateLimit };
