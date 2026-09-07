import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "./auth.js";
import {
	ALL_PATHS_SQL,
	CHATS_LIST_SQL,
	IS_SHARED_SQL,
	handleChatsRequest,
	isShared,
	loadAllPaths,
} from "./chats.js";
import { chatRow, makeDb, type RecordedStatement } from "./testing/d1.js";
import { gcRoot, type MessageRow } from "./tree.js";
import { MAX_CHATS, PENDING_TIMEOUT_MS } from "./tree-types.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	ensureDomainUser: vi.fn(async () => {}),
}));

vi.mock("./tree.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tree.js")>();
	return {
		...actual,
		gcRoot: vi.fn((db: D1Database, userId: string, rootId: string) =>
			actual.gcRoot(db, userId, rootId),
		),
	};
});

const envWith = (db: D1Database) => ({ DB: db }) as unknown as Env;

const USER_ID = "user-1";
const CHAT_ID = "chat-1";

const chatBody = (messages: Record<string, unknown>[], extras?: { id?: string; title?: string }) => ({
	id: extras?.id ?? CHAT_ID,
	title: extras?.title ?? "Test chat",
	createdAt: 1,
	updatedAt: 2,
	messages,
});

function linearPath(
	nodes: { id: string; role: "user" | "assistant"; content: string; created_at: number; reasoning?: string | null }[],
): MessageRow[] {
	const rootId = nodes[0]?.id ?? "";
	return nodes.map((node, depth) => ({
		id: node.id,
		user_id: USER_ID,
		root_id: rootId,
		parent_id: depth === 0 ? null : (nodes[depth - 1]?.id ?? null),
		depth,
		role: node.role,
		status: "done",
		content: node.content,
		reasoning: node.reasoning ?? null,
		created_at: node.created_at,
	}));
}

function existingChat(path: MessageRow[], leafId?: string | null) {
	const root = path[0]?.id ?? null;
	const leaf = leafId === undefined ? (path[path.length - 1]?.id ?? null) : leafId;
	return {
		id: CHAT_ID,
		user_id: USER_ID,
		root_id: root,
		leaf_id: leaf,
		title: "Old title",
		created_at: 1,
		updated_at: 2,
	};
}

