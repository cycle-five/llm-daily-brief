# Topic Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Topic Ledger — a multi-user Cloudflare Worker that stops the daily brief from repeating topics and counts would-be repeats — reachable over MCP and REST with OAuth and personal tokens, plus a small dashboard.

**Architecture:** One TypeScript Worker. `@cloudflare/workers-oauth-provider` fronts everything: `/mcp` and `/api/v1/` are its protected API routes (OAuth tokens, or personal `ldg_` tokens via `resolveExternalToken`), everything else goes to a Hono web app (sign-in + dashboard). A pure core (`normalize` → `trigram` → `match`) plus `Ledger` orchestration sits on D1 (source of truth) and an injectable `SemanticIndex` (Workers AI embeddings + Vectorize in production, an in-memory fake in tests).

**Tech Stack:** TypeScript 6, Cloudflare Workers, D1, Vectorize, Workers AI, KV, Rate Limiting binding, Hono 4 (+ JSX), zod 4, `agents` stateless MCP handler, `@modelcontextprotocol/server` 2, Vitest 4 with `@cloudflare/vitest-plugin`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-14-topic-ledger-design.md`

## Global Constraints

- **Exact dependency pins** (no `^`/`~`): `@cloudflare/workers-oauth-provider` 0.10.3, `agents` 0.23.0, `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `hono` 4.13.7, `zod` 4.6.5, `wrangler` 4.131.2, `@cloudflare/vitest-plugin` 1.1.9, `vitest` 4.1.11 (the plugin requires Vitest `^4.1.0`; do **not** use Vitest 5), `typescript` 6.0.3, `@biomejs/biome` 2.5.13, `@cloudflare/workers-types` 5.20260914.1.
- **Package manager:** npm. Node ≥ 22.
- **Typing rule:** every request, response, tool input and tool output is a zod schema in `src/api/schemas.ts`; TypeScript types come from `z.infer`. No `any`, no `as` casts on external data (parse with zod instead), no hand-assembled JSON objects outside those types. `tsc` runs in `strict` mode with `noUncheckedIndexedAccess`.
- **Imports:** `verbatimModuleSyntax` is on — type-only imports must use `import type`.
- **Categories** are trimmed and lowercased at input validation and must then be 1–64 UTF-8 bytes. **Names** are trimmed, 1–200 characters.
- **Thresholds (vars):** `SEMANTIC_REPEAT_THRESHOLD` `0.85`, `SEMANTIC_POSSIBLE_THRESHOLD` `0.75`, `TRIGRAM_REPEAT_THRESHOLD` `0.6`, `GLOBAL_MIN_USERS` `2`.
- **Embedding model:** `@cf/google/embeddinggemma-300m` (768 dimensions, cosine).
- **Resource names:** Worker `topic-ledger`, D1 `topic-ledger`, KV `topic-ledger-oauth`, Vectorize `topic-ledger-v1`, custom domain `ledger.twkr.io`, Cloudflare account Cycle Five Syndicate (`e24f723fe819bea445d08ab472d549f6`).
- **OAuth provider options:** `accessTokenTTL: 3600`; `refreshTokenTTL: undefined` **passed explicitly** (the library default is 30 days).
- **Error codes → HTTP:** `unauthorized` 401, `invalid_input` 400, `not_found` 404, `rate_limited` 429, `upstream_unavailable` 503.
- **Test isolation:** never assume an empty database. Every test creates its own user ids (`crypto.randomUUID()`) and, where it counts rows across users, its own category (`` `c-${crypto.randomUUID()}` ``). Test files run serially (`fileParallelism: false`, set in Task 5) because they share one local D1.
- **Commits:** every commit message ends with exactly this trailer line and no other `Co-Authored-By` line:
  `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- **Gate before each commit:** `npm run check` (typecheck + lint + tests) must pass.

## Deltas from the spec found while planning

1. `list` returns `{ entries: Entry[] }` (not a bare array): MCP `structuredContent` must be an object, and REST mirrors it.
2. The brief prompt snippet lives in `src/web/prompt.ts` (rendered on `/connect` and copied into the README) instead of `prompts/daily-brief.md`: the Worker bundle cannot import `.md` without extra module rules.
3. `stats` with `scope=me` lists only entries with `hit_count > 0`.
4. Every `claim` that returns `repeat` records a hit — including an exact match that refused `force: true`. This follows the spec's "Hit semantics" section.
5. Trigram test example: `srinivasa ramanujan` vs `srinivasa ramanujam` (≈ 0.81). The spec's original `ramanujan` vs `ramanujn` scores ≈ 0.55 and would not match (spec corrected).
6. File layout refines the spec's sketch: sign-in routes live in `src/web/auth.tsx` (not `src/auth/handler.ts`), and `src/api/context.ts`, `src/auth/encoding.ts`, `src/auth/pending.ts`, `src/web/guards.ts` are added. The File Structure below is authoritative.
7. Provisioning, calibration and the v0.1.0 release are a separate owner-only task (Task 13) because they touch external accounts.

## File Structure

```
package.json, package-lock.json, tsconfig.json, biome.json, .gitignore
wrangler.jsonc              production config (IDs filled in Task 13)
wrangler.test.jsonc         test config: no AI / VECTORS bindings
vitest.config.ts            cloudflareTest + D1 migrations + test secrets
migrations/0001_init.sql    schema
src/
  index.ts                  OAuthProvider options + default export (fetch, scheduled)
  env.ts                    Env and Props
  config.ts                 thresholds / min users parsed from env vars
  services.ts               ledgerFromEnv(env)
  core/
    rows.ts                 zod row schemas + types (EntryRow, HitRow, UserRow, TokenRow)
    errors.ts               LedgerError
    normalize.ts            normalize(), normalizeCategory()
    trigram.ts              trigrams(), trigramSimilarity()
    match.ts                lexical/semantic classification, ranking
    wire.ts                 row → wire conversions
    ledger.ts               Ledger: claim/check/list/forget/stats/backfill/deleteAccount
  store/d1.ts               LedgerStore: all SQL
  semantic/
    index.ts                SemanticIndex interface, UnavailableSemanticIndex, semanticIndexFromEnv
    cloudflare.ts           CloudflareSemanticIndex (Workers AI + Vectorize)
  api/
    schemas.ts              zod wire schemas + inferred types
    context.ts              ApiContext shared by REST and MCP
    errors.ts               error → Response / tool result
    validate.ts             parseInput()
    ratelimit.ts            enforceRateLimit()
    rest.ts                 Hono REST app
    mcp.ts                  buildMcpServer()
    handler.ts              apiHandler: props → /mcp or REST
  auth/
    encoding.ts             base64url helpers
    tokens.ts               personal tokens
    session.ts              HMAC-signed cookies
    upstream.ts             GitHub / Google OAuth clients (injected fetch)
    pending.ts              pending sign-in state in KV
  web/
    app.ts                  createWebApp(): mounts auth + dashboard routes
    guards.ts               WebEnv, WebDeps, session/origin guards, cookie options
    auth.tsx                /authorize, /login, /callback, /logout
    dashboard.tsx           dashboard routes
    layout.tsx              shared HTML layout
    prompt.ts               brief prompt snippet
test/
  env.d.ts, setup.ts
  fakes/semantic.ts
  helpers.ts                seedUser(), oauth test helpers
  *.test.ts
scripts/
  calibrate.ts, calibration-pairs.ts
.github/workflows/ci.yml, deploy.yml
```

---

### Task 1: Project scaffold, schema migration, test harness, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `wrangler.jsonc`, `wrangler.test.jsonc`, `vitest.config.ts`, `src/env.ts`, `src/index.ts` (placeholder export), `migrations/0001_init.sql`, `test/env.d.ts`, `test/setup.ts`, `test/migrations.test.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `Env` and `Props` (`src/env.ts`); D1 tables `users`, `identities`, `entries`, `hits`, `api_tokens`; `cloudflare:test` `env` typed as `Env & { TEST_MIGRATIONS }`; npm scripts `typecheck`, `lint`, `format`, `test`, `check`.

- [ ] **Step 1: Write package and tool configuration**

`package.json`:

```json
{
	"name": "topic-ledger",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "wrangler dev",
		"deploy": "wrangler deploy",
		"typecheck": "tsc --noEmit",
		"lint": "biome check .",
		"format": "biome check --write .",
		"test": "vitest run",
		"check": "npm run typecheck && npm run lint && npm run test"
	},
	"dependencies": {
		"@cloudflare/workers-oauth-provider": "0.10.3",
		"@modelcontextprotocol/client": "2.0.0",
		"@modelcontextprotocol/server": "2.0.0",
		"agents": "0.23.0",
		"hono": "4.13.7",
		"zod": "4.6.5"
	},
	"devDependencies": {
		"@biomejs/biome": "2.5.13",
		"@cloudflare/vitest-plugin": "1.1.9",
		"@cloudflare/workers-types": "5.20260914.1",
		"typescript": "6.0.3",
		"vitest": "4.1.11",
		"wrangler": "4.131.2"
	}
}
```

`@modelcontextprotocol/client` is a non-optional peer of `agents`, so it is a dependency (tests also use it).

`tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2024",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"lib": ["ES2024"],
		"types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"],
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"verbatimModuleSyntax": true,
		"isolatedModules": true,
		"skipLibCheck": true,
		"noEmit": true,
		"jsx": "react-jsx",
		"jsxImportSource": "hono/jsx"
	},
	"include": ["src", "test"]
}
```

`biome.json`:

```json
{
	"$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
	"files": {
		"includes": ["src/**", "test/**", "scripts/**", "*.json", "*.jsonc", "vitest.config.ts"]
	},
	"formatter": { "indentStyle": "tab", "lineWidth": 100 },
	"javascript": { "formatter": { "quoteStyle": "double" } },
	"linter": {
		"rules": {
			"recommended": true,
			"suspicious": { "noExplicitAny": "error" }
		}
	}
}
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, exit 0. If npm reports an `ERESOLVE` peer conflict, stop and report the full message — do not use `--force` or `--legacy-peer-deps`.

- [ ] **Step 3: Write Wrangler configs**

`wrangler.jsonc` (production; `database_id` and the KV `id` are added in Task 13 after the resources are created):

```jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "topic-ledger",
	"main": "src/index.ts",
	"compatibility_date": "2026-09-01",
	"compatibility_flags": ["nodejs_compat"],
	"workers_dev": false,
	"routes": [{ "pattern": "ledger.twkr.io", "custom_domain": true }],
	"observability": { "enabled": true },
	"vars": {
		"PUBLIC_ORIGIN": "https://ledger.twkr.io",
		"SEMANTIC_REPEAT_THRESHOLD": "0.85",
		"SEMANTIC_POSSIBLE_THRESHOLD": "0.75",
		"TRIGRAM_REPEAT_THRESHOLD": "0.6",
		"GLOBAL_MIN_USERS": "2"
	},
	"d1_databases": [
		{ "binding": "DB", "database_name": "topic-ledger", "migrations_dir": "migrations" }
	],
	"kv_namespaces": [{ "binding": "OAUTH_KV" }],
	"vectorize": [{ "binding": "VECTORS", "index_name": "topic-ledger-v1" }],
	"ai": { "binding": "AI" },
	"ratelimits": [
		{ "name": "CLAIM_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
	],
	"triggers": { "crons": ["*/15 * * * *"] }
}
```

`wrangler.test.jsonc` (no `AI`, no `VECTORS`, no routes):

```jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "topic-ledger-test",
	"main": "src/index.ts",
	"compatibility_date": "2026-09-01",
	"compatibility_flags": ["nodejs_compat"],
	"vars": {
		"PUBLIC_ORIGIN": "https://ledger.test",
		"SEMANTIC_REPEAT_THRESHOLD": "0.85",
		"SEMANTIC_POSSIBLE_THRESHOLD": "0.75",
		"TRIGRAM_REPEAT_THRESHOLD": "0.6",
		"GLOBAL_MIN_USERS": "2"
	},
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "topic-ledger",
			"database_id": "00000000-0000-0000-0000-000000000000",
			"migrations_dir": "migrations"
		}
	],
	"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "test-oauth-kv" }],
	"ratelimits": [
		{ "name": "CLAIM_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
	]
}
```

- [ ] **Step 4: Write env types, a placeholder entry point, and the test harness**

`src/env.ts`:

```ts
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
	DB: D1Database;
	OAUTH_KV: KVNamespace;
	/** Absent in tests (wrangler.test.jsonc); semantic matching then reports "unavailable". */
	AI?: Ai;
	/** Absent in tests (wrangler.test.jsonc). */
	VECTORS?: Vectorize;
	CLAIM_LIMITER: RateLimit;
	/** Injected by OAuthProvider before the default handler runs. */
	OAUTH_PROVIDER: OAuthHelpers;
	PUBLIC_ORIGIN: string;
	SEMANTIC_REPEAT_THRESHOLD: string;
	SEMANTIC_POSSIBLE_THRESHOLD: string;
	TRIGRAM_REPEAT_THRESHOLD: string;
	GLOBAL_MIN_USERS: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	COOKIE_SECRET: string;
}

export const PropsSchema = z.object({ userId: z.string().min(1) });
export type Props = z.infer<typeof PropsSchema>;
```

`src/index.ts` (replaced in Task 8; exists now so the test config's `main` resolves):

```ts
import type { Env } from "./env";

export default {
	async fetch(): Promise<Response> {
		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
```

`vitest.config.ts`:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
					GITHUB_CLIENT_ID: "gh-client",
					GITHUB_CLIENT_SECRET: "gh-secret",
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					COOKIE_SECRET: "test-cookie-secret-0123456789abcdef",
				},
			},
		})),
	],
	test: { setupFiles: ["./test/setup.ts"] },
});
```

`test/env.d.ts`:

```ts
import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

declare global {
	namespace Cloudflare {
		interface Env extends AppEnv {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
```

`test/setup.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 5: Write the failing migration tests**

`test/migrations.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function countWhere(table: string, column: string, value: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`)
		.bind(value)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

describe("migration 0001_init", () => {
	it("cascades a user delete to identities, entries, hits and tokens", async () => {
		const userId = crypto.randomUUID();
		const entryId = crypto.randomUUID();
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, ?2)",
			).bind(userId, now),
			env.DB.prepare(
				"INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES ('github', ?1, ?2, NULL, ?3)",
			).bind(`gh-${userId}`, userId, now),
			env.DB.prepare(
				"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at) VALUES (?1, ?2, 'math', 'Euler', 'euler', 'pending', 1, ?3)",
			).bind(entryId, userId, now),
			env.DB.prepare(
				"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at) VALUES (?1, ?2, ?3, 'Euler', 'euler', 'exact', 1, ?4)",
			).bind(crypto.randomUUID(), entryId, userId, now),
			env.DB.prepare(
				"INSERT INTO api_tokens (id, user_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, 'cron', ?4)",
			).bind(crypto.randomUUID(), userId, `hash-${userId}`, now),
		]);

		await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();

		expect(await countWhere("identities", "user_id", userId)).toBe(0);
		expect(await countWhere("entries", "user_id", userId)).toBe(0);
		expect(await countWhere("api_tokens", "user_id", userId)).toBe(0);
		expect(await countWhere("hits", "entry_id", entryId)).toBe(0);
	});

	it("rejects a second entry with the same user, category and normalized name", async () => {
		const userId = crypto.randomUUID();
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, ?2)",
		)
			.bind(userId, now)
			.run();
		const insert = () =>
			env.DB.prepare(
				"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at) VALUES (?1, ?2, 'math', 'Euler', 'euler', 'pending', 0, ?3)",
			)
				.bind(crypto.randomUUID(), userId, now)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow(/UNIQUE constraint failed/);
	});
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run test/migrations.test.ts`
Expected: FAIL — `readD1Migrations` finds no migrations, so queries fail with `no such table: users`.

- [ ] **Step 7: Write the migration**

`migrations/0001_init.sql`:

```sql
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
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/migrations.test.ts`
Expected: PASS (2 tests). If the cascade test fails with non-zero counts, D1 is not enforcing foreign keys in Miniflare — stop and report; do not work around it silently.

- [ ] **Step 9: Add CI and run the full gate**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [master]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

Run: `npm run format && npm run check`
Expected: typecheck, lint and tests all pass.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json biome.json .gitignore wrangler.jsonc wrangler.test.jsonc vitest.config.ts src test migrations .github
git commit -m "chore: scaffold topic-ledger worker with D1 schema and test harness" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


### Task 2: Normalization and trigram similarity

**Files:**
- Create: `src/core/normalize.ts`, `src/core/trigram.ts`
- Test: `test/normalize.test.ts`, `test/trigram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalize(text: string): string`
  - `normalizeCategory(text: string): string`
  - `trigrams(normalized: string): Set<string>`
  - `trigramSimilarity(a: string, b: string): number` — Jaccard in `[0, 1]`, inputs already normalized

- [ ] **Step 1: Write the failing tests**

`test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalize, normalizeCategory } from "../src/core/normalize";

describe("normalize", () => {
	it.each([
		["Euler's Identity", "euler identity"],
		["Euler’s Identity", "euler identity"],
		["Kurt Gödel", "kurt godel"],
		["The Banach–Tarski Paradox", "banach tarski paradox"],
		["P & NP", "p and np"],
		["  Ada   Lovelace  ", "ada lovelace"],
		["An Introduction", "introduction"],
		["A Mathematician's Apology", "mathematician apology"],
		["Theory of Everything", "theory of everything"],
		["e^(iπ)+1=0", "e i π 1 0"],
		["!!!", ""],
	])("normalize(%j) === %j", (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});
});

describe("normalizeCategory", () => {
	it("trims and lowercases without folding punctuation", () => {
		expect(normalizeCategory("  Math-History ")).toBe("math-history");
	});
});
```

`test/trigram.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { trigramSimilarity, trigrams } from "../src/core/trigram";

describe("trigrams", () => {
	it("pads with one space on each side", () => {
		expect([...trigrams("ab")].sort()).toEqual([" ab", "ab "]);
	});

	it("returns an empty set for an empty string", () => {
		expect(trigrams("").size).toBe(0);
	});
});

describe("trigramSimilarity", () => {
	it("is 1 for identical strings", () => {
		expect(trigramSimilarity("euler identity", "euler identity")).toBe(1);
	});

	it("keeps different topics that share a word well below 0.6", () => {
		expect(trigramSimilarity("euler identity", "euler totient")).toBeCloseTo(6 / 21, 5);
	});

	it("scores a one-letter misspelling of a long name above 0.6", () => {
		expect(trigramSimilarity("srinivasa ramanujan", "srinivasa ramanujam")).toBeCloseTo(17 / 21, 5);
	});

	it("is symmetric", () => {
		expect(trigramSimilarity("godel", "kurt godel")).toBe(trigramSimilarity("kurt godel", "godel"));
	});

	it("is 0 when exactly one side is empty and 1 when both are", () => {
		expect(trigramSimilarity("", "ab")).toBe(0);
		expect(trigramSimilarity("", "")).toBe(1);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/normalize.test.ts test/trigram.test.ts`
Expected: FAIL — cannot resolve `../src/core/normalize` and `../src/core/trigram`.

- [ ] **Step 3: Implement**

`src/core/normalize.ts`:

```ts
const COMBINING_MARKS = /\p{M}/gu;
const POSSESSIVE = /['’]s\b/g;
const NON_ALPHANUMERIC_RUN = /[^\p{L}\p{N}]+/gu;
const LEADING_ARTICLE = /^(?:the|a|an) /;

/**
 * Canonical form used for exact and trigram matching. Never used as embedding input.
 * Steps (spec "Normalization"): NFKD + strip marks, lowercase, & → and, drop possessive
 * 's, collapse non-alphanumerics to single spaces, trim, drop one leading article.
 */
export function normalize(text: string): string {
	return text
		.normalize("NFKD")
		.replace(COMBINING_MARKS, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(POSSESSIVE, "")
		.replace(NON_ALPHANUMERIC_RUN, " ")
		.trim()
		.replace(LEADING_ARTICLE, "");
}

export function normalizeCategory(text: string): string {
	return text.trim().toLowerCase();
}
```

`src/core/trigram.ts`:

```ts
export function trigrams(normalized: string): Set<string> {
	const out = new Set<string>();
	if (normalized.length === 0) return out;
	const padded = ` ${normalized} `;
	for (let i = 0; i + 3 <= padded.length; i++) {
		out.add(padded.slice(i, i + 3));
	}
	return out;
}

/** Jaccard similarity of character trigrams. Inputs must already be normalized. */
export function trigramSimilarity(a: string, b: string): number {
	const left = trigrams(a);
	const right = trigrams(b);
	if (left.size === 0 && right.size === 0) return 1;
	let shared = 0;
	for (const gram of left) {
		if (right.has(gram)) shared++;
	}
	return shared / (left.size + right.size - shared);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/normalize.test.ts test/trigram.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/core/normalize.ts src/core/trigram.ts test/normalize.test.ts test/trigram.test.ts
git commit -m "feat: add topic normalization and trigram similarity" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 3: Wire schemas, row schemas, errors, and match rules

**Files:**
- Create: `src/api/schemas.ts`, `src/core/rows.ts`, `src/core/errors.ts`, `src/core/match.ts`, `src/core/wire.ts`
- Test: `test/schemas.test.ts`, `test/match.test.ts`

**Interfaces:**
- Consumes: `trigramSimilarity` (Task 2).
- Produces:
  - `src/api/schemas.ts` — zod schemas **and** same-named types: `Category`, `TopicName`, `MatchKind`, `Confidence`, `SemanticStatus`, `Match`, `Entry`, `ClaimInput`, `ClaimResult`, `CheckInput`, `CheckResult`, `ListInput`, `ListResult`, `ForgetInput`, `StatsInput`, `RepeatStat`, `StatsResult`, `ErrorCode`, `ErrorBody`
  - `src/core/rows.ts` — `UserRowSchema`, `EntryRowSchema`, `HitRowSchema`, `TokenRowSchema` and types `UserRow`, `EntryRow`, `HitRow`, `TokenRow`
  - `src/core/errors.ts` — `class LedgerError extends Error { readonly code: ErrorCode }`
  - `src/core/match.ts` — `interface Thresholds { trigramRepeat; semanticRepeat; semanticPossible }`, `interface SemanticHit { entryId: string; score: number }`, `interface ScoredMatch { entry: EntryRow; kind: MatchKind; score: number; confidence: Confidence }`, `MAX_MATCHES = 5`, `findLexicalMatches(normalized, candidates, thresholds)`, `classifySemanticHits(hits, entriesById, thresholds)`, `rankMatches(matches)`, `isLikelyRepeat(matches)`
  - `src/core/wire.ts` — `toIso(ms)`, `toWireEntry(row): Entry`, `toWireMatch(match, hitCountBonus = 0): Match`

- [ ] **Step 1: Write the failing tests**

`test/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CheckInput, ClaimInput, ClaimResult, ListInput, StatsInput } from "../src/api/schemas";

describe("ClaimInput", () => {
	it("trims and lowercases the category, trims the name, defaults force to false", () => {
		expect(ClaimInput.parse({ category: "  Math ", name: " Euler " })).toEqual({
			category: "math",
			name: "Euler",
			force: false,
		});
	});

	it("accepts a 64-byte category and rejects 65+ bytes", () => {
		expect(CheckInput.safeParse({ category: "é".repeat(32), name: "x" }).success).toBe(true);
		expect(CheckInput.safeParse({ category: "é".repeat(33), name: "x" }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "a".repeat(65), name: "x" }).success).toBe(false);
	});

	it("rejects blank categories and names, and names over 200 characters", () => {
		expect(CheckInput.safeParse({ category: "   ", name: "x" }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "math", name: "   " }).success).toBe(false);
		expect(CheckInput.safeParse({ category: "math", name: "x".repeat(201) }).success).toBe(false);
	});
});

