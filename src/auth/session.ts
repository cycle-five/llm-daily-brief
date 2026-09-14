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

const ClientIds = z.array(z.string());

export function encodeApprovedClients(
	clientIds: readonly string[],
	secret: string,
): Promise<string> {
	return signValue(base64UrlEncode(encoder.encode(JSON.stringify(clientIds))), secret);
}

export async function decodeApprovedClients(
	value: string | undefined,
	secret: string,
): Promise<string[]> {
	if (!value) return [];
	const payload = await verifyValue(value, secret);
	if (!payload) return [];
	try {
		return ClientIds.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))));
	} catch {
		return [];
	}
}
