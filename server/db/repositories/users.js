const { getDb, inTransaction } = require('../connection');

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, role: row.role, password: row.password,
    familyId: row.family_id || 'default',
    ...(row.openid ? { openid: row.openid } : {}),
    ...(row.bound_at ? { boundAt: row.bound_at } : {}),
    tokensValidAfter: Number(row.tokens_valid_after || 0)
  };
}

function findById(id) { return toUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id)); }
function findByOpenId(openid) { return toUser(getDb().prepare('SELECT * FROM users WHERE openid = ?').get(openid)); }
function listAll() { return getDb().prepare('SELECT * FROM users ORDER BY rowid').all().map(toUser); }
function listByFamily(familyId) { return getDb().prepare('SELECT * FROM users WHERE family_id = ? ORDER BY rowid').all(familyId).map(toUser); }
function updatePassword(id, password) { getDb().prepare('UPDATE users SET password = ? WHERE id = ?').run(password, id); }

function bindOpenId(userId, openid, boundAt) {
  return inTransaction(db => {
    const conflict = db.prepare('SELECT * FROM users WHERE openid = ? AND id <> ?').get(openid, userId);
    if (conflict) return { conflict: toUser(conflict) };
    const result = db.prepare('UPDATE users SET openid = ?, bound_at = ? WHERE id = ?').run(openid, boundAt, userId);
    return { user: result.changes ? toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) : null };
  });
}

function insert(user, db = getDb()) {
  db.prepare('INSERT INTO users(id,name,role,password,family_id,openid,bound_at) VALUES (?,?,?,?,?,?,?)')
    .run(user.id, user.name, user.role, user.password || '', user.familyId || 'default', user.openid || null, user.boundAt || null);
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
}

function replaceAll(users) {
  return inTransaction(db => {
    const existing = new Map(db.prepare('SELECT * FROM users').all().map(row => [row.id, toUser(row)]));
    db.prepare('DELETE FROM users').run();
    const insertUser = db.prepare('INSERT INTO users(id,name,role,password,family_id,openid,bound_at,tokens_valid_after) VALUES (?,?,?,?,?,?,?,?)');
    for (const input of users) {
      const old = existing.get(input.id);
      insertUser.run(input.id, input.name, input.role, input.password || old?.password || '',
        input.familyId || old?.familyId || 'default', input.openid || old?.openid || null, input.boundAt || old?.boundAt || null,
        input.tokensValidAfter || old?.tokensValidAfter || 0);
    }
    return db.prepare('SELECT * FROM users ORDER BY rowid').all().map(toUser);
  });
}

function replaceFamily(familyId, users, adminId) {
  return inTransaction(db => {
    const currentRows = db.prepare('SELECT * FROM users WHERE family_id = ?').all(familyId);
    const current = new Map(currentRows.map(row => [row.id, toUser(row)]));
    const submittedIds = new Set(users.map(user => user.id));
    if (!submittedIds.has(adminId)) throw new Error('不能删除当前管理员');

    for (const input of users) {
      const globalUser = db.prepare('SELECT family_id FROM users WHERE id = ?').get(input.id);
      if (globalUser && globalUser.family_id !== familyId) throw new Error('用户ID已被其他家庭使用');
      if (input.id === adminId && input.role !== 'admin') throw new Error('不能修改当前管理员角色');
    }

    const remove = db.prepare('DELETE FROM users WHERE id = ? AND family_id = ?');
    for (const existing of current.values()) {
      if (!submittedIds.has(existing.id)) remove.run(existing.id, familyId);
    }

    const update = db.prepare('UPDATE users SET name = ?, role = ?, password = ?, openid = ?, bound_at = ? WHERE id = ? AND family_id = ?');
    const add = db.prepare('INSERT INTO users(id,name,role,password,family_id,openid,bound_at) VALUES (?,?,?,?,?,?,?)');
    for (const input of users) {
      const old = current.get(input.id);
      if (old) {
        update.run(input.name, input.role, input.password || old.password || '', input.openid || old.openid || null,
          input.boundAt || old.boundAt || null, input.id, familyId);
      } else {
        add.run(input.id, input.name, input.role, input.password || '', familyId, input.openid || null, input.boundAt || null);
      }
    }
    return db.prepare('SELECT * FROM users WHERE family_id = ? ORDER BY rowid').all(familyId).map(toUser);
  });
}

module.exports = { toUser, findById, findByOpenId, listAll, listByFamily, updatePassword, bindOpenId, insert, replaceAll, replaceFamily };
