import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../src/auth/encoding";
import {
	createSession,
	decodeApprovedClients,
	encodeApprovedClients,
	readSession,
	SESSION_TTL_SECONDS,
	signValue,
	verifyValue,
} from "../src/auth/session";

const secret = "unit-test-secret";

describe("signed values", () => {
	it("verifies its own signature and rejects tampering or another secret", async () => {
		const signed = await signValue("payload.with.dots", secret);
		expect(await verifyValue(signed, secret)).toBe("payload.with.dots");
		expect(await verifyValue(signed.replace("payload", "paylaod"), secret)).toBeNull();
		expect(await verifyValue(signed, "other-secret")).toBeNull();
		expect(await verifyValue("no-signature", secret)).toBeNull();
	});
});

describe("sessions", () => {
	it("round-trips a user id until expiry", async () => {
		const cookie = await createSession("user-1", 1_000, secret);
		expect(await readSession(cookie, 2_000, secret)).toBe("user-1");
		expect(await readSession(cookie, 1_000 + SESSION_TTL_SECONDS * 1000, secret)).toBeNull();
		expect(await readSession(undefined, 2_000, secret)).toBeNull();
	});
});

describe("approved clients", () => {
	it("round-trips client ids for the same user and ignores other users or tampered cookies", async () => {
		const cookie = await encodeApprovedClients("user-1", ["client-a", "client.b"], secret);
		expect(await decodeApprovedClients(cookie, "user-1", secret)).toEqual(["client-a", "client.b"]);
		expect(await decodeApprovedClients(cookie, "user-2", secret)).toEqual([]);
		expect(await decodeApprovedClients(`x${cookie}`, "user-1", secret)).toEqual([]);
		expect(await decodeApprovedClients(undefined, "user-1", secret)).toEqual([]);
	});

	it("requires the approved. prefix on a correctly signed payload", async () => {
		const unprefixed = await signValue(
			base64UrlEncode(
				new TextEncoder().encode(JSON.stringify({ userId: "user-1", clientIds: ["client-a"] })),
			),
			secret,
		);
		expect(await decodeApprovedClients(unprefixed, "user-1", secret)).toEqual([]);
	});

	it("never reads an approved-clients cookie as a session, or a session as approved clients", async () => {
		const approved = await encodeApprovedClients("user-1", ["client-a"], secret);
		expect(await readSession(approved, 2_000, secret)).toBeNull();
		const session = await createSession("user-1", 1_000, secret);
		expect(await decodeApprovedClients(session, "user-1", secret)).toEqual([]);
	});
});