describe("ListInput", () => {
	it("coerces string query parameters and applies the default limit", () => {
		expect(ListInput.parse({ limit: "5" })).toEqual({ limit: 5 });
		expect(ListInput.parse({})).toEqual({ limit: 20 });
	});

	it("rejects out-of-range limits and non-ISO since values", () => {
		expect(ListInput.safeParse({ limit: "0" }).success).toBe(false);
		expect(ListInput.safeParse({ limit: "101" }).success).toBe(false);
		expect(ListInput.safeParse({ since: "yesterday" }).success).toBe(false);
		expect(ListInput.safeParse({ since: "2026-09-14T00:00:00.000Z" }).success).toBe(true);
	});
});

describe("StatsInput", () => {
	it("defaults to scope me", () => {
		expect(StatsInput.parse({})).toEqual({ scope: "me", limit: 20 });
	});
});

describe("ClaimResult", () => {
	it("parses both variants", () => {
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
				possible_matches: [],
				semantic: "ok",
			}).status,
		).toBe("claimed");
		expect(ClaimResult.parse({ status: "repeat", matches: [], semantic: "unavailable" }).status).toBe(
			"repeat",
		);
	});
});
```

`test/match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	classifySemanticHits,
	findLexicalMatches,
	isLikelyRepeat,
	MAX_MATCHES,
	rankMatches,
	type ScoredMatch,
	type Thresholds,
} from "../src/core/match";
import type { EntryRow } from "../src/core/rows";
import { toWireMatch } from "../src/core/wire";

const thresholds: Thresholds = { trigramRepeat: 0.6, semanticRepeat: 0.85, semanticPossible: 0.75 };

function entry(overrides: Partial<EntryRow> & Pick<EntryRow, "id" | "normalized">): EntryRow {
	return {
		user_id: "u1",
		category: "math",
		display_name: overrides.normalized,
		vector_status: "indexed",
		hit_count: 0,
		created_at: Date.UTC(2026, 8, 14),
		...overrides,
	};
}

describe("findLexicalMatches", () => {
	const candidates = [
		entry({ id: "identity", normalized: "euler identity" }),
		entry({ id: "ramanujan", normalized: "srinivasa ramanujan" }),
	];

	it("reports an exact normalized match with score 1", () => {
		expect(findLexicalMatches("euler identity", candidates, thresholds)).toEqual([
			{ entry: candidates[0], kind: "exact", score: 1, confidence: "repeat" },
		]);
	});

	it("reports a trigram match at or above the threshold", () => {
		const [match] = findLexicalMatches("srinivasa ramanujam", candidates, thresholds);
		expect(match?.entry.id).toBe("ramanujan");
		expect(match?.kind).toBe("trigram");
		expect(match?.score).toBeCloseTo(17 / 21, 5);
	});

	it("ignores similar-looking but distinct topics", () => {
		expect(findLexicalMatches("euler totient", candidates, thresholds)).toEqual([]);
	});
});

describe("classifySemanticHits", () => {
	const known = new Map([
		["a", entry({ id: "a", normalized: "a" })],
		["b", entry({ id: "b", normalized: "b" })],
		["c", entry({ id: "c", normalized: "c" })],
	]);

	it("splits scores into repeat, possible, and dropped; drops unknown ids", () => {
		const out = classifySemanticHits(
			[
				{ entryId: "a", score: 0.9 },
				{ entryId: "b", score: 0.8 },
				{ entryId: "c", score: 0.7 },
				{ entryId: "gone", score: 0.99 },
			],
			known,
			thresholds,
		);
		expect(out.map((m) => [m.entry.id, m.confidence])).toEqual([
			["a", "repeat"],
			["b", "possible"],
		]);
	});
});

describe("rankMatches", () => {
	const e = (id: string) => entry({ id, normalized: id });
	const m = (id: string, kind: ScoredMatch["kind"], score: number): ScoredMatch => ({
		entry: e(id),
		kind,
		score,
		confidence: "repeat",
	});

	it("keeps the strongest match per entry and orders exact, trigram, semantic, then score", () => {
		const ranked = rankMatches([
			m("x", "semantic", 0.95),
			m("y", "semantic", 0.9),
			m("x", "trigram", 0.7),
			m("z", "exact", 1),
			m("w", "semantic", 0.99),
		]);
		expect(ranked.map((r) => [r.entry.id, r.kind])).toEqual([
			["z", "exact"],
			["x", "trigram"],
			["w", "semantic"],
			["y", "semantic"],
		]);
	});

	it("caps the list at MAX_MATCHES", () => {
		const many = Array.from({ length: 8 }, (_, i) => m(`s${i}`, "semantic", 0.9 - i / 100));
		expect(rankMatches(many)).toHaveLength(MAX_MATCHES);
	});
});

describe("isLikelyRepeat", () => {
	it("is false when only possible-confidence matches exist", () => {
		const possible: ScoredMatch = {
			entry: entry({ id: "p", normalized: "p" }),
			kind: "semantic",
			score: 0.8,
			confidence: "possible",
		};
		expect(isLikelyRepeat([possible])).toBe(false);
		expect(isLikelyRepeat([{ ...possible, confidence: "repeat" }])).toBe(true);
	});
});

describe("toWireMatch", () => {
	it("converts timestamps to ISO and applies the hit-count bonus", () => {
		const match: ScoredMatch = {
			entry: entry({ id: "a", normalized: "a", hit_count: 2 }),
			kind: "exact",
			score: 1,
			confidence: "repeat",
		};
		expect(toWireMatch(match, 1)).toEqual({
			entry_id: "a",
			display_name: "a",
			category: "math",
			kind: "exact",
			score: 1,
			confidence: "repeat",
			first_seen: "2026-09-14T00:00:00.000Z",
			hit_count: 3,
		});
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/schemas.test.ts test/match.test.ts`
Expected: FAIL — modules `../src/api/schemas`, `../src/core/match`, `../src/core/wire` not found.

- [ ] **Step 3: Implement the schemas**

`src/api/schemas.ts`:

```ts
import { z } from "zod";

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

export const Category = z
	.string()
	.trim()
	.toLowerCase()
	.refine((value) => {
		const bytes = utf8Length(value);
		return bytes >= 1 && bytes <= 64;
	}, "category must be 1-64 UTF-8 bytes after trimming");
export type Category = z.infer<typeof Category>;

export const TopicName = z.string().trim().min(1).max(200);
export type TopicName = z.infer<typeof TopicName>;

const Limit = z.coerce.number().int().min(1).max(100).default(20);

export const MatchKind = z.enum(["exact", "trigram", "semantic"]);
export type MatchKind = z.infer<typeof MatchKind>;

export const Confidence = z.enum(["repeat", "possible"]);
export type Confidence = z.infer<typeof Confidence>;

export const SemanticStatus = z.enum(["ok", "unavailable"]);
export type SemanticStatus = z.infer<typeof SemanticStatus>;

export const Match = z.object({
	entry_id: z.string(),
	display_name: z.string(),
	category: z.string(),
	kind: MatchKind,
	score: z.number(),
	confidence: Confidence,
	first_seen: z.string(),
	hit_count: z.number().int(),
});
export type Match = z.infer<typeof Match>;

export const Entry = z.object({
	id: z.string(),
	category: z.string(),
	display_name: z.string(),
	created_at: z.string(),
	hit_count: z.number().int(),
});
export type Entry = z.infer<typeof Entry>;

export const ClaimInput = z.object({
	category: Category,
	name: TopicName,
	force: z.boolean().default(false),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

export const ClaimResult = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("claimed"),
		entry: Entry,
		forced: z.boolean(),
		possible_matches: z.array(Match),
		semantic: SemanticStatus,
	}),
	z.object({
		status: z.literal("repeat"),
		matches: z.array(Match),
		semantic: SemanticStatus,
	}),
]);
export type ClaimResult = z.infer<typeof ClaimResult>;

export const CheckInput = z.object({ category: Category, name: TopicName });
export type CheckInput = z.infer<typeof CheckInput>;

export const CheckResult = z.object({
	likely_repeat: z.boolean(),
	matches: z.array(Match),
	semantic: SemanticStatus,
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ListInput = z.object({
	category: Category.optional(),
	limit: Limit,
	since: z.iso.datetime().optional(),
});
export type ListInput = z.infer<typeof ListInput>;

export const ListResult = z.object({ entries: z.array(Entry) });
export type ListResult = z.infer<typeof ListResult>;

export const ForgetInput = z.object({ entry_id: z.string().min(1) });
export type ForgetInput = z.infer<typeof ForgetInput>;

export const StatsInput = z.object({
	scope: z.enum(["me", "global"]).default("me"),
	category: Category.optional(),
	limit: Limit,
});
export type StatsInput = z.infer<typeof StatsInput>;

export const RepeatStat = z.object({
	display_name: z.string(),
	category: z.string(),
	hit_count: z.number().int(),
	distinct_users: z.number().int().optional(),
	recent_phrasings: z.array(z.string()).optional(),
});
export type RepeatStat = z.infer<typeof RepeatStat>;

export const StatsResult = z.object({
	scope: z.enum(["me", "global"]),
	repeats: z.array(RepeatStat),
});
export type StatsResult = z.infer<typeof StatsResult>;

export const ErrorCode = z.enum([
	"unauthorized",
	"invalid_input",
	"not_found",
	"rate_limited",
	"upstream_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
	error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
```

- [ ] **Step 4: Implement rows, errors, match rules and wire conversions**

`src/core/rows.ts`:

```ts
import { z } from "zod";
import { MatchKind } from "../api/schemas";

export const UserRowSchema = z.object({
	id: z.string(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	created_at: z.number(),
});
export type UserRow = z.infer<typeof UserRowSchema>;

export const EntryRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	category: z.string(),
	display_name: z.string(),
	normalized: z.string(),
	vector_status: z.enum(["pending", "indexed"]),
	hit_count: z.number().int(),
	created_at: z.number(),
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

export const HitRowSchema = z.object({
	id: z.string(),
	entry_id: z.string(),
	user_id: z.string(),
	candidate_text: z.string(),
	candidate_normalized: z.string(),
	match_kind: MatchKind,
	score: z.number(),
	created_at: z.number(),
});
export type HitRow = z.infer<typeof HitRowSchema>;

export const TokenRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	token_hash: z.string(),
	label: z.string(),
	created_at: z.number(),
	last_used_at: z.number().nullable(),
	revoked_at: z.number().nullable(),
});
export type TokenRow = z.infer<typeof TokenRowSchema>;
```

`src/core/errors.ts`:

```ts
import type { ErrorCode } from "../api/schemas";

export class LedgerError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "LedgerError";
		this.code = code;
	}
}
```

`src/core/match.ts`:

```ts
import type { Confidence, MatchKind } from "../api/schemas";
import type { EntryRow } from "./rows";
import { trigramSimilarity } from "./trigram";

export interface Thresholds {
	trigramRepeat: number;
	semanticRepeat: number;
	semanticPossible: number;
}

export interface SemanticHit {
	entryId: string;
	score: number;
}

export interface ScoredMatch {
	entry: EntryRow;
	kind: MatchKind;
	score: number;
	confidence: Confidence;
}

export const MAX_MATCHES = 5;

const KIND_RANK: Record<MatchKind, number> = { exact: 0, trigram: 1, semantic: 2 };

export function findLexicalMatches(
	normalized: string,
	candidates: readonly EntryRow[],
	thresholds: Thresholds,
): ScoredMatch[] {
	const out: ScoredMatch[] = [];
	for (const entry of candidates) {
		if (entry.normalized === normalized) {
			out.push({ entry, kind: "exact", score: 1, confidence: "repeat" });
			continue;
		}
		const score = trigramSimilarity(normalized, entry.normalized);
		if (score >= thresholds.trigramRepeat) {
			out.push({ entry, kind: "trigram", score, confidence: "repeat" });
		}
	}
	return out;
}

export function classifySemanticHits(
	hits: readonly SemanticHit[],
	entriesById: ReadonlyMap<string, EntryRow>,
	thresholds: Thresholds,
): ScoredMatch[] {
	const out: ScoredMatch[] = [];
	for (const hit of hits) {
		const entry = entriesById.get(hit.entryId);
		if (!entry) continue;
		if (hit.score >= thresholds.semanticRepeat) {
			out.push({ entry, kind: "semantic", score: hit.score, confidence: "repeat" });
		} else if (hit.score >= thresholds.semanticPossible) {
			out.push({ entry, kind: "semantic", score: hit.score, confidence: "possible" });
		}
	}
	return out;
}

function compareStrength(a: ScoredMatch, b: ScoredMatch): number {
	return KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.score - a.score;
}

export function rankMatches(matches: readonly ScoredMatch[]): ScoredMatch[] {
	const strongest = new Map<string, ScoredMatch>();
	for (const match of matches) {
		const current = strongest.get(match.entry.id);
		if (!current || compareStrength(match, current) < 0) {
			strongest.set(match.entry.id, match);
		}
	}
	return [...strongest.values()].sort(compareStrength).slice(0, MAX_MATCHES);
}

export function isLikelyRepeat(matches: readonly ScoredMatch[]): boolean {
	return matches.some((match) => match.confidence === "repeat");
}
```

`src/core/wire.ts`:

```ts
import type { Entry, Match } from "../api/schemas";
import type { ScoredMatch } from "./match";
import type { EntryRow } from "./rows";

export function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

export function toWireEntry(row: EntryRow): Entry {
	return {
		id: row.id,
		category: row.category,
		display_name: row.display_name,
		created_at: toIso(row.created_at),
		hit_count: row.hit_count,
	};
}

export function toWireMatch(match: ScoredMatch, hitCountBonus = 0): Match {
	return {
		entry_id: match.entry.id,
		display_name: match.entry.display_name,
		category: match.entry.category,
		kind: match.kind,
		score: match.score,
		confidence: match.confidence,
		first_seen: toIso(match.entry.created_at),
		hit_count: match.entry.hit_count + hitCountBonus,
	};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/schemas.test.ts test/match.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/api/schemas.ts src/core/rows.ts src/core/errors.ts src/core/match.ts src/core/wire.ts test/schemas.test.ts test/match.test.ts
git commit -m "feat: add wire schemas, row schemas and match ranking rules" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 4: D1 store

**Files:**
- Create: `src/store/d1.ts`, `test/helpers.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `EntryRow`, `HitRow`, `TokenRow`, `UserRow` and their schemas (Task 3); `normalize` (Task 2, test helper only).
- Produces (`src/store/d1.ts`):
  - `type IdentityProvider = "github" | "google"`
  - `interface IdentityInput { provider: IdentityProvider; subject: string; email: string | null; displayName: string | null }`
  - `interface GlobalRepeatRow { category: string; display_name: string; hit_count: number; distinct_users: number }`
  - `interface UserRepeatRow { entry: EntryRow; phrasings: string[] }`
  - `MAX_PHRASINGS = 10`, `CANDIDATE_SCAN_LIMIT = 5000`
  - `isUniqueViolation(error: unknown): boolean`
  - `class LedgerStore` with:
    - `findOrCreateUserByIdentity(identity: IdentityInput, now: number, newId: () => string): Promise<string>`
    - `getUser(userId: string): Promise<UserRow | null>`
    - `deleteUser(userId: string): Promise<string[]>` — returns the deleted user's entry ids
    - `listCandidates(userId: string, category: string, limit?: number): Promise<EntryRow[]>`
    - `getEntriesByIds(userId: string, category: string, ids: readonly string[]): Promise<EntryRow[]>`
    - `insertEntry(row: EntryRow): Promise<"inserted" | "duplicate">`
    - `markIndexed(ids: readonly string[]): Promise<void>`
    - `listPending(limit: number): Promise<EntryRow[]>`
    - `listEntries(userId: string, options: { category?: string; limit: number; sinceMs?: number }): Promise<EntryRow[]>`
    - `deleteEntry(userId: string, entryId: string): Promise<boolean>`
    - `recordHit(hit: HitRow): Promise<void>`
    - `topRepeatsForUser(userId: string, category: string | undefined, limit: number): Promise<UserRepeatRow[]>`
    - `globalRepeats(category: string | undefined, minUsers: number, limit: number): Promise<GlobalRepeatRow[]>`
    - `insertToken(row: TokenRow): Promise<void>`
    - `findActiveTokenByHash(hash: string): Promise<TokenRow | null>`
    - `touchToken(tokenId: string, now: number): Promise<void>`
    - `listTokens(userId: string): Promise<TokenRow[]>`
    - `revokeToken(userId: string, tokenId: string, now: number): Promise<boolean>`
- Produces (`test/helpers.ts`): `testStore(): LedgerStore`, `seedUser(label?: string): Promise<string>`, `uniqueCategory(): string`, `makeEntry(userId: string, category: string, displayName: string, overrides?: Partial<EntryRow>): EntryRow`, `makeHit(entry: EntryRow, candidate: string, overrides?: Partial<HitRow>): HitRow`

D1 allows at most 100 bound parameters per query; every `IN (...)` list below is chunked or bounded accordingly.

- [ ] **Step 1: Write the test helpers**

`test/helpers.ts`:

```ts
import { env } from "cloudflare:test";
import { normalize } from "../src/core/normalize";
import type { EntryRow, HitRow } from "../src/core/rows";
import { LedgerStore } from "../src/store/d1";

export function testStore(): LedgerStore {
	return new LedgerStore(env.DB);
}

export function seedUser(label = "user"): Promise<string> {
	return testStore().findOrCreateUserByIdentity(
		{ provider: "github", subject: `${label}-${crypto.randomUUID()}`, email: null, displayName: label },
		Date.now(),
		() => crypto.randomUUID(),
	);
}

export function uniqueCategory(): string {
	return `c-${crypto.randomUUID()}`;
}

export function makeEntry(
	userId: string,
	category: string,
	displayName: string,
	overrides: Partial<EntryRow> = {},
): EntryRow {
	return {
		id: crypto.randomUUID(),
		user_id: userId,
		category,
		display_name: displayName,
		normalized: normalize(displayName),
		vector_status: "pending",
		hit_count: 0,
		created_at: Date.now(),
		...overrides,
	};
}

export function makeHit(entry: EntryRow, candidate: string, overrides: Partial<HitRow> = {}): HitRow {
	return {
		id: crypto.randomUUID(),
		entry_id: entry.id,
		user_id: entry.user_id,
		candidate_text: candidate,
		candidate_normalized: normalize(candidate),
		match_kind: "exact",
		score: 1,
		created_at: Date.now(),
		...overrides,
	};
}
```

- [ ] **Step 2: Write the failing store tests**

`test/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeEntry, makeHit, seedUser, testStore, uniqueCategory } from "./helpers";

describe("users and identities", () => {
	it("returns the same user for the same identity and a new user for another", async () => {
		const store = testStore();
		const subject = `s-${crypto.randomUUID()}`;
		const identity = { provider: "github" as const, subject, email: "a@example.com", displayName: "A" };
		const first = await store.findOrCreateUserByIdentity(identity, 1, () => crypto.randomUUID());
		const again = await store.findOrCreateUserByIdentity(identity, 2, () => crypto.randomUUID());
		const google = await store.findOrCreateUserByIdentity(
			{ ...identity, provider: "google" },
			3,
			() => crypto.randomUUID(),
		);
		expect(again).toBe(first);
		expect(google).not.toBe(first);
		expect(await store.getUser(first)).toEqual({
			id: first,
			display_name: "A",
			email: "a@example.com",
			created_at: 1,
		});
	});

	it("deleteUser returns the user's entry ids and removes the user", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Euler");
		await store.insertEntry(entry);
		expect(await store.deleteUser(userId)).toEqual([entry.id]);
		expect(await store.getUser(userId)).toBeNull();
	});
});

describe("entries", () => {
	it("reports duplicates by user, category and normalized name", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		expect(await store.insertEntry(makeEntry(userId, category, "Euler's Identity"))).toBe("inserted");
		expect(await store.insertEntry(makeEntry(userId, category, "euler identity"))).toBe("duplicate");
	});

	it("scopes candidates to one user and category, newest first", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const older = makeEntry(alice, category, "Gauss", { created_at: 1 });
		const newer = makeEntry(alice, category, "Noether", { created_at: 2 });
		await store.insertEntry(older);
		await store.insertEntry(newer);
		await store.insertEntry(makeEntry(alice, uniqueCategory(), "Hilbert"));
		await store.insertEntry(makeEntry(bob, category, "Riemann"));
		expect((await store.listCandidates(alice, category)).map((e) => e.id)).toEqual([newer.id, older.id]);
	});

	it("getEntriesByIds ignores other users' and other categories' ids", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const mine = makeEntry(alice, category, "Cantor");
		const otherCategory = makeEntry(alice, uniqueCategory(), "Cantor");
		const theirs = makeEntry(bob, category, "Cantor");
		for (const e of [mine, otherCategory, theirs]) await store.insertEntry(e);
		const rows = await store.getEntriesByIds(alice, category, [mine.id, otherCategory.id, theirs.id]);
		expect(rows.map((r) => r.id)).toEqual([mine.id]);
		expect(await store.getEntriesByIds(alice, category, [])).toEqual([]);
	});

	it("filters listEntries by category and since", async () => {
		const store = testStore();
		const userId = await seedUser();
		const math = uniqueCategory();
		const people = uniqueCategory();
		await store.insertEntry(makeEntry(userId, math, "Old", { created_at: 1_000 }));
		const recent = makeEntry(userId, math, "Recent", { created_at: 5_000 });
		await store.insertEntry(recent);
		await store.insertEntry(makeEntry(userId, people, "Person", { created_at: 6_000 }));
		const rows = await store.listEntries(userId, { category: math, limit: 20, sinceMs: 2_000 });
		expect(rows.map((r) => r.id)).toEqual([recent.id]);
		expect(await store.listEntries(userId, { limit: 20 })).toHaveLength(3);
	});

	it("deletes only the owner's entry and cascades its hits", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const entry = makeEntry(alice, uniqueCategory(), "Fermat");
		await store.insertEntry(entry);
		await store.recordHit(makeHit(entry, "Fermat"));
		expect(await store.deleteEntry(bob, entry.id)).toBe(false);
		expect(await store.deleteEntry(alice, entry.id)).toBe(true);
		expect(await store.topRepeatsForUser(alice, entry.category, 10)).toEqual([]);
	});

	it("tracks pending entries until marked indexed", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Lovelace");
		await store.insertEntry(entry);
		expect((await store.listPending(1000)).some((e) => e.id === entry.id)).toBe(true);
		await store.markIndexed([entry.id]);
		expect((await store.listPending(1000)).some((e) => e.id === entry.id)).toBe(false);
	});
});

