import { env } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import {
	APPROVED_COOKIE,
	createSession,
	encodeApprovedClients,
	SESSION_COOKIE,
	STATE_COOKIE,
} from "../src/auth/session";
import type { FetchFn } from "../src/auth/upstream";
import { providerOptions } from "../src/index";
import { createWebApp } from "../src/web/app";
import { ORIGIN, seedUser, testStore } from "./helpers";

const CLIENT_REDIRECT = "https://client.test/callback";

function webEnv() {
	return { ...env, OAUTH_PROVIDER: getOAuthApi(providerOptions, env) };
}

function cookiesFrom(response: Response): Map<string, string> {
	const out = new Map<string, string>();
	for (const header of response.headers.getSetCookie()) {
		const [pair] = header.split(";");
		const eq = pair?.indexOf("=") ?? -1;
		if (pair && eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
	return out;
}

function cookieHeader(cookies: Record<string, string | undefined>): string {
	return Object.entries(cookies)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function fakeUpstream(): FetchFn {
	const githubId = Math.floor(Math.random() * 1_000_000_000);
	const googleSub = `g-${crypto.randomUUID()}`;
	return async (input, init) => {
		switch (input) {
			case "https://github.com/login/oauth/access_token": {
				const code = new URLSearchParams(String(init?.body)).get("code");
				return Response.json(
					code === "good" ? { access_token: "gh" } : { error: "bad_verification_code" },
				);
			}
			case "https://api.github.com/user":
				return Response.json({ id: githubId, login: "octo", name: "Octo", email: null });
			case "https://oauth2.googleapis.com/token":
				return Response.json({ access_token: "g" });
			case "https://openidconnect.googleapis.com/v1/userinfo":
				return Response.json({ sub: googleSub, name: "Grace" });
			default:
				return new Response("unexpected upstream call", { status: 500 });
		}
	};
}

async function startAuthorization(app: ReturnType<typeof createWebApp>, cookies = "") {
	const api = getOAuthApi(providerOptions, env);
	const client = await api.createClient({
		redirectUris: [CLIENT_REDIRECT],
		clientName: "Claude",
		tokenEndpointAuthMethod: "none",
	});
	const url = new URL(`${ORIGIN}/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: client.clientId,
		redirect_uri: CLIENT_REDIRECT,
		state: "client-state",
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
	}).toString();
	const response = await app.request(url.toString(), { headers: { cookie: cookies } }, webEnv());
	return { client, response, url };
}

describe("MCP client authorization via GitHub", () => {
	it("shows consent, signs in upstream, and redirects back with a code; returning users skip consent", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });

		const { response: consent, url } = await startAuthorization(app);
		expect(consent.status).toBe(200);
		const html = await consent.text();
		expect(html).toContain("Claude");
		expect(html).toContain("Continue with GitHub");
		const state = cookiesFrom(consent).get(STATE_COOKIE);
		expect(state).toBeTypeOf("string");

		const approve = await app.request(
			`${ORIGIN}/authorize/approve`,
			{
				method: "POST",
				headers: { origin: ORIGIN, cookie: cookieHeader({ [STATE_COOKIE]: state }) },
				body: new URLSearchParams({ state: state ?? "", provider: "github" }),
			},
			webEnv(),
		);
		expect(approve.status).toBe(302);
		const upstream = new URL(approve.headers.get("location") ?? "");
		expect(upstream.origin).toBe("https://github.com");
		expect(upstream.searchParams.get("state")).toBe(state);

		const callback = await app.request(
			`${ORIGIN}/callback/github?code=good&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(302);
		const back = new URL(callback.headers.get("location") ?? "");
		expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("code")).toBeTruthy();
		expect(back.searchParams.get("state")).toBe("client-state");
		const issued = cookiesFrom(callback);
		expect(issued.get(SESSION_COOKIE)).toBeTypeOf("string");
		expect(issued.get(APPROVED_COOKIE)).toBeTypeOf("string");

		// Same browser, same client: straight back to the client.
		const again = await app.request(
			url.toString(),
			{
				headers: {
					cookie: cookieHeader({
						[SESSION_COOKIE]: issued.get(SESSION_COOKIE),
						[APPROVED_COOKIE]: issued.get(APPROVED_COOKIE),
					}),
				},
			},
			webEnv(),
		);
		expect(again.status).toBe(302);
		expect(again.headers.get("location")).toContain(CLIENT_REDIRECT);
	});

	it("rejects approval without a matching state cookie or same-origin header", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const { response } = await startAuthorization(app);
		const state = cookiesFrom(response).get(STATE_COOKIE) ?? "";
		const body = () => new URLSearchParams({ state, provider: "github" });

		const crossSite = await app.request(
			`${ORIGIN}/authorize/approve`,
			{
				method: "POST",
				headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) },
				body: body(),
			},
			webEnv(),
		);
		expect(crossSite.status).toBe(403);

		const wrongState = await app.request(
			`${ORIGIN}/authorize/approve`,
			{
				method: "POST",
				headers: { origin: ORIGIN, cookie: cookieHeader({ [STATE_COOKIE]: "other" }) },
				body: body(),
			},
			webEnv(),
		);
		expect(wrongState.status).toBe(400);
	});

	it("shows an error page when the upstream rejects the code", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const login = await app.request(`${ORIGIN}/login/github`, {}, webEnv());
		const state = cookiesFrom(login).get(STATE_COOKIE);
		const callback = await app.request(
			`${ORIGIN}/callback/github?code=bad&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(502);
	});
});

describe("sessions for deleted accounts", () => {
	it("shows consent instead of granting when the session's user no longer exists", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const userId = await seedUser();
		const session = await createSession(userId, Date.now(), env.COOKIE_SECRET);
		await testStore().deleteUser(userId);
		const { client, url } = await startAuthorization(app);
		const approved = await encodeApprovedClients([client.clientId], env.COOKIE_SECRET);

		const response = await app.request(
			url.toString(),
			{
				headers: {
					cookie: cookieHeader({ [SESSION_COOKIE]: session, [APPROVED_COOKIE]: approved }),
				},
			},
			webEnv(),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Continue with GitHub");
		expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(
			true,
		);
	});
});

describe("authorization request errors", () => {
	it("returns 400 without leaking internals for an unregistered client", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const url = new URL(`${ORIGIN}/authorize`);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: "no-such-client",
			redirect_uri: CLIENT_REDIRECT,
			state: "client-state",
		}).toString();
		const response = await app.request(url.toString(), {}, webEnv());
		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).not.toContain("Error:");
		expect(body).not.toContain("AuthorizationError");
	});

	it("redirects a request rejected after redirect-URI validation back to the client", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const api = getOAuthApi(providerOptions, env);
		const client = await api.createClient({
			redirectUris: [CLIENT_REDIRECT],
			clientName: "Claude",
			tokenEndpointAuthMethod: "none",
		});
		const url = new URL(`${ORIGIN}/authorize`);
		// A public client without a PKCE code_challenge is rejected only after the
		// redirect URI has already been validated against the registered client.
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: client.clientId,
			redirect_uri: CLIENT_REDIRECT,
			state: "client-state",
		}).toString();
		const response = await app.request(url.toString(), {}, webEnv());
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
		expect(location.searchParams.get("error")).toBeTruthy();
		expect(location.searchParams.get("error_description")).toBeTruthy();
		expect(location.searchParams.get("state")).toBe("client-state");
	});
});

describe("dashboard sign-in via Google", () => {
	it("redirects to Google, then to /ledger with a session", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		const login = await app.request(`${ORIGIN}/login/google`, {}, webEnv());
		expect(login.status).toBe(302);
		expect(new URL(login.headers.get("location") ?? "").origin).toBe("https://accounts.google.com");
		const state = cookiesFrom(login).get(STATE_COOKIE);

		const callback = await app.request(
			`${ORIGIN}/callback/google?code=any&state=${state}`,
			{ headers: { cookie: cookieHeader({ [STATE_COOKIE]: state }) } },
			webEnv(),
		);
		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("/ledger");
		expect(cookiesFrom(callback).get(SESSION_COOKIE)).toBeTypeOf("string");
	});

	it("returns 404 for an unknown provider", async () => {
		const app = createWebApp({ fetchFn: fakeUpstream(), now: () => Date.now() });
		expect((await app.request(`${ORIGIN}/login/myspace`, {}, webEnv())).status).toBe(404);
	});
});
