import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionHint,
	hasSessionHint,
	markOAuthRedirect,
	showSessionPending,
	syncSessionHint,
	writeSessionHint,
} from "./session-hint";

afterEach(() => {
	clearSessionHint();
	vi.unstubAllGlobals();
});

describe("showSessionPending", () => {
	it("does not hide the login form while the session is still unknown", () => {
		expect(showSessionPending(true, false)).toBe(false);
	});

	it("waits when a previous visit said a session should exist", () => {
		expect(showSessionPending(true, true)).toBe(true);
	});

	it("never waits once the session has resolved", () => {
		expect(showSessionPending(false, true)).toBe(false);
		expect(showSessionPending(false, false)).toBe(false);
	});
});

describe("session hint storage", () => {
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

	it("is absent until a session is recorded", () => {
		stubStorage();
		expect(hasSessionHint()).toBe(false);
		writeSessionHint(true);
		expect(hasSessionHint()).toBe(true);
		writeSessionHint(false);
		expect(hasSessionHint()).toBe(false);
	});

	it("treats missing localStorage as signed out, without throwing", () => {
		expect(hasSessionHint()).toBe(false);
		expect(() => writeSessionHint(true)).not.toThrow();
		expect(hasSessionHint()).toBe(false);
	});

	it("keeps the hint across a late signed-out session while OAuth is leaving", () => {
		stubStorage();
		markOAuthRedirect();
		expect(hasSessionHint()).toBe(true);
		syncSessionHint(false);
		expect(hasSessionHint()).toBe(true);
		clearSessionHint();
		expect(hasSessionHint()).toBe(false);
	});

	it("records a confirmed session and clears a confirmed miss", () => {
		stubStorage();
		syncSessionHint(true);
		expect(hasSessionHint()).toBe(true);
		syncSessionHint(false);
		expect(hasSessionHint()).toBe(false);
	});
});
