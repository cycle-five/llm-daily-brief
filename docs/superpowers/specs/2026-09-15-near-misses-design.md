# Topic Ledger — Near misses and verdicts

- **Date:** 2026-09-15
- **Status:** Design approved in brainstorming (owner authorized autonomous execution through PR)
- **Branch:** `feat/topic-ledger` (ships in v0.1.0)
- **Amends:** `docs/superpowers/specs/2026-09-14-topic-ledger-design.md`; where the two
  disagree, this document wins.

## Problem

Semantic matches are advisory (`docs/calibration.md`): a claim that resembles an earlier
topic is recorded anyway and the match comes back in `possible_matches` for the brief's LLM
to judge. Two things are lost:

1. **Confirmed repeats are not counted.** When the LLM judges a possible match to be the
   same topic, the prompt tells it to `forget_topic` the new entry. That deletes the entry
   and records no hit, so repeats caught only by the LLM never reach `/repeats`, stats or
   the global leaderboard — yet counting would-be repeats is the ledger's purpose.
2. **Judgments leave no trace.** A possible match the LLM rejects (Omar Khayyam vs Ibn
   al-Haytham, 2026-09-15) is not stored anywhere, so the owner cannot audit verdicts and
   calibration cannot learn from real pairs.

`forget_topic` also serves two unrelated jobs: erasing history (a human decision) and
undoing a claim the LLM judged a repeat (a verdict). An unattended brief does not need a
tool that can erase any entry's history.

## Goals

1. Every possible match surfaced by a claim is stored as a **near miss** with its score and
   an explicit verdict.
2. A claim with possible matches asks for a verdict: `skip_topic` (same topic) or
   `keep_topic` (different topic). No verdict means the topic was used.
3. A skipped claim becomes an **alias** of the topic it repeats, records a hit on that
   topic, and blocks the same phrasing outright in future (exact and trigram matching on
   aliases resolve to the original).
4. Erasing history (`forget`) stays available to the owner (dashboard, REST) and leaves MCP.
5. The dashboard shows near misses and their verdicts.

## Non-goals

- A dashboard action to undo a wrong skip ("unlink" an alias and remove its hit). REST
  `DELETE` on the alias removes the alias; the hit stays. Revisit if wrong skips happen.
- A near-miss listing in the REST or MCP API.
- Verdicts on `check_topic` results (check records nothing).
- Aliases of aliases, or merging two existing topics.

## Data model

Migration `migrations/0002_near_misses.sql`:

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

- `entries.alias_of` is `NULL` for an **original** topic and holds the original's id for an
  **alias**. An alias always points at an original (no chains).
