import { describe, expect, it } from "vitest";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeTestLedger, seedUser, steppingClock, testStore, uniqueCategory } from "./helpers";

async function claimed(
	ledger: ReturnType<typeof makeTestLedger>,
	userId: string,
	category: string,
	name: string,
): Promise<string> {
	const result = await ledger.claim(userId, { category, name, force: false });
	if (result.status !== "claimed") throw new Error(`expected ${name} to be claimed`);
	return result.entry.id;
}

describe("Ledger.list", () => {
	it("returns the user's entries newest first, filtered by category and since", async () => {
		const ledger = makeTestLedger({ now: steppingClock(Date.UTC(2026, 8, 14)) });
		const userId = await seedUser();
		const math = uniqueCategory();
		const people = uniqueCategory();
		const first = await claimed(ledger, userId, math, "Gauss");
		const second = await claimed(ledger, userId, math, "Noether");
		await claimed(ledger, userId, people, "Lovelace");

		const all = await ledger.list(userId, { category: math, limit: 20 });
		expect(all.entries.map((e) => e.id)).toEqual([second, first]);
		expect(all.entries[0]?.created_at).toBe(new Date(Date.UTC(2026, 8, 14) + 2).toISOString());

		const since = await ledger.list(userId, {
			category: math,
			limit: 20,
			since: new Date(Date.UTC(2026, 8, 14) + 2).toISOString(),
		});
		expect(since.entries.map((e) => e.id)).toEqual([second]);
	});
});

describe("Ledger.forget", () => {
	it("removes the owner's entry from D1 and the semantic index", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const entryId = await claimed(ledger, userId, category, "Hilbert");

		await ledger.forget(userId, entryId);

		expect((await ledger.list(userId, { category, limit: 20 })).entries).toEqual([]);
		expect(semantic.documents.has(entryId)).toBe(false);
	});

	it("throws not_found for unknown ids and for another user's entry", async () => {
		const ledger = makeTestLedger();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		const entryId = await claimed(ledger, alice, category, "Cantor");

		await expect(ledger.forget(alice, crypto.randomUUID())).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(ledger.forget(bob, entryId)).rejects.toMatchObject({ code: "not_found" });
		expect((await ledger.list(alice, { category, limit: 20 })).entries).toHaveLength(1);
	});

	it("still deletes the D1 row when the semantic index fails", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const entryId = await claimed(ledger, userId, category, "Turing");
		semantic.failing = true;

		await ledger.forget(userId, entryId);

		expect((await ledger.list(userId, { category, limit: 20 })).entries).toEqual([]);
	});

	it("forgetting an original removes its aliases, their vectors and near misses", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const originalId = await claimed(ledger, userId, category, "Ibn al-Haytham");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const flagged = await ledger.claim(userId, { category, name: "Alhazen", force: false });
		if (flagged.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: flagged.entry.id, repeat_of: originalId });

		await ledger.forget(userId, originalId);

		expect(await testStore().getEntry(userId, flagged.entry.id)).toBeNull();
		expect(semantic.documents.has(flagged.entry.id)).toBe(false);
		expect(await testStore().listNearMisses(userId, 20)).toEqual([]);
	});

	it("forgetting an alias keeps the hit it recorded on the original", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const originalId = await claimed(ledger, userId, category, "Ibn al-Haytham");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const flagged = await ledger.claim(userId, { category, name: "Alhazen", force: false });
		if (flagged.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: flagged.entry.id, repeat_of: originalId });

		await ledger.forget(userId, flagged.entry.id);

		const stats = await ledger.stats(userId, { scope: "me", category, limit: 20 }, 2);
		expect(stats.repeats).toMatchObject([{ display_name: "Ibn al-Haytham", hit_count: 1 }]);
		expect(semantic.documents.has(flagged.entry.id)).toBe(false);
		expect(await testStore().getEntry(userId, originalId)).not.toBeNull();
	});
});

describe("Ledger.stats", () => {
	it("scope me ranks the user's repeated entries with newest phrasings first", async () => {
		const ledger = makeTestLedger({ now: steppingClock() });
		const userId = await seedUser();
		const category = uniqueCategory();
		await claimed(ledger, userId, category, "Euler's Identity");
		await claimed(ledger, userId, category, "Gauss");
		await ledger.claim(userId, { category, name: "euler identity", force: false });
		await ledger.claim(userId, { category, name: "Euler’s identity", force: false });

		const stats = await ledger.stats(userId, { scope: "me", category, limit: 20 }, 2);

		expect(stats).toEqual({
			scope: "me",
			repeats: [
				{
					display_name: "Euler's Identity",
					category,
					hit_count: 2,
					recent_phrasings: ["Euler’s identity", "euler identity"],
				},
			],
		});
	});

	it("scope global aggregates across users, hides topics below the minimum, and exposes no identities", async () => {
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		for (const userId of [alice, bob]) {
			await claimed(ledger, userId, category, "Euler's identity");
			await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		}
		await claimed(ledger, alice, category, "Obscure Lemma");
		await ledger.claim(alice, { category, name: "Obscure Lemma", force: false });

		const stats = await ledger.stats(alice, { scope: "global", category, limit: 20 }, 2);

		expect(stats).toEqual({
			scope: "global",
			repeats: [{ display_name: "Euler's identity", category, hit_count: 2, distinct_users: 2 }],
		});
		expect(
			(await ledger.stats(alice, { scope: "global", category, limit: 20 }, 3)).repeats,
		).toEqual([]);
	});
});

describe("Ledger.deleteAccount", () => {
	it("removes the user, their entries and their vectors", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const entryId = await claimed(ledger, userId, uniqueCategory(), "Hypatia");

		await ledger.deleteAccount(userId);

		expect(await testStore().getUser(userId)).toBeNull();
		expect(semantic.documents.has(entryId)).toBe(false);
		expect((await ledger.list(userId, { limit: 20 })).entries).toEqual([]);
	});
});
