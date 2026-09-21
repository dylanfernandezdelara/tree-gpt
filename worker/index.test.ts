import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser, handleAuthRequest } from "./auth.js";
import worker, { rejectUnsafeRequest, serveHashedAsset, withApiHeaders } from "./index.js";
import { makeDb } from "./testing/d1.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	handleAuthRequest: vi.fn(async () => new Response("auth-ok")),
	ensureDomainUser: vi.fn(async () => {}),
}));

const envWith = (db: D1Database, assets?: { fetch(request: Request): Promise<Response> }) =>
	({ DB: db, ...(assets ? { ASSETS: assets } : {}) }) as unknown as Env;

function ctx() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

describe("worker fetch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "user@example.com" });
		vi.mocked(handleAuthRequest).mockResolvedValue(new Response("auth-ok"));
	});

	it("returns JSON 500 for unexpected throws on /api/ routes", async () => {
		vi.mocked(getSessionUser).mockRejectedValueOnce(new Error("d1 exploded"));
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/chats/chat-1/turns", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ ok: false, error: "Internal error" });
	});

	it("does not wrap /api/auth in the JSON 500 handler", async () => {
		vi.mocked(handleAuthRequest).mockRejectedValueOnce(new Error("auth boom"));
		const { db } = makeDb({});
		await expect(
			worker.fetch(new Request("http://localhost:5173/api/auth/ok"), envWith(db), ctx()),
		).rejects.toThrow("auth boom");
	});

	it("routes every method on /api/chats?summary=1 to the tree 405", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/chats?summary=1", { method: "POST" }),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ ok: false, error: "Method not allowed" });
	});

	it("routes unknown methods on /api/chats/:id to the tree 405", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/chats/chat-1", { method: "POST" }),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ ok: false, error: "Method not allowed" });
	});

	it("answers unknown /api paths with 404 instead of a stub 200", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/anything-else"),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
		expect(getSessionUser).not.toHaveBeenCalled();
	});

	it("marks every /api response no-store and nosniff", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/chats?summary=1"),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("passes a real hashed asset through unchanged", async () => {
		const { db } = makeDb({});
		const js = new Response("export default 1", {
			headers: { "Content-Type": "text/javascript" },
		});
		const fetchAsset = vi.fn(async () => js);
		const response = await worker.fetch(
			new Request("http://localhost:5173/assets/ChatApp-abc.js"),
			envWith(db, { fetch: fetchAsset }),
			ctx(),
		);
		expect(fetchAsset).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("javascript");
		expect(await response.text()).toBe("export default 1");
	});

	it("forwards a hashed-asset 304 from the assets binding", async () => {
		const { db } = makeDb({});
		const notModified = new Response(null, {
			status: 304,
			headers: { ETag: '"abc"' },
		});
		const fetchAsset = vi.fn(async () => notModified);
		const response = await worker.fetch(
			new Request("http://localhost:5173/assets/ChatApp-abc.js", {
				headers: { "If-None-Match": '"abc"' },
			}),
			envWith(db, { fetch: fetchAsset }),
			ctx(),
		);
		expect(fetchAsset).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe('"abc"');
	});

	it("forwards an asset-binding 5xx from /assets/", async () => {
		const { db } = makeDb({});
		const unavailable = new Response("unavailable", { status: 503 });
		const fetchAsset = vi.fn(async () => unavailable);
		const response = await worker.fetch(
			new Request("http://localhost:5173/assets/ChatApp-abc.js"),
			envWith(db, { fetch: fetchAsset }),
			ctx(),
		);
		expect(fetchAsset).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("unavailable");
	});

	it("404s a hashed asset miss instead of caching the SPA shell as JavaScript", async () => {
		const { db } = makeDb({});
		const html = new Response("<!doctype html><title>Fork</title>", {
			status: 200,
			headers: { "Content-Type": "text/html; charset=UTF-8" },
		});
		const response = await worker.fetch(
			new Request("http://localhost:5173/assets/ChatApp-missing.js"),
			envWith(db, { fetch: async () => html }),
			ctx(),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Type")).not.toContain("text/html");
		expect(await response.text()).toBe("Not found");
	});

	it("keeps a handler's own Cache-Control when it sets one", async () => {
		const sse = withApiHeaders(
			new Response("data: x\n\n", {
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
			}),
		);
		expect(sse.headers.get("Cache-Control")).toBe("no-cache");
		expect(sse.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await sse.text()).toBe("data: x\n\n");
	});
});

