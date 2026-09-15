# Near Misses and Verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every possible match a claim surfaces as a near miss, let the brief answer with `skip_topic` (same topic → the claim becomes an alias of the original and a hit is recorded) or `keep_topic`, resolve aliases during matching, drop `forget_topic` from MCP, and show near misses on the dashboard.

**Architecture:** Migration 0002 adds `entries.alias_of` and a `near_misses` table. Matching resolves any matched alias to its original before ranking, so hits, verdicts and near misses always reference originals. `Ledger.claim` gains a `possible_repeat` status and writes near-miss rows; `Ledger.skip` applies one guarded D1 batch; `Ledger.keep` is one guarded update. REST and MCP expose skip/keep; the dashboard gets `/near-misses` and alias names on `/ledger`.

**Tech Stack:** TypeScript 6, Cloudflare Workers, D1, Hono 4 JSX, zod 4, `@modelcontextprotocol/server` 2, Vitest 4 with `@cloudflare/vitest-plugin`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-15-near-misses-design.md` (amends `docs/superpowers/specs/2026-09-14-topic-ledger-design.md`; the near-misses spec wins where they disagree)

## Global Constraints

- **Branch:** `feat/topic-ledger` (this ships in v0.1.0; `package.json` version stays `0.1.0`, `MCP_SERVER_VERSION` stays `"0.1.0"`). No new dependencies; existing pins are exact and unchanged.
- **Typing rule:** every request, response, tool input and tool output is a zod schema in `src/api/schemas.ts`; TypeScript types come from `z.infer`. No `any`, no `as` casts on external data (parse with zod), no hand-assembled JSON objects outside those types. `tsc` runs `strict` with `noUncheckedIndexedAccess`. D1 rows are parsed with zod schemas (`src/core/rows.ts` or the store module).
- **Imports:** `verbatimModuleSyntax` is on — type-only imports must use `import type` (or inline `type` specifiers).
- **Thresholds (unchanged):** `TRIGRAM_REPEAT_THRESHOLD` 0.6, `SEMANTIC_REPEAT_THRESHOLD` 1, `SEMANTIC_POSSIBLE_THRESHOLD` 0.78, `GLOBAL_MIN_USERS` 2. Embedding model `@cf/qwen/qwen3-embedding-0.6b` (unchanged).
- **Error codes → HTTP:** `unauthorized` 401, `invalid_input` 400, `not_found` 404, `rate_limited` 429, `upstream_unavailable` 503.
- **Verdict values:** `pending`, `repeat`, `distinct`. **Note:** trimmed, 1–500 characters, optional.
- **Exact strings (copy verbatim):**
  - `NEXT_STEP` = `Decide whether this topic is the same as any possible match. If it is, call skip_topic with repeat_of set to that match's entry_id and choose a different topic. Otherwise call keep_topic.`
  - `FORCED_NOTE` = `forced`
  - Dashboard verdict labels use the em dash U+2014: `Repeat — skipped`, `Different — kept`, `No verdict — used`, `Not judged — claim skipped`. The page and the test that asserts it must carry the same characters.
- **Non-ASCII in source (amended, ruling R1):** in `src/` *pattern constants* — regexes and normalization tables, such as the possessive regex in `src/core/normalize.ts`, which silently lost its U+2019 in an earlier session — write the character as a JavaScript escape (a backslash, then `u`, then the four hex digits), never as the character itself. Everywhere else, including test data and UI label strings, copy the character itself and follow the surrounding file (`test/store.test.ts` already stores a raw `π`). After editing, verify the bytes: `grep -caP '\x00' <file>` must print `0`, and a character you pasted must still be the character you meant.
- **Test isolation:** never assume an empty database. Every test creates its own users (`seedUser()`) and categories (`uniqueCategory()`). Test files run serially against one local D1.
- **Formatting:** Biome, tabs, line width 100. Run `npx biome check --write <files you changed>` before the gate.
- **Commits:** every commit message ends with exactly this trailer line and no other `Co-Authored-By` line:
  `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- **Gate before each commit:** `npm run check` (typecheck + lint + tests) must pass. Never commit while it fails.

## Deltas from the spec found while planning

1. `SkipInput`/`KeepInput` are built from REST body schemas `SkipBody = { repeat_of, note? }` and `KeepBody = { note? }` (entry id from the path). `POST /entries/:id/keep` therefore requires a JSON body (`{}` is fine), like every other REST POST.
2. `NearMissView` (dashboard join row) lives in `src/store/d1.ts` next to `UserRepeatRow`, because it is a store read model, not a wire type.
3. Near-miss rows are written right after the claim's entry insert and before the embedding upsert, so a failed upsert still leaves the verdict request recorded.
4. The skip guard also requires the claim entry to have `hit_count = 0` and no aliases *inside* the batch, so the spec's step-2 rejection is atomic as well as pre-checked.

## File Structure

```
migrations/0002_near_misses.sql   entries.alias_of + near_misses table (Task 1)
src/core/rows.ts                  EntryRow.alias_of, VerdictSchema, NearMissRowSchema (Task 1)
src/store/d1.ts                   alias/near-miss queries; originals-only listings (Task 1)
src/core/match.ts                 ScoredMatch.via, resolveAliases (Task 2)
src/core/wire.ts                  Match.via_alias (Task 2)
src/core/ledger.ts                alias resolution, SEMANTIC_TOP_K (Task 2); possible_repeat +
                                  near-miss rows (Task 3); skip, keep, alias-aware forget (Task 4)
src/api/schemas.ts                Match.via_alias (Task 2); ClaimResult (Task 3);
                                  Skip*/Keep* (Task 4); Forget* removed (Task 5)
src/api/rest.ts                   skip/keep routes (Task 5)
src/api/mcp.ts                    skip_topic/keep_topic, forget_topic removed (Task 5)
src/web/layout.tsx                nav link (Task 6)
src/web/dashboard.tsx             /near-misses, aliases on /ledger (Task 6)
src/web/prompt.ts                 new prompt snippet (Task 6)
test/helpers.ts                   makeEntry alias_of default, makeNearMiss (Task 1)
test/migrations.test.ts, test/store.test.ts            (Task 1)
test/match.test.ts, test/ledger-claim.test.ts          (Tasks 1–3)
test/schemas.test.ts                                   (Tasks 3–4)
test/ledger-verdicts.test.ts (new), test/ledger-admin.test.ts   (Task 4)
test/rest.test.ts, test/mcp.test.ts                    (Task 5)
test/dashboard.test.ts                                 (Task 6)
README.md (Tasks 5–6), docs/calibration.md and the original spec (Task 6)
```

---

### Task 1: Schema, rows and store

**Files:**
- Create: `migrations/0002_near_misses.sql`
- Modify: `src/core/rows.ts`, `src/store/d1.ts`, `src/core/ledger.ts` (one field in the entry literal), `test/helpers.ts`, `test/match.test.ts` (one field in the `entry()` helper)
- Test: `test/migrations.test.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: existing `LedgerStore`, `chunk`, `placeholders`, `MAX_IN_LIST`, `MatchKind`, `HitRow`, `makeEntry`, `makeHit`.
- Produces:
  - `src/core/rows.ts`: `EntryRow` gains `alias_of: string | null`; `VerdictSchema`, `type Verdict = "pending" | "repeat" | "distinct"`; `NearMissRowSchema`, `type NearMissRow = { id; user_id; claim_entry_id; matched_entry_id; via_entry_id: string | null; match_kind: MatchKind; score: number; verdict: Verdict; note: string | null; created_at: number; decided_at: number | null }`.
  - `src/store/d1.ts`: `type NearMissView = { id; created_at: number; claim_name; claim_alias_of: string | null; matched_name; category; via_name: string | null; match_kind; score; verdict; note: string | null }`; `interface SkipWrite { nearMissId: string; claimEntryId: string; hit: HitRow; note: string | null; decidedAt: number }`; new `LedgerStore` methods:
    - `getEntry(userId: string, entryId: string): Promise<EntryRow | null>`
    - `listAliases(userId: string, originalIds: readonly string[]): Promise<EntryRow[]>`
    - `insertNearMisses(rows: readonly NearMissRow[]): Promise<void>`
    - `listNearMissesForClaim(userId: string, claimEntryId: string): Promise<NearMissRow[]>` (highest score first)
    - `skipAsAlias(write: SkipWrite): Promise<boolean>` (false when a concurrent verdict already decided the claim)
    - `keepPending(userId: string, claimEntryId: string, note: string | null, decidedAt: number): Promise<number>`
    - `listNearMisses(userId: string, limit: number): Promise<NearMissView[]>` (newest first)
  - `listEntries`, `topRepeatsForUser` and the display-name lookup in `globalRepeats` return/consider originals only.
  - `test/helpers.ts`: `makeEntry` defaults `alias_of: null`; `makeNearMiss(claim: EntryRow, matched: EntryRow, overrides?: Partial<NearMissRow>): NearMissRow`.

- [ ] **Step 1: Write the failing migration tests**

Append to `test/migrations.test.ts` (it already defines `countWhere(table, column, value)` at the top):

