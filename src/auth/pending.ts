import { z } from "zod";
import { base64UrlEncode } from "./encoding";

/** Mirrors the OAuth library's AuthRequest so the parsed value can be passed back to it. */
const AuthRequestSchema = z.object({
	responseType: z.string(),
	clientId: z.string(),
	redirectUri: z.string(),
	scope: z.array(z.string()),
	state: z.string(),
	codeChallenge: z.string().optional(),
	codeChallengeMethod: z.string().optional(),
	resource: z.union([z.string(), z.array(z.string())]).optional(),
	issuer: z.string().optional(),
});

export const PendingSignIn = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("authorize"), request: AuthRequestSchema, clientName: z.string() }),
	z.object({ kind: z.literal("dashboard") }),
]);
export type PendingSignIn = z.infer<typeof PendingSignIn>;

const TTL_SECONDS = 600;
const keyFor = (id: string): string => `signin:${id}`;

export async function savePending(kv: KVNamespace, pending: PendingSignIn): Promise<string> {
	const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
	await kv.put(keyFor(id), JSON.stringify(pending), { expirationTtl: TTL_SECONDS });
	return id;
}

/** Reads and deletes a pending sign-in; each id is usable once. */
export async function takePending(kv: KVNamespace, id: string): Promise<PendingSignIn | null> {
	const raw = await kv.get(keyFor(id));
	if (raw === null) return null;
	await kv.delete(keyFor(id));
	try {
		const parsed = PendingSignIn.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
