import type { TokenRow } from "../core/rows";
import type { LedgerStore } from "../store/d1";
import { base64UrlEncode } from "./encoding";

export const TOKEN_PREFIX = "ldg_";
/** last_used_at is written at most this often per token. */
export const TOUCH_INTERVAL_MS = 3_600_000;

export function generateToken(): string {
	return `${TOKEN_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashToken(token: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	);
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPersonalToken(
	store: LedgerStore,
	userId: string,
	label: string,
	now: number,
	newId: () => string,
): Promise<{ token: string; row: TokenRow }> {
	const token = generateToken();
	const row: TokenRow = {
		id: newId(),
		user_id: userId,
		token_hash: await hashToken(token),
		label,
		created_at: now,
		last_used_at: null,
		revoked_at: null,
	};
	await store.insertToken(row);
	return { token, row };
}

export async function resolvePersonalToken(
	store: LedgerStore,
	token: string,
	now: number,
): Promise<{ userId: string } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const row = await store.findActiveTokenByHash(await hashToken(token));
	if (!row) return null;
	if (row.last_used_at === null || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
		await store.touchToken(row.id, now);
	}
	return { userId: row.user_id };
}
