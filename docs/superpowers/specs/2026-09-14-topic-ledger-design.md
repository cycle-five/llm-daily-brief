# Topic Ledger — Design

- **Date:** 2026-09-14
- **Status:** Design approved in brainstorming; awaiting spec review
- **Branch:** `feat/topic-ledger`
- **Amended 2026-09-15:** embedding model and semantic thresholds changed after calibration
  (`docs/calibration.md`); semantic matches are advisory by default.
- **Amended 2026-09-15:** near misses, verdicts (`skip_topic` / `keep_topic`) and topic
  aliases — see `docs/superpowers/specs/2026-09-15-near-misses-design.md`, which wins where
  the two disagree.

## Problem

The daily brief is a claude.ai scheduled task whose prompt asks for a random
math topic and a random historical person. Each run has no memory of earlier
runs, so topics repeat often. We want a ledger the brief consults before
choosing, which blocks repeats (including rephrasings) and records how often
each topic *would* have repeated — that repeat count is itself interesting.

The service must be usable by other people, from other schedulers (openclaw,
cron), with OAuth.

## Goals

1. Block repeats per user and per category: exact and spelling-variant matches
   block; likely rephrasings are surfaced as possible matches for the caller to
   judge (see `docs/calibration.md`).
2. Record every blocked repeat ("hit"), with the phrasing that was attempted.
3. Serve MCP (claude.ai connectors, openclaw) and REST (cron, scripts) from one
   core, with identical semantics.
4. Multi-user: OAuth sign-in with GitHub or Google; private ledgers; an
   anonymous global leaderboard of most-repeated topics.
5. A small signed-in dashboard to browse the ledger, repeats, and access.

## Non-goals (this iteration)

