import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../src/auth/encoding";
import {
	createPersonalToken,
	generateToken,
	hashToken,
	resolvePersonalToken,
	TOUCH_INTERVAL_MS,
} from "../src/auth/tokens";
import { seedUser, testStore } from "./helpers";

describe("encoding", () => {
	it("round-trips bytes through base64url without padding", () => {
		const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
		expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
	});
});

describe("personal tokens", () => {
	it("generates ldg_ tokens carrying 32 random bytes", () => {
		const token = generateToken();
		expect(token).toMatch(/^ldg_[A-Za-z0-9_-]{43}$/);
		expect(generateToken()).not.toBe(token);
	});

	it("hashes deterministically to 64 hex characters", async () => {
		expect(await hashToken("ldg_abc")).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashToken("ldg_abc")).toBe(await hashToken("ldg_abc"));
	});

	it("resolves active tokens, ignores other prefixes, and throttles last_used_at writes", async () => {
		const store = testStore();
		const userId = await seedUser();
		const { token, row } = await createPersonalToken(store, userId, "cron", 1_000, () =>
			crypto.randomUUID(),
		);
		expect(row.token_hash).toBe(await hashToken(token));

		expect(await resolvePersonalToken(store, "not-a-ledger-token", 2_000)).toBeNull();
		expect(await resolvePersonalToken(store, token, 2_000)).toEqual({ userId, client: "cron" });
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000);

		await resolvePersonalToken(store, token, 2_000 + TOUCH_INTERVAL_MS - 1);
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000);

		await resolvePersonalToken(store, token, 2_000 + TOUCH_INTERVAL_MS);
		expect((await store.listTokens(userId))[0]?.last_used_at).toBe(2_000 + TOUCH_INTERVAL_MS);

		await store.revokeToken(userId, row.id, 5_000);
		expect(await resolvePersonalToken(store, token, 6_000)).toBeNull();
	});
});
