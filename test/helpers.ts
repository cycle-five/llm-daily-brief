import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { base64UrlEncode } from "../src/auth/encoding";
import { createPersonalToken } from "../src/auth/tokens";
import { DEFAULT_THRESHOLDS } from "../src/config";
import { Ledger } from "../src/core/ledger";
import type { Thresholds } from "../src/core/match";
import { normalize } from "../src/core/normalize";
import type { EntryRow, HitRow } from "../src/core/rows";
import { providerOptions } from "../src/index";
import type { SemanticIndex } from "../src/semantic/index";
import { LedgerStore } from "../src/store/d1";
import { FakeSemanticIndex } from "./fakes/semantic";

export function testStore(): LedgerStore {
	return new LedgerStore(env.DB);
}

export function seedUser(label = "user"): Promise<string> {
	return testStore().findOrCreateUserByIdentity(
		{
			provider: "github",
			subject: `${label}-${crypto.randomUUID()}`,
			email: null,
			displayName: label,
		},
		Date.now(),
		() => crypto.randomUUID(),
	);
}

export function uniqueCategory(): string {
	return `c-${crypto.randomUUID()}`;
}

export function makeEntry(
	userId: string,
	category: string,
	displayName: string,
	overrides: Partial<EntryRow> = {},
): EntryRow {
	return {
		id: crypto.randomUUID(),
		user_id: userId,
		category,
		display_name: displayName,
		normalized: normalize(displayName),
		vector_status: "pending",
		hit_count: 0,
		created_at: Date.now(),
		...overrides,
	};
}

export function makeHit(
	entry: EntryRow,
	candidate: string,
	overrides: Partial<HitRow> = {},
): HitRow {
	return {
		id: crypto.randomUUID(),
		entry_id: entry.id,
		user_id: entry.user_id,
		candidate_text: candidate,
		candidate_normalized: normalize(candidate),
		match_kind: "exact",
		score: 1,
		created_at: Date.now(),
		...overrides,
	};
}

export function makeTestLedger(
	options: { semantic?: SemanticIndex; now?: () => number; thresholds?: Thresholds } = {},
): Ledger {
	return new Ledger({
		store: testStore(),
		semantic: options.semantic ?? new FakeSemanticIndex(),
		thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
		now: options.now ?? (() => Date.now()),
		newId: () => crypto.randomUUID(),
	});
}

/** Strictly increasing timestamps, so "newest first" orderings are deterministic. */
export function steppingClock(start = 1_000): () => number {
	let current = start;
	return () => {
		current += 1;
		return current;
	};
}

export const ORIGIN = "https://ledger.test";

export async function createTestToken(userId: string): Promise<string> {
	const { token } = await createPersonalToken(testStore(), userId, "test", Date.now(), () =>
		crypto.randomUUID(),
	);
	return token;
}

const TokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string().optional(),
	token_type: z.string(),
});

/** Runs a real authorization-code + PKCE exchange against the Worker's /token endpoint. */
export async function issueOAuthTokens(
	userId: string,
): Promise<{ accessToken: string; refreshToken: string | undefined }> {
	const api = getOAuthApi(providerOptions, env);
	const redirectUri = "https://client.test/callback";
	const client = await api.createClient({
		redirectUris: [redirectUri],
		clientName: "Test Client",
		tokenEndpointAuthMethod: "none",
	});
	const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64UrlEncode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
	);
	const { redirectTo } = await api.completeAuthorization({
		request: {
			responseType: "code",
			clientId: client.clientId,
			redirectUri,
			scope: ["ledger"],
			state: "test-state",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		},
		userId,
		metadata: {},
		scope: ["ledger"],
		props: { userId },
	});
	const code = new URL(redirectTo).searchParams.get("code");
	if (!code) throw new Error(`authorization redirect carried no code: ${redirectTo}`);
	const response = await SELF.fetch(`${ORIGIN}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: client.clientId,
			code_verifier: verifier,
		}),
	});
	if (response.status !== 200) {
		throw new Error(`token endpoint returned ${response.status}: ${await response.text()}`);
	}
	const body = TokenResponse.parse(await response.json());
	return { accessToken: body.access_token, refreshToken: body.refresh_token };
}
