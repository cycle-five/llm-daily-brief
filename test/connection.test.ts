import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { once } from "../src/api/connection";
import { ClaimResult } from "../src/api/schemas";
import {
	createTestToken,
	issueOAuthTokens,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

async function claimOverRest(token: string, body: Record<string, unknown>) {
	const res = await SELF.fetch(`${ORIGIN}/api/v1/claims`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	const result = ClaimResult.parse(await res.json());
	if (result.status !== "claimed") throw new Error(`expected claimed, got ${result.status}`);
	return result;
}

describe("connection name", () => {
	it("is a personal token's label, which also stands in for an undeclared model", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId); // labelled "test"
		const category = uniqueCategory();

		const defaulted = await claimOverRest(token, { category, name: "Hilbert" });
		const declared = await claimOverRest(token, {
			category,
			name: "Cantor",
			model: "Claude",
			model_version: "Opus 5",
		});

		expect(await testStore().getEntry(userId, defaulted.entry.id)).toMatchObject({
			model: "test",
			model_version: null,
			client: "test",
		});
		expect(await testStore().getEntry(userId, declared.entry.id)).toMatchObject({
			model: "Claude",
			model_version: "Opus 5",
			client: "test",
		});
	});

	it("is the OAuth client's registered name for an access token", async () => {
		const userId = await seedUser();
		const { accessToken } = await issueOAuthTokens(userId); // client "Test Client"

		const result = await claimOverRest(accessToken, {
			category: uniqueCategory(),
			name: "Noether",
		});

		expect(await testStore().getEntry(userId, result.entry.id)).toMatchObject({
			model: "Test Client",
			client: "Test Client",
		});
	});
});

describe("once", () => {
	it("computes on first use only", async () => {
		let calls = 0;
		const value = once(async () => {
			calls += 1;
			return "name";
		});
		expect(calls).toBe(0);
		expect(await value()).toBe("name");
		expect(await value()).toBe("name");
		expect(calls).toBe(1);
	});
});
