import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { ModelLabel, type RepeatStat } from "../api/schemas";
import { SESSION_COOKIE } from "../auth/session";
import { createPersonalToken } from "../auth/tokens";
import { globalMinUsersFromEnv } from "../config";
import { LedgerError } from "../core/errors";
import { sameModel } from "../core/match";
import type { EntryRow, TokenRow } from "../core/rows";
import { toIso } from "../core/wire";
import { ledgerFromEnv } from "../services";
import {
	LedgerStore,
	type ModelSummaryRow,
	type NearMissView,
	type OverlapView,
	type UserRepeatRow,
} from "../store/d1";
import { currentUserId, isSameOrigin, type WebDeps, type WebEnv } from "./guards";
import { ErrorPage, Layout, render } from "./layout";
import { BRIEF_PROMPT_SNIPPET } from "./prompt";

const TokenForm = z.object({ label: z.string().trim().min(1).max(64) });
const DeleteForm = z.object({ confirm: z.literal("delete") });
const ShareForm = z.object({ share: z.enum(["on", "off"]) });
const ViewQuery = z.enum(["split", "combined"]).catch("split");
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

function modelLabel(model: string, version: string | null): string {
	return version === null ? model : `${model} (${version})`;
}

/** True when both names are present and name different models. */
function differentModels(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && !sameModel(a, b);
}

/**
 * Hits over attempts. Every attempt ends as a kept original, a blocked hit, or a skip (an alias,
 * which is no longer an original, plus a hit), so originals plus hits counts attempts.
 */
export function formatRepeatRate(originals: number, hits: number): string {
	const attempts = originals + hits;
	return attempts === 0 ? "—" : `${Math.round((hits / attempts) * 100)}%`;
}

