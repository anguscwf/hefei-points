const crypto = require('crypto');
const { getDb, inTransaction } = require('../connection');
const transactions = require('./transactions');

function getFamilyPoints(familyId) {
  const rows = getDb().prepare('SELECT kid_id, balance FROM point_accounts WHERE family_id = ?').all(familyId || 'default');
  return Object.fromEntries(rows.map(row => [row.kid_id, row.balance]));
}

function setBalance(familyId, kidId, balance, db = getDb()) {
  db.prepare(`
    INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)
    ON CONFLICT(family_id, kid_id) DO UPDATE SET balance = excluded.balance
  `).run(familyId || 'default', kidId, Number(balance) || 0);
}

function changePoints({ familyId, kid, kidName, amount, reason, operator, note, ruleId = null, categoryId = null }) {
  return inTransaction(db => {
    const beforeBalance = Number(db.prepare('SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?').get(familyId, kid)?.balance || 0);
    db.prepare(`
      INSERT INTO point_accounts(family_id, kid_id, balance) VALUES (?, ?, ?)
      ON CONFLICT(family_id, kid_id) DO UPDATE SET balance = point_accounts.balance + excluded.balance
    `).run(familyId, kid, amount);

    const record = transactions.insert({
      id: crypto.randomUUID(), familyId,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      kid, kidName, amount, reason, operator, note: note || '',
      ruleId: ruleId || null,
      categoryId: categoryId || null
    }, db);

    const rows = db.prepare('SELECT kid_id, balance FROM point_accounts WHERE family_id = ?').all(familyId);
    const points = Object.fromEntries(rows.map(row => [row.kid_id, row.balance]));
    return { points, record, beforeBalance, afterBalance: points[kid] };
  });
}

function listAccounts() { return getDb().prepare('SELECT family_id, kid_id, balance FROM point_accounts ORDER BY family_id, kid_id').all(); }

module.exports = { getFamilyPoints, setBalance, changePoints, listAccounts };
