const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { logicalDatabaseSha256 } = require('./logical-fingerprint');
const { validateSyntheticDeployment } = require('../config/deployment-profile');
const { validateSyntheticRuntimeFilesystem } = require('../config/synthetic-runtime-filesystem');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, 'hefei-points.sqlite');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
let database;

function validateSyntheticDatabaseBoundary() {
  if (process.env.NODE_ENV !== 'production' || process.env.DEPLOYMENT_TIER !== 'synthetic') return;
  const projectRoot = path.resolve(__dirname, '..', '..');
  const deployment = validateSyntheticDeployment(process.env, { projectRoot });
  const samePath = (left, right) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
  if (!samePath(deployment.dataPaths.dataDir, DATA_DIR)
      || !samePath(deployment.dataPaths.sqliteFile, DB_FILE)) {
    const error = new Error('synthetic database path changed after module initialization');
    error.code = 'SYNTHETIC_DATA_ROOT_UNSAFE';
    throw error;
  }
  validateSyntheticRuntimeFilesystem(deployment, projectRoot);
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
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

function businessCounts(db) {
  const tables = {
    families: 'families',
    users: 'users',
    pointAccounts: 'point_accounts',
    transactions: 'transactions'
  };
  return Object.fromEntries(Object.entries(tables).map(([key, table]) => [
    key,
    tableExists(db, table)
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
      : null
  ]));
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function validateProductionMigrationBackup(db) {
  if (process.env.NODE_ENV !== 'production') return;
  const applied = appliedMigrations(db);
  const appliedSet = new Set(applied);
  const pending = migrationFiles().filter(name => !appliedSet.has(name));
  if (!pending.length) return;
  const counts = businessCounts(db);
  if (!Object.values(counts).some(value => Number(value) > 0)) return;

  const manifestPath = process.env.PRE_MIGRATION_BACKUP_MANIFEST;
  if (!manifestPath) {
    throw new Error('检测到待执行迁移和存量数据；请先运行 npm run backup:pre-migration 并设置 PRE_MIGRATION_BACKUP_MANIFEST');
  }
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  if (manifest.purpose !== 'pre_migration_backup' || manifest.integrityCheck !== 'ok') {
    throw new Error('迁移前备份清单无效');
  }
  if (manifest.sourceFile !== path.basename(DB_FILE)) {
    throw new Error('迁移前备份清单与当前数据库文件不匹配');
  }
  if (JSON.stringify(manifest.appliedMigrations || []) !== JSON.stringify(applied)) {
    throw new Error('迁移前备份清单的迁移版本与当前数据库不匹配');
  }
  if (JSON.stringify(manifest.pendingMigrations || []) !== JSON.stringify(pending)) {
    throw new Error('迁移前备份清单的待执行迁移与当前代码不匹配');
  }
  if (JSON.stringify(manifest.counts || {}) !== JSON.stringify(counts)) {
    throw new Error('迁移前备份清单的业务计数与当前数据库不匹配');
  }
  if (manifest.sourceLogicalSha256 !== logicalDatabaseSha256(db)) {
    throw new Error('迁移前备份清单的逻辑内容指纹与当前数据库不匹配');
  }
  const manifestDir = path.dirname(resolvedManifest);
  const snapshotFile = path.resolve(manifestDir, manifest.snapshotFile || '');
  const relativeSnapshot = path.relative(manifestDir, snapshotFile);
  if (!relativeSnapshot || relativeSnapshot.startsWith('..') || path.isAbsolute(relativeSnapshot)) {
    throw new Error('迁移前备份快照路径无效');
  }
  if (!fs.existsSync(snapshotFile) || sha256File(snapshotFile) !== manifest.snapshotSha256) {
    throw new Error('迁移前备份快照哈希校验失败');
  }
  const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
  try {
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      throw new Error('迁移前备份快照完整性校验失败');
    }
  } finally {
    snapshot.close();
  }
}

function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const files = migrationFiles();
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(filename, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function getDb() {
  if (database) return database;
  validateSyntheticDatabaseBoundary();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const candidate = new DatabaseSync(DB_FILE);
  try {
    validateSyntheticDatabaseBoundary();
    candidate.exec('PRAGMA foreign_keys = ON');
    // INSERT OR REPLACE internally deletes conflicting rows. Recursive trigger
    // delivery is required so immutable consent/session/request/ledger evidence
    // cannot bypass their no-delete guards through REPLACE.
    candidate.exec('PRAGMA recursive_triggers = ON');
    candidate.exec('PRAGMA journal_mode = WAL');
    candidate.exec('PRAGMA synchronous = FULL');
    candidate.exec('PRAGMA busy_timeout = 5000');
    validateSyntheticDatabaseBoundary();
    validateProductionMigrationBackup(candidate);
    applyMigrations(candidate);
    validateSyntheticDatabaseBoundary();
    database = candidate;
    return database;
  } catch (error) {
    candidate.close();
    throw error;
  }
}

function closeDb() {
  if (!database) return;
  database.close();
  database = undefined;
}

function inTransaction(work) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function inReadTransaction(work) {
  const db = getDb();
  // DEFERRED pins a consistent snapshot on the first read without taking the
  // reserved writer lock used by state-changing operations.
  db.exec('BEGIN DEFERRED');
  try {
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  getDb,
  closeDb,
  inTransaction,
  inReadTransaction,
  validateProductionMigrationBackup
};
