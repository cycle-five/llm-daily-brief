import { Hono } from "hono";
import { LedgerError } from "../core/errors";
import type { ApiContext } from "./context";
import { errorResponse } from "./errors";
import { enforceRateLimit } from "./ratelimit";
import { CheckInput, ClaimInput, ListInput, StatsInput } from "./schemas";
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
		return c.json(await c.env.ledger.claim(c.env.userId, input));
	});

	app.post("/checks", async (c) => {
		await enforceRateLimit(c.env.limiter, c.env.userId);
		const input = parseInput(CheckInput, await readJson(c.req.raw));
		return c.json(await c.env.ledger.check(c.env.userId, input));
	});

	app.get("/entries", async (c) => {
		const input = parseInput(ListInput, c.req.query());
		return c.json(await c.env.ledger.list(c.env.userId, input));
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
