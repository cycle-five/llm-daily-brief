CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  email        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE identities (
  provider   TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_by_user ON identities (user_id);

CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  vector_status TEXT NOT NULL CHECK (vector_status IN ('pending', 'indexed')),
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, category, normalized)
);
CREATE INDEX entries_by_user_category ON entries (user_id, category, created_at DESC);
CREATE INDEX entries_pending ON entries (vector_status) WHERE vector_status = 'pending';
CREATE INDEX entries_by_category_normalized ON entries (category, normalized);

CREATE TABLE hits (
  id                   TEXT PRIMARY KEY,
  entry_id             TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL,
  candidate_text       TEXT NOT NULL,
  candidate_normalized TEXT NOT NULL,
  match_kind           TEXT NOT NULL CHECK (match_kind IN ('exact', 'trigram', 'semantic')),
  score                REAL NOT NULL,
  created_at           INTEGER NOT NULL
);
CREATE INDEX hits_by_entry ON hits (entry_id, created_at DESC);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_tokens_by_user ON api_tokens (user_id);
