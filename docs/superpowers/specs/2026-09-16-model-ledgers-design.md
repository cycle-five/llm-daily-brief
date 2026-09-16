# Topic Ledger — Model ledgers and overlaps

- **Date:** 2026-09-16
- **Status:** Approved by the owner; implemented on `feat/model-ledgers` (v0.2.0). Matching step 3
  amended during implementation (alias-scope rule).
- **Branch:** `feat/model-ledgers` (ships in v0.2.0)
- **Amends:** `docs/superpowers/specs/2026-09-14-topic-ledger-design.md` and
  `docs/superpowers/specs/2026-09-15-near-misses-design.md`; where they disagree, this document
  wins.

## Problem

The owner runs a morning brief on three models — Claude (claude.ai), Grok (grok.com), and soon
Gemini — each connected to the same account, so all three share one ledger.

1. **Models block each other.** The owner is content for two models to cover the same topic, but
   a shared ledger refuses the second one and records the refusal as a hit. A hit then no longer
   means "this model repeated itself", which is the measurement the ledger exists for.
2. **Nobody records which model claimed what.** The OAuth grant stores the client's name
   (`completeAuthorization` writes `metadata: { clientName }`) and personal tokens have labels,
   but `props` carries only `userId`, so identity is discarded before the ledger sees a claim.
3. **A client name identifies the app, not the model.** claude.ai reports "Claude" whichever
   Claude model is running, and a multi-model client such as openclaw reports its own name for
   every model behind it.
4. **The schema forbids it anyway.** `entries` has a table-level
   `UNIQUE (user_id, category, normalized)`, so two models cannot both store the same topic.

Evidence, 2026-09-16: Grok connected at 07:49 UTC on the owner's account. Its first claim,
*Émilie du Châtelet*, came back as a `possible_repeat` against four of Claude's people (La Boétie,
Galois, Noether, Lovelace), and Grok was asked to rule on topics that were never its concern.

## Goals

1. Every claim records the model that made it: the **model family** (declared by the model), an
   optional **model version** (declared, a label only), and the **connection name** (audit only).
2. A per-user switch, **share one ledger across all my models**. On: today's behaviour. Off: each
   model family blocks only its own repeats.
3. With the switch off, a match against another model never blocks and never asks for a verdict.
   It is stored as an **overlap** with its match kind and score.
4. The dashboard shows overlaps (exact and spelling matches apart from meaning-only ones, with a
   toggle to combine them), the model behind each topic, a per-model repeat rate, and the switch.
5. Deploying changes no behaviour. (MCP callers must now declare `model`; see Rollout step 6.)
   Flipping the switch is the cutover.

## Non-goals

- Sharing between some models but not others. There is one switch per user.
- Renaming or merging model names on the dashboard. A misdeclared model is corrected by SQL.
- Verdicts on overlaps, or overlaps in the REST or MCP API.
- Naming a match's owning model in the wire `Match` type.
- Filtering Vectorize queries by model (see *Matching → Known limit*).
- Changes to the global leaderboard or the brief prompt.

## Identity

### The model declares itself

| Field | MCP (`claim_topic`, `check_topic`) | REST (`/claims`, `/checks`) |
|---|---|---|
| `model` | required | optional; defaults to the connection name |
| `model_version` | optional, `claim_topic` only | optional, `/claims` only |

- Both are trimmed and 1–64 UTF-8 bytes.
- `model` is compared case-insensitively (`COLLATE NOCASE` in SQL, lower-casing in TypeScript) and
  stored as given.
- MCP parameter descriptions, pinned by a test:
  - `model`: *"Your model family name only, such as \"Claude\", \"Grok\" or \"Gemini\" — not a
    version. It selects the ledger your repeats are checked against, so keep it the same across
    upgrades."*
  - `model_version`: *"Optional: your specific model or version, such as \"Opus 5\". Recorded as
    a label; it never affects matching."*
- `skip_topic`, `keep_topic` and `forget` act on entry ids and take no model. `list_topics` and
  `topic_stats` accept `model` as an optional filter.

### The connection name

- **Personal token (`ldg_`):** the token's `label`. `resolvePersonalToken` returns
  `{ userId, client: label }` and `PropsSchema` gains an optional `client`.
