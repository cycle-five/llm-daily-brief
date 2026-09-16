# Topic Ledger

A small multi-user service that keeps an LLM daily brief from repeating itself.
Before the brief writes about a math topic or a historical figure, it *claims* the
topic here. Exact repeats and spelling variants are refused, and every refused
attempt is counted, so you can see which topics the model keeps wanting to come
back to. Rephrasings — like "Euler's identity" vs "e^(iπ)+1=0" — come back as
`possible_repeat`, and the brief answers with `skip_topic` (same topic: counted as a repeat,
and the phrasing becomes an alias that is refused outright next time) or `keep_topic`
(different topic). Every such verdict is listed on the dashboard's **Near misses** page; see
[`docs/calibration.md`](docs/calibration.md) for why meaning-based matches ask for a verdict
instead of blocking.

- **MCP** (claude.ai connectors, openclaw): `https://ledger.twkr.io/mcp`
- **REST** (cron, scripts): `https://ledger.twkr.io/api/v1`
- **Dashboard:** `https://ledger.twkr.io`

MCP tools: `claim_topic`, `check_topic`, `list_topics`, `skip_topic`, `keep_topic`,
`topic_stats`. Erasing a topic is only possible from the dashboard or REST.

Design: [`docs/superpowers/specs/2026-09-14-topic-ledger-design.md`](docs/superpowers/specs/2026-09-14-topic-ledger-design.md),
amended by [`docs/superpowers/specs/2026-09-15-near-misses-design.md`](docs/superpowers/specs/2026-09-15-near-misses-design.md)

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
| POST | `/api/v1/claims` | `{category, name, force?}` | `{status: "claimed", entry, forced, overridden_matches, semantic}`, `{status: "possible_repeat", entry, possible_matches, next_step, semantic}` or `{status: "repeat", matches, semantic}` |
| POST | `/api/v1/checks` | `{category, name}` | `{likely_repeat, matches, semantic}` (records nothing) |
| GET | `/api/v1/entries` | `?category=&limit=&since=` | `{entries}` (original topics only) |
| POST | `/api/v1/entries/:id/skip` | `{repeat_of, note?}` | `{skipped, alias_of}`: the entry becomes an alias of `repeat_of` and a hit is recorded |
| POST | `/api/v1/entries/:id/keep` | `{note?}` | `{kept, distinct}` |
| DELETE | `/api/v1/entries/:id` | — | 204; erases the topic with its hits, aliases and near misses |
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
# Dimensions must match EMBEDDING_DIMENSIONS for @cf/qwen/qwen3-embedding-0.6b:
npx wrangler vectorize create topic-ledger-v2 --dimensions=1024 --metric=cosine
# Metadata indexes MUST exist before the first vector is inserted:
npx wrangler vectorize create-metadata-index topic-ledger-v2 --property-name=user_id --type=string
npx wrangler vectorize create-metadata-index topic-ledger-v2 --property-name=category --type=string
npx wrangler vectorize list-metadata-index topic-ledger-v2
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

Semantic thresholds were calibrated against real embeddings; the method, results and
chosen values are in [`docs/calibration.md`](docs/calibration.md). To re-run the pair set:

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