describe("hits and repeats", () => {
	it("recordHit increments hit_count; topRepeatsForUser orders by hits with newest phrasings", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const euler = makeEntry(userId, category, "Euler's Identity");
		const gauss = makeEntry(userId, category, "Gauss");
		const untouched = makeEntry(userId, category, "Noether");
		for (const e of [euler, gauss, untouched]) await store.insertEntry(e);
		await store.recordHit(makeHit(euler, "Euler identity", { created_at: 1 }));
		await store.recordHit(makeHit(euler, "e^(iπ)+1=0", { created_at: 2, match_kind: "semantic", score: 0.9 }));
		await store.recordHit(makeHit(gauss, "Gauss", { created_at: 3 }));

		const repeats = await store.topRepeatsForUser(userId, category, 10);
		expect(repeats.map((r) => [r.entry.id, r.entry.hit_count])).toEqual([
			[euler.id, 2],
			[gauss.id, 1],
		]);
		expect(repeats[0]?.phrasings).toEqual(["e^(iπ)+1=0", "Euler identity"]);
	});

	it("caps phrasings per entry at MAX_PHRASINGS", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Pi");
		await store.insertEntry(entry);
		for (let i = 0; i < 12; i++) {
			await store.recordHit(makeHit(entry, `pi ${i}`, { created_at: i }));
		}
		const [repeat] = await store.topRepeatsForUser(userId, entry.category, 10);
		expect(repeat?.phrasings).toHaveLength(10);
		expect(repeat?.phrasings[0]).toBe("pi 11");
	});

	it("globalRepeats hides topics hit by fewer than minUsers users and picks the most common display name", async () => {
		const store = testStore();
		const category = uniqueCategory();
		const [a, b, c] = [await seedUser("a"), await seedUser("b"), await seedUser("c")];
		const entryA = makeEntry(a, category, "Euler's Identity");
		const entryB = makeEntry(b, category, "Euler's identity");
		const entryC = makeEntry(c, category, "Euler's identity");
		const lonely = makeEntry(a, category, "Obscure Lemma");
		for (const e of [entryA, entryB, entryC, lonely]) await store.insertEntry(e);
		await store.recordHit(makeHit(entryA, "Euler identity"));
		await store.recordHit(makeHit(entryB, "Euler identity"));
		await store.recordHit(makeHit(lonely, "Obscure Lemma"));

		expect(await store.globalRepeats(category, 2, 20)).toEqual([
			{ category, display_name: "Euler's identity", hit_count: 2, distinct_users: 2 },
		]);
		expect(await store.globalRepeats(category, 1, 20)).toHaveLength(2);
	});
});