describe("serveHashedAsset", () => {
	it("keeps a successful JS or CSS body", async () => {
		const js = serveHashedAsset(
			new Response("ok", { headers: { "Content-Type": "text/javascript; charset=UTF-8" } }),
		);
		expect(js.status).toBe(200);
		expect(await js.text()).toBe("ok");
		const css = serveHashedAsset(
			new Response("body{}", { headers: { "Content-Type": "text/css" } }),
		);
		expect(css.status).toBe(200);
		expect(await css.text()).toBe("body{}");
	});

	it("turns the SPA HTML fallback into an uncacheable 404", async () => {
		const response = serveHashedAsset(
			new Response("<!doctype html>", {
				headers: { "Content-Type": "text/html" },
			}),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe("Not found");
	});

	it("does not cache a binding 404 as HTML either", async () => {
		const response = serveHashedAsset(new Response(null, { status: 404 }));
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("forwards a 304 revalidation hit", async () => {
		const notModified = new Response(null, {
			status: 304,
			headers: { ETag: '"abc"' },
		});
		const response = serveHashedAsset(notModified);
		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe('"abc"');
		expect(await response.text()).toBe("");
	});

	it("forwards an asset-binding 5xx instead of rewriting it as a miss", async () => {
		const upstream = new Response("unavailable", { status: 503 });
		const response = serveHashedAsset(upstream);
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("unavailable");
	});
});

describe("rejectUnsafeRequest", () => {
	const url = new URL("http://localhost:5173/api/chats/chat-1/turns");

	function post(headers: Record<string, string>, method = "POST"): Request {
		return new Request(url, { method, headers, body: method === "GET" ? undefined : "{}" });
	}

	it("refuses writes whose Origin does not match the request origin", async () => {
		const response = rejectUnsafeRequest(post({ Origin: "https://evil.example" }), url);
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({ ok: false, error: "Cross-origin request refused" });
	});

	it("treats the opaque \"null\" Origin as cross-origin", () => {
		expect(rejectUnsafeRequest(post({ Origin: "null" }), url)?.status).toBe(403);
	});

	it("applies to every mutating method", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const response = rejectUnsafeRequest(
				post({ Origin: "https://evil.example" }, method),
				url,
			);
			expect(response?.status).toBe(403);
		}
	});

	it("lets same-origin writes and Origin-less clients through", () => {
		expect(rejectUnsafeRequest(post({ Origin: "http://localhost:5173" }), url)).toBeNull();
		expect(rejectUnsafeRequest(post({}), url)).toBeNull();
	});

	it("ignores Origin on reads", () => {
		expect(rejectUnsafeRequest(post({ Origin: "https://evil.example" }, "GET"), url)).toBeNull();
	});

	it("refuses bodies declared larger than the API cap before parsing", async () => {
		const response = rejectUnsafeRequest(
			post({ "Content-Length": String(9 * 1024 * 1024) }),
			url,
		);
		expect(response?.status).toBe(413);
		expect(await response?.json()).toEqual({ ok: false, error: "Request body is too large" });
		expect(rejectUnsafeRequest(post({ "Content-Length": String(4 * 1024 * 1024) }), url)).toBeNull();
	});

	it("is wired in front of the session check on the worker", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/chats/chat-1", {
				method: "PATCH",
				headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
				body: JSON.stringify({ title: "pwned" }),
			}),
			envWith(db),
			ctx(),
		);
		expect(response.status).toBe(403);
		expect(getSessionUser).not.toHaveBeenCalled();
		expect(db.prepare).not.toHaveBeenCalled();
	});

	it("leaves /api/auth to Better Auth's own origin checks", async () => {
		const { db } = makeDb({});
		const response = await worker.fetch(
			new Request("http://localhost:5173/api/auth/sign-in/social", {
				method: "POST",
				headers: { Origin: "https://evil.example" },
				body: "{}",
			}),
			envWith(db),
			ctx(),
		);
		expect(handleAuthRequest).toHaveBeenCalledTimes(1);
		expect(await response.text()).toBe("auth-ok");
	});
});
