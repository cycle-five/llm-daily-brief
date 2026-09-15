ALTER TABLE entries ADD COLUMN alias_of TEXT REFERENCES entries(id) ON DELETE CASCADE;
CREATE INDEX entries_by_alias ON entries (alias_of) WHERE alias_of IS NOT NULL;

CREATE TABLE near_misses (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  matched_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  via_entry_id     TEXT REFERENCES entries(id) ON DELETE SET NULL,
  match_kind       TEXT NOT NULL CHECK (match_kind IN ('exact', 'trigram', 'semantic')),
  score            REAL NOT NULL,
  verdict          TEXT NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'repeat', 'distinct')),
  note             TEXT,
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER
);
CREATE INDEX near_misses_by_user ON near_misses (user_id, created_at DESC);
CREATE INDEX near_misses_by_claim ON near_misses (claim_entry_id);
