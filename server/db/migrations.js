const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const EXPECTED_MIGRATION_FILES = Object.freeze([
  '001_init.sql',
  '002_token_revocation.sql',
  '003_transaction_soft_delete.sql',
  '004_family_rules_history.sql',
  '005_transaction_rule_ids.sql',
  '006_guardian_consent_enrollment.sql',
  '007_device_pairing_sessions.sql',
  '008_point_requests_transaction_sources.sql',
  '009_data_rights_audit.sql',
  '010_synthetic_bootstrap_receipt.sql'
]);

function assertExpectedMigrationFiles(entries) {
  const actual = [...entries].sort();
  if (actual.length !== EXPECTED_MIGRATION_FILES.length
      || actual.some((name, index) => name !== EXPECTED_MIGRATION_FILES[index])) {
    const error = new Error('migration directory does not match the audited manifest');
    error.code = 'MIGRATION_SET_INVALID';
    throw error;
  }
  return EXPECTED_MIGRATION_FILES;
}

function migrationFiles() {
  const entries = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  if (entries.some(entry => entry.name.endsWith('.sql')
      && (!entry.isFile() || entry.isSymbolicLink()))) {
    const error = new Error('migration directory contains an unsafe SQL entry');
    error.code = 'MIGRATION_SET_INVALID';
    throw error;
  }
  return assertExpectedMigrationFiles(
    entries.filter(entry => entry.name.endsWith('.sql')).map(entry => entry.name)
  );
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

function assertAppliedMigrationsPrefix(db) {
  const applied = appliedMigrations(db);
  if (applied.length > EXPECTED_MIGRATION_FILES.length
      || applied.some((filename, index) => filename !== EXPECTED_MIGRATION_FILES[index])) {
    const error = new Error('migration ledger is not an audited ordered prefix');
    error.code = 'MIGRATION_LEDGER_INVALID';
    throw error;
  }
  return applied;
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
  assertAppliedMigrationsPrefix(db);
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
  EXPECTED_MIGRATION_FILES,
  MIGRATIONS_DIR,
  assertAppliedMigrationsPrefix,
  assertExpectedMigrationFiles,
  appliedMigrations,
  applyMigrations,
  applyMigrationsInCurrentTransaction,
  migrationFiles,
  tableExists
};
