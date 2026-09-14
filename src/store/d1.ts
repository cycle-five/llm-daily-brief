import { z } from "zod";
import { MatchKind } from "../api/schemas";
import { chunk } from "../core/chunk";
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

const RepeatHitSchema = z.object({
	candidate_text: z.string(),
	match_kind: MatchKind,
	score: z.number(),
});
export type RepeatHit = z.infer<typeof RepeatHitSchema>;

export interface UserRepeatRow {
	entry: EntryRow;
	hits: RepeatHit[];
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
const HitDetailRow = RepeatHitSchema.extend({ entry_id: z.string() });

export function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function placeholders(count: number, firstIndex: number): string {
	return Array.from({ length: count }, (_, i) => `?${firstIndex + i}`).join(", ");
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
					.prepare(
						"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, ?2, ?3, ?4)",
					)
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

	async findExact(userId: string, category: string, normalized: string): Promise<EntryRow | null> {
		const row = await this.db
			.prepare(
				`SELECT ${ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND category = ?2 AND normalized = ?3`,
			)
			.bind(userId, category, normalized)
			.first();
		return row ? EntryRowSchema.parse(row) : null;
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
				.prepare(`INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
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
			this.db
				.prepare("UPDATE entries SET hit_count = hit_count + 1 WHERE id = ?1")
				.bind(hit.entry_id),
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
		const hitsByEntry = new Map<string, RepeatHit[]>(entries.map((entry) => [entry.id, []]));
		for (const batch of chunk(
			entries.map((entry) => entry.id),
			MAX_IN_LIST,
		)) {
			const hits = await this.db
				.prepare(
					`SELECT entry_id, candidate_text, match_kind, score FROM hits WHERE entry_id IN (${placeholders(batch.length, 1)}) ORDER BY created_at DESC`,
				)
				.bind(...batch)
				.all();
			for (const raw of hits.results) {
				const hit = HitDetailRow.parse(raw);
				const list = hitsByEntry.get(hit.entry_id);
				if (list && list.length < MAX_PHRASINGS) {
					list.push({
						candidate_text: hit.candidate_text,
						match_kind: hit.match_kind,
						score: hit.score,
					});
				}
			}
		}
		return entries.map((entry) => ({ entry, hits: hitsByEntry.get(entry.id) ?? [] }));
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
			.prepare(
				`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC`,
			)
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
