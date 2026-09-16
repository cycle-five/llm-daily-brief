import type { Env } from "../env";

/**
 * The name of the connection a request arrived on, kept for audit and used as REST's default
 * model: a personal token's label (already in props), or the OAuth client's registered name,
 * falling back to its client id. Null only when the bearer credential cannot be unwrapped.
 */
export async function connectionName(
	env: Pick<Env, "OAUTH_PROVIDER">,
	request: Request,
	propsClient: string | undefined,
): Promise<string | null> {
	if (propsClient !== undefined) return propsClient;
	const token = bearerToken(request);
	if (token === null) return null;
	const summary = await env.OAUTH_PROVIDER.unwrapToken(token);
	if (!summary) return null;
	const client = await env.OAUTH_PROVIDER.lookupClient(summary.grant.clientId);
	const name = client?.clientName?.trim();
	return name ? name : summary.grant.clientId;
}

function bearerToken(request: Request): string | null {
	const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
	return match?.[1] ?? null;
}

/** Memoises an async value: computed on first use, and never if unused. */
export function once<T>(compute: () => Promise<T>): () => Promise<T> {
	let value: Promise<T> | undefined;
	return () => {
		value ??= compute();
		return value;
	};
}