Bulk import of past topics, account linking across providers, category
aliasing, read-only scopes, shared/team ledgers. See [Future work](#future-work).

## Architecture

One TypeScript Cloudflare Worker, deployed to the custom domain
**`ledger.twkr.io`**. The custom domain creates its own Worker-owned DNS record;
`*.twkr.io` exists only as a tunnel ingress rule (there is no wildcard DNS
record, verified 2026-09-15), so the homelab tunnel never sees this hostname.

| Route | Purpose | Auth |
|---|---|---|
| `/mcp` | MCP server (stateless `createMcpHandler`) | OAuth bearer or personal token |
| `/api/v1/*` | REST API (Hono) | OAuth bearer or personal token |
| `/authorize`, `/token`, `/register`, `/.well-known/*` | OAuth 2.1 + dynamic client registration (`@cloudflare/workers-oauth-provider`) | — |
| `/login/:provider`, `/callback/:provider` | GitHub / Google upstream sign-in | — |
| `/`, `/ledger`, `/repeats`, `/global`, `/access`, `/connect`, `/account` | Dashboard (Hono JSX, server-rendered) | Session cookie |

### Bindings

| Binding | Resource | Notes |
|---|---|---|
| `DB` | D1 `topic-ledger` | Source of truth |
| `VECTORS` | Vectorize `topic-ledger-v2` | 1024 dims, cosine; metadata indexes `user_id`, `category` (string) |
| `AI` | Workers AI | `@cf/qwen/qwen3-embedding-0.6b` (at most 32 texts per call) |
| `OAUTH_KV` | KV `topic-ledger-oauth` | Required by the OAuth provider; also holds sign-in state |
| `CLAIM_LIMITER` | Rate limit | 60 requests / 60 s, keyed by user id |
| cron | `*/15 * * * *` | Backfills pending embeddings |

Vectorize metadata indexes **must be created before any vector is inserted**;
vectors inserted earlier are not filterable on those fields.

Vars: `SEMANTIC_REPEAT_THRESHOLD` (default `1`, i.e. semantic matches never block),
`SEMANTIC_POSSIBLE_THRESHOLD` (default `0.78`), `TRIGRAM_REPEAT_THRESHOLD`
(default `0.6`), `GLOBAL_MIN_USERS` (default `2`). Semantic defaults come from
`docs/calibration.md`.

Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET`.

### Project layout

```
src/
  index.ts              entry: token routing, OAuthProvider, scheduled handler
  env.ts                Env and Props types
  core/normalize.ts     normalize(text) — pure
  core/trigram.ts       trigram Jaccard — pure
  core/match.ts         match decision rules — pure
  core/ledger.ts        claim / check / list / forget / stats orchestration
  store/d1.ts           typed D1 queries
  semantic/index.ts     SemanticIndex interface
  semantic/cloudflare.ts  Workers AI + Vectorize implementation
  api/schemas.ts        zod wire schemas; TS types inferred from them
  api/rest.ts           Hono REST router
  api/mcp.ts            MCP server factory and tool definitions
  auth/tokens.ts        personal API tokens
  auth/session.ts       signed session cookies
  auth/upstream.ts      GitHub and Google OAuth clients
  auth/handler.ts       /authorize, /login, /callback
  web/                  dashboard pages (.tsx)
migrations/0001_init.sql
test/
scripts/calibrate.ts    threshold calibration against real Workers AI
prompts/daily-brief.md  recommended prompt snippet
```

**Typing rule:** every request, response, tool input and tool output is a zod
schema in `api/schemas.ts`, with its TypeScript type inferred via `z.infer`.
No `any`, no hand-assembled JSON objects outside those types. `tsc` runs in
`strict` mode.

## Data model (D1)

Timestamps are epoch milliseconds. IDs are `crypto.randomUUID()`.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  email        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE identities (
  provider   TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  subject    TEXT NOT NULL,            -- stable upstream user id, never email
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,          -- trimmed + lowercased, 1..64 UTF-8 bytes
  display_name  TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  vector_status TEXT NOT NULL CHECK (vector_status IN ('pending', 'indexed')),
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, category, normalized)
);
CREATE INDEX entries_by_user_category ON entries (user_id, category, created_at DESC);
CREATE INDEX entries_pending ON entries (vector_status) WHERE vector_status = 'pending';

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
  token_hash   TEXT NOT NULL UNIQUE,    -- hex SHA-256 of the full token
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
```

Categories are trimmed and lowercased once, at input validation, and stored in
that form everywhere (D1 rows, Vectorize metadata, stats grouping). `Math` and
`math` are the same category; `math` and `mathematics` are not.

Cascading deletes rely on D1 enforcing foreign keys; a migration test asserts
that deleting a user removes their entries, hits and tokens.

## Matching

### Normalization

Applied to names for exact and trigram matching (not to the embedding input):

1. Unicode NFKD, then remove combining marks (`\p{M}`).
2. Lowercase.
3. `&` → ` and `.
4. Remove possessive `'s` / `’s`.
5. Replace every run of non-alphanumeric characters with one space; trim.
6. Remove one leading `the `, `a ` or `an `.

| Input | Normalized |
|---|---|
| `Euler's Identity` | `euler identity` |
| `Kurt Gödel` | `kurt godel` |
| `The Banach–Tarski Paradox` | `banach tarski paradox` |
| `P & NP` | `p and np` |

### Pipeline

Every lookup is scoped to one `(user_id, lowercased category)`.

1. **Exact.** A D1 row with equal `normalized` → match, score `1.0`.
2. **Trigram.** Load that user's entries in the category (most recent 5,000;
   documented limit) and compute Jaccard similarity over character trigrams of
   `" " + normalized + " "`. Score ≥ `TRIGRAM_REPEAT_THRESHOLD` → match.