describe("api tokens", () => {
	it("finds active tokens by hash and stops finding them after revocation", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const row = {
			id: crypto.randomUUID(),
			user_id: alice,
			token_hash: `hash-${crypto.randomUUID()}`,
			label: "cron",
			created_at: 10,
			last_used_at: null,
			revoked_at: null,
		};
		await store.insertToken(row);
		expect(await store.findActiveTokenByHash(row.token_hash)).toEqual(row);

		await store.touchToken(row.id, 20);
		expect((await store.listTokens(alice))[0]?.last_used_at).toBe(20);

		expect(await store.revokeToken(bob, row.id, 30)).toBe(false);
		expect(await store.revokeToken(alice, row.id, 30)).toBe(true);
		expect(await store.findActiveTokenByHash(row.token_hash)).toBeNull();
		expect(await store.revokeToken(alice, row.id, 40)).toBe(false);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — cannot resolve `../src/store/d1`.

- [ ] **Step 4: Implement the store**

`src/store/d1.ts`:

```ts
import { z } from "zod";
import {
	type EntryRow,
	EntryRowSchema,
	type HitRow,
	type TokenRow,
	TokenRowSchema,
	type UserRow,
	UserRowSchema,
} from "../core/rows";

export type IdentityProvider = "github" | "google";

export interface IdentityInput {
	provider: IdentityProvider;
	subject: string;
	email: string | null;
	displayName: string | null;
}

const GlobalRepeatRowSchema = z.object({
	category: z.string(),
	display_name: z.string(),
	hit_count: z.number().int(),
	distinct_users: z.number().int(),
});
export type GlobalRepeatRow = z.infer<typeof GlobalRepeatRowSchema>;

export interface UserRepeatRow {
	entry: EntryRow;
	phrasings: string[];
}

export const MAX_PHRASINGS = 10;
export const CANDIDATE_SCAN_LIMIT = 5000;
/** D1 allows 100 bound parameters per query; leave room for fixed parameters. */
const MAX_IN_LIST = 90;

const ENTRY_COLUMNS =
	"id, user_id, category, display_name, normalized, vector_status, hit_count, created_at";
const TOKEN_COLUMNS = "id, user_id, token_hash, label, created_at, last_used_at, revoked_at";

const UserIdRow = z.object({ user_id: z.string() });
const IdRow = z.object({ id: z.string() });
const PhrasingRow = z.object({ entry_id: z.string(), candidate_text: z.string() });

export function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function placeholders(count: number, firstIndex: number): string {
	return Array.from({ length: count }, (_, i) => `?${firstIndex + i}`).join(", ");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export class LedgerStore {
	constructor(private readonly db: D1Database) {}

	async findOrCreateUserByIdentity(
		identity: IdentityInput,
		now: number,
		newId: () => string,
	): Promise<string> {
		const existing = await this.findUserIdByIdentity(identity);
		if (existing) return existing;
		const userId = newId();
		try {
			await this.db.batch([
				this.db
					.prepare("INSERT INTO users (id, display_name, email, created_at) VALUES (?1, ?2, ?3, ?4)")
					.bind(userId, identity.displayName, identity.email, now),
				this.db
					.prepare(
						"INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
					)
					.bind(identity.provider, identity.subject, userId, identity.email, now),
			]);
			return userId;
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			const raced = await this.findUserIdByIdentity(identity);
			if (!raced) throw error;
			return raced;
		}
	}

	private async findUserIdByIdentity(identity: IdentityInput): Promise<string | null> {
		const row = await this.db
			.prepare("SELECT user_id FROM identities WHERE provider = ?1 AND subject = ?2")
			.bind(identity.provider, identity.subject)
			.first();
		return row ? UserIdRow.parse(row).user_id : null;
	}

	async getUser(userId: string): Promise<UserRow | null> {
		const row = await this.db
			.prepare("SELECT id, display_name, email, created_at FROM users WHERE id = ?1")
			.bind(userId)
			.first();
		return row ? UserRowSchema.parse(row) : null;
	}

	async deleteUser(userId: string): Promise<string[]> {
		const { results } = await this.db
			.prepare("SELECT id FROM entries WHERE user_id = ?1")
			.bind(userId)
			.all();
		await this.db.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();
		return results.map((row) => IdRow.parse(row).id);
	}

	async listCandidates(
		userId: string,
		category: string,
		limit: number = CANDIDATE_SCAN_LIMIT,
	): Promise<EntryRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND category = ?2 ORDER BY created_at DESC LIMIT ?3`,
			)
			.bind(userId, category, limit)
			.all();
		return results.map((row) => EntryRowSchema.parse(row));
	}

	async getEntriesByIds(
		userId: string,
		category: string,
		ids: readonly string[],
	): Promise<EntryRow[]> {
		const rows: EntryRow[] = [];
		for (const batch of chunk(ids, MAX_IN_LIST)) {
			const { results } = await this.db
				.prepare(
					`SELECT ${ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND category = ?2 AND id IN (${placeholders(batch.length, 3)})`,
				)
				.bind(userId, category, ...batch)
				.all();
			rows.push(...results.map((row) => EntryRowSchema.parse(row)));
		}
		return rows;
	}

	async insertEntry(row: EntryRow): Promise<"inserted" | "duplicate"> {
		try {
			await this.db
				.prepare(
					`INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
				)
				.bind(
					row.id,
					row.user_id,
					row.category,
					row.display_name,
					row.normalized,
					row.vector_status,
					row.hit_count,
					row.created_at,
				)
				.run();
			return "inserted";
		} catch (error) {
			if (isUniqueViolation(error)) return "duplicate";
			throw error;
		}
	}

	async markIndexed(ids: readonly string[]): Promise<void> {
		for (const batch of chunk(ids, MAX_IN_LIST)) {
			await this.db
				.prepare(
					`UPDATE entries SET vector_status = 'indexed' WHERE id IN (${placeholders(batch.length, 1)})`,
				)
				.bind(...batch)
				.run();
		}
	}

	async listPending(limit: number): Promise<EntryRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries WHERE vector_status = 'pending' ORDER BY created_at LIMIT ?1`,
			)
			.bind(limit)
			.all();
		return results.map((row) => EntryRowSchema.parse(row));
	}

	async listEntries(
		userId: string,
		options: { category?: string; limit: number; sinceMs?: number },
	): Promise<EntryRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries
				 WHERE user_id = ?1 AND (?2 IS NULL OR category = ?2) AND (?3 IS NULL OR created_at >= ?3)
				 ORDER BY created_at DESC LIMIT ?4`,
			)
			.bind(userId, options.category ?? null, options.sinceMs ?? null, options.limit)
			.all();
		return results.map((row) => EntryRowSchema.parse(row));
	}

	async deleteEntry(userId: string, entryId: string): Promise<boolean> {
		const result = await this.db
			.prepare("DELETE FROM entries WHERE id = ?1 AND user_id = ?2")
			.bind(entryId, userId)
			.run();
		return result.meta.changes > 0;
	}

	async recordHit(hit: HitRow): Promise<void> {
		await this.db.batch([
			this.db
				.prepare(
					`INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
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
				),
			this.db.prepare("UPDATE entries SET hit_count = hit_count + 1 WHERE id = ?1").bind(hit.entry_id),
		]);
	}

	async topRepeatsForUser(
		userId: string,
		category: string | undefined,
		limit: number,
	): Promise<UserRepeatRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries
				 WHERE user_id = ?1 AND hit_count > 0 AND (?2 IS NULL OR category = ?2)
				 ORDER BY hit_count DESC, created_at DESC LIMIT ?3`,
			)
			.bind(userId, category ?? null, limit)
			.all();
		const entries = results.map((row) => EntryRowSchema.parse(row));
		const phrasings = new Map<string, string[]>(entries.map((entry) => [entry.id, []]));
		for (const batch of chunk(
			entries.map((entry) => entry.id),
			MAX_IN_LIST,
		)) {
			const hits = await this.db
				.prepare(
					`SELECT entry_id, candidate_text FROM hits WHERE entry_id IN (${placeholders(batch.length, 1)}) ORDER BY created_at DESC`,
				)
				.bind(...batch)
				.all();
			for (const raw of hits.results) {
				const hit = PhrasingRow.parse(raw);
				const list = phrasings.get(hit.entry_id);
				if (list && list.length < MAX_PHRASINGS) list.push(hit.candidate_text);
			}
		}
		return entries.map((entry) => ({ entry, phrasings: phrasings.get(entry.id) ?? [] }));
	}

	async globalRepeats(
		category: string | undefined,
		minUsers: number,
		limit: number,
	): Promise<GlobalRepeatRow[]> {
		const { results } = await this.db
			.prepare(
				`WITH grouped AS (
				   SELECT e.category AS category, e.normalized AS normalized,
				          COUNT(*) AS hit_count, COUNT(DISTINCT h.user_id) AS distinct_users
				   FROM hits h JOIN entries e ON e.id = h.entry_id
				   WHERE (?1 IS NULL OR e.category = ?1)
				   GROUP BY e.category, e.normalized
				   HAVING COUNT(DISTINCT h.user_id) >= ?2
				 )
				 SELECT g.category, g.hit_count, g.distinct_users,
				        (SELECT e2.display_name FROM entries e2
				         WHERE e2.category = g.category AND e2.normalized = g.normalized
				         GROUP BY e2.display_name
				         ORDER BY COUNT(*) DESC, e2.display_name ASC LIMIT 1) AS display_name
				 FROM grouped g
				 ORDER BY g.hit_count DESC, g.category, g.normalized
				 LIMIT ?3`,
			)
			.bind(category ?? null, minUsers, limit)
			.all();
		return results.map((row) => GlobalRepeatRowSchema.parse(row));
	}

	async insertToken(row: TokenRow): Promise<void> {
		await this.db
			.prepare(`INSERT INTO api_tokens (${TOKEN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
			.bind(
				row.id,
				row.user_id,
				row.token_hash,
				row.label,
				row.created_at,
				row.last_used_at,
				row.revoked_at,
			)
			.run();
	}

	async findActiveTokenByHash(hash: string): Promise<TokenRow | null> {
		const row = await this.db
			.prepare(
				`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL`,
			)
			.bind(hash)
			.first();
		return row ? TokenRowSchema.parse(row) : null;
	}

	async touchToken(tokenId: string, now: number): Promise<void> {
		await this.db
			.prepare("UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1")
			.bind(tokenId, now)
			.run();
	}

	async listTokens(userId: string): Promise<TokenRow[]> {
		const { results } = await this.db
			.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC`)
			.bind(userId)
			.all();
		return results.map((row) => TokenRowSchema.parse(row));
	}

	async revokeToken(userId: string, tokenId: string, now: number): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
			)
			.bind(tokenId, userId, now)
			.run();
		return result.meta.changes > 0;
	}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/store.test.ts`
Expected: PASS. If `globalRepeats` returns `display_name: null` for a group, the correlated subquery is not matching — check that `category`/`normalized` come from `grouped`, not from the outer `entries` alias.

- [ ] **Step 6: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/store/d1.ts test/helpers.ts test/store.test.ts
git commit -m "feat: add typed D1 store for users, entries, hits and tokens" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 5: Semantic index and the claim/check core

**Files:**
- Create: `src/config.ts`, `src/semantic/index.ts`, `src/semantic/cloudflare.ts`, `src/core/ledger.ts`, `src/services.ts`, `test/fakes/semantic.ts`
- Test: `test/config.test.ts`, `test/ledger-claim.test.ts`

**Interfaces:**
- Consumes: `LedgerStore` (Task 4); `normalize` (Task 2); `findLexicalMatches`, `classifySemanticHits`, `rankMatches`, `isLikelyRepeat`, `MAX_MATCHES`, `Thresholds`, `SemanticHit`, `ScoredMatch` (Task 3); `toWireEntry`, `toWireMatch` (Task 3); `LedgerError` (Task 3); `ClaimInput`, `ClaimResult`, `CheckInput`, `CheckResult`, `SemanticStatus` (Task 3); `Env` (Task 1).
- Produces:
  - `src/config.ts` — `DEFAULT_THRESHOLDS: Thresholds`, `thresholdsFromEnv(env): Thresholds`, `globalMinUsersFromEnv(env): number`
  - `src/semantic/index.ts` — `interface SemanticDocument { entryId: string; userId: string; category: string; text: string }`, `interface SemanticQuery { userId: string; category: string; text: string; topK: number }`, `interface SemanticIndex { query(q): Promise<SemanticHit[]>; upsert(docs: readonly SemanticDocument[]): Promise<void>; remove(entryIds: readonly string[]): Promise<void> }`, `class UnavailableSemanticIndex`
  - `src/semantic/cloudflare.ts` — `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS = 768`, `class CloudflareSemanticIndex(ai: Ai, vectors: Vectorize)`, `semanticIndexFromEnv(env: Pick<Env, "AI" | "VECTORS">): SemanticIndex`
  - `src/core/ledger.ts` — `interface LedgerDeps { store: LedgerStore; semantic: SemanticIndex; thresholds: Thresholds; now: () => number; newId: () => string }`, `BACKFILL_BATCH = 100`, `class Ledger` with `check(userId, input: CheckInput): Promise<CheckResult>`, `claim(userId, input: ClaimInput): Promise<ClaimResult>`, `backfill(limit?: number): Promise<number>` (Task 6 adds more methods)
  - `src/services.ts` — `ledgerFromEnv(env: Env): Ledger`
  - `test/fakes/semantic.ts` — `class FakeSemanticIndex implements SemanticIndex` with `documents: Map<string, SemanticDocument>`, `failing: boolean`, `setSimilarity(a: string, b: string, score: number): void`

A semantic failure never fails a request: `query` failures yield `semantic: "unavailable"` and `upsert` failures leave the entry `pending` for the cron backfill.

- [ ] **Step 1: Make test files run serially**

The backfill test indexes *every* pending row in the shared local D1, which could race another file's pending-row assertions. In `vitest.config.ts` change the `test` block to:

```ts
	test: {
		setupFiles: ["./test/setup.ts"],
		// All files share one local D1; the backfill test touches rows it did not create.
		fileParallelism: false,
	},
```

- [ ] **Step 2: Write the fake semantic index**

`test/fakes/semantic.ts`:

```ts
import type { SemanticHit } from "../../src/core/match";
import type { SemanticDocument, SemanticIndex, SemanticQuery } from "../../src/semantic/index";

/**
 * Deterministic in-memory SemanticIndex. Texts equal ignoring case score 1; pairs registered
 * with setSimilarity score that value; everything else scores 0 and is not returned.
 */
export class FakeSemanticIndex implements SemanticIndex {
	readonly documents = new Map<string, SemanticDocument>();
	failing = false;
	private readonly scores = new Map<string, number>();

	setSimilarity(a: string, b: string, score: number): void {
		this.scores.set(this.pairKey(a, b), score);
	}

	async query(query: SemanticQuery): Promise<SemanticHit[]> {
		this.assertAvailable();
		const hits: SemanticHit[] = [];
		for (const doc of this.documents.values()) {
			if (doc.userId !== query.userId || doc.category !== query.category) continue;
			const score =
				doc.text.toLowerCase() === query.text.toLowerCase()
					? 1
					: (this.scores.get(this.pairKey(doc.text, query.text)) ?? 0);
			if (score > 0) hits.push({ entryId: doc.entryId, score });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, query.topK);
	}

	async upsert(documents: readonly SemanticDocument[]): Promise<void> {
		this.assertAvailable();
		for (const doc of documents) this.documents.set(doc.entryId, doc);
	}

	async remove(entryIds: readonly string[]): Promise<void> {
		this.assertAvailable();
		for (const id of entryIds) this.documents.delete(id);
	}

	private pairKey(a: string, b: string): string {
		return [a.toLowerCase(), b.toLowerCase()].sort().join("\u0000");
	}

	private assertAvailable(): void {
		if (this.failing) throw new Error("fake semantic index is failing");
	}
}
```

- [ ] **Step 3: Write the failing tests**

`test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, globalMinUsersFromEnv, thresholdsFromEnv } from "../src/config";

const vars = {
	TRIGRAM_REPEAT_THRESHOLD: "0.6",
	SEMANTIC_REPEAT_THRESHOLD: "0.85",
	SEMANTIC_POSSIBLE_THRESHOLD: "0.75",
	GLOBAL_MIN_USERS: "2",
};

describe("config", () => {
	it("parses thresholds from string vars", () => {
		expect(thresholdsFromEnv(vars)).toEqual(DEFAULT_THRESHOLDS);
		expect(thresholdsFromEnv({ ...vars, SEMANTIC_REPEAT_THRESHOLD: "0.9" }).semanticRepeat).toBe(0.9);
	});

	it("falls back to defaults for blank vars", () => {
		expect(thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "" }).trigramRepeat).toBe(0.6);
	});

	it("rejects non-numeric values and a possible threshold above the repeat threshold", () => {
		expect(() => thresholdsFromEnv({ ...vars, TRIGRAM_REPEAT_THRESHOLD: "high" })).toThrow(
			/TRIGRAM_REPEAT_THRESHOLD/,
		);
		expect(() => thresholdsFromEnv({ ...vars, SEMANTIC_POSSIBLE_THRESHOLD: "0.95" })).toThrow(
			/SEMANTIC_POSSIBLE_THRESHOLD/,
		);
	});

	it("parses GLOBAL_MIN_USERS as a positive integer", () => {
		expect(globalMinUsersFromEnv(vars)).toBe(2);
		expect(() => globalMinUsersFromEnv({ GLOBAL_MIN_USERS: "0" })).toThrow(/GLOBAL_MIN_USERS/);
		expect(() => globalMinUsersFromEnv({ GLOBAL_MIN_USERS: "1.5" })).toThrow(/GLOBAL_MIN_USERS/);
	});
});
```

`test/ledger-claim.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../src/config";
import { LedgerError } from "../src/core/errors";
import { Ledger } from "../src/core/ledger";
import { FakeSemanticIndex } from "./fakes/semantic";
import { seedUser, testStore, uniqueCategory } from "./helpers";

function makeLedger(semantic = new FakeSemanticIndex()): Ledger {
	return new Ledger({
		store: testStore(),
		semantic,
		thresholds: DEFAULT_THRESHOLDS,
		now: () => Date.now(),
		newId: () => crypto.randomUUID(),
	});
}

async function hitCount(userId: string, category: string, entryId: string): Promise<number> {
	const rows = await testStore().listEntries(userId, { category, limit: 100 });
	return rows.find((row) => row.id === entryId)?.hit_count ?? -1;
}

describe("Ledger.claim", () => {
	it("claims a new topic and indexes it", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const category = uniqueCategory();

		const result = await ledger.claim(userId, { category, name: "Euler's Identity", force: false });

		expect(result.status).toBe("claimed");
		if (result.status !== "claimed") return;
		expect(result.entry.display_name).toBe("Euler's Identity");
		expect(result).toMatchObject({ forced: false, possible_matches: [], semantic: "ok" });
		expect(semantic.documents.get(result.entry.id)?.text).toBe("Euler's Identity");
		const pending = await testStore().listPending(1000);
		expect(pending.some((row) => row.id === result.entry.id)).toBe(false);
	});

	it("blocks an exact repeat and records a hit", async () => {
		const ledger = makeLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's Identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const again = await ledger.claim(userId, { category, name: "euler identity", force: false });

		expect(again.status).toBe("repeat");
		if (again.status !== "repeat") return;
		expect(again.matches[0]).toMatchObject({ entry_id: first.entry.id, kind: "exact", hit_count: 1 });
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});

	it("blocks a trigram repeat", async () => {
		const ledger = makeLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Srinivasa Ramanujan", force: false });

		const result = await ledger.claim(userId, { category, name: "Srinivasa Ramanujam", force: false });

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") expect(result.matches[0]?.kind).toBe("trigram");
	});

	it("blocks a semantic repeat at or above the repeat threshold", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.9);
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Euler's identity", force: false });

		const result = await ledger.claim(userId, { category, name: "e^(iπ)+1=0", force: false });

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") {
			expect(result.matches[0]).toMatchObject({ kind: "semantic", confidence: "repeat", score: 0.9 });
		}
	});

	it("claims but reports possible matches between the two semantic thresholds, without a hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Fermat's Last Theorem", "Wiles' proof", 0.8);
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Fermat's Last Theorem", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Wiles' proof", force: false });

		expect(result.status).toBe("claimed");
		if (result.status === "claimed") {
			expect(result.forced).toBe(false);
			expect(result.possible_matches).toMatchObject([
				{ entry_id: first.entry.id, confidence: "possible" },
			]);
		}
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});

	it("force overrides a semantic repeat, returns the overridden matches, and records no hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "Euler's totient", 0.9);
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Euler's totient", force: true });

		expect(result.status).toBe("claimed");
		if (result.status === "claimed") {
			expect(result.forced).toBe(true);
			expect(result.possible_matches).toMatchObject([{ entry_id: first.entry.id, confidence: "repeat" }]);
		}
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});

	it("force does not override an exact match, and the repeat records a hit", async () => {
		const ledger = makeLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Gauss", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Gauss", force: true });

		expect(result.status).toBe("repeat");
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});

	it("never matches another user's entries", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeLedger(semantic);
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		await ledger.claim(alice, { category, name: "Noether", force: false });

		expect((await ledger.claim(bob, { category, name: "Noether", force: false })).status).toBe("claimed");
	});

	it("rejects names without letters or digits", async () => {
		const ledger = makeLedger();
		const userId = await seedUser();
		await expect(
			ledger.claim(userId, { category: uniqueCategory(), name: "!!!", force: false }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(ledger.check(userId, { category: uniqueCategory(), name: "?" })).rejects.toBeInstanceOf(
			LedgerError,
		);
	});
});

describe("Ledger.check", () => {
	it("reports a likely repeat without recording a hit", async () => {
		const ledger = makeLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Noether", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.check(userId, { category, name: "noether" });

		expect(result).toMatchObject({ likely_repeat: true, semantic: "ok" });
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});
});

describe("semantic degradation and backfill", () => {
	it("claims with semantic unavailable, still blocks exact repeats, then backfills", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.failing = true;
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const category = uniqueCategory();

		const claimed = await ledger.claim(userId, { category, name: "Lovelace", force: false });
		expect(claimed).toMatchObject({ status: "claimed", semantic: "unavailable" });
		if (claimed.status !== "claimed") return;
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(true);

		const repeat = await ledger.claim(userId, { category, name: "lovelace", force: false });
		expect(repeat).toMatchObject({ status: "repeat", semantic: "unavailable" });

		semantic.failing = false;
		expect(await ledger.backfill(1000)).toBeGreaterThanOrEqual(1);
		expect(semantic.documents.has(claimed.entry.id)).toBe(true);
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(false);
	});

	it("backfill returns 0 and leaves rows pending when the index is still failing", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.failing = true;
		const ledger = makeLedger(semantic);
		const userId = await seedUser();
		const claimed = await ledger.claim(userId, { category: uniqueCategory(), name: "Hopper", force: false });
		if (claimed.status !== "claimed") throw new Error("expected claimed");

		expect(await ledger.backfill(1000)).toBe(0);
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(true);
	});
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts test/ledger-claim.test.ts`
Expected: FAIL — cannot resolve `../src/config`, `../src/core/ledger`, `../../src/semantic/index`.

- [ ] **Step 5: Implement config and the semantic index**

`src/config.ts`:

```ts
import type { Thresholds } from "./core/match";
import type { Env } from "./env";

export const DEFAULT_THRESHOLDS: Thresholds = {
	trigramRepeat: 0.6,
	semanticRepeat: 0.85,
	semanticPossible: 0.75,
};

const DEFAULT_GLOBAL_MIN_USERS = 2;

function readNumber(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
	return value;
}

export function thresholdsFromEnv(
	env: Pick<
		Env,
		"TRIGRAM_REPEAT_THRESHOLD" | "SEMANTIC_REPEAT_THRESHOLD" | "SEMANTIC_POSSIBLE_THRESHOLD"
	>,
): Thresholds {
	const thresholds: Thresholds = {
		trigramRepeat: readNumber(
			"TRIGRAM_REPEAT_THRESHOLD",
			env.TRIGRAM_REPEAT_THRESHOLD,
			DEFAULT_THRESHOLDS.trigramRepeat,
		),
		semanticRepeat: readNumber(
			"SEMANTIC_REPEAT_THRESHOLD",
			env.SEMANTIC_REPEAT_THRESHOLD,
			DEFAULT_THRESHOLDS.semanticRepeat,
		),
		semanticPossible: readNumber(
			"SEMANTIC_POSSIBLE_THRESHOLD",
			env.SEMANTIC_POSSIBLE_THRESHOLD,
			DEFAULT_THRESHOLDS.semanticPossible,
		),
	};
	if (thresholds.semanticPossible > thresholds.semanticRepeat) {
		throw new Error("SEMANTIC_POSSIBLE_THRESHOLD must not exceed SEMANTIC_REPEAT_THRESHOLD");
	}
	return thresholds;
}

export function globalMinUsersFromEnv(env: Pick<Env, "GLOBAL_MIN_USERS">): number {
	const value = readNumber("GLOBAL_MIN_USERS", env.GLOBAL_MIN_USERS, DEFAULT_GLOBAL_MIN_USERS);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`GLOBAL_MIN_USERS must be a positive integer, got "${env.GLOBAL_MIN_USERS}"`);
	}
	return value;
}
```

`src/semantic/index.ts`:

```ts
import type { SemanticHit } from "../core/match";

export interface SemanticDocument {
	entryId: string;
	userId: string;
	category: string;
	/** Raw display name — never the normalized form. */
	text: string;
}

export interface SemanticQuery {
	userId: string;
	category: string;
	text: string;
	topK: number;
}

/** Any method may throw; callers treat a throw as "semantic layer unavailable". */
export interface SemanticIndex {
	query(query: SemanticQuery): Promise<SemanticHit[]>;
	upsert(documents: readonly SemanticDocument[]): Promise<void>;
	remove(entryIds: readonly string[]): Promise<void>;
}

export class UnavailableSemanticIndex implements SemanticIndex {
	async query(): Promise<SemanticHit[]> {
		throw new Error("semantic index is not configured");
	}

	async upsert(): Promise<void> {
		throw new Error("semantic index is not configured");
	}

	async remove(): Promise<void> {
		throw new Error("semantic index is not configured");
	}
}
```

`src/semantic/cloudflare.ts`:

```ts
import type { SemanticHit } from "../core/match";
import type { Env } from "../env";
import {
	type SemanticDocument,
	type SemanticIndex,
	type SemanticQuery,
	UnavailableSemanticIndex,
} from "./index";

export const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
export const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export class CloudflareSemanticIndex implements SemanticIndex {
	constructor(
		private readonly ai: Ai,
		private readonly vectors: Vectorize,
	) {}

	async query(query: SemanticQuery): Promise<SemanticHit[]> {
		const [vector] = await this.embed([query.text]);
		if (!vector) throw new Error("embedding model returned no vector");
		const result = await this.vectors.query(vector, {
			topK: query.topK,
			filter: { user_id: { $eq: query.userId }, category: { $eq: query.category } },
		});
		return result.matches.map((match) => ({ entryId: match.id, score: match.score }));
	}

	async upsert(documents: readonly SemanticDocument[]): Promise<void> {
		for (const batch of chunk(documents, BATCH_SIZE)) {
			const embeddings = await this.embed(batch.map((doc) => doc.text));
			await this.vectors.upsert(
				batch.map((doc, i) => {
					const values = embeddings[i];
					if (!values) throw new Error(`missing embedding for entry ${doc.entryId}`);
					return {
						id: doc.entryId,
						values,
						metadata: { user_id: doc.userId, category: doc.category },
					};
				}),
			);
		}
	}

	async remove(entryIds: readonly string[]): Promise<void> {
		for (const batch of chunk(entryIds, BATCH_SIZE)) {
			await this.vectors.deleteByIds(batch);
		}
	}

	private async embed(texts: string[]): Promise<number[][]> {
		const output = await this.ai.run(EMBEDDING_MODEL, { text: texts });
		if (output.data.length !== texts.length) {
			throw new Error(`expected ${texts.length} embeddings, got ${output.data.length}`);
		}
		return output.data;
	}
}

export function semanticIndexFromEnv(env: Pick<Env, "AI" | "VECTORS">): SemanticIndex {
	if (!env.AI || !env.VECTORS) return new UnavailableSemanticIndex();
	return new CloudflareSemanticIndex(env.AI, env.VECTORS);
}
```

If `tsc` rejects `this.ai.run(EMBEDDING_MODEL, …)` because `EMBEDDING_MODEL` widened to `string`, declare it `export const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m" as const;`. Do not cast the output.

- [ ] **Step 6: Implement the ledger core and service wiring**

`src/core/ledger.ts`:

```ts
import type {
	CheckInput,
	CheckResult,
	ClaimInput,
	ClaimResult,
	SemanticStatus,
} from "../api/schemas";
import type { SemanticIndex } from "../semantic/index";
import type { LedgerStore } from "../store/d1";
import { LedgerError } from "./errors";
import {
	classifySemanticHits,
	findLexicalMatches,
	isLikelyRepeat,
	MAX_MATCHES,
	rankMatches,
	type ScoredMatch,
	type SemanticHit,
	type Thresholds,
} from "./match";
import { normalize } from "./normalize";
import type { EntryRow } from "./rows";
import { toWireEntry, toWireMatch } from "./wire";

export interface LedgerDeps {
	store: LedgerStore;
	semantic: SemanticIndex;
	thresholds: Thresholds;
	now: () => number;
	newId: () => string;
}

interface Evaluation {
	normalized: string;
	matches: ScoredMatch[];
	semantic: SemanticStatus;
}

export const BACKFILL_BATCH = 100;

export class Ledger {
	constructor(private readonly deps: LedgerDeps) {}

	async check(userId: string, input: CheckInput): Promise<CheckResult> {
		const evaluation = await this.evaluate(userId, input.category, input.name);
		return {
			likely_repeat: isLikelyRepeat(evaluation.matches),
			matches: evaluation.matches.map((match) => toWireMatch(match)),
			semantic: evaluation.semantic,
		};
	}

	claim(userId: string, input: ClaimInput): Promise<ClaimResult> {
		return this.claimOnce(userId, input, false);
	}

	async backfill(limit: number = BACKFILL_BATCH): Promise<number> {
		const { store, semantic } = this.deps;
		const pending = await store.listPending(limit);
		if (pending.length === 0) return 0;
		try {
			await semantic.upsert(
				pending.map((entry) => ({
					entryId: entry.id,
					userId: entry.user_id,
					category: entry.category,
					text: entry.display_name,
				})),
			);
		} catch (error) {
			console.warn("backfill upsert failed", { count: pending.length, error: String(error) });
			return 0;
		}
		await store.markIndexed(pending.map((entry) => entry.id));
		return pending.length;
	}

	private async claimOnce(userId: string, input: ClaimInput, isRetry: boolean): Promise<ClaimResult> {
		const { store, semantic, now, newId } = this.deps;
		const evaluation = await this.evaluate(userId, input.category, input.name);
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
			created_at: now(),
		};
		if ((await store.insertEntry(entry)) === "duplicate") {
			// A concurrent claim inserted the same normalized name; re-evaluating yields an exact repeat.
			if (isRetry) {
				throw new LedgerError("upstream_unavailable", "topic claim conflicted twice; retry");
			}
			return this.claimOnce(userId, input, true);
		}

		let semanticStatus = evaluation.semantic;
		try {
			await semantic.upsert([
				{ entryId: entry.id, userId, category: entry.category, text: entry.display_name },
			]);
			await store.markIndexed([entry.id]);
		} catch (error) {
			console.warn("semantic upsert failed; entry left pending", {
				entryId: entry.id,
				error: String(error),
			});
			semanticStatus = "unavailable";
		}

		const forced = best !== undefined;
		const nonBlocking = forced
			? evaluation.matches
			: evaluation.matches.filter((match) => match.confidence === "possible");
		return {
			status: "claimed",
			entry: toWireEntry(entry),
			forced,
			possible_matches: nonBlocking.map((match) => toWireMatch(match)),
			semantic: semanticStatus,
		};
	}

	private async evaluate(userId: string, category: string, name: string): Promise<Evaluation> {
		const normalized = normalize(name);
		if (normalized.length === 0) {
			throw new LedgerError("invalid_input", "name must contain at least one letter or digit");
		}
		const candidates = await this.deps.store.listCandidates(userId, category);
		const lexical = findLexicalMatches(normalized, candidates, this.deps.thresholds);
		const semantic = await this.semanticMatches(userId, category, name, candidates);
		return {
			normalized,
			matches: rankMatches([...lexical, ...semantic.matches]),
			semantic: semantic.status,
		};
	}

	private async semanticMatches(
		userId: string,
		category: string,
		name: string,
		candidates: readonly EntryRow[],
	): Promise<{ matches: ScoredMatch[]; status: SemanticStatus }> {
		let hits: SemanticHit[];
		try {
			hits = await this.deps.semantic.query({ userId, category, text: name, topK: MAX_MATCHES });
		} catch (error) {
			console.warn("semantic query failed", { error: String(error) });
			return { matches: [], status: "unavailable" };
		}
		const byId = new Map(candidates.map((entry) => [entry.id, entry]));
		const missing = hits.map((hit) => hit.entryId).filter((id) => !byId.has(id));
		for (const row of await this.deps.store.getEntriesByIds(userId, category, missing)) {
			byId.set(row.id, row);
		}
		return { matches: classifySemanticHits(hits, byId, this.deps.thresholds), status: "ok" };
	}
}
```

Note `forced` is `best !== undefined` because reaching the insert with a repeat-confidence `best` is only possible when `input.force` is true and `best` is not exact.

`src/services.ts`:

```ts
import { thresholdsFromEnv } from "./config";
import { Ledger } from "./core/ledger";
import type { Env } from "./env";
import { semanticIndexFromEnv } from "./semantic/cloudflare";
import { LedgerStore } from "./store/d1";

export function ledgerFromEnv(env: Env): Ledger {
	return new Ledger({
		store: new LedgerStore(env.DB),
		semantic: semanticIndexFromEnv(env),
		thresholds: thresholdsFromEnv(env),
		now: () => Date.now(),
		newId: () => crypto.randomUUID(),
	});
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts test/ledger-claim.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass (including the earlier test files, now running serially).

```bash
git add vitest.config.ts src/config.ts src/semantic src/core/ledger.ts src/services.ts test/fakes test/config.test.ts test/ledger-claim.test.ts
git commit -m "feat: add claim/check core with semantic index and backfill" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 6: List, forget, stats and account deletion

**Files:**
- Modify: `src/core/ledger.ts` (add four methods), `test/helpers.ts` (add `makeTestLedger`, `steppingClock`), `test/ledger-claim.test.ts` (use the shared helper)
- Test: `test/ledger-admin.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `LedgerDeps` (Task 5); `LedgerStore.listEntries`, `deleteEntry`, `topRepeatsForUser`, `globalRepeats`, `deleteUser` (Task 4); `ListInput`, `ListResult`, `StatsInput`, `StatsResult` (Task 3); `FakeSemanticIndex` (Task 5).
- Produces:
  - `Ledger.list(userId: string, input: ListInput): Promise<ListResult>`
  - `Ledger.forget(userId: string, entryId: string): Promise<void>` — throws `LedgerError("not_found")` when the entry does not exist or belongs to someone else
  - `Ledger.stats(userId: string, input: StatsInput, globalMinUsers: number): Promise<StatsResult>`
  - `Ledger.deleteAccount(userId: string): Promise<void>` — deletes D1 rows (cascade) and the user's vectors; OAuth grants are revoked by the caller (Task 11)
  - `test/helpers.ts`: `makeTestLedger(options?: { semantic?: SemanticIndex; now?: () => number }): Ledger`, `steppingClock(start?: number): () => number`

- [ ] **Step 1: Add shared ledger test helpers**

Append to `test/helpers.ts` (and add the imports at the top of the file):

```ts
import { DEFAULT_THRESHOLDS } from "../src/config";
import { Ledger } from "../src/core/ledger";
import type { SemanticIndex } from "../src/semantic/index";
import { FakeSemanticIndex } from "./fakes/semantic";

export function makeTestLedger(options: { semantic?: SemanticIndex; now?: () => number } = {}): Ledger {
	return new Ledger({
		store: testStore(),
		semantic: options.semantic ?? new FakeSemanticIndex(),
		thresholds: DEFAULT_THRESHOLDS,
		now: options.now ?? (() => Date.now()),
		newId: () => crypto.randomUUID(),
	});
}

/** Strictly increasing timestamps, so "newest first" orderings are deterministic. */
export function steppingClock(start = 1_000): () => number {
	let current = start;
	return () => {
		current += 1;
		return current;
	};
}
```

In `test/ledger-claim.test.ts`, delete the local `makeLedger` function and its `DEFAULT_THRESHOLDS` / `Ledger` imports, import `makeTestLedger` from `./helpers`, and replace each `makeLedger(x)` call with `makeTestLedger({ semantic: x })` (and `makeLedger()` with `makeTestLedger()`).

Run: `npx vitest run test/ledger-claim.test.ts`
Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write the failing tests**

`test/ledger-admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeTestLedger, seedUser, steppingClock, testStore, uniqueCategory } from "./helpers";

async function claimed(
	ledger: ReturnType<typeof makeTestLedger>,
	userId: string,
	category: string,
	name: string,
): Promise<string> {
	const result = await ledger.claim(userId, { category, name, force: false });
	if (result.status !== "claimed") throw new Error(`expected ${name} to be claimed`);
	return result.entry.id;
}

describe("Ledger.list", () => {
	it("returns the user's entries newest first, filtered by category and since", async () => {
		const ledger = makeTestLedger({ now: steppingClock(Date.UTC(2026, 8, 14)) });
		const userId = await seedUser();
		const math = uniqueCategory();
		const people = uniqueCategory();
		const first = await claimed(ledger, userId, math, "Gauss");
		const second = await claimed(ledger, userId, math, "Noether");
		await claimed(ledger, userId, people, "Lovelace");

		const all = await ledger.list(userId, { category: math, limit: 20 });
		expect(all.entries.map((e) => e.id)).toEqual([second, first]);
		expect(all.entries[0]?.created_at).toBe(new Date(Date.UTC(2026, 8, 14) + 2).toISOString());

		const since = await ledger.list(userId, {
			category: math,
			limit: 20,
			since: new Date(Date.UTC(2026, 8, 14) + 2).toISOString(),
		});
		expect(since.entries.map((e) => e.id)).toEqual([second]);
	});
});

describe("Ledger.forget", () => {
	it("removes the owner's entry from D1 and the semantic index", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const entryId = await claimed(ledger, userId, category, "Hilbert");

		await ledger.forget(userId, entryId);

		expect((await ledger.list(userId, { category, limit: 20 })).entries).toEqual([]);
		expect(semantic.documents.has(entryId)).toBe(false);
	});

	it("throws not_found for unknown ids and for another user's entry", async () => {
		const ledger = makeTestLedger();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const entryId = await claimed(ledger, alice, category, "Cantor");

		await expect(ledger.forget(alice, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
		await expect(ledger.forget(bob, entryId)).rejects.toMatchObject({ code: "not_found" });
		expect((await ledger.list(alice, { category, limit: 20 })).entries).toHaveLength(1);
	});

	it("still deletes the D1 row when the semantic index fails", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const entryId = await claimed(ledger, userId, category, "Turing");
		semantic.failing = true;

		await ledger.forget(userId, entryId);

		expect((await ledger.list(userId, { category, limit: 20 })).entries).toEqual([]);
	});
});

describe("Ledger.stats", () => {
	it("scope me ranks the user's repeated entries with newest phrasings first", async () => {
		const ledger = makeTestLedger({ now: steppingClock() });
		const userId = await seedUser();
		const category = uniqueCategory();
		await claimed(ledger, userId, category, "Euler's Identity");
		await claimed(ledger, userId, category, "Gauss");
		await ledger.claim(userId, { category, name: "euler identity", force: false });
		await ledger.claim(userId, { category, name: "Euler’s identity", force: false });

		const stats = await ledger.stats(userId, { scope: "me", category, limit: 20 }, 2);

		expect(stats).toEqual({
			scope: "me",
			repeats: [
				{
					display_name: "Euler's Identity",
					category,
					hit_count: 2,
					recent_phrasings: ["Euler’s identity", "euler identity"],
				},
			],
		});
	});

	it("scope global aggregates across users, hides topics below the minimum, and exposes no identities", async () => {
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		for (const userId of [alice, bob]) {
			await claimed(ledger, userId, category, "Euler's identity");
			await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		}
		await claimed(ledger, alice, category, "Obscure Lemma");
		await ledger.claim(alice, { category, name: "Obscure Lemma", force: false });

		const stats = await ledger.stats(alice, { scope: "global", category, limit: 20 }, 2);

		expect(stats).toEqual({
			scope: "global",
			repeats: [{ display_name: "Euler's identity", category, hit_count: 2, distinct_users: 2 }],
		});
		expect((await ledger.stats(alice, { scope: "global", category, limit: 20 }, 3)).repeats).toEqual([]);
	});
});

describe("Ledger.deleteAccount", () => {
	it("removes the user, their entries and their vectors", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const entryId = await claimed(ledger, userId, uniqueCategory(), "Hypatia");

		await ledger.deleteAccount(userId);

		expect(await testStore().getUser(userId)).toBeNull();
		expect(semantic.documents.has(entryId)).toBe(false);
		expect((await ledger.list(userId, { limit: 20 })).entries).toEqual([]);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/ledger-admin.test.ts`
Expected: FAIL — `ledger.list is not a function` (and likewise for `forget`, `stats`, `deleteAccount`).

- [ ] **Step 4: Implement the methods**

In `src/core/ledger.ts`, extend the schema import to include the new types:

```ts
import type {
	CheckInput,
	CheckResult,
	ClaimInput,
	ClaimResult,
	ListInput,
	ListResult,
	SemanticStatus,
	StatsInput,
	StatsResult,
} from "../api/schemas";
```

Add these methods to `class Ledger`, directly after `claim`:

```ts
	async list(userId: string, input: ListInput): Promise<ListResult> {
		const rows = await this.deps.store.listEntries(userId, {
			category: input.category,
			limit: input.limit,
			sinceMs: input.since === undefined ? undefined : Date.parse(input.since),
		});
		return { entries: rows.map(toWireEntry) };
	}

	async forget(userId: string, entryId: string): Promise<void> {
		if (!(await this.deps.store.deleteEntry(userId, entryId))) {
			throw new LedgerError("not_found", `no entry ${entryId}`);
		}
		try {
			await this.deps.semantic.remove([entryId]);
		} catch (error) {
			// Orphaned vectors are harmless: semantic hits are joined against D1.
			console.warn("vector delete failed", { entryId, error: String(error) });
		}
	}

	async stats(userId: string, input: StatsInput, globalMinUsers: number): Promise<StatsResult> {
		const { store } = this.deps;
		if (input.scope === "global") {
			const rows = await store.globalRepeats(input.category, globalMinUsers, input.limit);
			return {
				scope: "global",
				repeats: rows.map((row) => ({
					display_name: row.display_name,
					category: row.category,
					hit_count: row.hit_count,
					distinct_users: row.distinct_users,
				})),
			};
		}
		const rows = await store.topRepeatsForUser(userId, input.category, input.limit);
		return {
			scope: "me",
			repeats: rows.map((row) => ({
				display_name: row.entry.display_name,
				category: row.entry.category,
				hit_count: row.entry.hit_count,
				recent_phrasings: row.phrasings,
			})),
		};
	}

	async deleteAccount(userId: string): Promise<void> {
		const entryIds = await this.deps.store.deleteUser(userId);
		try {
			await this.deps.semantic.remove(entryIds);
		} catch (error) {
			console.warn("vector cleanup after account deletion failed", {
				count: entryIds.length,
				error: String(error),
			});
		}
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/ledger-admin.test.ts test/ledger-claim.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/core/ledger.ts test/helpers.ts test/ledger-claim.test.ts test/ledger-admin.test.ts
git commit -m "feat: add list, forget, stats and account deletion to the ledger" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 7: REST API

**Files:**
- Create: `src/api/context.ts`, `src/api/errors.ts`, `src/api/validate.ts`, `src/api/ratelimit.ts`, `src/api/rest.ts`
- Test: `test/rest.test.ts`

**Interfaces:**
- Consumes: `Ledger` (Tasks 5–6); `LedgerError` (Task 3); `ClaimInput`, `CheckInput`, `ListInput`, `StatsInput`, `ErrorBody`, `ErrorCode` (Task 3); `makeTestLedger`, `seedUser`, `uniqueCategory` (test helpers).
- Produces:
  - `src/api/context.ts` — `interface ApiContext { userId: string; ledger: Ledger; limiter: RateLimit; globalMinUsers: number }`
  - `src/api/errors.ts` — `ERROR_STATUS: Record<ErrorCode, number>`, `toErrorBody(error: unknown): { status: number; body: ErrorBody }`, `errorResponse(error: unknown): Response`
  - `src/api/validate.ts` — `parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S>`
  - `src/api/ratelimit.ts` — `enforceRateLimit(limiter: RateLimit, userId: string): Promise<void>`
  - `src/api/rest.ts` — `createRestApp()`: a Hono app with `Bindings: ApiContext`, mounted at `/api/v1`

Routes (all under `/api/v1`): `POST /claims`, `POST /checks`, `GET /entries`, `DELETE /entries/:id` (204), `GET /stats`. `claims` and `checks` are rate limited before validation. Unknown errors map to `upstream_unavailable` (503) and are logged.

- [ ] **Step 1: Write the failing tests**

`test/rest.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiContext } from "../src/api/context";
import { createRestApp } from "../src/api/rest";
import { CheckResult, ClaimResult, ErrorBody, ListResult, StatsResult } from "../src/api/schemas";
import { makeTestLedger, seedUser, uniqueCategory } from "./helpers";

async function context(overrides: Partial<ApiContext> = {}): Promise<ApiContext> {
	return {
		userId: await seedUser(),
		ledger: makeTestLedger(),
		limiter: env.CLAIM_LIMITER,
		globalMinUsers: 2,
		...overrides,
	};
}

function post(path: string, body: unknown, ctx: ApiContext): Promise<Response> {
	return createRestApp().request(
		path,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		ctx,
	);
}

describe("POST /api/v1/claims", () => {
	it("claims, then reports a repeat", async () => {
		const ctx = await context();
		const category = uniqueCategory();

		const first = await post("/api/v1/claims", { category, name: "Euler's Identity" }, ctx);
		expect(first.status).toBe(200);
		expect(ClaimResult.parse(await first.json()).status).toBe("claimed");

		const second = await post("/api/v1/claims", { category, name: "euler identity" }, ctx);
		expect(ClaimResult.parse(await second.json()).status).toBe("repeat");
	});

	it("rejects invalid input with a typed error body", async () => {
		const ctx = await context();
		const res = await post("/api/v1/claims", { name: "No category" }, ctx);
		expect(res.status).toBe(400);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("invalid_input");
	});

	it("rejects a non-JSON body", async () => {
		const ctx = await context();
		const res = await createRestApp().request(
			"/api/v1/claims",
			{ method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
			ctx,
		);
		expect(res.status).toBe(400);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("invalid_input");
	});

	it("returns 429 when the rate limiter refuses", async () => {
		const ctx = await context({ limiter: { limit: async () => ({ success: false }) } });
		const res = await post("/api/v1/claims", { category: uniqueCategory(), name: "Gauss" }, ctx);
		expect(res.status).toBe(429);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("rate_limited");
	});

	it("maps unexpected errors to 503 upstream_unavailable", async () => {
		const ctx = await context({
			limiter: {
				limit: async () => {
					throw new Error("boom");
				},
			},
		});
		const res = await post("/api/v1/claims", { category: uniqueCategory(), name: "Gauss" }, ctx);
		expect(res.status).toBe(503);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("upstream_unavailable");
	});
});

describe("POST /api/v1/checks", () => {
	it("reports likely repeats", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Noether" }, ctx);

		const res = await post("/api/v1/checks", { category, name: "NOETHER" }, ctx);

		expect(res.status).toBe(200);
		expect(CheckResult.parse(await res.json()).likely_repeat).toBe(true);
	});
});

describe("entries", () => {
	it("lists with a coerced limit, rejects a bad limit, and deletes", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		const claimed = ClaimResult.parse(
			await (await post("/api/v1/claims", { category, name: "Hilbert" }, ctx)).json(),
		);
		await post("/api/v1/claims", { category, name: "Cantor" }, ctx);
		if (claimed.status !== "claimed") throw new Error("expected claimed");

		const listed = await createRestApp().request(`/api/v1/entries?category=${category}&limit=1`, {}, ctx);
		expect(ListResult.parse(await listed.json()).entries).toHaveLength(1);

		const bad = await createRestApp().request("/api/v1/entries?limit=abc", {}, ctx);
		expect(bad.status).toBe(400);

		const del = await createRestApp().request(`/api/v1/entries/${claimed.entry.id}`, { method: "DELETE" }, ctx);
		expect(del.status).toBe(204);

		const again = await createRestApp().request(`/api/v1/entries/${claimed.entry.id}`, { method: "DELETE" }, ctx);
		expect(again.status).toBe(404);
		expect(ErrorBody.parse(await again.json()).error.code).toBe("not_found");
	});
});

describe("GET /api/v1/stats", () => {
	it("returns the caller's repeats", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Gauss" }, ctx);
		await post("/api/v1/claims", { category, name: "gauss" }, ctx);

		const res = await createRestApp().request(`/api/v1/stats?scope=me&category=${category}`, {}, ctx);

		expect(StatsResult.parse(await res.json()).repeats).toMatchObject([{ display_name: "Gauss", hit_count: 1 }]);
	});
});

describe("unknown routes", () => {
	it("return a typed 404", async () => {
		const res = await createRestApp().request("/api/v1/nope", {}, await context());
		expect(res.status).toBe(404);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("not_found");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/rest.test.ts`
Expected: FAIL — cannot resolve `../src/api/context` / `../src/api/rest`.

- [ ] **Step 3: Implement the shared API modules**

`src/api/context.ts`:

```ts
import type { Ledger } from "../core/ledger";

/** Per-request dependencies for REST and MCP, built by the API handler from ctx.props + env. */
export interface ApiContext {
	userId: string;
	ledger: Ledger;
	limiter: RateLimit;
	globalMinUsers: number;
}
```

`src/api/errors.ts`:

```ts
import { LedgerError } from "../core/errors";
import type { ErrorBody, ErrorCode } from "./schemas";

export const ERROR_STATUS: Record<ErrorCode, number> = {
	unauthorized: 401,
	invalid_input: 400,
	not_found: 404,
	rate_limited: 429,
	upstream_unavailable: 503,
};

export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
	if (error instanceof LedgerError) {
		return {
			status: ERROR_STATUS[error.code],
			body: { error: { code: error.code, message: error.message } },
		};
	}
	console.error("unhandled error", error);
	return {
		status: ERROR_STATUS.upstream_unavailable,
		body: { error: { code: "upstream_unavailable", message: "internal error; retry later" } },
	};
}

export function errorResponse(error: unknown): Response {
	const { status, body } = toErrorBody(error);
	return Response.json(body, { status });
}
```

`src/api/validate.ts`:

```ts
import { z } from "zod";
import { LedgerError } from "../core/errors";

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new LedgerError("invalid_input", z.prettifyError(result.error));
	}
	return result.data;
}
```

`src/api/ratelimit.ts`:

```ts
import { LedgerError } from "../core/errors";

export async function enforceRateLimit(limiter: RateLimit, userId: string): Promise<void> {
	const { success } = await limiter.limit({ key: userId });
	if (!success) {
		throw new LedgerError("rate_limited", "too many claim/check requests; slow down");
	}
}
```

- [ ] **Step 4: Implement the REST app**

`src/api/rest.ts`:

```ts
import { Hono } from "hono";
import { LedgerError } from "../core/errors";
import type { ApiContext } from "./context";
import { errorResponse } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import { CheckInput, ClaimInput, ListInput, StatsInput } from "./schemas";
import { parseInput } from "./validate";

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new LedgerError("invalid_input", "request body must be JSON");
	}
}

export function createRestApp() {
	const app = new Hono<{ Bindings: ApiContext }>().basePath("/api/v1");

	app.post("/claims", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(ClaimInput, await readJson(c.req.raw));
		return c.json(await c.env.ledger.claim(c.env.userId, input));
	});

	app.post("/checks", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(CheckInput, await readJson(c.req.raw));
		return c.json(await c.env.ledger.check(c.env.userId, input));
	});

	app.get("/entries", async (c) => {
		const input = parseInput(ListInput, c.req.query());
		return c.json(await c.env.ledger.list(c.env.userId, input));
	});

	app.delete("/entries/:id", async (c) => {
		await c.env.ledger.forget(c.env.userId, c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/stats", async (c) => {
		const input = parseInput(StatsInput, c.req.query());
		return c.json(await c.env.ledger.stats(c.env.userId, input, c.env.globalMinUsers));
	});

	app.notFound(() => errorResponse(new LedgerError("not_found", "no such endpoint")));
	app.onError((error) => errorResponse(error));

	return app;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/rest.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/api/context.ts src/api/errors.ts src/api/validate.ts src/api/ratelimit.ts src/api/rest.ts test/rest.test.ts
git commit -m "feat: add REST API for claims, checks, entries and stats" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 8: OAuth provider wiring, personal tokens, cron

**Files:**
- Create: `src/auth/encoding.ts`, `src/auth/tokens.ts`, `src/api/handler.ts`, `src/web/app.ts`
- Replace: `src/index.ts`
- Modify: `test/helpers.ts` (add `createTestToken`, `issueOAuthTokens`)
- Test: `test/tokens.test.ts`, `test/worker.test.ts`

**Interfaces:**
- Consumes: `LedgerStore.insertToken`, `findActiveTokenByHash`, `touchToken` (Task 4); `TokenRow` (Task 3); `createRestApp`, `ApiContext`, `errorResponse` (Task 7); `ledgerFromEnv` (Task 5); `globalMinUsersFromEnv` (Task 5); `PropsSchema`, `Env` (Task 1).
- Produces:
  - `src/auth/encoding.ts` — `base64UrlEncode(bytes: Uint8Array): string`, `base64UrlDecode(value: string): Uint8Array`
  - `src/auth/tokens.ts` — `TOKEN_PREFIX = "ldg_"`, `TOUCH_INTERVAL_MS = 3_600_000`, `generateToken(): string`, `hashToken(token: string): Promise<string>`, `createPersonalToken(store, userId, label, now, newId): Promise<{ token: string; row: TokenRow }>`, `resolvePersonalToken(store, token, now): Promise<{ userId: string } | null>`
  - `src/api/handler.ts` — `apiHandler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> }` (Task 9 adds the `/mcp` branch)
  - `src/web/app.ts` — `createWebApp()` returning `Hono<{ Bindings: Env }>` (Task 10 adds parameters and routes)
  - `src/index.ts` — `providerOptions: OAuthProviderOptions<Env>`, default export `{ fetch, scheduled }`
  - `test/helpers.ts` — `createTestToken(userId: string): Promise<string>`, `issueOAuthTokens(userId: string): Promise<{ accessToken: string; refreshToken: string | undefined }>`, `ORIGIN = "https://ledger.test"`

- [ ] **Step 1: Write the failing token unit tests**

`test/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../src/auth/encoding";
import {
	createPersonalToken,
	generateToken,
	hashToken,
	resolvePersonalToken,
	TOUCH_INTERVAL_MS,
} from "../src/auth/tokens";
import { seedUser, testStore } from "./helpers";

describe("encoding", () => {
	it("round-trips bytes through base64url without padding", () => {
		const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
		expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
	});
});

describe("personal tokens", () => {
	it("generates ldg_ tokens carrying 32 random bytes", () => {
		const token = generateToken();
		expect(token).toMatch(/^ldg_[A-Za-z0-9_-]{43}$/);
		expect(generateToken()).not.toBe(token);
	});

	it("hashes deterministically to 64 hex characters", async () => {
		expect(await hashToken("ldg_abc")).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashToken("ldg_abc")).toBe(await hashToken("ldg_abc"));
	});

	it("resolves active tokens, ignores other prefixes, and throttles last_used_at writes", async () => {
		const store = testStore();
		const userId = await seedUser();
		const { token, row } = await createPersonalToken(store, userId, "cron", 1_000, () => crypto.randomUUID());
		expect(row.token_hash).toBe(await hashToken(token));

		expect(await resolvePersonalToken(store, "not-a-ledger-token", 2_000)).toBeNull();
		expect(await resolvePersonalToken(store, token, 2_000)).toEqual({ userId });
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000);

		await resolvePersonalToken(store, token, 2_000 + TOUCH_INTERVAL_MS - 1);
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000);

		await resolvePersonalToken(store, token, 2_000 + TOUCH_INTERVAL_MS);
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000 + TOUCH_INTERVAL_MS);

		await store.revokeToken(userId, row.id, 5_000);
		expect(await resolvePersonalToken(store, token, 6_000)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tokens.test.ts`
Expected: FAIL — cannot resolve `../src/auth/encoding` / `../src/auth/tokens`.

- [ ] **Step 3: Implement encoding and tokens**

`src/auth/encoding.ts`:

```ts
export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}
```

`src/auth/tokens.ts`:

```ts
import type { TokenRow } from "../core/rows";
import type { LedgerStore } from "../store/d1";
import { base64UrlEncode } from "./encoding";

export const TOKEN_PREFIX = "ldg_";
/** last_used_at is written at most this often per token. */
export const TOUCH_INTERVAL_MS = 3_600_000;

export function generateToken(): string {
	return `${TOKEN_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashToken(token: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	);
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPersonalToken(
	store: LedgerStore,
	userId: string,
	label: string,
	now: number,
	newId: () => string,
): Promise<{ token: string; row: TokenRow }> {
	const token = generateToken();
	const row: TokenRow = {
		id: newId(),
		user_id: userId,
		token_hash: await hashToken(token),
		label,
		created_at: now,
		last_used_at: null,
		revoked_at: null,
	};
	await store.insertToken(row);
	return { token, row };
}

export async function resolvePersonalToken(
	store: LedgerStore,
	token: string,
	now: number,
): Promise<{ userId: string } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const row = await store.findActiveTokenByHash(await hashToken(token));
	if (!row) return null;
	if (row.last_used_at === null || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
		await store.touchToken(row.id, now);
	}
	return { userId: row.user_id };
}
```

- [ ] **Step 4: Run the token tests to verify they pass**

Run: `npx vitest run test/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Add worker-level test helpers**

Append to `test/helpers.ts` (merge the imports with the existing ones at the top):

```ts
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { SELF } from "cloudflare:test";
import { z } from "zod";
import { base64UrlEncode } from "../src/auth/encoding";
import { createPersonalToken } from "../src/auth/tokens";
import { providerOptions } from "../src/index";

export const ORIGIN = "https://ledger.test";

export async function createTestToken(userId: string): Promise<string> {
	const { token } = await createPersonalToken(testStore(), userId, "test", Date.now(), () =>
		crypto.randomUUID(),
	);
	return token;
}

const TokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string().optional(),
	token_type: z.string(),
});

/** Runs a real authorization-code + PKCE exchange against the Worker's /token endpoint. */
export async function issueOAuthTokens(
	userId: string,
): Promise<{ accessToken: string; refreshToken: string | undefined }> {
	const api = getOAuthApi(providerOptions, env);
	const redirectUri = "https://client.test/callback";
	const client = await api.createClient({
		redirectUris: [redirectUri],
		clientName: "Test Client",
		tokenEndpointAuthMethod: "none",
	});
	const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64UrlEncode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
	);
	const { redirectTo } = await api.completeAuthorization({
		request: {
			responseType: "code",
			clientId: client.clientId,
			redirectUri,
			scope: ["ledger"],
			state: "test-state",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		},
		userId,
		metadata: {},
		scope: ["ledger"],
		props: { userId },
	});
	const code = new URL(redirectTo).searchParams.get("code");
	if (!code) throw new Error(`authorization redirect carried no code: ${redirectTo}`);
	const response = await SELF.fetch(`${ORIGIN}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: client.clientId,
			code_verifier: verifier,
		}),
	});
	if (response.status !== 200) {
		throw new Error(`token endpoint returned ${response.status}: ${await response.text()}`);
	}
	const body = TokenResponse.parse(await response.json());
	return { accessToken: body.access_token, refreshToken: body.refresh_token };
}
```

(`env` is already imported from `cloudflare:test` at the top of the helpers file.)

- [ ] **Step 6: Write the failing worker tests**

`test/worker.test.ts`:

```ts
import {
	createExecutionContext,
	createScheduledController,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaimResult, ListResult } from "../src/api/schemas";
import worker, { providerOptions } from "../src/index";
import {
	createTestToken,
	issueOAuthTokens,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

function authed(token: string, init: RequestInit = {}): RequestInit {
	return { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } };
}

describe("provider options", () => {
	it("uses one-hour access tokens and explicitly non-expiring refresh tokens", () => {
		expect(providerOptions.accessTokenTTL).toBe(3600);
		expect(Object.hasOwn(providerOptions, "refreshTokenTTL")).toBe(true);
		expect(providerOptions.refreshTokenTTL).toBeUndefined();
	});

	it("advertises dynamic client registration for MCP clients", async () => {
		const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
		expect(res.status).toBe(200);
		const metadata = z
			.object({ registration_endpoint: z.string(), token_endpoint: z.string() })
			.parse(await res.json());
		expect(metadata.registration_endpoint).toBe(`${ORIGIN}/register`);
	});
});

describe("API authentication", () => {
	it("rejects requests without a token or with an unknown ldg_ token", async () => {
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`)).status).toBe(401);
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed("ldg_unknown"))).status).toBe(401);
	});

	it("accepts a personal token end to end", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId);
		const category = uniqueCategory();

		const claim = await SELF.fetch(
			`${ORIGIN}/api/v1/claims`,
			authed(token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ category, name: "Euler's Identity" }),
			}),
		);
		expect(claim.status).toBe(200);
		// wrangler.test.jsonc has no AI/VECTORS bindings.
		expect(ClaimResult.parse(await claim.json())).toMatchObject({
			status: "claimed",
			semantic: "unavailable",
		});

		const list = await SELF.fetch(`${ORIGIN}/api/v1/entries?category=${category}`, authed(token));
		expect(ListResult.parse(await list.json()).entries).toHaveLength(1);
	});

	it("stops accepting a revoked personal token", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId);
		const [row] = await testStore().listTokens(userId);
		if (!row) throw new Error("expected a token row");
		await testStore().revokeToken(userId, row.id, Date.now());

		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed(token))).status).toBe(401);
	});

	it("accepts an OAuth access token and issues a refresh token", async () => {
		const userId = await seedUser();
		const { accessToken, refreshToken } = await issueOAuthTokens(userId);

		expect(refreshToken).toBeTypeOf("string");
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed(accessToken));
		expect(res.status).toBe(200);
		expect(ListResult.parse(await res.json()).entries).toEqual([]);
	});
});

