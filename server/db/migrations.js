const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function appliedMigrations(db) {
  if (!tableExists(db, 'schema_migrations')) return [];
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map(row => row.version);
}

function applyMigrationsInCurrentTransaction(db, {
  now = () => new Date(),
  afterMigration
} = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)'
  );
  for (const filename of migrationFiles()) {
    // Re-read under the caller's writer lock. This makes concurrent fresh
    // starts converge instead of relying on a stale pre-lock migration set.
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(filename)) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
    insert.run(filename, now().toISOString());
    if (typeof afterMigration === 'function') afterMigration(filename, db);
  }
}

function applyMigrations(db, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    applyMigrationsInCurrentTransaction(db, options);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  MIGRATIONS_DIR,
  appliedMigrations,
  applyMigrations,
  applyMigrationsInCurrentTransaction,
  migrationFiles,
  tableExists
};
