import { vi } from "vitest";
import type { ChatRow, MessageRow } from "../tree.js";

export type RecordedStatement = { sql: string; params: unknown[] };

export type MakeDbHooks = {
	first?: (sql: string, params: unknown[]) => Promise<unknown>;
	all?: (sql: string, params: unknown[]) => Promise<{ results: unknown[] }>;
	run?: (sql: string, params: unknown[]) => Promise<{ meta: { changes: number } }>;
	batch?: (stmts: RecordedStatement[]) => Promise<unknown>;
	batchResult?: (stmt: RecordedStatement, index: number) => { meta: { changes: number } };
};

export function makeDb(hooks: MakeDbHooks = {}) {
	const statements: RecordedStatement[] = [];
	const batch = vi.fn(async (stmts: RecordedStatement[]) => {
		if (hooks.batch) {
			return hooks.batch(stmts);
		}
		if (hooks.batchResult) {
			return stmts.map((stmt, index) => hooks.batchResult?.(stmt, index) ?? { meta: { changes: 1 } });
		}
		return stmts.map(() => ({ meta: { changes: 1 } }));
	});
	const db = {
		prepare: vi.fn((sql: string) => ({
			bind: (...params: unknown[]) => {
				const recorded: RecordedStatement = { sql, params };
				statements.push(recorded);
				return {
					sql,
					params,
					first: () => hooks.first?.(sql, params) ?? Promise.resolve(undefined),
					all: () => hooks.all?.(sql, params) ?? Promise.resolve({ results: [] }),
					run: () => hooks.run?.(sql, params) ?? Promise.resolve({ meta: { changes: 1 } }),
				};
			},
		})),
		batch,
	};
	return {
		db: db as unknown as D1Database,
		statements,
		batch,
		getBatch: () => (batch.mock.calls[0]?.[0] ?? []) as RecordedStatement[],
	};
}

export function chatRow(overrides: Partial<ChatRow> = {}): ChatRow {
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

export function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
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
