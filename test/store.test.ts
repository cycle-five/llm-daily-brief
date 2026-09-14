import { describe, expect, it } from "vitest";
import { makeEntry, makeHit, seedUser, testStore, uniqueCategory } from "./helpers";

describe("users and identities", () => {
	it("returns the same user for the same identity and a new user for another", async () => {
		const store = testStore();
		const subject = `s-${crypto.randomUUID()}`;
		const identity = {
			provider: "github" as const,
			subject,
			email: "a@example.com",
			displayName: "A",
		};
		const first = await store.findOrCreateUserByIdentity(identity, 1, () => crypto.randomUUID());
		const again = await store.findOrCreateUserByIdentity(identity, 2, () => crypto.randomUUID());
		const google = await store.findOrCreateUserByIdentity(
			{ ...identity, provider: "google" },
			3,
			() => crypto.randomUUID(),
		);
		expect(again).toBe(first);
		expect(google).not.toBe(first);
		expect(await store.getUser(first)).toEqual({
			id: first,
			display_name: "A",
			email: "a@example.com",
			created_at: 1,
		});
	});

	it("deleteUser returns the user's entry ids and removes the user", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Euler");
		await store.insertEntry(entry);
		expect(await store.deleteUser(userId)).toEqual([entry.id]);
		expect(await store.getUser(userId)).toBeNull();
	});
});

describe("entries", () => {
	it("reports duplicates by user, category and normalized name", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		expect(await store.insertEntry(makeEntry(userId, category, "Euler's Identity"))).toBe(
			"inserted",
		);
		expect(await store.insertEntry(makeEntry(userId, category, "euler identity"))).toBe(
			"duplicate",
		);
	});

	it("scopes candidates to one user and category, newest first", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const older = makeEntry(alice, category, "Gauss", { created_at: 1 });
		const newer = makeEntry(alice, category, "Noether", { created_at: 2 });
		await store.insertEntry(older);
		await store.insertEntry(newer);
		await store.insertEntry(makeEntry(alice, uniqueCategory(), "Hilbert"));
		await store.insertEntry(makeEntry(bob, category, "Riemann"));
		expect((await store.listCandidates(alice, category)).map((e) => e.id)).toEqual([
			newer.id,
			older.id,
		]);
	});

	it("findExact returns the matching row for the owner and null for another user or category", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const entry = makeEntry(alice, category, "Euler's Identity");
		await store.insertEntry(entry);

		expect(await store.findExact(alice, category, entry.normalized)).toEqual(entry);
		expect(await store.findExact(bob, category, entry.normalized)).toBeNull();
		expect(await store.findExact(alice, uniqueCategory(), entry.normalized)).toBeNull();
	});

	it("getEntriesByIds ignores other users' and other categories' ids", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const mine = makeEntry(alice, category, "Cantor");
		const otherCategory = makeEntry(alice, uniqueCategory(), "Cantor");
		const theirs = makeEntry(bob, category, "Cantor");
		for (const e of [mine, otherCategory, theirs]) await store.insertEntry(e);
		const rows = await store.getEntriesByIds(alice, category, [
			mine.id,
			otherCategory.id,
			theirs.id,
		]);
		expect(rows.map((r) => r.id)).toEqual([mine.id]);
		expect(await store.getEntriesByIds(alice, category, [])).toEqual([]);
	});

	it("filters listEntries by category and since", async () => {
		const store = testStore();
		const userId = await seedUser();
		const math = uniqueCategory();
		const people = uniqueCategory();
		await store.insertEntry(makeEntry(userId, math, "Old", { created_at: 1_000 }));
		const recent = makeEntry(userId, math, "Recent", { created_at: 5_000 });
		await store.insertEntry(recent);
		await store.insertEntry(makeEntry(userId, people, "Person", { created_at: 6_000 }));
		const rows = await store.listEntries(userId, { category: math, limit: 20, sinceMs: 2_000 });
		expect(rows.map((r) => r.id)).toEqual([recent.id]);
		expect(await store.listEntries(userId, { limit: 20 })).toHaveLength(3);
	});

	it("deletes only the owner's entry and cascades its hits", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const entry = makeEntry(alice, uniqueCategory(), "Fermat");
		await store.insertEntry(entry);
		await store.recordHit(makeHit(entry, "Fermat"));
		expect(await store.deleteEntry(bob, entry.id)).toBe(false);
		expect(await store.deleteEntry(alice, entry.id)).toBe(true);
		expect(await store.topRepeatsForUser(alice, entry.category, 10)).toEqual([]);
	});

	it("tracks pending entries until marked indexed", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Lovelace");
		await store.insertEntry(entry);
		expect((await store.listPending(1000)).some((e) => e.id === entry.id)).toBe(true);
		await store.markIndexed([entry.id]);
		expect((await store.listPending(1000)).some((e) => e.id === entry.id)).toBe(false);
	});
});

