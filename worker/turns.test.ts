/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "./auth.js";
import { makeDb } from "./testing/d1.js";
import { loadPath, summaryFor, type ChatRow, type MessageRow } from "./tree.js";
import type { ChatSummary } from "./tree-types.js";
import { PENDING_TIMEOUT_MS } from "./tree-types.js";
import { abandonTurn, handleTurnRequest, planTurn, reserveTurn } from "./turns.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	ensureDomainUser: vi.fn(async () => {}),
}));

vi.mock("./tree.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tree.js")>();
	return {
		...actual,
		loadPath: vi.fn(async () => [
			{ id: "u2", role: "user", content: "hello", createdAt: 1 },
			{ id: "a2", role: "assistant", content: "Hello, it's wonderful meeting you", createdAt: 2 },
		]),
		summaryFor: vi.fn((chat: ChatRow, _leaf: MessageRow | null, _now: number): ChatSummary => ({
			id: chat.id,
			title: chat.title,
			rootId: chat.root_id,
			leafId: chat.leaf_id,
			generating: false,
			createdAt: chat.created_at,
			updatedAt: chat.updated_at,
		})),
	};
});

const envWith = (db: D1Database, extra: Record<string, unknown> = {}) =>
	({
		DB: db,
		OPENROUTER_API_KEY: "test-key",
		...extra,
	}) as unknown as Env;

function makeCtx() {
	const promises: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: vi.fn((p: Promise<unknown>) => {
			promises.push(p);
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
	return { ctx, promises };
}

function turnRequest(chatId: string, body: unknown, method = "POST") {
	return new Request(`http://localhost:5173/api/chats/${chatId}/turns`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});
}

const appendBody = {
	parentId: "a1",
	expectLeaf: "a1",
	userMessage: { id: "u2", content: "hello" },
	replyId: "a2",
};

const sourceChat: ChatRow = {
	id: "chat-1",
	user_id: "user-1",
	root_id: "u1",
	leaf_id: "a1",
	title: "Test chat",
	created_at: 1,
	updated_at: 2,
};

const parentLeaf: MessageRow = {
	id: "a1",
	user_id: "user-1",
	root_id: "u1",
	parent_id: "u1",
	depth: 1,
	role: "assistant",
	status: "done",
	content: "prior",
	reasoning: "display-only, must not go upstream",
	created_at: 1,
};

const userParent: MessageRow = {
	id: "u1",
	user_id: "user-1",
	root_id: "u1",
	parent_id: null,
	depth: 0,
	role: "user",
	status: "done",
	content: "first",
	reasoning: null,
	created_at: 1,
};

const pathMessages = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: "prior" },
	{ role: "user", content: "hello" },
];

function fixtureResponse() {
	return new Response(readFileSync(join(import.meta.dirname, "testdata", "muse-minimal.sse")), {
		status: 200,
	});
}

function sseResponse(frames: string) {
	return new Response(frames, { status: 200 });
}

function firstFor(rows: {
	chats?: Record<string, ChatRow | undefined>;
	messages?: Record<string, MessageRow | undefined>;
	chatCount?: number;
	rootCount?: number;
	rateLimit?: { windowStart: number; count: number };
	forkIds?: Set<string>;
	doneSibling?: { id: string };
}) {
	return async (sql: string, params: unknown[]) => {
		if (sql.includes("openrouter_limits")) {
			return rows.rateLimit;
		}
		if (sql.includes("COUNT(*)") && sql.includes("FROM chats")) {
			return { n: rows.chatCount ?? 1 };
		}
		if (sql.includes("COUNT(*)") && sql.includes("FROM messages")) {
			return { n: rows.rootCount ?? 2 };
		}
		if (sql.includes("SELECT id FROM chats WHERE id = ?")) {
			const id = String(params[0]);
			if (rows.forkIds?.has(id)) {
				return { id };
			}
			return undefined;
		}
		if (sql.includes("FROM chats")) {
			return rows.chats?.[String(params[0])];
		}
		if (
			sql.includes("role = 'assistant'") &&
			sql.includes("status = 'done'") &&
			sql.includes("ORDER BY created_at")
		) {
			return rows.doneSibling;
		}
		if (sql.includes("FROM messages")) {
			return rows.messages?.[String(params[0])];
		}
		return undefined;
	};
}

