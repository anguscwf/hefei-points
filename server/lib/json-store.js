const { DATA_DIR, DB_FILE, getDb, inTransaction } = require('../db/connection');

// 兼容仍调用 withLock 的旧扩展代码；核心数据一致性由 SQLite 事务保证。
const LOCK_NAMES = Object.freeze({
  configFileLock: 'configFileLock',
  pointsFileLock: 'pointsFileLock',
  historyFileLock: 'historyFileLock',
  databaseFileLock: 'databaseFileLock'
});
const locks = new Map();

function normalizeLockName(key) {
  if (Object.values(LOCK_NAMES).includes(key)) return key;
  if (/history/i.test(key)) return LOCK_NAMES.historyFileLock;
  if (/points/i.test(key)) return LOCK_NAMES.pointsFileLock;
  if (/config|family|child|wx_bind/i.test(key)) return LOCK_NAMES.configFileLock;
  return LOCK_NAMES.databaseFileLock;
}

async function withLock(key, work) {
  const name = normalizeLockName(key);
  const previous = locks.get(name) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(name, current);
  try {
    await previous;
    return await work();
  } finally {
    release();
    if (locks.get(name) === current) locks.delete(name);
  }
}

module.exports = { DATA_DIR, DB_FILE, LOCK_NAMES, withLock, getDb, inTransaction };
