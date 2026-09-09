import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "./auth.js";
import { chatRow, makeDb, messageRow } from "./testing/d1.js";
import { handleTreeRequest } from "./tree-routes.js";
import { GC_ROOT_SQL } from "./tree.js";
import { MAX_TITLE } from "./tree-types.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	ensureDomainUser: vi.fn(async () => {}),
}));

const envWith = (db: D1Database) => ({ DB: db }) as unknown as Env;

const leafRow = (overrides: Parameters<typeof messageRow>[0] = {}) =>
	messageRow({
		id: "m2",
		parent_id: "m1",
		depth: 1,
		role: "assistant",
		status: "done",
		content: "hello",
		created_at: 2,
		...overrides,
	});

function request(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost:5173${path}`, init);
}

describe("handleTreeRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "user@example.com" });
	});

	it("returns 401 without a session", async () => {
		vi.mocked(getSessionUser).mockResolvedValueOnce(null);
		const { db } = makeDb({});
		const response = await handleTreeRequest(request("/api/chats?summary=1"), envWith(db), null);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ ok: false, error: "Unauthorized" });
	});

	it("summary route returns chats without a messages key", async () => {
		const { db, statements } = makeDb({
			all: async () => ({
				results: [
					{
						...chatRow(),
						leaf_status: "done",
						leaf_created_at: 2,
					},
				],
			}),
		});
		const response = await handleTreeRequest(request("/api/chats?summary=1"), envWith(db), null);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("messages");
		expect(body.chats).toEqual([
			{
				id: "chat-1",
				title: "Test chat",
				rootId: "m1",
				leafId: "m2",
				generating: false,
				createdAt: 1,
				updatedAt: 2,
			},
		]);
		const chats = body.chats as Record<string, unknown>[];
		expect(chats[0]).not.toHaveProperty("messages");
		expect(statements[0]?.sql).toMatch(/LEFT JOIN messages leaf ON leaf.id = c.leaf_id/);
		expect(statements[0]?.params).toEqual(["user-1"]);
	});

	it("returns 405 for non-GET on the summary route", async () => {
		const { db } = makeDb({});
		const response = await handleTreeRequest(
			request("/api/chats?summary=1", { method: "POST" }),
			envWith(db),
			null,
		);
		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ ok: false, error: "Method not allowed" });
	});

	it("GET returns 404 for an unknown id", async () => {
		const { db } = makeDb({
			first: async () => undefined,
		});
		const response = await handleTreeRequest(request("/api/chats/missing"), envWith(db), "missing");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
	});

	it("GET returns the summary and path for a known chat", async () => {
		const { db } = makeDb({
			first: async (sql) => {
				if (sql.includes("FROM chats")) {
					return chatRow();
				}
				if (sql.includes("FROM messages") && !sql.includes("WITH RECURSIVE")) {
					return leafRow();
				}
				return undefined;
			},
			all: async () => ({
				results: [
					{
						id: "m1",
						user_id: "user-1",
						root_id: "m1",
						parent_id: null,
						depth: 0,
						role: "user",
						status: "done",
						content: "hi",
						reasoning: null,
						citations: null,
						tool_calls: null,
						created_at: 1,
					},
					leafRow(),
				],
			}),
		});
		const response = await handleTreeRequest(request("/api/chats/chat-1"), envWith(db), "chat-1");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chat: { id: string; leafId: string };
			messages: { id: string }[];
		};
		expect(body.chat.id).toBe("chat-1");
		expect(body.chat.leafId).toBe("m2");
		expect(body.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
	});

	it("PATCH rejects invalid titles", async () => {
		const { db } = makeDb({});

		const notObject = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify("nope"),
			}),
			envWith(db),
			"chat-1",
		);
		expect(notObject.status).toBe(400);
		expect(await notObject.json()).toEqual({ ok: false, error: "Invalid JSON body" });

		const missing = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
			envWith(db),
			"chat-1",
		);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ ok: false, error: "title must be a string" });

		const empty = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "   " }),
			}),
			envWith(db),
			"chat-1",
		);
		expect(empty.status).toBe(400);
		expect(await empty.json()).toEqual({ ok: false, error: "title must not be empty" });

		const tooLong = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "x".repeat(MAX_TITLE + 1) }),
			}),
			envWith(db),
			"chat-1",
		);
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toEqual({ ok: false, error: "title is too long" });
	});

	it("PATCH returns 404 when the update changes 0 rows", async () => {
		const { db } = makeDb({
			run: async () => ({ meta: { changes: 0 } }),
		});
		const response = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Renamed" }),
			}),
			envWith(db),
			"chat-1",
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
	});

	it("PATCH updates title only and does not touch leaf_id", async () => {
		const { db, statements } = makeDb({
			first: async (sql) => {
				if (sql.includes("FROM chats")) {
					return chatRow({ title: "Renamed", updated_at: 99 });
				}
				return leafRow();
			},
		});
		const response = await handleTreeRequest(
			request("/api/chats/chat-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "  Renamed  " }),
			}),
			envWith(db),
			"chat-1",
		);
		expect(response.status).toBe(200);
		const update = statements.find((statement) => statement.sql.includes("UPDATE chats"));
		expect(update).toBeDefined();
		expect(update?.sql).not.toMatch(/leaf_id/);
		expect(update?.params[0]).toBe("Renamed");
		expect(update?.params[2]).toBe("chat-1");
		expect(update?.params[3]).toBe("user-1");
		const body = (await response.json()) as { chat: { title: string; leafId: string } };
		expect(body.chat.title).toBe("Renamed");
		expect(body.chat.leafId).toBe("m2");
		expect(body).not.toHaveProperty("messages");
	});

	it("DELETE returns 404 when the chat is missing", async () => {
		const { db, batch } = makeDb({
			first: async () => undefined,
		});
		const response = await handleTreeRequest(
			request("/api/chats/chat-1", { method: "DELETE" }),
			envWith(db),
			"chat-1",
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
		expect(batch).not.toHaveBeenCalled();
	});

	it("DELETE batches the pointer delete first, then gc", async () => {
		const { db, statements, batch } = makeDb({
			first: async () => chatRow(),
		});
		const response = await handleTreeRequest(
			request("/api/chats/chat-1", { method: "DELETE" }),
			envWith(db),
			"chat-1",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(batch).toHaveBeenCalledTimes(1);
		const batched = statements.filter(
			(statement) =>
				statement.sql.includes("DELETE FROM chats") || statement.sql.includes("DELETE FROM messages"),
		);
		expect(batched[0]?.sql).toMatch(/DELETE FROM chats WHERE id = \? AND user_id = \?/);
		expect(batched[0]?.params).toEqual(["chat-1", "user-1"]);
		expect(batched[1]?.sql).toBe(GC_ROOT_SQL);
		expect(batched[1]?.sql).toMatch(/WITH RECURSIVE reach/);
		expect(batched[1]?.params).toEqual(["user-1", "m1", "user-1", "m1"]);
	});

	it("DELETE returns 500 when the batch throws", async () => {
		const { db } = makeDb({
			first: async () => chatRow(),
			batch: async () => {
				throw new Error("fk");
			},
		});
		const response = await handleTreeRequest(
			request("/api/chats/chat-1", { method: "DELETE" }),
			envWith(db),
			"chat-1",
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ ok: false, error: "Could not delete chat" });
	});
});
