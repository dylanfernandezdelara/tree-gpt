import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginSignOut,
	cancelSignOut,
	clearSessionHint,
	hasSessionHint,
	markOAuthRedirect,
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

	it("is absent until a session is recorded", () => {
		stubStorage();
		expect(hasSessionHint()).toBe(false);
		syncSessionHint(true);
		expect(hasSessionHint()).toBe(true);
		syncSessionHint(false);
		expect(hasSessionHint()).toBe(false);
	});

	it("treats missing localStorage as signed out, without throwing", () => {
		expect(hasSessionHint()).toBe(false);
		expect(() => syncSessionHint(true)).not.toThrow();
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

	it("does not restore the hint from a stale session after logout starts", () => {
		stubStorage();
		syncSessionHint(true);
		beginSignOut();
		expect(hasSessionHint()).toBe(false);
		syncSessionHint(true);
		expect(hasSessionHint()).toBe(false);
		syncSessionHint(false);
		expect(hasSessionHint()).toBe(false);
	});

	it("restores the hint if logout is cancelled and the session is still there", () => {
		stubStorage();
		syncSessionHint(true);
		beginSignOut();
		cancelSignOut();
		syncSessionHint(true);
		expect(hasSessionHint()).toBe(true);
	});
});