```ts
describe("migration 0002_near_misses", () => {
	async function seedUserRow(): Promise<string> {
		const userId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, 1)",
		)
			.bind(userId)
			.run();
		return userId;
	}

	async function insertEntry(
		userId: string,
		name: string,
		aliasOf: string | null = null,
	): Promise<string> {
		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at) VALUES (?1, ?2, 'math', ?3, ?4, 'pending', 0, ?5, 1)",
		)
			.bind(id, userId, name, `${name.toLowerCase()} ${id}`, aliasOf)
			.run();
		return id;
	}

	async function insertNearMiss(
		userId: string,
		claimId: string,
		matchedId: string,
		viaId: string | null = null,
		verdict = "pending",
	): Promise<string> {
		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.8, ?6, 1)",
		)
			.bind(id, userId, claimId, matchedId, viaId, verdict)
			.run();
		return id;
	}

	it("cascades an original's deletion to its aliases and to near misses on either side", async () => {
		const userId = await seedUserRow();
		const original = await insertEntry(userId, "Euler");
		const alias = await insertEntry(userId, "Leonhard Euler", original);
		const claim = await insertEntry(userId, "Gauss");
		const other = await insertEntry(userId, "Noether");
		const matchedOriginal = await insertNearMiss(userId, claim, original);
		const claimedByAlias = await insertNearMiss(userId, alias, other);
		const unrelated = await insertNearMiss(userId, claim, other);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(original).run();

		expect(await countWhere("entries", "id", alias)).toBe(0);
		expect(await countWhere("near_misses", "id", matchedOriginal)).toBe(0);
		expect(await countWhere("near_misses", "id", claimedByAlias)).toBe(0);
		expect(await countWhere("near_misses", "id", unrelated)).toBe(1);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(claim).run();
		expect(await countWhere("near_misses", "id", unrelated)).toBe(0);
	});

	it("clears via_entry_id when the alias is deleted and removes near misses with the user", async () => {
		const userId = await seedUserRow();
		const original = await insertEntry(userId, "Hypatia");
		const alias = await insertEntry(userId, "Hypatia of Alexandria", original);
		const claim = await insertEntry(userId, "Alexandrian mathematician");
		const row = await insertNearMiss(userId, claim, original, alias);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(alias).run();
		const via = await env.DB.prepare("SELECT via_entry_id FROM near_misses WHERE id = ?1")
			.bind(row)
			.first<{ via_entry_id: string | null }>();
		expect(via).toEqual({ via_entry_id: null });

		await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();
		expect(await countWhere("near_misses", "user_id", userId)).toBe(0);
	});

	it("rejects an unknown verdict", async () => {
		const userId = await seedUserRow();
		const a = await insertEntry(userId, "Cantor");
		const b = await insertEntry(userId, "Cantor set");
		await expect(insertNearMiss(userId, a, b, null, "maybe")).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Write the failing store tests**

In `test/helpers.ts`, change the import `import type { EntryRow, HitRow } from "../src/core/rows";` to `import type { EntryRow, HitRow, NearMissRow } from "../src/core/rows";`, add `alias_of: null,` to `makeEntry`'s returned object (after `hit_count: 0,`), and append:

```ts
export function makeNearMiss(
	claim: EntryRow,
	matched: EntryRow,
	overrides: Partial<NearMissRow> = {},
): NearMissRow {
	return {
		id: crypto.randomUUID(),
		user_id: claim.user_id,
		claim_entry_id: claim.id,
		matched_entry_id: matched.id,
		via_entry_id: null,
		match_kind: "semantic",
		score: 0.8,
		verdict: "pending",
		note: null,
		created_at: Date.now(),
		decided_at: null,
		...overrides,
	};
}
```

In `test/match.test.ts`, add `alias_of: null,` to the `entry()` helper's object (after `hit_count: 0,`).

In `test/store.test.ts`, change the helpers import to `import { makeEntry, makeHit, makeNearMiss, seedUser, testStore, uniqueCategory } from "./helpers";` and append:

```ts
describe("aliases", () => {
	it("getEntry returns only the owner's entry", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const entry = makeEntry(alice, uniqueCategory(), "Gauss");
		await store.insertEntry(entry);
		expect(await store.getEntry(alice, entry.id)).toEqual(entry);
		expect(await store.getEntry(bob, entry.id)).toBeNull();
	});

	it("listAliases returns the owner's aliases; listEntries and topRepeatsForUser exclude aliases", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const original = makeEntry(userId, category, "Euler's identity", { created_at: 1 });
		// A stale hit_count on the alias proves the repeats listing filters aliases explicitly.
		const alias = makeEntry(userId, category, "e^(iπ)+1=0", {
			alias_of: original.id,
			hit_count: 1,
			created_at: 2,
		});
		for (const e of [original, alias]) await store.insertEntry(e);
		await store.recordHit(makeHit(original, "Euler identity"));

		expect((await store.listAliases(userId, [original.id])).map((e) => e.id)).toEqual([alias.id]);
		expect(await store.listAliases(await seedUser("other"), [original.id])).toEqual([]);
		expect(await store.listAliases(userId, [])).toEqual([]);
		expect((await store.listEntries(userId, { category, limit: 20 })).map((e) => e.id)).toEqual([
			original.id,
		]);
		expect((await store.topRepeatsForUser(userId, category, 20)).map((r) => r.entry.id)).toEqual([
			original.id,
		]);
	});

	it("globalRepeats picks the display name from originals only", async () => {
		const store = testStore();
		const category = uniqueCategory();
		for (const label of ["a", "b"]) {
			const userId = await seedUser(label);
			const entry = makeEntry(userId, category, "Euler's identity");
			await store.insertEntry(entry);
			await store.recordHit(makeHit(entry, "Euler identity"));
		}
		for (const label of ["c", "d", "e"]) {
			const userId = await seedUser(label);
			const original = makeEntry(userId, category, "Euler's formula");
			await store.insertEntry(original);
			await store.insertEntry(
				makeEntry(userId, category, "Euler’s Identity", { alias_of: original.id }),
			);
		}
		expect(await store.globalRepeats(category, 2, 20)).toEqual([
			{ category, display_name: "Euler's identity", hit_count: 2, distinct_users: 2 },
		]);
	});
});

describe("near misses", () => {
	async function seedClaim() {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const original = makeEntry(userId, category, "Ibn al-Haytham", { created_at: 1 });
		const other = makeEntry(userId, category, "Omar Khayyam", { created_at: 2 });
		const claim = makeEntry(userId, category, "Alhazen", { created_at: 3 });
		for (const e of [original, other, claim]) await store.insertEntry(e);
		const toOriginal = makeNearMiss(claim, original, { score: 0.9, created_at: 3 });
		const toOther = makeNearMiss(claim, other, { score: 0.79, created_at: 3 });
		await store.insertNearMisses([toOther, toOriginal]);
		return { store, userId, category, original, claim, toOriginal, toOther };
	}

	it("round-trips rows for a claim, highest score first, scoped to the owner", async () => {
		const { store, userId, claim, toOriginal, toOther } = await seedClaim();
		expect(await store.listNearMissesForClaim(userId, claim.id)).toEqual([toOriginal, toOther]);
		expect(await store.listNearMissesForClaim(await seedUser("other"), claim.id)).toEqual([]);
		await store.insertNearMisses([]);
	});

	it("skipAsAlias records the hit, marks the row, aliases the claim, and applies only once", async () => {
		const { store, userId, category, original, claim, toOriginal, toOther } = await seedClaim();
		const write = {
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name, {
				match_kind: "semantic",
				score: 0.9,
				created_at: 10,
			}),
			note: "same person",
			decidedAt: 10,
		};

		expect(await store.skipAsAlias(write)).toBe(true);
		expect(
			await store.skipAsAlias({ ...write, hit: { ...write.hit, id: crypto.randomUUID() } }),
		).toBe(false);

		expect((await store.getEntry(userId, claim.id))?.alias_of).toBe(original.id);
		const [repeat] = await store.topRepeatsForUser(userId, category, 20);
		expect(repeat?.entry.id).toBe(original.id);
		expect(repeat?.entry.hit_count).toBe(1);
		expect(repeat?.hits).toEqual([
			{ candidate_text: "Alhazen", match_kind: "semantic", score: 0.9 },
		]);
		expect(await store.listNearMissesForClaim(userId, claim.id)).toEqual([
			{ ...toOriginal, verdict: "repeat", note: "same person", decided_at: 10 },
			toOther,
		]);
	});

	it("skipAsAlias is a no-op once the claim has been kept", async () => {
		const { store, userId, category, original, claim, toOriginal } = await seedClaim();
		expect(await store.keepPending(userId, claim.id, "different people", 10)).toBe(2);

		const applied = await store.skipAsAlias({
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name),
			note: null,
			decidedAt: 11,
		});

		expect(applied).toBe(false);
		expect((await store.getEntry(userId, claim.id))?.alias_of).toBeNull();
		expect(await store.topRepeatsForUser(userId, category, 20)).toEqual([]);
		expect(await store.keepPending(userId, claim.id, null, 12)).toBe(0);
	});

	it("keepPending does nothing for another user or for a claim that is now an alias", async () => {
		const { store, userId, original, claim, toOriginal } = await seedClaim();
		expect(await store.keepPending(await seedUser("other"), claim.id, null, 10)).toBe(0);
		await store.skipAsAlias({
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name),
			note: null,
			decidedAt: 10,
		});
		expect(await store.keepPending(userId, claim.id, null, 11)).toBe(0);
	});

	it("listNearMisses joins names, alias state and via, newest first", async () => {
		const { store, userId, category, original } = await seedClaim();
		const via = makeEntry(userId, category, "Alhazen of Basra", {
			alias_of: original.id,
			created_at: 4,
		});
		const later = makeEntry(userId, category, "Father of optics", { created_at: 5 });
		for (const e of [via, later]) await store.insertEntry(e);
		await store.insertNearMisses([
			makeNearMiss(later, original, { via_entry_id: via.id, score: 0.81, created_at: 5 }),
		]);

		const rows = await store.listNearMisses(userId, 20);

		expect(rows.map((r) => [r.claim_name, r.matched_name, r.via_name])).toEqual([
			["Father of optics", "Ibn al-Haytham", "Alhazen of Basra"],
			["Alhazen", "Ibn al-Haytham", null],
			["Alhazen", "Omar Khayyam", null],
		]);
		expect(rows[0]).toMatchObject({
			category,
			claim_alias_of: null,
			match_kind: "semantic",
			score: 0.81,
			verdict: "pending",
			note: null,
		});
		expect(await store.listNearMisses(await seedUser("other"), 20)).toEqual([]);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/migrations.test.ts test/store.test.ts`
Expected: FAIL — `no such column: alias_of` / `no such table: near_misses`, and type errors are not reported by vitest (tsc runs in the gate).

- [ ] **Step 4: Write the migration**

Create `migrations/0002_near_misses.sql`:

```sql
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
```

- [ ] **Step 5: Extend the row schemas**

In `src/core/rows.ts`, add `alias_of` to `EntryRowSchema` (between `hit_count` and `created_at`) and append the near-miss schemas:

```ts
export const EntryRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	category: z.string(),
	display_name: z.string(),
	normalized: z.string(),
	vector_status: z.enum(["pending", "indexed"]),
	hit_count: z.number().int(),
	/** Null for an original topic; the original's id for an alias. */
	alias_of: z.string().nullable(),
	created_at: z.number(),
});
```

```ts
export const VerdictSchema = z.enum(["pending", "repeat", "distinct"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const NearMissRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	claim_entry_id: z.string(),
	matched_entry_id: z.string(),
	via_entry_id: z.string().nullable(),
	match_kind: MatchKind,
	score: z.number(),
	verdict: VerdictSchema,
	note: z.string().nullable(),
	created_at: z.number(),
	decided_at: z.number().nullable(),
});
export type NearMissRow = z.infer<typeof NearMissRowSchema>;
```

In `src/core/ledger.ts`, add `alias_of: null,` to the `const entry: EntryRow = { ... }` literal in `claimOnce` (after `hit_count: 0,`).

- [ ] **Step 6: Implement the store changes**

In `src/store/d1.ts`:

1. Extend the rows import with `type NearMissRow, NearMissRowSchema, VerdictSchema`.
2. Replace `ENTRY_COLUMNS` and add the near-miss columns, view schema, write type and skip guard:

```ts
const ENTRY_COLUMNS =
	"id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at";
const NEAR_MISS_COLUMNS =
	"id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, note, created_at, decided_at";
```

```ts
const NearMissViewSchema = z.object({
	id: z.string(),
	created_at: z.number(),
	claim_name: z.string(),
	claim_alias_of: z.string().nullable(),
	matched_name: z.string(),
	category: z.string(),
	via_name: z.string().nullable(),
	match_kind: MatchKind,
	score: z.number(),
	verdict: VerdictSchema,
	note: z.string().nullable(),
});
export type NearMissView = z.infer<typeof NearMissViewSchema>;

export interface SkipWrite {
	nearMissId: string;
	claimEntryId: string;
	hit: HitRow;
	note: string | null;
	decidedAt: number;
}

/**
 * True while the near miss (bound as ?1) is pending and its claim is still an original with no
 * repeat history. Every statement of a skip is guarded by it, so a verdict that loses a race on the
 * same claim changes nothing.
 */
