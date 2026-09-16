import type {
	CheckInput,
	CheckResult,
	ClaimInput,
	ClaimResult,
	KeepInput,
	KeepResult,
	ListInput,
	ListResult,
	SemanticStatus,
	SkipInput,
	SkipResult,
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
	rankMatches,
	resolveAliases,
	type ScoredMatch,
	type SemanticHit,
	splitByScope,
	type Thresholds,
} from "./match";
import { normalize } from "./normalize";
import type { EntryRow, NearMissRow, OverlapRow } from "./rows";
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
	/** Matches in the caller's ledger: they can block or ask for a verdict. */
	matches: ScoredMatch[];
	/** Matches on other models' topics while ledgers are separate: recorded as overlaps. */
	crossModel: ScoredMatch[];
	semantic: SemanticStatus;
}

export const BACKFILL_BATCH = 100;

/**
 * Aliases of one topic, and other models' topics, can fill the semantic results, so over-fetch
 * before resolving, splitting and ranking. Twenty is within Vectorize's topK limit in every
 * return mode; confirm the limit before raising it.
 */
export const SEMANTIC_TOP_K = 20;

/** Sent with every possible_repeat so an LLM caller knows a verdict is expected. */
export const NEXT_STEP =
	"Decide whether this topic is the same as any possible match. If it is, call skip_topic with repeat_of set to that match's entry_id and choose a different topic. Otherwise call keep_topic.";
/** Note stored on near misses a forced claim overrode: the caller already decided they differ. */
export const FORCED_NOTE = "forced";

export class Ledger {
	constructor(private readonly deps: LedgerDeps) {}

	async check(userId: string, input: CheckInput): Promise<CheckResult> {
		const evaluation = await this.evaluate(userId, input.category, input.name, input.model ?? null);
		return {
			likely_repeat: isLikelyRepeat(evaluation.matches),
			matches: evaluation.matches.map((match) => toWireMatch(match)),
			semantic: evaluation.semantic,
		};
	}

	/** `client` is the connection's name, stored for audit; it never affects matching. */
	claim(userId: string, input: ClaimInput, client: string | null = null): Promise<ClaimResult> {
		return this.claimOnce(userId, input, client, false);
	}

	async list(userId: string, input: ListInput): Promise<ListResult> {
		const rows = await this.deps.store.listEntries(userId, {
			category: input.category,
			limit: input.limit,
			sinceMs: input.since === undefined ? undefined : Date.parse(input.since),
			model: input.model,
		});
		return { entries: rows.map(toWireEntry) };
	}

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
		// A stored near miss named an original when it was written, but a pending row can outlive
		// that guarantee if the matched entry was since skipped into an alias itself; the SQL guard
		// (skipOpen) also rejects this, atomically, but checking here gives a clearer error.
		const original = await this.requireEntry(userId, row.matched_entry_id);
		if (original.alias_of !== null) {
			throw new LedgerError(
				"invalid_input",
				`${input.repeat_of} is no longer an original; it was itself skipped`,
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
				model: entry.model,
				model_version: entry.model_version,
				created_at: decidedAt,
			},
			note: input.note ?? null,
			decidedAt,
		});
		if (!applied) {
			throw new LedgerError("invalid_input", `entry ${entry.id} was already decided`);
		}
		// Re-read the original: skipAsAlias just incremented its hit_count, and the response's
		// hit_count must include that hit.
		const updatedOriginal = await this.requireEntry(userId, row.matched_entry_id);
		const via = row.via_entry_id ? await store.getEntry(userId, row.via_entry_id) : null;
		// Pending near misses only ever come from possible-confidence matches.
		const match: ScoredMatch = {
			entry: updatedOriginal,
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
		const rows = await store.topRepeatsForUser(userId, input.category, input.limit, input.model);
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
		client: string | null,
		isRetry: boolean,
	): Promise<ClaimResult> {
		const { store, semantic, now, newId } = this.deps;
		const model = input.model ?? null;
		const modelVersion = input.model_version ?? null;
		const evaluation = await this.evaluate(userId, input.category, input.name, model);
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
				model,
				model_version: modelVersion,
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
			model,
			model_version: modelVersion,
			client,
		};
		if ((await store.insertEntry(entry)) === "duplicate") {
			// A concurrent claim by the same model inserted the same normalized name; re-evaluating
			// yields an exact repeat.
			if (isRetry) {
				throw new LedgerError("upstream_unavailable", "topic claim conflicted twice; retry");
			}
			return this.claimOnce(userId, input, client, true);
		}

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
		await store.insertOverlaps(
			evaluation.crossModel.map(
				(match): OverlapRow => ({
					id: newId(),
					user_id: userId,
					claim_entry_id: entry.id,
					matched_entry_id: match.entry.id,
					via_entry_id: match.via?.id ?? null,
					match_kind: match.kind,
					score: match.score,
					created_at: entry.created_at,
				}),
			),
		);

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
	}

	private async evaluate(
		userId: string,
		category: string,
		name: string,
		model: string | null,
	): Promise<Evaluation> {
		const { store, thresholds } = this.deps;
		const normalized = normalize(name);
		if (normalized.length === 0) {
			throw new LedgerError("invalid_input", "name must contain at least one letter or digit");
		}
		const candidates = await store.listCandidates(userId, category);
		const lexical = findLexicalMatches(normalized, candidates, thresholds);
		// listCandidates is windowed (CANDIDATE_SCAN_LIMIT), so an exact match can lie outside it, and
		// each model can hold its own copy. Ranking deduplicates an entry found both ways.
		for (const exact of await store.findExact(userId, category, normalized)) {
			lexical.push({ entry: exact, kind: "exact", score: 1, confidence: "repeat" });
		}
		const semantic = await this.semanticMatches(userId, category, name, candidates);
		const resolved = await this.withOriginals(
			userId,
			category,
			[...lexical, ...semantic.matches],
			candidates,
		);
		// The API refuses callers whose user row is gone; default to sharing, the conservative choice.
		const shareLedger = (await store.getUser(userId))?.share_ledger ?? true;
		// Rank each ledger separately so other models' matches cannot take the caller's slots.
		const { inScope, crossModel } = splitByScope(resolved, model, shareLedger);
		// An original reached both cross-model and through the caller's own alias is a near miss, not also an overlap.
		const inScopeIds = new Set(inScope.map((match) => match.entry.id));
		const dedupedCrossModel = crossModel.filter((match) => !inScopeIds.has(match.entry.id));
		return {
			normalized,
			matches: rankMatches(inScope),
			crossModel: rankMatches(dedupedCrossModel),
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

	private async semanticMatches(
		userId: string,
		category: string,
		name: string,
		candidates: readonly EntryRow[],
	): Promise<{ matches: ScoredMatch[]; status: SemanticStatus }> {
		let hits: SemanticHit[];
		try {
			hits = await this.deps.semantic.query({ userId, category, text: name, topK: SEMANTIC_TOP_K });
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

	private async requireEntry(userId: string, entryId: string): Promise<EntryRow> {
		const entry = await this.deps.store.getEntry(userId, entryId);
		if (!entry) throw new LedgerError("not_found", `no entry ${entryId}`);
		return entry;
	}
}
