const { getDb, inTransaction } = require('../connection');

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    time: row.occurred_at,
    kid: row.kid_id,
    kidName: row.kid_name,
    amount: row.amount,
    reason: row.reason,
    operator: row.operator,
    note: row.note || '',
    ruleId: row.rule_id || null,
    categoryId: row.category_id || null
  };
}

function insert(record, db = getDb()) {
  const stored = {
    ...record,
    note: record.note || '',
    ruleId: record.ruleId || null,
    categoryId: record.categoryId || null
  };
  db.prepare(`
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note,
      rule_id, category_id
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    stored.id,
    stored.familyId,
    stored.time,
    stored.kid,
    stored.kidName,
    stored.amount,
    stored.reason,
    stored.operator,
    stored.note,
    stored.ruleId,
    stored.categoryId
  );
  return stored;
}

function listByFamily(familyId, kid, limit = 50) {
  const db = getDb();
  const rows = kid
    ? db.prepare('SELECT * FROM transactions WHERE family_id = ? AND kid_id = ? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT ?').all(familyId, kid, limit)
    : db.prepare('SELECT * FROM transactions WHERE family_id = ? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT ?').all(familyId, limit);
  return rows.map(toRecord);
}

function updateNote(recordId, familyId, note) {
  return getDb().prepare('UPDATE transactions SET note = ? WHERE id = ? AND family_id = ? AND deleted_at IS NULL')
    .run(note || '', String(recordId), familyId).changes > 0;
}

function remove(recordId, familyId) {
  return getDb().prepare('UPDATE transactions SET deleted_at = ? WHERE id = ? AND family_id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), String(recordId), familyId).changes > 0;
}

function cleanup(familyId, { kid, beforeDate, afterDate }) {
  return inTransaction(db => {
    const rows = db.prepare('SELECT id, occurred_at, kid_id FROM transactions WHERE family_id = ? AND deleted_at IS NULL').all(familyId);
    const ids = rows.filter(row => {
      if (kid && row.kid_id !== kid) return false;
      const date = row.occurred_at ? row.occurred_at.split(' ')[0].replace(/\//g, '-') : '';
      return (!beforeDate || date <= beforeDate) && (!afterDate || date >= afterDate);
    }).map(row => row.id);
    const removeOne = db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?');
    const deletedAt = new Date().toISOString();
    for (const id of ids) removeOne.run(deletedAt, id);
    return ids.length;
  });
}

function count() { return Number(getDb().prepare('SELECT COUNT(*) AS count FROM transactions').get().count); }
function sumByAccount() {
  return getDb().prepare('SELECT family_id, kid_id, COALESCE(SUM(amount),0) AS total FROM transactions GROUP BY family_id, kid_id').all();
}

function listForGuardian(familyId, guardianId, kid, limit = 50) {
  const db = getDb();
  const params = kid
    ? [familyId, guardianId, kid, limit]
    : [familyId, guardianId, limit];
  const childFilter = kid ? 'AND t.kid_id = ?' : '';
  return db.prepare(`
    SELECT t.*
    FROM transactions t
    WHERE t.family_id = ?
      AND t.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM guardian_consents gc
        JOIN child_privacy_states cps
          ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
        WHERE gc.family_id = t.family_id
          AND gc.child_id = t.kid_id
          AND gc.guardian_id = ?
          AND gc.status = 'active'
          AND cps.status = 'active'
      )
      ${childFilter}
    ORDER BY t.rowid DESC
    LIMIT ?
  `).all(...params).map(toRecord);
}

function updateNoteForGuardian(recordId, familyId, guardianId, note) {
  return getDb().prepare(`
    UPDATE transactions
    SET note = ?
    WHERE id = ? AND family_id = ? AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM guardian_consents gc
        JOIN child_privacy_states cps
          ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
        WHERE gc.family_id = transactions.family_id
          AND gc.child_id = transactions.kid_id
          AND gc.guardian_id = ?
          AND gc.status = 'active'
          AND cps.status = 'active'
      )
  `).run(note || '', String(recordId), familyId, guardianId).changes > 0;
}

function removeForGuardian(recordId, familyId, guardianId) {
  return getDb().prepare(`
    UPDATE transactions
    SET deleted_at = ?
    WHERE id = ? AND family_id = ? AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM guardian_consents gc
        JOIN child_privacy_states cps
          ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
        WHERE gc.family_id = transactions.family_id
          AND gc.child_id = transactions.kid_id
          AND gc.guardian_id = ?
          AND gc.status = 'active'
          AND cps.status = 'active'
      )
  `).run(new Date().toISOString(), String(recordId), familyId, guardianId).changes > 0;
}

function cleanupForGuardian(familyId, guardianId, { kid, beforeDate, afterDate }) {
  return inTransaction(db => {
    const rows = db.prepare(`
      SELECT t.id, t.occurred_at, t.kid_id
      FROM transactions t
      WHERE t.family_id = ? AND t.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM guardian_consents gc
          JOIN child_privacy_states cps
            ON cps.family_id = gc.family_id AND cps.child_id = gc.child_id
          WHERE gc.family_id = t.family_id
            AND gc.child_id = t.kid_id
            AND gc.guardian_id = ?
            AND gc.status = 'active'
            AND cps.status = 'active'
        )
    `).all(familyId, guardianId);
    const ids = rows.filter(row => {
      if (kid && row.kid_id !== kid) return false;
      const date = row.occurred_at ? row.occurred_at.split(' ')[0].replace(/\//g, '-') : '';
      return (!beforeDate || date <= beforeDate) && (!afterDate || date >= afterDate);
    }).map(row => row.id);
    const removeOne = db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ? AND family_id = ?');
    const deletedAt = new Date().toISOString();
    for (const id of ids) removeOne.run(deletedAt, id, familyId);
    return ids.length;
  });
}

module.exports = {
  toRecord,
  insert,
  listByFamily,
  listForGuardian,
  updateNote,
  updateNoteForGuardian,
  remove,
  removeForGuardian,
  cleanup,
  cleanupForGuardian,
  count,
  sumByAccount
};
