CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE,
  invite_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'parent', 'child')),
  password TEXT NOT NULL DEFAULT '',
  family_id TEXT NOT NULL DEFAULT 'default',
  openid TEXT UNIQUE,
  bound_at TEXT,
  FOREIGN KEY (family_id) REFERENCES families(id)
);
CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS point_accounts (
  family_id TEXT NOT NULL,
  kid_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, kid_id),
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kid_id TEXT NOT NULL,
  kid_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_transactions_family_time ON transactions(family_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_family_kid ON transactions(family_id, kid_id);