const SKIP_OPEN = `EXISTS (
	SELECT 1 FROM near_misses n JOIN entries c ON c.id = n.claim_entry_id
	WHERE n.id = ?1 AND n.verdict = 'pending' AND c.alias_of IS NULL AND c.hit_count = 0
	  AND NOT EXISTS (SELECT 1 FROM entries a WHERE a.alias_of = c.id))`;
```

3. `insertEntry` now binds nine values:

```ts
	async insertEntry(row: EntryRow): Promise<"inserted" | "duplicate"> {
		try {
			await this.db
				.prepare(
					`INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
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
				)
				.run();
			return "inserted";
		} catch (error) {
			if (isUniqueViolation(error)) return "duplicate";
			throw error;
		}
	}
```

4. Originals only: in `listEntries` change the `WHERE` to `WHERE user_id = ?1 AND alias_of IS NULL AND (?2 IS NULL OR category = ?2) AND (?3 IS NULL OR created_at >= ?3)`; in `topRepeatsForUser` change it to `WHERE user_id = ?1 AND alias_of IS NULL AND hit_count > 0 AND (?2 IS NULL OR category = ?2)`; in `globalRepeats` change the display-name subquery's `WHERE` to `WHERE e2.category = g.category AND e2.normalized = g.normalized AND e2.alias_of IS NULL`.

5. Add these methods to `LedgerStore` (place `getEntry` and `listAliases` after `findExact`; the near-miss methods after `globalRepeats`):

```ts
	async getEntry(userId: string, entryId: string): Promise<EntryRow | null> {
		const row = await this.db
			.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ?1 AND user_id = ?2`)
			.bind(entryId, userId)
			.first();
		return row ? EntryRowSchema.parse(row) : null;
	}

	async listAliases(userId: string, originalIds: readonly string[]): Promise<EntryRow[]> {
		const rows: EntryRow[] = [];
		for (const batch of chunk(originalIds, MAX_IN_LIST)) {
			const { results } = await this.db
				.prepare(
					`SELECT ${ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND alias_of IN (${placeholders(batch.length, 2)}) ORDER BY created_at`,
				)
				.bind(userId, ...batch)
				.all();
			rows.push(...results.map((row) => EntryRowSchema.parse(row)));
		}
		return rows;
	}
```

```ts
	async insertNearMisses(rows: readonly NearMissRow[]): Promise<void> {
		if (rows.length === 0) return;
		await this.db.batch(
			rows.map((row) =>
				this.db
					.prepare(
						`INSERT INTO near_misses (${NEAR_MISS_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
					)
					.bind(
						row.id,
						row.user_id,
						row.claim_entry_id,
						row.matched_entry_id,
						row.via_entry_id,
						row.match_kind,
						row.score,
						row.verdict,
						row.note,
						row.created_at,
						row.decided_at,
					),
			),
		);
	}

	async listNearMissesForClaim(userId: string, claimEntryId: string): Promise<NearMissRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${NEAR_MISS_COLUMNS} FROM near_misses WHERE user_id = ?1 AND claim_entry_id = ?2 ORDER BY score DESC`,
			)
			.bind(userId, claimEntryId)
			.all();
		return results.map((row) => NearMissRowSchema.parse(row));
	}

	/** Applies a skip atomically; false when a concurrent verdict already decided the claim. */
	async skipAsAlias(write: SkipWrite): Promise<boolean> {
		const { hit } = write;
		const results = await this.db.batch([
			this.db
				.prepare(
					`INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at)
					 SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${SKIP_OPEN}`,
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
				),
			this.db
				.prepare(`UPDATE entries SET hit_count = hit_count + 1 WHERE id = ?2 AND ${SKIP_OPEN}`)
				.bind(write.nearMissId, hit.entry_id),
			this.db
				.prepare(
					`UPDATE near_misses SET verdict = 'repeat', note = ?2, decided_at = ?3 WHERE id = ?1 AND ${SKIP_OPEN}`,
				)
				.bind(write.nearMissId, write.note, write.decidedAt),
			this.db
				.prepare(
					`UPDATE entries SET alias_of = ?2 WHERE id = ?3 AND alias_of IS NULL
					 AND EXISTS (SELECT 1 FROM near_misses WHERE id = ?1 AND claim_entry_id = ?3 AND verdict = 'repeat')`,
				)
				.bind(write.nearMissId, hit.entry_id, write.claimEntryId),
		]);
		return (results[2]?.meta.changes ?? 0) > 0;
	}

	/** Marks a claim's pending near misses distinct; 0 when none are pending or the claim is an alias. */
	async keepPending(
		userId: string,
		claimEntryId: string,
		note: string | null,
		decidedAt: number,
	): Promise<number> {
		const result = await this.db
			.prepare(
				`UPDATE near_misses SET verdict = 'distinct', note = ?3, decided_at = ?4
				 WHERE claim_entry_id = ?1 AND user_id = ?2 AND verdict = 'pending'
				   AND EXISTS (SELECT 1 FROM entries e WHERE e.id = ?1 AND e.alias_of IS NULL)`,
			)
			.bind(claimEntryId, userId, note, decidedAt)
			.run();
		return result.meta.changes;
	}

	async listNearMisses(userId: string, limit: number): Promise<NearMissView[]> {
		const { results } = await this.db
			.prepare(
				`SELECT n.id, n.created_at, c.display_name AS claim_name, c.alias_of AS claim_alias_of,
				        m.display_name AS matched_name, m.category AS category, v.display_name AS via_name,
				        n.match_kind, n.score, n.verdict, n.note
				 FROM near_misses n
				 JOIN entries c ON c.id = n.claim_entry_id
				 JOIN entries m ON m.id = n.matched_entry_id
				 LEFT JOIN entries v ON v.id = n.via_entry_id
				 WHERE n.user_id = ?1
				 ORDER BY n.created_at DESC, n.score DESC
				 LIMIT ?2`,
			)
			.bind(userId, limit)
			.all();
		return results.map((row) => NearMissViewSchema.parse(row));
	}
```

- [ ] **Step 7: Run the gate**

Run: `npx biome check --write migrations src test && npm run check`
Expected: PASS (typecheck, lint, all tests including the new migration and store tests).

- [ ] **Step 8: Commit**

```bash
git add migrations/0002_near_misses.sql src/core/rows.ts src/store/d1.ts src/core/ledger.ts test/helpers.ts test/match.test.ts test/migrations.test.ts test/store.test.ts
git commit -F - <<'EOF'
feat: add topic aliases and near-miss storage

Migration 0002 adds entries.alias_of and the near_misses table. The store gains alias and near-miss queries, a guarded skip batch and keep update, and lists originals only.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

---

### Task 2: Alias-aware matching

**Files:**
- Modify: `src/core/match.ts`, `src/core/wire.ts`, `src/api/schemas.ts` (`Match` only), `src/core/ledger.ts`
- Test: `test/match.test.ts`, `test/ledger-claim.test.ts`

**Interfaces:**
- Consumes: `EntryRow.alias_of` (Task 1); `LedgerStore.getEntriesByIds`, `LedgerStore.insertEntry`, `LedgerStore.getEntry` (Task 1); `makeEntry` (Task 1).
- Produces:
  - `src/core/match.ts`: `ScoredMatch` gains `via?: EntryRow`; `resolveAliases(matches: readonly ScoredMatch[], entriesById: ReadonlyMap<string, EntryRow>): ScoredMatch[]`.
  - `src/api/schemas.ts`: `Match` gains `via_alias?: string`.
  - `src/core/wire.ts`: `toWireMatch` sets `via_alias` to `match.via.display_name` when `via` is present (key absent otherwise).
  - `src/core/ledger.ts`: `export const SEMANTIC_TOP_K = MAX_MATCHES * 2;` used for the semantic query; `evaluate` returns matches on originals only.

- [ ] **Step 1: Write the failing unit tests**

In `test/match.test.ts`, add `resolveAliases,` to the `../src/core/match` import, and append:

```ts
describe("resolveAliases", () => {
	const original = entry({ id: "o", normalized: "euler identity" });
	const alias = entry({ id: "a", normalized: "leonhard euler identity", alias_of: "o" });
	const orphan = entry({ id: "x", normalized: "orphan", alias_of: "missing" });
	const chained = entry({ id: "c", normalized: "chained", alias_of: "a" });
	const known = new Map([
		[original.id, original],
		[alias.id, alias],
	]);

	it("moves alias matches onto the original, keeps kind and score, and drops orphans and chains", () => {
		const out = resolveAliases(
			[
				{ entry: original, kind: "semantic", score: 0.8, confidence: "possible" },
				{ entry: alias, kind: "exact", score: 1, confidence: "repeat" },
				{ entry: orphan, kind: "trigram", score: 0.7, confidence: "repeat" },
				{ entry: chained, kind: "trigram", score: 0.7, confidence: "repeat" },
			],
			known,
		);
		expect(out).toEqual([
			{ entry: original, kind: "semantic", score: 0.8, confidence: "possible" },
			{ entry: original, kind: "exact", score: 1, confidence: "repeat", via: alias },
		]);
	});
});
```

Also append inside the existing `describe("toWireMatch", ...)` block:

```ts
	it("names the alias that matched, and omits via_alias otherwise", () => {
		const original = entry({ id: "o", normalized: "o", display_name: "Ibn al-Haytham" });
		const alias = entry({ id: "a", normalized: "a", display_name: "Alhazen", alias_of: "o" });
		const base: ScoredMatch = { entry: original, kind: "semantic", score: 0.9, confidence: "possible" };
		expect(toWireMatch({ ...base, via: alias })).toMatchObject({
			entry_id: "o",
			display_name: "Ibn al-Haytham",
			via_alias: "Alhazen",
		});
		expect(Object.hasOwn(toWireMatch(base), "via_alias")).toBe(false);
	});
```

- [ ] **Step 2: Write the failing ledger tests**

In `test/ledger-claim.test.ts`, change imports to include `MAX_MATCHES` and `makeEntry`:

```ts
import { MAX_MATCHES } from "../src/core/match";
import { makeEntry, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";
```

and append:

```ts
describe("aliases", () => {
	async function seedAlias(
		userId: string,
		category: string,
		originalId: string,
		name: string,
		semantic?: FakeSemanticIndex,
	): Promise<EntryRow> {
		const alias = makeEntry(userId, category, name, {
			alias_of: originalId,
			vector_status: "indexed",
		});
		await testStore().insertEntry(alias);
		await semantic?.upsert([{ entryId: alias.id, userId, category, text: name }]);
		return alias;
	}

	it("blocks an exact repeat of an alias as a repeat of the original, with the hit on the original", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		const alias = await seedAlias(userId, category, first.entry.id, "Alhazen");

		const result = await ledger.claim(userId, { category, name: "alhazen", force: false });

		expect(result.status).toBe("repeat");
		if (result.status !== "repeat") return;
		expect(result.matches).toMatchObject([
			{
				entry_id: first.entry.id,
				display_name: "Ibn al-Haytham",
				kind: "exact",
				via_alias: "Alhazen",
				hit_count: 1,
			},
		]);
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
		expect((await testStore().getEntry(userId, alias.id))?.hit_count).toBe(0);
	});

	it("blocks a spelling variant of an alias through trigram matching", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, {
			category,
			name: "Srinivasa Ramanujan",
			force: false,
		});
		if (first.status !== "claimed") throw new Error("expected claimed");
		await seedAlias(userId, category, first.entry.id, "The Man Who Knew Infinity");

		const result = await ledger.claim(userId, {
			category,
			name: "The Man Who Knew Infinty",
			force: false,
		});

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") {
			expect(result.matches[0]).toMatchObject({
				entry_id: first.entry.id,
				kind: "trigram",
				via_alias: "The Man Who Knew Infinity",
			});
		}
	});

	it("reports an original matched directly and through an alias once, as its strongest match", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		await seedAlias(userId, category, first.entry.id, "Alhazen", semantic);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.9);
		semantic.setSimilarity("Ibn al-Haytham", "Father of optics", 0.8);

		const result = await ledger.check(userId, { category, name: "Father of optics" });

		expect(result.likely_repeat).toBe(false);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			entry_id: first.entry.id,
			kind: "semantic",
			score: 0.9,
			via_alias: "Alhazen",
		});
	});

	it("over-fetches semantic results so one topic's aliases do not crowd out other topics", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const crowded = await ledger.claim(userId, { category, name: "Leonhard Euler", force: false });
		const other = await ledger.claim(userId, {
			category,
			name: "Carl Friedrich Gauss",
			force: false,
		});
		if (crowded.status !== "claimed" || other.status !== "claimed") {
			throw new Error("expected claimed");
		}
		for (let i = 1; i <= MAX_MATCHES; i++) {
			const name = `Euler alias ${i}`;
			await seedAlias(userId, category, crowded.entry.id, name, semantic);
			semantic.setSimilarity(name, "Prince of mathematicians", 0.95);
		}
		semantic.setSimilarity("Carl Friedrich Gauss", "Prince of mathematicians", 0.8);

		const result = await ledger.check(userId, { category, name: "Prince of mathematicians" });

		expect(result.matches.map((match) => match.entry_id)).toEqual([
			crowded.entry.id,
			other.entry.id,
		]);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/match.test.ts test/ledger-claim.test.ts`
Expected: FAIL — `resolveAliases` is not exported; alias matches come back on the alias entry without `via_alias`; the crowding test returns only the Euler alias.

- [ ] **Step 4: Implement alias resolution in the match core**

In `src/core/match.ts`, replace the `ScoredMatch` interface and add `resolveAliases` after `classifySemanticHits`:

```ts
export interface ScoredMatch {
	entry: EntryRow;
	kind: MatchKind;
	score: number;
	confidence: Confidence;
	/** The alias whose text actually matched, when `entry` was reached through one. */
	via?: EntryRow;
}
```

```ts
/**
 * Replaces each match on an alias with the same match on its original, keeping the alias as `via`,
 * so hits, verdicts and near misses always reference originals. Matches whose original is missing
 * from `entriesById` (or is itself an alias) are dropped.
 */
export function resolveAliases(
	matches: readonly ScoredMatch[],
	entriesById: ReadonlyMap<string, EntryRow>,
): ScoredMatch[] {
	const out: ScoredMatch[] = [];
	for (const match of matches) {
		if (match.entry.alias_of === null) {
			out.push(match);
			continue;
		}
		const original = entriesById.get(match.entry.alias_of);
		if (original && original.alias_of === null) {
			out.push({ ...match, entry: original, via: match.entry });
		}
	}
	return out;
}
```

In `src/api/schemas.ts`, add to the `Match` object (after `hit_count`):

```ts
	via_alias: z.string().optional(),
```

In `src/core/wire.ts`, replace `toWireMatch`:

```ts
export function toWireMatch(match: ScoredMatch, hitCountBonus = 0): Match {
	const wire: Match = {
		entry_id: match.entry.id,
		display_name: match.entry.display_name,
		category: match.entry.category,
		kind: match.kind,
		score: match.score,
		confidence: match.confidence,
		first_seen: toIso(match.entry.created_at),
		hit_count: match.entry.hit_count + hitCountBonus,
	};
	return match.via ? { ...wire, via_alias: match.via.display_name } : wire;
}
```

- [ ] **Step 5: Resolve aliases in the ledger**

In `src/core/ledger.ts`:

1. Add `resolveAliases,` to the `./match` import.
2. After `export const BACKFILL_BATCH = 100;` add:

```ts
/** One topic's aliases can fill the semantic results; over-fetch before resolving and ranking. */
export const SEMANTIC_TOP_K = MAX_MATCHES * 2;
```

3. Replace the tail of `evaluate` (from `const semantic = ...` to the end of the method):

```ts
		const semantic = await this.semanticMatches(userId, category, name, candidates);
		const resolved = await this.withOriginals(
			userId,
			category,
			[...lexical, ...semantic.matches],
			candidates,
		);
		return {
			normalized,
			matches: rankMatches(resolved),
			semantic: semantic.status,
		};
	}

	private async withOriginals(
		userId: string,
		category: string,
		matches: readonly ScoredMatch[],
		candidates: readonly EntryRow[],
	): Promise<ScoredMatch[]> {
		const byId = new Map(candidates.map((entry) => [entry.id, entry]));
		const missing = new Set<string>();
		for (const match of matches) {
			const originalId = match.entry.alias_of;
			if (originalId !== null && !byId.has(originalId)) missing.add(originalId);
		}
		for (const row of await this.deps.store.getEntriesByIds(userId, category, [...missing])) {
			byId.set(row.id, row);
		}
		return resolveAliases(matches, byId);
	}
```

4. In `semanticMatches`, change `topK: MAX_MATCHES` to `topK: SEMANTIC_TOP_K`.

- [ ] **Step 6: Run the gate**

Run: `npx biome check --write src test && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/match.ts src/core/wire.ts src/api/schemas.ts src/core/ledger.ts test/match.test.ts test/ledger-claim.test.ts
git commit -F - <<'EOF'
feat: resolve matched aliases to their original topic

Exact, trigram and semantic matches on an alias now report (and record hits on) the original, naming the alias in via_alias. Semantic queries over-fetch so aliases of one topic cannot crowd out others.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

---

### Task 3: `possible_repeat` claims record near misses

**Files:**
- Modify: `src/api/schemas.ts` (`ClaimResult`), `src/core/ledger.ts` (`claimOnce`)
- Test: `test/ledger-claim.test.ts`, `test/schemas.test.ts`

**Interfaces:**
- Consumes: `LedgerStore.insertNearMisses`, `LedgerStore.listNearMissesForClaim`, `NearMissRow` (Task 1); `ScoredMatch.via` (Task 2); `seedAlias` in `test/ledger-claim.test.ts` (Task 2).
- Produces:
  - `ClaimResult` = `{ status: "claimed"; entry; forced; overridden_matches: Match[]; semantic }` | `{ status: "possible_repeat"; entry; possible_matches: Match[]; next_step: string; semantic }` | `{ status: "repeat"; matches; semantic }`.
  - `src/core/ledger.ts`: `export const NEXT_STEP`, `export const FORCED_NOTE = "forced"`.
  - Claim writes one near-miss row per non-blocking match: `pending` (not forced) or `distinct` with note `forced` and `decided_at = created_at` (forced).

- [ ] **Step 1: Update and add failing tests**

In `test/schemas.test.ts`, replace the body of `describe("ClaimResult", ...)` with:

```ts
	it("parses all three variants", () => {
		const entry = {
			id: "e1",
			category: "math",
			display_name: "Euler",
			created_at: "2026-09-14T00:00:00.000Z",
			hit_count: 0,
		};
		expect(
			ClaimResult.parse({
				status: "claimed",
				entry,
				forced: false,
				overridden_matches: [],
				semantic: "ok",
			}).status,
		).toBe("claimed");
		expect(
			ClaimResult.parse({
				status: "possible_repeat",
				entry,
				possible_matches: [],
				next_step: "decide",
				semantic: "ok",
			}).status,
		).toBe("possible_repeat");
		expect(
			ClaimResult.parse({ status: "repeat", matches: [], semantic: "unavailable" }).status,
		).toBe("repeat");
		expect(
			ClaimResult.safeParse({
				status: "claimed",
				entry,
				forced: false,
				possible_matches: [],
				semantic: "ok",
			}).success,
		).toBe(false);
	});
```

In `test/ledger-claim.test.ts`:

1. Add `FORCED_NOTE, NEXT_STEP` to imports: `import { FORCED_NOTE, Ledger, NEXT_STEP } from "../src/core/ledger";`.
2. In "claims a new topic and indexes it", replace the `toMatchObject` line with:

```ts
		expect(result).toMatchObject({ forced: false, overridden_matches: [], semantic: "ok" });
		expect(await testStore().listNearMissesForClaim(userId, result.entry.id)).toEqual([]);
```

3. Replace the test "treats a strong semantic match as advisory under the default thresholds, without a hit" with:

```ts
	it("returns possible_repeat for a strong semantic match, records a pending near miss, and no hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.95);
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "e^(iπ)+1=0", force: false });

		expect(result.status).toBe("possible_repeat");
		if (result.status !== "possible_repeat") return;
		expect(result.next_step).toBe(NEXT_STEP);
		expect(result.possible_matches).toMatchObject([
			{ entry_id: first.entry.id, kind: "semantic", confidence: "possible", score: 0.95 },
		]);
		expect(await testStore().listNearMissesForClaim(userId, result.entry.id)).toMatchObject([
			{
				user_id: userId,
				claim_entry_id: result.entry.id,
				matched_entry_id: first.entry.id,
				via_entry_id: null,
				match_kind: "semantic",
				score: 0.95,
				verdict: "pending",
				note: null,
				decided_at: null,
			},
		]);
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});
```

4. In "claims but reports possible matches between the two semantic thresholds, without a hit", rename it to `"returns possible_repeat between the two semantic thresholds, without a hit"` and replace its `expect(result.status)...` block with:

```ts
		expect(result.status).toBe("possible_repeat");
		if (result.status === "possible_repeat") {
			expect(result.possible_matches).toMatchObject([
				{ entry_id: first.entry.id, confidence: "possible" },
			]);
		}
