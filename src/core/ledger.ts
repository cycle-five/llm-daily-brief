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
				recent_phrasings: row.hits.map((hit) => hit.candidate_text),
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

	private async claimOnce(
		userId: string,
		input: ClaimInput,
		isRetry: boolean,
	): Promise<ClaimResult> {
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
			alias_of: null,
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
		if (!lexical.some((match) => match.kind === "exact")) {
			// listCandidates is windowed (CANDIDATE_SCAN_LIMIT); an exact match can lie outside it.
			const exact = await this.deps.store.findExact(userId, category, normalized);
			if (exact) lexical.push({ entry: exact, kind: "exact", score: 1, confidence: "repeat" });
		}
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