- **OAuth access token:** `env.OAUTH_PROVIDER.unwrapToken(bearer)` gives `grant.clientId`, and
  `lookupClient(clientId)` gives `clientName`, falling back to the client id when the client
  registered without a name. The provider injects `env.OAUTH_PROVIDER` before calling handlers
  (library source: `if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env)`).
  This works for grants that already exist, so nothing needs reconnecting.
- Resolved lazily and memoised per request, so only claims, and REST checks that omit `model`, pay
  the two KV reads.
- A connection name always exists (label, client name, or client id). It is stored in
  `entries.client` for audit and is never used for matching, except as REST's default `model`.

## Data model

Migration `migrations/0003_model_ledgers.sql`:

```sql
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
```

- `entries.model` is `NULL` for an **unattributed** row (created before this migration and not
  backfilled). An unattributed row belongs to every model.
- `entries_unique_per_model` refuses a second entry for the same user, category, model (any case)
  and normalized name, allows the same topic under different models, and groups unattributed rows
  together — so they still collide with each other exactly as before.
- `hits.model` and `hits.model_version` name the model that made the attempt. With the switch on,
  that can differ from the model that owns the entry.
- `overlaps` holds one row per match between a claim and **another model's** entry, written when
  that claim creates an entry with the switch off. `matched_entry_id` is an original when the row
  is written (a later skip can make it an alias) and `via_entry_id` means what it means on
  `near_misses`. Each side's model is read from `entries`.
- SQL comments in the migration avoid apostrophes and semicolons, so no statement splitter can
  misparse them.

### The migration's traps

Production has no aliases today, so none of these would damage this deployment — which is exactly
why tests, not production, must prove each one is handled.

1. **Dropping `entries` can empty the tables that reference it.** SQLite runs an implicit `DELETE`
   before `DROP TABLE`, and that can fire the `ON DELETE CASCADE` and `SET NULL` actions on `hits`,
   `near_misses` and aliases. D1 does not let a migration turn foreign keys off, and deferring
   foreign keys defers checks, not actions. Step 1 sets those rows aside and step 3 restores them.
2. **The rebuilt table's self-reference must name `entries_new`.** Otherwise the old table's drop
   cascades into the new table's aliases.
3. **An expression has no collation.** Without the explicit `COLLATE NOCASE`, "claude" and "Claude"
   would be allowed to hold the same topic twice.
4. **Copy order.** Originals are copied before aliases, so the copy never depends on deferred
   foreign-key checks. `defer_foreign_keys` is set anyway.

### Compatibility

v0.1.0 names every column it reads and writes. Its inserts create unattributed rows, which the new
index still treats as one group, so v0.1.0 keeps working on the new schema. Rollout step 1 proves it
by running v0.1.0's own test suite with this migration added.

## Matching

`Ledger.evaluate` receives the caller's model and the user's switch, and changes in three places:

1. **Collect** lexical candidates, exact rows and semantic hits for the whole user and category, as
   today — except that `findExact` now returns every exact row (at most one per model) instead of
   the first.
2. **Resolve aliases** as today.
3. **Split by scope.** With the switch on, every match is *in scope*. With it off, a match is in
   scope when its original's model is `NULL` or equals the caller's model case-insensitively;
   otherwise it is *cross-model*. A match through an alias is in scope when either the alias or its
   original belongs to the caller's model or is unattributed: the alias records the caller's own
   earlier judgment, and without this rule the claim would collide with the caller's own alias row
   in the per-model unique index. It is cross-model only when neither belongs to the caller.
4. **Rank each group separately** with `rankMatches` (dedupe by entry, order by `KIND_RANK` then
   score, cap at `MAX_MATCHES`). Separate ranking stops other models' matches from pushing the
   caller's own out of the five slots, and `KIND_RANK` puts exact and trigram ahead of semantic,
   so a meaning-only overlap never displaces an exact or spelling one.

In-scope matches drive everything that exists today: repeat, possible repeat, force, near misses
and the response. Cross-model matches become overlap rows and never appear in a response.

