const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-pre-migration-backup-'));
const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
const sourceFile = path.join(tempDir, 'source.sqlite');
const backupRoot = path.join(tempDir, 'backups');
const { createPreMigrationBackup } = require('../../scripts/pre-migration-backup');

function applyThrough005(db) {
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const filename of fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()) {
    if (filename > '005_transaction_rule_ids.sql') break;
    db.exec(fs.readFileSync(path.join(migrationDir, filename), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(filename, '2026-08-23T00:00:00.000Z');
  }
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('迁移前备份不加载应用连接、不执行 006，并生成经校验的快照与清单', () => {
  const db = new DatabaseSync(sourceFile);
  applyThrough005(db);
  db.exec(`
    INSERT INTO families(id, name, created_at)
    VALUES ('synthetic_family', '合成家庭', '2026-08-23T00:00:00.000Z');
    INSERT INTO users(id, name, role, password, family_id)
    VALUES ('synthetic_child', '合成孩子', 'child', '', 'synthetic_family');
    INSERT INTO point_accounts(family_id, kid_id, balance)
    VALUES ('synthetic_family', 'synthetic_child', 7);
    INSERT INTO transactions(
      id, family_id, occurred_at, kid_id, kid_name, amount, reason, operator, note
    ) VALUES (
      'synthetic_tx', 'synthetic_family', '2026/8/23 00:00:00',
      'synthetic_child', '合成孩子', 7, '合成测试', '测试', ''
    );
  `);
  db.close();

  const result = createPreMigrationBackup({
    databaseFile: sourceFile,
    backupRoot,
    now: new Date('2026-08-23T01:02:03.456Z')
  });
  assert.equal(result.manifest.integrityCheck, 'ok');
  assert.equal(result.manifest.foreignKeyViolationCount, 0);
  assert.equal(result.manifest.counts.families, 2);
  assert.equal(result.manifest.counts.users, 1);
  assert.equal(result.manifest.counts.pointAccounts, 1);
  assert.equal(result.manifest.counts.transactions, 1);
  assert.equal(result.manifest.snapshotSha256, fileSha256(result.snapshotFile));
  assert.match(result.manifest.sourceLogicalSha256, /^[0-9a-f]{64}$/);
  assert.ok(result.manifest.pendingMigrations.includes('006_guardian_consent_enrollment.sql'));

  for (const filename of [sourceFile, result.snapshotFile]) {
    const inspected = new DatabaseSync(filename, { readOnly: true });
    assert.equal(inspected.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
      WHERE version = '006_guardian_consent_enrollment.sql'
    `).get().count, 0);
    assert.equal(inspected.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'guardian_consents'
    `).get().count, 0);
    assert.equal(inspected.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    inspected.close();
  }

  const manifestOnDisk = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
  assert.deepEqual(manifestOnDisk, result.manifest);

  const command = [
    '-e',
    "const connection=require('./server/db/connection');connection.getDb();connection.closeDb();"
  ];
  const productionEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: tempDir,
    SQLITE_FILE: sourceFile
  };
  delete productionEnv.PRE_MIGRATION_BACKUP_MANIFEST;
  const refused = spawnSync(process.execPath, command, {
    cwd: path.join(__dirname, '..', '..'),
    env: productionEnv,
    encoding: 'utf8'
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /backup:pre-migration/);
  const stillOld = new DatabaseSync(sourceFile, { readOnly: true });
  assert.equal(stillOld.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations
    WHERE version = '006_guardian_consent_enrollment.sql'
  `).get().count, 0);
  stillOld.close();

  const changedWithoutCountChange = new DatabaseSync(sourceFile);
  changedWithoutCountChange.prepare(`
    UPDATE families SET name = '内容已变化但行数相同' WHERE id = 'synthetic_family'
  `).run();
  changedWithoutCountChange.close();
  const staleManifest = spawnSync(process.execPath, command, {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...productionEnv,
      PRE_MIGRATION_BACKUP_MANIFEST: result.manifestFile
    },
    encoding: 'utf8'
  });
  assert.notEqual(staleManifest.status, 0);
  assert.match(staleManifest.stderr, /逻辑内容指纹/);
  const restoreSource = new DatabaseSync(sourceFile);
  restoreSource.prepare(`
    UPDATE families SET name = '合成家庭' WHERE id = 'synthetic_family'
  `).run();
  restoreSource.close();

  const approved = spawnSync(process.execPath, command, {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...productionEnv,
      PRE_MIGRATION_BACKUP_MANIFEST: result.manifestFile
    },
    encoding: 'utf8'
  });
  assert.equal(approved.status, 0, approved.stderr);
  const migrated = new DatabaseSync(sourceFile, { readOnly: true });
  assert.equal(migrated.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations
    WHERE version = '006_guardian_consent_enrollment.sql'
  `).get().count, 1);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  migrated.close();

  const unchangedBackup = new DatabaseSync(result.snapshotFile, { readOnly: true });
  assert.equal(unchangedBackup.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations
    WHERE version = '006_guardian_consent_enrollment.sql'
  `).get().count, 0);
  unchangedBackup.close();
});
