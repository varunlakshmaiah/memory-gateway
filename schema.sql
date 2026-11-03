-- The index is disposable: every row can be rebuilt from the markdown files in R2
-- by calling POST /admin/reindex. Never store anything here that exists nowhere else
-- (the audit table is the one exception and is only a convenience log).

CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'current',
  updated     TEXT NOT NULL DEFAULT '',
  supersedes  TEXT NOT NULL DEFAULT '',
  etag        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  indexed_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path UNINDEXED,
  title,
  description,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  agent  TEXT NOT NULL,
  action TEXT NOT NULL,
  path   TEXT NOT NULL DEFAULT ''
);