The overlap list is capped at `MAX_MATCHES` (5) per claim, like every other match list. Because
exact and trigram rank first, the cap can only ever drop the weakest meaning-only matches.

**Semantic over-fetch:** `SEMANTIC_TOP_K` rises from 10 to 20. Twenty is within Vectorize's `topK`
limit in every return mode; going higher requires confirming the limit for id-and-score queries
first.

**Known limit:** Vectorize still searches every model's vectors. If more than twenty of a claim's
nearest neighbours belong to other models, a same-model *possible* match can be missed. That costs
an advisory verdict, never a block, because lexical matching is unaffected. The upgrade path is to
add `model` to vector metadata with a metadata index and query in-scope vectors separately; current
volume does not need it.

**Known race:** with the switch on, two different models claiming the same new topic at the same
moment can both insert it, because the index allows the same topic under different models. The old
constraint prevented this. It needs two briefs claiming an identical topic within the same second.

## Operations

### claim

- **In-scope repeat:** returns `repeat` as today. The hit records the caller's `model` and
  `model_version`. No overlap rows.
- **Otherwise:** the entry is inserted with `model`, `model_version` and `client`; near misses are
  written for in-scope matches exactly as today; with the switch off, one `overlaps` row is written
  per ranked cross-model match, of any kind. Overlaps are written whether or not `force` is set.
- A same-model duplicate insert retries as today.

Every cross-model pair is recorded once, by the later of the two claims: the earlier claim could not
match an entry that did not exist yet, and a later same-model repeat is blocked before it creates
one.

### check

The same scope rule applies. `likely_repeat` and `matches` come from the in-scope group only. Check
still records nothing.

### skip and keep

Unchanged. A skip's hit takes its `model` and `model_version` from the claim entry it aliases.

### list and stats

- `list`: optional `model` filter, case-insensitive. Unattributed rows appear only without a filter.
- `stats` scope `me`: optional `model` filter on the entry's model, with the same rule for
  unattributed rows. Scope `global` is unchanged.

### forget

Unchanged. Deleting an entry now also cascades to overlaps on either side.

### Wire changes

```ts
interface ClaimInput     { category: string; name: string; force?: boolean;
                           model?: string; model_version?: string }        // REST
interface ClaimToolInput extends ClaimInput { model: string }              // MCP: required
interface CheckInput     { category: string; name: string; model?: string }  // REST
interface CheckToolInput extends CheckInput { model: string }              // MCP: required
interface ListInput      { category?: string; limit: number; since?: string; model?: string }
interface StatsInput     { scope: "me" | "global"; category?: string; limit: number; model?: string }
interface Entry          { id: string; category: string; display_name: string;
                           created_at: string; hit_count: number; model: string | null }
```

`Match`, `ClaimResult`, `SkipResult` and `KeepResult` are unchanged.

## Dashboard

- **Account (`/account`):** the switch, labelled *Share one ledger across all my models*, with a
  sentence describing the current state and a button that switches to the other.
  `POST /account/ledger-sharing` through the existing `action` guard. No REST or MCP route can
  change it.
- **Overlaps (`/overlaps`, new, in the nav between Near misses and Global):**
  - Default view: **Overlaps** (exact and trigram) and, separately, **Similar, unverified**
    (semantic). `?view=combined` shows one list.
  - Columns: Date, Topic (the later claim), Model, Matched topic, Model, Match, Score.
  - While the switch is on, a notice explains that matches between models block instead, and links
    to Repeats. Stored overlap rows show either way.
- **Ledger (`/ledger`):** a Model column showing "Claude (Opus 5)", or "—" when unattributed. The
  connection name appears in small text when it differs from the model case-insensitively. A
  case-insensitive `?model=` filter.
- **Repeats (`/repeats`):**
  - A per-model summary first: Model, Topics, Repeats, **Repeat rate** =
    `hits / (originals + hits)`, where *originals* are the model's entries with `alias_of IS NULL`
    and *hits* are hits whose `model` is that model. Every attempt ends as a kept original, a
    blocked hit with no entry, or a skip (an alias that is no longer an original, plus a hit), so
    the denominator counts attempts. The rate shows "—" when a model has no attempts. Models are
    grouped case-insensitively and labelled with the spelling on their most recent entry.
    Unattributed rows form their own line when any exist.
  - A phrasing row shows "by Grok" when the hit's model differs from the entry's.
