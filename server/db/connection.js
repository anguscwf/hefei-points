const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, 'hefei-points.sqlite');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
let database;

function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
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
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  database = new DatabaseSync(DB_FILE);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 5000');
  applyMigrations(database);
  return database;
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

module.exports = { DATA_DIR, DB_FILE, getDb, closeDb, inTransaction };
