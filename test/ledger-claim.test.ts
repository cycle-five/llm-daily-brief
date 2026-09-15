import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../src/config";
import { LedgerError } from "../src/core/errors";
import { Ledger } from "../src/core/ledger";
import { MAX_MATCHES } from "../src/core/match";
import type { EntryRow } from "../src/core/rows";
import { LedgerStore } from "../src/store/d1";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeEntry, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

/** Production defaults keep semantic matches advisory; blocking stays configurable. */
const BLOCKING_THRESHOLDS = { ...DEFAULT_THRESHOLDS, semanticRepeat: 0.85 };

/** Simulates a user with more entries than listCandidates' scan window returns. */
class NarrowWindowStore extends LedgerStore {
	override async listCandidates(): Promise<EntryRow[]> {
		return [];
	}
}

function makeNarrowWindowLedger(semantic: FakeSemanticIndex): Ledger {
	return new Ledger({
		store: new NarrowWindowStore(env.DB),
		semantic,
		thresholds: DEFAULT_THRESHOLDS,
		now: () => Date.now(),
		newId: () => crypto.randomUUID(),
	});
}

async function hitCount(userId: string, category: string, entryId: string): Promise<number> {
	const rows = await testStore().listEntries(userId, { category, limit: 100 });
	return rows.find((row) => row.id === entryId)?.hit_count ?? -1;
}

describe("Ledger.claim", () => {
	it("claims a new topic and indexes it", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();

		const result = await ledger.claim(userId, { category, name: "Euler's Identity", force: false });

		expect(result.status).toBe("claimed");
		if (result.status !== "claimed") return;
		expect(result.entry.display_name).toBe("Euler's Identity");
		expect(result).toMatchObject({ forced: false, possible_matches: [], semantic: "ok" });
		expect(semantic.documents.get(result.entry.id)?.text).toBe("Euler's Identity");
		const pending = await testStore().listPending(1000);
		expect(pending.some((row) => row.id === result.entry.id)).toBe(false);
	});

	it("blocks an exact repeat and records a hit", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's Identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const again = await ledger.claim(userId, { category, name: "euler identity", force: false });

		expect(again.status).toBe("repeat");
		if (again.status !== "repeat") return;
		expect(again.matches[0]).toMatchObject({
			entry_id: first.entry.id,
			kind: "exact",
			hit_count: 1,
		});
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});

	it("blocks a trigram repeat", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Srinivasa Ramanujan", force: false });

		const result = await ledger.claim(userId, {
			category,
			name: "Srinivasa Ramanujam",
			force: false,
		});

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") expect(result.matches[0]?.kind).toBe("trigram");
	});

	it("treats a strong semantic match as advisory under the default thresholds, without a hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.95);
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "e^(iπ)+1=0", force: false });

		expect(result.status).toBe("claimed");
		if (result.status === "claimed") {
			expect(result.forced).toBe(false);
			expect(result.possible_matches).toMatchObject([
				{ entry_id: first.entry.id, kind: "semantic", confidence: "possible", score: 0.95 },
			]);
		}
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});

	it("blocks a semantic repeat when a repeat threshold is configured", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.9);
		const ledger = makeTestLedger({ semantic, thresholds: BLOCKING_THRESHOLDS });
		const userId = await seedUser();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Euler's identity", force: false });

		const result = await ledger.claim(userId, { category, name: "e^(iπ)+1=0", force: false });

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") {
			expect(result.matches[0]).toMatchObject({
				kind: "semantic",
				confidence: "repeat",
				score: 0.9,
			});
		}
	});

	it("claims but reports possible matches between the two semantic thresholds, without a hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Fermat's Last Theorem", "Wiles' proof", 0.8);
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, {
			category,
			name: "Fermat's Last Theorem",
			force: false,
		});
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Wiles' proof", force: false });

		expect(result.status).toBe("claimed");
		if (result.status === "claimed") {
			expect(result.forced).toBe(false);
			expect(result.possible_matches).toMatchObject([
				{ entry_id: first.entry.id, confidence: "possible" },
			]);
		}
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});

	it("force overrides a configured semantic repeat, returns the overridden matches, and records no hit", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.setSimilarity("Euler's identity", "Euler's totient", 0.9);
		const ledger = makeTestLedger({ semantic, thresholds: BLOCKING_THRESHOLDS });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Euler's totient", force: true });

		expect(result.status).toBe("claimed");
		if (result.status === "claimed") {
			expect(result.forced).toBe(true);
			expect(result.possible_matches).toMatchObject([
				{ entry_id: first.entry.id, confidence: "repeat" },
			]);
		}
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});

	it("force does not override an exact match, and the repeat records a hit", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Gauss", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.claim(userId, { category, name: "Gauss", force: true });

		expect(result.status).toBe("repeat");
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});

	it("never matches another user's entries", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const alice = await seedUser("alice");
		const bob = await seedUser("bob");
		const category = uniqueCategory();
		await ledger.claim(alice, { category, name: "Noether", force: false });

		expect((await ledger.claim(bob, { category, name: "Noether", force: false })).status).toBe(
			"claimed",
		);
	});

	it("rejects names without letters or digits", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		await expect(
			ledger.claim(userId, { category: uniqueCategory(), name: "!!!", force: false }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			ledger.check(userId, { category: uniqueCategory(), name: "?" }),
		).rejects.toBeInstanceOf(LedgerError);
	});
});