describe("hits and repeats", () => {
	it("recordHit increments hit_count; topRepeatsForUser orders by hits with newest phrasings", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const euler = makeEntry(userId, category, "Euler's Identity");
		const gauss = makeEntry(userId, category, "Gauss");
		const untouched = makeEntry(userId, category, "Noether");
		for (const e of [euler, gauss, untouched]) await store.insertEntry(e);
		await store.recordHit(makeHit(euler, "Euler identity", { created_at: 1 }));
		await store.recordHit(
			makeHit(euler, "e^(iπ)+1=0", { created_at: 2, match_kind: "semantic", score: 0.9 }),
		);
		await store.recordHit(makeHit(gauss, "Gauss", { created_at: 3 }));

		const repeats = await store.topRepeatsForUser(userId, category, 10);
		expect(repeats.map((r) => [r.entry.id, r.entry.hit_count])).toEqual([
			[euler.id, 2],
			[gauss.id, 1],
		]);
		expect(repeats[0]?.phrasings).toEqual(["e^(iπ)+1=0", "Euler identity"]);
	});

	it("caps phrasings per entry at MAX_PHRASINGS", async () => {
		const store = testStore();
		const userId = await seedUser();
		const entry = makeEntry(userId, uniqueCategory(), "Pi");
		await store.insertEntry(entry);
		for (let i = 0; i < 12; i++) {
			await store.recordHit(makeHit(entry, `pi ${i}`, { created_at: i }));
		}
		const [repeat] = await store.topRepeatsForUser(userId, entry.category, 10);
		expect(repeat?.phrasings).toHaveLength(10);
		expect(repeat?.phrasings[0]).toBe("pi 11");
	});

	it("globalRepeats hides topics hit by fewer than minUsers users and picks the most common display name", async () => {
		const store = testStore();
		const category = uniqueCategory();
		const [a, b, c] = [await seedUser("a"), await seedUser("b"), await seedUser("c")];
		const entryA = makeEntry(a, category, "Euler's Identity");
		const entryB = makeEntry(b, category, "Euler's identity");
		const entryC = makeEntry(c, category, "Euler's identity");
		const lonely = makeEntry(a, category, "Obscure Lemma");
		for (const e of [entryA, entryB, entryC, lonely]) await store.insertEntry(e);
		await store.recordHit(makeHit(entryA, "Euler identity"));
		await store.recordHit(makeHit(entryB, "Euler identity"));
		await store.recordHit(makeHit(lonely, "Obscure Lemma"));

		expect(await store.globalRepeats(category, 2, 20)).toEqual([
			{ category, display_name: "Euler's identity", hit_count: 2, distinct_users: 2 },
		]);
		expect(await store.globalRepeats(category, 1, 20)).toHaveLength(2);
	});
});

describe("api tokens", () => {
	it("finds active tokens by hash and stops finding them after revocation", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const row = {
			id: crypto.randomUUID(),
			user_id: alice,
			token_hash: `hash-${crypto.randomUUID()}`,
			label: "cron",
			created_at: 10,
			last_used_at: null,
			revoked_at: null,
		};
		await store.insertToken(row);
		expect(await store.findActiveTokenByHash(row.token_hash)).toEqual(row);

		await store.touchToken(row.id, 20);
		expect((await store.listTokens(alice))[0]?.last_used_at).toBe(20);

		expect(await store.revokeToken(bob, row.id, 30)).toBe(false);
		expect(await store.revokeToken(alice, row.id, 30)).toBe(true);
		expect(await store.findActiveTokenByHash(row.token_hash)).toBeNull();
		expect(await store.revokeToken(alice, row.id, 40)).toBe(false);
	});
});
