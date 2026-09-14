import { Hono } from "hono";
import { registerAuthRoutes } from "./auth";
import type { WebDeps, WebEnv } from "./guards";

const defaultDeps: WebDeps = {
	fetchFn: (input, init) => fetch(input, init),
	now: () => Date.now(),
};

export function createWebApp(deps: WebDeps = defaultDeps) {
	const app = new Hono<WebEnv>();
	registerAuthRoutes(app, deps);
	app.get("/", (c) => c.redirect("/login"));
	app.get("/login", (c) =>
		c.html(
			'<!doctype html><title>Topic Ledger</title><h1>Topic Ledger</h1><p><a href="/login/github">Continue with GitHub</a> · <a href="/login/google">Continue with Google</a></p>',
		),
	);
	return app;
}
