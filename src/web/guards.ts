import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { readSession, SESSION_COOKIE } from "../auth/session";
import type { FetchFn } from "../auth/upstream";
import type { Env } from "../env";

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

export function cookieOptions(maxAgeSeconds: number): CookieOptions {
	return { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: maxAgeSeconds };
}