describe("handleTurnRequest", () => {
	const fetchMock = vi.fn();
	const getSessionUserMock = vi.mocked(getSessionUser);
	const loadPathMock = vi.mocked(loadPath);
	const summaryForMock = vi.mocked(summaryFor);

	beforeEach(() => {
		vi.clearAllMocks();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		getSessionUserMock.mockResolvedValue({ id: "user-1", email: "user@example.com" });
		loadPathMock.mockResolvedValue([
			{ id: "u2", role: "user", content: "hello", createdAt: 1 },
			{ id: "a2", role: "assistant", content: "Hello, it's wonderful meeting you", createdAt: 2 },
		]);
		summaryForMock.mockImplementation((chat: ChatRow) => ({
			id: chat.id,
			title: chat.title,
			rootId: chat.root_id,
			leafId: chat.leaf_id,
			generating: false,
			createdAt: chat.created_at,
			updatedAt: chat.updated_at,
		}));
	});

	it("returns 401 without a session", async () => {
		getSessionUserMock.mockResolvedValueOnce(null);
		const { db } = makeDb({});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects redo without parentId", async () => {
		const { db } = makeDb({});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", { parentId: null, expectLeaf: null, replyId: "a2" }),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/parentId/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a missing replyId", async () => {
		const { db } = makeDb({});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", { parentId: "a1", expectLeaf: "a1", userMessage: { id: "u2", content: "hi" } }),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/replyId/i);
	});

	it("rejects userMessage.id equal to replyId", async () => {
		const { db } = makeDb({});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", {
				parentId: "a1",
				expectLeaf: "a1",
				userMessage: { id: "same", content: "hi" },
				replyId: "same",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/differ/i);
	});

	it("rejects empty userMessage content", async () => {
		const { db } = makeDb({});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", {
				parentId: "a1",
				expectLeaf: "a1",
				userMessage: { id: "u2", content: "   " },
				replyId: "a2",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/empty/i);
	});

	it("replays a done replyId without quota or upstream", async () => {
		const doneReply: MessageRow = {
			...parentLeaf,
			id: "a2",
			status: "done",
			content: "already done",
			reasoning: null,
		};
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": { ...sourceChat, leaf_id: "a2" } },
				messages: { a2: doneReply, a1: parentLeaf },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; chat: ChatSummary; messages: unknown[] };
		expect(body.ok).toBe(true);
		expect(body.chat).toBeDefined();
		expect(body.messages).toBeDefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(statements.some((s) => s.sql.includes("openrouter_limits"))).toBe(false);
	});

	it("returns 409 when replyId is still pending and fresh", async () => {
		const pending: MessageRow = {
			...parentLeaf,
			id: "a2",
			status: "pending",
			content: "",
			created_at: Date.now(),
		};
		const { db } = makeDb({
			first: firstFor({
				chats: { "chat-1": { ...sourceChat, leaf_id: "a2" } },
				messages: { a2: pending },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(409);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("Reply is still generating");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns 429 when the generate quota is exhausted and writes nothing", async () => {
		const windowStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
		// The limiter upsert returns the post-increment count: 61 means this
		// request is the first one past the 60/hour ceiling.
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": sourceChat },
				messages: { a1: parentLeaf },
				rateLimit: { windowStart, count: 61 },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
		const writes = statements.filter(
			(s) =>
				/^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql) &&
				(s.sql.includes("INTO messages") ||
					s.sql.includes("INTO chats") ||
					s.sql.includes("UPDATE chats") ||
					s.sql.includes("UPDATE messages") ||
					s.sql.includes("DELETE FROM messages")),
		);
		expect(writes).toHaveLength(0);
	});

	it("guards append inserts with INSERT ... SELECT ... WHERE leaf_id IS ?", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		const inserts = statements.filter((s) => /^\s*INSERT INTO messages/i.test(s.sql));
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.sql).toMatch(/INSERT\s+INTO\s+messages[\s\S]+SELECT[\s\S]+WHERE/i);
			expect(insert.sql).toContain("leaf_id IS ?");
		}
	});

	it("guards create inserts with NOT EXISTS", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
		const chats: Record<string, ChatRow | undefined> = {};
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				chatCount: 0,
			}),
			all: async () => ({ results: [{ role: "user", content: "hello" }] }),
			batch: async (stmts) => {
				chats["chat-1"] = {
					id: "chat-1",
					user_id: "user-1",
					root_id: "u2",
					leaf_id: "a2",
					title: "New chat",
					created_at: 1,
					updated_at: 1,
				};
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		await handleTurnRequest(
			turnRequest("chat-1", {
				parentId: null,
				expectLeaf: null,
				userMessage: { id: "u2", content: "hello" },
				replyId: "a2",
				title: "New chat",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		const inserts = statements.filter((s) => /^\s*INSERT INTO messages/i.test(s.sql));
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.sql).toMatch(/INSERT\s+INTO\s+messages[\s\S]+SELECT[\s\S]+WHERE/i);
			expect(insert.sql).toContain("NOT EXISTS");
		}
	});

	it("guards create-into-empty inserts with leaf_id IS NULL", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
		const emptyChat: ChatRow = {
			...sourceChat,
			root_id: null,
			leaf_id: null,
			title: "Empty",
		};
		const chats: Record<string, ChatRow | undefined> = { "chat-1": emptyChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				chatCount: 1,
			}),
			all: async () => ({ results: [{ role: "user", content: "hello" }] }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...emptyChat, root_id: "u2", leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		await handleTurnRequest(
			turnRequest("chat-1", {
				parentId: null,
				expectLeaf: null,
				userMessage: { id: "u2", content: "hello" },
				replyId: "a2",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		const inserts = statements.filter((s) => /^\s*INSERT INTO messages/i.test(s.sql));
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.sql).toMatch(/INSERT\s+INTO\s+messages[\s\S]+SELECT[\s\S]+WHERE/i);
			expect(insert.sql).toContain("leaf_id IS NULL");
		}
	});

	it("guards fork inserts with leaf_id IS ? and NOT EXISTS", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
				chatCount: 1,
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["fork-1"] = {
					...sourceChat,
					id: "fork-1",
					leaf_id: "a2",
					title: "Fork",
				};
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		await handleTurnRequest(
			turnRequest("chat-1", {
				...appendBody,
				fork: { chatId: "fork-1", title: "Fork" },
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		const inserts = statements.filter((s) => /^\s*INSERT INTO messages/i.test(s.sql));
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.sql).toMatch(/INSERT\s+INTO\s+messages[\s\S]+SELECT[\s\S]+WHERE/i);
			expect(insert.sql).toContain("leaf_id IS ?");
			expect(insert.sql).toContain("NOT EXISTS");
		}
	});

	it("returns 409 and skips upstream when the pointer writes zero rows", async () => {
		const { db } = makeDb({
			first: firstFor({
				chats: { "chat-1": sourceChat },
				messages: { a1: parentLeaf },
			}),
			batch: async (stmts) =>
				stmts.map((stmt) => ({
					meta: {
						changes:
							stmt.sql.includes("UPDATE chats SET leaf_id") || stmt.sql.includes("INSERT INTO chats")
								? 0
								: 1,
					},
				})),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(409);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("Chat changed, reload");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("completes a non-streaming append with fixture content", async () => {
		fetchMock.mockResolvedValue(fixtureResponse());
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; chat: ChatSummary; messages: unknown[] };
		expect(body.ok).toBe(true);
		expect(body.chat).toBeDefined();
		expect(body.messages).toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const upstream = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			messages: Record<string, unknown>[];
		};
		for (const message of upstream.messages) {
			expect(message).toEqual({ role: message.role, content: message.content });
			expect("reasoning" in message).toBe(false);
		}
		const complete = statements.find(
			(s) => s.sql.includes("UPDATE messages") && s.sql.includes("status = 'done'"),
		);
		expect(complete).toBeDefined();
		expect(complete?.params[0]).toBe("Hello, it's wonderful meeting you");
		expect(complete?.sql).toContain("status = 'pending'");
	});

	it("streams reasoning/content and a single committed done event", async () => {
		fetchMock.mockResolvedValue(
			sseResponse(
				[
					`data: {"model":"meta/muse-spark-1.3-contributor","choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Considering"}]}}]}\n\n`,
					`data: {"model":"meta/muse-spark-1.3-contributor","choices":[{"delta":{"content":"Hello"}}]}\n\n`,
					`data: {"model":"meta/muse-spark-1.3-contributor","choices":[{"delta":{"content":" there"}}]}\n\n`,
					`data: [DONE]\n\n`,
				].join(""),
			),
		);
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", { ...appendBody, stream: true }),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");
		const text = await response.text();
		await Promise.all(promises);
		const events = text
			.split("\n\n")
			.filter((frame) => frame.startsWith("data:"))
			.map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
		expect(events.some((event) => event.type === "reasoning")).toBe(true);
		expect(events.some((event) => event.type === "content")).toBe(true);
		const dones = events.filter((event) => event.type === "done");
		expect(dones).toHaveLength(1);
		expect(dones[0]).toEqual(
			expect.objectContaining({
				type: "done",
				chat: expect.anything(),
				messages: expect.anything(),
			}),
		);
		expect(events.some((event) => event.type === "done" && "model" in event)).toBe(false);
		expect(JSON.stringify(events)).not.toContain('{"type":"done","model"');
	});

	it("abandons and returns 502 JSON when upstream fails before the stream", async () => {
		fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }));
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(502);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		const abandonUpdate = statements.find(
			(s) => s.sql.includes("UPDATE chats SET leaf_id") && s.sql.includes("CASE WHEN"),
		);
		expect(abandonUpdate).toBeDefined();
		expect(abandonUpdate?.params[0]).toBe("u2");
		expect(abandonUpdate?.params[4]).toBe("a2");
		const abandonDelete = statements.find(
			(s) => s.sql.includes("DELETE FROM messages") && s.params[0] === "a2",
		);
		expect(abandonDelete).toBeDefined();
	});

	it("abandons when the stream has no content", async () => {
		fetchMock.mockResolvedValue(
			sseResponse(
				`data: {"model":"meta/muse-spark-1.3-contributor","choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"only thinking"}]}}]}\n\n`,
			),
		);
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(502);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.error).toBe("OpenRouter returned an empty reply");
		expect(statements.some((s) => s.sql.includes("DELETE FROM messages") && s.params[0] === "a2")).toBe(
			true,
		);
	});

	it("abandons when upstream emits an error event mid-stream", async () => {
		fetchMock.mockResolvedValue(
			sseResponse(
				[
					`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`,
					`data: {"error":{"message":"overloaded"}}\n\n`,
				].join(""),
			),
		);
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(502);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.error).toBe("OpenRouter returned an error");
		expect(statements.some((s) => s.sql.includes("DELETE FROM messages") && s.params[0] === "a2")).toBe(
			true,
		);
	});

	it("returns 409 when complete loses the pending row", async () => {
		fetchMock.mockResolvedValue(fixtureResponse());
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				const completing = stmts.some((s) => s.sql.includes("status = 'done'"));
				if (completing) {
					return stmts.map((s) => ({
						meta: { changes: s.sql.includes("UPDATE messages") ? 0 : 1 },
					}));
				}
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("Reply was abandoned before it finished");
	});

	it("redo reserve emits one message insert under parentId", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2b" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		await handleTurnRequest(
			turnRequest("chat-1", { parentId: "u1", expectLeaf: "a1", replyId: "a2b" }),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		const inserts = statements.filter((s) => /^\s*INSERT INTO messages/i.test(s.sql));
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.params[3]).toBe("u1");
	});

	it("fork happy path does not update the source chat pointer", async () => {
		fetchMock.mockResolvedValue(fixtureResponse());
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
				chatCount: 1,
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["fork-1"] = {
					...sourceChat,
					id: "fork-1",
					leaf_id: "a2",
					title: "Fork",
				};
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", {
				...appendBody,
				fork: { chatId: "fork-1", title: "Fork" },
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		expect(response.status).toBe(200);
		expect(
			statements.some((s) => /^\s*UPDATE chats\b/i.test(s.sql) && s.params.includes("chat-1")),
		).toBe(false);
	});

	it("abandons a stale pending replay then returns 409 timed out", async () => {
		const stale: MessageRow = {
			...parentLeaf,
			id: "a2",
			status: "pending",
			content: "",
			created_at: Date.now() - PENDING_TIMEOUT_MS - 1_000,
		};
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": { ...sourceChat, leaf_id: "a2" } },
				messages: { a2: stale, u1: userParent },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		expect(response.status).toBe(409);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("Reply timed out");
		expect(statements.some((s) => s.sql.includes("DELETE FROM messages") && s.params[0] === "a2")).toBe(
			true,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stale replay abandon uses the stored reply parent, not the body parentId", async () => {
		const stale: MessageRow = {
			...parentLeaf,
			id: "a2",
			parent_id: "u2",
			status: "pending",
			content: "",
			created_at: Date.now() - PENDING_TIMEOUT_MS - 1_000,
		};
		const storedParent: MessageRow = {
			id: "u2",
			user_id: "user-1",
			root_id: "u1",
			parent_id: "a1",
			depth: 2,
			role: "user",
			status: "done",
			content: "hello",
			reasoning: null,
			created_at: 2,
		};
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": { ...sourceChat, leaf_id: "a2" } },
				messages: { a2: stale, u2: storedParent, a1: parentLeaf },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", { ...appendBody, parentId: "other-parent" }),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Reply timed out");
		const abandonUpdate = statements.find(
			(s) => s.sql.includes("UPDATE chats SET leaf_id") && s.sql.includes("CASE WHEN"),
		);
		expect(abandonUpdate?.params[0]).toBe("u2");
		expect(abandonUpdate?.params[0]).not.toBe("other-parent");
	});

	it("planTurn then reserveTurn builds the append batch", async () => {
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db, statements } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const planned = await planTurn(
			db,
			"user-1",
			"chat-1",
			{
				...appendBody,
				stream: false,
				model: "meta/muse-spark-1.3-contributor",
				effort: "minimal",
			},
			1_000,
		);
		expect(planned.ok).toBe(true);
		if (!planned.ok) {
			return;
		}
		expect(planned.plan.reserveCase.kind).toBe("append");
		expect(planned.plan.replyParentId).toBe("u2");
		const reserved = await reserveTurn(db, "user-1", appendBody, planned.plan, 1_000);
		expect(reserved.ok).toBe(true);
		expect(statements.some((s) => /^\s*INSERT INTO messages/i.test(s.sql))).toBe(true);
	});

	it("rejects an unsupported turn model without quota, writes, or upstream", async () => {
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": sourceChat },
				messages: { a1: parentLeaf },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", { ...appendBody, model: "openai/gpt-4o" }),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("model is not supported");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(statements.some((s) => s.sql.includes("openrouter_limits"))).toBe(false);
		expect(statements.some((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql))).toBe(false);
	});

	it("defaults an omitted turn model to Muse Spark", async () => {
		fetchMock.mockResolvedValue(fixtureResponse());
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(turnRequest("chat-1", appendBody), envWith(db), ctx, "chat-1");
		await Promise.all(promises);
		expect(response.status).toBe(200);
		const upstream = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
			string,
			unknown
		>;
		expect(upstream.model).toBe("meta/muse-spark-1.3-contributor");
		expect(upstream.reasoning).toEqual({ effort: "minimal" });
	});

	it("rejects turn efforts the model does not offer without side effects", async () => {
		const { db, statements } = makeDb({
			first: firstFor({
				chats: { "chat-1": sourceChat },
				messages: { a1: parentLeaf },
			}),
		});
		const { ctx } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", {
				...appendBody,
				model: "meta/muse-spark-1.3-contributor",
				effort: "none",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("effort is not supported by this model");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(statements.some((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql))).toBe(false);
	});

	it("forwards the selected turn model and effort", async () => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(fixtureResponse());
		const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
		const { db } = makeDb({
			first: firstFor({
				chats,
				messages: { a1: parentLeaf, u1: userParent },
			}),
			all: async () => ({ results: pathMessages }),
			batch: async (stmts) => {
				chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		});
		const { ctx, promises } = makeCtx();
		const response = await handleTurnRequest(
			turnRequest("chat-1", {
				...appendBody,
				model: "openai/gpt-5.6-luna",
				effort: "low",
			}),
			envWith(db),
			ctx,
			"chat-1",
		);
		await Promise.all(promises);
		expect(response.status).toBe(200);
		const upstream = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
			string,
			unknown
		>;
		expect(upstream.model).toBe("openai/gpt-5.6-luna");
		expect(upstream.max_tokens).toBe(4096);
		expect(upstream.reasoning).toEqual({ effort: "low" });
	});
});

describe("abandonTurn", () => {
	it("guards the pointer move so a done reply is not un-pointed", async () => {
		const { db, statements } = makeDb({});
		await abandonTurn(db, "user-1", "a2", "u1");
		const pointer = statements.find(
			(s) => s.sql.includes("UPDATE chats SET leaf_id") && s.sql.includes("CASE WHEN"),
		);
		expect(pointer).toBeDefined();
		expect(pointer?.sql).toMatch(
			/EXISTS\s*\(\s*SELECT 1 FROM messages WHERE id = \? AND user_id = \? AND status = 'pending'\)/,
		);
		expect(pointer?.params[4]).toBe("a2");
		expect(pointer?.params[5]).toBe("a2");
	});
});
