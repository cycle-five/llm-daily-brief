import { Hono } from "hono";
import type { Env } from "../env";

export function createWebApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/", (c) => c.text("Topic Ledger"));
	return app;
}
