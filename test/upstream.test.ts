import { describe, expect, it } from "vitest";
import {
	exchangeUpstreamCode,
	type FetchFn,
	UpstreamError,
	upstreamAuthorizationUrl,
} from "../src/auth/upstream";

const credentials = { clientId: "cid", clientSecret: "secret" };
const redirectUri = "https://ledger.test/callback/github";

const fake: FetchFn = async (input, init) => {
	if (input === "https://github.com/login/oauth/access_token") {
		const code = new URLSearchParams(String(init?.body)).get("code");
		return Response.json(
			code === "good" ? { access_token: "gh" } : { error: "bad_verification_code" },
		);
	}
	if (input === "https://api.github.com/user") {
		return Response.json({ id: 42, login: "octo", name: null, email: "o@example.com" });
	}
	if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "g" });
	if (input === "https://openidconnect.googleapis.com/v1/userinfo") {
		return Response.json({ sub: "g-7", email: "g@example.com", name: "Grace" });
	}
	return new Response("unexpected", { status: 500 });
};

describe("upstreamAuthorizationUrl", () => {
	it("includes client id, redirect, scope and state", () => {
		const url = new URL(upstreamAuthorizationUrl("github", credentials, redirectUri, "st"));
		expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "cid",
			redirect_uri: redirectUri,
			scope: "read:user user:email",
			state: "st",
		});
		const google = new URL(upstreamAuthorizationUrl("google", credentials, redirectUri, "st"));
		expect(google.searchParams.get("scope")).toBe("openid email profile");
		expect(google.searchParams.get("response_type")).toBe("code");
	});
});

describe("exchangeUpstreamCode", () => {
	it("maps GitHub users to a stable numeric subject", async () => {
		expect(await exchangeUpstreamCode("github", credentials, "good", redirectUri, fake)).toEqual({
			provider: "github",
			subject: "42",
			email: "o@example.com",
			displayName: "octo",
		});
	});

	it("maps Google users to their sub", async () => {
		expect(await exchangeUpstreamCode("google", credentials, "any", redirectUri, fake)).toEqual({
			provider: "google",
			subject: "g-7",
			email: "g@example.com",
			displayName: "Grace",
		});
	});

	it("raises UpstreamError when the provider rejects the code", async () => {
		await expect(
			exchangeUpstreamCode("github", credentials, "bad", redirectUri, fake),
		).rejects.toBeInstanceOf(UpstreamError);
	});
});
