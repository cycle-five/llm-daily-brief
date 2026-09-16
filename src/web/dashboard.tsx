import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Entry, RepeatStat } from "../api/schemas";
import { SESSION_COOKIE } from "../auth/session";
import { createPersonalToken } from "../auth/tokens";
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import type { EntryRow, TokenRow } from "../core/rows";
import { toIso } from "../core/wire";
import { ledgerFromEnv } from "../services";
import { LedgerStore, type NearMissView, type UserRepeatRow } from "../store/d1";
import { currentUserId, isSameOrigin, type WebDeps, type WebEnv } from "./guards";
import { ErrorPage, Layout, render } from "./layout";
import { BRIEF_PROMPT_SNIPPET } from "./prompt";

const TokenForm = z.object({ label: z.string().trim().min(1).max(64) });
const DeleteForm = z.object({ confirm: z.literal("delete") });
const GrantMetadata = z.object({ clientName: z.string() });
/**
 * `Handler`'s `Context<WebEnv>` carries no route-literal type, so `c.req.param` falls back to
 * Hono's `string | undefined` overload even though the router only invokes these handlers when
 * `:id` matched. Parsing (rather than casting) narrows the type and keeps a defensive check.
 */
const RouteId = z.string().min(1);
const PAGE_LIMIT = 100;
const MAX_GRANT_SWEEPS = 50;

type Handler = (c: Context<WebEnv>, userId: string) => Promise<Response>;

function LandingPage() {
	return (
		<Layout title="Welcome">
			<h1>Topic Ledger</h1>
			<p>Keeps your daily brief from repeating itself, and counts how often it tried.</p>
			<p>
				<a href="/login/github">Continue with GitHub</a> ·{" "}
				<a href="/login/google">Continue with Google</a>
			</p>
		</Layout>
	);
}

