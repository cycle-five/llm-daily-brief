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
		model: row.model,
	};
}

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
