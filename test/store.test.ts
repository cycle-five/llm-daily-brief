import { describe, expect, it } from "vitest";
import { makeEntry, makeHit, makeNearMiss, seedUser, testStore, uniqueCategory } from "./helpers";

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
		expect(repeats[0]?.hits.map((h) => h.candidate_text)).toEqual(["e^(iπ)+1=0", "Euler identity"]);
		expect(repeats[0]?.hits[0]?.match_kind).toBe("semantic");
		expect(repeats[0]?.hits[0]?.score).toBe(0.9);
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
		expect(repeat?.hits).toHaveLength(10);
		expect(repeat?.hits[0]?.candidate_text).toBe("pi 11");
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

describe("aliases", () => {
	it("getEntry returns only the owner's entry", async () => {
		const store = testStore();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const entry = makeEntry(alice, uniqueCategory(), "Gauss");
		await store.insertEntry(entry);
		expect(await store.getEntry(alice, entry.id)).toEqual(entry);
		expect(await store.getEntry(bob, entry.id)).toBeNull();
	});

	it("listAliases returns the owner's aliases; listEntries and topRepeatsForUser exclude aliases", async () => {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const original = makeEntry(userId, category, "Euler's identity", { created_at: 1 });
		// A stale hit_count on the alias proves the repeats listing filters aliases explicitly.
		const alias = makeEntry(userId, category, "e^(iπ)+1=0", {
			alias_of: original.id,
			hit_count: 1,
			created_at: 2,
		});
		for (const e of [original, alias]) await store.insertEntry(e);
		await store.recordHit(makeHit(original, "Euler identity"));

		expect((await store.listAliases(userId, [original.id])).map((e) => e.id)).toEqual([alias.id]);
		expect(await store.listAliases(await seedUser("other"), [original.id])).toEqual([]);
		expect(await store.listAliases(userId, [])).toEqual([]);
		expect((await store.listEntries(userId, { category, limit: 20 })).map((e) => e.id)).toEqual([
			original.id,
		]);
		expect((await store.topRepeatsForUser(userId, category, 20)).map((r) => r.entry.id)).toEqual([
			original.id,
		]);
	});

	it("globalRepeats picks the display name from originals only", async () => {
		const store = testStore();
		const category = uniqueCategory();
		for (const label of ["a", "b"]) {
			const userId = await seedUser(label);
			const entry = makeEntry(userId, category, "Euler's identity");
			await store.insertEntry(entry);
			await store.recordHit(makeHit(entry, "Euler identity"));
		}
		for (const label of ["c", "d", "e"]) {
			const userId = await seedUser(label);
			const original = makeEntry(userId, category, "Euler's formula");
			await store.insertEntry(original);
			await store.insertEntry(
				makeEntry(userId, category, "Euler’s Identity", { alias_of: original.id }),
			);
		}
		expect(await store.globalRepeats(category, 2, 20)).toEqual([
			{ category, display_name: "Euler's identity", hit_count: 2, distinct_users: 2 },
		]);
	});
});

