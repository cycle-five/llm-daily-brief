-- Model ledgers and overlaps. See docs/superpowers/specs/2026-09-16-model-ledgers-design.md

PRAGMA defer_foreign_keys = true;

-- New hit columns first, so the copy below carries them.
ALTER TABLE hits ADD COLUMN model TEXT COLLATE NOCASE;
ALTER TABLE hits ADD COLUMN model_version TEXT;

-- 1. Set aside every row that references entries. Dropping entries runs an implicit DELETE
--    that can fire ON DELETE CASCADE and SET NULL into these tables.
CREATE TABLE hits_keep AS SELECT * FROM hits;
CREATE TABLE near_misses_keep AS SELECT * FROM near_misses;

-- 2. Rebuild entries. alias_of references entries_new, not entries. A reference to the old
--    table would let the old table drop cascade into the new table aliases. The rename
--    below repoints it.
CREATE TABLE entries_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  vector_status TEXT NOT NULL CHECK (vector_status IN ('pending', 'indexed')),
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  alias_of      TEXT REFERENCES entries_new(id) ON DELETE CASCADE,
  model         TEXT COLLATE NOCASE,
  model_version TEXT,
  client        TEXT
);
INSERT INTO entries_new
  (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at, alias_of)
  SELECT id, user_id, category, display_name, normalized, vector_status, hit_count, created_at, alias_of
  FROM entries ORDER BY alias_of IS NOT NULL;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

-- 3. Put back whatever the drop removed. Deleting first makes this correct whether or not
--    the cascade fired.
DELETE FROM hits;
INSERT INTO hits SELECT * FROM hits_keep;
DELETE FROM near_misses;
INSERT INTO near_misses SELECT * FROM near_misses_keep;
DROP TABLE hits_keep;
DROP TABLE near_misses_keep;

-- 4. Indexes lost with the old table, and per-model uniqueness as a droppable index.
--    ifnull() carries no collation, so NOCASE must be stated or uniqueness turns case-sensitive.
CREATE UNIQUE INDEX entries_unique_per_model
  ON entries (user_id, category, ifnull(model, '') COLLATE NOCASE, normalized);
CREATE INDEX entries_by_user_category ON entries (user_id, category, created_at DESC);
CREATE INDEX entries_pending ON entries (vector_status) WHERE vector_status = 'pending';
CREATE INDEX entries_by_category_normalized ON entries (category, normalized);
CREATE INDEX entries_by_alias ON entries (alias_of) WHERE alias_of IS NOT NULL;

-- 5. The switch. 1 shares one ledger across all models, which is the behaviour before this migration.
ALTER TABLE users ADD COLUMN share_ledger INTEGER NOT NULL DEFAULT 1 CHECK (share_ledger IN (0, 1));

-- 6. Overlaps between models.
CREATE TABLE overlaps (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  matched_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  via_entry_id     TEXT REFERENCES entries(id) ON DELETE SET NULL,
  match_kind       TEXT NOT NULL CHECK (match_kind IN ('exact', 'trigram', 'semantic')),
  score            REAL NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX overlaps_by_user ON overlaps (user_id, created_at DESC);
CREATE INDEX overlaps_by_claim ON overlaps (claim_entry_id);
