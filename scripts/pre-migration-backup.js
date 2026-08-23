const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { logicalDatabaseSha256 } = require('../server/db/logical-fingerprint');

const projectDir = path.join(__dirname, '..');
const migrationsDir = path.join(projectDir, 'server', 'db', 'migrations');

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filename));
  return hash.digest('hex');
}

function quoteSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function countRows(db, table) {
  if (!tableExists(db, table)) return null;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function appliedMigrations(db) {
  if (!tableExists(db, 'schema_migrations')) return [];
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map(row => row.version);
}

function inspectDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  return {
    integrity,
    foreignKeyViolationCount: foreignKeyViolations.length,
    logicalSha256: logicalDatabaseSha256(db),
    appliedMigrations: appliedMigrations(db),
    counts: {
      families: countRows(db, 'families'),
      users: countRows(db, 'users'),
      pointAccounts: countRows(db, 'point_accounts'),
      transactions: countRows(db, 'transactions')
    }
  };
}

function assertHealthy(report, label) {
  if (report.integrity.length !== 1 || report.integrity[0] !== 'ok') {
    throw new Error(`${label} integrity_check 未通过`);
  }
  if (report.foreignKeyViolationCount !== 0) {
    throw new Error(`${label} foreign_key_check 发现 ${report.foreignKeyViolationCount} 条异常`);
  }
}

function createPreMigrationBackup({ databaseFile, backupRoot, now = new Date() }) {
  const source = path.resolve(databaseFile);
  const root = path.resolve(backupRoot);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('迁移前数据库文件不存在');
  }
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, `pre-migration-${timestamp(now)}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: false });
  const snapshotFile = path.join(directory, 'hefei-points.pre-migration.sqlite');
  const manifestFile = path.join(directory, 'manifest.json');

  let sourceDb;
  let snapshotDb;
  try {
    sourceDb = new DatabaseSync(source, { readOnly: true });
    sourceDb.exec('PRAGMA busy_timeout = 5000');
    const sourceReport = inspectDatabase(sourceDb);
    assertHealthy(sourceReport, '源数据库');

    // Directly open SQLite without importing the application connection module.
    // VACUUM INTO creates a transactionally consistent snapshot and includes
    // committed WAL content without applying any pending application migration.
    sourceDb.exec(`VACUUM INTO '${quoteSqlLiteral(snapshotFile)}'`);
    sourceDb.close();
    sourceDb = undefined;

    snapshotDb = new DatabaseSync(snapshotFile, { readOnly: true });
    const snapshotReport = inspectDatabase(snapshotDb);
    assertHealthy(snapshotReport, '备份快照');
    snapshotDb.close();
    snapshotDb = undefined;

    if (JSON.stringify(sourceReport) !== JSON.stringify(snapshotReport)) {
      throw new Error('备份快照与源数据库核对结果不一致');
    }

    const allMigrations = fs.readdirSync(migrationsDir)
      .filter(name => name.endsWith('.sql'))
      .sort();
    const applied = new Set(sourceReport.appliedMigrations);
    const manifest = {
      formatVersion: 1,
      purpose: 'pre_migration_backup',
      createdAt: now.toISOString(),
      sourceFile: path.basename(source),
      snapshotFile: path.basename(snapshotFile),
      snapshotSha256: sha256File(snapshotFile),
      snapshotBytes: fs.statSync(snapshotFile).size,
      sourceLogicalSha256: sourceReport.logicalSha256,
      integrityCheck: 'ok',
      foreignKeyViolationCount: 0,
      appliedMigrations: sourceReport.appliedMigrations,
      pendingMigrations: allMigrations.filter(name => !applied.has(name)),
      counts: sourceReport.counts
    };
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { directory, snapshotFile, manifestFile, manifest };
  } finally {
    if (snapshotDb) snapshotDb.close();
    if (sourceDb) sourceDb.close();
  }
}

function main(argv = process.argv.slice(2)) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectDir, 'data'));
  const databaseFile = path.resolve(
    argument(argv, '--database') || process.env.SQLITE_FILE || path.join(dataDir, 'hefei-points.sqlite')
  );
  const backupRoot = path.resolve(
    argument(argv, '--backup-root') || path.join(dataDir, '..', 'backups')
  );
  const result = createPreMigrationBackup({ databaseFile, backupRoot });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    directory: result.directory,
    manifestFile: result.manifestFile,
    snapshotSha256: result.manifest.snapshotSha256,
    pendingMigrations: result.manifest.pendingMigrations
  })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`迁移前备份失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createPreMigrationBackup, inspectDatabase, sha256File };
