import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALL_PATHS_SQL,
	CHATS_LIST_SQL,
	GC_ROOT_SQL,
	IS_SHARED_SQL,
	PATH_SQL,
	gcRoot,
	isShared,
	loadAllPaths,
	loadPath,
	summaryFor,
	toApiMessage,
} from "./tree.js";
import { PENDING_TIMEOUT_MS, type ChatRow, type MessageRow } from "./tree-types.js";

type RecordedStatement = { sql: string; params: unknown[] };

function makeDb(hooks: {
	first?: (sql: string, params: unknown[]) => Promise<unknown>;
	all?: (sql: string, params: unknown[]) => Promise<{ results: unknown[] }>;
	run?: (sql: string, params: unknown[]) => Promise<{ meta: { changes: number } }>;
}) {
	const statements: RecordedStatement[] = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			bind: (...params: unknown[]) => {
				statements.push({ sql, params });
				return {
					first: () => hooks.first?.(sql, params) ?? Promise.resolve(undefined),
					all: () => hooks.all?.(sql, params) ?? Promise.resolve({ results: [] }),
					run: () => hooks.run?.(sql, params) ?? Promise.resolve({ meta: { changes: 1 } }),
				};
			},
		})),
		batch: vi.fn(async () => []),
	};
	return { db: db as unknown as D1Database, statements };
}

function chatRow(overrides: Partial<ChatRow> = {}): ChatRow {
	return {
		id: "chat-1",
		user_id: "user-1",
		root_id: "m1",
		leaf_id: "m2",
		title: "Test chat",
		created_at: 1,
		updated_at: 2,
		...overrides,
	};
}

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
	return {
		id: "m1",
		user_id: "user-1",
		root_id: "m1",
		parent_id: null,
		depth: 0,
		role: "user",
		status: "done",
		content: "hi",
		reasoning: null,
		created_at: 1,
		...overrides,
	};
}

describe("loadPath", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns [] when leaf_id is null and does not query", async () => {
		const { db, statements } = makeDb({});
		const messages = await loadPath(db, chatRow({ leaf_id: null, root_id: null }));
		expect(messages).toEqual([]);
		expect(statements).toHaveLength(0);
	});

	it("orders by depth and sets pending only on pending rows", async () => {
		const { db, statements } = makeDb({
			all: async () => ({
				results: [
					messageRow({ id: "m1", depth: 0, role: "user", status: "done", content: "hi" }),
					messageRow({
						id: "m2",
						parent_id: "m1",
						depth: 1,
						role: "assistant",
						status: "pending",
						content: "",
						created_at: 2,
						reasoning: "thinking",
					}),
					messageRow({
						id: "m3",
						parent_id: "m1",
						depth: 2,
						role: "assistant",
						status: "done",
						content: "hello",
						created_at: 3,
						reasoning: "",
					}),
				],
			}),
		});

		const messages = await loadPath(db, chatRow({ leaf_id: "m2" }));
		expect(statements).toHaveLength(1);
		expect(statements[0]?.sql).toBe(PATH_SQL);
		expect(statements[0]?.sql).toMatch(/ORDER BY depth ASC/);
		expect(statements[0]?.params).toEqual(["m2", "user-1"]);
		expect(messages).toEqual([
			{ id: "m1", role: "user", content: "hi", createdAt: 1 },
			{
				id: "m2",
				role: "assistant",
				content: "",
				createdAt: 2,
				reasoning: "thinking",
				pending: true,
			},
			{ id: "m3", role: "assistant", content: "hello", createdAt: 3 },
		]);
		expect(messages[0]?.pending).toBeUndefined();
		expect(messages[2]?.pending).toBeUndefined();
	});
});

describe("toApiMessage", () => {
	it("throws when role is not user or assistant", () => {
		expect(() => toApiMessage(messageRow({ role: "system" }))).toThrow(/invalid message role/);
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

describe("summaryFor", () => {
	const chat = chatRow();
	const pendingLeaf = messageRow({
		id: "m2",
		role: "assistant",
		status: "pending",
		created_at: 1_000,
	});

	it("is generating when the pending leaf is younger than 120s", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS - 1).generating).toBe(true);
	});

	it("is not generating at the 120s boundary", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS).generating).toBe(false);
	});

	it("is not generating when the pending leaf is older than 120s", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS + 1).generating).toBe(false);
	});

	it("is not generating when the leaf is done or missing", () => {
		expect(summaryFor(chat, messageRow({ status: "done", created_at: 1_000 }), 2_000).generating).toBe(
			false,
		);
		expect(summaryFor(chat, null, 2_000).generating).toBe(false);
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

describe("gcRoot", () => {
	it("returns a reachability delete that excludes reachable ids", () => {
		const { db, statements } = makeDb({});
		const prepared = gcRoot(db, "user-1", "root-1");
		expect(prepared).toHaveLength(1);
		expect(statements).toHaveLength(1);
		expect(statements[0]?.sql).toBe(GC_ROOT_SQL);
		expect(statements[0]?.sql).toMatch(/WITH RECURSIVE reach/);
		expect(statements[0]?.sql).toMatch(/id NOT IN/);
		expect(statements[0]?.params).toEqual(["user-1", "root-1", "user-1", "root-1"]);
	});
});
