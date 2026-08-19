const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../server/lib/logger');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectDir = path.join(__dirname, '..');
const sourceDir = path.resolve(argument('--source') || process.env.DATA_DIR || path.join(projectDir, 'data'));
const databaseFile = path.resolve(argument('--database') || path.join(sourceDir, 'hefei-points.sqlite'));
const force = process.argv.includes('--force');
process.env.SQLITE_FILE = databaseFile;
process.env.DATA_DIR = sourceDir;

const { getDb, inTransaction, closeDb } = require('../server/db/connection');

function readJson(filename, fallback) {
  const file = path.join(sourceDir, filename);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePoints(raw) {
  if (raw && typeof raw.enhe === 'number') return { default: raw };
  return raw || {};
}

function migrate() {
  const config = readJson('config.json', { families: {}, users: [], rules: {} });
  const points = normalizePoints(readJson('points.json', {}));
  const history = readJson('history.json', []);
  const familyMap = { ...(config.families || {}) };
  if (!familyMap.default) familyMap.default = { id: 'default', name: '安总家', createdAt: new Date().toISOString() };
  for (const user of config.users || []) {
    const familyId = user.familyId || 'default';
    if (!familyMap[familyId]) familyMap[familyId] = { id: familyId, name: familyId, createdAt: new Date().toISOString() };
  }
  for (const familyId of Object.keys(points)) {
    if (!familyMap[familyId]) familyMap[familyId] = { id: familyId, name: familyId, createdAt: new Date().toISOString() };
  }
  for (const record of history) {
    const familyId = record.familyId || 'default';
    if (!familyMap[familyId]) familyMap[familyId] = { id: familyId, name: familyId, createdAt: new Date().toISOString() };
  }

  const existingDb = getDb();
  const existingUsers = Number(existingDb.prepare('SELECT COUNT(*) AS count FROM users').get().count);
  const existingTransactions = Number(existingDb.prepare('SELECT COUNT(*) AS count FROM transactions').get().count);
  if (!force && (existingUsers > 0 || existingTransactions > 0)) {
    throw new Error('目标 SQLite 已包含业务数据；如确认覆盖，请显式添加 --force');
  }
  const result = inTransaction(db => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM point_accounts').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM rules').run();
    db.prepare('DELETE FROM families').run();

    const addFamily = db.prepare('INSERT INTO families(id,name,invite_code,invite_json,created_at) VALUES (?,?,?,?,?)');
    for (const [key, family] of Object.entries(familyMap)) {
      const id = family.id || key;
      addFamily.run(id, family.name || id, family.invite?.code || family.inviteCode || null,
        family.invite ? JSON.stringify(family.invite) : null, family.createdAt || new Date().toISOString());
    }

    const addUser = db.prepare('INSERT INTO users(id,name,role,password,family_id,openid,bound_at) VALUES (?,?,?,?,?,?,?)');
    for (const user of config.users || []) {
      addUser.run(user.id, user.name, user.role, user.password || '', user.familyId || 'default', user.openid || null, user.boundAt || null);
    }
    db.prepare('INSERT INTO rules(id,data_json) VALUES (1,?)').run(JSON.stringify(config.rules || {}));

    const setBalance = db.prepare('INSERT INTO point_accounts(family_id,kid_id,balance) VALUES (?,?,?)');
    for (const [familyId, accounts] of Object.entries(points)) {
      for (const [kidId, balance] of Object.entries(accounts || {})) setBalance.run(familyId, kidId, Number(balance) || 0);
    }

    const addTransaction = db.prepare(`
      INSERT INTO transactions(id,family_id,occurred_at,kid_id,kid_name,amount,reason,operator,note)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const importedIds = new Set();
    // 旧 history.json 是最新记录在数组前面；反向插入后 SQLite rowid DESC 保持相同 API 顺序。
    for (const record of [...history].reverse()) {
      let recordId = String(record.id ?? crypto.randomUUID());
      if (importedIds.has(recordId)) recordId = crypto.randomUUID();
      importedIds.add(recordId);
      addTransaction.run(recordId, record.familyId || 'default', record.time || new Date().toLocaleString('zh-CN', { hour12: false }),
        record.kid, record.kidName || record.kid, Number(record.amount) || 0, record.reason || '', record.operator || '', record.note || '');
    }

    let adjustments = 0;
    const accounts = db.prepare('SELECT family_id,kid_id,balance FROM point_accounts').all();
    const ledgerSum = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE family_id = ? AND kid_id = ?');
    for (const account of accounts) {
      const total = Number(ledgerSum.get(account.family_id, account.kid_id).total);
      const difference = account.balance - total;
      if (difference === 0) continue;
      const user = db.prepare('SELECT name FROM users WHERE id = ?').get(account.kid_id);
      addTransaction.run(crypto.randomUUID(), account.family_id, new Date().toLocaleString('zh-CN', { hour12: false }),
        account.kid_id, user?.name || account.kid_id, difference, 'JSON 迁移期初余额校准', '系统迁移', '自动补齐余额与历史流水差额');
      adjustments++;
    }

    const checks = db.prepare(`
      SELECT a.family_id AS familyId, a.kid_id AS kidId, a.balance,
             COALESCE(SUM(t.amount),0) AS recalculated
      FROM point_accounts a
      LEFT JOIN transactions t ON t.family_id = a.family_id AND t.kid_id = a.kid_id
      GROUP BY a.family_id, a.kid_id, a.balance
      ORDER BY a.family_id, a.kid_id
    `).all();
    if (checks.some(row => Number(row.balance) !== Number(row.recalculated))) throw new Error('余额核对失败，迁移已回滚');
    return {
      users: Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count),
      families: Number(db.prepare('SELECT COUNT(*) AS count FROM families').get().count),
      sourceHistory: history.length,
      transactions: Number(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count),
      adjustments,
      checks
    };
  });
  logger.info({ event: 'migration.completed', databaseFile, ...result }, 'JSON to SQLite migration completed');
}

try {
  migrate();
  closeDb();
} catch (error) {
  try { closeDb(); } catch (_) {}
  logger.error({ event: 'migration.failed', error: error.message }, 'JSON to SQLite migration failed');
  process.exitCode = 1;
}
