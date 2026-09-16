import { describe, expect, it } from "vitest";
import type { Ledger } from "../src/core/ledger";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeEntry, makeHit, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

interface Flagged {
	ledger: Ledger;
	semantic: FakeSemanticIndex;
	userId: string;
	category: string;
	haythamId: string;
	khayyamId: string;
	claimId: string;
}

/** Ibn al-Haytham and Omar Khayyam are claimed; the claim "Alhazen" then resembles both. */
async function flaggedClaim(): Promise<Flagged> {
	const semantic = new FakeSemanticIndex();
	const ledger = makeTestLedger({ semantic });
	const userId = await seedUser();
	const category = uniqueCategory();
	const haytham = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
	const khayyam = await ledger.claim(userId, { category, name: "Omar Khayyam", force: false });
	if (haytham.status !== "claimed" || khayyam.status !== "claimed") {
		throw new Error("expected claimed");
	}
	semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
	semantic.setSimilarity("Omar Khayyam", "Alhazen", 0.79);
	const claim = await ledger.claim(userId, { category, name: "Alhazen", force: false });
	if (claim.status !== "possible_repeat") throw new Error("expected possible_repeat");
	return {
		ledger,
		semantic,
		userId,
		category,
		haythamId: haytham.entry.id,
		khayyamId: khayyam.entry.id,
		claimId: claim.entry.id,
	};
}

describe("Ledger.skip", () => {
	it("aliases the claim to the original, records the hit, and leaves the other near miss pending", async () => {
		const f = await flaggedClaim();

		const result = await f.ledger.skip(f.userId, {
			entry_id: f.claimId,
			repeat_of: f.haythamId,
			note: "same person",
		});

		expect(result).toMatchObject({
			skipped: f.claimId,
			alias_of: {
				entry_id: f.haythamId,
				display_name: "Ibn al-Haytham",
				kind: "semantic",
				score: 0.9,
				confidence: "possible",
				hit_count: 1,
			},
		});
		const store = testStore();
		expect((await store.getEntry(f.userId, f.claimId))?.alias_of).toBe(f.haythamId);
		expect(f.semantic.documents.has(f.claimId)).toBe(true);
		const rows = await store.listNearMissesForClaim(f.userId, f.claimId);
		expect(rows.map((row) => [row.matched_entry_id, row.verdict, row.note])).toEqual([
			[f.haythamId, "repeat", "same person"],
			[f.khayyamId, "pending", null],
		]);
		const stats = await f.ledger.stats(
			f.userId,
			{ scope: "me", category: f.category, limit: 20 },
			2,
		);
		expect(stats.repeats).toEqual([
			{
				display_name: "Ibn al-Haytham",
				category: f.category,
				hit_count: 1,
				recent_phrasings: ["Alhazen"],
			},
		]);
		const listed = await f.ledger.list(f.userId, { category: f.category, limit: 20 });
		expect(listed.entries.map((entry) => entry.id).sort()).toEqual(
			[f.haythamId, f.khayyamId].sort(),
		);
	});

	it("turns the skipped phrasing into an exact repeat of the original", async () => {
		const f = await flaggedClaim();
		await f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId });

		const again = await f.ledger.claim(f.userId, {
			category: f.category,
			name: "ALHAZEN",
			force: false,
		});

		expect(again.status).toBe("repeat");
		if (again.status === "repeat") {
			expect(again.matches[0]).toMatchObject({
				entry_id: f.haythamId,
				kind: "exact",
				via_alias: "Alhazen",
				hit_count: 2,
			});
		}
	});

	it("rejects another user's entry, a repeat_of that is not a pending match, and a second verdict", async () => {
		const f = await flaggedClaim();
		const stranger = await seedUser("stranger");

		await expect(
			f.ledger.skip(stranger, { entry_id: f.claimId, repeat_of: f.haythamId }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.claimId }),
		).rejects.toMatchObject({ code: "invalid_input" });

		await f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId });

		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.khayyamId }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(f.ledger.keep(f.userId, { entry_id: f.claimId })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect((await testStore().getEntry(f.userId, f.khayyamId))?.hit_count).toBe(0);
	});

	it("rejects an entry with no pending near misses, and skip after keep", async () => {
		const f = await flaggedClaim();
		await expect(
			f.ledger.skip(f.userId, { entry_id: f.haythamId, repeat_of: f.khayyamId }),
		).rejects.toMatchObject({ code: "invalid_input" });

		await f.ledger.keep(f.userId, { entry_id: f.claimId });

		await expect(
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId }),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("rejects an entry that already has hits or aliases of its own", async () => {
		const store = testStore();
		const withHit = await flaggedClaim();
		const claimRow = await store.getEntry(withHit.userId, withHit.claimId);
		if (!claimRow) throw new Error("expected the claim entry");
		await store.recordHit(makeHit(claimRow, "Alhazen"));
		await expect(
			withHit.ledger.skip(withHit.userId, {
				entry_id: withHit.claimId,
				repeat_of: withHit.haythamId,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		const withAlias = await flaggedClaim();
		await store.insertEntry(
			makeEntry(withAlias.userId, withAlias.category, "Al-Hasan ibn al-Haytham", {
				alias_of: withAlias.claimId,
			}),
		);
		await expect(
			withAlias.ledger.skip(withAlias.userId, {
				entry_id: withAlias.claimId,
				repeat_of: withAlias.haythamId,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("records exactly one hit when two skips race", async () => {
		const f = await flaggedClaim();

		const outcomes = await Promise.allSettled([
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.haythamId }),
			f.ledger.skip(f.userId, { entry_id: f.claimId, repeat_of: f.khayyamId }),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
			code: "invalid_input",
		});
		const store = testStore();
		const haytham = await store.getEntry(f.userId, f.haythamId);
		const khayyam = await store.getEntry(f.userId, f.khayyamId);
		expect((haytham?.hit_count ?? 0) + (khayyam?.hit_count ?? 0)).toBe(1);
	});
});

describe("Ledger.keep", () => {
	it("marks every pending near miss distinct with the note and keeps the topic", async () => {
		const f = await flaggedClaim();

		expect(
			await f.ledger.keep(f.userId, { entry_id: f.claimId, note: "different people" }),
		).toEqual({ kept: f.claimId, distinct: 2 });

		const rows = await testStore().listNearMissesForClaim(f.userId, f.claimId);
		expect(rows.map((row) => [row.verdict, row.note])).toEqual([
			["distinct", "different people"],
			["distinct", "different people"],
		]);
		expect(rows.every((row) => row.decided_at !== null)).toBe(true);
		expect(
			(await f.ledger.list(f.userId, { category: f.category, limit: 20 })).entries,
		).toHaveLength(3);
		await expect(f.ledger.keep(f.userId, { entry_id: f.claimId })).rejects.toMatchObject({
			code: "invalid_input",
		});
	});

	it("rejects unknown and foreign entries", async () => {
		const f = await flaggedClaim();
		await expect(f.ledger.keep(f.userId, { entry_id: crypto.randomUUID() })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(
			f.ledger.keep(await seedUser("stranger"), { entry_id: f.claimId }),
		).rejects.toMatchObject({ code: "not_found" });
	});
});
