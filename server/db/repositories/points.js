const crypto = require('crypto');
const { getDb, inTransaction } = require('../connection');
const transactions = require('./transactions');

function assertChildProcessingAllowed(db, familyId, childId) {
  const state = db.prepare(`
    SELECT status
    FROM child_privacy_states
    WHERE family_id = ? AND child_id = ?
  `).get(familyId, childId);
  if (!state || state.status !== 'active') {
    const error = new Error('儿童档案当前不允许新增积分处理');
    error.code = 'CHILD_PROCESSING_BLOCKED';
    throw error;
  }
}

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

function getGuardianPoints(familyId, guardianId) {
  const rows = getDb().prepare(`
    SELECT pa.kid_id, pa.balance
    FROM point_accounts pa
    WHERE pa.family_id = ?
      AND EXISTS (
        SELECT 1
        FROM guardian_consents gc
        JOIN child_privacy_states cps
          ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
        WHERE gc.family_id = pa.family_id
          AND gc.child_id = pa.kid_id
          AND gc.guardian_id = ?
          AND gc.status = 'active'
          AND cps.status = 'active'
      )
    ORDER BY pa.kid_id
  `).all(familyId || 'default', guardianId);
  return Object.fromEntries(rows.map(row => [row.kid_id, row.balance]));
}

function getChildPoints(familyId, childId) {
  const row = getDb().prepare('SELECT balance FROM point_accounts WHERE family_id = ? AND kid_id = ?')
    .get(familyId || 'default', childId);
  return row ? { [childId]: Number(row.balance || 0) } : {};
}

function changePoints({ familyId, kid, kidName, amount, reason, operator, note, ruleId = null, categoryId = null }) {
  return inTransaction(db => {
    assertChildProcessingAllowed(db, familyId, kid);
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

module.exports = {
  getFamilyPoints,
  getGuardianPoints,
  getChildPoints,
  setBalance,
  changePoints,
  listAccounts,
  assertChildProcessingAllowed
};