async function putRequest(
	messages: Record<string, unknown>[],
	hooks: {
		chat?: ReturnType<typeof existingChat> | { user_id: string } | null;
		path?: MessageRow[];
		leaf?: { status: string; created_at: number } | null;
		existingNodes?: {
			id: string;
			parent_id: string | null;
			role: string;
			content: string;
			reasoning: string | null;
		}[];
		count?: number;
		body?: Record<string, unknown>;
		urlId?: string;
		shared?: boolean;
		batchResult?: (stmt: RecordedStatement, index: number) => { meta: { changes: number } };
	} = {},
) {
	const { db, statements, getBatch } = makeDb({
		batchResult: hooks.batchResult,
		first: async (sql) => {
			if (sql.includes("COUNT(*)")) {
				return { n: hooks.count ?? 0 };
			}
			if (sql === IS_SHARED_SQL) {
				return { shared: hooks.shared ? 1 : 0 };
			}
			if (sql.includes("FROM chats")) {
				return hooks.chat === undefined ? undefined : hooks.chat;
			}
			if (sql.includes("SELECT status, created_at")) {
				return hooks.leaf === undefined
					? { status: "done", created_at: 1 }
					: hooks.leaf;
			}
			return undefined;
		},
		all: async (sql) => {
			if (sql.includes("FROM path") || sql.includes("status = 'done'")) {
				return { results: hooks.path ?? [] };
			}
			if (sql.includes("id IN")) {
				return { results: hooks.existingNodes ?? [] };
			}
			return { results: [] };
		},
	});
	const urlId = hooks.urlId ?? CHAT_ID;
	const request = new Request(`http://localhost:5173/api/chats/${urlId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(hooks.body ?? chatBody(messages)),
	});
	const response = await handleChatsRequest(request, envWith(db), urlId);
	return { response, db, statements, batch: getBatch() };
}

describe("handleChatsRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSessionUser).mockResolvedValue({ id: USER_ID, email: "user@example.com" });
	});

	it("PUT drops legacy blobs but stores the display-only trace", async () => {
		const { response, statements, batch } = await putRequest([
			{ id: "m1", role: "user", content: "hi", createdAt: 1 },
			{
				id: "m2",
				role: "assistant",
				content: "hello",
				createdAt: 2,
				reasoningDetails: [{ type: "reasoning.text", text: "old thinking" }],
				reasoning: "Considering the question.",
			},
		]);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chat: { messages: Record<string, unknown>[] };
		};
		expect(body.chat.messages[1]).toEqual({
			id: "m2",
			role: "assistant",
			content: "hello",
			createdAt: 2,
			reasoning: "Considering the question.",
		});
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) {
			expect(statement.sql.includes("reasoning_details")).toBe(false);
		}
		const inserts = batch.filter((s) => s.sql.includes("INSERT INTO messages"));
		expect(inserts).toHaveLength(2);
		// user_id, root_id, parent_id, depth, role, content, reasoning, created_at
		expect(inserts[0]?.params[7]).toBe(null);
		expect(inserts[1]?.params).toHaveLength(10);
		expect(inserts[1]?.params[7]).toBe("Considering the question.");
	});

	it("PUT truncates overlong traces instead of rejecting the chat", async () => {
		const { response, batch } = await putRequest([
			{
				id: "m1",
				role: "assistant",
				content: "hello",
				createdAt: 1,
				reasoning: "y".repeat(10_000),
			},
		]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chat: { messages: { reasoning?: string }[] };
		};
		expect(body.chat.messages[0]?.reasoning).toHaveLength(4000);
		const insert = batch.find((s) => s.sql.includes("INSERT INTO messages"));
		expect(insert?.params[7]).toHaveLength(4000);
	});

	it("GET delegates to loadAllPaths and returns its result unchanged under chats", async () => {
		const chats = [
			{
				id: "chat-1",
				title: "t",
				createdAt: 1,
				updatedAt: 2,
				messages: [
					{ id: "m1", role: "user", content: "hi", createdAt: 1 },
					{
						id: "m2",
						role: "assistant",
						content: "hello",
						createdAt: 2,
						reasoning: "Considering the question.",
					},
				],
			},
		];
		const { db } = makeDb({
			all: async (sql) => {
				if (sql === CHATS_LIST_SQL) {
					return {
						results: [chatRow({ title: "t", created_at: 1, updated_at: 2 })],
					};
				}
				return {
					results: [
						{
							chat_id: "chat-1",
							id: "m1",
							parent_id: null,
							depth: 0,
							role: "user",
							status: "done",
							content: "hi",
							reasoning: null,
							created_at: 1,
						},
						{
							chat_id: "chat-1",
							id: "m2",
							parent_id: "m1",
							depth: 1,
							role: "assistant",
							status: "done",
							content: "hello",
							reasoning: "Considering the question.",
							created_at: 2,
						},
					],
				};
			},
		});

		const response = await handleChatsRequest(
			new Request("http://localhost:5173/api/chats"),
			envWith(db),
			null,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chats: { messages: Record<string, unknown>[] }[];
		};
		expect(body.chats).toEqual(chats);
		expect(body.chats[0]?.messages[1]).toEqual({
			id: "m2",
			role: "assistant",
			content: "hello",
			createdAt: 2,
			reasoning: "Considering the question.",
		});
	});

	it("GET returns 500 when loadAllPaths throws", async () => {
		const { db } = makeDb({
			all: async () => {
				throw new Error("boom");
			},
		});
		const response = await handleChatsRequest(
			new Request("http://localhost:5173/api/chats"),
			envWith(db),
			null,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ ok: false, error: "Could not load chats" });
	});

	it("rejects unauthenticated callers", async () => {
		vi.mocked(getSessionUser).mockResolvedValue(null);
		const { db } = makeDb({});
		const response = await handleChatsRequest(
			new Request("http://localhost:5173/api/chats"),
			envWith(db),
			null,
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ ok: false, error: "Unauthorized" });
	});

	it("rejects a PUT whose body id does not match the URL", async () => {
		const { response, batch } = await putRequest(
			[{ id: "m1", role: "user", content: "hi", createdAt: 1 }],
			{ urlId: "chat-1", body: chatBody([{ id: "m1", role: "user", content: "hi", createdAt: 1 }], { id: "other" }) },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "Chat id must match the URL" });
		expect(batch).toHaveLength(0);
	});

	it("rejects a new chat when the caller is at the chat limit", async () => {
		const { response, batch } = await putRequest(
			[{ id: "m1", role: "user", content: "hi", createdAt: 1 }],
			{ count: MAX_CHATS },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "Chat limit reached" });
		expect(batch).toHaveLength(0);
	});

	it("returns 404 when the chat belongs to another user", async () => {
		const { response, batch } = await putRequest(
			[{ id: "m1", role: "user", content: "hi", createdAt: 1 }],
			{ chat: { user_id: "someone-else" } },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
		expect(batch).toHaveLength(0);
	});
});

describe("PUT reconcile", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSessionUser).mockResolvedValue({ id: USER_ID, email: "user@example.com" });
	});

	it("new chat with 2 messages inserts nodes then the chats row", async () => {
		const { response, batch } = await putRequest([
			{ id: "m1", role: "user", content: "hi", createdAt: 1 },
			{ id: "m2", role: "assistant", content: "hello", createdAt: 2 },
		]);
		expect(response.status).toBe(200);
		expect(batch.map((s) => s.sql)).toEqual([
			expect.stringContaining("INSERT INTO messages"),
			expect.stringContaining("INSERT INTO messages"),
			expect.stringContaining("INSERT INTO chats"),
		]);
		expect(batch[0]?.sql).toContain("NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)");
		expect(batch[1]?.sql).toContain("NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)");
		expect(batch[2]?.sql).toContain("NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)");
		expect(batch[0]?.params).toEqual(["m1", USER_ID, "m1", null, 0, "user", "hi", null, 1, CHAT_ID]);
		expect(batch[1]?.params).toEqual(["m2", USER_ID, "m1", "m1", 1, "assistant", "hello", null, 2, CHAT_ID]);
		expect(batch[2]?.params).toEqual([CHAT_ID, USER_ID, "m1", "m2", "Test chat", 1, 2, CHAT_ID]);
		expect(batch.some((s) => s.sql.includes("DELETE"))).toBe(false);
	});

	it("appends 2 nodes to a path of 2 and moves the leaf", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
				{ id: "m3", role: "user", content: "c", createdAt: 3 },
				{ id: "m4", role: "assistant", content: "d", createdAt: 4 },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		const inserts = batch.filter((s) => s.sql.includes("INSERT INTO messages"));
		const updates = batch.filter((s) => s.sql.includes("UPDATE chats"));
		expect(inserts).toHaveLength(2);
		expect(inserts[0]?.params).toEqual(["m3", USER_ID, "m1", "m2", 2, "user", "c", null, 3, CHAT_ID, USER_ID, "m2"]);
		expect(inserts[1]?.params).toEqual(["m4", USER_ID, "m1", "m3", 3, "assistant", "d", null, 4, CHAT_ID, USER_ID, "m2"]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.params).toEqual(["m4", "m1", "Test chat", 1, 2, CHAT_ID, USER_ID, "m2"]);
		expect(batch.some((s) => s.sql.includes("DELETE"))).toBe(false);
	});

	it("truncates 4→2 with no inserts and leaf = M[1].id", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
			{ id: "m3", role: "user", content: "c", created_at: 3 },
			{ id: "m4", role: "assistant", content: "d", created_at: 4 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		expect(batch.filter((s) => s.sql.includes("INSERT INTO messages"))).toHaveLength(0);
		expect(batch).toHaveLength(1);
		expect(batch[0]?.sql).toContain("UPDATE chats");
		expect(batch[0]?.params[0]).toBe("m2");
		expect(batch[0]?.params[1]).toBe("m1");
		expect(batch[0]?.params).toEqual(["m2", "m1", "Test chat", 1, 2, CHAT_ID, USER_ID, "m4"]);
	});

	it("truncates to empty with leaf NULL and root NULL", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest([], { chat: existingChat(path), path });
		expect(response.status).toBe(200);
		expect(batch.filter((s) => s.sql.includes("INSERT"))).toHaveLength(0);
		expect(batch).toHaveLength(1);
		expect(batch[0]?.sql).toContain("UPDATE chats");
		expect(batch[0]?.params).toEqual([null, null, "Test chat", 1, 2, CHAT_ID, USER_ID, "m2"]);
		// The pointer left root m1: reclaim it after the CAS pointer write.
		expect(gcRoot).toHaveBeenCalledWith(expect.anything(), USER_ID, "m1");
	});

	it("diverges at position 2 under P[1] at depth 2", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
			{ id: "m3", role: "user", content: "c", created_at: 3 },
			{ id: "m4", role: "assistant", content: "d", created_at: 4 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
				{ id: "m5", role: "user", content: "e", createdAt: 5 },
				{ id: "m6", role: "assistant", content: "f", createdAt: 6 },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		const inserts = batch.filter((s) => s.sql.includes("INSERT INTO messages"));
		expect(inserts).toHaveLength(2);
		expect(inserts[0]?.params).toEqual(["m5", USER_ID, "m1", "m2", 2, "user", "e", null, 5, CHAT_ID, USER_ID, "m4"]);
		expect(inserts[1]?.params).toEqual(["m6", USER_ID, "m1", "m5", 3, "assistant", "f", null, 6, CHAT_ID, USER_ID, "m4"]);
		const pointer = batch.find((s) => s.sql.includes("UPDATE chats"));
		expect(pointer?.params[0]).toBe("m6");
		expect(pointer?.params[1]).toBe("m1");
	});

	it("in-place content edit on an unshared node updates the row", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "old", created_at: 2, reasoning: "think" },
		]);
		const { response, batch, statements } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "new", createdAt: 2, reasoning: "think" },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		expect(statements.some((statement) => statement.sql === IS_SHARED_SQL)).toBe(true);
		expect(statements.find((statement) => statement.sql === IS_SHARED_SQL)?.params).toEqual([
			USER_ID,
			CHAT_ID,
			"m2",
			"m2",
		]);
		const messageUpdate = batch.filter((s) => s.sql.includes("UPDATE messages SET content"));
		expect(messageUpdate).toHaveLength(1);
		expect(messageUpdate[0]?.params).toEqual(["new", "think", "m2", USER_ID, CHAT_ID, USER_ID, "m2"]);
		expect(batch.filter((s) => s.sql.includes("INSERT INTO messages"))).toHaveLength(0);
		expect(batch.find((s) => s.sql.includes("UPDATE chats"))?.params[0]).toBe("m2");
	});

	it("in-place content edit on a shared node is a 409 and writes nothing", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "old", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "new", createdAt: 2 },
			],
			{ chat: existingChat(path), path, shared: true },
		);
		expect(response.status).toBe(409);
		expect(batch).toHaveLength(0);
	});

	it("no-op document only updates the chats pointer metadata", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch, statements } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		expect(batch).toHaveLength(1);
		expect(batch[0]?.sql).toContain("UPDATE chats");
		expect(batch[0]?.params).toEqual(["m2", "m1", "Test chat", 1, 2, CHAT_ID, USER_ID, "m2"]);
		expect(statements.every((statement) => statement.sql !== IS_SHARED_SQL)).toBe(true);
	});

	it("fresh pending leaf returns 409 and writes nothing", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
			],
			{
				chat: existingChat(path, "pend"),
				path,
				leaf: { status: "pending", created_at: Date.now() - 1_000 },
			},
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ ok: false, error: "Chat is generating" });
		expect(batch).toHaveLength(0);
	});

	it("stale pending leaf is deleted after the pointer update", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
			],
			{
				chat: existingChat(path, "pend"),
				path,
				leaf: { status: "pending", created_at: Date.now() - PENDING_TIMEOUT_MS - 1 },
			},
		);
		expect(response.status).toBe(200);
		expect(batch.map((s) => s.sql)).toEqual([
			expect.stringContaining("UPDATE chats"),
			expect.stringContaining("DELETE FROM messages"),
		]);
		expect(batch[0]?.params[0]).toBe("m2");
		expect(batch[1]?.sql).toContain("status = 'pending'");
		expect(batch[1]?.params).toEqual(["pend", USER_ID]);
	});

	it("re-attaches an orphaned tail id instead of inserting (avoids PK)", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
				{ id: "m3", role: "user", content: "c-new", createdAt: 3 },
			],
			{
				chat: existingChat(path),
				path,
				existingNodes: [
					{ id: "m3", parent_id: "m2", role: "user", content: "c-old", reasoning: null },
				],
			},
		);
		expect(response.status).toBe(200);
		expect(batch.filter((s) => s.sql.includes("INSERT INTO messages"))).toHaveLength(0);
		const reattach = batch.filter((s) => s.sql.includes("UPDATE messages"));
		expect(reattach).toHaveLength(1);
		expect(reattach[0]?.params).toEqual(["c-new", null, "m3", USER_ID, CHAT_ID, USER_ID, "m2"]);
		expect(batch.find((s) => s.sql.includes("UPDATE chats"))?.params[0]).toBe("m3");
	});

	it("rejects a conflicting reuse of an existing message id", async () => {
		const path = linearPath([{ id: "m1", role: "user", content: "a", created_at: 1 }]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "taken", role: "assistant", content: "nope", createdAt: 2 },
			],
			{
				chat: existingChat(path),
				path,
				existingNodes: [
					{ id: "taken", parent_id: "other-parent", role: "assistant", content: "x", reasoning: null },
				],
			},
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "message ids must be unique" });
		expect(batch).toHaveLength(0);
	});

	it("returns 409 and skips gc when the pointer CAS loses", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response } = await putRequest([], {
			chat: existingChat(path),
			path,
			batchResult: () => ({ meta: { changes: 0 } }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ ok: false, error: "Chat changed, reload" });
		expect(gcRoot).not.toHaveBeenCalled();
	});

	it("guards every append INSERT/UPDATE with the old-leaf CAS", async () => {
		const path = linearPath([
			{ id: "m1", role: "user", content: "a", created_at: 1 },
			{ id: "m2", role: "assistant", content: "b", created_at: 2 },
		]);
		const { response, batch } = await putRequest(
			[
				{ id: "m1", role: "user", content: "a", createdAt: 1 },
				{ id: "m2", role: "assistant", content: "b", createdAt: 2 },
				{ id: "m3", role: "user", content: "c", createdAt: 3 },
				{ id: "m4", role: "assistant", content: "d", createdAt: 4 },
			],
			{ chat: existingChat(path), path },
		);
		expect(response.status).toBe(200);
		const writes = batch.filter(
			(s) => s.sql.includes("INSERT INTO messages") || s.sql.includes("UPDATE messages"),
		);
		expect(writes).toHaveLength(2);
		for (const statement of writes) {
			expect(statement.sql).toContain(
				"EXISTS (SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND leaf_id IS ?)",
			);
			expect(statement.params.slice(-3)).toEqual([CHAT_ID, USER_ID, "m2"]);
		}
		const pointer = batch.find((s) => s.sql.includes("UPDATE chats"));
		expect(pointer?.sql).toContain("leaf_id IS ?");
		expect(pointer?.params.at(-1)).toBe("m2");
	});
});

describe("loadAllPaths", () => {
	it("groups by chat, omits pending rows, and keeps updated_at desc order", async () => {
		const chats = [
			chatRow({ id: "chat-new", title: "Newer", updated_at: 20, created_at: 1, leaf_id: "m2" }),
			chatRow({ id: "chat-old", title: "Older", updated_at: 10, created_at: 2, leaf_id: "m3" }),
			chatRow({
				id: "chat-empty",
				title: "Empty",
				updated_at: 5,
				created_at: 3,
				leaf_id: null,
				root_id: null,
			}),
		];
		const { db, statements } = makeDb({
			all: async (sql) => {
				if (sql === CHATS_LIST_SQL) {
					return { results: chats };
				}
				return {
					results: [
						{
							chat_id: "chat-new",
							id: "m1",
							parent_id: null,
							depth: 0,
							role: "user",
							status: "done",
							content: "hi",
							reasoning: null,
							created_at: 1,
						},
						{
							chat_id: "chat-new",
							id: "m2",
							parent_id: "m1",
							depth: 1,
							role: "assistant",
							status: "pending",
							content: "",
							reasoning: null,
							created_at: 2,
						},
						{
							chat_id: "chat-old",
							id: "m1",
							parent_id: null,
							depth: 0,
							role: "user",
							status: "done",
							content: "hi",
							reasoning: null,
							created_at: 1,
						},
						{
							chat_id: "chat-old",
							id: "m3",
							parent_id: "m1",
							depth: 1,
							role: "assistant",
							status: "done",
							content: "hello",
							reasoning: "trace",
							created_at: 3,
						},
					],
				};
			},
		});

		const result = await loadAllPaths(db, "user-1");
		expect(statements[0]?.sql).toBe(CHATS_LIST_SQL);
		expect(statements[0]?.sql).toMatch(/ORDER BY updated_at DESC, created_at DESC/);
		expect(statements[0]?.params).toEqual(["user-1"]);
		expect(statements[1]?.sql).toBe(ALL_PATHS_SQL);
		expect(statements[1]?.params).toEqual(["user-1", "user-1"]);
		expect(result.map((chat) => chat.id)).toEqual(["chat-new", "chat-old", "chat-empty"]);
		expect(result[0]?.messages).toEqual([{ id: "m1", role: "user", content: "hi", createdAt: 1 }]);
		expect(result[1]?.messages).toEqual([
			{ id: "m1", role: "user", content: "hi", createdAt: 1 },
			{
				id: "m3",
				role: "assistant",
				content: "hello",
				createdAt: 3,
				reasoning: "trace",
			},
		]);
		expect(result[2]?.messages).toEqual([]);
		for (const chat of result) {
			expect(chat.messages.some((message) => message.pending)).toBe(false);
		}
	});
});

describe("isShared", () => {
	it("binds userId, excludingChatId, nodeId, nodeId", async () => {
		const { db, statements } = makeDb({
			first: async () => ({ shared: 1 }),
		});
		const shared = await isShared(db, "user-1", "node-9", "chat-a");
		expect(shared).toBe(true);
		expect(statements).toHaveLength(1);
		expect(statements[0]?.sql).toBe(IS_SHARED_SQL);
		expect(statements[0]?.params).toEqual(["user-1", "chat-a", "node-9", "node-9"]);
	});
});