```

5. In "force overrides a configured semantic repeat, returns the overridden matches, and records no hit", replace the `if (result.status === "claimed") { ... }` block with:

```ts
		if (result.status === "claimed") {
			expect(result.forced).toBe(true);
			expect(result.overridden_matches).toMatchObject([
				{ entry_id: first.entry.id, confidence: "repeat" },
			]);
			const [row] = await testStore().listNearMissesForClaim(userId, result.entry.id);
			expect(row).toMatchObject({
				matched_entry_id: first.entry.id,
				verdict: "distinct",
				note: FORCED_NOTE,
			});
			expect(row?.decided_at).toBe(row?.created_at);
		}
```

6. Append inside `describe("aliases", ...)`:

```ts
	it("records the alias a possible match came through", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		const alias = await seedAlias(userId, category, first.entry.id, "Alhazen", semantic);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);

		const result = await ledger.claim(userId, { category, name: "Father of optics", force: false });

		expect(result.status).toBe("possible_repeat");
		if (result.status !== "possible_repeat") return;
		expect(result.possible_matches).toMatchObject([
			{ entry_id: first.entry.id, via_alias: "Alhazen" },
		]);
		expect(await testStore().listNearMissesForClaim(userId, result.entry.id)).toMatchObject([
			{ matched_entry_id: first.entry.id, via_entry_id: alias.id, verdict: "pending" },
		]);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ledger-claim.test.ts test/schemas.test.ts`
Expected: FAIL — status is still `claimed`, `overridden_matches` is undefined, no near-miss rows.

- [ ] **Step 3: Change the claim result schema**

In `src/api/schemas.ts`, replace `ClaimResult`:

```ts
export const ClaimResult = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("claimed"),
		entry: Entry,
		forced: z.boolean(),
		/** Matches a forced claim overrode; empty unless forced. */
		overridden_matches: z.array(Match),
		semantic: SemanticStatus,
	}),
	z.object({
		status: z.literal("possible_repeat"),
		entry: Entry,
		possible_matches: z.array(Match),
		next_step: z.string(),
		semantic: SemanticStatus,
	}),
	z.object({
		status: z.literal("repeat"),
		matches: z.array(Match),
		semantic: SemanticStatus,
	}),
]);
```

`z.object` strips unknown keys by default, so the negative case in the schema test fails because `overridden_matches` is missing, not because of the extra key.

- [ ] **Step 4: Record near misses in `claimOnce`**

In `src/core/ledger.ts`:

1. Change the rows import to `import type { EntryRow, NearMissRow } from "./rows";`.
2. After `SEMANTIC_TOP_K`, add:

```ts
/** Sent with every possible_repeat so an LLM caller knows a verdict is expected. */
export const NEXT_STEP =
	"Decide whether this topic is the same as any possible match. If it is, call skip_topic with repeat_of set to that match's entry_id and choose a different topic. Otherwise call keep_topic.";
