import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClaimInput, ClaimResult } from "../src/api/schemas";
import type { Ledger } from "../src/core/ledger";
import { MAX_MATCHES } from "../src/core/match";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeEntry, makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

type Claimed = Extract<ClaimResult, { status: "claimed" }>;
type Possible = Extract<ClaimResult, { status: "possible_repeat" }>;
type Repeat = Extract<ClaimResult, { status: "repeat" }>;

function claimed(result: ClaimResult): Claimed {
	if (result.status !== "claimed") throw new Error(`expected claimed, got ${result.status}`);
	return result;
}

function possible(result: ClaimResult): Possible {
	if (result.status !== "possible_repeat") {
		throw new Error(`expected possible_repeat, got ${result.status}`);
	}
	return result;
}

function repeated(result: ClaimResult): Repeat {
	if (result.status !== "repeat") throw new Error(`expected repeat, got ${result.status}`);
	return result;
}

/** A user whose models each keep their own ledger. */
async function separateUser(): Promise<string> {
	const userId = await seedUser();
	await testStore().setShareLedger(userId, false);
	return userId;
}

/** Claims as `model`, using the model's name as the connection. */
function claimAs(
	ledger: Ledger,
	userId: string,
	category: string,
	model: string,
	name: string,
	extra: Partial<ClaimInput> = {},
): Promise<ClaimResult> {
	return ledger.claim(userId, { category, name, force: false, model, ...extra }, model);
}

async function hitModels(entryId: string): Promise<unknown> {
	return env.DB.prepare("SELECT model, model_version FROM hits WHERE entry_id = ?1")
		.bind(entryId)
		.first();
}

async function latestHitModel(entryId: string): Promise<unknown> {
	return env.DB.prepare(
		"SELECT model FROM hits WHERE entry_id = ?1 ORDER BY created_at DESC LIMIT 1",
	)
		.bind(entryId)
		.first();
}

describe("shared ledger (the default)", () => {
	it("blocks another model's topic and records the attempting model on the hit", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		const first = claimed(
			await claimAs(ledger, userId, category, "Claude", "Stone duality", {
				model_version: "Opus 5",
			}),
		);

		const again = await claimAs(ledger, userId, category, "Grok", "stone duality", {
			model_version: "Grok 4",
		});

		expect(again.status).toBe("repeat");
		expect(first.entry.model).toBe("Claude");
		expect(await testStore().getEntry(userId, first.entry.id)).toMatchObject({
			model: "Claude",
			model_version: "Opus 5",
			client: "Claude",
		});
		expect(await hitModels(first.entry.id)).toEqual({ model: "Grok", model_version: "Grok 4" });
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});
});

