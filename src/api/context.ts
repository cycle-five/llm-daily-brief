import type { Ledger } from "../core/ledger";

/** Per-request dependencies for REST and MCP, built by the API handler from ctx.props + env. */
export interface ApiContext {
	userId: string;
	ledger: Ledger;
	limiter: RateLimit;
	globalMinUsers: number;
}
