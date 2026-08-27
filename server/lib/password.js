const crypto = require('node:crypto');

// Password verifiers are deliberately independent from token signing. Importing
// this module has no filesystem side effects, which lets the synthetic bootstrap
// hash its one stdin credential without creating the runtime token secret.
function hashPwd(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPwd(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored) return false;
  if (!stored.includes(':')) {
    // Legacy SHA-256 remains read-compatible. Successful adult login upgrades
    // it through the existing auth route; bootstrap never writes this format.
    return /^[0-9a-f]{64}$/.test(stored)
      && crypto.createHash('sha256').update(password).digest('hex') === stored;
  }
  const parts = stored.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/.test(parts[0])
      || !/^[0-9a-f]{128}$/.test(parts[1])) return false;
  const test = crypto.scryptSync(password, parts[0], 64);
  const expected = Buffer.from(parts[1], 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

function isHashed(password) {
  return typeof password === 'string'
    && (/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(password)
      || /^[0-9a-f]{64}$/.test(password));
}

module.exports = { hashPwd, verifyPwd, isHashed };