describe("separate ledgers", () => {
	it("lets another model claim the same topic and records an exact overlap instead of a hit", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const claude = claimed(await claimAs(ledger, userId, category, "Claude", "Stone duality"));

		const grok = claimed(await claimAs(ledger, userId, category, "Grok", "stone duality"));

		expect(grok.entry.model).toBe("Grok");
		expect(await testStore().listOverlapsForClaim(userId, grok.entry.id)).toMatchObject([
			{ matched_entry_id: claude.entry.id, via_entry_id: null, match_kind: "exact", score: 1 },
		]);
		expect(await testStore().listNearMissesForClaim(userId, grok.entry.id)).toEqual([]);
		expect((await testStore().getEntry(userId, claude.entry.id))?.hit_count).toBe(0);
	});

	it("still blocks a model's own repeat, whatever the case of its declared name", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const first = claimed(await claimAs(ledger, userId, category, "Claude", "Gauss"));

		const again = await claimAs(ledger, userId, category, "CLAUDE", "gauss");

		expect(again.status).toBe("repeat");
		expect((await testStore().getEntry(userId, first.entry.id))?.hit_count).toBe(1);
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});

	it("records spelling and meaning overlaps without blocking or asking for a verdict", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const ramanujan = claimed(
			await claimAs(ledger, userId, category, "Claude", "Srinivasa Ramanujan"),
		);
		const boetie = claimed(
			await claimAs(ledger, userId, category, "Claude", "Étienne de La Boétie"),
		);
		semantic.setSimilarity("Étienne de La Boétie", "Émilie du Châtelet", 0.84);

		const misspelt = claimed(
			await claimAs(ledger, userId, category, "Grok", "Srinivasa Ramanujam"),
		);
		const chatelet = claimed(await claimAs(ledger, userId, category, "Grok", "Émilie du Châtelet"));

		expect(await testStore().listOverlapsForClaim(userId, misspelt.entry.id)).toMatchObject([
			{ matched_entry_id: ramanujan.entry.id, match_kind: "trigram" },
		]);
		expect(await testStore().listOverlapsForClaim(userId, chatelet.entry.id)).toMatchObject([
			{ matched_entry_id: boetie.entry.id, match_kind: "semantic", score: 0.84 },
		]);
		expect(await testStore().listNearMissesForClaim(userId, chatelet.entry.id)).toEqual([]);
	});

	it("asks only about the caller's own topics when a claim matches both ledgers", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		const alhazen = claimed(await claimAs(ledger, userId, category, "Grok", "Alhazen"));
		semantic.setSimilarity("Ibn al-Haytham", "Father of optics", 0.9);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);

		const optics = possible(await claimAs(ledger, userId, category, "Grok", "Father of optics"));

		expect(optics.possible_matches.map((match) => match.entry_id)).toEqual([alhazen.entry.id]);
		expect(
			(await testStore().listNearMissesForClaim(userId, optics.entry.id)).map(
				(row) => row.matched_entry_id,
			),
		).toEqual([alhazen.entry.id]);
		expect(await testStore().listOverlapsForClaim(userId, optics.entry.id)).toMatchObject([
			{ matched_entry_id: haytham.entry.id, match_kind: "semantic", score: 0.9 },
		]);
	});

	it("treats an unattributed topic as belonging to every model", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await ledger.claim(userId, { category, name: "Noether", force: false }));

		expect((await claimAs(ledger, userId, category, "Grok", "noether")).status).toBe("repeat");
	});

	it("records an overlap through another model's alias, against its original", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		const alias = makeEntry(userId, category, "Alhazen", {
			model: "Claude",
			alias_of: haytham.entry.id,
			vector_status: "indexed",
		});
		await testStore().insertEntry(alias);

		const grok = claimed(await claimAs(ledger, userId, category, "Grok", "alhazen"));

		expect(await testStore().listOverlapsForClaim(userId, grok.entry.id)).toMatchObject([
			{ matched_entry_id: haytham.entry.id, via_entry_id: alias.id, match_kind: "exact" },
		]);
	});

	it("matches entries from both ledgers once sharing is turned back on, recording one hit", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Euler's identity"));
		claimed(await claimAs(ledger, userId, category, "Grok", "Euler's identity"));
		await testStore().setShareLedger(userId, true);

		const gemini = await claimAs(ledger, userId, category, "Gemini", "euler identity");

		expect(gemini.status).toBe("repeat");
		const repeats = await testStore().topRepeatsForUser(userId, category, 10);
		expect(repeats.flatMap((row) => row.hits.map((hit) => hit.model))).toEqual(["Gemini"]);
	});

	it("ranks each ledger separately, so other models' matches cannot crowd out the caller's own", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const noether = claimed(await claimAs(ledger, userId, category, "Grok", "Emmy Noether"));
		const others = [
			"Hypatia",
			"Maryam Mirzakhani",
			"Sofia Kovalevskaya",
			"Sophie Germain",
			"Mary Somerville",
			"Olga Taussky-Todd",
		];
		for (const name of others) {
			claimed(await claimAs(ledger, userId, category, "Claude", name));
			semantic.setSimilarity(name, "Ada Lovelace", 0.95);
		}
		semantic.setSimilarity("Emmy Noether", "Ada Lovelace", 0.8);

		const lovelace = possible(await claimAs(ledger, userId, category, "Grok", "Ada Lovelace"));

		expect(lovelace.possible_matches.map((match) => match.entry_id)).toEqual([noether.entry.id]);
		expect(await testStore().listOverlapsForClaim(userId, lovelace.entry.id)).toHaveLength(
			MAX_MATCHES,
		);
	});

	it("checks against the caller's ledger", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Gauss"));

		expect(await ledger.check(userId, { category, name: "gauss", model: "Grok" })).toMatchObject({
			likely_repeat: false,
			matches: [],
		});
		expect(
			(await ledger.check(userId, { category, name: "gauss", model: "claude" })).likely_repeat,
		).toBe(true);
	});

	it("gives a skip's hit the model of the claim it aliases", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await separateUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Grok", "Ibn al-Haytham"));
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const alhazen = possible(
			await claimAs(ledger, userId, category, "Grok", "Alhazen", { model_version: "Grok 4" }),
		);

		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });

		expect(await hitModels(haytham.entry.id)).toEqual({ model: "Grok", model_version: "Grok 4" });
	});

	it("blocks a phrasing the caller skipped onto another model's topic, after sharing is turned off", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const alhazen = possible(await claimAs(ledger, userId, category, "Grok", "Alhazen"));
		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });
		await testStore().setShareLedger(userId, false);

		const again = repeated(await claimAs(ledger, userId, category, "Grok", "alhazen"));

		expect(again.matches[0]).toMatchObject({
			entry_id: haytham.entry.id,
			kind: "exact",
			via_alias: "Alhazen",
		});
		expect(await latestHitModel(haytham.entry.id)).toEqual({ model: "Grok" });
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});

	it("blocks the original's owner when another model's alias of its topic matches", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const alhazen = possible(await claimAs(ledger, userId, category, "Grok", "Alhazen"));
		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });
		await testStore().setShareLedger(userId, false);

		const again = repeated(await claimAs(ledger, userId, category, "Claude", "alhazen"));

		expect(again.matches[0]).toMatchObject({ entry_id: haytham.entry.id });
		expect(await testStore().listOverlaps(userId, 10)).toEqual([]);
	});

	it("does not record an overlap on an original the caller also reaches through its own alias", async () => {
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const userId = await seedUser();
		const category = uniqueCategory();
		const haytham = claimed(await claimAs(ledger, userId, category, "Claude", "Ibn al-Haytham"));
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const alhazen = possible(await claimAs(ledger, userId, category, "Grok", "Alhazen"));
		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });
		await testStore().setShareLedger(userId, false);
		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);
		semantic.setSimilarity("Ibn al-Haytham", "Father of optics", 0.8);

		const optics = possible(await claimAs(ledger, userId, category, "Grok", "Father of optics"));

		expect(optics.possible_matches).toHaveLength(1);
		expect(optics.possible_matches[0]).toMatchObject({
			entry_id: haytham.entry.id,
			via_alias: "Alhazen",
		});
		const nearMisses = await testStore().listNearMissesForClaim(userId, optics.entry.id);
		expect(nearMisses).toHaveLength(1);
		expect(nearMisses[0]).toMatchObject({ matched_entry_id: haytham.entry.id });
		expect(await testStore().listOverlapsForClaim(userId, optics.entry.id)).toEqual([]);
	});

	it("records overlaps for a forced claim", async () => {
		const ledger = makeTestLedger();
		const userId = await separateUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Grok", "Srinivasa Ramanujan"));
		const ramanujam = claimed(
			await claimAs(ledger, userId, category, "Claude", "Srinivasa Ramanujam"),
		);

		const forced = claimed(
			await claimAs(ledger, userId, category, "Grok", "srinivasa ramanujam", { force: true }),
		);

		expect(forced.forced).toBe(true);
		expect(await testStore().listOverlapsForClaim(userId, forced.entry.id)).toMatchObject([
			{ matched_entry_id: ramanujam.entry.id, match_kind: "exact" },
		]);
	});
});

describe("list and stats filters", () => {
	it("filter by model case-insensitively, including unattributed topics only without a filter", async () => {
		const ledger = makeTestLedger();
		const userId = await seedUser();
		const category = uniqueCategory();
		claimed(await claimAs(ledger, userId, category, "Claude", "Hilbert"));
		claimed(await claimAs(ledger, userId, category, "Grok", "Cantor"));
		claimed(await ledger.claim(userId, { category, name: "Riemann", force: false }));
		expect((await claimAs(ledger, userId, category, "Claude", "hilbert")).status).toBe("repeat");

		const grokList = await ledger.list(userId, { category, limit: 20, model: "grok" });
		expect(grokList.entries.map((entry) => entry.display_name)).toEqual(["Cantor"]);
		expect((await ledger.list(userId, { category, limit: 20 })).entries).toHaveLength(3);
		const stats = (model: string) =>
			ledger.stats(userId, { scope: "me", category, limit: 20, model }, 2);
		expect((await stats("GROK")).repeats).toEqual([]);
		expect((await stats("claude")).repeats).toMatchObject([
			{ display_name: "Hilbert", hit_count: 1 },
		]);
	});
});
