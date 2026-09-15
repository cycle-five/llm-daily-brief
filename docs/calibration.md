# Semantic matching calibration

- **Date:** 2026-09-15
- **Account:** Cycle Five Syndicate, live Workers AI (`/ai/run`), cosine similarity
- **Decision:** embedding model `@cf/qwen/qwen3-embedding-0.6b` (1024 dims, Vectorize
  index `topic-ledger-v2`); `SEMANTIC_REPEAT_THRESHOLD = 1` (semantic matches never block);
  `SEMANTIC_POSSIBLE_THRESHOLD = 0.78` (surfaced as `possible_matches` for the brief to judge)

## Why semantic matches are advisory

The first production smoke test used the original model, `@cf/google/embeddinggemma-300m`,
with thresholds 0.85 / 0.75. Claiming "Euler's identity" and then "e^(i pi) + 1 = 0" produced
**no match at all**: the pair scored 0.58. Vectors, metadata filters and the D1 join were all
verified working; the scores were the problem.

Across every text-embedding model Workers AI offers, distinct topics that share a name
(Four vs Five color theorem, Marie vs Pierre Curie, Fermat's Last vs little theorem) score
**above** genuine rephrasings (formula forms, full names). No single threshold can block
rephrasings without also blocking legitimate new topics. Exact and trigram matching still
block; semantic similarity instead surfaces candidates, and the brief's prompt tells the LLM
to `forget_topic` a new entry it judges to be the same topic.

## Method

- **Pair set:** the 24 labelled pairs in `scripts/calibration-pairs.ts` — 12 SAME
  (rephrasings) and 12 "near" different topics that deliberately share words or names.
- **Unrelated pairs:** 12 extra pairs of clearly unrelated topics, measured to place the
  possible threshold above everyday noise (not in the script's pair file).
- **Input:** raw names via the model's `text` input, embedded identically on both sides
  (the Worker embeds stored entries and candidates the same way).
- **Separability score (AUC):** the probability that a random SAME pair scores above a random
  near-different pair. 1.0 is perfect separation; 0.5 is chance.

## Model comparison (24-pair set, raw text)

| Model | Dims | AUC | Lowest SAME | Highest near-different |
|---|---|---|---|---|
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 | **0.813** | 0.794 | 0.952 |
| `@cf/pfnet/plamo-embedding-1b` | 2048 | 0.715 | 0.721 | 0.910 |
| `@cf/baai/bge-small-en-v1.5` | 384 | 0.667 | 0.586 | 0.889 |
| `@cf/baai/bge-base-en-v1.5` | 768 | 0.667 | 0.670 | 0.910 |
| `@cf/google/embeddinggemma-300m` + `task: sentence similarity \| query:` prefix | 768 | 0.646 | 0.556 | 0.916 |
| `@cf/google/embeddinggemma-300m` (original) | 768 | 0.639 | 0.562 | 0.868 |
| `@cf/baai/bge-m3` | 1024 | 0.604 | 0.425 | 0.845 |
| `@cf/baai/bge-large-en-v1.5` | 1024 | 0.604 | 0.670 | 0.919 |

EmbeddingGemma's asymmetric retrieval prompts (`task: search result | query:` for the
candidate, `title: none | text:` for the stored entry) were worse still: lowest SAME 0.382,
highest near-different 0.634, only 2 of 12 SAME pairs above every different pair.

## `@cf/qwen/qwen3-embedding-0.6b` — full results

| Group | Min | Max | Mean |
|---|---|---|---|
| SAME (12) | 0.794 | 0.986 | 0.913 |
| Near-different (12) | 0.564 | 0.952 | 0.801 |
| Unrelated (12) | 0.439 | 0.735 | 0.583 |

Pairs at or above each candidate possible threshold:

| Threshold | SAME (of 12) | Near-different (of 12) | Unrelated (of 12) |
|---|---|---|---|
| 0.70 | 12 | 9 | 1 |
| 0.75 | 12 | 8 | 0 |
| **0.78** | **12** | **6** | **0** |
| 0.80 | 11 | 6 | 0 |
| 0.85 | 10 | 5 | 0 |

```
0.986 same      Isaac Newton | Sir Isaac Newton
0.979 same      Hypatia | Hypatia of Alexandria
0.967 same      Monty Hall problem | Monty Hall paradox
0.965 same      Banach–Tarski paradox | Banach-Tarski theorem
0.952 near      Four color theorem | Five color theorem
0.936 same      Ada Lovelace | Augusta Ada King, Countess of Lovelace
0.935 same      Gödel's incompleteness theorems | Incompleteness theorem
0.930 near      Marie Curie | Pierre Curie
0.920 near      Carl Friedrich Gauss | Carl Gustav Jacob Jacobi
0.900 same      Infinitude of primes | Euclid's proof that there are infinitely many primes
0.899 same      Leonhard Euler | Euler
0.897 same      Fermat's Last Theorem | Wiles' proof of Fermat's Last Theorem
0.894 near      Isaac Newton | Gottfried Wilhelm Leibniz
0.878 near      Fermat's Last Theorem | Fermat's little theorem
0.851 same      Riemann hypothesis | Zeros of the Riemann zeta function
0.844 same      Pythagorean theorem | a² + b² = c²
0.819 near      Cantor's diagonal argument | Cantor set
0.794 same      Euler's identity | e^(iπ) + 1 = 0
0.776 near      Euler's identity | Euler's totient function
0.750 near      Mandelbrot set | Julia set
0.745 near      Riemann hypothesis | Riemann integral
0.735 unrelated Euler's identity | Srinivasa Ramanujan
0.698 unrelated Fermat's Last Theorem | Mandelbrot set
0.694 near      Pythagorean theorem | Pythagorean tuning
0.692 near      Hilbert's hotel | Hilbert space
0.654 unrelated Gödel's incompleteness theorems | Four color theorem
0.643 unrelated Riemann hypothesis | Hypatia
0.604 unrelated Pythagorean theorem | Monty Hall problem
0.591 unrelated Sophie Germain | Fourier transform
0.564 near      Gaussian elimination | Gaussian curvature
0.558 unrelated Isaac Newton | Cantor set
0.556 unrelated Archimedes | Game of Life
0.521 unrelated Emmy Noether | Travelling salesman problem
0.508 unrelated Ada Lovelace | Banach–Tarski paradox
0.486 unrelated Marie Curie | Hilbert space
0.439 unrelated Alan Turing | Knot theory
```

## Chosen thresholds

- **`SEMANTIC_POSSIBLE_THRESHOLD = 0.78`** — just under the lowest SAME pair (0.794), so every
  calibrated rephrasing is surfaced, and above the highest unrelated pair (0.735), so everyday
  topics don't flood `possible_matches`. About half of the lookalike pairs are surfaced too;
  the brief's LLM judges those.
- **`SEMANTIC_REPEAT_THRESHOLD = 1`** — semantic similarity never blocks on its own. The
  mechanism stays configurable if a future model separates the groups.
- **`TRIGRAM_REPEAT_THRESHOLD = 0.6`** — unchanged; production smoke test scored the
  misspelling "Srinivasa Ramanujam" at 0.81 and blocked it.

## Known limits

- Margins are thin: the lowest SAME pair is 0.014 above the possible threshold, and the highest
  unrelated pair 0.045 below it. A rephrasing phrased differently from the calibration set can
  still fall under 0.78 and be claimed without any match.
- The pair set is small (36 pairs). Re-run after changing the model, and extend
  `scripts/calibration-pairs.ts` with real near-misses seen in `/repeats` over time.

## Re-running

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/calibrate.ts
```

The script embeds the pair set with the model named in it (keep it in sync with
`EMBEDDING_MODEL` in `src/semantic/cloudflare.ts`) and prints the scores plus a suggested
possible threshold. Changing the model requires a new Vectorize index whose dimensions match.
