import { z } from "zod";
import type { Env } from "../env";
import type { IdentityInput, IdentityProvider } from "../store/d1";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface UpstreamCredentials {
	clientId: string;
	clientSecret: string;
}

export class UpstreamError extends Error {
	override name = "UpstreamError";
}

const AUTHORIZE_URL: Record<IdentityProvider, string> = {
	github: "https://github.com/login/oauth/authorize",
	google: "https://accounts.google.com/o/oauth2/v2/auth",
};

const SCOPES: Record<IdentityProvider, string> = {
	github: "read:user user:email",
	google: "openid email profile",
};

const AccessToken = z.object({ access_token: z.string() });
const GitHubUser = z.object({
	id: z.number(),
	login: z.string(),
	name: z.string().nullable(),
	email: z.string().nullable(),
});
const GoogleUser = z.object({
	sub: z.string(),
	email: z.string().optional(),
	name: z.string().optional(),
});

export function credentialsFor(env: Env, provider: IdentityProvider): UpstreamCredentials {
	return provider === "github"
		? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
		: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

export function upstreamAuthorizationUrl(
	provider: IdentityProvider,
	credentials: UpstreamCredentials,
	redirectUri: string,
	state: string,
): string {
	const url = new URL(AUTHORIZE_URL[provider]);
	url.searchParams.set("client_id", credentials.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", SCOPES[provider]);
	url.searchParams.set("state", state);
	if (provider === "google") url.searchParams.set("response_type", "code");
	return url.toString();
}

async function readAs<S extends z.ZodType>(
	response: Response,
	schema: S,
	what: string,
): Promise<z.output<S>> {
	if (!response.ok) throw new UpstreamError(`${what} failed with HTTP ${response.status}`);
	const parsed = schema.safeParse(await response.json());
	if (!parsed.success) throw new UpstreamError(`${what} returned an unexpected payload`);
	return parsed.data;
}

export async function exchangeUpstreamCode(
	provider: IdentityProvider,
	credentials: UpstreamCredentials,
	code: string,
	redirectUri: string,
	fetchFn: FetchFn,
): Promise<IdentityInput> {
	if (provider === "github") {
		const token = await readAs(
			await fetchFn("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					code,
					redirect_uri: redirectUri,
				}),
			}),
			AccessToken,
			"GitHub token exchange",
		);
		const user = await readAs(
			await fetchFn("https://api.github.com/user", {
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token.access_token}`,
					"user-agent": "topic-ledger",
				},
			}),
			GitHubUser,
			"GitHub user lookup",
		);
		return {
			provider,
			subject: String(user.id),
			email: user.email,
			displayName: user.name ?? user.login,
		};
	}

	const token = await readAs(
		await fetchFn("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		}),
		AccessToken,
		"Google token exchange",
	);
	const user = await readAs(
		await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", {
			headers: { authorization: `Bearer ${token.access_token}` },
		}),
		GoogleUser,
		"Google user lookup",
	);
	return { provider, subject: user.sub, email: user.email ?? null, displayName: user.name ?? null };
}
