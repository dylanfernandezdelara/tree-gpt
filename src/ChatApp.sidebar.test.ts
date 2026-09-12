import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
	};
}

function stubMatchMedia(mobile: boolean) {
	const matchMedia = (query: string) => ({
		matches: mobile && query.includes("max-width: 768px"),
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	});
	vi.stubGlobal("matchMedia", matchMedia);
	vi.stubGlobal("window", { matchMedia });
}

vi.stubGlobal("localStorage", memoryStorage());
stubMatchMedia(false);

import { SIDEBAR_PREF_REV } from "./lib/storage";
import ChatApp from "./ChatApp";

const user = { id: "u1", name: "Dylan", email: "d@example.com", image: null };

describe("ChatApp sidebar first paint", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.stubGlobal("localStorage", memoryStorage());
		stubMatchMedia(false);
	});

	it("opens the sidebar on desktop when the user has never collapsed it", () => {
		const html = renderToStaticMarkup(createElement(ChatApp, { user }));
		expect(html).toContain('class="sidebar"');
		expect(html).not.toContain("sidebar--closed");
		expect(html).not.toContain("Open sidebar");
	});

	it("treats a legacy auto-saved closed sidebar as expanded on desktop", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({ "treegpt.ui.v1": JSON.stringify({ sidebarOpen: false }) }),
		);
		const html = renderToStaticMarkup(createElement(ChatApp, { user }));
		expect(html).not.toContain("sidebar--closed");
	});

	it("keeps the sidebar closed when the user collapsed it", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({
				"treegpt.ui.v1": JSON.stringify({ sidebarOpen: false, sidebarPrefRev: SIDEBAR_PREF_REV }),
			}),
		);
		const html = renderToStaticMarkup(createElement(ChatApp, { user }));
		expect(html).toContain("sidebar--closed");
		expect(html).toContain("Open sidebar");
	});

	it("starts closed on mobile when the user has never toggled", () => {
		stubMatchMedia(true);
		const html = renderToStaticMarkup(createElement(ChatApp, { user }));
		expect(html).toContain("sidebar--closed");
	});

	it("stays expanded on mobile after the user expanded it", () => {
		stubMatchMedia(true);
		vi.stubGlobal(
			"localStorage",
			memoryStorage({
				"treegpt.ui.v1": JSON.stringify({ sidebarOpen: true, sidebarPrefRev: SIDEBAR_PREF_REV }),
			}),
		);
		const html = renderToStaticMarkup(createElement(ChatApp, { user }));
		expect(html).not.toContain("sidebar--closed");
	});
});