describe("near misses", () => {
	async function seedClaim() {
		const store = testStore();
		const userId = await seedUser();
		const category = uniqueCategory();
		const original = makeEntry(userId, category, "Ibn al-Haytham", { created_at: 1 });
		const other = makeEntry(userId, category, "Omar Khayyam", { created_at: 2 });
		const claim = makeEntry(userId, category, "Alhazen", { created_at: 3 });
		for (const e of [original, other, claim]) await store.insertEntry(e);
		const toOriginal = makeNearMiss(claim, original, { score: 0.9, created_at: 3 });
		const toOther = makeNearMiss(claim, other, { score: 0.79, created_at: 3 });
		await store.insertNearMisses([toOther, toOriginal]);
		return { store, userId, category, original, claim, toOriginal, toOther };
	}

	it("round-trips rows for a claim, highest score first, scoped to the owner", async () => {
		const { store, userId, claim, toOriginal, toOther } = await seedClaim();
		expect(await store.listNearMissesForClaim(userId, claim.id)).toEqual([toOriginal, toOther]);
		expect(await store.listNearMissesForClaim(await seedUser("other"), claim.id)).toEqual([]);
		await store.insertNearMisses([]);
	});

	it("skipAsAlias records the hit, marks the row, aliases the claim, and applies only once", async () => {
		const { store, userId, category, original, claim, toOriginal, toOther } = await seedClaim();
		const write = {
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name, {
				match_kind: "semantic",
				score: 0.9,
				created_at: 10,
			}),
			note: "same person",
			decidedAt: 10,
		};

		expect(await store.skipAsAlias(write)).toBe(true);
		expect(
			await store.skipAsAlias({ ...write, hit: { ...write.hit, id: crypto.randomUUID() } }),
		).toBe(false);

		expect((await store.getEntry(userId, claim.id))?.alias_of).toBe(original.id);
		const [repeat] = await store.topRepeatsForUser(userId, category, 20);
		expect(repeat?.entry.id).toBe(original.id);
		expect(repeat?.entry.hit_count).toBe(1);
		expect(repeat?.hits).toEqual([
			{ candidate_text: "Alhazen", match_kind: "semantic", score: 0.9 },
		]);
		expect(await store.listNearMissesForClaim(userId, claim.id)).toEqual([
			{ ...toOriginal, verdict: "repeat", note: "same person", decided_at: 10 },
			toOther,
		]);
	});

	it("skipAsAlias is a no-op once the claim has been kept", async () => {
		const { store, userId, category, original, claim, toOriginal } = await seedClaim();
		expect(await store.keepPending(userId, claim.id, "different people", 10)).toBe(2);

		const applied = await store.skipAsAlias({
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name),
			note: null,
			decidedAt: 11,
		});

		expect(applied).toBe(false);
		expect((await store.getEntry(userId, claim.id))?.alias_of).toBeNull();
		expect(await store.topRepeatsForUser(userId, category, 20)).toEqual([]);
		expect(await store.keepPending(userId, claim.id, null, 12)).toBe(0);
	});

	it("keepPending does nothing for another user or for a claim that is now an alias", async () => {
		const { store, userId, original, claim, toOriginal } = await seedClaim();
		expect(await store.keepPending(await seedUser("other"), claim.id, null, 10)).toBe(0);
		await store.skipAsAlias({
			nearMissId: toOriginal.id,
			claimEntryId: claim.id,
			hit: makeHit(original, claim.display_name),
			note: null,
			decidedAt: 10,
		});
		expect(await store.keepPending(userId, claim.id, null, 11)).toBe(0);
	});

	it("listNearMisses joins names, alias state and via, newest first", async () => {
		const { store, userId, category, original } = await seedClaim();
		const via = makeEntry(userId, category, "Alhazen of Basra", {
			alias_of: original.id,
			created_at: 4,
		});
		const later = makeEntry(userId, category, "Father of optics", { created_at: 5 });
		for (const e of [via, later]) await store.insertEntry(e);
		await store.insertNearMisses([
			makeNearMiss(later, original, { via_entry_id: via.id, score: 0.81, created_at: 5 }),
		]);

		const rows = await store.listNearMisses(userId, 20);

		expect(rows.map((r) => [r.claim_name, r.matched_name, r.via_name])).toEqual([
			["Father of optics", "Ibn al-Haytham", "Alhazen of Basra"],
			["Alhazen", "Ibn al-Haytham", null],
			["Alhazen", "Omar Khayyam", null],
		]);
		expect(rows[0]).toMatchObject({
			category,
			claim_alias_of: null,
			match_kind: "semantic",
			score: 0.81,
			verdict: "pending",
			note: null,
		});
		expect(await store.listNearMisses(await seedUser("other"), 20)).toEqual([]);
	});
});
