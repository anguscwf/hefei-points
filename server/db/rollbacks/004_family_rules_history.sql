-- Manual rollback for 004_family_rules_history.sql.
-- Stop the v2.5 server first and execute the 005 rollback before this file.

CREATE TABLE IF NOT EXISTS rules_v25_archive (
  family_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions_v25_archive (
  version_id INTEGER PRIMARY KEY,
  family_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  restored_from_version_id INTEGER,
  UNIQUE (family_id, revision)
);

INSERT OR REPLACE INTO rules_v25_archive(
  family_id, revision, data_json, updated_by, updated_at
)
SELECT family_id, revision, data_json, updated_by, updated_at FROM rules;

INSERT OR REPLACE INTO rule_versions_v25_archive(
  version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
)
SELECT
  version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
FROM rule_versions;

DROP TABLE rule_versions;
DROP TABLE rules;

CREATE TABLE rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL
);

INSERT INTO rules(id, data_json)
SELECT 1, data_json
FROM rules_v25_archive
WHERE family_id = 'default';

DELETE FROM schema_migrations WHERE version = '004_family_rules_history.sql';
