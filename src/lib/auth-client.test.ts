import { describe, expect, it } from "vitest";
import { resolveSignedInUser, sessionUser } from "./auth-client";

const dylan = {
	id: "user-1",
	name: "Dylan",
	email: "dylan@example.com",
	image: null,
};

describe("resolveSignedInUser", () => {
	it("shows the login form while get-session is pending when no cookie is expected", () => {
		expect(resolveSignedInUser(null, true, false, null)).toEqual({
			user: null,
			waitForSession: false,
		});
	});

	it("waits only when a cookie is expected and there is no cached profile", () => {
		expect(resolveSignedInUser(null, true, true, null)).toEqual({
			user: null,
			waitForSession: true,
		});
	});

	it("paints the cached profile while get-session is still in flight", () => {
		expect(resolveSignedInUser(null, true, true, dylan)).toEqual({
			user: dylan,
			waitForSession: false,
		});
	});

	it("prefers the live session over the cache", () => {
		const live = { ...dylan, name: "Dylan F" };
		expect(resolveSignedInUser(live, true, true, dylan)).toEqual({
			user: live,
			waitForSession: false,
		});
	});

	it("drops the cache once get-session says signed out", () => {
		expect(resolveSignedInUser(null, false, true, dylan)).toEqual({
			user: null,
			waitForSession: false,
		});
	});
});

describe("sessionUser", () => {
	it("reads a Better Auth session payload", () => {
		expect(sessionUser({ user: dylan, session: { token: "t" } })).toEqual(dylan);
	});

	it("treats the Worker stub as signed out", () => {
		expect(sessionUser({ ok: true })).toBeNull();
	});
});