3. **Semantic.** Embed the raw candidate name, query Vectorize `topK: 5` with
   filter `{ user_id: { $eq }, category: { $eq } }`, then join returned ids
   against D1 (ids with no row are dropped — orphaned vectors are harmless).
   - score ≥ `SEMANTIC_REPEAT_THRESHOLD` → **repeat** confidence
   - `SEMANTIC_POSSIBLE_THRESHOLD` ≤ score < repeat threshold → **possible**
     confidence (reported, never blocks)

   Calibration (2026-09-15) found that no available Workers AI embedding model
   separates rephrasings from distinct topics that share a name (e.g. "Four color
   theorem" vs "Five color theorem" scores above "Euler's identity" vs
   "e^(iπ) + 1 = 0"). The defaults therefore make semantic matches advisory:
   repeat threshold `1`, possible threshold `0.78`, which surfaces every calibrated
   rephrasing for the caller (the brief's LLM) to judge and forget if needed.

### Decision

- `likely_repeat` is true if there is any exact match, any trigram match, or
  any semantic match with repeat confidence.
- Matches are de-duplicated by `entry_id` (keeping the strongest), ordered
  exact → trigram → semantic, then by score descending, and capped at 5.
- The **best match** is the first element; hits are recorded against it.

If Workers AI or Vectorize fails, steps 1–2 still decide, and the response
carries `semantic: "unavailable"`.

**Known gap:** Vectorize is eventually consistent; a vector inserted seconds
ago may not be returned yet. Exact and trigram matching read D1 and are
immediately consistent, which covers the common case.

## Operations

One core (`core/ledger.ts`) exposed identically over MCP and REST.

| Operation | MCP tool | REST |
|---|---|---|
| claim | `claim_topic` | `POST /api/v1/claims` |
| check | `check_topic` | `POST /api/v1/checks` |
| list | `list_topics` | `GET /api/v1/entries?category=&limit=&since=` |
| forget | `forget_topic` | `DELETE /api/v1/entries/:id` |
| stats | `topic_stats` | `GET /api/v1/stats?scope=me\|global&category=&limit=` |

### Wire types

```ts
type MatchKind = "exact" | "trigram" | "semantic";

interface Match {
  entry_id: string;
  display_name: string;
  category: string;
  kind: MatchKind;
  score: number;                       // 0..1
  confidence: "repeat" | "possible";
  first_seen: string;                  // ISO 8601
  hit_count: number;
}

interface Entry {
  id: string;
  category: string;
  display_name: string;
  created_at: string;                  // ISO 8601
  hit_count: number;
}

type SemanticStatus = "ok" | "unavailable";

// claim
interface ClaimInput { category: string; name: string; force?: boolean }
type ClaimResult =
  | { status: "claimed"; entry: Entry; forced: boolean;
      possible_matches: Match[]; semantic: SemanticStatus }
  | { status: "repeat"; matches: Match[]; semantic: SemanticStatus };

// check
interface CheckInput { category: string; name: string }
interface CheckResult { likely_repeat: boolean; matches: Match[]; semantic: SemanticStatus }

// stats
interface RepeatStat {
  display_name: string;
  category: string;
  hit_count: number;
  distinct_users?: number;             // global scope only
  recent_phrasings?: string[];         // me scope only, newest 10
}
```

Validation: `category` is trimmed and lowercased, then must be 1–64 UTF-8 bytes
(Vectorize's filterable string prefix is 64 bytes); `name` 1–200 characters after trim; `limit` 1–100,
default 20.

### claim semantics

1. Run the pipeline.
2. If `likely_repeat`:
   - If the best match is **exact**, the result is `repeat` even with
     `force: true` (the unique index forbids a second identical entry), and a
     hit is recorded as for any other repeat.
   - Otherwise, if `force` is false → in one D1 batch, insert a `hits` row for
     the best match and increment its `hit_count`; return `repeat`.
   - Otherwise (`force: true`) → proceed to step 3 with `forced: true` and
     record **no** hit.
3. Insert the entry with `vector_status = 'pending'`. A unique-constraint
   violation (a concurrent identical claim) re-runs the operation once, which
   then yields `repeat`.
4. Embed and upsert the vector (`id = entry.id`, metadata `user_id`,
   lowercased `category`). On success set `vector_status = 'indexed'`; on
   failure leave it `pending` for the cron backfill and return
   `semantic: "unavailable"`.
5. Return `claimed`. `possible_matches` holds every match that did not block the
   claim: possible-confidence matches normally, or all matches when `forced`.

### Hit semantics

A **hit** is recorded only by `claim` when it returns `repeat`. `check`, `list`,
`stats` and dashboard browsing never record hits. Repeated attempts at the same
topic record one hit each — each is a separate "wanted to repeat" signal.

### forget

Deletes the D1 entry (hits cascade), then deletes the vector. A failed vector
delete is logged and otherwise ignored, because semantic results are joined
against D1.

### stats

- `scope=me`: the user's entries ordered by `hit_count` desc (ties: newest
  first), each with its newest 10 hit phrasings.
- `scope=global`: hits joined to entries, grouped by
  `(lower(category), entries.normalized)`, reporting total hits and
  `COUNT(DISTINCT hits.user_id)`, filtered `HAVING distinct_users >=
  GLOBAL_MIN_USERS`. No user ids, emails or phrasings are exposed. The display
  name shown is the most common `display_name` in the group.

## Auth

### Request routing (`src/index.ts`)

```
export default new OAuthProvider({
  apiRoute:   ["/mcp", "/api/v1/"]     → API router, props in ctx.props
  apiHandler: API router (dispatches /mcp vs /api/v1/ by path)
  defaultHandler: web app (auth pages + dashboard)
  resolveExternalToken({ token, env }):
    token starts with "ldg_" → look up hash in api_tokens
      → { props: { userId } }, or null (401) if unknown or revoked
})
```

`resolveExternalToken` is called by the provider (0.10.3) for any bearer token
not found in its KV store, so personal tokens and OAuth tokens reach the API
router identically, with `ctx.props = { userId: string }`.

### OAuth sign-in (MCP clients such as claude.ai)

1. The client registers dynamically (`/register`) and sends the user to
   `/authorize`.
2. `GET /authorize` parses the request with `parseAuthRequest`, looks up the
   client, and renders a consent page naming the client, with **Continue with
   GitHub** and **Continue with Google**. The parsed request is stored in KV
   under a random state id (10-minute TTL); the state id is also set in a
   `__Host-ledger_state` cookie to bind it to the browser.
3. `/login/:provider` redirects upstream. GitHub scopes: `read:user
   user:email`. Google scopes: `openid email profile` (no Google verification
   review needed for these).
4. `/callback/:provider` checks the state against the cookie, exchanges the
   code, reads the stable subject id, and finds or creates `identities` →
   `users`. Upstream access tokens are discarded after this step.
5. `completeAuthorization({ request, userId, scope: ["ledger"], props: { userId } })`,
   then redirect to the client.
6. If a valid dashboard session cookie exists, steps 3–4 are skipped and the
   session's user is used. If additionally the client id is listed in the
   `__Host-ledger_approved` signed cookie, the consent page in step 2 is skipped
   too and `/authorize` goes straight to step 5.

**Unattended runs:** the scheduled brief runs without a person present, so
access tokens are short-lived (`accessTokenTTL: 3600`) but refresh tokens do not
expire until the grant is revoked. In `@cloudflare/workers-oauth-provider`
0.10.3 the refresh-token default is 30 days; non-expiring requires passing
`refreshTokenTTL: undefined` **explicitly**. A unit test asserts the option
object contains the key with value `undefined`.

### Dashboard sessions

`/login/:provider` without a pending authorization signs in to the dashboard.
The session cookie `__Host-ledger_session` holds `userId.expiresAt.signature`
(HMAC-SHA256 with `COOKIE_SECRET`), and is `HttpOnly; Secure; SameSite=Lax;
Path=/`, valid 30 days. Every state-changing dashboard request is a `POST`
whose `Origin` header must equal the service origin.

### Personal API tokens

- Format `ldg_` + base64url of 32 random bytes. Shown once at creation.
- Stored as hex SHA-256; lookup by hash.
- `last_used_at` is written at most once per hour per token.
- Revocation sets `revoked_at`; revoked tokens return 401.

### Scope

A single scope, `ledger`, grants read and write to the user's own ledger.

### Rate limiting

`claim` and `check` (both transports) call `CLAIM_LIMITER.limit({ key: userId })`;
over the limit returns `rate_limited` (HTTP 429).

## Dashboard

Server-rendered Hono JSX; no SPA and no frontend build step.

| Page | Contents |
|---|---|
| `/` | Sign-in buttons, or redirect to `/ledger` when signed in |
| `/ledger` | Entries by category and date; forget button |
| `/repeats` | The user's entries ranked by hits; expand to see each hit's phrasing, kind and score |
| `/global` | Global leaderboard (topics hit by ≥ `GLOBAL_MIN_USERS` users) |
| `/access` | Create/revoke personal tokens; list/revoke OAuth grants (`listUserGrants`, `revokeGrant`) |
| `/connect` | MCP URL, curl example, prompt snippet from `prompts/daily-brief.md` |
| `/account` | Delete account (confirmation form) |

Account deletion removes the user row (cascading to identities, entries, hits
and tokens), revokes all OAuth grants, and deletes the user's vectors by id in
batches.

## Error handling

REST errors use one envelope and status mapping:

```ts
interface ErrorBody {
  error: {
    code: "unauthorized" | "invalid_input" | "not_found" | "rate_limited" | "upstream_unavailable";
    message: string;
  };
}
```

| Code | HTTP |
|---|---|
| `unauthorized` | 401 |
| `invalid_input` | 400 |
| `not_found` | 404 |
| `rate_limited` | 429 |
| `upstream_unavailable` | 503 |

MCP tools return `isError: true` with the same `code` and `message` in
structured content.

`upstream_unavailable` is returned only when D1 itself fails. Workers AI or
Vectorize failures degrade to `semantic: "unavailable"` rather than failing the
request.

**Cron backfill** (`*/15 * * * *`): select up to 100 `pending` entries, embed in
one batch, upsert vectors, mark `indexed`. Failures leave rows `pending`.

## Testing

- **Runner:** Vitest 4 with `@cloudflare/vitest-plugin` (`cloudflareTest`),
  local D1 through Miniflare, migrations applied with `readD1Migrations` /
  `applyD1Migrations` in a setup file. Tests use `wrangler.test.jsonc`, which
  omits the `AI` and `VECTORS` bindings (neither runs locally); over HTTP the
  semantic layer therefore reports `unavailable`, and semantic matching is
  covered at the core level with the fake.
- **MCP tests** drive `/mcp` with `@modelcontextprotocol/client`
  (`Client` + `StreamableHTTPClientTransport` with a custom `fetch`), so they
  exercise the real protocol negotiation.
- **Pure units:** normalization table (above), trigram scores (for example
  `euler identity` vs `euler totient` < 0.6; `srinivasa ramanujan` vs
  `srinivasa ramanujam` ≥ 0.6),
  decision and ordering rules, token format and hashing, cookie signing.
- **`SemanticIndex` fake:** an in-memory implementation with deterministic
  embeddings, injected in tests, because Vectorize and Workers AI have no local
  emulation.
- **Integration (Miniflare):**
  - claim → claimed; same claim → repeat with one hit; `force` behaviour,
    including exact matches refusing `force`.
  - check records no hit.
  - forget removes the entry and its hits; list and stats reflect it.
  - REST and MCP return equivalent results for the same operation.
  - Auth: personal token, OAuth token, missing token, revoked token.
  - Isolation: user B cannot list, check against, or forget user A's entries.
  - Global stats hide topics below `GLOBAL_MIN_USERS`.
  - Semantic failure path yields `semantic: "unavailable"` and a `pending`
    entry; the scheduled handler indexes it.
  - Account deletion cascade.
- **Auth flow:** the GitHub and Google clients take an injected `fetch`
  function; tests pass a fake that answers the token and user endpoints.
- **Calibration (not CI):** `scripts/calibrate.ts` embeds labeled same/different
  topic pairs with real Workers AI and prints the score distribution. Thresholds
  are set from its output before the first release tag, and the chosen values
  and pair set are recorded in `docs/calibration.md`.

## Deploy and release

- **Package manager:** npm. Wrangler, TypeScript, Biome and Vitest are dev
  dependencies with exact versions pinned.
- **CI** (`.github/workflows/ci.yml`, on pull requests and pushes to `master`):
  `npm ci`, `tsc --noEmit`, `biome check`, `vitest run`.
- **Deploy** (`.github/workflows/deploy.yml`, on push of tags `v*`): `npm ci`,
  tests, `wrangler d1 migrations apply topic-ledger --remote`, `wrangler
  deploy`. Repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Release:** the tag push *is* the release; it deploys and creates no GitHub
  release. The terminal step of the change loop is the deploy.
- **Version:** `package.json` starts at `0.1.0`.

### One-time provisioning (documented in README)

1. Deploy to the **Cycle Five Syndicate** account
   (`e24f723fe819bea445d08ab472d549f6`), which owns the `twkr.io` zone
   (`87982e35283b83c4d504b3c06dd06849`) — verified 2026-09-14. The account had
   no Workers, D1 databases, KV namespaces or Vectorize indexes at that time, so
   the names above are free. Scope `CLOUDFLARE_API_TOKEN` to this account.
2. Create D1 `topic-ledger`, KV `topic-ledger-oauth`, and Vectorize
   `topic-ledger-v2` (1024, cosine).
3. Create Vectorize metadata indexes `user_id` and `category` (string) —
   **before** any insert.
4. Create a GitHub OAuth app (callback `https://ledger.twkr.io/callback/github`)
   and a Google OAuth client (callback `https://ledger.twkr.io/callback/google`);
   publish the Google consent screen.
5. `wrangler secret put` for the five secrets.
6. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the GitHub repo.

## Brief integration

`prompts/daily-brief.md` holds the recommended wording, for example:

> Before writing the math section, choose a topic and call `claim_topic` with
> category `math` and the topic's common name. If the result is `repeat`, choose
> a different topic and call again, up to 5 times. If the result is `claimed`
> but lists `possible_matches` you judge to be the same topic, call
> `forget_topic` on the new entry and choose again. Do the same with category
> `person` for the historical figure.

The claude.ai scheduled task uses the connector added under Settings →
Connectors with URL `https://ledger.twkr.io/mcp`.

## Risks and open items

| Risk | Mitigation |
|---|---|
| Embeddings can't separate rephrasings from lookalike topics | Calibrated 2026-09-15 (`docs/calibration.md`): semantic matches are advisory `possible_matches`; exact and trigram still block |
| Deploy token scoped to the wrong account (custom domains require the zone's account) | `twkr.io` confirmed on Cycle Five Syndicate; `CLOUDFLARE_ACCOUNT_ID` pinned to it |
| Unattended scheduled runs lose auth | `refreshTokenTTL: undefined` passed explicitly (library default is 30 days); unit-tested |
| New, fast-moving libraries (OAuth provider, MCP SDK v2, Agents SDK) | Exact version pins; integration tests cover both transports |
| D1 foreign-key enforcement assumed | Migration test asserts cascades |
| Trigram scan grows with ledger size | 5,000 most-recent cap per category; about 14 years of daily entries |

## Future work

- **Bulk import** of past topics (`POST /api/v1/entries/import` and a dashboard
  paste box), where duplicates inside an import become hits.
- Account linking between GitHub and Google identities.
- Category aliases so `math` and `mathematics` merge.
- Read-only scopes and tokens.
- Shared ledgers for families or teams.