describe("scheduled handler", () => {
	it("runs backfill and KV purge without throwing", async () => {
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);
	});
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run test/worker.test.ts`
Expected: FAIL — `providerOptions` is not exported from `../src/index`, and API routes return the placeholder 404.

- [ ] **Step 8: Implement the API handler, the minimal web app and the entry point**

`src/api/handler.ts`:

```ts
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import { type Env, PropsSchema } from "../env";
import { ledgerFromEnv } from "../services";
import type { ApiContext } from "./context";
import { errorResponse } from "./errors";
import { createRestApp } from "./rest";

const restApp = createRestApp();

/** Receives only authenticated requests: OAuthProvider sets ctx.props before calling it. */
export const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = PropsSchema.safeParse(ctx.props);
		if (!props.success) {
			return errorResponse(new LedgerError("unauthorized", "missing or invalid identity"));
		}
		const api: ApiContext = {
			userId: props.data.userId,
			ledger: ledgerFromEnv(env),
			limiter: env.CLAIM_LIMITER,
			globalMinUsers: globalMinUsersFromEnv(env),
		};
		return restApp.fetch(request, api, ctx);
	},
};
```

`src/web/app.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../env";

export function createWebApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/", (c) => c.text("Topic Ledger"));
	return app;
}
```

`src/index.ts` (replaces the placeholder):

```ts
import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { apiHandler } from "./api/handler";
import { resolvePersonalToken } from "./auth/tokens";
import type { Env } from "./env";
import { ledgerFromEnv } from "./services";
import { LedgerStore } from "./store/d1";
import { createWebApp } from "./web/app";

const webApp = createWebApp();

