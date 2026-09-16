# Model Ledgers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every claim to the model that made it, let each model family keep its own ledger behind a per-user switch, and record matches between models as overlaps.

**Architecture:** Migration 0003 rebuilds `entries` with `model`, `model_version` and `client` and moves uniqueness into a per-model index; `hits` gain the attempting model; `users` gain `share_ledger`; a new `overlaps` table records matches between models. The ledger reads the user's switch, splits resolved matches into in-scope and cross-model groups before ranking, and writes overlaps for the cross-model group. The API layer resolves the connection name (token label or OAuth client name) lazily. The dashboard gains an Overlaps page, a model column, a per-model repeat rate and the switch.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vectorize, Hono 4 JSX, zod 4, `@modelcontextprotocol/server` 2, `@cloudflare/workers-oauth-provider` 0.10.3, Vitest 4 with `@cloudflare/vitest-plugin`, Biome, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-16-model-ledgers-design.md`

## Global Constraints

- Every commit ends with exactly this trailer and no other `Co-Authored-By` line: `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- `npm run check` (tsc + biome + vitest) passes at the end of every task. Biome uses tabs, line width 100, double quotes; run `npx biome check --write .` before committing. Run one file with `npx vitest run test/<name>.test.ts`.
- TypeScript is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: type-only imports use `import type` or an inline `type` modifier.
- Every row and wire shape is a zod schema, and D1 rows are parsed through their schema.
- `model` and `model_version` are trimmed and 1–64 UTF-8 bytes. `model` compares case-insensitively with ASCII-only folding (SQLite `NOCASE`) and is stored as given.
- An entry whose `model` is `NULL` is unattributed and belongs to every model.
- `users.share_ledger` defaults to 1 (shared, which is today's behaviour). A user whose switch is on must see no behaviour change.
- MCP parameter descriptions, verbatim — `model`: `Your model family name only, such as "Claude", "Grok" or "Gemini" — not a version. It selects the ledger your repeats are checked against, so keep it the same across upgrades.` — `model_version`: `Optional: your specific model or version, such as "Opus 5". Recorded as a label; it never affects matching.`
- `SEMANTIC_TOP_K` is 20. Overlap lists are capped at `MAX_MATCHES` (5) per claim by `rankMatches`.
- Regular expressions and other pattern constants in `src/` are ASCII-only.
- SQL comments in migrations contain no apostrophes and no semicolons.
- The brief prompt (`BRIEF_PROMPT_SNIPPET` in `src/web/prompt.ts` and its quote in `README.md`) does not change.
- Every new test that guards a behaviour is falsified: break the code it protects, run it, confirm it fails for the expected reason, restore the code. Report each break and the failing assertion.
- The version becomes 0.2.0 (`package.json`, `package-lock.json`, `MCP_SERVER_VERSION`).

## File map

| File | Task | Responsibility |
|---|---|---|
| `migrations/0003_model_ledgers.sql` | 1 | Rebuild `entries`, add model columns, the switch and `overlaps` |
| `wrangler.test.jsonc`, `test/env.d.ts` | 1 | An unmigrated `MIGRATION_DB` binding for stepwise migration tests |
| `src/core/rows.ts` | 2, 3 | Row schemas gain model columns, `share_ledger`, `OverlapRow` |
| `src/store/d1.ts` | 2, 3 | Model columns in queries; overlaps, near-miss models, per-model summary |
| `src/core/match.ts` | 4 | `sameModel`, `splitByScope` |
| `src/core/ledger.ts` | 2, 4 | Scope split, overlaps, model on entries and hits |
| `src/api/schemas.ts`, `src/core/wire.ts` | 4 | Model fields on inputs and `Entry` |
| `src/api/connection.ts` (new) | 5 | Connection name and `once` |
| `src/env.ts`, `src/auth/tokens.ts`, `src/api/context.ts`, `src/api/handler.ts`, `src/api/rest.ts`, `src/api/mcp.ts` | 5 | Identity plumbing and declared models over REST and MCP |
| `src/web/dashboard.tsx`, `src/web/layout.tsx` | 6 | Overlaps page, model column, repeat rate, switch |
| `README.md`, `package.json`, `package-lock.json` | 7 | Documentation and version |

---

### Task 1: Migration 0003 and its tests

**Files:**
- Create: `migrations/0003_model_ledgers.sql`
- Modify: `wrangler.test.jsonc` (add a second D1 binding)
- Modify: `test/env.d.ts`
- Modify: `test/migrations.test.ts` (imports; append a `describe`)

**Interfaces:**
- Consumes: migrations 0001 and 0002.
- Produces (schema only, no application code changes):
  - `entries` gains `model TEXT COLLATE NOCASE`, `model_version TEXT`, `client TEXT`; unique index `entries_unique_per_model` on `(user_id, category, ifnull(model, '') COLLATE NOCASE, normalized)` replaces the table-level `UNIQUE`.
  - `hits` gains `model TEXT COLLATE NOCASE`, `model_version TEXT`.
  - `users` gains `share_ledger INTEGER NOT NULL DEFAULT 1 CHECK (share_ledger IN (0, 1))`.
  - New table `overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at)`.
  - Test binding `env.MIGRATION_DB: D1Database`, never migrated by `test/setup.ts`.

- [ ] **Step 1: Add the unmigrated test database**

In `wrangler.test.jsonc`, replace the `d1_databases` array with:

```jsonc
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "topic-ledger",
			"database_id": "00000000-0000-0000-0000-000000000000",
			"migrations_dir": "migrations"
		},
		{
			"binding": "MIGRATION_DB",
			"database_name": "topic-ledger-migrations",
			"database_id": "00000000-0000-0000-0000-000000000001"
		}
	],
```

In `test/env.d.ts`, add the binding to the `Env` interface:

```ts
		interface Env extends AppEnv {
			TEST_MIGRATIONS: D1Migration[];
			/** Left unmigrated by test/setup.ts so migration tests can apply migrations stepwise. */
			MIGRATION_DB: D1Database;
		}