- **Near misses (`/near-misses`):** the matched topic's model is shown when it differs from the
  claim's.
- **Connect (`/connect`):** the script example gains `model`.
- Global and Access are unchanged.

## Brief integration

No prompt change. `model` is required by the tool schema, and frontier models fill required
parameters from it. If a model declares a version as its family or otherwise misdeclares, the Ledger
page's Model column shows it; correct those rows by SQL and add a clause to that brief's prompt.

## Rollout

Deploying changes nothing, because every user's switch starts on. Each production step is confirmed
with the owner at the time.

1. **Compatibility check** (during implementation): in a worktree of `v0.1.0`, add
   `0003_model_ledgers.sql` to `migrations/` and run `npm test`. It must pass.
2. **Merge the PR** (version already 0.2.0). Migration 0003 is applied from `master` so a review fix
   cannot leave production running a migration that differs from the one merged.
3. **Safety net:** `npx wrangler d1 time-travel info topic-ledger` and record the bookmark, then
   `npx wrangler d1 export topic-ledger --remote --output=<scratch>/pre-0003.sql`, where `<scratch>`
   is a directory outside the repository.
4. **Dress rehearsal:** load the export into a scratch local database
   (`npx wrangler d1 execute topic-ledger --local --persist-to=<scratch>/rehearsal --file=<scratch>/pre-0003.sql`),
   apply migrations locally with the same `--persist-to`, and compare row counts for `users`,
   `identities`, `api_tokens`, `entries`, aliases, `hits` and `near_misses` before and after.
5. **Apply 0003 to production:** `npx wrangler d1 migrations apply topic-ledger --remote`, then
   compare the same counts against step 3.
6. **Tag:** `git tag -s v0.2.0 -m "v0.2.0"` and `git push origin v0.2.0`. The Deploy workflow finds
   0003 already applied and deploys. Tag between brief runs: an MCP session that listed tools
   before the deploy would fail schema validation on `claim_topic` and `check_topic`, because
   `model` is now required; claude.ai and grok.com list tools again for each new conversation.
7. **Backfill** the owner's account (`:owner` is its user id). Rows written before step 6 carry no
   model.
   - **Known at spec time (2026-09-16):** everything before Grok's grant (created 1789544973
     seconds, 07:49:33 UTC) is Claude's. The two runs after it (07:56 and 11:30 UTC, four entries)
     are Grok's, confirmed by the owner. All three hits predate Grok.
   - **Briefs keep running until step 6,** so a time boundary alone would credit Claude's later runs
     to Grok, and a Grok claim blocked by a Claude topic leaves a hit whose model differs from its
     entry's. So list the unattributed rows created after the grant, grouped into runs by
     timestamp, and have the owner assign each run to a model. The updates then name ids.
   - Count aliases first (`SELECT COUNT(*) FROM entries WHERE alias_of IS NOT NULL`); with none,
     the `via` guard changes nothing.

   ```sql
   -- Rows after Grok connected, for the owner to assign to runs and models.
   SELECT 'entry' AS kind, id, display_name AS text, category, created_at FROM entries
     WHERE user_id = :owner AND model IS NULL AND created_at >= 1789544973000
   UNION ALL
   SELECT 'hit', id, candidate_text, NULL, created_at FROM hits
     WHERE user_id = :owner AND model IS NULL AND created_at >= 1789544973000
   ORDER BY created_at;

   -- The owner assignment, one pair of statements per model.
   UPDATE entries SET model = :model, client = :model WHERE user_id = :owner AND id IN (:entry_ids);
   UPDATE hits SET model = :model WHERE user_id = :owner AND id IN (:hit_ids);

   -- Everything still unattributed predates Grok, so it belongs to Claude.
   UPDATE entries SET model = 'Claude', client = 'Claude' WHERE user_id = :owner AND model IS NULL;
   UPDATE hits SET model = 'Claude' WHERE user_id = :owner AND model IS NULL;

   -- The overlaps the ledger would have recorded, from near misses between models.
   INSERT INTO overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at)
     SELECT lower(hex(randomblob(16))), n.user_id, n.claim_entry_id, n.matched_entry_id,
            n.via_entry_id, n.match_kind, n.score, n.created_at
     FROM near_misses n
     JOIN entries c ON c.id = n.claim_entry_id
     JOIN entries m ON m.id = n.matched_entry_id
     LEFT JOIN entries v ON v.id = n.via_entry_id
     WHERE n.user_id = :owner AND c.model <> m.model COLLATE NOCASE
       AND (v.id IS NULL OR (v.model IS NOT NULL AND v.model <> c.model COLLATE NOCASE));
   ```

   Expected with the data as of spec time: 4 entries Grok, the rest Claude, 3 hits Claude, and 5
   overlap rows (all `semantic`). Later runs add to these. The near-miss rows stay: they record what
   the ledger actually asked at the time.
