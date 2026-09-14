import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { savePending, takePending } from "../auth/pending";
import {
	APPROVED_COOKIE,
	createSession,
	decodeApprovedClients,
	encodeApprovedClients,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	STATE_COOKIE,
} from "../auth/session";
import {
	credentialsFor,
	exchangeUpstreamCode,
	UpstreamError,
	upstreamAuthorizationUrl,
} from "../auth/upstream";
import { LedgerStore } from "../store/d1";
import { cookieOptions, currentUserId, isSameOrigin, type WebDeps, type WebEnv } from "./guards";
import { ErrorPage, Layout, render } from "./layout";

const Provider = z.enum(["github", "google"]);
const ApproveForm = z.object({ state: z.string().min(1), provider: Provider.optional() });
const CallbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });
const STATE_TTL_SECONDS = 600;
const MAX_REMEMBERED_CLIENTS = 20;

function callbackUrl(c: Context<WebEnv>, provider: z.infer<typeof Provider>): string {
	return `${c.env.PUBLIC_ORIGIN}/callback/${provider}`;
}

function clearState(c: Context<WebEnv>): void {
	deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
}

function ConsentPage(props: { clientName: string; stateId: string; signedIn: boolean }) {
	return (
		<Layout title="Authorize">
			<h1>Connect {props.clientName}</h1>
			<p>
				<strong>{props.clientName}</strong> wants to read and write your topic ledger.
			</p>
			<form method="post" action="/authorize/approve">
				<input type="hidden" name="state" value={props.stateId} />
				{props.signedIn ? (
					<button type="submit">Approve</button>
				) : (
					<>
						<button type="submit" name="provider" value="github">
							Continue with GitHub
						</button>{" "}
						<button type="submit" name="provider" value="google">
							Continue with Google
						</button>
					</>
				)}
			</form>
		</Layout>
	);
}

async function completeGrant(
	c: Context<WebEnv>,
	request: AuthRequest,
	userId: string,
	clientName: string,
): Promise<Response> {
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request,
		userId,
		metadata: { clientName },
		scope: ["ledger"],
		props: { userId },
	});
	const approved = await decodeApprovedClients(getCookie(c, APPROVED_COOKIE), c.env.COOKIE_SECRET);
	if (!approved.includes(request.clientId)) {
		const remembered = [...approved, request.clientId].slice(-MAX_REMEMBERED_CLIENTS);
		setCookie(
			c,
			APPROVED_COOKIE,
			await encodeApprovedClients(remembered, c.env.COOKIE_SECRET),
			cookieOptions(SESSION_TTL_SECONDS),
		);
	}
	return c.redirect(redirectTo);
}

export function registerAuthRoutes(app: Hono<WebEnv>, deps: WebDeps): void {
	app.get("/authorize", async (c) => {
		let request: AuthRequest;
		try {
			request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		} catch (error) {
			if (!(error instanceof AuthorizationError)) throw error;
			if (error.redirectUri) {
				const target = new URL(error.redirectUri);
				target.searchParams.set("error", error.code);
				target.searchParams.set("error_description", error.description);
				if (error.state) target.searchParams.set("state", error.state);
				if (error.issuer) target.searchParams.set("iss", error.issuer);
				return c.redirect(target.toString());
			}
			return render(
				c,
				<ErrorPage
					title="Invalid authorization request"
					message={error.description || error.code}
				/>,
				400,
			);
		}
		const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
		if (!client) {
			return render(
				c,
				<ErrorPage title="Unknown client" message="This application is not registered." />,
				400,
			);
		}
		const clientName = client.clientName ?? request.clientId;
		const userId = await currentUserId(c, deps);
		if (userId) {
			const approved = await decodeApprovedClients(
				getCookie(c, APPROVED_COOKIE),
				c.env.COOKIE_SECRET,
			);
			if (approved.includes(request.clientId)) return completeGrant(c, request, userId, clientName);
		}
		const stateId = await savePending(c.env.OAUTH_KV, { kind: "authorize", request, clientName });
		setCookie(c, STATE_COOKIE, stateId, cookieOptions(STATE_TTL_SECONDS));
		return render(
			c,
			<ConsentPage clientName={clientName} stateId={stateId} signedIn={userId !== null} />,
		);
	});

	app.post("/authorize/approve", async (c) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		const form = ApproveForm.safeParse(await c.req.parseBody());
		if (!form.success || form.data.state !== getCookie(c, STATE_COOKIE)) {
			return render(
				c,
				<ErrorPage title="Sign-in expired" message="Start again from your app." />,
				400,
			);
		}
		const userId = await currentUserId(c, deps);
		if (userId) {
			const pending = await takePending(c.env.OAUTH_KV, form.data.state);
			clearState(c);
			if (pending?.kind !== "authorize") {
				return render(
					c,
					<ErrorPage title="Sign-in expired" message="Start again from your app." />,
					400,
				);
			}
			return completeGrant(c, pending.request, userId, pending.clientName);
		}
		if (!form.data.provider) {
			return render(
				c,
				<ErrorPage title="Choose a provider" message="Pick GitHub or Google." />,
				400,
			);
		}
		const provider = form.data.provider;
		return c.redirect(
			upstreamAuthorizationUrl(
				provider,
				credentialsFor(c.env, provider),
				callbackUrl(c, provider),
				form.data.state,
			),
		);
	});

	app.get("/login/:provider", async (c) => {
		const provider = Provider.safeParse(c.req.param("provider"));
		if (!provider.success) {
			return render(c, <ErrorPage title="Not found" message="Unknown sign-in provider." />, 404);
		}
		const stateId = await savePending(c.env.OAUTH_KV, { kind: "dashboard" });
		setCookie(c, STATE_COOKIE, stateId, cookieOptions(STATE_TTL_SECONDS));
		return c.redirect(
			upstreamAuthorizationUrl(
				provider.data,
				credentialsFor(c.env, provider.data),
				callbackUrl(c, provider.data),
				stateId,
			),
		);
	});

	app.get("/callback/:provider", async (c) => {
		const provider = Provider.safeParse(c.req.param("provider"));
		const query = CallbackQuery.safeParse(c.req.query());
		if (!provider.success || !query.success || query.data.state !== getCookie(c, STATE_COOKIE)) {
			return render(c, <ErrorPage title="Sign-in expired" message="Please start again." />, 400);
		}
		const pending = await takePending(c.env.OAUTH_KV, query.data.state);
		clearState(c);
		if (!pending) {
			return render(c, <ErrorPage title="Sign-in expired" message="Please start again." />, 400);
		}
		let identity: Awaited<ReturnType<typeof exchangeUpstreamCode>>;
		try {
			identity = await exchangeUpstreamCode(
				provider.data,
				credentialsFor(c.env, provider.data),
				query.data.code,
				callbackUrl(c, provider.data),
				deps.fetchFn,
			);
		} catch (error) {
			if (error instanceof UpstreamError) {
				return render(c, <ErrorPage title="Sign-in failed" message={error.message} />, 502);
			}
			throw error;
		}
		const userId = await new LedgerStore(c.env.DB).findOrCreateUserByIdentity(
			identity,
			deps.now(),
			() => crypto.randomUUID(),
		);
		setCookie(
			c,
			SESSION_COOKIE,
			await createSession(userId, deps.now(), c.env.COOKIE_SECRET),
			cookieOptions(SESSION_TTL_SECONDS),
		);
		if (pending.kind === "authorize")
			return completeGrant(c, pending.request, userId, pending.clientName);
		return c.redirect("/ledger");
	});

	app.post("/logout", (c) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
		return c.redirect("/");
	});
}