export const providerOptions: OAuthProviderOptions<Env> = {
	apiRoute: ["/mcp", "/api/v1/"],
	apiHandler,
	defaultHandler: {
		fetch: (request, env, ctx) => webApp.fetch(request, env, ctx),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["ledger"],
	accessTokenTTL: 3600,
	// The library default is 30 days. Scheduled briefs run unattended, so refresh tokens must
	// not expire until the grant is revoked — and that requires passing undefined explicitly.
	refreshTokenTTL: undefined,
	resolveExternalToken: async ({ token, env }) => {
		const resolved = await resolvePersonalToken(new LedgerStore(env.DB), token, Date.now());
		return resolved ? { props: resolved } : null;
	},
};

const provider = new OAuthProvider<Env>(providerOptions);

export default {
	fetch: (request, env, ctx) => provider.fetch(request, env, ctx),
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(Promise.all([ledgerFromEnv(env).backfill(), provider.purgeExpiredData(env)]));
	},
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/tokens.test.ts test/worker.test.ts`
Expected: PASS.

If "accepts an OAuth access token" fails at the token endpoint with a PKCE or resource error, print the response body (the helper includes it in the thrown message) and adjust the helper's request to what the error names — do not change `providerOptions` to make the test pass.

- [ ] **Step 10: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/auth/encoding.ts src/auth/tokens.ts src/api/handler.ts src/web/app.ts src/index.ts test/helpers.ts test/tokens.test.ts test/worker.test.ts
git commit -m "feat: wire OAuth provider with personal tokens and scheduled backfill" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 9: MCP tools

**Files:**
- Create: `src/api/mcp.ts`
- Modify: `src/api/schemas.ts` (add `ListToolInput`, `StatsToolInput`, `ForgetResult`), `src/api/handler.ts` (route `/mcp`)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `ApiContext` (Task 7); `enforceRateLimit`, `toErrorBody` (Task 7); `ClaimInput`, `CheckInput`, `ForgetInput`, `ListInput`, `StatsInput`, `ClaimResult`, `CheckResult`, `ListResult`, `StatsResult`, `ErrorBody` (Task 3); `apiHandler` (Task 8); `createTestToken`, `issueOAuthTokens`, `ORIGIN` (Task 8 helpers).
- Produces:
  - `src/api/schemas.ts` — `ListToolInput`, `StatsToolInput` (same shapes as `ListInput`/`StatsInput` but `limit` is a plain number, because MCP arguments are JSON, not query strings), `ForgetResult = { forgotten: string }`
  - `src/api/mcp.ts` — `MCP_TOOL_NAMES`, `buildMcpServer(api: ApiContext): McpServer`
  - `/mcp` served by `createMcpHandler` from `agents/mcp/server`, restricted to the `PUBLIC_ORIGIN` hostname

Tools: `claim_topic`, `check_topic`, `list_topics`, `forget_topic`, `topic_stats`. Each returns the same typed payload as the matching REST endpoint in `structuredContent`, plus a JSON text block for clients that ignore structured content. Errors return `isError: true` with an `ErrorBody` in `structuredContent`.

- [ ] **Step 1: Write the failing MCP tests**

`test/mcp.test.ts`:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CheckResult, ClaimResult, ErrorBody, ListResult, StatsResult } from "../src/api/schemas";
import { createTestToken, issueOAuthTokens, ORIGIN, seedUser, uniqueCategory } from "./helpers";

const open: Client[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((client) => client.close()));
});

async function connect(token: string): Promise<Client> {
	const client = new Client({ name: "ledger-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
		fetch: (url, init) => SELF.fetch(url, init),
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	open.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
	return client.callTool({ name, arguments: args });
}

describe("MCP endpoint", () => {
	it("lists the five ledger tools", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"check_topic",
			"claim_topic",
			"forget_topic",
			"list_topics",
			"topic_stats",
		]);
	});

	it("claims, repeats, checks, lists and reports stats with typed structured content", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const category = uniqueCategory();

		const first = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "Euler's Identity" })).structuredContent,
		);
		expect(first.status).toBe("claimed");

		const second = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "euler identity" })).structuredContent,
		);
		expect(second.status).toBe("repeat");

		const check = CheckResult.parse(
			(await call(client, "check_topic", { category, name: "EULER IDENTITY" })).structuredContent,
		);
		expect(check.likely_repeat).toBe(true);

		const list = ListResult.parse(
			(await call(client, "list_topics", { category, limit: 5 })).structuredContent,
		);
		expect(list.entries).toHaveLength(1);

		const stats = StatsResult.parse(
			(await call(client, "topic_stats", { scope: "me", category })).structuredContent,
		);
		expect(stats.repeats).toMatchObject([{ display_name: "Euler's Identity", hit_count: 1 }]);
	});

	it("shares one ledger with REST", async () => {
		const token = await createTestToken(await seedUser());
		const client = await connect(token);
		const category = uniqueCategory();
		await call(client, "claim_topic", { category, name: "Noether" });

		const res = await SELF.fetch(`${ORIGIN}/api/v1/checks`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ category, name: "noether" }),
		});
		expect(CheckResult.parse(await res.json()).likely_repeat).toBe(true);
	});

	it("returns a typed tool error for an unknown entry", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const result = await call(client, "forget_topic", { entry_id: crypto.randomUUID() });
		expect(result.isError).toBe(true);
		expect(ErrorBody.parse(result.structuredContent).error.code).toBe("not_found");
	});

	it("rejects invalid arguments", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		// The SDK may surface schema violations as a tool error result or as a protocol error.
		const outcome = await call(client, "claim_topic", { category: "", name: "x" }).then(
			(result) => result.isError === true,
			() => true,
		);
		expect(outcome).toBe(true);
	});

	it("accepts OAuth access tokens", async () => {
		const { accessToken } = await issueOAuthTokens(await seedUser());
		const client = await connect(accessToken);
		expect((await client.listTools()).tools).toHaveLength(5);
	});

	it("refuses unauthenticated connections", async () => {
		await expect(connect("ldg_not-a-real-token")).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL — connecting to `/mcp` gets the REST app's typed 404, so `client.connect` rejects.

- [ ] **Step 3: Add the tool-specific schemas**

Append to `src/api/schemas.ts`:

```ts
/** MCP arguments arrive as JSON numbers, so tools use a plain number instead of query-string coercion. */
const ToolLimit = z.number().int().min(1).max(100).default(20);

export const ListToolInput = ListInput.extend({ limit: ToolLimit });
export type ListToolInput = z.infer<typeof ListToolInput>;

export const StatsToolInput = StatsInput.extend({ limit: ToolLimit });
export type StatsToolInput = z.infer<typeof StatsToolInput>;

export const ForgetResult = z.object({ forgotten: z.string() });
export type ForgetResult = z.infer<typeof ForgetResult>;
```

- [ ] **Step 4: Implement the MCP server**

`src/api/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import type { ApiContext } from "./context";
import { toErrorBody } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import {
	CheckInput,
	ClaimInput,
	type ForgetResult,
	ForgetInput,
	ListToolInput,
	StatsToolInput,
} from "./schemas";

export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
	"claim_topic",
	"check_topic",
	"list_topics",
	"forget_topic",
	"topic_stats",
] as const;

interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
}

async function run(action: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
	try {
		const result = await action();
		return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
	} catch (error) {
		const { body } = toErrorBody(error);
		return {
			isError: true,
			content: [{ type: "text", text: `${body.error.code}: ${body.error.message}` }],
			structuredContent: body,
		};
	}
}

export function buildMcpServer(api: ApiContext): McpServer {
	const server = new McpServer({ name: "topic-ledger", version: MCP_SERVER_VERSION });

	server.registerTool(
		"claim_topic",
		{
			title: "Claim a topic",
			description:
				"Record a topic for this category unless it repeats one already used. " +
				'Returns status "claimed" or "repeat". On "repeat", pick a different topic and call again. ' +
				"If a claimed result lists possible_matches you judge to be the same topic, call forget_topic " +
				"on the new entry and pick again. force=true overrides fuzzy (not exact) matches.",
			inputSchema: ClaimInput,
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async (args) =>
			run(async () => {
				await enforceRateLimit(api.limiter, api.userId);
				return api.ledger.claim(api.userId, args);
			}),
	);

	server.registerTool(
		"check_topic",
		{
			title: "Check a topic",
			description: "Report whether a topic would be a repeat, without recording anything.",
			inputSchema: CheckInput,
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			run(async () => {
				await enforceRateLimit(api.limiter, api.userId);
				return api.ledger.check(api.userId, args);
			}),
	);

	server.registerTool(
		"list_topics",
		{
			title: "List topics",
			description:
				"List recently claimed topics, newest first. Useful for avoiding repeats up front.",
			inputSchema: ListToolInput,
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => api.ledger.list(api.userId, args)),
	);

	server.registerTool(
		"forget_topic",
		{
			title: "Forget a topic",
			description: "Delete a claimed topic and its repeat history.",
			inputSchema: ForgetInput,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (args) =>
			run(async () => {
				await api.ledger.forget(api.userId, args.entry_id);
				const result: ForgetResult = { forgotten: args.entry_id };
				return result;
			}),
	);

	server.registerTool(
		"topic_stats",
		{
			title: "Repeat statistics",
			description:
				'Most-repeated topics. scope "me" shows your entries with the phrasings that were blocked; ' +
				'scope "global" shows anonymous counts across all users.',
			inputSchema: StatsToolInput,
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => api.ledger.stats(api.userId, args, api.globalMinUsers)),
	);

	return server;
}
```

- [ ] **Step 5: Route `/mcp` in the API handler**

In `src/api/handler.ts` add the imports:

```ts
import { createMcpHandler } from "agents/mcp/server";
import { buildMcpServer } from "./mcp";
```

and replace the final `return restApp.fetch(request, api, ctx);` with:

```ts
		if (new URL(request.url).pathname === "/mcp") {
			const mcp = createMcpHandler(() => buildMcpServer(api), {
				route: "/mcp",
				allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname],
			});
			return mcp(request, env, ctx);
		}
		return restApp.fetch(request, api, ctx);
```

The handler is created per request because the server factory closes over this request's user; `createMcpHandler` is stateless, so nothing is shared between requests.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mcp.test.ts`
Expected: PASS.

If `tsc` rejects a `registerTool` callback's return type, the SDK's `CallToolResult` is narrower than `ToolResult`; import `type CallToolResult` from `@modelcontextprotocol/server` and annotate `run`'s return type with it instead of widening with casts. If the connection fails with a Host or Origin rejection, log the response body from a direct `SELF.fetch` to `/mcp` and fix the `allowedHostnames` value — do not pass `"*"`.

- [ ] **Step 7: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/api/mcp.ts src/api/schemas.ts src/api/handler.ts test/mcp.test.ts
git commit -m "feat: expose ledger operations as MCP tools" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 10: Sign-in — sessions, GitHub/Google, authorize flow

**Files:**
- Create: `src/auth/session.ts`, `src/auth/upstream.ts`, `src/auth/pending.ts`, `src/web/guards.ts`, `src/web/layout.tsx`, `src/web/auth.tsx`
- Modify: `src/web/app.ts`
- Test: `test/session.test.ts`, `test/upstream.test.ts`, `test/auth-flow.test.ts`

**Interfaces:**
- Consumes: `base64UrlEncode`, `base64UrlDecode` (Task 8); `LedgerStore.findOrCreateUserByIdentity`, `IdentityInput`, `IdentityProvider` (Task 4); `Env` (Task 1); `providerOptions`, `ORIGIN` helpers (Task 8).
- Produces:
  - `src/auth/session.ts` — `SESSION_COOKIE`, `APPROVED_COOKIE`, `STATE_COOKIE`, `SESSION_TTL_SECONDS`, `signValue(payload, secret)`, `verifyValue(signed, secret): Promise<string | null>`, `createSession(userId, now, secret)`, `readSession(value: string | undefined, now, secret): Promise<string | null>`, `encodeApprovedClients(clientIds, secret)`, `decodeApprovedClients(value: string | undefined, secret): Promise<string[]>`
  - `src/auth/upstream.ts` — `type FetchFn = (input: string, init?: RequestInit) => Promise<Response>`, `interface UpstreamCredentials { clientId; clientSecret }`, `class UpstreamError extends Error`, `upstreamAuthorizationUrl(provider, credentials, redirectUri, state): string`, `exchangeUpstreamCode(provider, credentials, code, redirectUri, fetchFn): Promise<IdentityInput>`, `credentialsFor(env, provider): UpstreamCredentials`
  - `src/auth/pending.ts` — `PendingSignIn` (zod + type: `{ kind: "authorize"; request: AuthRequest; clientName: string } | { kind: "dashboard" }`), `savePending(kv, pending): Promise<string>`, `takePending(kv, id): Promise<PendingSignIn | null>`
  - `src/web/guards.ts` — `type WebEnv = { Bindings: Env }`, `interface WebDeps { fetchFn: FetchFn; now: () => number }`, `isSameOrigin(c): boolean`, `sessionUserId(c, now): Promise<string | null>`, `cookieOptions(maxAgeSeconds): CookieOptions`
  - `src/web/layout.tsx` — `Layout`, `ErrorPage`, `render(c, page, status?)`
  - `src/web/auth.tsx` — `registerAuthRoutes(app: Hono<WebEnv>, deps: WebDeps): void` — `GET /authorize`, `POST /authorize/approve`, `GET /login/:provider`, `GET /callback/:provider`, `POST /logout`
  - `src/web/app.ts` — `createWebApp(deps?: WebDeps)` (defaults to global `fetch` and `Date.now`)

Pending sign-ins live in `OAUTH_KV` under the `signin:` prefix (the OAuth library uses other prefixes) with a 10-minute TTL, and the id is bound to the browser through `__Host-ledger_state`. Upstream access tokens are never stored.

- [ ] **Step 1: Write the failing unit tests**

`test/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	createSession,
	decodeApprovedClients,
	encodeApprovedClients,
	readSession,
	SESSION_TTL_SECONDS,
	signValue,
	verifyValue,
} from "../src/auth/session";

const secret = "unit-test-secret";

describe("signed values", () => {
	it("verifies its own signature and rejects tampering or another secret", async () => {
		const signed = await signValue("payload.with.dots", secret);
		expect(await verifyValue(signed, secret)).toBe("payload.with.dots");
		expect(await verifyValue(signed.replace("payload", "paylaod"), secret)).toBeNull();
		expect(await verifyValue(signed, "other-secret")).toBeNull();
		expect(await verifyValue("no-signature", secret)).toBeNull();
	});
});

describe("sessions", () => {
	it("round-trips a user id until expiry", async () => {
		const cookie = await createSession("user-1", 1_000, secret);
		expect(await readSession(cookie, 2_000, secret)).toBe("user-1");
		expect(await readSession(cookie, 1_000 + SESSION_TTL_SECONDS * 1000, secret)).toBeNull();
		expect(await readSession(undefined, 2_000, secret)).toBeNull();
	});
});

describe("approved clients", () => {
	it("round-trips client ids and ignores tampered cookies", async () => {
		const cookie = await encodeApprovedClients(["client-a", "client.b"], secret);
		expect(await decodeApprovedClients(cookie, secret)).toEqual(["client-a", "client.b"]);
		expect(await decodeApprovedClients(`x${cookie}`, secret)).toEqual([]);
		expect(await decodeApprovedClients(undefined, secret)).toEqual([]);
	});
});
```

`test/upstream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	exchangeUpstreamCode,
	type FetchFn,
	UpstreamError,
	upstreamAuthorizationUrl,
} from "../src/auth/upstream";

const credentials = { clientId: "cid", clientSecret: "secret" };
const redirectUri = "https://ledger.test/callback/github";

const fake: FetchFn = async (input, init) => {
	if (input === "https://github.com/login/oauth/access_token") {
		const code = new URLSearchParams(String(init?.body)).get("code");
		return Response.json(code === "good" ? { access_token: "gh" } : { error: "bad_verification_code" });
	}
	if (input === "https://api.github.com/user") {
		return Response.json({ id: 42, login: "octo", name: null, email: "o@example.com" });
	}
	if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "g" });
	if (input === "https://openidconnect.googleapis.com/v1/userinfo") {
		return Response.json({ sub: "g-7", email: "g@example.com", name: "Grace" });
	}
	return new Response("unexpected", { status: 500 });
};

describe("upstreamAuthorizationUrl", () => {
	it("includes client id, redirect, scope and state", () => {
		const url = new URL(upstreamAuthorizationUrl("github", credentials, redirectUri, "st"));
		expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "cid",
			redirect_uri: redirectUri,
			scope: "read:user user:email",
			state: "st",
		});
		const google = new URL(upstreamAuthorizationUrl("google", credentials, redirectUri, "st"));
		expect(google.searchParams.get("scope")).toBe("openid email profile");
		expect(google.searchParams.get("response_type")).toBe("code");
	});
});

describe("exchangeUpstreamCode", () => {
	it("maps GitHub users to a stable numeric subject", async () => {
		expect(await exchangeUpstreamCode("github", credentials, "good", redirectUri, fake)).toEqual({
			provider: "github",
			subject: "42",
			email: "o@example.com",
			displayName: "octo",
		});
	});

	it("maps Google users to their sub", async () => {
		expect(await exchangeUpstreamCode("google", credentials, "any", redirectUri, fake)).toEqual({
			provider: "google",
			subject: "g-7",
			email: "g@example.com",
			displayName: "Grace",
		});
	});

	it("raises UpstreamError when the provider rejects the code", async () => {
		await expect(
			exchangeUpstreamCode("github", credentials, "bad", redirectUri, fake),
		).rejects.toBeInstanceOf(UpstreamError);
	});
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npx vitest run test/session.test.ts test/upstream.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement sessions, upstream clients and pending state**

`src/auth/session.ts`:

```ts
import { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "./encoding";

export const SESSION_COOKIE = "__Host-ledger_session";
export const APPROVED_COOKIE = "__Host-ledger_approved";
export const STATE_COOKIE = "__Host-ledger_state";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signValue(payload: string, secret: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
	return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyValue(signed: string, secret: string): Promise<string | null> {
	const separator = signed.lastIndexOf(".");
	if (separator <= 0) return null;
	const payload = signed.slice(0, separator);
	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(signed.slice(separator + 1));
	} catch {
		return null;
	}
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		signature,
		encoder.encode(payload),
	);
	return valid ? payload : null;
}

export function createSession(userId: string, now: number, secret: string): Promise<string> {
	return signValue(`${userId}.${now + SESSION_TTL_SECONDS * 1000}`, secret);
}

export async function readSession(
	value: string | undefined,
	now: number,
	secret: string,
): Promise<string | null> {
	if (!value) return null;
	const payload = await verifyValue(value, secret);
	if (!payload) return null;
	const separator = payload.lastIndexOf(".");
	const userId = payload.slice(0, separator);
	const expiresAt = Number(payload.slice(separator + 1));
	if (separator <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
	return userId;
}

const ClientIds = z.array(z.string());

export function encodeApprovedClients(clientIds: readonly string[], secret: string): Promise<string> {
	return signValue(base64UrlEncode(encoder.encode(JSON.stringify(clientIds))), secret);
}

export async function decodeApprovedClients(
	value: string | undefined,
	secret: string,
): Promise<string[]> {
	if (!value) return [];
	const payload = await verifyValue(value, secret);
	if (!payload) return [];
	try {
		return ClientIds.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))));
	} catch {
		return [];
	}
}
```

`src/auth/upstream.ts`:

```ts
import { z } from "zod";
import type { Env } from "../env";
import type { IdentityInput, IdentityProvider } from "../store/d1";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface UpstreamCredentials {
	clientId: string;
	clientSecret: string;
}

export class UpstreamError extends Error {
	override name = "UpstreamError";
}

const AUTHORIZE_URL: Record<IdentityProvider, string> = {
	github: "https://github.com/login/oauth/authorize",
	google: "https://accounts.google.com/o/oauth2/v2/auth",
};

const SCOPES: Record<IdentityProvider, string> = {
	github: "read:user user:email",
	google: "openid email profile",
};

const AccessToken = z.object({ access_token: z.string() });
const GitHubUser = z.object({
	id: z.number(),
	login: z.string(),
	name: z.string().nullable(),
	email: z.string().nullable(),
});
const GoogleUser = z.object({
	sub: z.string(),
	email: z.string().optional(),
	name: z.string().optional(),
});

export function credentialsFor(env: Env, provider: IdentityProvider): UpstreamCredentials {
	return provider === "github"
		? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
		: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

export function upstreamAuthorizationUrl(
	provider: IdentityProvider,
	credentials: UpstreamCredentials,
	redirectUri: string,
	state: string,
): string {
	const url = new URL(AUTHORIZE_URL[provider]);
	url.searchParams.set("client_id", credentials.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", SCOPES[provider]);
	url.searchParams.set("state", state);
	if (provider === "google") url.searchParams.set("response_type", "code");
	return url.toString();
}

async function readAs<S extends z.ZodType>(
	response: Response,
	schema: S,
	what: string,
): Promise<z.output<S>> {
	if (!response.ok) throw new UpstreamError(`${what} failed with HTTP ${response.status}`);
	const parsed = schema.safeParse(await response.json());
	if (!parsed.success) throw new UpstreamError(`${what} returned an unexpected payload`);
	return parsed.data;
}

export async function exchangeUpstreamCode(
	provider: IdentityProvider,
	credentials: UpstreamCredentials,
	code: string,
	redirectUri: string,
	fetchFn: FetchFn,
): Promise<IdentityInput> {
	if (provider === "github") {
		const token = await readAs(
			await fetchFn("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					code,
					redirect_uri: redirectUri,
				}),
			}),
			AccessToken,
			"GitHub token exchange",
		);
		const user = await readAs(
			await fetchFn("https://api.github.com/user", {
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token.access_token}`,
					"user-agent": "topic-ledger",
				},
			}),
			GitHubUser,
			"GitHub user lookup",
		);
		return { provider, subject: String(user.id), email: user.email, displayName: user.name ?? user.login };
	}

	const token = await readAs(
		await fetchFn("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		}),
		AccessToken,
		"Google token exchange",
	);
	const user = await readAs(
		await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", {
			headers: { authorization: `Bearer ${token.access_token}` },
		}),
		GoogleUser,
		"Google user lookup",
	);
	return { provider, subject: user.sub, email: user.email ?? null, displayName: user.name ?? null };
}
```

`src/auth/pending.ts`:

```ts
import { z } from "zod";
import { base64UrlEncode } from "./encoding";

/** Mirrors the OAuth library's AuthRequest so the parsed value can be passed back to it. */
const AuthRequestSchema = z.object({
	responseType: z.string(),
	clientId: z.string(),
	redirectUri: z.string(),
	scope: z.array(z.string()),
	state: z.string(),
	codeChallenge: z.string().optional(),
	codeChallengeMethod: z.string().optional(),
	resource: z.union([z.string(), z.array(z.string())]).optional(),
	issuer: z.string().optional(),
});

export const PendingSignIn = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("authorize"), request: AuthRequestSchema, clientName: z.string() }),
	z.object({ kind: z.literal("dashboard") }),
]);
export type PendingSignIn = z.infer<typeof PendingSignIn>;

const TTL_SECONDS = 600;
const keyFor = (id: string): string => `signin:${id}`;

export async function savePending(kv: KVNamespace, pending: PendingSignIn): Promise<string> {
	const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
	await kv.put(keyFor(id), JSON.stringify(pending), { expirationTtl: TTL_SECONDS });
	return id;
}

/** Reads and deletes a pending sign-in; each id is usable once. */
export async function takePending(kv: KVNamespace, id: string): Promise<PendingSignIn | null> {
	const raw = await kv.get(keyFor(id));
	if (raw === null) return null;
	await kv.delete(keyFor(id));
	try {
		const parsed = PendingSignIn.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run test/session.test.ts test/upstream.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing flow tests**

`test/auth-flow.test.ts`:

```ts
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { APPROVED_COOKIE, SESSION_COOKIE, STATE_COOKIE } from "../src/auth/session";
import type { FetchFn } from "../src/auth/upstream";
import { providerOptions } from "../src/index";
import { createWebApp } from "../src/web/app";
import { ORIGIN } from "./helpers";

const CLIENT_REDIRECT = "https://client.test/callback";

function webEnv() {
	return { ...env, OAUTH_PROVIDER: getOAuthApi(providerOptions, env) };
}

function cookiesFrom(response: Response): Map<string, string> {
	const out = new Map<string, string>();
	for (const header of response.headers.getSetCookie()) {
		const [pair] = header.split(";");
		const eq = pair?.indexOf("=") ?? -1;
		if (pair && eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
	return out;
}

function cookieHeader(cookies: Record<string, string | undefined>): string {
	return Object.entries(cookies)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function fakeUpstream(): FetchFn {
	const githubId = Math.floor(Math.random() * 1_000_000_000);
	const googleSub = `g-${crypto.randomUUID()}`;
	return async (input, init) => {
		switch (input) {
			case "https://github.com/login/oauth/access_token": {
				const code = new URLSearchParams(String(init?.body)).get("code");
				return Response.json(code === "good" ? { access_token: "gh" } : { error: "bad_verification_code" });
			}
			case "https://api.github.com/user":
				return Response.json({ id: githubId, login: "octo", name: "Octo", email: null });
			case "https://oauth2.googleapis.com/token":
				return Response.json({ access_token: "g" });
			case "https://openidconnect.googleapis.com/v1/userinfo":
				return Response.json({ sub: googleSub, name: "Grace" });
			default:
				return new Response("unexpected upstream call", { status: 500 });
		}
	};
}

async function startAuthorization(app: ReturnType<typeof createWebApp>, cookies = "") {
	const api = getOAuthApi(providerOptions, env);
	const client = await api.createClient({
		redirectUris: [CLIENT_REDIRECT],
		clientName: "Claude",
		tokenEndpointAuthMethod: "none",
	});
	const url = new URL(`${ORIGIN}/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: client.clientId,
		redirect_uri: CLIENT_REDIRECT,
		state: "client-state",
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
	}).toString();
	const response = await app.request(url.toString(), { headers: { cookie: cookies } }, webEnv());
	return { client, response, url };
}

describe("MCP client authorization via GitHub", () => {
	it("shows consent, signs in upstream, and redirects back with a code; returning users skip consent", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });

		const { response: consent, url } = await startAuthorization(app);
		expect(consent.status).toBe(200);
		const html = await consent.text();
		expect(html).toContain("Claude");
		expect(html).toContain("Continue with GitHub");
		const state = cookiesFrom(consent).get(STATE_COOKIE);
		expect(state).toBeTypeOf("string");

		const approve = await app.request(
			`${ORIGIN}/authorize/approve`,
			{
				method: "POST",
				headers: { origin: ORIGIN, cookie: cookieHeader({ [STATE_COOKIE]: state }) },
				body: new URLSearchParams({ state: state ?? "", provider: "github" }),
			},
			webEnv(),
		);
		expect(approve.status).toBe(302);
		const upstream = new URL(approve.headers.get("location") ?? "");
		expect(upstream.origin).toBe("https://github.com");
		expect(upstream.searchParams.get("state")).toBe(state);

		const callback = await app.request(
			`${ORIGIN}/callback/github?code=good&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(302);
		const back = new URL(callback.headers.get("location") ?? "");
		expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("code")).toBeTruthy();
		expect(back.searchParams.get("state")).toBe("client-state");
		const issued = cookiesFrom(callback);
		expect(issued.get(SESSION_COOKIE)).toBeTypeOf("string");
		expect(issued.get(APPROVED_COOKIE)).toBeTypeOf("string");

		// Same browser, same client: straight back to the client.
		const again = await app.request(
			url.toString(),
			{
				headers: {
					cookie: cookieHeader({
						[SESSION_COOKIE]: issued.get(SESSION_COOKIE),
						[APPROVED_COOKIE]: issued.get(APPROVED_COOKIE),
					}),
				},
			},
			webEnv(),
		);
		expect(again.status).toBe(302);
		expect(again.headers.get("location")).toContain(CLIENT_REDIRECT);
	});

	it("rejects approval without a matching state cookie or same-origin header", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const { response } = await startAuthorization(app);
		const state = cookiesFrom(response).get(STATE_COOKIE) ?? "";
		const body = () => new URLSearchParams({ state, provider: "github" });

		const crossSite = await app.request(
			`${ORIGIN}/authorize/approve`,
			{ method: "POST", headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) }, body: body() },
			webEnv(),
		);
		expect(crossSite.status).toBe(403);

		const wrongState = await app.request(
			`${ORIGIN}/authorize/approve`,
			{ method: "POST", headers: { origin: ORIGIN, cookie: cookieHeader({ [STATE_COOKIE]: "other" }) }, body: body() },
			webEnv(),
		);
		expect(wrongState.status).toBe(400);
	});

	it("shows an error page when the upstream rejects the code", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const login = await app.request(`${ORIGIN}/login/github`, {}, webEnv());
		const state = cookiesFrom(login).get(STATE_COOKIE);
		const callback = await app.request(
			`${ORIGIN}/callback/github?code=bad&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(502);
	});
});

describe("dashboard sign-in via Google", () => {
	it("redirects to Google, then to /ledger with a session", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const login = await app.request(`${ORIGIN}/login/google`, {}, webEnv());
		expect(login.status).toBe(302);
		expect(new URL(login.headers.get("location") ?? "").origin).toBe("https://accounts.google.com");
		const state = cookiesFrom(login).get(STATE_COOKIE);

		const callback = await app.request(
			`${ORIGIN}/callback/google?code=any&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("/ledger");
		expect(cookiesFrom(callback).get(SESSION_COOKIE)).toBeTypeOf("string");
	});

	it("returns 404 for an unknown provider", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		expect((await app.request(`${ORIGIN}/login/myspace`, {}, webEnv())).status).toBe(404);
	});
});
```

- [ ] **Step 6: Run the flow tests to verify they fail**

Run: `npx vitest run test/auth-flow.test.ts`
Expected: FAIL — `createWebApp` takes no arguments yet and `/authorize` returns 404.

- [ ] **Step 7: Implement guards, layout and auth routes**

`src/web/guards.ts`:

```ts
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { readSession, SESSION_COOKIE } from "../auth/session";
import type { FetchFn } from "../auth/upstream";
import type { Env } from "../env";