/** Note stored on near misses a forced claim overrode: the caller already decided they differ. */
export const FORCED_NOTE = "forced";
```

3. In `claimOnce`, directly after the `if ((await store.insertEntry(entry)) === "duplicate") { ... }` block and before `let semanticStatus = evaluation.semantic;`, insert:

```ts
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
```

4. Replace the method's final block (from the old `const forced = best !== undefined;` through the final `return { status: "claimed", ... };`) with:

```ts
		const matches = nonBlocking.map((match) => toWireMatch(match));
		if (!forced && matches.length > 0) {
			return {
				status: "possible_repeat",
				entry: toWireEntry(entry),
				possible_matches: matches,
				next_step: NEXT_STEP,
				semantic: semanticStatus,
			};
		}
		return {
			status: "claimed",
			entry: toWireEntry(entry),
			forced,
			overridden_matches: matches,
			semantic: semanticStatus,
		};
```

- [ ] **Step 5: Run the gate**

Run: `npx biome check --write src test && npm run check`
Expected: PASS. (`test/mcp.test.ts`, `test/rest.test.ts` and `test/dashboard.test.ts` only claim topics with no matches, so they still see `claimed`.)

- [ ] **Step 6: Commit**

```bash
git add src/api/schemas.ts src/core/ledger.ts test/ledger-claim.test.ts test/schemas.test.ts
git commit -F - <<'EOF'
feat: ask for a verdict when a claim has possible matches

A claim with possible matches now returns possible_repeat with a next_step and records a pending near miss per match; forced claims record their overridden matches as distinct. claimed carries overridden_matches instead of possible_matches.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

---

### Task 4: Skip, keep and alias-aware forget

**Files:**
- Modify: `src/api/schemas.ts`, `src/core/ledger.ts`
- Create: `test/ledger-verdicts.test.ts`
- Test: `test/ledger-admin.test.ts`, `test/schemas.test.ts`

**Interfaces:**
- Consumes: `LedgerStore.getEntry`, `listAliases`, `listNearMissesForClaim`, `skipAsAlias`, `keepPending`, `listNearMisses` (Task 1); `toWireMatch` with `via` (Task 2); `possible_repeat` claims (Task 3).
- Produces:
  - `src/api/schemas.ts`: `SkipBody = { repeat_of: string; note?: string }`, `SkipInput = SkipBody & { entry_id: string }`, `SkipResult = { skipped: string; alias_of: Match }`, `KeepBody = { note?: string }`, `KeepInput = KeepBody & { entry_id: string }`, `KeepResult = { kept: string; distinct: number }` (schemas and same-named types).
  - `Ledger.skip(userId: string, input: SkipInput): Promise<SkipResult>`
  - `Ledger.keep(userId: string, input: KeepInput): Promise<KeepResult>`
  - `Ledger.forget` also removes the entry's aliases' vectors.

- [ ] **Step 1: Write the failing schema test**

In `test/schemas.test.ts`, extend the import with `KeepInput, SkipInput` and append:

```ts
describe("verdict inputs", () => {
	it("trims notes, bounds them to 1-500 characters, and requires repeat_of for skip", () => {
		expect(KeepInput.parse({ entry_id: "e1", note: "  different people " })).toEqual({
			entry_id: "e1",
			note: "different people",
		});
		expect(KeepInput.parse({ entry_id: "e1" })).toEqual({ entry_id: "e1" });
		expect(KeepInput.safeParse({ entry_id: "e1", note: "   " }).success).toBe(false);
		expect(
			SkipInput.safeParse({ entry_id: "e1", repeat_of: "e2", note: "x".repeat(501) }).success,
		).toBe(false);
		expect(SkipInput.safeParse({ entry_id: "e1" }).success).toBe(false);
		expect(SkipInput.safeParse({ entry_id: "", repeat_of: "e2" }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Write the failing verdict tests**

Create `test/ledger-verdicts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Ledger } from "../src/core/ledger";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeEntry, makeHit, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

interface Flagged {
	ledger: Ledger;
	semantic: FakeSemanticIndex;
	userId: string;
	category: string;
	haythamId: string;
	khayyamId: string;
	claimId: string;
}

/** Ibn al-Haytham and Omar Khayyam are claimed; the claim "Alhazen" then resembles both. */
async function flaggedClaim(): Promise<Flagged> {
	const semantic = new FakeSemanticIndex();
	const ledger = makeTestLedger({ semantic });
	const userId = await seedUser();
	const category = uniqueCategory();
	const haytham = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
	const khayyam = await ledger.claim(userId, { category, name: "Omar Khayyam", force: false });
	if (haytham.status !== "claimed" || khayyam.status !== "claimed") {
		throw new Error("expected claimed");
	}
	semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
	semantic.setSimilarity("Omar Khayyam", "Alhazen", 0.79);
	const claim = await ledger.claim(userId, { category, name: "Alhazen", force: false });
	if (claim.status !== "possible_repeat") throw new Error("expected possible_repeat");
	return {
		ledger,
		semantic,
		userId,
		category,
		haythamId: haytham.entry.id,
		khayyamId: khayyam.entry.id,
		claimId: claim.entry.id,
	};
}

describe("Ledger.skip", () => {
	it("aliases the claim to the original, records the hit, and leaves the other near miss pending", async () => {
		const f = await flaggedClaim();

		const result = await f.ledger.skip(f.userId, {
			entry_id: f.claimId,
			repeat_of: f.haythamId,
			note: "same person",
		});

		expect(result).toMatchObject({
			skipped: f.claimId,
			alias_of: {
				entry_id: f.haythamId,
				display_name: "Ibn al-Haytham",
				kind: "semantic",
				score: 0.9,
				confidence: "possible",
				hit_count: 1,
			},
		});
		const store = testStore();
		expect((await store.getEntry(f.userId, f.claimId))?.alias_of).toBe(f.haythamId);
		expect(f.semantic.documents.has(f.claimId)).toBe(true);
		const rows = await store.listNearMissesForClaim(f.userId, f.claimId);
		expect(rows.map((row) => [row.matched_entry_id, row.verdict, row.note])).toEqual([
			[f.haythamId, "repeat", "same person"],
			[f.khayyamId, "pending", null],
		]);
		const stats = await f.ledger.stats(
			f.userId,
			{ scope: "me", category: f.category, limit: 20 },
			2,
		);
		expect(stats.repeats).toEqual([
			{
				display_name: "Ibn al-Haytham",
				category: f.category,
				hit_count: 1,
				recent_phrasings: ["Alhazen"],
			},
		]);
		const listed = await f.ledger.list(f.userId, { category: f.category, limit: 20 });
		expect(listed.entries.map((entry) => entry.id).sort()).toEqual(
			[f.haythamId, f.khayyamId].sort(),
		);
	});

	it("turns the skipped phrasing into an exact repeat of the original", async () => {
		const f = await flaggedClaim();
		await f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId });

		const again = await f.ledger.claim(f.userId, {
			category: f.category,
			name: "ALHAZEN",
			force: false,
		});

		expect(again.status).toBe("repeat");
		if (again.status === "repeat") {
			expect(again.matches[0]).toMatchObject({
				entry_id: f.haythamId,
				kind: "exact",
				via_alias: "Alhazen",
				hit_count: 2,
			});
		}
	});

	it("rejects another user's entry, a repeat_of that is not a pending match, and a second verdict", async () => {
		const f = await flaggedClaim();
		const stranger = await seedUser("stranger");

		await expect(
			f.ledger.skip(stranger, { entry_id: f.claimId, repeat_of: f.haythamId }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.claimId }),
		).rejects.toMatchObject({ code: "invalid_input" });

		await f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId });

		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.khayyamId }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(f.ledger.keep(f.userId, { entry_id: f.claimId })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect((await testStore().getEntry(f.userId, f.khayyamId))?.hit_count).toBe(0);
	});

	it("rejects an entry with no pending near misses, and skip after keep", async () => {
		const f = await flaggedClaim();
		await expect(
			f.ledger.skip(f.userId, { entry_id: f.haythamId, repeat_of: f.khayyamId }),
		).rejects.toMatchObject({ code: "invalid_input" });

		await f.ledger.keep(f.userId, { entry_id: f.claimId });

		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId }),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("rejects an entry that already has hits or aliases of its own", async () => {
		const store = testStore();
		const withHit = await flaggedClaim();
		const claimRow = await store.getEntry(withHit.userId, withHit.claimId);
		if (!claimRow) throw new Error("expected the claim entry");
		await store.recordHit(makeHit(claimRow, "Alhazen"));
		await expect(
			withHit.ledger.skip(withHit.userId, {
				entry_id: withHit.claimId,
				repeat_of: withHit.haythamId,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		const withAlias = await flaggedClaim();
		await store.insertEntry(
			makeEntry(withAlias.userId, withAlias.category, "Al-Hasan ibn al-Haytham", {
				alias_of: withAlias.claimId,
			}),
		);
		await expect(
			withAlias.ledger.skip(withAlias.userId, {
				entry_id: withAlias.claimId,
				repeat_of: withAlias.haythamId,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("records exactly one hit when two skips race", async () => {
		const f = await flaggedClaim();

		const outcomes = await Promise.allSettled([
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId }),
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.khayyamId }),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
			code: "invalid_input",
		});
		const store = testStore();
		const haytham = await store.getEntry(f.userId, f.haythamId);
		const khayyam = await store.getEntry(f.userId, f.khayyamId);
		expect((haytham?.hit_count ?? 0) + (khayyam?.hit_count ?? 0)).toBe(1);
	});
});

describe("Ledger.keep", () => {
	it("marks every pending near miss distinct with the note and keeps the topic", async () => {
		const f = await flaggedClaim();

		expect(
			await f.ledger.keep(f.userId, { entry_id: f.claimId, note: "different people" }),
		).toEqual({ kept: f.claimId, distinct: 2 });

		const rows = await testStore().listNearMissesForClaim(f.userId, f.claimId);
		expect(rows.map((row) => [row.verdict, row.note])).toEqual([
			["distinct", "different people"],
			["distinct", "different people"],
		]);
		expect(rows.every((row) => row.decided_at !== null)).toBe(true);
		expect(
			(await f.ledger.list(f.userId, { category: f.category, limit: 20 })).entries,
		).toHaveLength(3);
		await expect(f.ledger.keep(f.userId, { entry_id: f.claimId })).rejects.toMatchObject({
			code: "invalid_input",
		});
	});

	it("rejects unknown and foreign entries", async () => {
		const f = await flaggedClaim();
		await expect(
			f.ledger.keep(f.userId, { entry_id: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			f.ledger.keep(await seedUser("stranger"), { entry_id: f.claimId }),
		).rejects.toMatchObject({ code: "not_found" });
	});
});
```

Append inside `describe("Ledger.forget", ...)` in `test/ledger-admin.test.ts` (it already imports `FakeSemanticIndex`, `makeTestLedger`, `seedUser`, `testStore`, `uniqueCategory` and defines `claimed()`):

```ts
	it("forgetting an original removes its aliases, their vectors and near misses", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const originalId = await claimed(ledger, userId, category, "Ibn al-Haytham");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const flagged = await ledger.claim(userId, { category, name: "Alhazen", force: false });
		if (flagged.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: flagged.entry.id, repeat_of: originalId });

		await ledger.forget(userId, originalId);

		expect(await testStore().getEntry(userId, flagged.entry.id)).toBeNull();
		expect(semantic.documents.has(flagged.entry.id)).toBe(false);
		expect(await testStore().listNearMisses(userId, 20)).toEqual([]);
	});

	it("forgetting an alias keeps the hit it recorded on the original", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const originalId = await claimed(ledger, userId, category, "Ibn al-Haytham");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const flagged = await ledger.claim(userId, { category, name: "Alhazen", force: false });
		if (flagged.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: flagged.entry.id, repeat_of: originalId });

		await ledger.forget(userId, flagged.entry.id);

		const stats = await ledger.stats(userId, { scope: "me", category, limit: 20 }, 2);
		expect(stats.repeats).toMatchObject([{ display_name: "Ibn al-Haytham", hit_count: 1 }]);
		expect(semantic.documents.has(flagged.entry.id)).toBe(false);
		expect(await testStore().getEntry(userId, originalId)).not.toBeNull();
	});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/ledger-verdicts.test.ts test/ledger-admin.test.ts test/schemas.test.ts`
Expected: FAIL — `ledger.skip is not a function`, `KeepInput` is undefined, the alias vector survives forget.

- [ ] **Step 4: Add the verdict schemas**

In `src/api/schemas.ts`, directly after the `ForgetInput` type export, add:

```ts
const EntryId = z.string().min(1);
const Note = z.string().trim().min(1).max(500);

