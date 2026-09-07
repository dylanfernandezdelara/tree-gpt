import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatsRequest } from "./chats.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	ensureDomainUser: vi.fn(async () => {}),
}));

type RecordedStatement = { sql: string; params: unknown[] };

function makeDb(hooks: {
	first?: (sql: string) => Promise<unknown>;
	all?: (sql: string) => Promise<{ results: unknown[] }>;
}) {
	const statements: RecordedStatement[] = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			bind: (...params: unknown[]) => {
				statements.push({ sql, params });
				return {
					first: () => hooks.first?.(sql) ?? Promise.resolve(undefined),
					all: () => hooks.all?.(sql) ?? Promise.resolve({ results: [] }),
					run: () => Promise.resolve({ meta: { changes: 1 } }),
				};
			},
		})),
		batch: vi.fn(async () => []),
	};
	return { db: db as unknown as D1Database, statements };
}

const envWith = (db: D1Database) => ({ DB: db }) as unknown as Env;

const chatBody = (messages: Record<string, unknown>[]) => ({
	id: "chat-1",
	title: "Test chat",
	createdAt: 1,
	updatedAt: 2,
	messages,
});

describe("handleChatsRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("PUT accepts legacy reasoningDetails but never writes the column", async () => {
		const { db, statements } = makeDb({
			first: async (sql) => (sql.includes("COUNT(*)") ? { n: 0 } : undefined),
		});
		const request = new Request("http://localhost:5173/api/chats/chat-1", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				chatBody([
					{ id: "m1", role: "user", content: "hi", createdAt: 1 },
					{
						id: "m2",
						role: "assistant",
						content: "hello",
						createdAt: 2,
						reasoningDetails: [{ type: "reasoning.text", text: "old thinking" }],
					},
				]),
			),
		});

		const response = await handleChatsRequest(request, envWith(db));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chat: { messages: Record<string, unknown>[] };
		};
		for (const message of body.chat.messages) {
			expect("reasoningDetails" in message).toBe(false);
		}
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) {
			expect(statement.sql.includes("reasoning_details")).toBe(false);
		}
		const insert = statements.find((s) => s.sql.startsWith("INSERT INTO messages"));
		expect(insert).toBeDefined();
		expect(insert?.params).toHaveLength(5);
	});

	it("GET returns messages without reasoningDetails", async () => {
		const { db } = makeDb({
			all: async (sql) => {
				if (sql.includes("FROM chats")) {
					return {
						results: [{ id: "chat-1", title: "t", created_at: 1, updated_at: 2 }],
					};
				}
				return {
					results: [
						{ id: "m1", chat_id: "chat-1", role: "user", content: "hi", created_at: 1 },
						{
							id: "m2",
							chat_id: "chat-1",
							role: "assistant",
							content: "hello",
							created_at: 2,
						},
					],
				};
			},
		});

		const response = await handleChatsRequest(
			new Request("http://localhost:5173/api/chats"),
			envWith(db),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			chats: { messages: Record<string, unknown>[] }[];
		};
		expect(body.chats).toHaveLength(1);
		for (const message of body.chats[0]?.messages ?? []) {
			expect("reasoningDetails" in message).toBe(false);
		}
	});
});