function LedgerPage(props: { entries: Entry[]; aliases: ReadonlyMap<string, string[]> }) {
	return (
		<Layout title="Ledger" signedIn>
			<h1>Ledger</h1>
			{props.entries.length === 0 ? (
				<p>
					No topics yet. Connect your brief on the <a href="/connect">Connect</a> page.
				</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Claimed</th>
							<th>Repeats</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.entries.map((entry) => {
							const aliases = props.aliases.get(entry.id) ?? [];
							return (
								<tr>
									<td>
										{entry.display_name}
										{aliases.length > 0 ? (
											<>
												<br />
												<small>{`also claimed as: ${aliases.join(", ")}`}</small>
											</>
										) : null}
									</td>
									<td>{entry.category}</td>
									<td>{entry.created_at.slice(0, 10)}</td>
									<td>{entry.hit_count}</td>
									<td>
										<form class="inline" method="post" action={`/entries/${entry.id}/forget`}>
											<button type="submit">Forget</button>
										</form>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
			<p>Showing the newest {PAGE_LIMIT} topics.</p>
		</Layout>
	);
}

function aliasNamesByOriginal(aliases: readonly EntryRow[]): Map<string, string[]> {
	const names = new Map<string, string[]>();
	for (const alias of aliases) {
		if (alias.alias_of === null) continue;
		names.set(alias.alias_of, [...(names.get(alias.alias_of) ?? []), alias.display_name]);
	}
	return names;
}

function verdictLabel(row: NearMissView): string {
	if (row.verdict === "repeat") return "Repeat — skipped";
	if (row.verdict === "distinct") return "Different — kept";
	return row.claim_alias_of === null ? "No verdict — used" : "Not judged — claim skipped";
}

function NearMissesPage(props: { rows: NearMissView[] }) {
	return (
		<Layout title="Near misses" signedIn>
			<h1>Near misses</h1>
			<p>Earlier topics a claim resembled closely enough to ask the brief for a verdict.</p>
			{props.rows.length === 0 ? (
				<p>No near misses yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Claimed</th>
							<th>Matched</th>
							<th>Match</th>
							<th>Score</th>
							<th>Verdict</th>
							<th>Note</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<tr>
								<td>{toIso(row.created_at).slice(0, 10)}</td>
								<td>{row.claim_name}</td>
								<td>
									{row.matched_name} <small>{`(${row.category})`}</small>
									{row.via_name === null ? null : (
										<>
											<br />
											<small>{`via ${row.via_name}`}</small>
										</>
									)}
								</td>
								<td>{row.match_kind}</td>
								<td>{row.score.toFixed(2)}</td>
								<td>{verdictLabel(row)}</td>
								<td>{row.note ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p>Showing the newest {PAGE_LIMIT} near misses.</p>
		</Layout>
	);
}

function MyRepeatsPage(props: { rows: UserRepeatRow[] }) {
	return (
		<Layout title="Your repeats" signedIn>
			<h1>Your repeats</h1>
			{props.rows.length === 0 ? (
				<p>No repeats yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Hits</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<tr>
								<td>{row.entry.display_name}</td>
								<td>{row.entry.category}</td>
								<td>{row.entry.hit_count}</td>
								<td>
									<details>
										<summary>{row.hits.length} blocked attempts</summary>
										<table>
											<thead>
												<tr>
													<th>Phrasing</th>
													<th>Match</th>
													<th>Score</th>
												</tr>
											</thead>
											<tbody>
												{row.hits.map((hit) => (
													<tr>
														<td>{hit.candidate_text}</td>
														<td>{hit.match_kind}</td>
														<td>{hit.score.toFixed(2)}</td>
													</tr>
												))}
											</tbody>
										</table>
									</details>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Layout>
	);
}

function GlobalRepeatsPage(props: { repeats: RepeatStat[]; minUsers: number }) {
	return (
		<Layout title="Global repeats" signedIn>
			<h1>Global repeats</h1>
			<p>Topics appear here once at least {props.minUsers} people have tried to repeat them.</p>
			{props.repeats.length === 0 ? (
				<p>No repeats yet.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Topic</th>
							<th>Category</th>
							<th>Hits</th>
							<th>People</th>
						</tr>
					</thead>
					<tbody>
						{props.repeats.map((repeat) => (
							<tr>
								<td>{repeat.display_name}</td>
								<td>{repeat.category}</td>
								<td>{repeat.hit_count}</td>
								<td>{repeat.distinct_users}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Layout>
	);
}

function AccessPage(props: { tokens: TokenRow[]; grants: GrantSummary[]; newToken?: string }) {
	return (
		<Layout title="Access" signedIn>
			<h1>Access</h1>
			{props.newToken ? (
				<>
					<p>
						<strong>New token — copy it now, it will not be shown again:</strong>
					</p>
					<pre>{props.newToken}</pre>
				</>
			) : null}
			<h2>Personal API tokens</h2>
			<form method="post" action="/tokens">
				<label>
					Label <input name="label" maxLength={64} required />
				</label>{" "}
				<button type="submit">Create token</button>
			</form>
			<table>
				<tbody>
					{props.tokens.map((token) => (
						<tr>
							<td>{token.label}</td>
							<td>created {toIso(token.created_at).slice(0, 10)}</td>
							<td>
								{token.last_used_at
									? `used ${toIso(token.last_used_at).slice(0, 10)}`
									: "never used"}
							</td>
							<td>
								{token.revoked_at ? (
									"revoked"
								) : (
									<form class="inline" method="post" action={`/tokens/${token.id}/revoke`}>
										<button type="submit">Revoke</button>
									</form>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<h2>Connected clients</h2>
			<table>
				<tbody>
					{props.grants.map((grant) => {
						const metadata = GrantMetadata.safeParse(grant.metadata);
						return (
							<tr>
								<td>{metadata.success ? metadata.data.clientName : grant.clientId}</td>
								<td>
									<form class="inline" method="post" action={`/grants/${grant.id}/revoke`}>
										<button type="submit">Disconnect</button>
									</form>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</Layout>
	);
}

function ConnectPage(props: { origin: string }) {
	const curl = [
		`curl -X POST ${props.origin}/api/v1/claims`,
		'  -H "Authorization: Bearer ldg_YOUR_TOKEN"',
		'  -H "content-type: application/json"',
		`  -d '{"category":"math","name":"Euler identity"}'`,
	].join(" \\\n");
	return (
		<Layout title="Connect" signedIn>
			<h1>Connect</h1>
			<h2>claude.ai and other MCP clients</h2>
			<p>Add a custom connector with this URL, then sign in when prompted:</p>
			<pre>{`${props.origin}/mcp`}</pre>
			<h2>Scripts and cron jobs</h2>
			<p>
				Create a token on the <a href="/access">Access</a> page, then:
			</p>
			<pre>{curl}</pre>
			<h2>Prompt for your brief</h2>
			<pre>{BRIEF_PROMPT_SNIPPET}</pre>
		</Layout>
	);
}

function AccountPage() {
	return (
		<Layout title="Account" signedIn>
			<h1>Delete account</h1>
			<p>This permanently deletes your topics, repeat history, tokens and connected clients.</p>
			<form method="post" action="/account/delete">
				<label>
					Type <code>delete</code> to confirm <input name="confirm" required />
				</label>{" "}
				<button type="submit">Delete my account</button>
			</form>
		</Layout>
	);
}

async function accessPage(c: Context<WebEnv>, userId: string, newToken?: string) {
	const tokens = await new LedgerStore(c.env.DB).listTokens(userId);
	const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(userId);
	return <AccessPage tokens={tokens} grants={items} newToken={newToken} />;
}

async function revokeAllGrants(c: Context<WebEnv>, userId: string): Promise<void> {
	for (let sweep = 0; sweep < MAX_GRANT_SWEEPS; sweep++) {
		const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(userId);
		if (items.length === 0) return;
		for (const grant of items) await c.env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
	}
	throw new Error(`grants for ${userId} still present after ${MAX_GRANT_SWEEPS} sweeps`);
}

export function registerDashboardRoutes(app: Hono<WebEnv>, deps: WebDeps): void {
	const page = (handler: Handler) => async (c: Context<WebEnv>) => {
		const userId = await currentUserId(c, deps);
		return userId ? handler(c, userId) : c.redirect("/");
	};
	const action = (handler: Handler) => async (c: Context<WebEnv>) => {
		if (!isSameOrigin(c)) {
			return render(c, <ErrorPage title="Forbidden" message="Cross-site request refused." />, 403);
		}
		const userId = await currentUserId(c, deps);
		return userId ? handler(c, userId) : c.redirect("/");
	};

	app.get("/", async (c) =>
		(await currentUserId(c, deps)) ? c.redirect("/ledger") : render(c, <LandingPage />),
	);

	app.get(
		"/ledger",
		page(async (c, userId) => {
			const { entries } = await ledgerFromEnv(c.env).list(userId, { limit: PAGE_LIMIT });
			const aliases = await new LedgerStore(c.env.DB).listAliases(
				userId,
				entries.map((entry) => entry.id),
			);
			return render(c, <LedgerPage entries={entries} aliases={aliasNamesByOriginal(aliases)} />);
		}),
	);

	app.post(
		"/entries/:id/forget",
		action(async (c, userId) => {
			try {
				await ledgerFromEnv(c.env).forget(userId, RouteId.parse(c.req.param("id")));
			} catch (error) {
				if (!(error instanceof LedgerError && error.code === "not_found")) throw error;
			}
			return c.redirect("/ledger");
		}),
	);

	app.get(
		"/repeats",
		page(async (c, userId) => {
			const rows = await new LedgerStore(c.env.DB).topRepeatsForUser(userId, undefined, PAGE_LIMIT);
			return render(c, <MyRepeatsPage rows={rows} />);
		}),
	);

	app.get(
		"/near-misses",
		page(async (c, userId) => {
			const rows = await new LedgerStore(c.env.DB).listNearMisses(userId, PAGE_LIMIT);
			return render(c, <NearMissesPage rows={rows} />);
		}),
	);

	app.get(
		"/global",
		page(async (c, userId) => {
			const minUsers = globalMinUsersFromEnv(c.env);
			const stats = await ledgerFromEnv(c.env).stats(
				userId,
				{ scope: "global", limit: PAGE_LIMIT },
				minUsers,
			);
			return render(c, <GlobalRepeatsPage repeats={stats.repeats} minUsers={minUsers} />);
		}),
	);

	app.get(
		"/access",
		page(async (c, userId) => render(c, await accessPage(c, userId))),
	);

	app.post(
		"/tokens",
		action(async (c, userId) => {
			const form = TokenForm.safeParse(await c.req.parseBody());
			if (!form.success) {
				return render(
					c,
					<ErrorPage title="Invalid label" message="Labels are 1-64 characters." />,
					400,
				);
			}
			const { token } = await createPersonalToken(
				new LedgerStore(c.env.DB),
				userId,
				form.data.label,
				deps.now(),
				() => crypto.randomUUID(),
			);
			// The plaintext token is shown exactly once; keep it out of every cache and back/forward store.
			c.header("Cache-Control", "no-store");
			return render(c, await accessPage(c, userId, token));
		}),
	);

	app.post(
		"/tokens/:id/revoke",
		action(async (c, userId) => {
			await new LedgerStore(c.env.DB).revokeToken(
				userId,
				RouteId.parse(c.req.param("id")),
				deps.now(),
			);
			return c.redirect("/access");
		}),
	);

	app.post(
		"/grants/:id/revoke",
		action(async (c, userId) => {
			await c.env.OAUTH_PROVIDER.revokeGrant(RouteId.parse(c.req.param("id")), userId);
			return c.redirect("/access");
		}),
	);

	app.get(
		"/connect",
		page(async (c) => render(c, <ConnectPage origin={c.env.PUBLIC_ORIGIN} />)),
	);

	app.get(
		"/account",
		page(async (c) => render(c, <AccountPage />)),
	);

	app.post(
		"/account/delete",
		action(async (c, userId) => {
			if (!DeleteForm.safeParse(await c.req.parseBody()).success) {
				return render(
					c,
					<ErrorPage title="Not deleted" message='Type "delete" to confirm.' />,
					400,
				);
			}
			await revokeAllGrants(c, userId);
			await ledgerFromEnv(c.env).deleteAccount(userId);
			deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
			return c.redirect("/");
		}),
	);
}