export type WebEnv = { Bindings: Env };

export interface WebDeps {
	fetchFn: FetchFn;
	now: () => number;
}

export function isSameOrigin(c: Context<WebEnv>): boolean {
	return c.req.header("origin") === c.env.PUBLIC_ORIGIN;
}

export function sessionUserId(c: Context<WebEnv>, now: number): Promise<string | null> {
	return readSession(getCookie(c, SESSION_COOKIE), now, c.env.COOKIE_SECRET);
}

export function cookieOptions(maxAgeSeconds: number): CookieOptions {
	return { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: maxAgeSeconds };
}
```

`src/web/layout.tsx`:

```tsx
import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { WebEnv } from "./guards";

const STYLES = `
body { font-family: system-ui, sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; padding: 0.75rem 1rem; background: #fff; border-bottom: 1px solid #d0d7de; }
header nav { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
main { max-width: 48rem; margin: 0 auto; padding: 1rem; }
table { width: 100%; border-collapse: collapse; background: #fff; }
td, th { text-align: left; padding: 0.4rem; border-bottom: 1px solid #d0d7de; vertical-align: top; }
form.inline { display: inline; }
button { cursor: pointer; }
code, pre { background: #fff; border: 1px solid #d0d7de; padding: 0.2rem 0.4rem; overflow-x: auto; white-space: pre-wrap; }
.brand { font-weight: 700; text-decoration: none; color: inherit; }
`;

export function Layout(props: { title: string; signedIn?: boolean; children?: Child }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{`${props.title} · Topic Ledger`}</title>
				<style>{STYLES}</style>
			</head>
			<body>
				<header>
					<a class="brand" href="/">
						Topic Ledger
					</a>
					{props.signedIn ? (
						<nav>
							<a href="/ledger">Ledger</a>
							<a href="/repeats">Repeats</a>
							<a href="/global">Global</a>
							<a href="/access">Access</a>
							<a href="/connect">Connect</a>
							<a href="/account">Account</a>
							<form class="inline" method="post" action="/logout">
								<button type="submit">Sign out</button>
							</form>
						</nav>
					) : null}
				</header>
				<main>{props.children}</main>
			</body>
		</html>
	);
}

export function ErrorPage(props: { title: string; message: string }) {
	return (
		<Layout title={props.title}>
			<h1>{props.title}</h1>
			<p>{props.message}</p>
		</Layout>
	);
}

export function render(c: Context<WebEnv>, page: Child, status: 200 | 400 | 403 | 404 | 502 = 200) {
	return c.html(
		<>
			{raw("<!doctype html>")}
			{page}
		</>,
		status,
	);
}
```

`src/web/auth.tsx`:

```tsx
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { savePending, takePending } from "../auth/pending";
import {
	APPROVED_COOKIE,
	createSession,
	decodeApprovedClients,
	encodeApprovedClients,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	STATE_COOKIE,
} from "../auth/session";
import {
	credentialsFor,
	exchangeUpstreamCode,
	UpstreamError,
	upstreamAuthorizationUrl,
} from "../auth/upstream";
import { LedgerStore } from "../store/d1";
import {
	cookieOptions,
	isSameOrigin,
	sessionUserId,
	type WebDeps,
	type WebEnv,
} from "./guards";
import { ErrorPage, Layout, render } from "./layout";

const Provider = z.enum(["github", "google"]);
const ApproveForm = z.object({ state: z.string().min(1), provider: Provider.optional() });
const CallbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });
const STATE_TTL_SECONDS = 600;
const MAX_REMEMBERED_CLIENTS = 20;

function callbackUrl(c: Context<WebEnv>, provider: z.infer<typeof Provider>): string {
	return `${c.env.PUBLIC_ORIGIN}/callback/${provider}`;
}

function clearState(c: Context<WebEnv>): void {
	deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
}

function ConsentPage(props: { clientName: string; stateId: string; signedIn: boolean }) {
	return (
		<Layout title="Authorize">
			<h1>Connect {props.clientName}</h1>
			<p>
				<strong>{props.clientName}</strong> wants to read and write your topic ledger.
			</p>
			<form method="post" action="/authorize/approve">
				<input type="hidden" name="state" value={props.stateId} />
				{props.signedIn ? (
					<button type="submit">Approve</button>
				) : (
					<>
						<button type="submit" name="provider" value="github">
							Continue with GitHub
						</button>{" "}
						<button type="submit" name="provider" value="google">
							Continue with Google
						</button>
					</>
				)}
			</form>
		</Layout>
	);
}

async function completeGrant(
	c: Context<WebEnv>,
	request: AuthRequest,
	userId: string,
	clientName: string,
): Promise<Response> {
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request,
		userId,
		metadata: { clientName },
		scope: ["ledger"],
		props: { userId },
	});
	const approved = await decodeApprovedClients(getCookie(c, APPROVED_COOKIE), c.env.COOKIE_SECRET);
	if (!approved.includes(request.clientId)) {
		const remembered = [...approved, request.clientId].slice(-MAX_REMEMBERED_CLIENTS);
		setCookie(
			c,
			APPROVED_COOKIE,
			await encodeApprovedClients(remembered, c.env.COOKIE_SECRET),
			cookieOptions(SESSION_TTL_SECONDS),
		);
	}
	return c.redirect(redirectTo);
}

export function registerAuthRoutes(app: Hono<WebEnv>, deps: WebDeps): void {
	app.get("/authorize", async (c) => {
		let request: AuthRequest;
		try {
			request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		} catch (error) {
			return render(c, <ErrorPage title="Invalid authorization request" message={String(error)} />, 400);
		}
		const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
		if (!client) {
			return render(c, <ErrorPage title="Unknown client" message="This application is not registered." />, 400);
		}
		const clientName = client.clientName ?? request.clientId;
		const userId = await sessionUserId(c, deps.now());
		if (userId) {
			const approved = await decodeApprovedClients(getCookie(c, APPROVED_COOKIE), c.env.COOKIE_SECRET);
			if (approved.includes(request.clientId)) return completeGrant(c, request, userId, clientName);
		}
		const stateId = await savePending(c.env.OAUTH_KV, { kind: "authorize", request, clientName });
		setCookie(c, STATE_COOKIE, stateId, cookieOptions(STATE_TTL_SECONDS));
		return render(c, <ConsentPage clientName={clientName} stateId={stateId} signedIn={userId !== null} />);
	});

	app.post("/authorize/approve", async (c) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		const form = ApproveForm.safeParse(await c.req.parseBody());
		if (!form.success || form.data.state !== getCookie(c, STATE_COOKIE)) {
			return render(c, <ErrorPage title="Sign-in expired" message="Start again from your app." />, 400);
		}
		const userId = await sessionUserId(c, deps.now());
		if (userId) {
			const pending = await takePending(c.env.OAUTH_KV, form.data.state);
			clearState(c);
			if (pending?.kind !== "authorize") {
				return render(c, <ErrorPage title="Sign-in expired" message="Start again from your app." />, 400);
			}
			return completeGrant(c, pending.request, userId, pending.clientName);
		}
		if (!form.data.provider) {
			return render(c, <ErrorPage title="Choose a provider" message="Pick GitHub or Google." />, 400);
		}
		const provider = form.data.provider;
		return c.redirect(
			upstreamAuthorizationUrl(provider, credentialsFor(c.env, provider), callbackUrl(c, provider), form.data.state),
		);
	});

	app.get("/login/:provider", async (c) => {
		const provider = Provider.safeParse(c.req.param("provider"));
		if (!provider.success) {
			return render(c, <ErrorPage title="Not found" message="Unknown sign-in provider." />, 404);
		}
		const stateId = await savePending(c.env.OAUTH_KV, { kind: "dashboard" });
		setCookie(c, STATE_COOKIE, stateId, cookieOptions(STATE_TTL_SECONDS));
		return c.redirect(
			upstreamAuthorizationUrl(
				provider.data,
				credentialsFor(c.env, provider.data),
				callbackUrl(c, provider.data),
				stateId,
			),
		);
	});

	app.get("/callback/:provider", async (c) => {
		const provider = Provider.safeParse(c.req.param("provider"));
		const query = CallbackQuery.safeParse(c.req.query());
		if (!provider.success || !query.success || query.data.state !== getCookie(c, STATE_COOKIE)) {
			return render(c, <ErrorPage title="Sign-in expired" message="Please start again." />, 400);
		}
		const pending = await takePending(c.env.OAUTH_KV, query.data.state);
		clearState(c);
		if (!pending) {
			return render(c, <ErrorPage title="Sign-in expired" message="Please start again." />, 400);
		}
		let identity: Awaited<ReturnType<typeof exchangeUpstreamCode>>;
		try {
			identity = await exchangeUpstreamCode(
				provider.data,
				credentialsFor(c.env, provider.data),
				query.data.code,
				callbackUrl(c, provider.data),
				deps.fetchFn,
			);
		} catch (error) {
			if (error instanceof UpstreamError) {
				return render(c, <ErrorPage title="Sign-in failed" message={error.message} />, 502);
			}
			throw error;
		}
		const userId = await new LedgerStore(c.env.DB).findOrCreateUserByIdentity(identity, deps.now(), () =>
			crypto.randomUUID(),
		);
		setCookie(
			c,
			SESSION_COOKIE,
			await createSession(userId, deps.now(), c.env.COOKIE_SECRET),
			cookieOptions(SESSION_TTL_SECONDS),
		);
		if (pending.kind === "authorize") return completeGrant(c, pending.request, userId, pending.clientName);
		return c.redirect("/ledger");
	});

	app.post("/logout", (c) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
		return c.redirect("/");
	});
}
```

Replace `src/web/app.ts`:

```ts
import { Hono } from "hono";
import type { WebDeps, WebEnv } from "./guards";
import { registerAuthRoutes } from "./auth";

const defaultDeps: WebDeps = {
	fetchFn: (input, init) => fetch(input, init),
	now: () => Date.now(),
};

export function createWebApp(deps: WebDeps = defaultDeps) {
	const app = new Hono<WebEnv>();
	registerAuthRoutes(app, deps);
	app.get("/", (c) => c.redirect("/login"));
	app.get("/login", (c) =>
		c.html(
			'<!doctype html><title>Topic Ledger</title><h1>Topic Ledger</h1><p><a href="/login/github">Continue with GitHub</a> · <a href="/login/google">Continue with Google</a></p>',
		),
	);
	return app;
}
```

(Task 11 replaces the `/` and `/login` placeholders with the dashboard landing page.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/session.test.ts test/upstream.test.ts test/auth-flow.test.ts test/worker.test.ts`
Expected: PASS.

If `tsc` reports that the zod-parsed `pending.request` is not assignable to `AuthRequest`, align `AuthRequestSchema` with the library's `AuthRequest` fields (read `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts`) rather than casting.

- [ ] **Step 9: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/auth src/web test/session.test.ts test/upstream.test.ts test/auth-flow.test.ts
git commit -m "feat: add GitHub/Google sign-in and MCP client authorization flow" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 11: Dashboard

**Files:**
- Create: `src/web/prompt.ts`, `src/web/dashboard.tsx`
- Modify: `src/web/app.ts` (register dashboard routes; remove the `/` and `/login` placeholders)
- Test: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `sessionUserId`, `isSameOrigin`, `WebDeps`, `WebEnv` (Task 10); `Layout`, `ErrorPage`, `render` (Task 10); `SESSION_COOKIE`, `createSession` (Task 10); `ledgerFromEnv` (Task 5); `Ledger.list/forget/stats/deleteAccount` (Task 6); `globalMinUsersFromEnv` (Task 5); `createPersonalToken` (Task 8); `LedgerStore.listTokens/revokeToken` (Task 4); `env.OAUTH_PROVIDER.listUserGrants/revokeGrant`; test helpers `issueOAuthTokens`, `makeTestLedger`, `seedUser`, `uniqueCategory`, `ORIGIN`.
- Produces:
  - `src/web/prompt.ts` — `BRIEF_PROMPT_SNIPPET: string`
  - `src/web/dashboard.tsx` — `registerDashboardRoutes(app: Hono<WebEnv>, deps: WebDeps): void` with `GET /`, `GET /ledger`, `POST /entries/:id/forget`, `GET /repeats`, `GET /global`, `GET /access`, `POST /tokens`, `POST /tokens/:id/revoke`, `POST /grants/:id/revoke`, `GET /connect`, `GET /account`, `POST /account/delete`

Every page requires a session (otherwise redirect to `/`). Every `POST` also requires `Origin` equal to `PUBLIC_ORIGIN` (otherwise 403). Hono JSX escapes all interpolated text, which is what keeps user-supplied topic names safe.

- [ ] **Step 1: Write the failing tests**

`test/dashboard.test.ts`:

```ts
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { providerOptions } from "../src/index";
import { createWebApp } from "../src/web/app";
import { issueOAuthTokens, makeTestLedger, ORIGIN, seedUser, testStore, uniqueCategory } from "./helpers";

const app = createWebApp();
const webEnv = () => ({ ...env, OAUTH_PROVIDER: getOAuthApi(providerOptions, env) });

async function sessionCookie(userId: string): Promise<string> {
	return `${SESSION_COOKIE}=${await createSession(userId, Date.now(), env.COOKIE_SECRET)}`;
}

function get(path: string, cookie = ""): Promise<Response> {
	return app.request(`${ORIGIN}${path}`, { headers: { cookie } }, webEnv());
}

function post(path: string, cookie: string, form: Record<string, string> = {}, sameOrigin = true) {
	const headers: Record<string, string> = { cookie };
	if (sameOrigin) headers.origin = ORIGIN;
	return app.request(
		`${ORIGIN}${path}`,
		{ method: "POST", headers, body: new URLSearchParams(form) },
		webEnv(),
	);
}

describe("landing and session gate", () => {
	it("shows sign-in to visitors, redirects signed-in users, and gates pages", async () => {
		const landing = await get("/");
		expect(landing.status).toBe(200);
		expect(await landing.text()).toContain("Continue with GitHub");

		expect((await get("/ledger")).headers.get("location")).toBe("/");

		const cookie = await sessionCookie(await seedUser());
		expect((await get("/", cookie)).headers.get("location")).toBe("/ledger");
	});
});

describe("ledger page", () => {
	it("lists topics with escaped names and forgets only same-origin requests", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const category = uniqueCategory();
		const result = await makeTestLedger().claim(userId, {
			category,
			name: "<script>alert(1)</script> Theorem",
			force: false,
		});
		if (result.status !== "claimed") throw new Error("expected claimed");

		const html = await (await get("/ledger", cookie)).text();
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Theorem");
		expect(html).not.toContain("<script>alert(1)</script>");

		expect((await post(`/entries/${result.entry.id}/forget`, cookie, {}, false)).status).toBe(403);
		const forgot = await post(`/entries/${result.entry.id}/forget`, cookie);
		expect(forgot.headers.get("location")).toBe("/ledger");
		expect(await testStore().listEntries(userId, { category, limit: 10 })).toEqual([]);
	});
});

describe("repeats pages", () => {
	it("shows the phrasings that were blocked and renders the global page", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Euler's Identity", force: false });
		await ledger.claim(userId, { category, name: "EULER IDENTITY", force: false });

		const repeats = await (await get("/repeats", cookie)).text();
		expect(repeats).toContain("Euler&#39;s Identity");
		expect(repeats).toContain("EULER IDENTITY");

		const global = await get("/global", cookie);
		expect(global.status).toBe(200);
		expect(await global.text()).toContain("Global repeats");
	});
});

describe("access page", () => {
	it("creates a personal token shown once, which works until revoked", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);

		const created = await post("/tokens", cookie, { label: "cron" });
		const tokens = (await created.text()).match(/ldg_[A-Za-z0-9_-]{43}/g) ?? [];
		expect(tokens).toHaveLength(1);
		const token = tokens[0] ?? "";

		const auth = { headers: { authorization: `Bearer ${token}` } };
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, auth)).status).toBe(200);

		const [row] = await testStore().listTokens(userId);
		expect((await post(`/tokens/${row?.id}/revoke`, cookie)).headers.get("location")).toBe("/access");
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, auth)).status).toBe(401);
		expect(await (await get("/access", cookie)).text()).not.toMatch(/ldg_[A-Za-z0-9_-]{43}/);
	});

	it("lists connected OAuth clients and revokes them", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const { accessToken } = await issueOAuthTokens(userId);

		expect(await (await get("/access", cookie)).text()).toContain('action="/grants/');
		const { items } = await getOAuthApi(providerOptions, env).listUserGrants(userId);
		expect(items).toHaveLength(1);

		await post(`/grants/${items[0]?.id}/revoke`, cookie);
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(401);
	});
});

describe("connect page", () => {
	it("shows the MCP URL and the prompt snippet", async () => {
		const html = await (await get("/connect", await sessionCookie(await seedUser()))).text();
		expect(html).toContain(`${ORIGIN}/mcp`);
		expect(html).toContain("claim_topic");
	});
});

describe("account deletion", () => {
	it("requires typed confirmation, then removes the user, their grants and session", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const { accessToken } = await issueOAuthTokens(userId);
		await makeTestLedger().claim(userId, { category: uniqueCategory(), name: "Hypatia", force: false });

		expect((await post("/account/delete", cookie, { confirm: "nope" })).status).toBe(400);

		const deleted = await post("/account/delete", cookie, { confirm: "delete" });
		expect(deleted.headers.get("location")).toBe("/");
		expect(deleted.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
		expect(await testStore().getUser(userId)).toBeNull();
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(401);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard.test.ts`
Expected: FAIL — `/ledger` and the other dashboard routes return 404; `/` redirects to `/login`.

- [ ] **Step 3: Implement the prompt snippet and dashboard**

`src/web/prompt.ts`:

```ts
/** Recommended wording for the scheduled brief. Keep README.md's copy identical. */
export const BRIEF_PROMPT_SNIPPET = [
	'Before writing the math section, choose a topic and call claim_topic with category "math"',
	"and the topic's common name. If the result is \"repeat\", choose a different topic and call",
	'again, up to 5 times. If the result is "claimed" but lists possible_matches you judge to be',
	"the same topic, call forget_topic on the new entry and choose again. Do the same with",
	'category "person" for the historical figure.',
].join(" ");
```

`src/web/dashboard.tsx`:

