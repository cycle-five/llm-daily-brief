import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { providerOptions } from "../src/index";
import { createWebApp } from "../src/web/app";
import { formatRepeatRate } from "../src/web/dashboard";
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

/** The HTML between `<h2>heading</h2>` and the next h2 or the end of the page body. */
function section(html: string, heading: string): string {
	const marker = `<h2>${heading}</h2>`;
	const start = html.indexOf(marker);
	if (start === -1) throw new Error(`no section ${heading}`);
	const rest = html.slice(start + marker.length);
	const end = rest.search(/<h2>|<\/main>/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** The single <tr> whose first cell is exactly `label`. */
function summaryRow(html: string, label: string): string {
	const rows = html.split("<tr>").filter((row) => row.startsWith(`<td>${label}</td>`));
	if (rows.length !== 1) throw new Error(`expected one row for ${label}, got ${rows.length}`);
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
		expect(html).toContain('href="/overlaps"');
		expect(html).toMatch(/(&quot;|")model(&quot;|"):(&quot;|")cron/);
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

	it("names the other model when a near miss crossed models", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		await ledger.claim(
			userId,
			{ category, name: "Ibn al-Haytham", force: false, model: "Claude" },
			"Claude",
		);
		semantic.setSimilarity("Ibn al-Haytham", "Alhazen", 0.9);
		const grok = await ledger.claim(
			userId,
			{ category, name: "Alhazen", force: false, model: "Grok" },
			"Grok",
		);
		if (grok.status !== "possible_repeat") throw new Error("expected possible_repeat");

		const html = await (await get("/near-misses", cookie)).text();
		expect(rowFor(html, "Alhazen", "Ibn al-Haytham")).toContain("<small>from Claude</small>");
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

describe("overlaps page", () => {
	it("splits exact and spelling overlaps from meaning-only ones, and combines them on request", async () => {
		const userId = await seedUser();
		await testStore().setShareLedger(userId, false);
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claim = (name: string, model: string) =>
			ledger.claim(userId, { category, name, force: false, model }, model);
		await claim("Stone duality", "Claude");
		await claim("Étienne de La Boétie", "Claude");
		semantic.setSimilarity("Étienne de La Boétie", "Émilie du Châtelet", 0.84);
		await claim("stone duality", "Grok");
		await claim("Émilie du Châtelet", "Grok");

		const split = await (await get("/overlaps", cookie)).text();
		expect(section(split, "Overlaps")).toContain("<td>stone duality</td>");
		expect(section(split, "Overlaps")).not.toContain("Châtelet");
		expect(section(split, "Similar, unverified")).toContain("<td>Émilie du Châtelet</td>");
		expect(section(split, "Similar, unverified")).toContain("0.84");
		expect(section(split, "Similar, unverified")).not.toContain("stone duality");
		expect(split).not.toContain("Your models share one ledger");

		const combined = await (await get("/overlaps?view=combined", cookie)).text();
		expect(combined).not.toContain("<h2>Similar, unverified</h2>");
		expect(combined).toContain("<td>stone duality</td>");
		expect(combined).toContain("<td>Émilie du Châtelet</td>");
	});

	it("explains that a shared ledger blocks instead, and shows an empty state", async () => {
		const html = await (await get("/overlaps", await sessionCookie(await seedUser()))).text();
		expect(html).toContain("Your models share one ledger");
		expect(html).toContain("No overlaps yet.");
	});
});

describe("ledger models", () => {
	it("shows each topic's model and version, the connection when it differs, and filters by model", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const ledger = makeTestLedger();
		const category = uniqueCategory();
		await ledger.claim(
			userId,
			{ category, name: "Hilbert", force: false, model: "Claude", model_version: "Opus 5" },
			"Claude",
		);
		await ledger.claim(
			userId,
			{ category, name: "Cantor", force: false, model: "Grok" },
			"openclaw",
		);

		const all = await (await get("/ledger", cookie)).text();
		expect(all).toContain("Claude (Opus 5)");
		expect(all).toContain("connection: openclaw");
		expect(all).not.toContain("connection: Claude");

		const grok = await (await get("/ledger?model=grok", cookie)).text();
		expect(grok).toContain("Cantor");
		expect(grok).not.toContain("Hilbert");
		expect(grok).toContain("Showing topics from grok.");
	});
});

describe("repeats by model", () => {
	it("summarises attempts per model and names the model behind a cross-model hit", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);
		const semantic = new FakeSemanticIndex();
		const ledger = makeTestLedger({ semantic });
		const category = uniqueCategory();
		const claude = (name: string) =>
			ledger.claim(userId, { category, name, force: false, model: "Claude" }, "Claude");

		const kept = await claude("Euler's identity");
		if (kept.status !== "claimed") throw new Error("expected claimed");
		expect((await claude("euler identity")).status).toBe("repeat");
		semantic.setSimilarity("Euler's identity", "e^(iπ)+1=0", 0.9);
		const skipped = await claude("e^(iπ)+1=0");
		if (skipped.status !== "possible_repeat") throw new Error("expected possible_repeat");
		await ledger.skip(userId, { entry_id: skipped.entry.id, repeat_of: kept.entry.id });
		const grok = await ledger.claim(
			userId,
			{ category, name: "EULER'S IDENTITY", force: false, model: "Grok" },
			"Grok",
		);
		expect(grok.status).toBe("repeat");

		const html = await (await get("/repeats", cookie)).text();
		// Claude: one kept topic, a blocked repeat and a skip, so 2 hits over 3 attempts.
		expect(summaryRow(html, "Claude")).toContain("<td>67%</td>");
		expect(summaryRow(html, "Grok")).toContain("<td>100%</td>");
		expect(html).toContain("<small>by Grok</small>");
		expect(html).not.toContain("<small>by Claude</small>");
	});

	it("formats the rate, with a dash when there are no attempts", () => {
		expect(formatRepeatRate(0, 0)).toBe("—");
		expect(formatRepeatRate(1, 2)).toBe("67%");
		expect(formatRepeatRate(3, 0)).toBe("0%");
	});
});

describe("ledger sharing switch", () => {
	it("starts on, turns off and back on for same-origin posts only, and rejects other values", async () => {
		const userId = await seedUser();
		const cookie = await sessionCookie(userId);

		expect(await (await get("/account", cookie)).text()).toContain(
			"On: a topic any of your models has claimed is a repeat for all of them.",
		);

		expect((await post("/account/ledger-sharing", cookie, { share: "off" }, false)).status).toBe(
			403,
		);
		expect((await testStore().getUser(userId))?.share_ledger).toBe(true);

		const off = await post("/account/ledger-sharing", cookie, { share: "off" });
		expect(off.headers.get("location")).toBe("/account");
		expect((await testStore().getUser(userId))?.share_ledger).toBe(false);
		expect(await (await get("/account", cookie)).text()).toContain(
			"Off: each model is blocked only by its own topics",
		);

		expect((await post("/account/ledger-sharing", cookie, { share: "maybe" })).status).toBe(400);
		await post("/account/ledger-sharing", cookie, { share: "on" });
		expect((await testStore().getUser(userId))?.share_ledger).toBe(true);
	});
});
