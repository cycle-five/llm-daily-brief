import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
					GITHUB_CLIENT_ID: "gh-client",
					GITHUB_CLIENT_SECRET: "gh-secret",
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					COOKIE_SECRET: "test-cookie-secret-0123456789abcdef",
				},
			},
		})),
	],
	test: { setupFiles: ["./test/setup.ts"] },
});
