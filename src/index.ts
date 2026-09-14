import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { apiHandler } from "./api/handler";
import { resolvePersonalToken } from "./auth/tokens";
import type { Env } from "./env";
import { ledgerFromEnv } from "./services";
import { LedgerStore } from "./store/d1";
import { createWebApp } from "./web/app";

const webApp = createWebApp();

export const providerOptions: OAuthProviderOptions<Env> = {
	apiRoute: ["/mcp", "/api/v1/"],
	apiHandler,
	defaultHandler: {
		fetch: (request, env, ctx) => webApp.fetch(request, env, ctx),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["ledger"],
	accessTokenTTL: 3600,
	// The library default is 30 days. Scheduled briefs run unattended, so refresh tokens must
	// not expire until the grant is revoked — and that requires passing undefined explicitly.
	refreshTokenTTL: undefined,
	resolveExternalToken: async ({ token, env }) => {
		const resolved = await resolvePersonalToken(new LedgerStore(env.DB), token, Date.now());
		return resolved ? { props: resolved } : null;
	},
};

const provider = new OAuthProvider<Env>(providerOptions);

export default {
	fetch: (request, env, ctx) => provider.fetch(request, env, ctx),
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(Promise.all([ledgerFromEnv(env).backfill(), provider.purgeExpiredData(env)]));
	},
} satisfies ExportedHandler<Env>;