```

- [ ] **Step 2: Write the failing migration tests**

In `test/migrations.test.ts`, change the first two lines to:

```ts
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
```

Append to the end of the file:

```ts
describe("migration 0003_model_ledgers", () => {
	const db = env.MIGRATION_DB;
	const userId = crypto.randomUUID();
	const euler = crypto.randomUUID();
	const gauss = crypto.randomUUID();
	const alias = crypto.randomUUID();
	const claim = crypto.randomUUID();
	type Row = Record<string, unknown>;
	let before: { entries: Row[]; hits: Row[]; nearMisses: Row[] };

	async function rows(sql: string): Promise<Row[]> {
		return (await db.prepare(sql).all<Row>()).results;
	}

	async function count(table: string, column: string, value: string): Promise<number> {
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`)
			.bind(value)
			.first<{ n: number }>();
		return row?.n ?? -1;
	}

	function insertUser(id: string) {
		return db
			.prepare("INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, 1)")
			.bind(id);
	}

	beforeAll(async () => {
		await applyD1Migrations(
			db,
			env.TEST_MIGRATIONS.filter((migration) => migration.name < "0003"),
		);
		const entry = (id: string, name: string, hitCount: number, aliasOf: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at) VALUES (?1, ?2, 'math', ?3, ?4, 'indexed', ?5, ?6, 1)",
				)
				.bind(id, userId, name, name.toLowerCase(), hitCount, aliasOf);
		await db.batch([
			insertUser(userId),
			entry(euler, "Euler", 1, null),
			entry(gauss, "Gauss", 0, null),
			entry(alias, "Leonhard Euler", 0, euler),
			entry(claim, "Prince of mathematicians", 0, null),
			db
				.prepare(
					"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at) VALUES (?1, ?2, ?3, 'euler', 'euler', 'exact', 1, 5)",
				)
				.bind(crypto.randomUUID(), euler, userId),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, note, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.9, 'pending', NULL, 6, NULL)",
				)
				.bind(crypto.randomUUID(), userId, claim, euler, alias),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, note, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, NULL, 'semantic', 0.8, 'distinct', 'different', 6, 7)",
				)
				.bind(crypto.randomUUID(), userId, claim, gauss),
		]);
		before = {
			entries: await rows("SELECT * FROM entries ORDER BY id"),
			hits: await rows("SELECT * FROM hits ORDER BY id"),
			nearMisses: await rows("SELECT * FROM near_misses ORDER BY id"),
		};
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
	});

	it("keeps every entry, alias, hit and near miss, adding only unattributed model columns", async () => {
		// Non-empty snapshots, so the comparisons below cannot pass vacuously.
		expect(before.entries).toHaveLength(4);
		expect(before.hits).toHaveLength(1);
		expect(before.nearMisses).toHaveLength(2);

		expect(await rows("SELECT * FROM entries ORDER BY id")).toEqual(
			before.entries.map((row) => ({ ...row, model: null, model_version: null, client: null })),
		);
		expect(await rows("SELECT * FROM hits ORDER BY id")).toEqual(
			before.hits.map((row) => ({ ...row, model: null, model_version: null })),
		);
		expect(await rows("SELECT * FROM near_misses ORDER BY id")).toEqual(before.nearMisses);
		expect(
			await rows(
				"SELECT name FROM sqlite_master WHERE name IN ('hits_keep', 'near_misses_keep', 'entries_new')",
			),
		).toEqual([]);
	});

	it("cascades on the rebuilt table: aliases, hits, near misses and overlaps go with an original", async () => {
		const owner = crypto.randomUUID();
		const original = crypto.randomUUID();
		const viaAlias = crypto.randomUUID();
		const keptAlias = crypto.randomUUID();
		const other = crypto.randomUUID();
		const claimer = crypto.randomUUID();
		const nearMiss = crypto.randomUUID();
		const overlapVia = crypto.randomUUID();
		const overlapOnOther = crypto.randomUUID();
		const entry = (id: string, name: string, aliasOf: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at, model) VALUES (?1, ?2, 'math', ?3, ?4, 'pending', 0, ?5, 1, 'Claude')",
				)
				.bind(id, owner, name, name.toLowerCase(), aliasOf);
		await db.batch([
			insertUser(owner),
			entry(original, "Hypatia", null),
			entry(viaAlias, "Hypatia of Alexandria", original),
			entry(keptAlias, "The Philosopher", original),
			entry(other, "Noether", null),
			entry(claimer, "Alexandrian mathematician", null),
			db
				.prepare(
					"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at, model) VALUES (?1, ?2, ?3, 'hypatia', 'hypatia', 'exact', 1, 2, 'Grok')",
				)
				.bind(crypto.randomUUID(), original, owner),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.9, 'pending', 3)",
				)
				.bind(nearMiss, owner, claimer, original, viaAlias),
			db
				.prepare(
					"INSERT INTO overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'exact', 1, 3)",
				)
				.bind(overlapVia, owner, claimer, original, viaAlias),
			db
				.prepare(
					"INSERT INTO overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 'semantic', 0.8, 3)",
				)
				.bind(overlapOnOther, owner, claimer, other),
		]);
		expect(await count("hits", "entry_id", original)).toBe(1);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(viaAlias).run();
		expect(await rows(`SELECT via_entry_id FROM near_misses WHERE id = '${nearMiss}'`)).toEqual([
			{ via_entry_id: null },
		]);
		expect(await rows(`SELECT via_entry_id FROM overlaps WHERE id = '${overlapVia}'`)).toEqual([
			{ via_entry_id: null },
		]);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(original).run();
		expect(await count("entries", "id", keptAlias)).toBe(0);
		expect(await count("hits", "entry_id", original)).toBe(0);
		expect(await count("near_misses", "id", nearMiss)).toBe(0);
		expect(await count("overlaps", "id", overlapVia)).toBe(0);
		expect(await count("overlaps", "id", overlapOnOther)).toBe(1);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(claimer).run();
		expect(await count("overlaps", "id", overlapOnOther)).toBe(0);
	});

	it("allows a topic once per model, case-insensitively, and makes unattributed rows collide", async () => {
		const owner = crypto.randomUUID();
		await insertUser(owner).run();
		const insert = (model: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at, model) VALUES (?1, ?2, 'math', 'Noether', 'noether', 'pending', 0, 1, ?3)",
				)
				.bind(crypto.randomUUID(), owner, model)
				.run();

		await insert("Claude");
		await expect(insert("claude")).rejects.toThrow(/UNIQUE constraint failed/);
		await insert("Grok");
		await insert(null);
		await expect(insert(null)).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("defaults share_ledger to on and accepts only 0 or 1", async () => {
		const owner = crypto.randomUUID();
		await insertUser(owner).run();
		expect(
			await db.prepare("SELECT share_ledger FROM users WHERE id = ?1").bind(owner).first(),
		).toEqual({ share_ledger: 1 });
		await db.prepare("UPDATE users SET share_ledger = 0 WHERE id = ?1").bind(owner).run();
		await expect(
			db.prepare("UPDATE users SET share_ledger = 2 WHERE id = ?1").bind(owner).run(),
		).rejects.toThrow(/CHECK constraint failed/);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/migrations.test.ts`
Expected: FAIL — the four new tests fail (no `model` columns, no `overlaps` table, no `share_ledger`); the existing 0001 and 0002 tests still pass.

- [ ] **Step 4: Write the migration**

Create `migrations/0003_model_ledgers.sql` with exactly this content:

```sql
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
```

Contingency: if applying the migration fails only because `PRAGMA defer_foreign_keys = true` is rejected, delete that line (the copy order makes the migration independent of it) and report it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/migrations.test.ts`
Expected: PASS (all tests in the file).

Run: `npm run check`
Expected: PASS. No application code reads the new columns yet, and the existing duplicate-name test in the 0001 block still holds because both of its rows are unattributed.

- [ ] **Step 6: Falsify the three traps**

Make each change, run `npx vitest run test/migrations.test.ts`, record the failure, then restore the file exactly (`git diff migrations/` must be empty before the next break).

1. Delete both `CREATE TABLE ..._keep` lines and the whole step-3 block (from `DELETE FROM hits;` through `DROP TABLE near_misses_keep;`). Expected: FAIL in "keeps every entry, alias, hit and near miss" (hits and near misses gone).
2. In `entries_new`, change `REFERENCES entries_new(id)` to `REFERENCES entries(id)`. Expected: FAIL — either the migration errors on a foreign-key check or the survival test reports the alias missing.
3. In `entries_unique_per_model`, delete `COLLATE NOCASE`. Expected: FAIL in "allows a topic once per model" (the `claude` insert succeeds).

If break 1 or 2 does not fail, the local D1 did not cascade on `DROP TABLE`. Keep the migration unchanged (production D1 may differ and the spec requires the steps) and report the observation instead.

- [ ] **Step 7: Prove v0.1.0 runs on the new schema**

```bash
SP=/tmp/claude-1000/-home-lothrop-projects-llm-daily-brief/5148450b-14e7-4f0c-8814-c4b001bf45ad/scratchpad
git worktree add "$SP/v010-compat" v0.1.0
cp migrations/0003_model_ledgers.sql "$SP/v010-compat/migrations/"
(cd "$SP/v010-compat" && npm ci && npm test)
git worktree remove --force "$SP/v010-compat"
```

Expected: every v0.1.0 test passes with migration 0003 applied. Report the pass count. A failure here blocks the rollout order in the spec; report it rather than changing v0.1.0.

- [ ] **Step 8: Commit**

```bash
git add migrations/0003_model_ledgers.sql wrangler.test.jsonc test/env.d.ts test/migrations.test.ts
git commit -F - <<'EOF'
feat: add migration 0003 for model ledgers and overlaps

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 2: Model columns in rows and the store

**Files:**
- Modify: `src/core/rows.ts` (`UserRowSchema`, `EntryRowSchema`, `HitRowSchema`)
- Modify: `src/store/d1.ts`
- Modify: `src/core/ledger.ts` (compile only: new columns, `findExact` returns an array)
- Modify: `test/helpers.ts` (`makeEntry`, `makeHit` defaults)
- Modify: `test/match.test.ts` (the local `entry()` helper)
- Modify: `test/store.test.ts`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces:
  - `EntryRow` gains `model: string | null`, `model_version: string | null`, `client: string | null`.
  - `HitRow` gains `model: string | null`, `model_version: string | null`.
  - `UserRow` gains `share_ledger: boolean`.
  - `LedgerStore.findExact(userId: string, category: string, normalized: string): Promise<EntryRow[]>`
  - `LedgerStore.setShareLedger(userId: string, share: boolean): Promise<void>`
  - `LedgerStore.listEntries(userId: string, options: { category?: string; limit: number; sinceMs?: number; model?: string }): Promise<EntryRow[]>`
  - `LedgerStore.topRepeatsForUser(userId: string, category: string | undefined, limit: number, model?: string): Promise<UserRepeatRow[]>`
  - `RepeatHit` gains `model: string | null`.
  - Behaviour is unchanged: the ledger writes `null` model columns until Task 4.

- [ ] **Step 1: Give test fixtures the new columns**

In `test/helpers.ts`, `makeEntry` returns (add the three fields before `created_at`):

```ts
	return {
		id: crypto.randomUUID(),
		user_id: userId,
		category,
		display_name: displayName,
		normalized: normalize(displayName),
		vector_status: "pending",
		hit_count: 0,
		alias_of: null,
		model: null,
		model_version: null,
		client: null,
		created_at: Date.now(),
		...overrides,
	};
```

and `makeHit` returns:

```ts
	return {
		id: crypto.randomUUID(),
		entry_id: entry.id,
		user_id: entry.user_id,
		candidate_text: candidate,
		candidate_normalized: normalize(candidate),
		match_kind: "exact",
		score: 1,
		model: null,
		model_version: null,
		created_at: Date.now(),
		...overrides,
	};
```

In `test/match.test.ts`, the `entry()` helper returns:

```ts
	return {
		user_id: "u1",
		category: "math",
		display_name: overrides.normalized,
		vector_status: "indexed",
		hit_count: 0,
		alias_of: null,
		model: null,
		model_version: null,
		client: null,
		created_at: Date.UTC(2026, 8, 14),
		...overrides,
	};
```

- [ ] **Step 2: Update existing store assertions and write the failing tests**

In `test/store.test.ts`:

1. Change the first line to add the `env` import, keeping the rest:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
```

2. In "users and identities", the `getUser` expectation becomes:

```ts
		expect(await store.getUser(first)).toEqual({
			id: first,
			display_name: "A",
			email: "a@example.com",
			created_at: 1,
			share_ledger: true,
		});
```

3. Replace the whole `findExact returns the matching row...` test with:

```ts
	it("findExact returns every matching row for the owner, and none for another user or category", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const entry = makeEntry(alice, category, "Euler's Identity");
		await store.insertEntry(entry);

		expect(await store.findExact(alice, category, entry.normalized)).toEqual([entry]);
		expect(await store.findExact(bob, category, entry.normalized)).toEqual([]);
		expect(await store.findExact(alice, uniqueCategory(), entry.normalized)).toEqual([]);
	});
```

4. In "skipAsAlias records the hit, marks the row...", the hits expectation becomes:

```ts
		expect(repeat?.hits).toEqual([
			{ candidate_text: "Alhazen", match_kind: "semantic", score: 0.9, model: null },
		]);
```

5. Append a new `describe` at the end of the file:

```ts
describe("model attribution", () => {
	it("stores model, version and client, and allows a topic once per model", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const claude = makeEntry(userId, category, "Stone duality", {
			model: "Claude",
			model_version: "Opus 5",
			client: "Claude",
		});
		const grok = makeEntry(userId, category, "Stone duality", { model: "Grok", client: "openclaw" });

		expect(await store.insertEntry(claude)).toBe("inserted");
		expect(await store.insertEntry(grok)).toBe("inserted");
		expect(
			await store.insertEntry(makeEntry(userId, category, "Stone duality", { model: "CLAUDE" })),
		).toBe("duplicate");

		expect(await store.getEntry(userId, claude.id)).toEqual(claude);
		const exact = await store.findExact(userId, category, claude.normalized);
		expect(exact).toHaveLength(2);
		expect(exact).toEqual(expect.arrayContaining([claude, grok]));
	});

	it("records the attempting model on hits from recordHit and skipAsAlias, and filters repeats by model", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const euler = makeEntry(userId, category, "Euler", { model: "Claude" });
		const gauss = makeEntry(userId, category, "Gauss", { model: "Grok" });
		const claim = makeEntry(userId, category, "Carl Gauss", { model: "Grok" });
		for (const entry of [euler, gauss, claim]) await store.insertEntry(entry);
		await store.recordHit(
			makeHit(euler, "euler", { model: "Grok", model_version: "Grok 4", created_at: 1 }),
		);
		const toGauss = makeNearMiss(claim, gauss);
		await store.insertNearMisses([toGauss]);
		expect(
			await store.skipAsAlias({
				nearMissId: toGauss.id,
				claimEntryId: claim.id,
				hit: makeHit(gauss, "Carl Gauss", {
					match_kind: "semantic",
					score: 0.8,
					model: "Grok",
					model_version: "Grok 4",
					created_at: 2,
				}),
				note: null,
				decidedAt: 2,
			}),
		).toBe(true);

		expect(
			await env.DB.prepare("SELECT model, model_version FROM hits WHERE entry_id = ?1")
				.bind(gauss.id)
				.first(),
		).toEqual({ model: "Grok", model_version: "Grok 4" });
		const [eulerRepeat] = await store.topRepeatsForUser(userId, category, 10, "claude");
		expect(eulerRepeat?.entry.id).toBe(euler.id);
		expect(eulerRepeat?.hits).toEqual([
			{ candidate_text: "euler", match_kind: "exact", score: 1, model: "Grok" },
		]);
		expect(
			(await store.topRepeatsForUser(userId, category, 10, "GROK")).map((row) => row.entry.id),
		).toEqual([gauss.id]);
		expect(await store.topRepeatsForUser(userId, category, 10)).toHaveLength(2);
	});

	it("flips the share switch, which starts on", async () => {
		const store = testStore();
		const userId = await seedUser();
		expect((await store.getUser(userId))?.share_ledger).toBe(true);
		await store.setShareLedger(userId, false);
		expect((await store.getUser(userId))?.share_ledger).toBe(false);
		await store.setShareLedger(userId, true);
		expect((await store.getUser(userId))?.share_ledger).toBe(true);
	});

	it("filters listEntries by model case-insensitively, leaving unattributed rows to the unfiltered list", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const claude = makeEntry(userId, category, "Hilbert", { model: "Claude", created_at: 1 });
		const grok = makeEntry(userId, category, "Cantor", { model: "Grok", created_at: 2 });
		const legacy = makeEntry(userId, category, "Riemann", { created_at: 3 });
		for (const entry of [claude, grok, legacy]) await store.insertEntry(entry);

		expect(
			(await store.listEntries(userId, { category, limit: 10, model: "grok" })).map((e) => e.id),
		).toEqual([grok.id]);
		expect((await store.listEntries(userId, { category, limit: 10 })).map((e) => e.id)).toEqual([
			legacy.id,
			grok.id,
			claude.id,
		]);
	});
});
```

- [ ] **Step 3: Run the store tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — type errors or assertion failures on the new columns, `setShareLedger`, the model filters and `findExact` returning an array.

- [ ] **Step 4: Extend the row schemas**

In `src/core/rows.ts`, `UserRowSchema` becomes:

```ts
export const UserRowSchema = z.object({
	id: z.string(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	created_at: z.number(),
	/** Stored as 0 or 1. True shares one ledger across all of the user's models. */
	share_ledger: z.number().int().transform((value) => value === 1),
});
```

In `EntryRowSchema`, after `created_at: z.number(),` add:

```ts
	/** The declared model family. Null for an unattributed row, which belongs to every model. */
	model: z.string().nullable(),
	/** The declared model version: a label that never affects matching. */
	model_version: z.string().nullable(),
	/** The connection's name (token label or OAuth client name), kept for audit. */
	client: z.string().nullable(),
```

In `HitRowSchema`, after `created_at: z.number(),` add:

```ts
	/** The model that made the attempt. With a shared ledger it can differ from the entry's model. */
	model: z.string().nullable(),
	model_version: z.string().nullable(),
```

- [ ] **Step 5: Update the store**

In `src/store/d1.ts`:

1. `RepeatHitSchema` gains the model (`HitDetailRow` extends it, so it follows):

```ts
const RepeatHitSchema = z.object({
	candidate_text: z.string(),
	match_kind: MatchKind,
	score: z.number(),
	model: z.string().nullable(),
});
```

2. `ENTRY_COLUMNS` becomes:

```ts
const ENTRY_COLUMNS =
	"id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at, model, model_version, client";
```

3. In `getUser`, the query becomes
`"SELECT id, display_name, email, created_at, share_ledger FROM users WHERE id = ?1"`.

4. Add after `getUser`:

```ts
	async setShareLedger(userId: string, share: boolean): Promise<void> {
		await this.db
			.prepare("UPDATE users SET share_ledger = ?2 WHERE id = ?1")
			.bind(userId, share ? 1 : 0)
			.run();
	}
```

5. Replace `findExact` with:

```ts
	/** Every entry with this exact normalized name: at most one per model, plus one unattributed. */
	async findExact(userId: string, category: string, normalized: string): Promise<EntryRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND category = ?2 AND normalized = ?3`,
			)
			.bind(userId, category, normalized)
			.all();
		return results.map((row) => EntryRowSchema.parse(row));
	}
```

6. In `insertEntry`, the statement and bindings become:

```ts
				.prepare(
					`INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
				)
				.bind(
					row.id,
					row.user_id,
					row.category,
					row.display_name,
					row.normalized,
					row.vector_status,
					row.hit_count,
					row.alias_of,
					row.created_at,
					row.model,
					row.model_version,
					row.client,
				)
```

7. Replace `listEntries` with:

```ts
	async listEntries(
		userId: string,
		options: { category?: string; limit: number; sinceMs?: number; model?: string },
	): Promise<EntryRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries
				 WHERE user_id = ?1 AND alias_of IS NULL AND (?2 IS NULL OR category = ?2) AND (?3 IS NULL OR created_at >= ?3)
				   AND (?5 IS NULL OR model = ?5 COLLATE NOCASE)
				 ORDER BY created_at DESC LIMIT ?4`,
			)
			.bind(
				userId,
				options.category ?? null,
				options.sinceMs ?? null,
				options.limit,
				options.model ?? null,
			)
			.all();
		return results.map((row) => EntryRowSchema.parse(row));
	}
```

8. In `recordHit`, the first statement becomes:

```ts
			this.db
				.prepare(
					`INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at, model, model_version)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
				)
				.bind(
					hit.id,
					hit.entry_id,
					hit.user_id,
					hit.candidate_text,
					hit.candidate_normalized,
					hit.match_kind,
					hit.score,
					hit.created_at,
					hit.model,
					hit.model_version,
				),
