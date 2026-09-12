import { describe, expect, it } from "vitest";

import { googleProvider, SESSION_COOKIE_CACHE } from "./auth.js";
import { makeDb } from "./testing/d1.js";

function envWith(extras: Record<string, string | undefined> = {}): Env {
	const { db } = makeDb();
	return {
		DB: db,
		BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars",
		GITHUB_CLIENT_ID: "gh-client",
		GITHUB_CLIENT_SECRET: "gh-secret",
		OPENROUTER_API_KEY: "or-key",
		...extras,
	} as unknown as Env;
}

describe("session cookie cache", () => {
	it("is enabled so get-session can skip D1 on revisits", () => {
		expect(SESSION_COOKIE_CACHE).toEqual({
			enabled: true,
			maxAge: 5 * 60,
		});
	});
});

describe("googleProvider", () => {
	it("omits Google when either secret is missing or blank", () => {
		expect(googleProvider(envWith())).toEqual({});
		expect(googleProvider(envWith({ GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com" }))).toEqual(
			{},
		);
		expect(googleProvider(envWith({ GOOGLE_CLIENT_SECRET: "secret" }))).toEqual({});
		expect(googleProvider(envWith({ GOOGLE_CLIENT_ID: "   ", GOOGLE_CLIENT_SECRET: "secret" }))).toEqual(
			{},
		);
	});

	it("enables Google when both secrets are set", () => {
		expect(
			googleProvider(
				envWith({
					GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
					GOOGLE_CLIENT_SECRET: "secret",
				}),
			),
		).toEqual({
			google: {
				clientId: "id.apps.googleusercontent.com",
				clientSecret: "secret",
			},
		});
	});
});
