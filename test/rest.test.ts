import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiContext } from "../src/api/context";
import { createRestApp } from "../src/api/rest";
import {
	CheckResult,
	ClaimResult,
	ErrorBody,
	KeepResult,
	ListResult,
	SkipResult,
	StatsResult,
} from "../src/api/schemas";
import { FakeSemanticIndex } from "./fakes/semantic";
import { makeTestLedger, seedUser, testStore, uniqueCategory } from "./helpers";

async function context(overrides: Partial<ApiContext> = {}): Promise<ApiContext> {
	return {
		userId: await seedUser(),
		ledger: makeTestLedger(),
		limiter: env.CLAIM_LIMITER,
		globalMinUsers: 2,
		connectionName: async () => "cron",
		...overrides,
	};
}

async function post(path: string, body: unknown, ctx: ApiContext): Promise<Response> {
	return createRestApp().request(
		path,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		ctx,
	);
}

describe("POST /api/v1/claims", () => {
	it("claims, then reports a repeat", async () => {
		const ctx = await context();
		const category = uniqueCategory();

		const first = await post("/api/v1/claims", { category, name: "Euler's Identity" }, ctx);
		expect(first.status).toBe(200);
		expect(ClaimResult.parse(await first.json()).status).toBe("claimed");

		const second = await post("/api/v1/claims", { category, name: "euler identity" }, ctx);
		expect(ClaimResult.parse(await second.json()).status).toBe("repeat");
	});

	it("rejects invalid input with a typed error body", async () => {
		const ctx = await context();
		const res = await post("/api/v1/claims", { name: "No category" }, ctx);
		expect(res.status).toBe(400);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("invalid_input");
	});

	it("rejects a non-JSON body", async () => {
		const ctx = await context();
		const res = await createRestApp().request(
			"/api/v1/claims",
			{ method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
			ctx,
		);
		expect(res.status).toBe(400);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("invalid_input");
	});

	it("returns 429 when the rate limiter refuses", async () => {
		const ctx = await context({ limiter: { limit: async () => ({ success: false }) } });
		const res = await post("/api/v1/claims", { category: uniqueCategory(), name: "Gauss" }, ctx);
		expect(res.status).toBe(429);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("rate_limited");
	});

	it("maps unexpected errors to 503 upstream_unavailable", async () => {
		const ctx = await context({
			limiter: {
				limit: async () => {
					throw new Error("boom");
				},
			},
		});
		const res = await post("/api/v1/claims", { category: uniqueCategory(), name: "Gauss" }, ctx);
		expect(res.status).toBe(503);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("upstream_unavailable");
	});
});

describe("POST /api/v1/checks", () => {
	it("reports likely repeats", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Noether" }, ctx);

		const res = await post("/api/v1/checks", { category, name: "NOETHER" }, ctx);

		expect(res.status).toBe(200);
		expect(CheckResult.parse(await res.json()).likely_repeat).toBe(true);
	});
});

describe("entries", () => {
	it("lists with a coerced limit, rejects a bad limit, and deletes", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		const claimed = ClaimResult.parse(
			await (await post("/api/v1/claims", { category, name: "Hilbert" }, ctx)).json(),
		);
		await post("/api/v1/claims", { category, name: "Cantor" }, ctx);
		if (claimed.status !== "claimed") throw new Error("expected claimed");

		const listed = await createRestApp().request(
			`/api/v1/entries?category=${category}&limit=1`,
			{},
			ctx,
		);
		expect(ListResult.parse(await listed.json()).entries).toHaveLength(1);

		const bad = await createRestApp().request("/api/v1/entries?limit=abc", {}, ctx);
		expect(bad.status).toBe(400);

		const del = await createRestApp().request(
			`/api/v1/entries/${claimed.entry.id}`,
			{ method: "DELETE" },
			ctx,
		);
		expect(del.status).toBe(204);

		const again = await createRestApp().request(
			`/api/v1/entries/${claimed.entry.id}`,
			{ method: "DELETE" },
			ctx,
		);
		expect(again.status).toBe(404);
		expect(ErrorBody.parse(await again.json()).error.code).toBe("not_found");
	});
});

describe("GET /api/v1/stats", () => {
	it("returns the caller's repeats", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Gauss" }, ctx);
		await post("/api/v1/claims", { category, name: "gauss" }, ctx);

		const res = await createRestApp().request(
			`/api/v1/stats?scope=me&category=${category}`,
			{},
			ctx,
		);

		expect(StatsResult.parse(await res.json()).repeats).toMatchObject([
			{ display_name: "Gauss", hit_count: 1 },
		]);
	});
});

describe("unknown routes", () => {
	it("return a typed 404", async () => {
		const res = await createRestApp().request("/api/v1/nope", {}, await context());
		expect(res.status).toBe(404);
		expect(ErrorBody.parse(await res.json()).error.code).toBe("not_found");
	});
});

