/**
 * Shared read/GC primitives over the message tree. Every query here is
 * scoped by user_id; callers never see another user's rows.
 */
import { parseStoredSearchJson, sanitizeCitations, sanitizeToolCalls } from "./search-meta.js";
import { PENDING_TIMEOUT_MS, type ApiMessage, type ChatSummary, type Role } from "./tree-types.js";

export type ChatRow = {
	id: string;
	user_id: string;
	root_id: string | null;
	leaf_id: string | null;
	title: string;
	created_at: number;
	updated_at: number;
};

export type MessageRow = {
	id: string;
	user_id: string;
	root_id: string;
	parent_id: string | null;
	depth: number;
	role: Role;
	status: "pending" | "done";
	content: string;
	reasoning: string | null;
	citations: string | null;
	tool_calls: string | null;
	created_at: number;
};

export const CHAT_COLUMNS = `id, user_id, root_id, leaf_id, title, created_at, updated_at`;

export const MESSAGE_COLUMNS = `id, user_id, root_id, parent_id, depth, role, status, content, reasoning, citations, tool_calls, created_at`;

export const CHAT_ROW_SQL = `SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ? AND user_id = ?`;

export const MESSAGE_ROW_SQL = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND user_id = ?`;

/**
 * Recursive CTE from a leaf up to its root. Bind order: (leafId, userId).
 * Consumers ORDER BY depth to get the root-to-leaf path.
 */
export const PATH_CTE = `
	WITH RECURSIVE path(id, user_id, root_id, parent_id, depth, role, status, content, reasoning, citations, tool_calls, created_at) AS (
		SELECT id, user_id, root_id, parent_id, depth, role, status, content, reasoning, citations, tool_calls, created_at
		FROM messages WHERE id = ? AND user_id = ?
		UNION ALL
		SELECT m.id, m.user_id, m.root_id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.citations, m.tool_calls, m.created_at
		FROM messages m JOIN path p ON m.id = p.parent_id AND m.user_id = p.user_id
	)`;

/** PATH_CTE plus the root-to-leaf select. Bind order: (leafId, userId). */
export const PATH_SQL = `${PATH_CTE}
	SELECT ${MESSAGE_COLUMNS}
	FROM path
	ORDER BY depth ASC`;

/** PATH_CTE plus done-only root-to-leaf select. Bind order: (leafId, userId). */
export const PATH_DONE_SQL = `${PATH_CTE}
	SELECT ${MESSAGE_COLUMNS}
	FROM path
	WHERE status = 'done'
	ORDER BY depth ASC`;

const SUMMARY_SELECT = `SELECT
				c.id,
				c.user_id,
				c.root_id,
				c.leaf_id,
				c.title,
				c.created_at,
				c.updated_at,
				leaf.status AS leaf_status,
				leaf.created_at AS leaf_created_at
			 FROM chats c
			 LEFT JOIN messages leaf ON leaf.id = c.leaf_id`;

/** All of a user's chat pointers joined to their leaf. Bind order: (userId). */
export const SUMMARY_SQL = `${SUMMARY_SELECT}
			 WHERE c.user_id = ?
			 ORDER BY c.updated_at DESC, c.created_at DESC`;

/** One chat pointer joined to its leaf. Bind order: (chatId, userId). */
export const SUMMARY_BY_ID_SQL = `${SUMMARY_SELECT}
			 WHERE c.id = ? AND c.user_id = ?`;

/**
 * Delete every message of a root that is not on any remaining chat path.
 * Bind order: (userId, rootId, userId, rootId).
 */
export const GC_ROOT_SQL = `
	DELETE FROM messages
	WHERE user_id = ? AND root_id = ?
	  AND id NOT IN (
		WITH RECURSIVE reach(id, parent_id) AS (
			SELECT m.id, m.parent_id
			FROM chats c
			JOIN messages m ON m.id = c.leaf_id
			WHERE c.user_id = ? AND c.root_id = ?
			UNION
			SELECT m.id, m.parent_id
			FROM messages m
			JOIN reach r ON m.id = r.parent_id
		)
		SELECT id FROM reach
	)`;

export type SummaryJoinRow = ChatRow & {
	leaf_status: string | null;
	leaf_created_at: number | null;
};

/** What summaryFor needs from the leaf row. */
export type LeafState = Pick<MessageRow, "status" | "created_at">;

/** What toApiMessage needs from a node row. */
export type RenderableRow = Pick<
	MessageRow,
	"id" | "role" | "content" | "reasoning" | "citations" | "tool_calls" | "status" | "created_at"
>;

export function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
	return Response.json({ ok: false, error, ...extra }, { status });
}

export async function loadChatRow(
	db: D1Database,
	userId: string,
	chatId: string,
): Promise<ChatRow | null> {
	const row = await db.prepare(CHAT_ROW_SQL).bind(chatId, userId).first<ChatRow>();
	return row ?? null;
}

export async function loadMessageRow(
	db: D1Database,
	userId: string,
	messageId: string,
): Promise<MessageRow | null> {
	const row = await db.prepare(MESSAGE_ROW_SQL).bind(messageId, userId).first<MessageRow>();
	return row ?? null;
}

export async function loadSummary(
	db: D1Database,
	userId: string,
	chatId: string,
	now: number,
): Promise<ChatSummary | null> {
	const row = await db.prepare(SUMMARY_BY_ID_SQL).bind(chatId, userId).first<SummaryJoinRow>();
	return row ? summaryFromJoin(row, now) : null;
}

export function summaryFromJoin(row: SummaryJoinRow, now: number): ChatSummary {
	return summaryFor(row, leafState(row), now);
}

/**
 * Invariant: the returned array is the root-to-leaf walk of `leafId`,
 * ordered by depth. `doneOnly` drops pending rows.
 */
export async function loadPathRows(
	db: D1Database,
	userId: string,
	leafId: string,
	opts?: { doneOnly?: boolean },
): Promise<MessageRow[]> {
	const sql = opts?.doneOnly ? PATH_DONE_SQL : PATH_SQL;
	const result = await db.prepare(sql).bind(leafId, userId).all<MessageRow>();
	return result.results;
}

/**
 * Invariant: the returned array is exactly the root-to-leaf path of
 * `chat.leaf_id`, ordered by depth, with `pending: true` only on a pending
 * assistant row. Empty when leaf_id is null.
 */
export async function loadPath(
	db: D1Database,
	chat: Pick<ChatRow, "user_id" | "leaf_id">,
): Promise<ApiMessage[]> {
	if (chat.leaf_id === null) {
		return [];
	}

	const rows = await loadPathRows(db, chat.user_id, chat.leaf_id);
	return rows.map(toApiMessage);
}

/**
 * Invariant: `generating` is true only when the leaf is a pending assistant
 * row younger than PENDING_TIMEOUT_MS as of `now`.
 */
export function summaryFor(chat: ChatRow, leaf: LeafState | null, now: number): ChatSummary {
	return {
		id: chat.id,
		title: chat.title,
		rootId: chat.root_id,
		leafId: chat.leaf_id,
		generating: leaf !== null && leaf.status === "pending" && now - leaf.created_at < PENDING_TIMEOUT_MS,
		createdAt: chat.created_at,
		updatedAt: chat.updated_at,
	};
}

/**
 * Invariant: returns the statements that delete every message of `rootId`
 * that is not on the path of any remaining chat of this user pointing into
 * that root. Must run after the pointer delete in the same batch (leaf_id is
 * ON DELETE RESTRICT).
 */
export function gcRoot(db: D1Database, userId: string, rootId: string): D1PreparedStatement[] {
	return [db.prepare(GC_ROOT_SQL).bind(userId, rootId, userId, rootId)];
}

/** Row → wire shape. Exported so turns.ts and chats.ts render identically. */
export function toApiMessage(row: RenderableRow): ApiMessage {
	const message: ApiMessage = {
		id: row.id,
		role: row.role,
		content: row.content,
		createdAt: row.created_at,
	};
	if (row.role === "assistant" && row.reasoning) {
		message.reasoning = row.reasoning;
	}
	if (row.role === "assistant") {
		const citations = parseStoredSearchJson(row.citations, sanitizeCitations);
		const toolCalls = parseStoredSearchJson(row.tool_calls, sanitizeToolCalls);
		if (citations) {
			message.citations = citations;
		}
		if (toolCalls) {
			message.toolCalls = toolCalls;
		}
	}
	if (row.status === "pending") {
		message.pending = true;
	}
	return message;
}

function leafState(row: SummaryJoinRow): LeafState | null {
	if (row.leaf_status !== "pending" && row.leaf_status !== "done") {
		return null;
	}
	if (typeof row.leaf_created_at !== "number") {
		return null;
	}
	return { status: row.leaf_status, created_at: row.leaf_created_at };
}
