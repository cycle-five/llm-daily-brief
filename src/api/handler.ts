import { createMcpHandler } from "agents/mcp/server";
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import { type Env, PropsSchema } from "../env";
import { ledgerFromEnv } from "../services";
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
		const api: ApiContext = {
			userId: props.data.userId,
			ledger: ledgerFromEnv(env),
			limiter: env.CLAIM_LIMITER,
			globalMinUsers: globalMinUsersFromEnv(env),
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
