const { getDb, inTransaction } = require('../connection');

function toFamily(row) {
  if (!row) return null;
  let invite;
  try { invite = row.invite_json ? JSON.parse(row.invite_json) : undefined; } catch (_) {}
  return { id: row.id, name: row.name, inviteCode: row.invite_code || undefined,
    ...(invite ? { invite } : {}), createdAt: row.created_at };
}

function findById(id) { return toFamily(getDb().prepare('SELECT * FROM families WHERE id = ?').get(id)); }
function listAll() { return getDb().prepare('SELECT * FROM families ORDER BY created_at').all().map(toFamily); }
function asObject() { return Object.fromEntries(listAll().map(family => [family.id, family])); }
function findByInviteCode(code, db = getDb()) { return toFamily(db.prepare('SELECT * FROM families WHERE invite_code = ?').get(code)); }

function ensureDefault(family) {
  getDb().prepare(`
    INSERT INTO families(id,name,invite_code,invite_json,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      invite_code = COALESCE(families.invite_code, excluded.invite_code),
      invite_json = COALESCE(families.invite_json, excluded.invite_json)
  `).run(family.id, family.name, family.inviteCode || null, family.invite ? JSON.stringify(family.invite) : null, family.createdAt);
  return findById(family.id);
}

function createWithAdmin(family, userId) {
  return inTransaction(db => {
    db.prepare('INSERT INTO families(id,name,invite_code,invite_json,created_at) VALUES (?,?,?,?,?)')
      .run(family.id, family.name, family.inviteCode || null, family.invite ? JSON.stringify(family.invite) : null, family.createdAt);
    db.prepare("UPDATE users SET family_id = ?, role = 'admin' WHERE id = ?").run(family.id, userId);
    return family;
  });
}

function joinByInvite(userId, code) {
  return inTransaction(db => {
    const family = findByInviteCode(code, db);
    if (!family) throw new Error('邀请码无效');
    if (family.invite) {
      if (family.invite.expiresAt && new Date(family.invite.expiresAt) < new Date()) throw new Error('邀请码已过期');
      if (family.invite.maxUses && family.invite.usedCount >= family.invite.maxUses) throw new Error('邀请码已用完');
      family.invite.usedCount = (family.invite.usedCount || 0) + 1;
      db.prepare('UPDATE families SET invite_json = ? WHERE id = ?').run(JSON.stringify(family.invite), family.id);
    }
    const user = db.prepare('SELECT family_id FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    if (user.family_id === family.id) throw new Error('你已在该家庭中');
    db.prepare('UPDATE users SET family_id = ? WHERE id = ?').run(family.id, userId);
    return family;
  });
}

function moveUser(userId, familyId) { return getDb().prepare('UPDATE users SET family_id = ? WHERE id = ?').run(familyId, userId).changes > 0; }
function kickUser(userId, familyId) {
  return inTransaction(db => {
    const target = db.prepare('SELECT name FROM users WHERE id = ? AND family_id = ?').get(userId, familyId);
    if (!target) throw new Error('该用户不在你的家庭中');
    db.prepare("UPDATE users SET family_id = 'default', tokens_valid_after = ? WHERE id = ?").run(Date.now(), userId);
    return target.name;
  });
}
function deleteFamily(familyId) {
  return inTransaction(db => {
    if (!db.prepare('SELECT 1 FROM families WHERE id = ?').get(familyId)) throw new Error('家庭不存在');
    db.prepare("UPDATE users SET family_id = 'default' WHERE family_id = ?").run(familyId);
    db.prepare('DELETE FROM point_accounts WHERE family_id = ?').run(familyId);
    db.prepare('DELETE FROM families WHERE id = ?').run(familyId);
  });
}

module.exports = { toFamily, findById, listAll, asObject, findByInviteCode, ensureDefault, createWithAdmin, joinByInvite, moveUser, kickUser, deleteFamily };
