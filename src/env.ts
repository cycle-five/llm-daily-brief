import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
	DB: D1Database;
	OAUTH_KV: KVNamespace;
	/** Absent in tests (wrangler.test.jsonc); semantic matching then reports "unavailable". */
	AI?: Ai;
	/** Absent in tests (wrangler.test.jsonc). */
	VECTORS?: Vectorize;
	CLAIM_LIMITER: RateLimit;
	/** Injected by OAuthProvider before the default and API handlers run. */
	OAUTH_PROVIDER: OAuthHelpers;
	PUBLIC_ORIGIN: string;
	SEMANTIC_REPEAT_THRESHOLD: string;
	SEMANTIC_POSSIBLE_THRESHOLD: string;
	TRIGRAM_REPEAT_THRESHOLD: string;
	GLOBAL_MIN_USERS: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	COOKIE_SECRET: string;
}

export const PropsSchema = z.object({
	userId: z.string().min(1),
	/** A personal token's label. OAuth grants carry no client here; see api/connection.ts. */
	client: z.string().min(1).optional(),
});
export type Props = z.infer<typeof PropsSchema>;