export const SkipBody = z.object({ repeat_of: EntryId, note: Note.optional() });
export type SkipBody = z.infer<typeof SkipBody>;

export const SkipInput = SkipBody.extend({ entry_id: EntryId });
export type SkipInput = z.infer<typeof SkipInput>;

export const SkipResult = z.object({ skipped: z.string(), alias_of: Match });
export type SkipResult = z.infer<typeof SkipResult>;

export const KeepBody = z.object({ note: Note.optional() });
export type KeepBody = z.infer<typeof KeepBody>;

export const KeepInput = KeepBody.extend({ entry_id: EntryId });
export type KeepInput = z.infer<typeof KeepInput>;

export const KeepResult = z.object({ kept: z.string(), distinct: z.number().int() });
export type KeepResult = z.infer<typeof KeepResult>;
```

- [ ] **Step 5: Implement skip, keep and alias-aware forget**

In `src/core/ledger.ts`:

1. Add `KeepInput, KeepResult, SkipInput, SkipResult,` to the type import from `../api/schemas`.
2. Replace `forget`:

```ts
	async forget(userId: string, entryId: string): Promise<void> {
		const { store, semantic } = this.deps;
		// Aliases cascade with the entry in D1; collect their ids first so their vectors go too.
		const aliasIds = (await store.listAliases(userId, [entryId])).map((alias) => alias.id);
		if (!(await store.deleteEntry(userId, entryId))) {
			throw new LedgerError("not_found", `no entry ${entryId}`);
		}
		try {
			await semantic.remove([entryId, ...aliasIds]);
		} catch (error) {
			// Orphaned vectors are harmless: semantic hits are joined against D1.
			console.warn("vector delete failed", { entryId, error: String(error) });
		}
	}
```

3. Add after `forget`:

```ts
	async skip(userId: string, input: SkipInput): Promise<SkipResult> {
		const { store, now, newId } = this.deps;
		const entry = await this.requireEntry(userId, input.entry_id);
		if (entry.alias_of !== null) {
			throw new LedgerError("invalid_input", `entry ${entry.id} is already an alias`);
		}
		if (entry.hit_count > 0 || (await store.listAliases(userId, [entry.id])).length > 0) {
			throw new LedgerError("invalid_input", `entry ${entry.id} already has repeat history`);
		}
		const pending = (await store.listNearMissesForClaim(userId, entry.id)).filter(
			(row) => row.verdict === "pending",
		);
		if (pending.length === 0) {
			throw new LedgerError("invalid_input", `entry ${entry.id} has no pending possible matches`);
		}
		const row = pending.find((candidate) => candidate.matched_entry_id === input.repeat_of);
		if (!row) {
			throw new LedgerError(
				"invalid_input",
				`${input.repeat_of} is not a pending possible match of entry ${entry.id}`,
			);
		}
		const decidedAt = now();
		const applied = await store.skipAsAlias({
			nearMissId: row.id,
			claimEntryId: entry.id,
			hit: {
				id: newId(),
				entry_id: row.matched_entry_id,
				user_id: userId,
				candidate_text: entry.display_name,
				candidate_normalized: entry.normalized,
				match_kind: row.match_kind,
				score: row.score,
				created_at: decidedAt,
			},
			note: input.note ?? null,
			decidedAt,
		});
		if (!applied) {
			throw new LedgerError("invalid_input", `entry ${entry.id} was already decided`);
		}
		const original = await this.requireEntry(userId, row.matched_entry_id);
		const via = row.via_entry_id ? await store.getEntry(userId, row.via_entry_id) : null;
		// Pending near misses only ever come from possible-confidence matches.
		const match: ScoredMatch = {
			entry: original,
			kind: row.match_kind,
			score: row.score,
			confidence: "possible",
		};
		if (via) match.via = via;
		return { skipped: entry.id, alias_of: toWireMatch(match) };
	}

	async keep(userId: string, input: KeepInput): Promise<KeepResult> {
		const entry = await this.requireEntry(userId, input.entry_id);
		if (entry.alias_of !== null) {
			throw new LedgerError("invalid_input", `entry ${entry.id} is already an alias`);
		}
		const distinct = await this.deps.store.keepPending(
			userId,
			entry.id,
			input.note ?? null,
			this.deps.now(),
		);
		if (distinct === 0) {
			throw new LedgerError("invalid_input", `entry ${entry.id} has no pending possible matches`);
		}
		return { kept: entry.id, distinct };
	}

	private async requireEntry(userId: string, entryId: string): Promise<EntryRow> {
		const entry = await this.deps.store.getEntry(userId, entryId);
		if (!entry) throw new LedgerError("not_found", `no entry ${entryId}`);
		return entry;
	}
```

(`requireEntry` may sit with the other private methods at the end of the class instead.)

- [ ] **Step 6: Run the gate**

Run: `npx biome check --write src test && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/schemas.ts src/core/ledger.ts test/ledger-verdicts.test.ts test/ledger-admin.test.ts test/schemas.test.ts
git commit -F - <<'EOF'
feat: add skip and keep verdicts, and forget aliases with their original

skip turns a flagged claim into an alias of the matched original and records a hit in one guarded batch; keep marks the claim's near misses distinct. Verdicts are final, and forget removes an original's alias vectors too.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

---

### Task 5: REST and MCP transports

**Files:**
- Modify: `src/api/rest.ts`, `src/api/mcp.ts`, `src/api/schemas.ts` (remove `ForgetInput`, `ForgetResult`), `README.md`
- Test: `test/rest.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `SkipBody`, `SkipInput`, `SkipResult`, `KeepBody`, `KeepInput`, `KeepResult`, `Ledger.skip`, `Ledger.keep` (Task 4); `makeEntry`, `makeNearMiss`, `LedgerStore.insertNearMisses` (Task 1).
- Produces:
  - REST: `POST /api/v1/entries/:id/skip` body `{repeat_of, note?}` → 200 `SkipResult`; `POST /api/v1/entries/:id/keep` body `{note?}` → 200 `KeepResult`. `DELETE /api/v1/entries/:id` unchanged.
  - MCP tools, exactly: `claim_topic`, `check_topic`, `list_topics`, `skip_topic`, `keep_topic`, `topic_stats`.

- [ ] **Step 1: Write the failing REST tests**

In `test/rest.test.ts`, extend imports:

```ts
import {
	CheckResult,
	ClaimResult,
	ErrorBody,
	KeepResult,
	ListResult,
	SkipResult,
	StatsResult,
} from "../src/api/schemas";
import { FakeSemanticIndex } from "./fakes/semantic";
```

and append:

```ts
describe("verdicts", () => {
	async function claim(ctx: ApiContext, category: string, name: string) {
		return ClaimResult.parse(await (await post("/api/v1/claims", { category, name }, ctx)).json());
	}

	it("skips one possible repeat and keeps another", async () => {
		const semantic = new FakeSemanticIndex();
		const ctx = await context({ ledger: makeTestLedger({ semantic }) });
		const category = uniqueCategory();
		const original = await claim(ctx, category, "Ibn al-Haytham");
		if (original.status !== "claimed") throw new Error("expected claimed");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		semantic.setSimilarity("Ibn al-Haytham", "Omar Khayyam", 0.81);

		const alhazen = await claim(ctx, category, "Alhazen");
		if (alhazen.status !== "possible_repeat") throw new Error("expected possible_repeat");
		const skipped = await post(
			`/api/v1/entries/${alhazen.entry.id}/skip`,
			{ repeat_of: original.entry.id, note: "same person" },
			ctx,
		);
		expect(skipped.status).toBe(200);
		expect(SkipResult.parse(await skipped.json())).toMatchObject({
			skipped: alhazen.entry.id,
			alias_of: { entry_id: original.entry.id, hit_count: 1 },
		});

		const khayyam = await claim(ctx, category, "Omar Khayyam");
		if (khayyam.status !== "possible_repeat") throw new Error("expected possible_repeat");
		const kept = await post(
			`/api/v1/entries/${khayyam.entry.id}/keep`,
			{ note: "different people" },
			ctx,
		);
		expect(kept.status).toBe(200);
		expect(KeepResult.parse(await kept.json())).toEqual({ kept: khayyam.entry.id, distinct: 1 });
	});

	it("validates bodies and maps verdict errors", async () => {
		const ctx = await context();

		const missing = await post(
			`/api/v1/entries/${crypto.randomUUID()}/skip`,
			{ note: "no repeat_of" },
			ctx,
		);
		expect(missing.status).toBe(400);
		expect(ErrorBody.parse(await missing.json()).error.code).toBe("invalid_input");

		const blankNote = await post(`/api/v1/entries/${crypto.randomUUID()}/keep`, { note: " " }, ctx);
		expect(blankNote.status).toBe(400);

		const unknown = await post(`/api/v1/entries/${crypto.randomUUID()}/keep`, {}, ctx);
		expect(unknown.status).toBe(404);
		expect(ErrorBody.parse(await unknown.json()).error.code).toBe("not_found");

		const plain = await claim(ctx, uniqueCategory(), "Hilbert");
		if (plain.status !== "claimed") throw new Error("expected claimed");
		const nothingPending = await post(`/api/v1/entries/${plain.entry.id}/keep`, {}, ctx);
		expect(nothingPending.status).toBe(400);
		expect(ErrorBody.parse(await nothingPending.json()).error.code).toBe("invalid_input");
	});
});
```

- [ ] **Step 2: Write the failing MCP tests**

In `test/mcp.test.ts`:

1. Extend imports:

```ts
import {
	CheckResult,
	ClaimResult,
	ErrorBody,
	KeepResult,
	ListResult,
	SkipResult,
	StatsResult,
} from "../src/api/schemas";
import {
	createTestToken,
	issueOAuthTokens,
	makeEntry,
	makeNearMiss,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";
```

2. Replace the test "lists the five ledger tools" with:

```ts
	it("lists the six ledger tools", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"check_topic",
			"claim_topic",
			"keep_topic",
			"list_topics",
			"skip_topic",
			"topic_stats",
		]);
	});
