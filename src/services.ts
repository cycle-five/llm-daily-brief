import { thresholdsFromEnv } from "./config";
import { Ledger } from "./core/ledger";
import type { Env } from "./env";
import { semanticIndexFromEnv } from "./semantic/cloudflare";
import { LedgerStore } from "./store/d1";

export function ledgerFromEnv(env: Env): Ledger {
	return new Ledger({
		store: new LedgerStore(env.DB),
		semantic: semanticIndexFromEnv(env),
		thresholds: thresholdsFromEnv(env),
		now: () => Date.now(),
		newId: () => crypto.randomUUID(),
	});
}
