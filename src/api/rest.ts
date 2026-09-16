import { Hono } from "hono";
import { LedgerError } from "../core/errors";
import type { ApiContext } from "./context";
import { errorResponse } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import {
	CheckInput,
	ClaimInput,
	KeepBody,
	type KeepInput,
	ListInput,
	SkipBody,
	type SkipInput,
	StatsInput,
} from "./schemas";
import { parseInput } from "./validate";

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new LedgerError("invalid_input", "request body must be JSON");
	}
}

export function createRestApp() {
	const app = new Hono<{ Bindings: ApiContext }>().basePath("/api/v1");

	app.post("/claims", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(ClaimInput, await readJson(c.req.raw));
		const client = await c.env.connectionName();
		// Scripts need not declare a model: the connection's name stands in for it.
		const model = input.model ?? client;
		const claim: ClaimInput = model === null ? input : { ...input, model };
		return c.json(await c.env.ledger.claim(c.env.userId, claim, client));
	});

	app.post("/checks", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(CheckInput, await readJson(c.req.raw));
		const model = input.model ?? (await c.env.connectionName());
		const check: CheckInput = model === null ? input : { ...input, model };
		return c.json(await c.env.ledger.check(c.env.userId, check));
	});

	app.get("/entries", async (c) => {
		const input = parseInput(ListInput, c.req.query());
		return c.json(await c.env.ledger.list(c.env.userId, input));
	});

	app.post("/entries/:id/skip", async (c) => {
		const body = parseInput(SkipBody, await readJson(c.req.raw));
		const input: SkipInput = { ...body, entry_id: c.req.param("id") };
		return c.json(await c.env.ledger.skip(c.env.userId, input));
	});

	app.post("/entries/:id/keep", async (c) => {
		const body = parseInput(KeepBody, await readJson(c.req.raw));
		const input: KeepInput = { ...body, entry_id: c.req.param("id") };
		return c.json(await c.env.ledger.keep(c.env.userId, input));
	});

	app.delete("/entries/:id", async (c) => {
		await c.env.ledger.forget(c.env.userId, c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/stats", async (c) => {
		const input = parseInput(StatsInput, c.req.query());
		return c.json(await c.env.ledger.stats(c.env.userId, input, c.env.globalMinUsers));
	});

	app.notFound(() => errorResponse(new LedgerError("not_found", "no such endpoint")));
	app.onError((error) => errorResponse(error));

	return app;
}
