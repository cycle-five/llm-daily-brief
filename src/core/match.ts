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
	/** The alias whose text actually matched, when `entry` was reached through one. */
	via?: EntryRow;
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
 * every match is in scope. Otherwise a match is in scope when its original, or the alias it came
 * through, is unattributed or belongs to the caller's model: an alias records the caller's own
 * earlier judgment, and without this the claim would collide with the caller's own alias row in
 * the per-model unique index. It is cross-model only when neither belongs to the caller.
 */
export function splitByScope(
	matches: readonly ScoredMatch[],
	model: string | null,
	shareLedger: boolean,
): ScopedMatches {
	if (shareLedger || model === null) return { inScope: [...matches], crossModel: [] };
	const belongsToCaller = (owner: string | null): boolean =>
		owner === null || sameModel(owner, model);
	const inScope: ScoredMatch[] = [];
	const crossModel: ScoredMatch[] = [];
	for (const match of matches) {
		const viaBelongs = match.via !== undefined && belongsToCaller(match.via.model);
		if (belongsToCaller(match.entry.model) || viaBelongs) inScope.push(match);
		else crossModel.push(match);
	}
	return { inScope, crossModel };
}