describe("Ledger.check", () => {
	it("reports a likely repeat without recording a hit", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Noether", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const result = await ledger.check(userId, { category, name: "noether" });

		expect(result).toMatchObject({ likely_repeat: true, semantic: "ok" });
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});
});

describe("semantic degradation and backfill", () => {
	it("claims with semantic unavailable, still blocks exact repeats, then backfills", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.failing = true;
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();

		const claimed = await ledger.claim(userId, { category, name: "Lovelace", force: false });
		expect(claimed).toMatchObject({ status: "claimed", semantic: "unavailable" });
		if (claimed.status !== "claimed") return;
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(
			true,
		);

		const repeat = await ledger.claim(userId, { category, name: "lovelace", force: false });
		expect(repeat).toMatchObject({ status: "repeat", semantic: "unavailable" });

		semantic.failing = false;
		expect(await ledger.backfill(1000)).toBeGreaterThanOrEqual(1);
		expect(semantic.documents.has(claimed.entry.id)).toBe(true);
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(
			false,
		);
	});

	it("backfill returns 0 and leaves rows pending when the index is still failing", async () => {
		const semantic = new FakeSemanticIndex();
		semantic.failing = true;
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const claimed = await ledger.claim(userId, {
			category: uniqueCategory(),
			name: "Hopper",
			force: false,
		});
		if (claimed.status !== "claimed") throw new Error("expected claimed");

		expect(await ledger.backfill(1000)).toBe(0);
		expect((await testStore().listPending(1000)).some((row) => row.id === claimed.entry.id)).toBe(
			true,
		);
	});
});

describe("exact match beyond the candidate scan window", () => {
	it("claim finds an exact repeat outside the window and records a hit", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Euler's Identity", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");

		const narrowLedger = makeNarrowWindowLedger(semantic);
		const result = await narrowLedger.claim(userId, {
			category,
			name: "euler identity",
			force: false,
		});

		expect(result.status).toBe("repeat");
		if (result.status !== "repeat") return;
		expect(result.matches[0]).toMatchObject({ entry_id: first.entry.id, kind: "exact" });
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});

	it("check reports likely_repeat for an exact repeat outside the window", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, {
			category,
			name: "Fermat's Last Theorem",
			force: false,
		});
		if (first.status !== "claimed") throw new Error("expected claimed");

		const narrowLedger = makeNarrowWindowLedger(semantic);
		const result = await narrowLedger.check(userId, { category, name: "Fermat Last Theorem" });

		expect(result.likely_repeat).toBe(true);
		expect(await hitCount(userId, category, first.entry.id)).toBe(0);
	});
});

