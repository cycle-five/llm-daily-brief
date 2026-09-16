import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

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

describe("migration 0003_model_ledgers", () => {
	const db = env.MIGRATION_DB;
	const userId = crypto.randomUUID();
	const euler = crypto.randomUUID();
	const gauss = crypto.randomUUID();
	const alias = crypto.randomUUID();
	const claim = crypto.randomUUID();
	type Row = Record<string, unknown>;
	let before: { entries: Row[]; hits: Row[]; nearMisses: Row[] };

	async function rows(sql: string): Promise<Row[]> {
		return (await db.prepare(sql).all<Row>()).results;
	}

	async function count(table: string, column: string, value: string): Promise<number> {
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`)
			.bind(value)
			.first<{ n: number }>();
		return row?.n ?? -1;
	}

	function insertUser(id: string) {
		return db
			.prepare("INSERT INTO users (id, display_name, email, created_at) VALUES (?1, NULL, NULL, 1)")
			.bind(id);
	}

	beforeAll(async () => {
		await applyD1Migrations(
			db,
			env.TEST_MIGRATIONS.filter((migration) => migration.name < "0003"),
		);
		const entry = (id: string, name: string, hitCount: number, aliasOf: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at) VALUES (?1, ?2, 'math', ?3, ?4, 'indexed', ?5, ?6, 1)",
				)
				.bind(id, userId, name, name.toLowerCase(), hitCount, aliasOf);
		await db.batch([
			insertUser(userId),
			entry(euler, "Euler", 1, null),
			entry(gauss, "Gauss", 0, null),
			entry(alias, "Leonhard Euler", 0, euler),
			entry(claim, "Prince of mathematicians", 0, null),
			db
				.prepare(
					"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at) VALUES (?1, ?2, ?3, 'euler', 'euler', 'exact', 1, 5)",
				)
				.bind(crypto.randomUUID(), euler, userId),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, note, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.9, 'pending', NULL, 6, NULL)",
				)
				.bind(crypto.randomUUID(), userId, claim, euler, alias),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, note, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, NULL, 'semantic', 0.8, 'distinct', 'different', 6, 7)",
				)
				.bind(crypto.randomUUID(), userId, claim, gauss),
		]);
		before = {
			entries: await rows("SELECT * FROM entries ORDER BY id"),
			hits: await rows("SELECT * FROM hits ORDER BY id"),
			nearMisses: await rows("SELECT * FROM near_misses ORDER BY id"),
		};
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
	});

	it("keeps every entry, alias, hit and near miss, adding only unattributed model columns", async () => {
		// Non-empty snapshots, so the comparisons below cannot pass vacuously.
		expect(before.entries).toHaveLength(4);
		expect(before.hits).toHaveLength(1);
		expect(before.nearMisses).toHaveLength(2);

		expect(await rows("SELECT * FROM entries ORDER BY id")).toEqual(
			before.entries.map((row) => ({ ...row, model: null, model_version: null, client: null })),
		);
		expect(await rows("SELECT * FROM hits ORDER BY id")).toEqual(
			before.hits.map((row) => ({ ...row, model: null, model_version: null })),
		);
		expect(await rows("SELECT * FROM near_misses ORDER BY id")).toEqual(before.nearMisses);
		expect(
			await rows(
				"SELECT name FROM sqlite_master WHERE name IN ('hits_keep', 'near_misses_keep', 'entries_new')",
			),
		).toEqual([]);
	});

	it("cascades on the rebuilt table: aliases, hits, near misses and overlaps go with an original", async () => {
		const owner = crypto.randomUUID();
		const original = crypto.randomUUID();
		const viaAlias = crypto.randomUUID();
		const keptAlias = crypto.randomUUID();
		const other = crypto.randomUUID();
		const claimer = crypto.randomUUID();
		const nearMiss = crypto.randomUUID();
		const overlapVia = crypto.randomUUID();
		const overlapOnOther = crypto.randomUUID();
		const entry = (id: string, name: string, aliasOf: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, alias_of, created_at, model) VALUES (?1, ?2, 'math', ?3, ?4, 'pending', 0, ?5, 1, 'Claude')",
				)
				.bind(id, owner, name, name.toLowerCase(), aliasOf);
		await db.batch([
			insertUser(owner),
			entry(original, "Hypatia", null),
			entry(viaAlias, "Hypatia of Alexandria", original),
			entry(keptAlias, "The Philosopher", original),
			entry(other, "Noether", null),
			entry(claimer, "Alexandrian mathematician", null),
			db
				.prepare(
					"INSERT INTO hits (id, entry_id, user_id, candidate_text, candidate_normalized, match_kind, score, created_at, model) VALUES (?1, ?2, ?3, 'hypatia', 'hypatia', 'exact', 1, 2, 'Grok')",
				)
				.bind(crypto.randomUUID(), original, owner),
			db
				.prepare(
					"INSERT INTO near_misses (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, verdict, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'semantic', 0.9, 'pending', 3)",
				)
				.bind(nearMiss, owner, claimer, original, viaAlias),
			db
				.prepare(
					"INSERT INTO overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'exact', 1, 3)",
				)
				.bind(overlapVia, owner, claimer, original, viaAlias),
			db
				.prepare(
					"INSERT INTO overlaps (id, user_id, claim_entry_id, matched_entry_id, via_entry_id, match_kind, score, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 'semantic', 0.8, 3)",
				)
				.bind(overlapOnOther, owner, claimer, other),
		]);
		expect(await count("hits", "entry_id", original)).toBe(1);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(viaAlias).run();
		expect(await rows(`SELECT via_entry_id FROM near_misses WHERE id = '${nearMiss}'`)).toEqual([
			{ via_entry_id: null },
		]);
		expect(await rows(`SELECT via_entry_id FROM overlaps WHERE id = '${overlapVia}'`)).toEqual([
			{ via_entry_id: null },
		]);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(original).run();
		expect(await count("entries", "id", keptAlias)).toBe(0);
		expect(await count("hits", "entry_id", original)).toBe(0);
		expect(await count("near_misses", "id", nearMiss)).toBe(0);
		expect(await count("overlaps", "id", overlapVia)).toBe(0);
		expect(await count("overlaps", "id", overlapOnOther)).toBe(1);

		await db.prepare("DELETE FROM entries WHERE id = ?1").bind(claimer).run();
		expect(await count("overlaps", "id", overlapOnOther)).toBe(0);
	});

	it("allows a topic once per model, case-insensitively, and makes unattributed rows collide", async () => {
		const owner = crypto.randomUUID();
		await insertUser(owner).run();
		const insert = (model: string | null) =>
			db
				.prepare(
					"INSERT INTO entries (id, user_id, category, display_name, normalized, vector_status, hit_count, created_at, model) VALUES (?1, ?2, 'math', 'Noether', 'noether', 'pending', 0, 1, ?3)",
				)
				.bind(crypto.randomUUID(), owner, model)
				.run();

		await insert("Claude");
		await expect(insert("claude")).rejects.toThrow(/UNIQUE constraint failed/);
		await insert("Grok");
		await insert(null);
		await expect(insert(null)).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("defaults share_ledger to on and accepts only 0 or 1", async () => {
		const owner = crypto.randomUUID();
		await insertUser(owner).run();
		expect(
			await db.prepare("SELECT share_ledger FROM users WHERE id = ?1").bind(owner).first(),
		).toEqual({ share_ledger: 1 });
		await db.prepare("UPDATE users SET share_ledger = 0 WHERE id = ?1").bind(owner).run();
		await expect(
			db.prepare("UPDATE users SET share_ledger = 2 WHERE id = ?1").bind(owner).run(),
		).rejects.toThrow(/CHECK constraint failed/);
	});
});
