import { createMcpHandler } from "agents/mcp/server";
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import { type Env, PropsSchema } from "../env";
import { ledgerFromEnv } from "../services";
import { LedgerStore } from "../store/d1";
import { connectionName, once } from "./connection";
import type { ApiContext } from "./context";
import { errorResponse } from "./errors";
import { buildMcpServer } from "./mcp";
import { createRestApp } from "./rest";

const restApp = createRestApp();

/** Receives only authenticated requests: OAuthProvider sets ctx.props before calling it. */
export const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = PropsSchema.safeParse(ctx.props);
		if (!props.success) {
			return errorResponse(new LedgerError("unauthorized", "missing or invalid identity"));
		}
		// OAuth grants and access tokens live in KV and are not tied to the users row, so a token
		// can outlive its account. Refuse it here rather than fail later on a foreign key.
		if (!(await new LedgerStore(env.DB).getUser(props.data.userId))) {
			return errorResponse(new LedgerError("unauthorized", "account no longer exists"));
		}
		const api: ApiContext = {
			userId: props.data.userId,
			ledger: ledgerFromEnv(env),
			limiter: env.CLAIM_LIMITER,
			globalMinUsers: globalMinUsersFromEnv(env),
			connectionName: once(() => connectionName(env, request, props.data.client)),
		};
		if (new URL(request.url).pathname === "/mcp") {
			const mcp = createMcpHandler(() => buildMcpServer(api), {
				route: "/mcp",
				allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname],
			});
			return mcp(request, env, ctx);
		}
		return restApp.fetch(request, api, ctx);
	},
};