describe("aliases", () => {
	async function seedAlias(
		userId: string,
		category: string,
		originalId: string,
		name: string,
		semantic?: FakeSemanticIndex,
	): Promise<EntryRow> {
		const alias = makeEntry(userId, category, name, {
			alias_of: originalId,
			vector_status: "indexed",
		});
		await testStore().insertEntry(alias);
		await semantic?.upsert([{ entryId: alias.id, userId, category, text: name }]);
		return alias;
	}

	it("blocks an exact repeat of an alias as a repeat of the original, with the hit on the original", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		const alias = await seedAlias(userId, category, first.entry.id, "Alhazen");

		const result = await ledger.claim(userId, { category, name: "alhazen", force: false });

		expect(result.status).toBe("repeat");
		if (result.status !== "repeat") return;
		expect(result.matches).toMatchObject([
			{
				entry_id: first.entry.id,
				display_name: "Ibn al-Haytham",
				kind: "exact",
				via_alias: "Alhazen",
				hit_count: 1,
			},
		]);
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
		expect((await testStore().getEntry(userId, alias.id))?.hit_count).toBe(0);
	});

	it("blocks a spelling variant of an alias through trigram matching", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, {
			category,
			name: "Srinivasa Ramanujan",
			force: false,
		});
		if (first.status !== "claimed") throw new Error("expected claimed");
		await seedAlias(userId, category, first.entry.id, "The Man Who Knew Infinity");

		const result = await ledger.claim(userId, {
			category,
			name: "The Man Who Knew Infinty",
			force: false,
		});

		expect(result.status).toBe("repeat");
		if (result.status === "repeat") {
			expect(result.matches[0]).toMatchObject({
				entry_id: first.entry.id,
				kind: "trigram",
				via_alias: "The Man Who Knew Infinity",
			});
		}
	});

	it("reports an original matched directly and through an alias once, as its strongest match", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		await seedAlias(userId, category, first.entry.id, "Alhazen", semantic);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.9);
		semantic.setSimilarity("Ibn al-Haytham", "Father of optics", 0.8);

		const result = await ledger.check(userId, { category, name: "Father of optics" });

		expect(result.likely_repeat).toBe(false);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			entry_id: first.entry.id,
			kind: "semantic",
			score: 0.9,
			via_alias: "Alhazen",
		});
	});

	it("over-fetches semantic results so one topic's aliases do not crowd out other topics", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const crowded = await ledger.claim(userId, { category, name: "Leonhard Euler", force: false });
		const other = await ledger.claim(userId, {
			category,
			name: "Carl Friedrich Gauss",
			force: false,
		});
		if (crowded.status !== "claimed" || other.status !== "claimed") {
			throw new Error("expected claimed");
		}
		for (let i = 1; i <= MAX_MATCHES; i++) {
			const name = `Euler alias ${i}`;
			await seedAlias(userId, category, crowded.entry.id, name, semantic);
			semantic.setSimilarity(name, "Prince of mathematicians", 0.95);
		}
		semantic.setSimilarity("Carl Friedrich Gauss", "Prince of mathematicians", 0.8);

		const result = await ledger.check(userId, { category, name: "Prince of mathematicians" });

		expect(result.matches.map((match) => match.entry_id)).toEqual([
			crowded.entry.id,
			other.entry.id,
		]);
	});

	it("resolves an alias whose original lies outside the candidate scan window", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = await ledger.claim(userId, { category, name: "Ibn al-Haytham", force: false });
		if (first.status !== "claimed") throw new Error("expected claimed");
		await seedAlias(userId, category, first.entry.id, "Alhazen", semantic);

		const narrowLedger = makeNarrowWindowLedger(semantic);
		const result = await narrowLedger.claim(userId, { category, name: "alhazen", force: false });

		expect(result.status).toBe("repeat");
		if (result.status !== "repeat") return;
		expect(result.matches[0]).toMatchObject({
			entry_id: first.entry.id,
			kind: "exact",
			via_alias: "Alhazen",
		});
		expect(await hitCount(userId, category, first.entry.id)).toBe(1);
	});
});
