const crypto = require('crypto');

const { getDb } = require('../connection');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left || '') || !/^[0-9a-f]{64}$/.test(right || '')) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function toSummary(row) {
  if (!row) return null;
  return {
    familyId: row.family_id,
    childId: row.child_id,
    childName: row.child_name,
    hasPointAccount: row.account_kid_id !== null,
    balance: row.account_kid_id === null ? null : Number(row.balance)
  };
}

function toTransaction(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    amount: Number(row.amount),
    reason: row.reason,
    ruleId: row.rule_id || null,
    categoryId: row.category_id || null
  };
}

function authorizedChild(input, db = getDb()) {
  return toSummary(db.prepare(`
    SELECT
      child.family_id,
      child.id AS child_id,
      child.name AS child_name,
      account.kid_id AS account_kid_id,
      account.balance
    FROM device_sessions AS session
    JOIN device_bindings AS binding
      ON binding.id = session.device_binding_id
      AND binding.family_id = session.family_id
      AND binding.child_id = session.child_id
    JOIN users AS child
      ON child.family_id = binding.family_id
      AND child.id = binding.child_id
      AND child.role = 'child'
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = child.family_id
      AND privacy.child_id = child.id
      AND privacy.status = 'active'
    JOIN guardian_consents AS consent
      ON consent.family_id = binding.family_id
      AND consent.child_id = binding.child_id
      AND consent.guardian_id = binding.created_by_guardian_id
      AND consent.status = 'active'
      AND json_extract(consent.consent_scope_json, '$.pointsLedger') = 1
      AND json_extract(consent.visibility_scope_json, '$.childDevice') = 'self_only'
    LEFT JOIN point_accounts AS account
      ON account.family_id = child.family_id
      AND account.kid_id = child.id
    WHERE session.id = ?
      AND session.family_id = ?
      AND session.child_id = ?
      AND session.device_binding_id = ?
      AND session.token_family_id = ?
      AND session.rotation_counter = ?
      AND session.status = 'active'
      AND session.access_expires_at > ?
      AND binding.status = 'active'
    LIMIT 1
  `).get(
    input.sessionId,
    input.familyId,
    input.childId,
    input.deviceBindingId,
    input.tokenFamilyId,
    input.rotationCounter,
    input.now
  ));
}

function listTransactions(input) {
  const db = getDb();
  db.exec('BEGIN DEFERRED');
  try {
    const child = authorizedChild(input, db);
    if (!child) {
      db.exec('COMMIT');
      return { authorized: false, accountComplete: false, cursorValid: true, rows: [] };
    }

    let boundaryRowId = null;
    if (input.cursorRowId) {
      const cursor = db.prepare(`
        SELECT CAST(rowid AS TEXT) AS cursor_row_id, id
        FROM transactions
        WHERE rowid = CAST(? AS INTEGER) AND family_id = ? AND kid_id = ?
      `).get(input.cursorRowId, child.familyId, child.childId);
      if (!cursor || !timingSafeHexEqual(input.cursorTransactionIdHash, sha256(cursor.id))) {
        db.exec('COMMIT');
        return {
          authorized: true,
          accountComplete: child.hasPointAccount,
          cursorValid: false,
          rows: []
        };
      }
      boundaryRowId = cursor.cursor_row_id;
    }

    const rows = boundaryRowId === null
      ? db.prepare(`
          SELECT CAST(rowid AS TEXT) AS cursor_row_id, *
          FROM transactions
          WHERE family_id = ? AND kid_id = ? AND deleted_at IS NULL
          ORDER BY rowid DESC
          LIMIT ?
        `).all(child.familyId, child.childId, input.limit + 1)
      : db.prepare(`
          SELECT CAST(rowid AS TEXT) AS cursor_row_id, *
          FROM transactions
          WHERE family_id = ? AND kid_id = ?
            AND deleted_at IS NULL AND rowid < CAST(? AS INTEGER)
          ORDER BY rowid DESC
          LIMIT ?
        `).all(child.familyId, child.childId, boundaryRowId, input.limit + 1);
    db.exec('COMMIT');
    return {
      authorized: true,
      accountComplete: child.hasPointAccount,
      cursorValid: true,
      rows: rows.map(row => ({
        cursorRowId: row.cursor_row_id,
        transaction: toTransaction(row)
      }))
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Preserve the original read failure.
    }
    throw error;
  }
}

module.exports = {
  authorizedChild,
  listTransactions
};
