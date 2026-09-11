import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginSignOut,
	cancelSignOut,
	clearSessionHint,
	hasSessionHint,
	markOAuthRedirect,
	readCachedUser,
	syncSessionHint,
} from "./session-hint";

afterEach(() => {
	clearSessionHint();
	vi.unstubAllGlobals();
});

describe("session hint", () => {
	const store = new Map<string, string>();

	afterEach(() => {
		store.clear();
	});

	function stubStorage() {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
		});
	}

	const dylan = {
		id: "user-1",
		name: "Dylan",
		email: "dylan@example.com",
		image: "https://example.com/a.png",
	};

	it("is absent until a session is recorded", () => {
		stubStorage();
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
		syncSessionHint(dylan);
		expect(hasSessionHint()).toBe(true);
		expect(readCachedUser()).toEqual(dylan);
		syncSessionHint(null);
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
	});

	it("treats missing localStorage as signed out, without throwing", () => {
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
		expect(() => syncSessionHint(dylan)).not.toThrow();
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
	});

	it("keeps the hint across a late signed-out session while OAuth is leaving", () => {
		stubStorage();
		syncSessionHint(dylan);
		markOAuthRedirect();
		expect(hasSessionHint()).toBe(true);
		expect(readCachedUser()).toEqual(dylan);
		syncSessionHint(null);
		expect(hasSessionHint()).toBe(true);
		expect(readCachedUser()).toEqual(dylan);
		clearSessionHint();
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
	});

	it("does not restore the hint from a stale session after logout starts", () => {
		stubStorage();
		syncSessionHint(dylan);
		beginSignOut();
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
		syncSessionHint(dylan);
		expect(hasSessionHint()).toBe(false);
		expect(readCachedUser()).toBeNull();
		syncSessionHint(null);
		expect(hasSessionHint()).toBe(false);
	});

	it("restores the hint if logout is cancelled and the session is still there", () => {
		stubStorage();
		syncSessionHint(dylan);
		beginSignOut();
		cancelSignOut();
		syncSessionHint(dylan);
		expect(hasSessionHint()).toBe(true);
		expect(readCachedUser()).toEqual(dylan);
	});

	it("ignores a malformed cached profile", () => {
		stubStorage();
		store.set("fork.signed-in", "1");
		store.set("fork.session-user", "{not json");
		expect(readCachedUser()).toBeNull();
		store.set("fork.session-user", JSON.stringify({ email: "x@y.z" }));
		expect(readCachedUser()).toBeNull();
	});
});
