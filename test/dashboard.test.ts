import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { providerOptions } from "../src/index";
import { createWebApp } from "../src/web/app";
import { FakeSemanticIndex } from "./fakes/semantic";
import {
	issueOAuthTokens,
	makeTestLedger,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

const app = createWebApp();
const webEnv = () => ({ ...env, OAUTH_PROVIDER: getOAuthApi(providerOptions, env) });

async function sessionCookie(userId: string): Promise<string> {
	return `${SESSION_COOKIE}=${await createSession(userId, Date.now(), env.COOKIE_SECRET)}`;
}

async function get(path: string, cookie = ""): Promise<Response> {
	return app.request(`${ORIGIN}${path}`, { headers: { cookie } }, webEnv());
}

async function post(
	path: string,
	cookie: string,
	form: Record<string, string> = {},
	sameOrigin = true,
): Promise<Response> {
	const headers: Record<string, string> = { cookie };
	if (sameOrigin) headers.origin = ORIGIN;
	return app.request(
		`${ORIGIN}${path}`,
		{ method: "POST", headers, body: new URLSearchParams(form) },
		webEnv(),
	);
}

/** The single <tr> whose claim cell is `claim` and whose matched topic is `matched`. */
function rowFor(html: string, claim: string, matched: string): string {
	const rows = html
		.split("<tr>")
		.filter((row) => row.includes(`<td>${claim}</td>`) && row.includes(matched));
	if (rows.length !== 1) {
		throw new Error(`expected exactly one row for ${claim} / ${matched}, got ${rows.length}`);
	}
	return rows[0] ?? "";
}

describe("landing and session gate", () => {
	it("shows sign-in to visitors, redirects signed-in users, and gates pages", async () => {
		const landing = await get("/");
		expect(landing.status).toBe(200);
		expect(await landing.text()).toContain("Continue with GitHub");

		expect((await get("/ledger")).headers.get("location")).toBe("/");

		const cookie = await sessionCookie(await seedUser());
		expect((await get("/", cookie)).headers.get("location")).toBe("/ledger");
	});

	it("clears the session cookie and redirects when the session's user no longer exists", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		await testStore().deleteUser(userId);

		const ledgerResponse = await get("/ledger", cookie);
		expect(ledgerResponse.headers.get("location")).toBe("/");
		expect(
			ledgerResponse.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`)),
		).toBe(true);

		const tokensResponse = await post("/tokens", cookie, { label: "cron" });
		expect(tokensResponse.headers.get("location")).toBe("/");
		expect(await testStore().listTokens(userId)).toEqual([]);
	});
});

describe("ledger page", () => {
	it("lists topics with escaped names and forgets only same-origin requests", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const category = uniqueCategory();
		const result = await makeTestLedger().claim(userId, {
			category,
			name: "<script>alert(1)</script> Theorem",
			force: false,
		});
		if (result.status !== "claimed") throw new Error("expected claimed");

		const html = await (await get("/ledger", cookie)).text();
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Theorem");
		expect(html).not.toContain("<script>alert(1)</script>");

		expect((await post(`/entries/${result.entry.id}/forget`, cookie, {}, false)).status).toBe(403);
		const forgot = await post(`/entries/${result.entry.id}/forget`, cookie);
		expect(forgot.headers.get("location")).toBe("/ledger");
		expect(await testStore().listEntries(userId, { category, limit: 10 })).toEqual([]);
	});
});

describe("repeats pages", () => {
	it("shows the phrasings that were blocked and renders the global page", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		await ledger.claim(userId, { category, name: "Euler's Identity", force: false });
		await ledger.claim(userId, { category, name: "EULER IDENTITY", force: false });
		await ledger.claim(userId, { category, name: "Srinivasa Ramanujan", force: false });
		await ledger.claim(userId, { category, name: "Srinivasa Ramanujam", force: false });

		const repeats = await (await get("/repeats", cookie)).text();
		expect(repeats).toContain("Euler&#39;s Identity");
		expect(repeats).toContain("EULER IDENTITY");
		expect(repeats).toContain("<details");
		expect(repeats).toContain("exact");
		expect(repeats).toContain("trigram");
		expect(repeats).toContain("1.00");

		const global = await get("/global", cookie);
		expect(global.status).toBe(200);
		expect(await global.text()).toContain("Global repeats");
	});
});

describe("access page", () => {
	it("creates a personal token shown once, which works until revoked", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);

		const created = await post("/tokens", cookie, { label: "cron" });
		expect(created.headers.get("cache-control")).toBe("no-store");
		const tokens = (await created.text()).match(/ldg_[A-Za-z0-9_-]{43}/g) ?? [];
		expect(tokens).toHaveLength(1);
		const token = tokens[0] ?? "";

		const auth = { headers: { authorization: `Bearer ${token}` } };
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, auth)).status).toBe(200);

		const [row] = await testStore().listTokens(userId);
		expect((await post(`/tokens/${row?.id}/revoke`, cookie)).headers.get("location")).toBe(
			"/access",
		);
		expect((await SELF.fetch(`${ORIGIN}/api/v1/entries`, auth)).status).toBe(401);
		expect(await (await get("/access", cookie)).text()).not.toMatch(/ldg_[A-Za-z0-9_-]{43}/);
	});

	it("lists connected OAuth clients and revokes them", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const { accessToken } = await issueOAuthTokens(userId);

		expect(await (await get("/access", cookie)).text()).toContain('action="/grants/');
		const { items } = await getOAuthApi(providerOptions, env).listUserGrants(userId);
		expect(items).toHaveLength(1);

		await post(`/grants/${items[0]?.id}/revoke`, cookie);
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(401);
	});
});

describe("connect page", () => {
	it("shows the MCP URL and the prompt snippet", async () => {
		const html = await (await get("/connect", await sessionCookie(await seedUser()))).text();
		expect(html).toContain(`${ORIGIN}/mcp`);
		expect(html).toContain("claim_topic");
		expect(html).toContain("skip_topic");
		expect(html).toContain("keep_topic");
		expect(html).not.toContain("forget_topic");
	});
});

describe("near misses page", () => {
	it("labels every verdict, shows via aliases, and lists aliases on the ledger", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claim = (name: string) => ledger.claim(userId, { category, name, force: false });

		const haytham = await claim("Ibn al-Haytham");
		if (haytham.status !== "claimed") throw new Error("expected claimed");

		semantic.setSimilarity("Ibn al-Haytham", "Omar Khayyam", 0.81);
		const khayyam = await claim("Omar Khayyam");
		if (khayyam.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.keep(userId, { entry_id: khayyam.entry.id, note: "different people" });

		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		semantic.setSimilarity("Omar Khayyam", "Alhazen", 0.79);
		const alhazen = await claim("Alhazen");
		if (alhazen.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: alhazen.entry.id, repeat_of: haytham.entry.id });

		semantic.setSimilarity("Alhazen", "Father of optics", 0.85);
		const optics = await claim("Father of optics");
		if (optics.status !== "possible_repeat") throw new Error("expected possible_repeat");

		const html = await (await get("/near-misses", cookie)).text();
		expect(html).toContain("via Alhazen");
		expect(html).toContain("different people");
		expect(html).toContain('href="/near-misses"');

		expect(rowFor(html, "Alhazen", "Ibn al-Haytham")).toContain("Repeat — skipped");
		expect(rowFor(html, "Omar Khayyam", "Ibn al-Haytham")).toContain("Different — kept");
		expect(rowFor(html, "Father of optics", "Ibn al-Haytham")).toContain("No verdict — used");
		expect(rowFor(html, "Alhazen", "Omar Khayyam")).toContain("Not judged — claim skipped");

		const ledgerHtml = await (await get("/ledger", cookie)).text();
		expect(ledgerHtml).toContain("also claimed as: Alhazen");
		expect(ledgerHtml).not.toContain(`/entries/${alhazen.entry.id}/forget`);
	});

	it("shows an empty state", async () => {
		const html = await (await get("/near-misses", await sessionCookie(await seedUser()))).text();
		expect(html).toContain("No near misses yet.");
	});
});

describe("account deletion", () => {
	it("requires typed confirmation, then removes the user, their grants and session", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const { accessToken } = await issueOAuthTokens(userId);
		await makeTestLedger().claim(userId, {
			category: uniqueCategory(),
			name: "Hypatia",
			force: false,
		});

		expect((await post("/account/delete", cookie, { confirm: "nope" })).status).toBe(400);

		const deleted = await post("/account/delete", cookie, { confirm: "delete" });
		expect(deleted.headers.get("location")).toBe("/");
		expect(deleted.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(
			true,
		);
		expect(await testStore().getUser(userId)).toBeNull();
		const res = await SELF.fetch(`${ORIGIN}/api/v1/entries`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(401);
	});
});
