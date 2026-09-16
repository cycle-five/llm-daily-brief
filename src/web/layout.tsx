import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { WebEnv } from "./guards";

const STYLES = `
body { font-family: system-ui, sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; padding: 0.75rem 1rem; background: #fff; border-bottom: 1px solid #d0d7de; }
header nav { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
main { max-width: 48rem; margin: 0 auto; padding: 1rem; }
table { width: 100%; border-collapse: collapse; background: #fff; }
td, th { text-align: left; padding: 0.4rem; border-bottom: 1px solid #d0d7de; vertical-align: top; }
form.inline { display: inline; }
button { cursor: pointer; }
code, pre { background: #fff; border: 1px solid #d0d7de; padding: 0.2rem 0.4rem; overflow-x: auto; white-space: pre-wrap; }
.brand { font-weight: 700; text-decoration: none; color: inherit; }
`;

export function Layout(props: { title: string; signedIn?: boolean; children?: Child }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{`${props.title} · Topic Ledger`}</title>
				<style>{STYLES}</style>
			</head>
			<body>
				<header>
					<a class="brand" href="/">
						Topic Ledger
					</a>
					{props.signedIn ? (
						<nav>
							<a href="/ledger">Ledger</a>
							<a href="/repeats">Repeats</a>
							<a href="/near-misses">Near misses</a>
							<a href="/overlaps">Overlaps</a>
							<a href="/global">Global</a>
							<a href="/access">Access</a>
							<a href="/connect">Connect</a>
							<a href="/account">Account</a>
							<form class="inline" method="post" action="/logout">
								<button type="submit">Sign out</button>
							</form>
						</nav>
					) : null}
				</header>
				<main>{props.children}</main>
			</body>
		</html>
	);
}

export function ErrorPage(props: { title: string; message: string }) {
	return (
		<Layout title={props.title}>
			<h1>{props.title}</h1>
			<p>{props.message}</p>
		</Layout>
	);
}

export function render(c: Context<WebEnv>, page: Child, status: 200 | 400 | 403 | 404 | 502 = 200) {
	return c.html(
		<>
			{raw("<!doctype html>")}
			{page}
		</>,
		status,
	);
}
