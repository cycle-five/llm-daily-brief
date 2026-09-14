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
