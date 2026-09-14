import { Hono } from "hono";
import { registerAuthRoutes } from "./auth";
import { registerDashboardRoutes } from "./dashboard";
import type { WebDeps, WebEnv } from "./guards";

const defaultDeps: WebDeps = {
	fetchFn: (input, init) => fetch(input, init),
	now: () => Date.now(),
};

export function createWebApp(deps: WebDeps = defaultDeps) {
	const app = new Hono<WebEnv>();
	registerAuthRoutes(app, deps);
	registerDashboardRoutes(app, deps);
	return app;
}
