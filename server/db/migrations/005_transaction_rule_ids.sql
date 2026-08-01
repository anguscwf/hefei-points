-- v2.5.0 / G-07
-- The archive is populated by rollback and lets a later roll-forward restore
-- stable rule/category links instead of silently degrading them to names only.
CREATE TABLE IF NOT EXISTS transaction_rule_links_v25_archive (
  transaction_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

ALTER TABLE transactions ADD COLUMN rule_id TEXT;
ALTER TABLE transactions ADD COLUMN category_id TEXT
  CHECK (
    (rule_id IS NULL AND category_id IS NULL)
    OR (rule_id IS NOT NULL AND category_id IS NOT NULL)
  );

UPDATE transactions
SET
  rule_id = (
    SELECT archive.rule_id FROM transaction_rule_links_v25_archive AS archive
    WHERE archive.transaction_id = transactions.id AND archive.family_id = transactions.family_id
  ),
  category_id = (
    SELECT archive.category_id FROM transaction_rule_links_v25_archive AS archive
    WHERE archive.transaction_id = transactions.id AND archive.family_id = transactions.family_id
  )
WHERE EXISTS (
  SELECT 1 FROM transaction_rule_links_v25_archive AS archive
  WHERE archive.transaction_id = transactions.id AND archive.family_id = transactions.family_id
);

CREATE INDEX IF NOT EXISTS idx_transactions_family_rule
  ON transactions(family_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_transactions_family_category
  ON transactions(family_id, category_id);