```

9. `topRepeatsForUser` takes a model filter. Its signature, first query and hits query become:

```ts
	async topRepeatsForUser(
		userId: string,
		category: string | undefined,
		limit: number,
		model?: string,
	): Promise<UserRepeatRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries
				 WHERE user_id = ?1 AND alias_of IS NULL AND hit_count > 0 AND (?2 IS NULL OR category = ?2)
				   AND (?4 IS NULL OR model = ?4 COLLATE NOCASE)
				 ORDER BY hit_count DESC, created_at DESC LIMIT ?3`,
			)
			.bind(userId, category ?? null, limit, model ?? null)
			.all();
```

```ts
				.prepare(
					`SELECT entry_id, candidate_text, match_kind, score, model FROM hits WHERE entry_id IN (${placeholders(batch.length, 1)}) ORDER BY created_at DESC`,
				)
```

and the push becomes:

```ts
					list.push({
						candidate_text: hit.candidate_text,
						match_kind: hit.match_kind,
						score: hit.score,
						model: hit.model,
					});
```

10. In `skipAsAlias`, the first statement becomes:

```ts
			this.db
				.prepare(
					`INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at, model, model_version)
					 SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE ${skipOpen(1, 4)}`,
				)
				.bind(
					write.nearMissId,
					hit.id,
					hit.entry_id,
					hit.user_id,
					hit.candidate_text,
					hit.candidate_normalized,
					hit.match_kind,
					hit.score,
					hit.created_at,
					hit.model,
					hit.model_version,
				),
```

- [ ] **Step 6: Keep the ledger compiling, with behaviour unchanged**

In `src/core/ledger.ts`:

1. In `evaluate`, replace the block from `const lexical = ...` through the closing brace of `if (!lexical.some(...)) { ... }` with:

```ts
		const lexical = findLexicalMatches(normalized, candidates, this.deps.thresholds);
		// listCandidates is windowed (CANDIDATE_SCAN_LIMIT), so an exact match can lie outside it, and
		// each model can hold its own copy. Ranking deduplicates an entry found both ways.
		for (const exact of await this.deps.store.findExact(userId, category, normalized)) {
			lexical.push({ entry: exact, kind: "exact", score: 1, confidence: "repeat" });
		}
```

2. In `claimOnce`, the `recordHit` argument gains `model: null, model_version: null,` (before `created_at`), and the `entry` literal gains `model: null, model_version: null, client: null,` (after `created_at: now(),`).

3. In `skip`, the `hit` literal gains, before `created_at: decidedAt,`:

```ts
				model: entry.model,
				model_version: entry.model_version,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/store.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Falsify**

Make each break, run `npx vitest run test/store.test.ts`, record the failing test, restore:

1. In `listEntries`, change `COLLATE NOCASE` to `COLLATE BINARY`. Expected: FAIL in "filters listEntries by model".
2. In `topRepeatsForUser`, delete the `AND (?4 IS NULL OR model = ?4 COLLATE NOCASE)` line. Expected: FAIL in "records the attempting model" (the `GROK` filter returns two rows).
3. In `skipAsAlias`, bind `null` in place of `hit.model`. Expected: FAIL in "records the attempting model".
4. In `findExact`, return only the first row (`.first()` wrapped in an array). Expected: FAIL in "stores model, version and client".
5. In `setShareLedger`, always bind `1`. Expected: FAIL in "flips the share switch".

- [ ] **Step 9: Commit**

```bash
git add src/core/rows.ts src/store/d1.ts src/core/ledger.ts test/helpers.ts test/match.test.ts test/store.test.ts
git commit -F - <<'EOF'
feat: store model attribution on entries and hits, and the share switch

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 3: Overlap, near-miss and per-model summary queries

**Files:**
- Modify: `src/core/rows.ts` (add `OverlapRowSchema`)
- Modify: `src/store/d1.ts`
- Modify: `test/helpers.ts` (add `makeOverlap`)
- Modify: `test/store.test.ts`

**Interfaces:**
- Consumes: Task 2 (`EntryRow` model columns, `HitRow.model`).
- Produces:
  - `OverlapRow = { id: string; user_id: string; claim_entry_id: string; matched_entry_id: string; via_entry_id: string | null; match_kind: MatchKind; score: number; created_at: number }`
  - `LedgerStore.insertOverlaps(rows: readonly OverlapRow[]): Promise<void>`
  - `LedgerStore.listOverlapsForClaim(userId: string, claimEntryId: string): Promise<OverlapRow[]>` (highest score first)
  - `OverlapView = { id: string; created_at: number; category: string; claim_name: string; claim_model: string | null; matched_name: string; matched_model: string | null; via_name: string | null; match_kind: MatchKind; score: number }`
  - `LedgerStore.listOverlaps(userId: string, limit: number): Promise<OverlapView[]>` (newest first, then highest score)
  - `NearMissView` gains `claim_model: string | null` and `matched_model: string | null`.
  - `ModelSummaryRow = { label: string | null; originals: number; hits: number }`
  - `LedgerStore.modelSummary(userId: string): Promise<ModelSummaryRow[]>`: one row per model compared case-insensitively, labelled with the spelling on the model's most recent entry (or most recent hit when it has no entries), ordered by lower-cased model with the unattributed row (`label: null`) last.
  - Test helper `makeOverlap(claim: EntryRow, matched: EntryRow, overrides?: Partial<OverlapRow>): OverlapRow`.

- [ ] **Step 1: Add the overlap fixture**

In `test/helpers.ts`, change the rows import to
`import type { EntryRow, HitRow, NearMissRow, OverlapRow } from "../src/core/rows";` and add after `makeNearMiss`:

```ts
export function makeOverlap(
	claim: EntryRow,
	matched: EntryRow,
	overrides: Partial<OverlapRow> = {},
): OverlapRow {
	return {
		id: crypto.randomUUID(),
		user_id: claim.user_id,
		claim_entry_id: claim.id,
		matched_entry_id: matched.id,
		via_entry_id: null,
		match_kind: "semantic",
		score: 0.8,
		created_at: Date.now(),
		...overrides,
	};
}
```

- [ ] **Step 2: Write the failing tests**

In `test/store.test.ts`:

1. Add `makeOverlap` to the helpers import.
2. The existing test that compares a whole `listNearMisses` row (the object containing `claim_alias_of: null`, in the "near misses" describe) gains `claim_model: null,` and `matched_model: null,` in that object.
3. Append:

```ts
describe("overlaps and per-model summaries", () => {
	it("round-trips overlaps for a claim and lists them newest first, with both models and the via alias", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const haytham = makeEntry(userId, category, "Ibn al-Haytham", { model: "Claude", created_at: 1 });
		const alias = makeEntry(userId, category, "Alhazen", {
			model: "Claude",
			alias_of: haytham.id,
			created_at: 2,
		});
		const grokAlhazen = makeEntry(userId, category, "alhazen", { model: "Grok", created_at: 3 });
		const stone = makeEntry(userId, category, "Stone duality", { model: "Claude", created_at: 4 });
		const grokStone = makeEntry(userId, category, "Stone duality", { model: "Grok", created_at: 5 });
		for (const entry of [haytham, alias, grokAlhazen, stone, grokStone]) {
			await store.insertEntry(entry);
		}
		const viaAlias = makeOverlap(grokAlhazen, haytham, {
			via_entry_id: alias.id,
			match_kind: "exact",
			score: 1,
			created_at: 3,
		});
		const exact = makeOverlap(grokStone, stone, { match_kind: "exact", score: 1, created_at: 5 });
		await store.insertOverlaps([viaAlias, exact]);
		await store.insertOverlaps([]);

		expect(await store.listOverlapsForClaim(userId, grokAlhazen.id)).toEqual([viaAlias]);
		expect(await store.listOverlapsForClaim(await seedUser("other"), grokAlhazen.id)).toEqual([]);
		expect(await store.listOverlaps(userId, 10)).toEqual([
			{
				id: exact.id,
				created_at: 5,
				category,
				claim_name: "Stone duality",
				claim_model: "Grok",
				matched_name: "Stone duality",
				matched_model: "Claude",
				via_name: null,
				match_kind: "exact",
				score: 1,
			},
			{
				id: viaAlias.id,
				created_at: 3,
				category,
				claim_name: "alhazen",
				claim_model: "Grok",
				matched_name: "Ibn al-Haytham",
				matched_model: "Claude",
				via_name: "Alhazen",
				match_kind: "exact",
				score: 1,
			},
		]);
		expect(await store.listOverlaps(await seedUser("other"), 10)).toEqual([]);
	});

	it("names each side's model on near misses", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const claude = makeEntry(userId, category, "Ibn al-Haytham", { model: "Claude" });
		const grok = makeEntry(userId, category, "Alhazen", { model: "Grok" });
		await store.insertEntry(claude);
		await store.insertEntry(grok);
		await store.insertNearMisses([makeNearMiss(grok, claude)]);

		expect(await store.listNearMisses(userId, 10)).toMatchObject([
			{
				claim_name: "Alhazen",
				claim_model: "Grok",
				matched_name: "Ibn al-Haytham",
				matched_model: "Claude",
			},
		]);
	});

	it("summarises originals and hits per model, case-insensitively, labelled by the newest spelling", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const euler = makeEntry(userId, category, "Euler", { model: "Claude", created_at: 1 });
		const alias = makeEntry(userId, category, "Leonhard Euler", {
			model: "Claude",
			alias_of: euler.id,
			created_at: 2,
		});
		const gauss = makeEntry(userId, category, "Gauss", { model: "claude", created_at: 3 });
		const legacy = makeEntry(userId, category, "Noether", { created_at: 4 });
		for (const entry of [euler, alias, gauss, legacy]) await store.insertEntry(entry);
		await store.recordHit(makeHit(euler, "euler", { model: "CLAUDE" }));
		await store.recordHit(makeHit(euler, "leonhard euler", { model: "Claude" }));
		await store.recordHit(makeHit(gauss, "gauss", { model: "Grok" }));

		expect(await store.modelSummary(userId)).toEqual([
			{ label: "claude", originals: 2, hits: 2 },
			{ label: "Grok", originals: 0, hits: 1 },
			{ label: null, originals: 1, hits: 0 },
		]);
		expect(await store.modelSummary(await seedUser("empty"))).toEqual([]);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `makeOverlap`, `insertOverlaps`, `listOverlapsForClaim`, `listOverlaps`, `modelSummary` and the near-miss model fields do not exist.

- [ ] **Step 4: Add the overlap row schema**

In `src/core/rows.ts`, after `NearMissRow`:

```ts
/** A match between a claim and another model's topic, recorded instead of blocking. */
export const OverlapRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	claim_entry_id: z.string(),
	/** Always an original. */
	matched_entry_id: z.string(),
	/** The alias whose text actually matched, when the match came through one. */
	via_entry_id: z.string().nullable(),
	match_kind: MatchKind,
	score: z.number(),
	created_at: z.number(),
});
export type OverlapRow = z.infer<typeof OverlapRowSchema>;
```

- [ ] **Step 5: Add the store queries**

In `src/store/d1.ts`:

1. Add `type OverlapRow, OverlapRowSchema,` to the `../core/rows` import.

2. In `NearMissViewSchema`, after `claim_alias_of`, add:

```ts
	claim_model: z.string().nullable(),
```

and after `matched_name`, add:

```ts
	matched_model: z.string().nullable(),
```

3. After `NearMissView`, add:

```ts
const OverlapViewSchema = z.object({
	id: z.string(),
	created_at: z.number(),
	category: z.string(),
	claim_name: z.string(),
	claim_model: z.string().nullable(),
	matched_name: z.string(),
	matched_model: z.string().nullable(),
	via_name: z.string().nullable(),
	match_kind: MatchKind,
	score: z.number(),
});
export type OverlapView = z.infer<typeof OverlapViewSchema>;

const ModelSummaryRowSchema = z.object({
	/** The model's newest spelling; null for unattributed rows. */
	label: z.string().nullable(),
	/** Entries that are not aliases. */
	originals: z.number().int(),
	/** Hits whose attempting model is this model. */
	hits: z.number().int(),
});
export type ModelSummaryRow = z.infer<typeof ModelSummaryRowSchema>;
```

4. After `NEAR_MISS_COLUMNS`, add:

```ts
const OVERLAP_COLUMNS =
	"id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at";
```

5. In `listNearMisses`, the select list becomes:

```ts
				`SELECT n.id, n.created_at, c.display_name AS claim_name, c.alias_of AS claim_alias_of,
				        c.model AS claim_model, m.display_name AS matched_name, m.model AS matched_model,
				        m.category AS category, v.display_name AS via_name,
				        n.match_kind, n.score, n.verdict, n.note
```

(the `FROM ... LIMIT ?2` part is unchanged).

6. After `listNearMisses`, add:

