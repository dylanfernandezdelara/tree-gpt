import { describe, expect, it } from "vitest";
import { redirectToAppOrigin, resolveAuthOrigins } from "./origins.js";

const env = (appOrigin?: string) =>
	({ APP_ORIGIN: appOrigin } as unknown as Env);

describe("resolveAuthOrigins", () => {
	it("uses the request origin when APP_ORIGIN is unset", () => {
		expect(resolveAuthOrigins(env(), "http://localhost:5173")).toEqual({
			baseURL: "http://localhost:5173",
			trustedOrigins: ["http://localhost:5173"],
		});
	});

	it("ignores APP_ORIGIN on loopback so npm run dev still works", () => {
		expect(
			resolveAuthOrigins(env("https://forkgpt.app"), "http://localhost:5173"),
		).toEqual({
			baseURL: "http://localhost:5173",
			trustedOrigins: ["http://localhost:5173"],
		});
	});

	it("pins production when the request is already on APP_ORIGIN", () => {
		expect(
			resolveAuthOrigins(env("https://forkgpt.app"), "https://forkgpt.app"),
		).toEqual({
			baseURL: "https://forkgpt.app",
			trustedOrigins: ["https://forkgpt.app"],
		});
	});

	it("does not pin preview or workers.dev hosts", () => {
		expect(
			resolveAuthOrigins(
				env("https://forkgpt.app"),
				"https://treegpt.example.workers.dev",
			),
		).toEqual({
			baseURL: "https://treegpt.example.workers.dev",
			trustedOrigins: ["https://treegpt.example.workers.dev"],
		});
	});

	it("falls back to the request origin when APP_ORIGIN is unparseable", () => {
		expect(
			resolveAuthOrigins(env("not a url"), "https://forkgpt.app"),
		).toEqual({
			baseURL: "https://forkgpt.app",
			trustedOrigins: ["https://forkgpt.app"],
		});
	});
});

describe("redirectToAppOrigin", () => {
	it("redirects www of APP_ORIGIN to the apex", () => {
		const next = redirectToAppOrigin(
			new URL("https://www.forkgpt.app/api/auth/ok?x=1"),
			env("https://forkgpt.app"),
		);
		expect(next?.href).toBe("https://forkgpt.app/api/auth/ok?x=1");
	});

	it("leaves the apex and other hosts alone", () => {
		expect(
			redirectToAppOrigin(new URL("https://forkgpt.app/"), env("https://forkgpt.app")),
		).toBeNull();
		expect(
			redirectToAppOrigin(
				new URL("https://www.localhost/"),
				env("https://forkgpt.app"),
			),
		).toBeNull();
	});
});
