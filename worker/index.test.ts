import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser, handleAuthRequest } from "./auth.js";
import worker from "./index.js";
import { makeDb } from "./testing/d1.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	handleAuthRequest: vi.fn(async () => new Response("auth-ok")),
	ensureDomainUser: vi.fn(async () => {}),
}));

const envWith = (db: D1Database) => ({ DB: db }) as unknown as Env;

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
});
