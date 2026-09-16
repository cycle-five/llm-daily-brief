import { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "./encoding";

export const SESSION_COOKIE = "__Host-ledger_session";
export const APPROVED_COOKIE = "__Host-ledger_approved";
export const STATE_COOKIE = "__Host-ledger_state";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signValue(payload: string, secret: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(secret),
		encoder.encode(payload),
	);
	return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyValue(signed: string, secret: string): Promise<string | null> {
	const separator = signed.lastIndexOf(".");
	if (separator <= 0) return null;
	const payload = signed.slice(0, separator);
	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(signed.slice(separator + 1));
	} catch {
		return null;
	}
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		signature,
		encoder.encode(payload),
	);
	return valid ? payload : null;
}

export function createSession(userId: string, now: number, secret: string): Promise<string> {
	return signValue(`${userId}.${now + SESSION_TTL_SECONDS * 1000}`, secret);
}

export async function readSession(
	value: string | undefined,
	now: number,
	secret: string,
): Promise<string | null> {
	if (!value) return null;
	const payload = await verifyValue(value, secret);
	if (!payload) return null;
	const separator = payload.lastIndexOf(".");
	const userId = payload.slice(0, separator);
	const expiresAt = Number(payload.slice(separator + 1));
	if (separator <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
	return userId;
}

/**
 * Domain separation from sessions (`userId.expiresAt`): a session payload never starts with this
 * prefix, so it cannot decode as approved clients; and an approved payload's text after its last
 * dot is base64url JSON (never numeric), so it cannot read as a session.
 */
const APPROVED_PREFIX = "approved.";
const ApprovedClients = z.object({ userId: z.string(), clientIds: z.array(z.string()) });
type ApprovedClients = z.infer<typeof ApprovedClients>;

/** Remembered consent is bound to the user who gave it, so it never carries over to another sign-in. */
export function encodeApprovedClients(
	userId: string,
	clientIds: readonly string[],
	secret: string,
): Promise<string> {
	const payload: ApprovedClients = { userId, clientIds: [...clientIds] };
	return signValue(
		`${APPROVED_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`,
		secret,
	);
}

export async function decodeApprovedClients(
	value: string | undefined,
	userId: string,
	secret: string,
): Promise<string[]> {
	if (!value) return [];
	const payload = await verifyValue(value, secret);
	if (!payload?.startsWith(APPROVED_PREFIX)) return [];
	let json: unknown;
	try {
		json = JSON.parse(
			new TextDecoder().decode(base64UrlDecode(payload.slice(APPROVED_PREFIX.length))),
		);
	} catch {
		return [];
	}
	const parsed = ApprovedClients.safeParse(json);
	return parsed.success && parsed.data.userId === userId ? parsed.data.clientIds : [];
}