```ts
	async insertOverlaps(rows: readonly OverlapRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.db.batch(
			rows.map((row) =>
				this.db
					.prepare(
						`INSERT INTO overlaps (${OVERLAP_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
					)
					.bind(
						row.id,
						row.user_id,
						row.claim_entry_id,
						row.matched_entry_id,
						row.via_entry_id,
						row.match_kind,
						row.score,
						row.created_at,
					),
			),
		);
	}

	async listOverlapsForClaim(userId: string, claimEntryId: string): Promise<OverlapRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${OVERLAP_COLUMNS} FROM overlaps WHERE user_id = ?1 AND claim_entry_id = ?2 ORDER BY score DESC`,
			)
			.bind(userId, claimEntryId)
			.all();
		return results.map((row) => OverlapRowSchema.parse(row));
	}

	async listOverlaps(userId: string, limit: number): Promise<OverlapView[]> {
		const { results } = await this.db
			.prepare(
				`SELECT o.id, o.created_at, m.category AS category,
				        c.display_name AS claim_name, c.model AS claim_model,
				        m.display_name AS matched_name, m.model AS matched_model,
				        v.display_name AS via_name, o.match_kind, o.score
				 FROM overlaps o
				 JOIN entries c ON c.id = o.claim_entry_id
				 JOIN entries m ON m.id = o.matched_entry_id
				 LEFT JOIN entries v ON v.id = o.via_entry_id
				 WHERE o.user_id = ?1
				 ORDER BY o.created_at DESC, o.score DESC
				 LIMIT ?2`,
			)
			.bind(userId, limit)
			.all();
		return results.map((row) => OverlapViewSchema.parse(row));
	}

	/**
	 * Originals and hits per model. Models group case-insensitively (SQLite lower() folds ASCII
	 * only, matching NOCASE) and unattributed rows form one group, last.
	 */
	async modelSummary(userId: string): Promise<ModelSummaryRow[]> {
		const { results } = await this.db
			.prepare(
				`WITH keys AS (
				   SELECT lower(model) AS key FROM entries WHERE user_id = ?1
				   UNION
				   SELECT lower(model) FROM hits WHERE user_id = ?1
				 )
				 SELECT
				   COALESCE(
				     (SELECT e.model FROM entries e WHERE e.user_id = ?1 AND lower(e.model) IS k.key
				      ORDER BY e.created_at DESC LIMIT 1),
				     (SELECT h.model FROM hits h WHERE h.user_id = ?1 AND lower(h.model) IS k.key
				      ORDER BY h.created_at DESC LIMIT 1)
				   ) AS label,
				   (SELECT COUNT(*) FROM entries e
				    WHERE e.user_id = ?1 AND e.alias_of IS NULL AND lower(e.model) IS k.key) AS originals,
				   (SELECT COUNT(*) FROM hits h WHERE h.user_id = ?1 AND lower(h.model) IS k.key) AS hits
				 FROM keys k
				 ORDER BY k.key IS NULL, k.key`,
			)
			.bind(userId)
			.all();
		return results.map((row) => ModelSummaryRowSchema.parse(row));
	}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/store.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Falsify**

Make each break, run `npx vitest run test/store.test.ts`, record the failing test, restore:

1. In `modelSummary`'s `originals` subquery, change `lower(e.model) IS k.key` to `e.model IS k.key`. Expected: FAIL in "summarises originals and hits per model".
2. In `modelSummary`'s label subquery on entries, change `ORDER BY e.created_at DESC` to `ASC`. Expected: FAIL (label `Claude` instead of `claude`).
3. In `listOverlaps`, replace `v.display_name AS via_name` with `NULL AS via_name`. Expected: FAIL in "round-trips overlaps".
4. In `listOverlapsForClaim`, change `WHERE user_id = ?1 AND claim_entry_id = ?2` to `WHERE ?1 IS NOT NULL AND claim_entry_id = ?2`. Expected: FAIL in "round-trips overlaps" (another user sees the row).
5. In `listNearMisses`, select `NULL AS matched_model`. Expected: FAIL in "names each side's model".

- [ ] **Step 8: Commit**

```bash
git add src/core/rows.ts src/store/d1.ts test/helpers.ts test/store.test.ts
git commit -F - <<'EOF'
feat: store overlaps between models and summarise repeats per model

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 4: Scoped matching in the ledger

**Files:**
- Modify: `src/api/schemas.ts`
- Modify: `src/core/wire.ts`
- Modify: `src/core/match.ts`
- Modify: `src/core/ledger.ts`
- Modify: `test/schemas.test.ts`, `test/match.test.ts`
- Create: `test/ledger-models.test.ts`

**Interfaces:**
- Consumes: Task 2 (`findExact` array, `setShareLedger`, `getUser().share_ledger`, model filters, `RepeatHit.model`) and Task 3 (`insertOverlaps`, `listOverlapsForClaim`, `OverlapRow`, `listOverlaps`).
- Produces:
  - `schemas.ts`: `MODEL_DESCRIPTION`, `MODEL_VERSION_DESCRIPTION` (strings), `ModelLabel` (zod schema: trimmed, 1–64 UTF-8 bytes), `ClaimInput` gains optional `model` and `model_version`, `ClaimToolInput` (same with `model` required), `CheckInput` gains optional `model`, `CheckToolInput` (`model` required), `ListInput` and `StatsInput` gain optional `model`, `Entry` gains `model: string | null`. Types `ClaimToolInput`, `CheckToolInput` exported.
  - `match.ts`: `sameModel(a: string, b: string): boolean`; `interface ScopedMatches { inScope: ScoredMatch[]; crossModel: ScoredMatch[] }`; `splitByScope(matches: readonly ScoredMatch[], model: string | null, shareLedger: boolean): ScopedMatches`.
  - `ledger.ts`: `SEMANTIC_TOP_K = 20`; `Ledger.claim(userId: string, input: ClaimInput, client: string | null = null): Promise<ClaimResult>`; `check`, `list` and `stats` honour `input.model`; claims write overlaps.
  - Deliberate refinement of the spec's "evaluate receives the user's switch": the ledger reads the switch itself (`store.getUser(userId)`) inside `evaluate`, so no caller (REST, MCP, dashboard, tests) can forget to pass it. A claim with no `model` keeps every match in scope, which is how every existing test and v0.1.0 caller behaves.

- [ ] **Step 1: Write the failing schema and matching unit tests**

In `test/schemas.test.ts`, add `CheckToolInput` and `ClaimToolInput` to the existing import from `../src/api/schemas`. In the existing "ClaimResult parses all three variants" test, every `entry` object passed to `ClaimResult.parse` gains `model: null` (the wire `Entry` now always carries it). Then append:

```ts
describe("model fields", () => {
	it("trim model and model_version, bound them to 1-64 bytes, and require model only on tool inputs", () => {
		expect(
			ClaimInput.parse({ category: "math", name: "x", model: " Claude ", model_version: " Opus 5 " }),
		).toMatchObject({ model: "Claude", model_version: "Opus 5" });
		expect(ClaimInput.safeParse({ category: "math", name: "x", model: "   " }).success).toBe(false);
		expect(
			ClaimInput.safeParse({ category: "math", name: "x", model: "é".repeat(33) }).success,
		).toBe(false);
		expect(ClaimInput.parse({ category: "math", name: "x" })).not.toHaveProperty("model");
		expect(ClaimToolInput.safeParse({ category: "math", name: "x" }).success).toBe(false);
		expect(CheckToolInput.safeParse({ category: "math", name: "x" }).success).toBe(false);
		expect(CheckToolInput.safeParse({ category: "math", name: "x", model: "Grok" }).success).toBe(
			true,
		);
		expect(ListInput.parse({ model: " grok " })).toMatchObject({ model: "grok" });
		expect(StatsInput.parse({ model: "Claude" })).toMatchObject({ model: "Claude" });
	});
});
```

In `test/match.test.ts`, add `sameModel` and `splitByScope` to the import from `../src/core/match`, and append:

```ts
describe("sameModel", () => {
	it("folds ASCII letters only, matching SQLite NOCASE", () => {
		expect(sameModel("Claude", "cLAUDE")).toBe(true);
		expect(sameModel("Grok", "Grok 4")).toBe(false);
		expect(sameModel("Émile", "émile")).toBe(false);
	});
});

describe("splitByScope", () => {
	const claude = entry({ id: "c", normalized: "stone duality", model: "Claude" });
	const grok = entry({ id: "g", normalized: "stone duality", model: "Grok" });
	const legacy = entry({ id: "l", normalized: "stone duality" });
	const matches: ScoredMatch[] = [claude, grok, legacy].map((row) => ({
		entry: row,
		kind: "exact",
		score: 1,
		confidence: "repeat",
	}));

	it("keeps every match in scope while the ledger is shared or no model is declared", () => {
		expect(splitByScope(matches, "Grok", true)).toEqual({ inScope: matches, crossModel: [] });
		expect(splitByScope(matches, null, false)).toEqual({ inScope: matches, crossModel: [] });
	});

	it("keeps the caller's and unattributed topics in scope and sends other models' topics across", () => {
		const { inScope, crossModel } = splitByScope(matches, "grok", false);
		expect(inScope.map((match) => match.entry.id)).toEqual(["g", "l"]);
		expect(crossModel.map((match) => match.entry.id)).toEqual(["c"]);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/schemas.test.ts test/match.test.ts`
Expected: FAIL — `ClaimToolInput`, `CheckToolInput`, `sameModel` and `splitByScope` do not exist.

- [ ] **Step 3: Implement the schemas, wire entry and matching helpers**

In `src/api/schemas.ts`, add after `TopicName`:

```ts
export const MODEL_DESCRIPTION =
	'Your model family name only, such as "Claude", "Grok" or "Gemini" — not a version. It selects the ledger your repeats are checked against, so keep it the same across upgrades.';
export const MODEL_VERSION_DESCRIPTION =
	'Optional: your specific model or version, such as "Opus 5". Recorded as a label; it never affects matching.';

/** A model family or version label: trimmed, 1-64 UTF-8 bytes. */
export const ModelLabel = z
	.string()
	.trim()
	.refine((value) => {
		const bytes = utf8Length(value);
		return bytes >= 1 && bytes <= 64;
	}, "must be 1-64 UTF-8 bytes after trimming");
```

`Entry` gains a last field:

```ts
	model: z.string().nullable(),
```

Replace `ClaimInput` and `CheckInput` (and their types) with:

```ts
export const ClaimInput = z.object({
	category: Category,
	name: TopicName,
	force: z.boolean().default(false),
	model: ModelLabel.optional().describe(MODEL_DESCRIPTION),
	model_version: ModelLabel.optional().describe(MODEL_VERSION_DESCRIPTION),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** MCP callers must declare their model; REST falls back to the connection name. */
export const ClaimToolInput = ClaimInput.extend({ model: ModelLabel.describe(MODEL_DESCRIPTION) });
export type ClaimToolInput = z.infer<typeof ClaimToolInput>;
```

```ts
export const CheckInput = z.object({
	category: Category,
	name: TopicName,
	model: ModelLabel.optional().describe(MODEL_DESCRIPTION),
});
export type CheckInput = z.infer<typeof CheckInput>;

export const CheckToolInput = CheckInput.extend({ model: ModelLabel.describe(MODEL_DESCRIPTION) });
export type CheckToolInput = z.infer<typeof CheckToolInput>;
```

`ListInput` and `StatsInput` each gain a last field:

```ts
	model: ModelLabel.optional(),
```

In `src/core/wire.ts`, `toWireEntry` gains `model: row.model,` after `hit_count: row.hit_count,`.

In `src/core/match.ts`, append:

```ts
/** Case-insensitive model equality with ASCII-only folding, matching SQLite's NOCASE collation. */
export function sameModel(a: string, b: string): boolean {
	return foldAscii(a) === foldAscii(b);
}

function foldAscii(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export interface ScopedMatches {
	/** Matches in the caller's ledger: they can block or ask for a verdict. */
	inScope: ScoredMatch[];
	/** Matches on another model's topics while ledgers are separate: recorded as overlaps. */
	crossModel: ScoredMatch[];
}

/**
 * Splits resolved matches by ledger. With a shared ledger, or when the caller declared no model,
 * every match is in scope. Otherwise a match is in scope when its entry (an original, after alias
 * resolution) is unattributed or belongs to the caller's model.
 */
export function splitByScope(
	matches: readonly ScoredMatch[],
	model: string | null,
	shareLedger: boolean,
): ScopedMatches {
	if (shareLedger || model === null) return { inScope: [...matches], crossModel: [] };
	const inScope: ScoredMatch[] = [];
	const crossModel: ScoredMatch[] = [];
	for (const match of matches) {
		const owner = match.entry.model;
		if (owner === null || sameModel(owner, model)) inScope.push(match);
		else crossModel.push(match);
	}
	return { inScope, crossModel };
}
```

Contingency for Task 5's pinned descriptions: if the MCP tool list later shows a description missing, move `.describe()` to the outermost schema of that field. Do not change the description text.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/schemas.test.ts test/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing ledger tests**

