import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useSignedInUser } from "./lib/auth-client";

vi.mock("./lib/auth-client", () => ({
	useSignedInUser: vi.fn(),
}));

vi.mock("./lib/session-hint", () => ({
	hasSessionHint: () => false,
}));

import App from "./App";

describe("App auth gate", () => {
	it("shows the login form when no session is expected", () => {
		vi.mocked(useSignedInUser).mockReturnValue({ user: null, waitForSession: false });
		const html = renderToStaticMarkup(createElement(App));
		expect(html).toContain("Log in");
		expect(html).not.toContain("Checking");
	});

	it("does not mount the login art while waiting for a returning session", () => {
		vi.mocked(useSignedInUser).mockReturnValue({ user: null, waitForSession: true });
		const html = renderToStaticMarkup(createElement(App));
		expect(html).not.toContain("Log in");
		expect(html).not.toContain("Checking");
		expect(html).toContain("aria-busy");
	});
});
