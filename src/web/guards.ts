import type { Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { readSession, SESSION_COOKIE } from "../auth/session";
import type { FetchFn } from "../auth/upstream";
import type { Env } from "../env";
import { LedgerStore } from "../store/d1";

export type WebEnv = { Bindings: Env };

export interface WebDeps {
	fetchFn: FetchFn;
	now: () => number;
}

export function isSameOrigin(c: Context<WebEnv>): boolean {
	return c.req.header("origin") === c.env.PUBLIC_ORIGIN;
}

export function sessionUserId(c: Context<WebEnv>, now: number): Promise<string | null> {
	return readSession(getCookie(c, SESSION_COOKIE), now, c.env.COOKIE_SECRET);
}

/**
 * Sessions are stateless HMAC cookies and cannot be revoked, so a session cookie can outlive the
 * user row it names (e.g. after /account/delete on another device). Every entry point that acts
 * for the session's user — dashboard pages and actions, and the OAuth authorize/approve routes —
 * must confirm the user still exists before running handler code against it; this is the one place
 * that check happens.
 */
export async function currentUserId(c: Context<WebEnv>, deps: WebDeps): Promise<string | null> {
	const userId = await sessionUserId(c, deps.now());
	if (userId === null) return null;
	if (await new LedgerStore(c.env.DB).getUser(userId)) return userId;
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
	return null;
}

export function cookieOptions(maxAgeSeconds: number): CookieOptions {
	return { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: maxAgeSeconds };
}
