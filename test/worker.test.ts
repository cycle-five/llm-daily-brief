import {
	createExecutionContext,
	createScheduledController,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaimResult, ListResult } from "../src/api/schemas";
import worker, { providerOptions } from "../src/index";
import {
	createTestToken,
	issueOAuthTokens,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

function authed(token: string, init: RequestInit = {}): RequestInit {
	return { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } };
}

describe("provider options", () => {
	it("uses one-hour access tokens and explicitly non-expiring refresh tokens and client registrations", () => {
		expect(providerOptions.accessTokenTTL).toBe(3600);
		expect(Object.hasOwn(providerOptions, "refreshTokenTTL")).toBe(true);
		expect(providerOptions.refreshTokenTTL).toBeUndefined();
		expect(Object.hasOwn(providerOptions, "clientRegistrationTTL")).toBe(true);
		expect(providerOptions.clientRegistrationTTL).toBeUndefined();
	});

	it("advertises dynamic client registration for MCP clients", async () => {
		const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
		expect(res.status).toBe(200);
		const metadata = z
			.object({ registration_endpoint: z.string(), token_endpoint: z.string() })
			.parse(await res.json());
		expect(metadata.registration_endpoint).toBe(`${ORIGIN}/register`);
	});
});

describe("API authentication", () => {
	it("rejects requests without a token or with an unknown ldg_ token", async () => {
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`)).status).toBe(401);
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed("ldg_unknown"))).status).toBe(401);
	});

	it("accepts a personal token end to end", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId);
		const category = uniqueCategory();

		const claim = await SELF.fetch(
			`${ORIGIN}/api/v1/claims`,
			authed(token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ category, name: "Euler's Identity" }),
			}),
		);
		expect(claim.status).toBe(200);
		// wrangler.test.jsonc has no AI/VECTORS bindings.
		expect(ClaimResult.parse(await claim.json())).toMatchObject({
			status: "claimed",
			semantic: "unavailable",
		});

		const list = await SELF.fetch(`${ORIGIN}/api/v1/entries?category=${category}`, authed(token));
		expect(ListResult.parse(await list.json()).entries).toHaveLength(1);
	});

	it("stops accepting a revoked personal token", async () => {
		const userId = await seedUser();
		const token = await createTestToken(userId);
		const [row] = await testStore().listTokens(userId);
		if (!row) throw new Error("expected a token row");
		await testStore().revokeToken(userId, row.id, Date.now());

		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed(token))).status).toBe(401);
	});

	it("accepts an OAuth access token and issues a refresh token", async () => {
		const userId = await seedUser();
		const { accessToken, refreshToken } = await issueOAuthTokens(userId);

		expect(refreshToken).toBeTypeOf("string");
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed(accessToken));
		expect(res.status).toBe(200);
		expect(ListResult.parse(await res.json()).entries).toEqual([]);
	});

	it("rejects an OAuth access token whose user was deleted", async () => {
		const userId = await seedUser();
		const { accessToken } = await issueOAuthTokens(userId);
		await testStore().deleteUser(userId);

		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, authed(accessToken))).status).toBe(401);
	});
});

describe("scheduled handler", () => {
	it("runs backfill and KV purge without throwing", async () => {
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);
	});
});