```tsx
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Entry, RepeatStat } from "../api/schemas";
import { SESSION_COOKIE } from "../auth/session";
import { createPersonalToken } from "../auth/tokens";
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import type { TokenRow } from "../core/rows";
import { toIso } from "../core/wire";
import { ledgerFromEnv } from "../services";
import { LedgerStore } from "../store/d1";
import { isSameOrigin, sessionUserId, type WebDeps, type WebEnv } from "./guards";
import { ErrorPage, Layout, render } from "./layout";
import { BRIEF_PROMPT_SNIPPET } from "./prompt";

const TokenForm = z.object({ label: z.string().trim().min(1).max(64) });
const DeleteForm = z.object({ confirm: z.literal("delete") });
const GrantMetadata = z.object({ clientName: z.string() });
const PAGE_LIMIT = 100;
const MAX_GRANT_SWEEPS = 50;

type Handler = (c: Context<WebEnv>, userId: string) => Promise<Response>;

function LandingPage() {
	return (
		<Layout title="Welcome">
			<h1>Topic Ledger</h1>
			<p>Keeps your daily brief from repeating itself, and counts how often it tried.</p>
			<p>
				<a href="/login/github">Continue with GitHub</a> · <a href="/login/google">Continue with Google</a>
			</p>
		</Layout>
	);
}

function LedgerPage(props: { entries: Entry[] }) {
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
						{props.entries.map((entry) => (
							<tr>
								<td>{entry.display_name}</td>
								<td>{entry.category}</td>
								<td>{entry.created_at.slice(0, 10)}</td>
								<td>{entry.hit_count}</td>
								<td>
									<form class="inline" method="post" action={`/entries/${entry.id}/forget`}>
										<button type="submit">Forget</button>
									</form>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p>Showing the newest {PAGE_LIMIT} topics.</p>
		</Layout>
	);
}

function RepeatsPage(props: { title: string; repeats: RepeatStat[]; minUsers?: number }) {
	return (
		<Layout title={props.title} signedIn>
			<h1>{props.title}</h1>
			{props.minUsers !== undefined ? (
				<p>Topics appear here once at least {props.minUsers} people have tried to repeat them.</p>
			) : null}
			{props.repeats.length === 0 ? (
				<p>No repeats yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Hits</th>
							<th>{props.minUsers !== undefined ? "People" : "Blocked phrasings"}</th>
						</tr>
					</thead>
					<tbody>
						{props.repeats.map((repeat) => (
							<tr>
								<td>{repeat.display_name}</td>
								<td>{repeat.category}</td>
								<td>{repeat.hit_count}</td>
								<td>
									{repeat.distinct_users !== undefined ? (
										repeat.distinct_users
									) : (
										<ul>
											{(repeat.recent_phrasings ?? []).map((phrasing) => (
												<li>{phrasing}</li>
											))}
										</ul>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Layout>
	);
}

function AccessPage(props: { tokens: TokenRow[]; grants: GrantSummary[]; newToken?: string }) {
	return (
		<Layout title="Access" signedIn>
			<h1>Access</h1>
			{props.newToken ? (
				<>
					<p>
						<strong>New token — copy it now, it will not be shown again:</strong>
					</p>
					<pre>{props.newToken}</pre>
				</>
			) : null}
			<h2>Personal API tokens</h2>
			<form method="post" action="/tokens">
				<label>
					Label <input name="label" maxLength={64} required />
				</label>{" "}
				<button type="submit">Create token</button>
			</form>
			<table>
				<tbody>
					{props.tokens.map((token) => (
						<tr>
							<td>{token.label}</td>
							<td>created {toIso(token.created_at).slice(0, 10)}</td>
							<td>{token.last_used_at ? `used ${toIso(token.last_used_at).slice(0, 10)}` : "never used"}</td>
							<td>
								{token.revoked_at ? (
									"revoked"
								) : (
									<form class="inline" method="post" action={`/tokens/${token.id}/revoke`}>
										<button type="submit">Revoke</button>
									</form>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<h2>Connected clients</h2>
			<table>
				<tbody>
					{props.grants.map((grant) => {
						const metadata = GrantMetadata.safeParse(grant.metadata);
						return (
							<tr>
								<td>{metadata.success ? metadata.data.clientName : grant.clientId}</td>
								<td>
									<form class="inline" method="post" action={`/grants/${grant.id}/revoke`}>
										<button type="submit">Disconnect</button>
									</form>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</Layout>
	);
}

function ConnectPage(props: { origin: string }) {
	const curl = [
		`curl -X POST ${props.origin}/api/v1/claims`,
		'  -H "Authorization: Bearer ldg_YOUR_TOKEN"',
		'  -H "content-type: application/json"',
		`  -d '{"category":"math","name":"Euler identity"}'`,
	].join(" \\\n");
	return (
		<Layout title="Connect" signedIn>
			<h1>Connect</h1>
			<h2>claude.ai and other MCP clients</h2>
			<p>Add a custom connector with this URL, then sign in when prompted:</p>
			<pre>{`${props.origin}/mcp`}</pre>
			<h2>Scripts and cron jobs</h2>
			<p>
				Create a token on the <a href="/access">Access</a> page, then:
			</p>
			<pre>{curl}</pre>
			<h2>Prompt for your brief</h2>
			<pre>{BRIEF_PROMPT_SNIPPET}</pre>
		</Layout>
	);
}

function AccountPage() {
	return (
		<Layout title="Account" signedIn>
			<h1>Delete account</h1>
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

async function accessPage(c: Context<WebEnv>, userId: string, newToken?: string) {
	const tokens = await new LedgerStore(c.env.DB).listTokens(userId);
	const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(userId);
	return <AccessPage tokens={tokens} grants={items} newToken={newToken} />;
}

async function revokeAllGrants(c: Context<WebEnv>, userId: string): Promise<void> {
	for (let sweep = 0; sweep < MAX_GRANT_SWEEPS; sweep++) {
		const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(userId);
		if (items.length === 0) return;
		for (const grant of items) await c.env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
	}
	throw new Error(`grants for ${userId} still present after ${MAX_GRANT_SWEEPS} sweeps`);
}

export function registerDashboardRoutes(app: Hono<WebEnv>, deps: WebDeps): void {
	const page = (handler: Handler) => async (c: Context<WebEnv>) => {
		const userId = await sessionUserId(c, deps.now());
		return userId ? handler(c, userId) : c.redirect("/");
	};
	const action = (handler: Handler) => async (c: Context<WebEnv>) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		const userId = await sessionUserId(c, deps.now());
		return userId ? handler(c, userId) : c.redirect("/");
	};

	app.get("/", async (c) =>
		(await sessionUserId(c, deps.now())) ? c.redirect("/ledger") : render(c, <LandingPage />),
	);

	app.get(
		"/ledger",
		page(async (c, userId) => {
			const { entries } = await ledgerFromEnv(c.env).list(userId, { limit: PAGE_LIMIT });
			return render(c, <LedgerPage entries={entries} />);
		}),
	);

	app.post(
		"/entries/:id/forget",
		action(async (c, userId) => {
			try {
				await ledgerFromEnv(c.env).forget(userId, c.req.param("id"));
			} catch (error) {
				if (!(error instanceof LedgerError && error.code === "not_found")) throw error;
			}
			return c.redirect("/ledger");
		}),
	);

	app.get(
		"/repeats",
		page(async (c, userId) => {
			const stats = await ledgerFromEnv(c.env).stats(
				userId,
				{ scope: "me", limit: PAGE_LIMIT },
				globalMinUsersFromEnv(c.env),
			);
			return render(c, <RepeatsPage title="Your repeats" repeats={stats.repeats} />);
		}),
	);

	app.get(
		"/global",
		page(async (c, userId) => {
			const minUsers = globalMinUsersFromEnv(c.env);
			const stats = await ledgerFromEnv(c.env).stats(userId, { scope: "global", limit: PAGE_LIMIT }, minUsers);
			return render(c, <RepeatsPage title="Global repeats" repeats={stats.repeats} minUsers={minUsers} />);
		}),
	);

	app.get(
		"/access",
		page(async (c, userId) => render(c, await accessPage(c, userId))),
	);

	app.post(
		"/tokens",
		action(async (c, userId) => {
			const form = TokenForm.safeParse(await c.req.parseBody());
			if (!form.success) {
				return render(c, <ErrorPage title="Invalid label" message="Labels are 1-64 characters." />, 400);
			}
			const { token } = await createPersonalToken(
				new LedgerStore(c.env.DB),
				userId,
				form.data.label,
				deps.now(),
				() => crypto.randomUUID(),
			);
			return render(c, await accessPage(c, userId, token));
		}),
	);

	app.post(
		"/tokens/:id/revoke",
		action(async (c, userId) => {
			await new LedgerStore(c.env.DB).revokeToken(userId, c.req.param("id"), deps.now());
			return c.redirect("/access");
		}),
	);

	app.post(
		"/grants/:id/revoke",
		action(async (c, userId) => {
			await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param("id"), userId);
			return c.redirect("/access");
		}),
	);

	app.get(
		"/connect",
		page(async (c) => render(c, <ConnectPage origin={c.env.PUBLIC_ORIGIN} />)),
	);

	app.get(
		"/account",
		page(async (c) => render(c, <AccountPage />)),
	);

	app.post(
		"/account/delete",
		action(async (c, userId) => {
			if (!DeleteForm.safeParse(await c.req.parseBody()).success) {
				return render(c, <ErrorPage title="Not deleted" message='Type "delete" to confirm.' />, 400);
			}
			await revokeAllGrants(c, userId);
			await ledgerFromEnv(c.env).deleteAccount(userId);
			deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
			return c.redirect("/");
		}),
	);
}
```

Replace `src/web/app.ts` with:

```ts
import { Hono } from "hono";
import { registerAuthRoutes } from "./auth";
import { registerDashboardRoutes } from "./dashboard";
import type { WebDeps, WebEnv } from "./guards";

const defaultDeps: WebDeps = {
	fetchFn: (input, init) => fetch(input, init),
	now: () => Date.now(),
};

export function createWebApp(deps: WebDeps = defaultDeps) {
	const app = new Hono<WebEnv>();
	registerAuthRoutes(app, deps);
	registerDashboardRoutes(app, deps);
	return app;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard.test.ts test/auth-flow.test.ts`
Expected: PASS.

If `deleteCookie` produces a header that does not start with `__Host-ledger_session=;`, print `deleted.headers.getSetCookie()` and adjust the assertion to the actual expired-cookie format — the requirement is that the session cookie is expired, not a specific serialization.

- [ ] **Step 5: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add src/web test/dashboard.test.ts
git commit -m "feat: add dashboard for ledger, repeats, access and account" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```


---

### Task 12: Calibration script, deploy workflow, README

**Files:**
- Create: `scripts/calibration-pairs.ts`, `scripts/calibrate.ts`, `.github/workflows/deploy.yml`
- Replace: `README.md`

**Interfaces:**
- Consumes: `EMBEDDING_MODEL` value (Task 5, copied — the script runs in Node, outside the Worker bundle); `BRIEF_PROMPT_SNIPPET` text (Task 11, copied into the README).
- Produces: `node scripts/calibrate.ts` (prints per-pair cosine scores and suggested thresholds); tag-push deploy workflow; README with usage, development, provisioning and release instructions.

No automated test: the calibration script needs a live Cloudflare account and the workflow runs only on tags. The steps below verify what can be verified locally.

- [ ] **Step 1: Write the calibration pairs**

`scripts/calibration-pairs.ts`:

```ts
export interface CalibrationPair {
	a: string;
	b: string;
	/** true when a brief should treat b as a repeat of a. */
	same: boolean;
}

export const PAIRS: CalibrationPair[] = [
	{ a: "Euler's identity", b: "e^(iπ) + 1 = 0", same: true },
	{ a: "Fermat's Last Theorem", b: "Wiles' proof of Fermat's Last Theorem", same: true },
	{ a: "Pythagorean theorem", b: "a² + b² = c²", same: true },
	{ a: "Gödel's incompleteness theorems", b: "Incompleteness theorem", same: true },
	{ a: "Banach–Tarski paradox", b: "Banach-Tarski theorem", same: true },
	{ a: "Riemann hypothesis", b: "Zeros of the Riemann zeta function", same: true },
	{ a: "Monty Hall problem", b: "Monty Hall paradox", same: true },
	{ a: "Infinitude of primes", b: "Euclid's proof that there are infinitely many primes", same: true },
	{ a: "Leonhard Euler", b: "Euler", same: true },
	{ a: "Ada Lovelace", b: "Augusta Ada King, Countess of Lovelace", same: true },
	{ a: "Isaac Newton", b: "Sir Isaac Newton", same: true },
	{ a: "Hypatia", b: "Hypatia of Alexandria", same: true },
	{ a: "Euler's identity", b: "Euler's totient function", same: false },
	{ a: "Fermat's Last Theorem", b: "Fermat's little theorem", same: false },
	{ a: "Riemann hypothesis", b: "Riemann integral", same: false },
	{ a: "Gaussian elimination", b: "Gaussian curvature", same: false },
	{ a: "Cantor's diagonal argument", b: "Cantor set", same: false },
	{ a: "Pythagorean theorem", b: "Pythagorean tuning", same: false },
	{ a: "Four color theorem", b: "Five color theorem", same: false },
	{ a: "Mandelbrot set", b: "Julia set", same: false },
	{ a: "Hilbert's hotel", b: "Hilbert space", same: false },
	{ a: "Isaac Newton", b: "Gottfried Wilhelm Leibniz", same: false },
	{ a: "Marie Curie", b: "Pierre Curie", same: false },
	{ a: "Carl Friedrich Gauss", b: "Carl Gustav Jacob Jacobi", same: false },
];
```

- [ ] **Step 2: Write the calibration script**

`scripts/calibrate.ts` (runs with Node's built-in TypeScript type stripping; outside `tsc`'s `include`):

```ts
import { z } from "zod";
import { PAIRS } from "./calibration-pairs.ts";

const MODEL = "@cf/google/embeddinggemma-300m";

const AiRunResponse = z.object({
	success: z.boolean(),
	result: z.object({ data: z.array(z.array(z.number())) }).optional(),
	errors: z.array(z.object({ message: z.string() })).default([]),
});

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
	console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI read) first.");
	process.exit(1);
}

async function embed(texts: string[]): Promise<number[][]> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
			body: JSON.stringify({ text: texts }),
		},
	);
	const body = AiRunResponse.parse(await response.json());
	if (!response.ok || !body.success || !body.result) {
		throw new Error(`Workers AI ${response.status}: ${body.errors.map((e) => e.message).join("; ")}`);
	}
	return body.result.data;
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const texts = [...new Set(PAIRS.flatMap((pair) => [pair.a, pair.b]))];
const vectors = new Map<string, number[]>();
const embeddings = await embed(texts);
texts.forEach((text, i) => {
	const vector = embeddings[i];
	if (!vector) throw new Error(`no embedding returned for ${text}`);
	vectors.set(text, vector);
});

const scored = PAIRS.map((pair) => ({
	...pair,
	score: cosine(vectors.get(pair.a) ?? [], vectors.get(pair.b) ?? []),
})).sort((x, y) => y.score - x.score);

for (const pair of scored) {
	console.log(`${pair.score.toFixed(3)}  ${pair.same ? "SAME" : "diff"}  ${pair.a}  |  ${pair.b}`);
}

const sameScores = scored.filter((p) => p.same).map((p) => p.score);
const differentScores = scored.filter((p) => !p.same).map((p) => p.score);
const minSame = Math.min(...sameScores);
const maxDifferent = Math.max(...differentScores);
console.log(`\nmin SAME score:      ${minSame.toFixed(3)}`);
console.log(`max different score: ${maxDifferent.toFixed(3)}`);
console.log(
	`suggested SEMANTIC_REPEAT_THRESHOLD   = ${(Math.ceil((maxDifferent + 0.005) * 100) / 100).toFixed(2)} (just above every different pair)`,
);
console.log(
	`suggested SEMANTIC_POSSIBLE_THRESHOLD = ${(Math.floor(Math.min(minSame, maxDifferent) * 100) / 100).toFixed(2)} (surface borderline pairs for the LLM)`,
);
```

Run: `node scripts/calibrate.ts` without credentials
Expected: prints `Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN …` and exits 1.

Run: `npm run lint`
Expected: pass (Biome covers `scripts/**`).

- [ ] **Step 3: Write the deploy workflow**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    tags: ["v*"]

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - name: Tag matches package.json version
        run: |
          expected="v$(node -p "require('./package.json').version")"
          if [ "$GITHUB_REF_NAME" != "$expected" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json ($expected)"; exit 1
          fi
      - run: npm ci
      - run: npm run check
      - run: npx wrangler d1 migrations apply topic-ledger --remote
      - run: npx wrangler deploy
```

This workflow creates no GitHub release: pushing the tag deploys, and the deploy is the last step of the release loop.

- [ ] **Step 4: Write the README**

Replace `README.md`:

````markdown
# Topic Ledger

A small multi-user service that keeps an LLM daily brief from repeating itself.
Before the brief writes about a math topic or a historical figure, it *claims* the
topic here. Repeats — including rephrasings like "Euler's identity" vs
"e^(iπ)+1=0" — are refused, and every refused attempt is counted, so you can see
which topics the model keeps wanting to come back to.

- **MCP** (claude.ai connectors, openclaw): `https://ledger.twkr.io/mcp`
- **REST** (cron, scripts): `https://ledger.twkr.io/api/v1`
- **Dashboard:** `https://ledger.twkr.io`

Design: [`docs/superpowers/specs/2026-09-14-topic-ledger-design.md`](docs/superpowers/specs/2026-09-14-topic-ledger-design.md)

## Connect your brief

### claude.ai scheduled task

1. Settings → Connectors → Add custom connector → `https://ledger.twkr.io/mcp`.
2. Sign in with GitHub or Google and approve.
3. Add this to the scheduled task's prompt:

> Before writing the math section, choose a topic and call claim_topic with category "math" and the topic's common name. If the result is "repeat", choose a different topic and call again, up to 5 times. If the result is "claimed" but lists possible_matches you judge to be the same topic, call forget_topic on the new entry and choose again. Do the same with category "person" for the historical figure.

### Scripts and cron

Create a token on the dashboard's **Access** page, then:

```sh
curl -X POST https://ledger.twkr.io/api/v1/claims \
  -H "Authorization: Bearer ldg_YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"category":"math","name":"Euler identity"}'
```

| Method | Path | Body / query | Result |
|---|---|---|---|
| POST | `/api/v1/claims` | `{category, name, force?}` | `{status: "claimed", entry, forced, possible_matches, semantic}` or `{status: "repeat", matches, semantic}` |
| POST | `/api/v1/checks` | `{category, name}` | `{likely_repeat, matches, semantic}` (records nothing) |
| GET | `/api/v1/entries` | `?category=&limit=&since=` | `{entries}` |
| DELETE | `/api/v1/entries/:id` | — | 204 |
| GET | `/api/v1/stats` | `?scope=me\|global&category=&limit=` | `{scope, repeats}` |

Errors are `{error: {code, message}}` with codes `unauthorized` (401),
`invalid_input` (400), `not_found` (404), `rate_limited` (429),
`upstream_unavailable` (503).

## Development

```sh
npm install
npm run check        # tsc + biome + vitest
npm run dev          # wrangler dev (needs .dev.vars with the secrets below)
```

Tests run in the Workers runtime against a local D1 using `wrangler.test.jsonc`,
which has no Workers AI or Vectorize binding; semantic matching is covered with an
in-memory fake.

## Provisioning (once, by the Cloudflare account owner)

Account: Cycle Five Syndicate (`e24f723fe819bea445d08ab472d549f6`), which owns the `twkr.io` zone.

```sh
npx wrangler d1 create topic-ledger                 # put database_id into wrangler.jsonc
npx wrangler kv namespace create topic-ledger-oauth # put id into wrangler.jsonc
npx wrangler vectorize create topic-ledger-v1 --dimensions=768 --metric=cosine
# Metadata indexes MUST exist before the first vector is inserted:
npx wrangler vectorize create-metadata-index topic-ledger-v1 --property-name=user_id --type=string
npx wrangler vectorize create-metadata-index topic-ledger-v1 --property-name=category --type=string
npx wrangler vectorize list-metadata-index topic-ledger-v1
```

OAuth apps:

- GitHub (Settings → Developer settings → OAuth Apps): callback `https://ledger.twkr.io/callback/github`
- Google (Cloud Console → Credentials → OAuth client, Web): redirect `https://ledger.twkr.io/callback/google`; publish the consent screen (scopes `openid email profile` need no verification)

Secrets:

```sh
for s in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET COOKIE_SECRET; do
  npx wrangler secret put "$s"
done                                   # COOKIE_SECRET: openssl rand -hex 32
gh secret set CLOUDFLARE_API_TOKEN     # Workers, D1, KV, Vectorize, AI, zone DNS for twkr.io
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Calibrate the semantic thresholds against real embeddings and record the output in
`docs/calibration.md`:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/calibrate.ts
```

## Release

Bump `version` in `package.json`, open a PR, merge when CI is green, then:

```sh
git checkout master && git pull --ff-only
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The tag push runs `.github/workflows/deploy.yml` (migrations, then `wrangler deploy`).
No GitHub release is created.
````

- [ ] **Step 5: Verify the README prompt matches the dashboard snippet**

Run: `node -e 'import("./src/web/prompt.ts").then(m => { const readme = require("fs").readFileSync("README.md", "utf8"); console.log(readme.includes(m.BRIEF_PROMPT_SNIPPET) ? "match" : "MISMATCH"); })'`
Expected: `match`

- [ ] **Step 6: Gate and commit**

Run: `npm run format && npm run check`
Expected: pass.

```bash
git add scripts .github/workflows/deploy.yml README.md
git commit -m "chore: add calibration script, tag deploy workflow and README" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 13: Provision, calibrate, and release v0.1.0 — **account owner steps**

Every step here touches external accounts (Cloudflare, GitHub, Google) or publishes. **A subagent must not run these.** The controller hands this task to the user, runs only what the user explicitly approves, and records what happened.

**Files:**
- Modify: `wrangler.jsonc` (add `database_id` and the KV `id`)
- Create: `docs/calibration.md`
- Possibly modify: `wrangler.jsonc` `vars` thresholds

- [ ] **Step 1: Provision resources** — run the README "Provisioning" commands. Add the printed D1 `database_id` to the `d1_databases` entry and the KV `id` to the `kv_namespaces` entry in `wrangler.jsonc`. Confirm `npx wrangler vectorize list-metadata-index topic-ledger-v1` lists `user_id` and `category` **before** anything is deployed.

- [ ] **Step 2: Create OAuth apps and set secrets** — as in the README.

- [ ] **Step 3: Calibrate** — run `node scripts/calibrate.ts` with credentials. Write `docs/calibration.md` containing the date, the model, the full printed table, and the chosen `SEMANTIC_REPEAT_THRESHOLD` / `SEMANTIC_POSSIBLE_THRESHOLD`. If the chosen values differ from `0.85` / `0.75`, update both `wrangler.jsonc` vars and `DEFAULT_THRESHOLDS` in `src/config.ts`, plus `test/config.test.ts` expectations, then `npm run check`.

- [ ] **Step 4: Commit, PR, CI**

```bash
git add wrangler.jsonc docs/calibration.md src/config.ts test/config.test.ts
git commit -m "chore: provision production resources and calibrate thresholds" -m "Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
git push -u origin feat/topic-ledger
gh pr create --title "Topic Ledger v0.1.0" --body-file <(printf '%s\n' "Implements docs/superpowers/specs/2026-09-14-topic-ledger-design.md per docs/superpowers/plans/2026-09-14-topic-ledger.md." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
```

Wait for CI to pass and review feedback to be resolved.

- [ ] **Step 5: Merge and tag** (after approval)

```bash
gh pr merge --squash
git checkout master && git pull --ff-only
git tag -s v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

- [ ] **Step 6: Smoke-test production**

```sh
curl -s https://ledger.twkr.io/.well-known/oauth-authorization-server | head -c 300
```
Expected: JSON containing `"registration_endpoint":"https://ledger.twkr.io/register"`.

Then sign in on `https://ledger.twkr.io`, create a token on **Access**, and:

```sh
T=ldg_...   # the new token
curl -s -X POST https://ledger.twkr.io/api/v1/claims -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"category":"smoke","name":"Euler identity"}'
curl -s -X POST https://ledger.twkr.io/api/v1/claims -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"category":"smoke","name":"e^(i pi) + 1 = 0"}'
```
Expected: first `"status":"claimed"` with `"semantic":"ok"`; wait ~10 s for Vectorize, then the second returns `"status":"repeat"` with a `semantic` match (if it is claimed instead, note its score in `docs/calibration.md`). Forget the smoke entries from the dashboard.

- [ ] **Step 7: Connect the brief** — add the connector in claude.ai (Settings → Connectors → `https://ledger.twkr.io/mcp`), add the prompt snippet to the scheduled task, and check the dashboard after the next scheduled run.