function LedgerPage(props: {
	entries: EntryRow[];
	aliases: ReadonlyMap<string, string[]>;
	model: string | undefined;
}) {
	return (
		<Layout title="Ledger" signedIn>
			<h1>Ledger</h1>
			{props.model === undefined ? null : (
				<p>
					{`Showing topics from ${props.model}.`} <a href="/ledger">Show all</a>
				</p>
			)}
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
							<th>Model</th>
							<th>Claimed</th>
							<th>Repeats</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{props.entries.map((entry) => {
							const aliases = props.aliases.get(entry.id) ?? [];
							const showClient =
								entry.client !== null &&
								(entry.model === null || !sameModel(entry.client, entry.model));
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
									<td>
										{entry.model === null ? (
											"—"
										) : (
											<a href={`/ledger?model=${encodeURIComponent(entry.model)}`}>
												{modelLabel(entry.model, entry.model_version)}
											</a>
										)}
										{showClient ? (
											<>
												<br />
												<small>{`connection: ${entry.client}`}</small>
											</>
										) : null}
									</td>
									<td>{toIso(entry.created_at).slice(0, 10)}</td>
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
									{differentModels(row.claim_model, row.matched_model) ? (
										<>
											<br />
											<small>{`from ${row.matched_model}`}</small>
										</>
									) : null}
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

function OverlapTable(props: { rows: OverlapView[] }) {
	return (
		<table>
			<thead>
				<tr>
					<th>Date</th>
					<th>Topic</th>
					<th>Model</th>
					<th>Matched topic</th>
					<th>Model</th>
					<th>Match</th>
					<th>Score</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row) => (
					<tr>
						<td>{toIso(row.created_at).slice(0, 10)}</td>
						<td>{row.claim_name}</td>
						<td>{row.claim_model ?? "—"}</td>
						<td>
							{row.matched_name}
							{row.via_name === null ? null : (
								<>
									<br />
									<small>{`via ${row.via_name}`}</small>
								</>
							)}
						</td>
						<td>{row.matched_model ?? "—"}</td>
						<td>{row.match_kind}</td>
						<td>{row.score.toFixed(2)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function OverlapsPage(props: {
	rows: OverlapView[];
	view: "split" | "combined";
	shareLedger: boolean;
}) {
	const lexical = props.rows.filter((row) => row.match_kind !== "semantic");
	const similar = props.rows.filter((row) => row.match_kind === "semantic");
	return (
		<Layout title="Overlaps" signedIn>
			<h1>Overlaps between models</h1>
			<p>Topics one model claimed that another model had already covered.</p>
			{props.shareLedger ? (
				<p>
					Your models share one ledger, so a match between models blocks the claim instead of
					recording an overlap. Those appear on <a href="/repeats">Repeats</a>. Change this on the{" "}
					<a href="/account">Account</a> page.
				</p>
			) : null}
			{props.rows.length === 0 ? (
				<p>No overlaps yet.</p>
			) : props.view === "combined" ? (
				<>
					<p>
						<a href="/overlaps">Split by match type</a>
					</p>
					<OverlapTable rows={props.rows} />
				</>
			) : (
				<>
					<p>
						<a href="/overlaps?view=combined">Combine into one list</a>
					</p>
					<h2>Overlaps</h2>
					{lexical.length === 0 ? <p>None.</p> : <OverlapTable rows={lexical} />}
					<h2>Similar, unverified</h2>
					<p>Matched by meaning only, so these may be different topics.</p>
					{similar.length === 0 ? <p>None.</p> : <OverlapTable rows={similar} />}
				</>
			)}
			<p>Showing the newest {PAGE_LIMIT} overlaps.</p>
		</Layout>
	);
}

function ModelSummaryTable(props: { rows: ModelSummaryRow[] }) {
	return (
		<table>
			<thead>
				<tr>
					<th>Model</th>
					<th>Topics</th>
					<th>Repeats</th>
					<th>Repeat rate</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row) => (
					<tr>
						<td>{row.label ?? "Unattributed"}</td>
						<td>{row.originals}</td>
						<td>{row.hits}</td>
						<td>{formatRepeatRate(row.originals, row.hits)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function MyRepeatsPage(props: { rows: UserRepeatRow[]; summary: ModelSummaryRow[] }) {
	return (
		<Layout title="Your repeats" signedIn>
			<h1>Your repeats</h1>
			{props.summary.length === 0 ? null : (
				<>
					<h2>By model</h2>
					<p>The repeat rate is repeats over attempts: every claim the model made, kept or not.</p>
					<ModelSummaryTable rows={props.summary} />
					<h2>Topics</h2>
				</>
			)}
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
														<td>
															{hit.candidate_text}
															{differentModels(hit.model, row.entry.model) ? (
																<>
																	{" "}
																	<small>{`by ${hit.model}`}</small>
																</>
															) : null}
														</td>
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
		`  -d '{"category":"math","name":"Euler identity","model":"cron"}'`,
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
			<p>
				<code>model</code> is optional over REST and defaults to the token's label.
			</p>
			<h2>Prompt for your brief</h2>
			<pre>{BRIEF_PROMPT_SNIPPET}</pre>
		</Layout>
	);
}

function AccountPage(props: { shareLedger: boolean }) {
	return (
		<Layout title="Account" signedIn>
			<h1>Account</h1>
			<h2>Share one ledger across all my models</h2>
			<p>
				{props.shareLedger
					? "On: a topic any of your models has claimed is a repeat for all of them."
					: "Off: each model is blocked only by its own topics, and matches between models are recorded as overlaps."}
			</p>
			<form method="post" action="/account/ledger-sharing">
				<input type="hidden" name="share" value={props.shareLedger ? "off" : "on"} />
				<button type="submit">{props.shareLedger ? "Turn sharing off" : "Turn sharing on"}</button>
			</form>
			<h2>Delete account</h2>
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
			const filter = ModelLabel.safeParse(c.req.query("model"));
			const model = filter.success ? filter.data : undefined;
			const store = new LedgerStore(c.env.DB);
			const entries = await store.listEntries(userId, { limit: PAGE_LIMIT, model });
			const aliases = await store.listAliases(
				userId,
				entries.map((entry) => entry.id),
			);
			return render(
				c,
				<LedgerPage entries={entries} aliases={aliasNamesByOriginal(aliases)} model={model} />,
			);
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
			const store = new LedgerStore(c.env.DB);
			const rows = await store.topRepeatsForUser(userId, undefined, PAGE_LIMIT);
			const summary = await store.modelSummary(userId);
			return render(c, <MyRepeatsPage rows={rows} summary={summary} />);
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
		"/overlaps",
		page(async (c, userId) => {
			const store = new LedgerStore(c.env.DB);
			const rows = await store.listOverlaps(userId, PAGE_LIMIT);
			const user = await store.getUser(userId);
			return render(
				c,
				<OverlapsPage
					rows={rows}
					view={ViewQuery.parse(c.req.query("view"))}
					shareLedger={user?.share_ledger ?? true}
				/>,
			);
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
		page(async (c, userId) => {
			const user = await new LedgerStore(c.env.DB).getUser(userId);
			return render(c, <AccountPage shareLedger={user?.share_ledger ?? true} />);
		}),
	);

	app.post(
		"/account/ledger-sharing",
		action(async (c, userId) => {
			const form = ShareForm.safeParse(await c.req.parseBody());
			if (!form.success) {
				return render(c, <ErrorPage title="Not changed" message="Choose on or off." />, 400);
			}
			await new LedgerStore(c.env.DB).setShareLedger(userId, form.data.share === "on");
			return c.redirect("/account");
		}),
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
