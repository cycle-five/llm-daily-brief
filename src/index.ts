import type { Env } from "./env";

export default {
	async fetch(): Promise<Response> {
		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