Create `test/ledger-models.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClaimInput, ClaimResult } from "../src/api/schemas";
import type { Ledger } from "../src/core/ledger";
import { MAX_MATCHES } from "../src/core/match";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeEntry, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

type Claimed = Extract<ClaimResult, { status: "claimed" }>;
type Possible = Extract<ClaimResult, { status: "possible_repeat" }>;

function claimed(result: ClaimResult): Claimed {
	if (result.status !== "claimed") throw new Error(`expected claimed, got ${result.status}`);
	return result;
}

function possible(result: ClaimResult): Possible {
	if (result.status !== "possible_repeat") {
		throw new Error(`expected possible_repeat, got ${result.status}`);
	}
	return result;
}

/** A user whose models each keep their own ledger. */
async function separateUser(): Promise<string> {
	const userId = await seedUser();
	await testStore().setShareLedger(userId, false);
	return userId;
}

/** Claims as `model`, using the model's name as the connection. */
function claimAs(
	ledger: Ledger,
	userId: string,
	category: string,
	model: string,
	name: string,
	extra: Partial<ClaimInput> = {},
): Promise<ClaimResult> {
	return ledger.claim(userId, { category, name, force: false, model, ...extra }, model);
}

async function hitModels(entryId: string): Promise<unknown> {
	return env.DB.prepare("SELECT model, model_version FROM hits WHERE entry_id = ?1")
		.bind(entryId)
		.first();
}

describe("shared ledger (the default)", () => {
	it("blocks another model's topic and records the attempting model on the hit", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = claimed(
			await claimAs(ledger, userId, category, "Claude", "Stone duality", { model_version: "Opus 5" }),
		);

		const again = await claimAs(ledger, userId, category, "Grok", "stone duality", {
			model_version: "Grok 4",
		});

		expect(again.status).toBe("repeat");
		expect(first.entry.model).toBe("Claude");
		expect(await testStore().getEntry(userId, first.entry.id)).toMatchObject({
			model: "Claude",
			model_version: "Opus 5",
			client: "Claude",
		});
		expect(await hitModels(first.entry.id)).toEqual({ model: "Grok", model_version: "Grok 4" });
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});
});

describe("separate ledgers", () => {
	it("lets another model claim the same topic and records an exact overlap instead of a hit", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const claude = claimed(await claimAs(ledger, userId, category, "Claude", "Stone duality"));

		const grok = claimed(await claimAs(ledger, userId, category, "Grok", "stone duality"));

		expect(grok.entry.model).toBe("Grok");
		expect(await testStore().listOverlapsForClaim(userId, grok.entry.id)).toMatchObject([
			{ matched_entry_id: claude.entry.id, via_entry_id: null, match_kind: "exact", score: 1 },
		]);
		expect(await testStore().listNearMissesForClaim(userId, grok.entry.id)).toEqual([]);
		expect((await testStore().getEntry(userId, claude.entry.id))?.hit_count).toBe(0);
	});

	it("still blocks a model's own repeat, whatever the case of its declared name", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const first = claimed(await claimAs(ledger, userId, category, "Claude", "Gauss"));

		const again = await claimAs(ledger, userId, category, "CLAUDE", "gauss");

		expect(again.status).toBe("repeat");
		expect((await testStore().getEntry(userId, first.entry.id))?.hit_count).toBe(1);
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});

	it("records spelling and meaning overlaps without blocking or asking for a verdict", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const ramanujan = claimed(
			await claimAs(ledger, userId, category, "Claude", "Srinivasa Ramanujan"),
		);
		const boetie = claimed(
			await claimAs(ledger, userId, category, "Claude", "Étienne de La Boétie"),
		);
		semantic.setSimilarity("Étienne de La Boétie", "Émilie du Châtelet", 0.84);

		const misspelt = claimed(
			await claimAs(ledger, userId, category, "Grok", "Srinivasa Ramanujam"),
		);
		const chatelet = claimed(await claimAs(ledger, userId, category, "Grok", "Émilie du Châtelet"));

		expect(await testStore().listOverlapsForClaim(userId, misspelt.entry.id)).toMatchObject([
			{ matched_entry_id: ramanujan.entry.id, match_kind: "trigram" },
		]);
		expect(await testStore().listOverlapsForClaim(userId, chatelet.entry.id)).toMatchObject([
			{ matched_entry_id: boetie.entry.id, match_kind: "semantic", score: 0.84 },
		]);
		expect(await testStore().listNearMissesForClaim(userId, chatelet.entry.id)).toEqual([]);
	});

	it("asks only about the caller's own topics when a claim matches both ledgers", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		const alhazen = claimed(await claimAs(ledger, userId, category, "Grok", "Alhazen"));
		semantic.setSimilarity("Ibn al-Haytham", "Father of optics", 0.9);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);

		const optics = possible(await claimAs(ledger, userId, category, "Grok", "Father of optics"));

		expect(optics.possible_matches.map((match) => match.entry_id)).toEqual([alhazen.entry.id]);
		expect(
			(await testStore().listNearMissesForClaim(userId, optics.entry.id)).map(
				(row) => row.matched_entry_id,
			),
		).toEqual([alhazen.entry.id]);
		expect(await testStore().listOverlapsForClaim(userId, optics.entry.id)).toMatchObject([
			{ matched_entry_id: haytham.entry.id, match_kind: "semantic", score: 0.9 },
		]);
	});

	it("treats an unattributed topic as belonging to every model", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await ledger.claim(userId, { category, name: "Noether", force: false }));

		expect((await claimAs(ledger, userId, category, "Grok", "noether")).status).toBe("repeat");
	});

	it("records an overlap through another model's alias, against its original", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		const alias = makeEntry(userId, category, "Alhazen", {
			model: "Claude",
			alias_of: haytham.entry.id,
			vector_status: "indexed",
		});
		await testStore().insertEntry(alias);

		const grok = claimed(await claimAs(ledger, userId, category, "Grok", "alhazen"));

		expect(await testStore().listOverlapsForClaim(userId, grok.entry.id)).toMatchObject([
			{ matched_entry_id: haytham.entry.id, via_entry_id: alias.id, match_kind: "exact" },
		]);
	});

	it("matches entries from both ledgers once sharing is turned back on, recording one hit", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Euler's identity"));
		claimed(await claimAs(ledger, userId, category, "Grok", "Euler's identity"));
		await testStore().setShareLedger(userId, true);

		const gemini = await claimAs(ledger, userId, category, "Gemini", "euler identity");

		expect(gemini.status).toBe("repeat");
		const repeats = await testStore().topRepeatsForUser(userId, category, 10);
		expect(repeats.flatMap((row) => row.hits.map((hit) => hit.model))).toEqual(["Gemini"]);
	});

	it("ranks each ledger separately, so other models' matches cannot crowd out the caller's own", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const noether = claimed(await claimAs(ledger, userId, category, "Grok", "Emmy Noether"));
		const others = [
			"Hypatia",
			"Maryam Mirzakhani",
			"Sofia Kovalevskaya",
			"Sophie Germain",
			"Mary Somerville",
			"Olga Taussky-Todd",
		];
		for (const name of others) {
			claimed(await claimAs(ledger, userId, category, "Claude", name));
			semantic.setSimilarity(name, "Ada Lovelace", 0.95);
		}
		semantic.setSimilarity("Emmy Noether", "Ada Lovelace", 0.8);

		const lovelace = possible(await claimAs(ledger, userId, category, "Grok", "Ada Lovelace"));

		expect(lovelace.possible_matches.map((match) => match.entry_id)).toEqual([noether.entry.id]);
		expect(await testStore().listOverlapsForClaim(userId, lovelace.entry.id)).toHaveLength(
			MAX_MATCHES,
		);
	});

	it("checks against the caller's ledger", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Gauss"));

		expect(await ledger.check(userId, { category, name: "gauss", model: "Grok" })).toMatchObject({
			likely_repeat: false,
			matches: [],
		});
		expect((await ledger.check(userId, { category, name: "gauss", model: "claude" })).likely_repeat).toBe(
			true,
		);
	});

	it("gives a skip's hit the model of the claim it aliases", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Grok", "Ibn al-Haytham"));
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const alhazen = possible(
			await claimAs(ledger, userId, category, "Grok", "Alhazen", { model_version: "Grok 4" }),
		);

		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });

		expect(await hitModels(haytham.entry.id)).toEqual({ model: "Grok", model_version: "Grok 4" });
	});
});

describe("list and stats filters", () => {
	it("filter by model case-insensitively, including unattributed topics only without a filter", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Hilbert"));
		claimed(await claimAs(ledger, userId, category, "Grok", "Cantor"));
		claimed(await ledger.claim(userId, { category, name: "Riemann", force: false }));
		expect((await claimAs(ledger, userId, category, "Claude", "hilbert")).status).toBe("repeat");

		const grokList = await ledger.list(userId, { category, limit: 20, model: "grok" });
		expect(grokList.entries.map((entry) => entry.display_name)).toEqual(["Cantor"]);
		expect((await ledger.list(userId, { category, limit: 20 })).entries).toHaveLength(3);
		const stats = (model: string) =>
			ledger.stats(userId, { scope: "me", category, limit: 20, model }, 2);
		expect((await stats("GROK")).repeats).toEqual([]);
		expect((await stats("claude")).repeats).toMatchObject([
			{ display_name: "Hilbert", hit_count: 1 },
		]);
	});
});
```

- [ ] **Step 6: Run the ledger tests to verify they fail**

Run: `npx vitest run test/ledger-models.test.ts`
Expected: FAIL — `claim` ignores the model and the connection, no overlaps are written, and every model shares one scope.

- [ ] **Step 7: Implement scoped matching in the ledger**

In `src/core/ledger.ts`:

1. The `./match` import gains `splitByScope`, and the `./rows` import becomes
`import type { EntryRow, NearMissRow, OverlapRow } from "./rows";`.

2. Replace `interface Evaluation` with:

```ts
interface Evaluation {
	normalized: string;
	/** Matches in the caller's ledger: they can block or ask for a verdict. */
	matches: ScoredMatch[];
	/** Matches on other models' topics while ledgers are separate: recorded as overlaps. */
	crossModel: ScoredMatch[];
	semantic: SemanticStatus;
}
```

3. Replace the `SEMANTIC_TOP_K` comment and declaration with:

```ts
/**
 * Aliases of one topic, and other models' topics, can fill the semantic results, so over-fetch
 * before resolving, splitting and ranking. Twenty is within Vectorize's topK limit in every
 * return mode; confirm the limit before raising it.
 */
export const SEMANTIC_TOP_K = 20;
```

4. In `check`, the first line becomes:

```ts
		const evaluation = await this.evaluate(userId, input.category, input.name, input.model ?? null);
```

5. Replace `claim` with:

```ts
	/** `client` is the connection's name, stored for audit; it never affects matching. */
	claim(userId: string, input: ClaimInput, client: string | null = null): Promise<ClaimResult> {
		return this.claimOnce(userId, input, client, false);
	}
```

6. In `list`, the `listEntries` options gain `model: input.model,` after `sinceMs`.

7. In `stats`, the `topRepeatsForUser` call becomes
`store.topRepeatsForUser(userId, input.category, input.limit, input.model)`.

8. Replace `claimOnce` with:

```ts
	private async claimOnce(
		userId: string,
		input: ClaimInput,
		client: string | null,
		isRetry: boolean,
	): Promise<ClaimResult> {
		const { store, semantic, now, newId } = this.deps;
		const model = input.model ?? null;
		const modelVersion = input.model_version ?? null;
		const evaluation = await this.evaluate(userId, input.category, input.name, model);
		const best = evaluation.matches.find((match) => match.confidence === "repeat");

		if (best && (!input.force || best.kind === "exact")) {
			await store.recordHit({
				id: newId(),
				entry_id: best.entry.id,
				user_id: userId,
				candidate_text: input.name,
				candidate_normalized: evaluation.normalized,
				match_kind: best.kind,
				score: best.score,
				model,
				model_version: modelVersion,
				created_at: now(),
			});
			return {
				status: "repeat",
				matches: evaluation.matches.map((match) => toWireMatch(match, match === best ? 1 : 0)),
				semantic: evaluation.semantic,
			};
		}

		const entry: EntryRow = {
			id: newId(),
			user_id: userId,
			category: input.category,
			display_name: input.name,
			normalized: evaluation.normalized,
			vector_status: "pending",
			hit_count: 0,
			alias_of: null,
			created_at: now(),
			model,
			model_version: modelVersion,
			client,
		};
		if ((await store.insertEntry(entry)) === "duplicate") {
			// A concurrent claim by the same model inserted the same normalized name; re-evaluating
			// yields an exact repeat.
			if (isRetry) {
				throw new LedgerError("upstream_unavailable", "topic claim conflicted twice; retry");
			}
			return this.claimOnce(userId, input, client, true);
		}

		const forced = best !== undefined;
		const nonBlocking = forced
			? evaluation.matches
			: evaluation.matches.filter((match) => match.confidence === "possible");
		await store.insertNearMisses(
			nonBlocking.map(
				(match): NearMissRow => ({
					id: newId(),
					user_id: userId,
					claim_entry_id: entry.id,
					matched_entry_id: match.entry.id,
					via_entry_id: match.via?.id ?? null,
					match_kind: match.kind,
					score: match.score,
					verdict: forced ? "distinct" : "pending",
					note: forced ? FORCED_NOTE : null,
					created_at: entry.created_at,
					decided_at: forced ? entry.created_at : null,
				}),
			),
		);
		await store.insertOverlaps(
			evaluation.crossModel.map(
				(match): OverlapRow => ({
					id: newId(),
					user_id: userId,
					claim_entry_id: entry.id,
					matched_entry_id: match.entry.id,
					via_entry_id: match.via?.id ?? null,
					match_kind: match.kind,
					score: match.score,
					created_at: entry.created_at,
				}),
			),
		);
```

The rest of `claimOnce` (from `let semanticStatus = evaluation.semantic;` to the end) is unchanged.

9. Replace `evaluate` with:

