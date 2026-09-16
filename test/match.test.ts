import { describe, expect, it } from "vitest";
import {
	classifySemanticHits,
	findLexicalMatches,
	isLikelyRepeat,
	MAX_MATCHES,
	rankMatches,
	resolveAliases,
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
		alias_of: null,
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

	it("names the alias that matched, and omits via_alias otherwise", () => {
		const original = entry({ id: "o", normalized: "o", display_name: "Ibn al-Haytham" });
		const alias = entry({ id: "a", normalized: "a", display_name: "Alhazen", alias_of: "o" });
		const base: ScoredMatch = {
			entry: original,
			kind: "semantic",
			score: 0.9,
			confidence: "possible",
		};
		expect(toWireMatch({ ...base, via: alias })).toMatchObject({
			entry_id: "o",
			display_name: "Ibn al-Haytham",
			via_alias: "Alhazen",
		});
		expect(Object.hasOwn(toWireMatch(base), "via_alias")).toBe(false);
	});
});

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
