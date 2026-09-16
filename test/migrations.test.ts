import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function countWhere(table: string, column: string, value: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`)
		.bind(value)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

describe("migration 0001_init", () => {
	it("cascades a user delete to identities, entries, hits and tokens", async () => {
		const userId = crypto.randomUUID();
		const entryId = crypto.randomUUID();
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, ?2)",
			).bind(userId, now),
			env.DB.prepare(
				"INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES ('github', ?1, ?2, NULL, ?3)",
			).bind(`gh-${userId}`, userId, now),
			env.DB.prepare(
				"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at) VALUES (?1, ?2, 'math', 'Euler', 'euler', 'pending', 1, ?3)",
			).bind(entryId, userId, now),
			env.DB.prepare(
				"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at) VALUES (?1, ?2, ?3, 'Euler', 'euler', 'exact', 1, ?4)",
			).bind(crypto.randomUUID(), entryId, userId, now),
			env.DB.prepare(
				"INSERT INTO api_tokens (id, user_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, 'cron', ?4)",
			).bind(crypto.randomUUID(), userId, `hash-${userId}`, now),
		]);

		await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();

		expect(await countWhere("identities", "user_id", userId)).toBe(0);
		expect(await countWhere("entries", "user_id", userId)).toBe(0);
		expect(await countWhere("api_tokens", "user_id", userId)).toBe(0);
		expect(await countWhere("hits", "entry_id", entryId)).toBe(0);
	});

	it("rejects a second entry with the same user, category and normalized name", async () => {
		const userId = crypto.randomUUID();
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, ?2)",
		)
			.bind(userId, now)
			.run();
		const insert = () =>
			env.DB.prepare(
				"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at) VALUES (?1, ?2, 'math', 'Euler', 'euler', 'pending', 0, ?3)",
			)
				.bind(crypto.randomUUID(), userId, now)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow(/UNIQUE constraint failed/);
	});
});

describe("migration 0002_near_misses", () => {
	async function seedUserRow(): Promise<string> {
		const userId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, 1)",
		)
			.bind(userId)
			.run();
		return userId;
	}

	async function insertEntry(
		userId: string,
		name: string,
		aliasOf: string | null = null,
	): Promise<string> {
		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at) VALUES (?1, ?2, 'math', ?3, ?4, 'pending', 0, ?5, 1)",
		)
			.bind(id, userId, name, `${name.toLowerCase()} ${id}`, aliasOf)
			.run();
		return id;
	}

	async function insertNearMiss(
		userId: string,
		claimId: string,
		matchedId: string,
		viaId: string | null = null,
		verdict = "pending",
	): Promise<string> {
		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.8, ?6, 1)",
		)
			.bind(id, userId, claimId, matchedId, viaId, verdict)
			.run();
		return id;
	}

	it("cascades an original's deletion to its aliases and to near misses on either side", async () => {
		const userId = await seedUserRow();
		const original = await insertEntry(userId, "Euler");
		const alias = await insertEntry(userId, "Leonhard Euler", original);
		const claim = await insertEntry(userId, "Gauss");
		const other = await insertEntry(userId, "Noether");
		const matchedOriginal = await insertNearMiss(userId, claim, original);
		const claimedByAlias = await insertNearMiss(userId, alias, other);
		const unrelated = await insertNearMiss(userId, claim, other);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(original).run();

		expect(await countWhere("entries", "id", alias)).toBe(0);
		expect(await countWhere("near_misses", "id", matchedOriginal)).toBe(0);
		expect(await countWhere("near_misses", "id", claimedByAlias)).toBe(0);
		expect(await countWhere("near_misses", "id", unrelated)).toBe(1);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(claim).run();
		expect(await countWhere("near_misses", "id", unrelated)).toBe(0);
	});

	it("clears via_entry_id when the alias is deleted and removes near misses with the user", async () => {
		const userId = await seedUserRow();
		const original = await insertEntry(userId, "Hypatia");
		const alias = await insertEntry(userId, "Hypatia of Alexandria", original);
		const claim = await insertEntry(userId, "Alexandrian mathematician");
		const row = await insertNearMiss(userId, claim, original, alias);

		await env.DB.prepare("DELETE FROM entries WHERE id = ?1").bind(alias).run();
		const via = await env.DB.prepare("SELECT via_entry_id FROM near_misses WHERE id = ?1")
			.bind(row)
			.first<{ via_entry_id: string | null }>();
		expect(via).toEqual({ via_entry_id: null });

		await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();
		expect(await countWhere("near_misses", "user_id", userId)).toBe(0);
	});

	it("rejects an unknown verdict", async () => {
		const userId = await seedUserRow();
		const a = await insertEntry(userId, "Cantor");
		const b = await insertEntry(userId, "Cantor set");
		await expect(insertNearMiss(userId, a, b, null, "maybe")).rejects.toThrow();
	});
});
