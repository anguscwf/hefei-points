const crypto = require('crypto');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function updateValue(hash, value) {
  if (value === null) {
    hash.update('null;');
    return;
  }
  if (Buffer.isBuffer(value)) {
    hash.update(`blob:${value.length}:`);
    hash.update(value);
    hash.update(';');
    return;
  }
  const type = typeof value;
  const serialized = type === 'number' && Object.is(value, -0)
    ? '-0'
    : String(value);
  hash.update(`${type}:${Buffer.byteLength(serialized, 'utf8')}:${serialized};`);
}

function logicalDatabaseSha256(db) {
  const hash = crypto.createHash('sha256');
  const tables = db.prepare(`
    SELECT name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_stat%'
    ORDER BY name
  `).all();
  for (const table of tables) {
    hash.update(`table:${Buffer.byteLength(table.name, 'utf8')}:${table.name};`);
    hash.update(`schema:${Buffer.byteLength(table.sql, 'utf8')}:${table.sql};`);
    const quotedTable = quoteIdentifier(table.name);
    const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all()
      .sort((left, right) => left.cid - right.cid)
      .map(column => column.name);
    hash.update(`columns:${columns.length};`);
    if (!columns.length) continue;
    const projection = columns.map(quoteIdentifier).join(', ');
    const order = columns.map(quoteIdentifier).join(', ');
    const rows = db.prepare(`
      SELECT ${projection} FROM ${quotedTable} ORDER BY ${order}
    `).iterate();
    let rowCount = 0;
    for (const row of rows) {
      hash.update('row;');
      for (const column of columns) updateValue(hash, row[column]);
      rowCount++;
    }
    hash.update(`rows:${rowCount};`);
  }
  return hash.digest('hex');
}

module.exports = { logicalDatabaseSha256 };