```ts
	private async evaluate(
		userId: string,
		category: string,
		name: string,
		model: string | null,
	): Promise<Evaluation> {
		const { store, thresholds } = this.deps;
		const normalized = normalize(name);
		if (normalized.length === 0) {
			throw new LedgerError("invalid_input", "name must contain at least one letter or digit");
		}
		const candidates = await store.listCandidates(userId, category);
		const lexical = findLexicalMatches(normalized, candidates, thresholds);
		// listCandidates is windowed (CANDIDATE_SCAN_LIMIT), so an exact match can lie outside it, and
		// each model can hold its own copy. Ranking deduplicates an entry found both ways.
		for (const exact of await store.findExact(userId, category, normalized)) {
			lexical.push({ entry: exact, kind: "exact", score: 1, confidence: "repeat" });
		}
		const semantic = await this.semanticMatches(userId, category, name, candidates);
		const resolved = await this.withOriginals(
			userId,
			category,
			[...lexical, ...semantic.matches],
			candidates,
		);
		// The API refuses callers whose user row is gone; default to sharing, the conservative choice.
		const shareLedger = (await store.getUser(userId))?.share_ledger ?? true;
		// Rank each ledger separately so other models' matches cannot take the caller's slots.
		const { inScope, crossModel } = splitByScope(resolved, model, shareLedger);
		return {
			normalized,
			matches: rankMatches(inScope),
			crossModel: rankMatches(crossModel),
			semantic: semantic.status,
		};
	}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/ledger-models.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS. Every existing ledger, REST, MCP and dashboard test still passes, because a claim with no declared model, or a user whose switch is on, keeps every match in scope.

- [ ] **Step 9: Falsify**

Make each break, run `npx vitest run test/ledger-models.test.ts test/match.test.ts`, record the failing tests, restore:

1. In `evaluate`, pass `true` instead of `shareLedger` to `splitByScope`. Expected: FAIL across "separate ledgers".
2. In `evaluate`, rank before splitting: set `const ranked = rankMatches(resolved);` and return `matches: ranked.filter((match) => inScope.includes(match))`. Expected: FAIL in "ranks each ledger separately".
3. In `claimOnce`, pass `[]` to `insertOverlaps`. Expected: FAIL in the overlap tests.
4. In `claimOnce`'s `recordHit`, set `model: null`. Expected: FAIL in "blocks another model's topic".
5. In `sameModel`, return `a === b`. Expected: FAIL in "still blocks a model's own repeat" and in `sameModel`.
6. In `check`, pass `null` instead of `input.model ?? null`. Expected: FAIL in "checks against the caller's ledger".
7. In `list`, remove `model: input.model,`. Expected: FAIL in "filter by model".

- [ ] **Step 10: Commit**

```bash
git add src/api/schemas.ts src/core/wire.ts src/core/match.ts src/core/ledger.ts test/schemas.test.ts test/match.test.ts test/ledger-models.test.ts
git commit -F - <<'EOF'
feat: split matches by model ledger and record overlaps between models

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 5: Connection identity and declared models over REST and MCP

**Files:**
- Modify: `src/env.ts`
- Modify: `src/auth/tokens.ts`
- Create: `src/api/connection.ts`
- Modify: `src/api/context.ts`, `src/api/handler.ts`, `src/api/rest.ts`, `src/api/mcp.ts`
- Modify: `test/tokens.test.ts`, `test/rest.test.ts`, `test/mcp.test.ts`
- Create: `test/connection.test.ts`