describe("verdicts", () => {
	async function claim(ctx: ApiContext, category: string, name: string) {
		return ClaimResult.parse(await (await post("/api/v1/claims", { category, name }, ctx)).json());
	}

	it("skips one possible repeat and keeps another", async () => {
		const semantic = new FakeSemanticIndex();
		const ctx = await context({ ledger: makeTestLedger({ semantic }) });
		const category = uniqueCategory();
		const original = await claim(ctx, category, "Ibn al-Haytham");
		if (original.status !== "claimed") throw new Error("expected claimed");
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		semantic.setSimilarity("Ibn al-Haytham", "Omar Khayyam", 0.81);

		const alhazen = await claim(ctx, category, "Alhazen");
		if (alhazen.status !== "possible_repeat") throw new Error("expected possible_repeat");
		const skipped = await post(
			`/api/v1/entries/${alhazen.entry.id}/skip`,
			{ repeat_of: original.entry.id, note: "same person" },
			ctx,
		);
		expect(skipped.status).toBe(200);
		expect(SkipResult.parse(await skipped.json())).toMatchObject({
			skipped: alhazen.entry.id,
			alias_of: { entry_id: original.entry.id, hit_count: 1 },
		});

		const khayyam = await claim(ctx, category, "Omar Khayyam");
		if (khayyam.status !== "possible_repeat") throw new Error("expected possible_repeat");
		const kept = await post(
			`/api/v1/entries/${khayyam.entry.id}/keep`,
			{ note: "different people" },
			ctx,
		);
		expect(kept.status).toBe(200);
		expect(KeepResult.parse(await kept.json())).toEqual({ kept: khayyam.entry.id, distinct: 1 });
	});

	it("validates bodies and maps verdict errors", async () => {
		const ctx = await context();

		const missing = await post(
			`/api/v1/entries/${crypto.randomUUID()}/skip`,
			{ note: "no repeat_of" },
			ctx,
		);
		expect(missing.status).toBe(400);
		expect(ErrorBody.parse(await missing.json()).error.code).toBe("invalid_input");

		const blankNote = await post(`/api/v1/entries/${crypto.randomUUID()}/keep`, { note: " " }, ctx);
		expect(blankNote.status).toBe(400);

		const unknown = await post(`/api/v1/entries/${crypto.randomUUID()}/keep`, {}, ctx);
		expect(unknown.status).toBe(404);
		expect(ErrorBody.parse(await unknown.json()).error.code).toBe("not_found");

		const plain = await claim(ctx, uniqueCategory(), "Hilbert");
		if (plain.status !== "claimed") throw new Error("expected claimed");
		const nothingPending = await post(`/api/v1/entries/${plain.entry.id}/keep`, {}, ctx);
		expect(nothingPending.status).toBe(400);
		expect(ErrorBody.parse(await nothingPending.json()).error.code).toBe("invalid_input");
	});
});

describe("models over REST", () => {
	it("defaults the model to the connection name, and an explicit model wins", async () => {
		const ctx = await context();
		const category = uniqueCategory();

		const defaulted = ClaimResult.parse(
			await (await post("/api/v1/claims", { category, name: "Hilbert" }, ctx)).json(),
		);
		const declared = ClaimResult.parse(
			await (
				await post("/api/v1/claims", { category, name: "Cantor", model: "Claude" }, ctx)
			).json(),
		);

		if (defaulted.status !== "claimed" || declared.status !== "claimed") {
			throw new Error("expected claimed");
		}
		expect(defaulted.entry.model).toBe("cron");
		expect(declared.entry.model).toBe("Claude");
		expect(await testStore().getEntry(ctx.userId, declared.entry.id)).toMatchObject({
			client: "cron",
		});
	});

	it("checks against the connection's ledger when no model is given", async () => {
		const ctx = await context();
		await testStore().setShareLedger(ctx.userId, false);
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Gauss", model: "Claude" }, ctx);

		const check = async (body: Record<string, unknown>) =>
			CheckResult.parse(await (await post("/api/v1/checks", { category, ...body }, ctx)).json());

		expect((await check({ name: "gauss" })).likely_repeat).toBe(false);
		expect((await check({ name: "gauss", model: "claude" })).likely_repeat).toBe(true);
	});

	it("filters entries and stats by model", async () => {
		const ctx = await context();
		const category = uniqueCategory();
		await post("/api/v1/claims", { category, name: "Hilbert", model: "Claude" }, ctx);
		await post("/api/v1/claims", { category, name: "Cantor", model: "Grok" }, ctx);
		await post("/api/v1/claims", { category, name: "hilbert", model: "Claude" }, ctx);

		const listed = ListResult.parse(
			await (
				await createRestApp().request(`/api/v1/entries?category=${category}&model=grok`, {}, ctx)
			).json(),
		);
		expect(listed.entries.map((entry) => entry.display_name)).toEqual(["Cantor"]);
		const stats = StatsResult.parse(
			await (
				await createRestApp().request(
					`/api/v1/stats?scope=me&category=${category}&model=GROK`,
					{},
					ctx,
				)
			).json(),
		);
		expect(stats.repeats).toEqual([]);
	});
});
