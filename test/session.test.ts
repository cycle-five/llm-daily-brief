import { describe, expect, it } from "vitest";
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
	it("round-trips client ids and ignores tampered cookies", async () => {
		const cookie = await encodeApprovedClients(["client-a", "client.b"], secret);
		expect(await decodeApprovedClients(cookie, secret)).toEqual(["client-a", "client.b"]);
		expect(await decodeApprovedClients(`x${cookie}`, secret)).toEqual([]);
		expect(await decodeApprovedClients(undefined, secret)).toEqual([]);
	});
});
