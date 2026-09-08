/// <reference types="node" />
/**
 * Empty-reply hang regression.
 *
 * Production canceled the generate request before any SSE byte because the
 * handler awaited OpenRouter first. These tests hold that fetch open and
 * fail in STREAM_TTFB_BUDGET_MS if the Response (and first heartbeat) wait
 * on it. A hang-until-Vitest-timeout is not a tripwire.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "./auth.js";
import { handleOpenRouterRequest, openStreamCompletion } from "./openrouter.js";
import { makeDb } from "./testing/d1.js";
import {
	assertWithinTtfbBudget,
	holdOpenRouterFetch,
	readFirstChunkWithinBudget,
	StreamTtfbTimeout,
} from "./testing/stream-ttfb.js";
import { loadPath, summaryFor, type ChatRow, type MessageRow } from "./tree.js";
import type { ChatSummary } from "./tree-types.js";
import { handleTurnRequest } from "./turns.js";

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

function rateLimitDb() {
	const run = vi.fn(async () => ({}));
	const first = vi.fn(async () => undefined);
	const db = {
		prepare: vi.fn(() => ({ bind: (..._args: unknown[]) => ({ first, run }) })),
	};
	return db as unknown as D1Database;
}

const env = (db: D1Database = rateLimitDb()) =>
	({
		OPENROUTER_API_KEY: "test-key",
		DB: db,
	}) as unknown as Env;

function postOpenRouter() {
	return new Request("http://localhost:5173/api/openrouter", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: "hi", stream: true }),
	});
}

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
	reasoning: null,
	created_at: 1,
};

function turnDb() {
	const chats: Record<string, ChatRow | undefined> = { "chat-1": sourceChat };
	const messages: Record<string, MessageRow | undefined> = { a1: parentLeaf };
	return makeDb({
		first: async (sql, params) => {
			if (sql.includes("openrouter_limits") || sql.includes("openrouter_global_limits")) {
				return undefined;
			}
			if (sql.includes("COUNT(*)") && sql.includes("FROM chats")) {
				return { n: 1 };
			}
			if (sql.includes("COUNT(*)") && sql.includes("FROM messages")) {
				return { n: 2 };
			}
			if (sql.includes("SELECT id FROM chats WHERE id = ?")) {
				return undefined;
			}
			if (sql.includes("FROM chats")) {
				return chats[String(params[0])];
			}
			if (sql.includes("FROM messages")) {
				return messages[String(params[0])];
			}
			return undefined;
		},
		all: async () => ({
			results: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "prior" },
				{ role: "user", content: "hello" },
			],
		}),
		batch: async (stmts) => {
			chats["chat-1"] = { ...sourceChat, leaf_id: "a2" };
			return stmts.map(() => ({ meta: { changes: 1 } }));
		},
	});
}

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

const doneUpstream = () =>
	new Response(`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n`, { status: 200 });

describe("stream TTFB hang regression", () => {
	let held: ReturnType<typeof holdOpenRouterFetch>;

	beforeEach(() => {
		held = holdOpenRouterFetch();
		vi.clearAllMocks();
		vi.stubGlobal("fetch", vi.fn(held.impl));
		vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "user@example.com" });
		vi.mocked(loadPath).mockResolvedValue([
			{ id: "u2", role: "user", content: "hello", createdAt: 1 },
			{ id: "a2", role: "assistant", content: "Hello, it's wonderful meeting you", createdAt: 2 },
		]);
		vi.mocked(summaryFor).mockImplementation((chat: ChatRow) => ({
			id: chat.id,
			title: chat.title,
			rootId: chat.root_id,
			leafId: chat.leaf_id,
			generating: false,
			createdAt: chat.created_at,
			updatedAt: chat.updated_at,
		}));
	});

	it("fails inside the TTFB budget when the handler never returns", async () => {
		await expect(assertWithinTtfbBudget(new Promise(() => {}), "hung handler")).rejects.toThrow(
			StreamTtfbTimeout,
		);
	});

	it("openStreamCompletion returns and heartbeats before OpenRouter answers", async () => {
		const opened = await assertWithinTtfbBudget(
			openStreamCompletion(env(), [{ role: "user", content: "hi" }]),
			"openStreamCompletion",
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) {
			return;
		}

		const reader = opened.events.getReader();
		const first = await assertWithinTtfbBudget(reader.read(), "openStreamCompletion first event");
		expect(first.done).toBe(false);
		expect(first.value).toEqual({ type: "heartbeat" });

		held.release(doneUpstream());
		await reader.cancel();
	});

	it("POST /api/openrouter returns SSE and :thinking before OpenRouter answers", async () => {
		const response = await assertWithinTtfbBudget(
			handleOpenRouterRequest(postOpenRouter(), env()),
			"handleOpenRouterRequest (stream)",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");

		const { text, reader } = await readFirstChunkWithinBudget(
			response.body,
			"handleOpenRouterRequest",
		);
		expect(text).toContain(":thinking");

		held.release(doneUpstream());
		await reader.cancel();
	});

	it("POST /api/chats/:id/turns?stream returns SSE and :thinking before OpenRouter answers", async () => {
		const { db } = turnDb();
		const { ctx, promises } = makeCtx();
		const request = new Request("http://localhost:5173/api/chats/chat-1/turns", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				parentId: "a1",
				expectLeaf: "a1",
				userMessage: { id: "u2", content: "hello" },
				replyId: "a2",
				stream: true,
			}),
		});

		const response = await assertWithinTtfbBudget(
			handleTurnRequest(request, env(db), ctx, "chat-1"),
			"handleTurnRequest (stream)",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");

		const { text, reader } = await readFirstChunkWithinBudget(response.body, "handleTurnRequest");
		expect(text).toContain(":thinking");

		held.release(doneUpstream());
		await reader.cancel();
		await Promise.all(promises);
	});
});
