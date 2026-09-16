import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

declare global {
	namespace Cloudflare {
		interface Env extends AppEnv {
			TEST_MIGRATIONS: D1Migration[];
			/** Left unmigrated by test/setup.ts so migration tests can apply migrations stepwise. */
			MIGRATION_DB: D1Database;
		}
	}
}
