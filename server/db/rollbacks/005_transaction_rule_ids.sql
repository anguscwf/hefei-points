CREATE TABLE IF NOT EXISTS transaction_rule_links_v25_archive (
  transaction_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

INSERT OR REPLACE INTO transaction_rule_links_v25_archive(
  transaction_id, family_id, rule_id, category_id, archived_at
)
SELECT id, family_id, rule_id, category_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM transactions
WHERE rule_id IS NOT NULL AND category_id IS NOT NULL;

DROP INDEX IF EXISTS idx_transactions_family_category;
DROP INDEX IF EXISTS idx_transactions_family_rule;

ALTER TABLE transactions DROP COLUMN category_id;
ALTER TABLE transactions DROP COLUMN rule_id;

DELETE FROM schema_migrations WHERE version = '005_transaction_rule_ids.sql';