```

3. In "returns a typed tool error for an unknown entry", replace the call with `const result = await call(client, "keep_topic", { entry_id: crypto.randomUUID() });`.
4. In "accepts OAuth access tokens", change `toHaveLength(5)` to `toHaveLength(6)`.
5. Append inside `describe("MCP endpoint", ...)`:

```ts
	it("skips and keeps flagged claims, and the skipped phrasing then repeats exactly", async () => {
		const userId = await seedUser();
		const client = await connect(await createTestToken(userId));
		const category = uniqueCategory();
		const store = testStore();
		// The test Worker has no semantic binding, so flagged claims are seeded directly.
		const original = makeEntry(userId, category, "Ibn al-Haytham");
		const alhazen = makeEntry(userId, category, "Alhazen");
		const khayyam = makeEntry(userId, category, "Omar Khayyam");
		for (const entry of [original, alhazen, khayyam]) await store.insertEntry(entry);
		await store.insertNearMisses([
			makeNearMiss(alhazen, original, { score: 0.9 }),
			makeNearMiss(khayyam, original, { score: 0.81 }),
		]);

		const skipped = await call(client, "skip_topic", {
			entry_id: alhazen.id,
			repeat_of: original.id,
			note: "same person",
		});
		expect(SkipResult.parse(skipped.structuredContent)).toMatchObject({
			skipped: alhazen.id,
			alias_of: { entry_id: original.id, hit_count: 1 },
		});

		const kept = await call(client, "keep_topic", { entry_id: khayyam.id });
		expect(KeepResult.parse(kept.structuredContent)).toEqual({ kept: khayyam.id, distinct: 1 });

		const repeat = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "alhazen" })).structuredContent,
		);
		expect(repeat).toMatchObject({
			status: "repeat",
			matches: [{ entry_id: original.id, via_alias: "Alhazen" }],
		});
	});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/rest.test.ts test/mcp.test.ts`
Expected: FAIL — skip/keep routes return 404, the tool list still contains `forget_topic`.

- [ ] **Step 4: Add the REST routes**

In `src/api/rest.ts`, replace the schemas import with:

```ts
import {
	CheckInput,
	ClaimInput,
	KeepBody,
	type KeepInput,
	ListInput,
	SkipBody,
	type SkipInput,
	StatsInput,
} from "./schemas";
```

and add after the `app.get("/entries", ...)` route:

```ts
	app.post("/entries/:id/skip", async (c) => {
		const body = parseInput(SkipBody, await readJson(c.req.raw));
		const input: SkipInput = { ...body, entry_id: c.req.param("id") };
		return c.json(await c.env.ledger.skip(c.env.userId, input));
	});

	app.post("/entries/:id/keep", async (c) => {
		const body = parseInput(KeepBody, await readJson(c.req.raw));
		const input: KeepInput = { ...body, entry_id: c.req.param("id") };
		return c.json(await c.env.ledger.keep(c.env.userId, input));
	});
```

- [ ] **Step 5: Replace `forget_topic` with `skip_topic` and `keep_topic`**

In `src/api/schemas.ts`, delete `ForgetInput` (and its type) and `ForgetResult` (and its type).

In `src/api/mcp.ts`:

1. Replace the schemas import with:

```ts
import {
	CheckInput,
	ClaimInput,
	KeepInput,
	ListToolInput,
	SkipInput,
	StatsToolInput,
} from "./schemas";
```

2. Replace `MCP_TOOL_NAMES`:

```ts
export const MCP_TOOL_NAMES = [
	"claim_topic",
	"check_topic",
	"list_topics",
	"skip_topic",
	"keep_topic",
	"topic_stats",
] as const;
```

3. Replace the `claim_topic` description string with:

```ts
				description:
					"Record a topic for this category unless it repeats one already used. " +
					'Returns status "claimed", "possible_repeat" or "repeat". On "repeat", pick a different topic and call again. ' +
					'On "possible_repeat" the topic is recorded but resembles earlier topics: follow next_step and call ' +
					"skip_topic (same topic) or keep_topic (different topic). force=true overrides fuzzy (not exact) matches.",