**Interfaces:**
- Consumes: Task 4 (`ClaimToolInput`, `CheckToolInput`, `MODEL_DESCRIPTION`, `MODEL_VERSION_DESCRIPTION`, `Ledger.claim(userId, input, client)`, `check` honouring `input.model`), Task 2 (`setShareLedger`, `getEntry` model columns).
- Produces:
  - `PropsSchema = z.object({ userId: z.string().min(1), client: z.string().min(1).optional() })`
  - `resolvePersonalToken(store, token, now): Promise<{ userId: string; client: string } | null>` (`client` is the token's label)
  - `connectionName(env: Pick<Env, "OAUTH_PROVIDER">, request: Request, propsClient: string | undefined): Promise<string | null>`
  - `once<T>(compute: () => Promise<T>): () => Promise<T>`
  - `ApiContext.connectionName: () => Promise<string | null>`
  - REST: `model` defaults to the connection name on `/claims` and `/checks`. MCP: `claim_topic` and `check_topic` require `model`.

- [ ] **Step 1: Write the failing tests**

In `test/tokens.test.ts`, the resolve expectation becomes:

```ts
		expect(await resolvePersonalToken(store, token, 2_000)).toEqual({ userId, client: "cron" });
```

Create `test/connection.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { once } from "../src/api/connection";
import { ClaimResult } from "../src/api/schemas";
import {
	createTestToken,
	issueOAuthTokens,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

async function claimOverRest(token: string, body: Record<string, unknown>) {
	const res = await SELF.fetch(`${ORIGIN}/api/v1/claims`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	const result = ClaimResult.parse(await res.json());
	if (result.status !== "claimed") throw new Error(`expected claimed, got ${result.status}`);
	return result;
}

describe("connection name", () => {
	it("is a personal token's label, which also stands in for an undeclared model", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId); // labelled "test"
		const category = uniqueCategory();

		const defaulted = await claimOverRest(token, { category, name: "Hilbert" });
		const declared = await claimOverRest(token, {
			category,
			name: "Cantor",
			model: "Claude",
			model_version: "Opus 5",
		});

		expect(await testStore().getEntry(userId, defaulted.entry.id)).toMatchObject({
			model: "test",
			model_version: null,
			client: "test",
		});
		expect(await testStore().getEntry(userId, declared.entry.id)).toMatchObject({
			model: "Claude",
			model_version: "Opus 5",
			client: "test",
		});
	});

	it("is the OAuth client's registered name for an access token", async () => {
		const userId = await seedUser();
		const { accessToken } = await issueOAuthTokens(userId); // client "Test Client"

		const result = await claimOverRest(accessToken, { category: uniqueCategory(), name: "Noether" });

		expect(await testStore().getEntry(userId, result.entry.id)).toMatchObject({
			model: "Test Client",
			client: "Test Client",
		});
	});
});

describe("once", () => {
	it("computes on first use only", async () => {
		let calls = 0;
		const value = once(async () => {
			calls += 1;
			return "name";
		});
		expect(calls).toBe(0);
		expect(await value()).toBe("name");
		expect(await value()).toBe("name");
		expect(calls).toBe(1);
	});
});
```

In `test/rest.test.ts`:

1. Add `testStore` to the helpers import.
2. In `context()`, add `connectionName: async () => "cron",` after `globalMinUsers: 2,`.
3. Append:

```ts
describe("models over REST", () => {
	it("defaults the model to the connection name, and an explicit model wins", async () => {
		const ctx = await context();
		const category = uniqueCategory();

		const defaulted = ClaimResult.parse(
			await (await post("/api/v1/claims", { category, name: "Hilbert" }, ctx)).json(),
		);
		const declared = ClaimResult.parse(
			await (await post("/api/v1/claims", { category, name: "Cantor", model: "Claude" }, ctx)).json(),
		);

		if (defaulted.status !== "claimed" || declared.status !== "claimed") {
			throw new Error("expected claimed");
		}
		expect(defaulted.entry.model).toBe("cron");
		expect(declared.entry.model).toBe("Claude");
		expect(await testStore().getEntry(ctx.userId, declared.entry.id)).toMatchObject({
			client: "cron",
		});
	});

	it("checks against the connection's ledger when no model is given", async () => {
		const ctx = await context();
		await testStore().setShareLedger(ctx.userId, false);
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Gauss", model: "Claude" }, ctx);

		const check = async (body: Record<string, unknown>) =>
			CheckResult.parse(await (await post("/api/v1/checks", { category, ...body }, ctx)).json());

		expect((await check({ name: "gauss" })).likely_repeat).toBe(false);
		expect((await check({ name: "gauss", model: "claude" })).likely_repeat).toBe(true);
	});

	it("filters entries and stats by model", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Hilbert", model: "Claude" }, ctx);
		await post("/api/v1/claims", { category, name: "Cantor", model: "Grok" }, ctx);
		await post("/api/v1/claims", { category, name: "hilbert", model: "Claude" }, ctx);

		const listed = ListResult.parse(
			await (
				await createRestApp().request(`/api/v1/entries?category=${category}&model=grok`, {}, ctx)
			).json(),
		);
		expect(listed.entries.map((entry) => entry.display_name)).toEqual(["Cantor"]);
		const stats = StatsResult.parse(
			await (
				await createRestApp().request(
					`/api/v1/stats?scope=me&category=${category}&model=GROK`,
					{},
					ctx,
				)
			).json(),
		);
		expect(stats.repeats).toEqual([]);
	});
});
```

In `test/mcp.test.ts`:

1. Add `import { z } from "zod";` after the vitest import, and add `MODEL_DESCRIPTION` and `MODEL_VERSION_DESCRIPTION` to the import from `../src/api/schemas`.
2. Every `claim_topic` and `check_topic` call that expects success gains `model: "Claude"` in its arguments. These are exactly the calls with arguments
   `{ category, name: "Euler's Identity" }`, `{ category, name: "euler identity" }`, `{ category, name: "EULER IDENTITY" }`, `{ category, name: "Noether" }`, `{ category: padded, name: "Fermat's Last Theorem" }` and `{ category, name: "alhazen" }`. Leave the "rejects invalid arguments" call unchanged.
3. Add, before `describe("MCP endpoint", ...)`:

```ts
const ToolSchema = z.object({
	properties: z.record(z.string(), z.looseObject({ description: z.string().optional() })),
	required: z.array(z.string()).default([]),
});
```

4. Append inside `describe("MCP endpoint", ...)`, after the last test:

```ts
	it("requires a declared model on claim_topic and check_topic, and describes both model fields", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const { tools } = await client.listTools();
		const schema = (name: string) =>
			ToolSchema.parse(tools.find((tool) => tool.name === name)?.inputSchema);

		const claim = schema("claim_topic");
		expect(claim.required).toContain("model");
		expect(claim.required).not.toContain("model_version");
		expect(claim.properties.model?.description).toBe(MODEL_DESCRIPTION);
		expect(claim.properties.model_version?.description).toBe(MODEL_VERSION_DESCRIPTION);
		const check = schema("check_topic");
		expect(check.required).toContain("model");
		expect(check.properties.model?.description).toBe(MODEL_DESCRIPTION);
		expect(check.properties.model_version).toBeUndefined();

		// The SDK may surface schema violations as a tool error result or as a protocol error.
		const missing = await call(client, "claim_topic", {
			category: uniqueCategory(),
			name: "Hilbert",
		}).then(
			(result) => result.isError === true,
			() => true,
		);
		expect(missing).toBe(true);
	});

	it("records the declared model and version, with the OAuth client's name as the connection", async () => {
		const userId = await seedUser();
		const { accessToken } = await issueOAuthTokens(userId);
		const client = await connect(accessToken);

		const result = ClaimResult.parse(
			(
				await call(client, "claim_topic", {
					category: uniqueCategory(),
					name: "Hypatia",
					model: "Claude",
					model_version: "Opus 5",
				})
			).structuredContent,
		);

		if (result.status !== "claimed") throw new Error("expected claimed");
		expect(await testStore().getEntry(userId, result.entry.id)).toMatchObject({
			model: "Claude",
			model_version: "Opus 5",
			client: "Test Client",
		});
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tokens.test.ts test/connection.test.ts test/rest.test.ts test/mcp.test.ts`
Expected: FAIL — `src/api/connection.ts` does not exist, `ApiContext` has no `connectionName`, tokens carry no `client`, and MCP does not require `model`.

- [ ] **Step 3: Carry the token label in props**

In `src/env.ts`, the `OAUTH_PROVIDER` comment becomes `/** Injected by OAuthProvider before the default and API handlers run. */` and `PropsSchema` becomes:

```ts
export const PropsSchema = z.object({
	userId: z.string().min(1),
	/** A personal token's label. OAuth grants carry no client here; see api/connection.ts. */
	client: z.string().min(1).optional(),
});
```

In `src/auth/tokens.ts`, `resolvePersonalToken`'s return type becomes `Promise<{ userId: string; client: string } | null>` and its last line becomes:

```ts
	return { userId: row.user_id, client: row.label };
```

- [ ] **Step 4: Resolve the connection name**

Create `src/api/connection.ts`:

```ts
import type { Env } from "../env";

/**
 * The name of the connection a request arrived on, kept for audit and used as REST's default
 * model: a personal token's label (already in props), or the OAuth client's registered name,
 * falling back to its client id. Null only when the bearer credential cannot be unwrapped.
 */
export async function connectionName(
	env: Pick<Env, "OAUTH_PROVIDER">,
	request: Request,
	propsClient: string | undefined,
): Promise<string | null> {
	if (propsClient !== undefined) return propsClient;
	const token = bearerToken(request);
	if (token === null) return null;
	const summary = await env.OAUTH_PROVIDER.unwrapToken(token);
	if (!summary) return null;
	const client = await env.OAUTH_PROVIDER.lookupClient(summary.grant.clientId);
	const name = client?.clientName?.trim();
	return name ? name : summary.grant.clientId;
}

function bearerToken(request: Request): string | null {
	const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
	return match?.[1] ?? null;
}

/** Memoises an async value: computed on first use, and never if unused. */
export function once<T>(compute: () => Promise<T>): () => Promise<T> {
	let value: Promise<T> | undefined;
	return () => {
		value ??= compute();
		return value;
	};
}
```

In `src/api/context.ts`, add to `ApiContext`:

```ts
	/** The connection's name (see api/connection.ts), resolved on first use. */
	connectionName: () => Promise<string | null>;
```

In `src/api/handler.ts`, add `import { connectionName, once } from "./connection";` and add to the `api` literal, after `globalMinUsers`:

```ts
			connectionName: once(() => connectionName(env, request, props.data.client)),
```

- [ ] **Step 5: Accept declared models over REST and MCP**

In `src/api/rest.ts`, replace the `/claims` and `/checks` routes with:

```ts
	app.post("/claims", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(ClaimInput, await readJson(c.req.raw));
		const client = await c.env.connectionName();
		// Scripts need not declare a model: the connection's name stands in for it.
		const model = input.model ?? client;
		const claim: ClaimInput = model === null ? input : { ...input, model };
		return c.json(await c.env.ledger.claim(c.env.userId, claim, client));
	});

	app.post("/checks", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(CheckInput, await readJson(c.req.raw));
		const model = input.model ?? (await c.env.connectionName());
		const check: CheckInput = model === null ? input : { ...input, model };
		return c.json(await c.env.ledger.check(c.env.userId, check));
	});
```

In `src/api/mcp.ts`:

1. In the `./schemas` import, replace `CheckInput` with `CheckToolInput` and `ClaimInput` with `ClaimToolInput`.
2. In `claim_topic`, set `inputSchema: ClaimToolInput` and make the handler body:

```ts
			run(async () => {
				await enforceRateLimit(api.limiter, api.userId);
				return api.ledger.claim(api.userId, args, await api.connectionName());
			}),
```

3. In `check_topic`, set `inputSchema: CheckToolInput`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/tokens.test.ts test/connection.test.ts test/rest.test.ts test/mcp.test.ts`
Expected: PASS. If only the description assertions fail because a description is missing from the tool's JSON schema, apply the Task 4 contingency (move `.describe()` to the outermost schema of that field) and rerun.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Falsify**

Make each break, run the four test files, record the failing test, restore:

1. In `/claims`, change `input.model ?? client` to `input.model ?? null`. Expected: FAIL in "defaults the model to the connection name" and "is a personal token's label".
2. In `connectionName`, return `summary.grant.clientId` without looking up the client. Expected: FAIL in "is the OAuth client's registered name" and "records the declared model and version".
3. In `mcp.ts`, set `claim_topic`'s `inputSchema` back to `ClaimInput`. Expected: FAIL in "requires a declared model".
4. In `mcp.ts`, pass `null` instead of `await api.connectionName()`. Expected: FAIL in "records the declared model and version".
5. In `once`, remove the memo (`return () => compute();`). Expected: FAIL in "computes on first use only".
6. In `/checks`, change `?? (await c.env.connectionName())` to `?? null`. Expected: FAIL in "checks against the connection's ledger".

- [ ] **Step 8: Commit**

```bash
git add src/env.ts src/auth/tokens.ts src/api/connection.ts src/api/context.ts src/api/handler.ts src/api/rest.ts src/api/mcp.ts test/tokens.test.ts test/connection.test.ts test/rest.test.ts test/mcp.test.ts
git commit -F - <<'EOF'
feat: resolve the connection name and accept declared models over REST and MCP

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 6: Dashboard

**Files:**
- Modify: `src/web/dashboard.tsx`
- Modify: `src/web/layout.tsx`
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 2 (`listEntries` with `model`, `getUser().share_ledger`, `setShareLedger`, `RepeatHit.model`), Task 3 (`listOverlaps`, `OverlapView`, `modelSummary`, `ModelSummaryRow`, `NearMissView.claim_model/matched_model`), Task 4 (`sameModel`, `ModelLabel`, `Ledger.claim(userId, input, client)`).
- Produces: `GET /overlaps` (`?view=combined`), `POST /account/ledger-sharing` (form field `share` = `on` | `off`), `GET /ledger?model=`, and the exported helper `formatRepeatRate(originals: number, hits: number): string`.

- [ ] **Step 1: Write the failing dashboard tests**

In `test/dashboard.test.ts`:

1. Add `import { formatRepeatRate } from "../src/web/dashboard";` after the `../src/web/app` import.
2. After `rowFor`, add:

```ts
/** The HTML between `<h2>heading</h2>` and the next h2 or the end of the page body. */
function section(html: string, heading: string): string {
	const marker = `<h2>${heading}</h2>`;
	const start = html.indexOf(marker);
	if (start === -1) throw new Error(`no section ${heading}`);
	const rest = html.slice(start + marker.length);
	const end = rest.search(/<h2>|<\/main>/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** The single <tr> whose first cell is exactly `label`. */
function summaryRow(html: string, label: string): string {
	const rows = html.split("<tr>").filter((row) => row.startsWith(`<td>${label}</td>`));
	if (rows.length !== 1) throw new Error(`expected one row for ${label}, got ${rows.length}`);
	return rows[0] ?? "";
}
```

3. In the "connect page" test, add:

```ts
		expect(html).toContain('href="/overlaps"');
		expect(html).toMatch(/(&quot;|")model(&quot;|"):(&quot;|")cron/);
```

4. Inside `describe("near misses page", ...)`, add:

```ts
	it("names the other model when a near miss crossed models", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		await ledger.claim(
			userId,
			{ category, name: "Ibn al-Haytham", force: false, model: "Claude" },
			"Claude",
		);
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const grok = await ledger.claim(
			userId,
			{ category, name: "Alhazen", force: false, model: "Grok" },
			"Grok",
		);
		if (grok.status !== "possible_repeat") throw new Error("expected possible_repeat");

		const html = await (await get("/near-misses", cookie)).text();
		expect(rowFor(html, "Alhazen", "Ibn al-Haytham")).toContain("<small>from Claude</small>");
	});
```

5. Append at the end of the file:

```ts
describe("overlaps page", () => {
	it("splits exact and spelling overlaps from meaning-only ones, and combines them on request", async () => {
		const userId = await seedUser();
		await testStore().setShareLedger(userId, false);
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claim = (name: string, model: string) =>
			ledger.claim(userId, { category, name, force: false, model }, model);
		await claim("Stone duality", "Claude");
		await claim("Étienne de La Boétie", "Claude");
		semantic.setSimilarity("Étienne de La Boétie", "Émilie du Châtelet", 0.84);
		await claim("stone duality", "Grok");
		await claim("Émilie du Châtelet", "Grok");

		const split = await (await get("/overlaps", cookie)).text();
		expect(section(split, "Overlaps")).toContain("<td>stone duality</td>");
		expect(section(split, "Overlaps")).not.toContain("Châtelet");
		expect(section(split, "Similar, unverified")).toContain("<td>Émilie du Châtelet</td>");
		expect(section(split, "Similar, unverified")).toContain("0.84");
		expect(section(split, "Similar, unverified")).not.toContain("stone duality");
		expect(split).not.toContain("Your models share one ledger");

		const combined = await (await get("/overlaps?view=combined", cookie)).text();
		expect(combined).not.toContain("<h2>Similar, unverified</h2>");
		expect(combined).toContain("<td>stone duality</td>");
		expect(combined).toContain("<td>Émilie du Châtelet</td>");
	});

	it("explains that a shared ledger blocks instead, and shows an empty state", async () => {
		const html = await (await get("/overlaps", await sessionCookie(await seedUser()))).text();
		expect(html).toContain("Your models share one ledger");
		expect(html).toContain("No overlaps yet.");
	});
});

describe("ledger models", () => {
	it("shows each topic's model and version, the connection when it differs, and filters by model", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		await ledger.claim(
			userId,
			{ category, name: "Hilbert", force: false, model: "Claude", model_version: "Opus 5" },
			"Claude",
		);
		await ledger.claim(userId, { category, name: "Cantor", force: false, model: "Grok" }, "openclaw");

		const all = await (await get("/ledger", cookie)).text();
		expect(all).toContain("Claude (Opus 5)");
		expect(all).toContain("connection: openclaw");
		expect(all).not.toContain("connection: Claude");

		const grok = await (await get("/ledger?model=grok", cookie)).text();
		expect(grok).toContain("Cantor");
		expect(grok).not.toContain("Hilbert");
		expect(grok).toContain("Showing topics from grok.");
	});
});

describe("repeats by model", () => {
	it("summarises attempts per model and names the model behind a cross-model hit", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claude = (name: string) =>
			ledger.claim(userId, { category, name, force: false, model: "Claude" }, "Claude");

		const kept = await claude("Euler's identity");
		if (kept.status !== "claimed") throw new Error("expected claimed");
		expect((await claude("euler identity")).status).toBe("repeat");
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.9);
		const skipped = await claude("e^(iπ)+1=0");
		if (skipped.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: skipped.entry.id, repeat_of: kept.entry.id });
		const grok = await ledger.claim(
			userId,
			{ category, name: "EULER'S IDENTITY", force: false, model: "Grok" },
			"Grok",
		);
		expect(grok.status).toBe("repeat");

		const html = await (await get("/repeats", cookie)).text();
		// Claude: one kept topic, a blocked repeat and a skip, so 2 hits over 3 attempts.
		expect(summaryRow(html, "Claude")).toContain("<td>67%</td>");
		expect(summaryRow(html, "Grok")).toContain("<td>100%</td>");
		expect(html).toContain("<small>by Grok</small>");
		expect(html).not.toContain("<small>by Claude</small>");
	});

	it("formats the rate, with a dash when there are no attempts", () => {
		expect(formatRepeatRate(0, 0)).toBe("—");
		expect(formatRepeatRate(1, 2)).toBe("67%");
		expect(formatRepeatRate(3, 0)).toBe("0%");
	});
});

describe("ledger sharing switch", () => {
	it("starts on, turns off and back on for same-origin posts only, and rejects other values", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);

		expect(await (await get("/account", cookie)).text()).toContain(
			"On: a topic any of your models has claimed is a repeat for all of them.",
		);

		expect((await post("/account/ledger-sharing", cookie, { share: "off" }, false)).status).toBe(403);
		expect((await testStore().getUser(userId))?.share_ledger).toBe(true);

		const off = await post("/account/ledger-sharing", cookie, { share: "off" });
		expect(off.headers.get("location")).toBe("/account");
		expect((await testStore().getUser(userId))?.share_ledger).toBe(false);
		expect(await (await get("/account", cookie)).text()).toContain(
			"Off: each model is blocked only by its own topics",
		);

		expect((await post("/account/ledger-sharing", cookie, { share: "maybe" })).status).toBe(400);
		await post("/account/ledger-sharing", cookie, { share: "on" });
		expect((await testStore().getUser(userId))?.share_ledger).toBe(true);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard.test.ts`
Expected: FAIL — `formatRepeatRate` is not exported, and the new pages, columns, labels and the switch do not exist.

- [ ] **Step 3: Add the Overlaps link to the navigation**

In `src/web/layout.tsx`, after `<a href="/near-misses">Near misses</a>` add:

```tsx
							<a href="/overlaps">Overlaps</a>
```

- [ ] **Step 4: Implement the dashboard changes**

In `src/web/dashboard.tsx`:

1. Replace `import type { Entry, RepeatStat } from "../api/schemas";` with
`import { ModelLabel, type RepeatStat } from "../api/schemas";`, add `import { sameModel } from "../core/match";`, and change the store import to:

```ts
import {
	LedgerStore,
	type ModelSummaryRow,
	type NearMissView,
	type OverlapView,
	type UserRepeatRow,
} from "../store/d1";
```

2. After `const DeleteForm = ...`, add:

```ts
const ShareForm = z.object({ share: z.enum(["on", "off"]) });
const ViewQuery = z.enum(["split", "combined"]).catch("split");
```

3. After `LandingPage`, add the helpers:

```tsx
function modelLabel(model: string, version: string | null): string {
	return version === null ? model : `${model} (${version})`;
}

/** True when both names are present and name different models. */
function differentModels(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && !sameModel(a, b);
}

/**
 * Hits over attempts. Every attempt ends as a kept original, a blocked hit, or a skip (an alias,
 * which is no longer an original, plus a hit), so originals plus hits counts attempts.
 */
export function formatRepeatRate(originals: number, hits: number): string {
	const attempts = originals + hits;
	return attempts === 0 ? "—" : `${Math.round((hits / attempts) * 100)}%`;
}
```

4. Replace `LedgerPage` with:

```tsx
function LedgerPage(props: {
	entries: EntryRow[];
	aliases: ReadonlyMap<string, string[]>;
	model: string | undefined;
}) {
	return (
		<Layout title="Ledger" signedIn>
			<h1>Ledger</h1>
			{props.model === undefined ? null : (
				<p>
					{`Showing topics from ${props.model}.`} <a href="/ledger">Show all</a>
				</p>
			)}
			{props.entries.length === 0 ? (
				<p>
					No topics yet. Connect your brief on the <a href="/connect">Connect</a> page.
				</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Model</th>
							<th>Claimed</th>
							<th>Repeats</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.entries.map((entry) => {
							const aliases = props.aliases.get(entry.id) ?? [];
							const showClient =
								entry.client !== null &&
								(entry.model === null || !sameModel(entry.client, entry.model));
							return (
								<tr>
									<td>
										{entry.display_name}
										{aliases.length > 0 ? (
											<>
												<br />
												<small>{`also claimed as: ${aliases.join(", ")}`}</small>
											</>
										) : null}
									</td>
									<td>{entry.category}</td>
									<td>
										{entry.model === null ? (
											"—"
										) : (
											<a href={`/ledger?model=${encodeURIComponent(entry.model)}`}>
												{modelLabel(entry.model, entry.model_version)}
											</a>
										)}
										{showClient ? (
											<>
												<br />
												<small>{`connection: ${entry.client}`}</small>
											</>
										) : null}
									</td>
									<td>{toIso(entry.created_at).slice(0, 10)}</td>
									<td>{entry.hit_count}</td>
									<td>
										<form class="inline" method="post" action={`/entries/${entry.id}/forget`}>
											<button type="submit">Forget</button>
										</form>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
			<p>Showing the newest {PAGE_LIMIT} topics.</p>
		</Layout>
	);
}
```

5. In `NearMissesPage`, the matched cell becomes:

```tsx
								<td>
									{row.matched_name} <small>{`(${row.category})`}</small>
									{row.via_name === null ? null : (
										<>
											<br />
											<small>{`via ${row.via_name}`}</small>
										</>
									)}
									{differentModels(row.claim_model, row.matched_model) ? (
										<>
											<br />
											<small>{`from ${row.matched_model}`}</small>
										</>
									) : null}
								</td>
```

6. After `NearMissesPage`, add:

```tsx
function OverlapTable(props: { rows: OverlapView[] }) {
	return (
		<table>
			<thead>
				<tr>
					<th>Date</th>
					<th>Topic</th>
					<th>Model</th>
					<th>Matched topic</th>
					<th>Model</th>
					<th>Match</th>
					<th>Score</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row) => (
					<tr>
						<td>{toIso(row.created_at).slice(0, 10)}</td>
						<td>{row.claim_name}</td>
						<td>{row.claim_model ?? "—"}</td>
						<td>
							{row.matched_name}
							{row.via_name === null ? null : (
								<>
									<br />
									<small>{`via ${row.via_name}`}</small>
								</>
							)}
						</td>
						<td>{row.matched_model ?? "—"}</td>
						<td>{row.match_kind}</td>
						<td>{row.score.toFixed(2)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function OverlapsPage(props: {
	rows: OverlapView[];
	view: "split" | "combined";
	shareLedger: boolean;
}) {
	const lexical = props.rows.filter((row) => row.match_kind !== "semantic");
	const similar = props.rows.filter((row) => row.match_kind === "semantic");
	return (
		<Layout title="Overlaps" signedIn>
			<h1>Overlaps between models</h1>
			<p>Topics one model claimed that another model had already covered.</p>
			{props.shareLedger ? (
				<p>
					Your models share one ledger, so a match between models blocks the claim instead of
					recording an overlap. Those appear on <a href="/repeats">Repeats</a>. Change this on
					the <a href="/account">Account</a> page.
				</p>
			) : null}
			{props.rows.length === 0 ? (
				<p>No overlaps yet.</p>
			) : props.view === "combined" ? (
				<>
					<p>
						<a href="/overlaps">Split by match type</a>
					</p>
					<OverlapTable rows={props.rows} />
				</>
			) : (
				<>
					<p>
						<a href="/overlaps?view=combined">Combine into one list</a>
					</p>
					<h2>Overlaps</h2>
					{lexical.length === 0 ? <p>None.</p> : <OverlapTable rows={lexical} />}
					<h2>Similar, unverified</h2>
					<p>Matched by meaning only, so these may be different topics.</p>
					{similar.length === 0 ? <p>None.</p> : <OverlapTable rows={similar} />}
				</>
			)}
			<p>Showing the newest {PAGE_LIMIT} overlaps.</p>
		</Layout>
	);
}
```

7. Replace `MyRepeatsPage` with:

```tsx
function ModelSummaryTable(props: { rows: ModelSummaryRow[] }) {
	return (
		<table>
			<thead>
				<tr>
					<th>Model</th>
					<th>Topics</th>
					<th>Repeats</th>
					<th>Repeat rate</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row) => (
					<tr>
						<td>{row.label ?? "Unattributed"}</td>
						<td>{row.originals}</td>
						<td>{row.hits}</td>
						<td>{formatRepeatRate(row.originals, row.hits)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function MyRepeatsPage(props: { rows: UserRepeatRow[]; summary: ModelSummaryRow[] }) {
	return (
		<Layout title="Your repeats" signedIn>
			<h1>Your repeats</h1>
			{props.summary.length === 0 ? null : (
				<>
					<h2>By model</h2>
					<p>The repeat rate is repeats over attempts: every claim the model made, kept or not.</p>
					<ModelSummaryTable rows={props.summary} />
					<h2>Topics</h2>
				</>
			)}
			{props.rows.length === 0 ? (
				<p>No repeats yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Hits</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<tr>
								<td>{row.entry.display_name}</td>
								<td>{row.entry.category}</td>
								<td>{row.entry.hit_count}</td>
								<td>
									<details>
										<summary>{row.hits.length} blocked attempts</summary>
										<table>
											<thead>
												<tr>
													<th>Phrasing</th>
													<th>Match</th>
													<th>Score</th>
												</tr>
											</thead>
											<tbody>
												{row.hits.map((hit) => (
													<tr>
														<td>
															{hit.candidate_text}
															{differentModels(hit.model, row.entry.model) ? (
																<>
																	{" "}
																	<small>{`by ${hit.model}`}</small>
																</>
															) : null}
														</td>
														<td>{hit.match_kind}</td>
														<td>{hit.score.toFixed(2)}</td>
													</tr>
												))}
											</tbody>
										</table>
									</details>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Layout>
	);
}
```

8. In `ConnectPage`, the last `curl` line becomes
``  `  -d '{"category":"math","name":"Euler identity","model":"cron"}'`, `` and after `<pre>{curl}</pre>` add:

```tsx
			<p>
				<code>model</code> is optional over REST and defaults to the token's label.
			</p>
```

9. Replace `AccountPage` with:

```tsx
function AccountPage(props: { shareLedger: boolean }) {
	return (
		<Layout title="Account" signedIn>
			<h1>Account</h1>
			<h2>Share one ledger across all my models</h2>
			<p>
				{props.shareLedger
					? "On: a topic any of your models has claimed is a repeat for all of them."
					: "Off: each model is blocked only by its own topics, and matches between models are recorded as overlaps."}
			</p>
			<form method="post" action="/account/ledger-sharing">
				<input type="hidden" name="share" value={props.shareLedger ? "off" : "on"} />
				<button type="submit">{props.shareLedger ? "Turn sharing off" : "Turn sharing on"}</button>
			</form>
			<h2>Delete account</h2>
			<p>This permanently deletes your topics, repeat history, tokens and connected clients.</p>
			<form method="post" action="/account/delete">
				<label>
					Type <code>delete</code> to confirm <input name="confirm" required />
				</label>{" "}
				<button type="submit">Delete my account</button>
			</form>
		</Layout>
	);
}
```

10. Replace the `/ledger` route with:

```tsx
	app.get(
		"/ledger",
		page(async (c, userId) => {
			const filter = ModelLabel.safeParse(c.req.query("model"));
			const model = filter.success ? filter.data : undefined;
			const store = new LedgerStore(c.env.DB);
			const entries = await store.listEntries(userId, { limit: PAGE_LIMIT, model });
			const aliases = await store.listAliases(
				userId,
				entries.map((entry) => entry.id),
			);
			return render(
				c,
				<LedgerPage entries={entries} aliases={aliasNamesByOriginal(aliases)} model={model} />,
			);
		}),
	);
```

11. Replace the `/repeats` route with:

```tsx
	app.get(
		"/repeats",
		page(async (c, userId) => {
			const store = new LedgerStore(c.env.DB);
			const rows = await store.topRepeatsForUser(userId, undefined, PAGE_LIMIT);
			const summary = await store.modelSummary(userId);
			return render(c, <MyRepeatsPage rows={rows} summary={summary} />);
		}),
	);
```

12. After the `/near-misses` route, add:

```tsx
	app.get(
		"/overlaps",
		page(async (c, userId) => {
			const store = new LedgerStore(c.env.DB);
			const rows = await store.listOverlaps(userId, PAGE_LIMIT);
			const user = await store.getUser(userId);
			return render(
				c,
				<OverlapsPage
					rows={rows}
					view={ViewQuery.parse(c.req.query("view"))}
					shareLedger={user?.share_ledger ?? true}
				/>,
			);
		}),
	);
```

13. Replace the `/account` route with the two routes below (the `/account/delete` route is unchanged):

```tsx
	app.get(
		"/account",
		page(async (c, userId) => {
			const user = await new LedgerStore(c.env.DB).getUser(userId);
			return render(c, <AccountPage shareLedger={user?.share_ledger ?? true} />);
		}),
	);

	app.post(
		"/account/ledger-sharing",
		action(async (c, userId) => {
			const form = ShareForm.safeParse(await c.req.parseBody());
			if (!form.success) {
				return render(c, <ErrorPage title="Not changed" message="Choose on or off." />, 400);
			}
			await new LedgerStore(c.env.DB).setShareLedger(userId, form.data.share === "on");
			return c.redirect("/account");
		}),
	);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Falsify**

Make each break, run `npx vitest run test/dashboard.test.ts`, record the failing test, restore:

1. In `formatRepeatRate`, divide by `originals` instead of `attempts`. Expected: FAIL in "summarises attempts per model" and "formats the rate".
2. In `OverlapsPage`, define `lexical` as all rows. Expected: FAIL in "splits exact and spelling overlaps".
3. In the `/ledger` route, pass `model: undefined` to `listEntries`. Expected: FAIL in "ledger models".
4. In `/account/ledger-sharing`, store `form.data.share === "off"`. Expected: FAIL in "ledger sharing switch".
5. In the phrasing cell, drop the `differentModels` check (always render `by ${hit.model}`). Expected: FAIL in "summarises attempts per model" (`by Claude` appears).
6. Register `/account/ledger-sharing` with `page` instead of `action`. Expected: FAIL in "ledger sharing switch" (the cross-origin post is not refused).
7. In `NearMissesPage`, remove the `from` label. Expected: FAIL in "names the other model".

- [ ] **Step 7: Commit**

```bash
git add src/web/dashboard.tsx src/web/layout.tsx test/dashboard.test.ts
git commit -F - <<'EOF'
feat: show overlaps, models and per-model repeat rates on the dashboard, with the sharing switch

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

### Task 7: Documentation and version

**Files:**
- Modify: `README.md`
- Modify: `package.json`, `package-lock.json` (via `npm version`)
- Modify: `src/api/mcp.ts` (`MCP_SERVER_VERSION`)

**Interfaces:**
- Consumes: the behaviour shipped by Tasks 1–6.
- Produces: user-facing documentation and version 0.2.0. No code behaviour changes.

- [ ] **Step 1: Bump the version**

Run: `npm version 0.2.0 --no-git-tag-version`
Expected: `package.json` and `package-lock.json` both show `"version": "0.2.0"`.

In `src/api/mcp.ts`: `export const MCP_SERVER_VERSION = "0.2.0";`

- [ ] **Step 2: Update the README's REST reference**

In `README.md`, the curl example's `-d` line becomes:

```sh
  -d '{"category":"math","name":"Euler identity","model":"cron"}'
```

In the REST table, replace these four rows:

```markdown
| POST | `/api/v1/claims` | `{category, name, force?, model?, model_version?}` | `{status: "claimed", entry, forced, overridden_matches, semantic}`, `{status: "possible_repeat", entry, possible_matches, next_step, semantic}` or `{status: "repeat", matches, semantic}` |
| POST | `/api/v1/checks` | `{category, name, model?}` | `{likely_repeat, matches, semantic}` (records nothing) |
| GET | `/api/v1/entries` | `?category=&limit=&since=&model=` | `{entries}` (original topics only; each carries its `model`) |
```

```markdown
| GET | `/api/v1/stats` | `?scope=me\|global&category=&limit=&model=` | `{scope, repeats}` |
```

and add, directly after the table (before the `Errors are ...` paragraph):

```markdown
`model` defaults to the token's label. Model filters compare case-insensitively.
```

- [ ] **Step 3: Add the Models section**

In `README.md`, insert immediately before `## Development`:

```markdown
## Models

Every claim records the model that made it. Over MCP, `claim_topic` and `check_topic` require
`model`: the model's family name, such as `Claude`, `Grok` or `Gemini`, never a version, because it
decides which ledger the claim is checked against. An optional `model_version` ("Opus 5") is kept as
a label. Over REST, `model` defaults to the token's label. Model names compare case-insensitively.

**Share one ledger across all my models** is a switch on the dashboard's **Account** page, on by
default:

- **On:** every claim is checked against every topic on your account, whichever model claimed it.
  Repeats block and possible repeats ask for a verdict, as described above; the hit records which
  model was blocked.
- **Off:** each model is blocked only by its own topics. A match against another model's topic
  never blocks and never asks: it is recorded as an **overlap** with its match type and score.

Topics claimed before models were recorded have no model, and count as belonging to every model.

The **Overlaps** page lists exact and spelling matches between models, with meaning-only matches
in a separate *Similar, unverified* section, or as one combined list. The **Repeats** page opens
with a per-model summary. Its repeat rate is repeats over attempts: every attempt ends as a kept
topic, a blocked repeat or a skip, so the rate is `hits / (topics + hits)`.
```

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: PASS.

Run: `git diff --stat -- src/web/prompt.ts` and `grep -c "choose a topic on your own" README.md`
Expected: no diff for `src/web/prompt.ts`, and a count of `1` (the brief prompt quote is unchanged).

- [ ] **Step 5: Commit**

```bash
git add README.md package.json package-lock.json src/api/mcp.ts
git commit -F - <<'EOF'
docs: document model ledgers and bump to 0.2.0

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```