- `near_misses.claim_entry_id` is the entry the claim created; `matched_entry_id` is always
  an original; `via_entry_id` is the alias that actually matched, when the match came
  through one (the score was measured against the alias's name).
- The migration is additive: code deployed before it keeps working after it is applied.

## Matching with aliases

`Ledger.evaluate` (used by claim and check) is unchanged until matches are collected:

1. Lexical candidates (`listCandidates`, `findExact`) and semantic hits
   (`getEntriesByIds`) include aliases.
2. **Alias resolution:** every match whose entry has `alias_of` is replaced by a match on
   the original entry, keeping `kind`, `score` and `confidence`, and remembering the alias
   as `via`. Originals missing from the candidate window are fetched by id (same user and
   category). A match whose original cannot be found is dropped.
3. `rankMatches` then deduplicates by entry id as today, so an original matched both
   directly and through an alias appears once, as its strongest match.
4. The semantic query asks for `topK = 2 × MAX_MATCHES` (10) so aliases of one topic do not
   crowd out other topics before deduplication; ranking still returns at most
   `MAX_MATCHES`.

Consequences: hits, `repeat_of` and near-miss rows always reference originals; a later
claim of an aliased phrasing is an exact (or trigram) repeat of the original.

## Operations

| Operation | MCP tool | REST |
|---|---|---|
| claim | `claim_topic` | `POST /api/v1/claims` |
| check | `check_topic` | `POST /api/v1/checks` |
| list | `list_topics` | `GET /api/v1/entries?category=&limit=&since=` |
| skip | `skip_topic` | `POST /api/v1/entries/:id/skip` |
| keep | `keep_topic` | `POST /api/v1/entries/:id/keep` |
| forget | *(none)* | `DELETE /api/v1/entries/:id`, dashboard Forget button |
| stats | `topic_stats` | `GET /api/v1/stats?scope=me\|global&category=&limit=` |

### Wire types

```ts
interface Match {
  entry_id: string;                    // always an original
  display_name: string;
  category: string;
  kind: MatchKind;
  score: number;
  confidence: "repeat" | "possible";
  first_seen: string;
  hit_count: number;
  via_alias?: string;                  // display name of the alias that matched, if any
}

type ClaimResult =
  | { status: "claimed"; entry: Entry; forced: boolean;
      overridden_matches: Match[]; semantic: SemanticStatus }   // empty unless forced
  | { status: "possible_repeat"; entry: Entry; possible_matches: Match[];
      next_step: string; semantic: SemanticStatus }
  | { status: "repeat"; matches: Match[]; semantic: SemanticStatus };

interface SkipInput  { entry_id: string; repeat_of: string; note?: string }  // REST: entry_id from the path
interface SkipResult { skipped: string; alias_of: Match }                      // hit_count includes this hit
interface KeepInput  { entry_id: string; note?: string }                       // REST: entry_id from the path
interface KeepResult { kept: string; distinct: number }                        // rows marked distinct
```

- `note` is trimmed and 1–500 characters when present.
- `next_step` is a constant: *"Decide whether this topic is the same as any possible match.
  If it is, call skip_topic with repeat_of set to that match's entry_id and choose a
  different topic. Otherwise call keep_topic."*
- `possible_matches` is renamed `overridden_matches` on `claimed`: after this change it only
  ever holds matches a forced claim overrode.

### claim

Steps 1–4 of the original claim semantics are unchanged (blocking, hit on repeat, insert,
embed). Then:

- **Not forced, possible matches present:** in one D1 batch, insert one `near_misses` row per
  possible match (`verdict = 'pending'`, `via_entry_id` from alias resolution); return
  `possible_repeat`.
- **Forced:** insert one row per overridden match with `verdict = 'distinct'`,
  `note = 'forced'`, `decided_at = now`; return `claimed` with `forced: true`.
- **No matches:** return `claimed`, `forced: false`, empty `overridden_matches`.
- **`force: true` but every match is only `possible`:** `force` overrides repeat-confidence
  matches only, so with none present nothing is overridden — the claim is not forced. It
  falls back to the first case: `possible_repeat` with a `pending` row per possible match,
  `force` otherwise ignored.

The entry is inserted before any verdict, so a claim nobody answers counts as used.

### skip

`skip(userId, entryId, repeatOf, note?)`:

1. Load the entry (same user) → `not_found` if absent.
2. `invalid_input` if the entry is an alias, has `hit_count > 0`, or has aliases of its own.
3. Load its near misses → `invalid_input` if none is `pending`, or if no `pending` row has
   `matched_entry_id = repeatOf`.
4. Load the matched entry → `invalid_input` if it is itself an alias. A pending row named an
   original when it was written, but the matched entry may have been skipped since. Step 5's
   guard rejects this case too, atomically, so this check exists only for the clearer message.
5. One D1 batch, every statement conditional on the same SQL guard — not merely on the row
   still being `pending`. The guard re-checks, inside the batch, every precondition that
   steps 2-4 tested outside it: the near-miss row is still `pending` and belongs to this user;
   the claim is still an original, with `hit_count = 0` and no aliases of its own; and the
   matched entry is still an original. That last clause is what prevents alias chains
   (X → A → Z); re-checking the rest is what makes two concurrent verdicts record at most one
   hit. The batch:
   - insert a `hits` row on `repeatOf` (`candidate_text` = the entry's display name,
     `candidate_normalized` = its normalized form, `match_kind`/`score` from the row);
   - increment the original's `hit_count`;
   - set the entry's `alias_of = repeatOf`;
   - set the row's `verdict = 'repeat'`, `note`, `decided_at`.
6. If the batch changed no near-miss row, a concurrent verdict won → `invalid_input`.
7. Return `{ skipped: entryId, alias_of: <match on the original with its new hit_count> }`.

The claim's other pending rows stay `pending`; the dashboard reports them as "not judged —
claim skipped". The alias keeps its vector.

### keep

`keep(userId, entryId, note?)`: `not_found` if the entry is absent; `invalid_input` if it is
an alias or has no `pending` near misses; otherwise set every pending row of that claim to
`distinct` with `note` and `decided_at`, and return the count.

### Verdicts are final

Once a claim has no pending rows (keep), or it is an alias (skip), both tools reject it.
The owner can still forget entries.

### Hits

A hit is recorded when `claim` returns `repeat`, and when `skip` succeeds.

### forget

Deletes the D1 entry. Foreign keys cascade to its hits, its aliases and every near miss that
references it as claim or match; `via_entry_id` references become `NULL`. Before deleting,
forget collects the ids of the entry's aliases so their vectors are removed with the entry's
(best effort, as before). Forgetting an alias directly leaves the hit it recorded on the
original.

### list and stats

- `listEntries` (behind `list_topics` and `/ledger`) returns originals only.
- `topRepeatsForUser` returns originals only.
- `globalRepeats` counts hits (always on originals); its display-name lookup considers
  originals only.

## MCP

Tools: `claim_topic`, `check_topic`, `list_topics`, `skip_topic`, `keep_topic`,
`topic_stats`. `forget_topic` is removed.

- `claim_topic` description: explains `claimed`, `possible_repeat` (call skip_topic or
  keep_topic) and `repeat`, and that `force` overrides fuzzy (not exact) matches.
- `check_topic` and `list_topics` descriptions both end with `CLAIM_FIRST_NOTE`, telling the
  caller to choose a topic before consulting the ledger. A brief that browses first never
  repeats and never records a hit, so the counter reads zero whether or not the model is
  repeating itself — the appearance of success, with no measurement behind it.
- `skip_topic` annotations: `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: false` — it only turns the caller's own new claim into an alias and
  records a hit. Leaving `destructiveHint` off avoids an approval prompt in unattended
  claude.ai runs (unverified; the owner checks the connector's tool permissions after
  deploy).
- `keep_topic` annotations: `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: true`.
- Neither is rate-limited; neither calls the embedding model.

## Dashboard

| Page | Change |
|---|---|
| `/ledger` | Originals only; each lists its aliases ("also claimed as …"), read-only |
| `/near-misses` | New; nav link after Repeats. Newest 100 rows: date, claimed name, matched topic (plus "via *alias*"), kind, score, verdict, note |
| `/repeats` | No change; skips appear as semantic hits with the alias's name as the phrasing |

Verdict labels:

| State | Label |
|---|---|
| `repeat` | Repeat — skipped |
| `distinct` | Different — kept |
| `pending`, claim entry is now an alias | Not judged — claim skipped |
| `pending`, otherwise | No verdict — used |

## Brief integration

`BRIEF_PROMPT_SNIPPET` (Connect page) and the README copy, kept identical:

> Before writing the math section, choose a topic on your own, without calling list_topics or
> check_topic first, then call claim_topic with category "math" and the topic's common name.
> Claiming blind is what makes the repeat counter meaningful. If the result is "repeat", choose
> a different topic and call again, up to 5 times. If the result is "possible_repeat", decide
> whether your topic is the same as any listed match: if it is, call skip_topic with repeat_of
> set to that match's entry_id and choose again; if not, call keep_topic. Include a short note
> with either call. Do the same with category "person" for the historical figure.

## Rollout

1. Apply migration 0002 remotely (additive; safe before the new code).
2. Deploy by hand from the branch; smoke-test claim → `possible_repeat` → skip → exact repeat
   of the alias, and keep; clean up.
3. Owner updates the scheduled task's prompt. A run between deploy and prompt update still
   gets `next_step`.
4. PR, merge, tag `v0.1.0`; the tag deploy's `migrations apply` is a no-op for 0002.

Steps 1–3 need the owner's go-ahead.

## Testing

- **Migration 0002:** deleting an original cascades to its aliases; near misses cascade on
  claim entry, matched entry and user deletion; `via_entry_id` becomes `NULL` when the alias
  is deleted; the verdict `CHECK` rejects other values.
- **Claim:** `possible_repeat` with one pending row per possible match; forced claims return
  `claimed` with `overridden_matches` and `distinct` rows noted `forced`; exact, trigram and
  semantic matches on an alias resolve to the original with `via_alias`, and a repeat records
  its hit on the original; an original matched directly and via an alias appears once.
- **Skip:** alias set, hit recorded with the row's kind and score, row marked `repeat` with
  note, other rows still pending, vector kept, `alias_of.hit_count` includes the hit.
  Rejections: another user's entry (`not_found`); no pending rows, alias, entry with hits,
  entry with aliases, `repeat_of` not a pending match, skip after keep (`invalid_input`).
  Two concurrent skips record exactly one hit.
- **Keep:** marks pending rows `distinct` with note and returns the count; rejections as
  above.
- **Forget:** forgetting an original removes its aliases, their vectors and near misses;
  forgetting an alias keeps the hit on the original.
- **List and stats:** aliases never appear as topics in list, `/ledger` rows, stats or the
  global leaderboard.
- **MCP:** tool list is exactly the six tools above; skip and keep round-trip.
- **REST:** skip and keep routes (success, validation, `not_found`); `DELETE` still works.
- **Dashboard:** `/near-misses` renders all four verdict labels and "via"; nav link;
  `/ledger` lists aliases; Connect page shows the new prompt.

## Documentation

- Original spec: header note pointing here; operations table, claim/hit/forget semantics,
  dashboard table and brief integration updated.
- README: API table, MCP tools, prompt.
- `docs/calibration.md`: extend the pair set from `/near-misses` (not `/repeats`).
