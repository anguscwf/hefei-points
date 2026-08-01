-- v2.5.0 / G-06 + G-08
-- Convert the singleton rules row into one independently versioned row per family.
-- Existing id=1 data belongs only to the default family.

-- These archives stay outside the live schema. They are empty on the first
-- upgrade and make a rollback -> roll-forward cycle lossless for every family.
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

INSERT OR IGNORE INTO families(id, name, invite_code, invite_json, created_at)
VALUES ('default', '默认家庭', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE rules RENAME TO rules_legacy_004;

CREATE TABLE rules (
  family_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
);

INSERT INTO rules(family_id, revision, data_json, updated_by, updated_at)
SELECT
  'default',
  CASE
    WHEN json_valid(data_json)
      AND json_type(data_json, '$.revision') = 'integer'
      AND CAST(json_extract(data_json, '$.revision') AS INTEGER) >= 0
    THEN CAST(json_extract(data_json, '$.revision') AS INTEGER)
    ELSE 0
  END,
  data_json,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM rules_legacy_004
WHERE id = 1;

-- When upgrading again after a structural rollback, restore every archived
-- family. For default, keep a newer singleton revision created while v2.4 was
-- temporarily active; non-default families exist only in the archive.
INSERT INTO rules(family_id, revision, data_json, updated_by, updated_at)
SELECT archive.family_id, archive.revision, archive.data_json, archive.updated_by, archive.updated_at
FROM rules_v25_archive AS archive
JOIN families ON families.id = archive.family_id
WHERE 1
ON CONFLICT(family_id) DO UPDATE SET
  revision = excluded.revision,
  data_json = excluded.data_json,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at
WHERE excluded.revision > rules.revision;

CREATE TABLE rule_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'save' CHECK (source IN ('migration', 'initialize', 'save', 'restore')),
  restored_from_version_id INTEGER,
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
  FOREIGN KEY (restored_from_version_id) REFERENCES rule_versions(version_id) ON DELETE SET NULL,
  UNIQUE (family_id, revision)
);

CREATE INDEX idx_rule_versions_family_revision
ON rule_versions(family_id, revision DESC);

INSERT OR IGNORE INTO rule_versions(
  version_id, family_id, revision, data_json, created_by, created_at, source, restored_from_version_id
)
SELECT
  archive.version_id, archive.family_id, archive.revision, archive.data_json,
  archive.created_by, archive.created_at, archive.source, archive.restored_from_version_id
FROM rule_versions_v25_archive AS archive
JOIN families ON families.id = archive.family_id
ORDER BY archive.version_id;

-- First-time migration, or a family without an archived matching snapshot,
-- receives one baseline version for its current live revision.
INSERT INTO rule_versions(family_id, revision, data_json, created_by, created_at, source)
SELECT current.family_id, current.revision, current.data_json, current.updated_by, current.updated_at, 'migration'
FROM rules AS current
WHERE NOT EXISTS (
  SELECT 1 FROM rule_versions AS version
  WHERE version.family_id = current.family_id AND version.revision = current.revision
);

DROP TABLE rules_legacy_004;