8. **Smoke test, switch on,** with a personal token in the throwaway category `smoke-models`: claim
   a topic as `smoke-a` (claimed), then as `smoke-b` (repeat); the hit's model is `smoke-b`.
9. **The owner turns the switch off** on the Account page.
10. **Smoke test, switch off:** claim the same topic as `smoke-b` (claimed, one `exact` overlap);
    claim it again as `SMOKE-B` (repeat, proving case-insensitivity). Delete the smoke entries and
    confirm their overlaps cascaded away.
11. **Watch the next real runs** declare `Claude` and `Grok` rather than version strings.

**Rollback.** Code: `npx wrangler rollback` to Worker version `dc5e4470` (v0.1.0), which step 1
proves runs on the new schema. Data:
`npx wrangler d1 time-travel restore topic-ledger --bookmark=<bookmark recorded in step 3>`,
losing only writes made after the bookmark.

## Testing

- **Migration 0003** runs on a dedicated, unmigrated D1 binding (`MIGRATION_DB` in
  `wrangler.test.jsonc` and `test/env.d.ts`), applying `TEST_MIGRATIONS` stepwise: 0001 and 0002,
  then seed users, originals, aliases, hits and near misses (including `via_entry_id`), then 0003.
  - Every seeded row survives with identical values; aliases still point at their originals.
  - On the rebuilt table, deleting an original still cascades to its aliases, hits, near misses and
    overlaps, and still sets `via_entry_id` to `NULL`.
  - The unique index refuses the same model in another case, allows different models, and makes
    unattributed rows collide.
  - **Falsified three times,** each against a named test: remove the set-aside and restore steps,
    point `alias_of` at `entries`, and drop `COLLATE NOCASE` from the index.
  - The existing 0001 test that rejects a duplicate normalized name still holds, because both of
    its rows are unattributed, and is joined by the per-model cases above.
- **Ledger,** with the fake semantic index, in both switch states:
  - cross-model exact, trigram and semantic matches (overlap when off, block or ask when on);
  - a claim with both in-scope and cross-model matches;
  - an unattributed row blocking every model;
  - an alias whose original belongs to another model;
  - flipping the switch with entries created under both states;
  - more cross-model semantic matches than `MAX_MATCHES` scoring above an in-scope one, which still
    comes back as `possible_repeat` (proves separate ranking);
  - hits recording the caller's model, including a skip's hit;
  - `findExact` returning one row per model.
- **MCP:** `model` required on `claim_topic` and `check_topic`; both parameter descriptions pinned;
  the OAuth client name stored as `client`; `list_topics` and `topic_stats` filters.
- **REST:** `model` defaults to the token label; an explicit `model` wins.
- **Dashboard:** each overlap row pinned to its section in both views; the repeat rate pinned with a
  worked example containing a kept claim, a blocked repeat and a skip (2 hits over 3 attempts); the
  switch posts and persists; the Model column and filter; "by Grok" on a cross-model hit.
- Every new guard test is falsified by breaking the code it protects.

## Documentation

- README: a **Models** section covering declaration, the switch, the Overlaps page and the repeat
  rate; the REST table's claim, check, list and stats rows gain their `model` fields.
- `package.json` version and `MCP_SERVER_VERSION` become `0.2.0`.