```

4. Replace the whole `server.registerTool("forget_topic", ...)` call with:

```ts
	server.registerTool(
		"skip_topic",
		{
			title: "Skip a repeated topic",
			description:
				'Use after claim_topic returned "possible_repeat" and you judge the topic to be the same as one of its ' +
				"possible_matches. Records a repeat of that match (repeat_of = its entry_id) and turns your new entry " +
				"into an alias of it, so the same phrasing is refused next time. Then choose a different topic.",
			inputSchema: SkipInput,
			// Not destructive: it only converts the caller's own new claim into an alias and records a hit.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => run(() => api.ledger.skip(api.userId, args)),
	);

	server.registerTool(
		"keep_topic",
		{
			title: "Keep a topic",
			description:
				'Use after claim_topic returned "possible_repeat" and you judge the topic to be different from every ' +
				"possible match. Records that verdict; the topic stays claimed.",
			inputSchema: KeepInput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (args) => run(() => api.ledger.keep(api.userId, args)),
	);
```

- [ ] **Step 6: Update the README API reference**

In `README.md`:

1. Replace the intro sentence that starts "Rephrasings — like" (through the end of that paragraph) with:

```markdown
back to. Rephrasings — like "Euler's identity" vs "e^(iπ)+1=0" — come back as
`possible_repeat`, and the brief answers with `skip_topic` (same topic: counted as a repeat,
and the phrasing becomes an alias that is refused outright next time) or `keep_topic`
(different topic). Every such verdict is listed on the dashboard's **Near misses** page; see
[`docs/calibration.md`](docs/calibration.md) for why meaning-based matches ask for a verdict
instead of blocking.
```

(Keep the preceding words of that paragraph unchanged; only the text from "Rephrasings" onward is replaced.)

2. After the `- **Dashboard:** ...` bullet, add a blank line and:

```markdown
MCP tools: `claim_topic`, `check_topic`, `list_topics`, `skip_topic`, `keep_topic`,
`topic_stats`. Erasing a topic is only possible from the dashboard or REST.
```

3. Replace the `Design:` line with:

```markdown
Design: [`docs/superpowers/specs/2026-09-14-topic-ledger-design.md`](docs/superpowers/specs/2026-09-14-topic-ledger-design.md),
amended by [`docs/superpowers/specs/2026-09-15-near-misses-design.md`](docs/superpowers/specs/2026-09-15-near-misses-design.md)
```

4. Replace the API table with:

```markdown
| Method | Path | Body / query | Result |
|---|---|---|---|
| POST | `/api/v1/claims` | `{category, name, force?}` | `{status: "claimed", entry, forced, overridden_matches, semantic}`, `{status: "possible_repeat", entry, possible_matches, next_step, semantic}` or `{status: "repeat", matches, semantic}` |
| POST | `/api/v1/checks` | `{category, name}` | `{likely_repeat, matches, semantic}` (records nothing) |
| GET | `/api/v1/entries` | `?category=&limit=&since=` | `{entries}` (original topics only) |
| POST | `/api/v1/entries/:id/skip` | `{repeat_of, note?}` | `{skipped, alias_of}`: the entry becomes an alias of `repeat_of` and a hit is recorded |
| POST | `/api/v1/entries/:id/keep` | `{note?}` | `{kept, distinct}` |
| DELETE | `/api/v1/entries/:id` | — | 204; erases the topic with its hits, aliases and near misses |
| GET | `/api/v1/stats` | `?scope=me\|global&category=&limit=` | `{scope, repeats}` |
```

- [ ] **Step 7: Run the gate**

Run: `npx biome check --write src test && npm run check && grep -rn "forget_topic\|ForgetInput\|ForgetResult" src test README.md`
Expected: gate PASS; the grep prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/api/rest.ts src/api/mcp.ts src/api/schemas.ts README.md test/rest.test.ts test/mcp.test.ts
git commit -F - <<'EOF'
feat: expose skip and keep over REST and MCP, and drop forget_topic from MCP

REST gains POST /entries/:id/skip and /keep; MCP gains skip_topic and keep_topic and no longer offers forget_topic, so an unattended brief cannot erase history. The README documents the new flow.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```

---

### Task 6: Dashboard, prompt and docs

**Files:**
- Modify: `src/web/layout.tsx`, `src/web/dashboard.tsx`, `src/web/prompt.ts`, `README.md` (prompt), `docs/calibration.md`, `docs/superpowers/specs/2026-09-14-topic-ledger-design.md`
- Test: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `LedgerStore.listAliases`, `LedgerStore.listNearMisses`, `NearMissView` (Task 1); `Ledger.skip`, `Ledger.keep` (Task 4); `possible_repeat` (Task 3).
- Produces: `GET /near-misses` page; nav link; alias names on `/ledger`; `BRIEF_PROMPT_SNIPPET` with the new wording (README copy identical).

- [ ] **Step 1: Write the failing dashboard tests**

In `test/dashboard.test.ts`, add `import { FakeSemanticIndex } from "./fakes/semantic";` and append:

```ts
describe("near misses page", () => {
	it("labels every verdict, shows via aliases, and lists aliases on the ledger", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claim = (name: string) => ledger.claim(userId, { category, name, force: false });

		const haytham = await claim("Ibn al-Haytham");
		if (haytham.status !== "claimed") throw new Error("expected claimed");

		semantic.setSimilarity("Ibn al-Haytham", "Omar Khayyam", 0.81);
		const khayyam = await claim("Omar Khayyam");
		if (khayyam.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.keep(userId, { entry_id: khayyam.entry.id, note: "different people" });

		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		semantic.setSimilarity("Omar Khayyam", "Alhazen", 0.79);
		const alhazen = await claim("Alhazen");
		if (alhazen.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });

		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);
		const optics = await claim("Father of optics");
		if (optics.status !== "possible_repeat") throw new Error("expected possible_repeat");

		const html = await (await get("/near-misses", cookie)).text();
		for (const text of [
			"Repeat — skipped",
			"Different — kept",
			"No verdict — used",
			"Not judged — claim skipped",
			"via Alhazen",
			"different people",
			'href="/near-misses"',
		]) {
			expect(html).toContain(text);
		}

		const ledgerHtml = await (await get("/ledger", cookie)).text();
		expect(ledgerHtml).toContain("also claimed as: Alhazen");
		expect(ledgerHtml).not.toContain(`/entries/${alhazen.entry.id}/forget`);
	});

	it("shows an empty state", async () => {
		const html = await (await get("/near-misses", await sessionCookie(await seedUser()))).text();
		expect(html).toContain("No near misses yet.");
	});
});
```

In `describe("connect page", ...)`, add after `expect(html).toContain("claim_topic");`:

```ts
		expect(html).toContain("skip_topic");
		expect(html).toContain("keep_topic");
		expect(html).not.toContain("forget_topic");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard.test.ts`
Expected: FAIL — `/near-misses` redirects/404s and the prompt still mentions `forget_topic`.

- [ ] **Step 3: Add the nav link**

In `src/web/layout.tsx`, after `<a href="/repeats">Repeats</a>` add:

```tsx
							<a href="/near-misses">Near misses</a>
```

- [ ] **Step 4: Build the pages**

In `src/web/dashboard.tsx`:

1. Change imports: `import type { EntryRow, TokenRow } from "../core/rows";` and `import { LedgerStore, type NearMissView, type UserRepeatRow } from "../store/d1";`.
2. Replace `LedgerPage` with:

```tsx
function LedgerPage(props: { entries: Entry[]; aliases: ReadonlyMap<string, string[]> }) {
	return (
		<Layout title="Ledger" signedIn>
			<h1>Ledger</h1>
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
							<th>Claimed</th>
							<th>Repeats</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.entries.map((entry) => {
							const aliases = props.aliases.get(entry.id) ?? [];
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
									<td>{entry.created_at.slice(0, 10)}</td>
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

function aliasNamesByOriginal(aliases: readonly EntryRow[]): Map<string, string[]> {
	const names = new Map<string, string[]>();
	for (const alias of aliases) {
		if (alias.alias_of === null) continue;
		names.set(alias.alias_of, [...(names.get(alias.alias_of) ?? []), alias.display_name]);
	}
	return names;
}

function verdictLabel(row: NearMissView): string {
	if (row.verdict === "repeat") return "Repeat — skipped";
	if (row.verdict === "distinct") return "Different — kept";
	return row.claim_alias_of === null ? "No verdict — used" : "Not judged — claim skipped";
}

function NearMissesPage(props: { rows: NearMissView[] }) {
	return (
		<Layout title="Near misses" signedIn>
			<h1>Near misses</h1>
			<p>Earlier topics a claim resembled closely enough to ask the brief for a verdict.</p>
			{props.rows.length === 0 ? (
				<p>No near misses yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Claimed</th>
							<th>Matched</th>
							<th>Match</th>
							<th>Score</th>
							<th>Verdict</th>
							<th>Note</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<tr>
								<td>{toIso(row.created_at).slice(0, 10)}</td>
								<td>{row.claim_name}</td>
								<td>
									{row.matched_name} <small>{`(${row.category})`}</small>
									{row.via_name === null ? null : (
										<>
											<br />
											<small>{`via ${row.via_name}`}</small>
										</>
									)}
								</td>
								<td>{row.match_kind}</td>
								<td>{row.score.toFixed(2)}</td>
								<td>{verdictLabel(row)}</td>
								<td>{row.note ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p>Showing the newest {PAGE_LIMIT} near misses.</p>
		</Layout>
	);
}
```

3. Replace the `/ledger` route and add `/near-misses` after the `/repeats` route:

```tsx
	app.get(
		"/ledger",
		page(async (c, userId) => {
			const { entries } = await ledgerFromEnv(c.env).list(userId, { limit: PAGE_LIMIT });
			const aliases = await new LedgerStore(c.env.DB).listAliases(
				userId,
				entries.map((entry) => entry.id),
			);
			return render(
				c,
				<LedgerPage entries={entries} aliases={aliasNamesByOriginal(aliases)} />,
			);
		}),
	);
```

```tsx
	app.get(
		"/near-misses",
		page(async (c, userId) => {
			const rows = await new LedgerStore(c.env.DB).listNearMisses(userId, PAGE_LIMIT);
			return render(c, <NearMissesPage rows={rows} />);
		}),
	);
```

- [ ] **Step 5: Update the prompt snippet and its README copy**

Replace `src/web/prompt.ts` with:

```ts
/** Recommended wording for the scheduled brief. Keep README.md's copy identical. */
export const BRIEF_PROMPT_SNIPPET = [
	'Before writing the math section, choose a topic and call claim_topic with category "math"',
	'and the topic\'s common name. If the result is "repeat", choose a different topic and call',
	'again, up to 5 times. If the result is "possible_repeat", decide whether your topic is the',
	"same as any listed match: if it is, call skip_topic with repeat_of set to that match's",
	"entry_id and choose again; if not, call keep_topic. Include a short note with either call.",
	'Do the same with category "person" for the historical figure.',
].join(" ");
```

In `README.md`, replace the quoted prompt line under "claude.ai scheduled task" with exactly:

```markdown
> Before writing the math section, choose a topic and call claim_topic with category "math" and the topic's common name. If the result is "repeat", choose a different topic and call again, up to 5 times. If the result is "possible_repeat", decide whether your topic is the same as any listed match: if it is, call skip_topic with repeat_of set to that match's entry_id and choose again; if not, call keep_topic. Include a short note with either call. Do the same with category "person" for the historical figure.
```

Verify they match: `node -e 'import("./src/web/prompt.ts").then(m => { const r = require("fs").readFileSync("README.md","utf8"); console.log(r.includes("> " + m.BRIEF_PROMPT_SNIPPET)); })'` must print `true`.

- [ ] **Step 6: Amend the calibration doc**

In `docs/calibration.md`:

1. Replace `(surfaced as \`possible_matches\` for the brief to judge)` with `(surfaced as \`possible_repeat\` for the brief to judge with \`skip_topic\` or \`keep_topic\`)`.
2. Replace the sentence `Exact and trigram matching still block; semantic similarity instead surfaces candidates, and the brief's prompt tells the LLM to \`forget_topic\` a new entry it judges to be the same topic.` (it spans two lines) with:

```markdown
Exact and trigram matching still block; semantic similarity instead returns `possible_repeat`,
and the brief's LLM answers with `skip_topic` (same topic: counted as a repeat, and the phrasing
becomes an alias that exact matching refuses next time) or `keep_topic`.
```

3. Replace `` `scripts/calibration-pairs.ts` with real near-misses seen in `/repeats` over time. `` with `` `scripts/calibration-pairs.ts` with real pairs and verdicts from the dashboard's Near misses page (`/near-misses`). ``

- [ ] **Step 7: Amend the original spec**

In `docs/superpowers/specs/2026-09-14-topic-ledger-design.md` (each old text appears once):

1. In the Architecture route table, replace `` `/`, `/ledger`, `/repeats`, `/global`, `/access`, `/connect`, `/account` `` with `` `/`, `/ledger`, `/repeats`, `/near-misses`, `/global`, `/access`, `/connect`, `/account` ``.
2. Replace `rephrasing for the caller (the brief's LLM) to judge and forget if needed.` with `rephrasing for the caller (the brief's LLM) to judge with \`skip_topic\` or \`keep_topic\`.`
3. In the Operations table, replace the row `` | forget | `forget_topic` | `DELETE /api/v1/entries/:id` | `` with:

```markdown
| skip | `skip_topic` | `POST /api/v1/entries/:id/skip` |
| keep | `keep_topic` | `POST /api/v1/entries/:id/keep` |
| forget | *(none)* | `DELETE /api/v1/entries/:id` |
```

4. In Wire types, replace the three lines

```
type ClaimResult =
  | { status: "claimed"; entry: Entry; forced: boolean;
      possible_matches: Match[]; semantic: SemanticStatus }
```

with

```
type ClaimResult =                     // see the near-misses spec
  | { status: "claimed"; entry: Entry; forced: boolean;
      overridden_matches: Match[]; semantic: SemanticStatus }
  | { status: "possible_repeat"; entry: Entry; possible_matches: Match[];
      next_step: string; semantic: SemanticStatus }
```

and add the line `  via_alias?: string;                  // alias that matched, if any` after `  hit_count: number;` inside `interface Match`.
5. Replace step 5 of "claim semantics" (`5. Return \`claimed\`. \`possible_matches\` holds every match that did not block the` and its continuation line) with:

```markdown
5. Record a near miss per non-blocking match, then return `possible_repeat` when unforced
   possible matches exist, otherwise `claimed` (see the near-misses spec).
```

6. Replace `A **hit** is recorded only by \`claim\` when it returns \`repeat\`.` with `A **hit** is recorded by \`claim\` when it returns \`repeat\`, and by \`skip\`.`
7. At the end of the "forget" section's paragraph, add the sentence: `It also removes the entry's aliases (with their vectors) and near misses, and is not exposed over MCP.`
8. In the Dashboard table, replace `` | `/ledger` | Entries by category and date; forget button | `` with:

```markdown
| `/ledger` | Original topics by category and date, with their aliases; forget button |
| `/near-misses` | Possible matches claims surfaced, with verdicts and notes |
```

9. Replace the Brief integration quote (the five `>` lines) with:

```markdown
> Before writing the math section, choose a topic and call `claim_topic` with
> category `math` and the topic's common name. If the result is `repeat`, choose
> a different topic and call again, up to 5 times. If the result is
> `possible_repeat`, decide whether your topic is the same as any listed match:
> if it is, call `skip_topic` with `repeat_of` set to that match's `entry_id` and
> choose again; if not, call `keep_topic`. Include a short note with either call.
> Do the same with category `person` for the historical figure.
```

10. In the Risks table, replace `semantic matches are advisory \`possible_matches\`; exact and trigram still block` with `semantic matches return \`possible_repeat\` and the brief gives a verdict; exact and trigram still block`.

- [ ] **Step 8: Run the gate**

Run: `npx biome check --write src test && npm run check && grep -rn "forget_topic" src test README.md docs/calibration.md`
Expected: gate PASS; grep prints nothing. (`forget_topic` may still appear in `docs/superpowers/specs/2026-09-15-near-misses-design.md` and the historical 2026-09-14 plan — leave those.)

- [ ] **Step 9: Commit**

```bash
git add src/web/layout.tsx src/web/dashboard.tsx src/web/prompt.ts README.md docs/calibration.md docs/superpowers/specs/2026-09-14-topic-ledger-design.md test/dashboard.test.ts
git commit -F - <<'EOF'
feat: show near misses and aliases on the dashboard, and update the brief prompt

A Near misses page lists every possible match with its verdict and note, the ledger lists each topic's aliases, and the prompt tells the brief to answer possible_repeat with skip_topic or keep_topic. Docs follow.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
EOF
```
