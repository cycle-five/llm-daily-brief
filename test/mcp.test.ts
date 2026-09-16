import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { CLAIM_FIRST_NOTE } from "../src/api/mcp";
import {
	CheckResult,
	ClaimResult,
	ErrorBody,
	KeepResult,
	ListResult,
	SkipResult,
	StatsResult,
} from "../src/api/schemas";
import {
	createTestToken,
	issueOAuthTokens,
	makeEntry,
	makeNearMiss,
	ORIGIN,
	seedUser,
	testStore,
	uniqueCategory,
} from "./helpers";

const open: Client[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((client) => client.close()));
});

// `SELF.fetch` calls the Worker's exported `fetch` handler directly (see
// `@cloudflare/vitest-plugin`'s `cloudflare:test-internal`), rather than making a real HTTP round
// trip. A real HTTP client always sends a `Host` header derived from the request's authority; this
// in-process shortcut does not synthesize one, so `/mcp`'s DNS-rebinding Host check (via
// `allowedHostnames`) never sees it. Add it explicitly so the test reproduces what a real MCP
// client's request looks like on the wire.
const originHostname = new URL(ORIGIN).hostname;

async function connect(token: string): Promise<Client> {
	const client = new Client({ name: "ledger-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
		fetch: (url, init) => SELF.fetch(url, init),
		requestInit: { headers: { authorization: `Bearer ${token}`, host: originHostname } },
	});
	await client.connect(transport);
	open.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
	return client.callTool({ name, arguments: args });
}

describe("MCP endpoint", () => {
	it("lists the six ledger tools", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"check_topic",
			"claim_topic",
			"keep_topic",
			"list_topics",
			"skip_topic",
			"topic_stats",
		]);
	});

	it("tells the read tools not to pre-browse, so a repeat is counted rather than avoided", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const { tools } = await client.listTools();
		const description = (name: string) =>
			tools.find((tool) => tool.name === name)?.description ?? "";

		for (const name of ["check_topic", "list_topics"]) {
			expect(description(name)).toContain(CLAIM_FIRST_NOTE.trim());
		}
		// The original wording invited exactly the pre-browsing that zeroes the hit counter.
		expect(description("list_topics")).not.toContain("avoiding repeats up front");
	});

	it("claims, repeats, checks, lists and reports stats with typed structured content", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const category = uniqueCategory();

		const first = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "Euler's Identity" })).structuredContent,
		);
		expect(first.status).toBe("claimed");

		const second = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "euler identity" })).structuredContent,
		);
		expect(second.status).toBe("repeat");

		const check = CheckResult.parse(
			(await call(client, "check_topic", { category, name: "EULER IDENTITY" })).structuredContent,
		);
		expect(check.likely_repeat).toBe(true);

		const list = ListResult.parse(
			(await call(client, "list_topics", { category, limit: 5 })).structuredContent,
		);
		expect(list.entries).toHaveLength(1);

		const stats = StatsResult.parse(
			(await call(client, "topic_stats", { scope: "me", category })).structuredContent,
		);
		expect(stats.repeats).toMatchObject([{ display_name: "Euler's Identity", hit_count: 1 }]);
	});

	it("shares one ledger with REST", async () => {
		const token = await createTestToken(await seedUser());
		const client = await connect(token);
		const category = uniqueCategory();
		await call(client, "claim_topic", { category, name: "Noether" });

		const res = await SELF.fetch(`${ORIGIN}/api/v1/checks`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ category, name: "noether" }),
		});
		expect(CheckResult.parse(await res.json()).likely_repeat).toBe(true);
	});

	it("returns a typed tool error for an unknown entry", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		const result = await call(client, "keep_topic", { entry_id: crypto.randomUUID() });
		expect(result.isError).toBe(true);
		expect(ErrorBody.parse(result.structuredContent).error.code).toBe("not_found");
	});

	it("rejects invalid arguments", async () => {
		const client = await connect(await createTestToken(await seedUser()));
		// The SDK may surface schema violations as a tool error result or as a protocol error.
		const outcome = await call(client, "claim_topic", { category: "", name: "x" }).then(
			(result) => result.isError === true,
			() => true,
		);
		expect(outcome).toBe(true);
	});

	it("accepts OAuth access tokens", async () => {
		const { accessToken } = await issueOAuthTokens(await seedUser());
		const client = await connect(accessToken);
		expect((await client.listTools()).tools).toHaveLength(6);
	});

	it("refuses unauthenticated connections", async () => {
		await expect(connect("ldg_not-a-real-token")).rejects.toThrow();
	});

	it("normalizes a mixed-case, padded category the same way REST does", async () => {
		const token = await createTestToken(await seedUser());
		const client = await connect(token);
		const category = uniqueCategory();
		const padded = `  ${category.toUpperCase()}  `;

		await call(client, "claim_topic", { category: padded, name: "Fermat's Last Theorem" });

		const res = await SELF.fetch(`${ORIGIN}/api/v1/checks`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ category, name: "fermat's last theorem" }),
		});
		expect(CheckResult.parse(await res.json()).likely_repeat).toBe(true);

		const list = ListResult.parse(
			(await call(client, "list_topics", { category: padded, limit: 5 })).structuredContent,
		);
		expect(list.entries).toHaveLength(1);
		expect(list.entries[0]?.category).toBe(category);
	});

	it("skips and keeps flagged claims, and the skipped phrasing then repeats exactly", async () => {
		const userId = await seedUser();
		const client = await connect(await createTestToken(userId));
		const category = uniqueCategory();
		const store = testStore();
		// The test Worker has no semantic binding, so flagged claims are seeded directly.
		const original = makeEntry(userId, category, "Ibn al-Haytham");
		const alhazen = makeEntry(userId, category, "Alhazen");
		const khayyam = makeEntry(userId, category, "Omar Khayyam");
		for (const entry of [original, alhazen, khayyam]) await store.insertEntry(entry);
		await store.insertNearMisses([
			makeNearMiss(alhazen, original, { score: 0.9 }),
			makeNearMiss(khayyam, original, { score: 0.81 }),
		]);

		const skipped = await call(client, "skip_topic", {
			entry_id: alhazen.id,
			repeat_of: original.id,
			note: "same person",
		});
		expect(SkipResult.parse(skipped.structuredContent)).toMatchObject({
			skipped: alhazen.id,
			alias_of: { entry_id: original.id, hit_count: 1 },
		});

		const kept = await call(client, "keep_topic", { entry_id: khayyam.id });
		expect(KeepResult.parse(kept.structuredContent)).toEqual({ kept: khayyam.id, distinct: 1 });

		const repeat = ClaimResult.parse(
			(await call(client, "claim_topic", { category, name: "alhazen" })).structuredContent,
		);
		expect(repeat).toMatchObject({
			status: "repeat",
			matches: [{ entry_id: original.id, via_alias: "Alhazen" }],
		});
	});
});
