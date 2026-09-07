/**
 * Shared read/GC primitives over the message tree. Every query here is
 * scoped by user_id; callers never see another user's rows.
 */
import {
	PENDING_TIMEOUT_MS,
	isRole,
	type ApiChat,
	type ApiMessage,
	type ChatRow,
	type ChatSummary,
	type MessageRow,
} from "./tree-types.js";

/**
 * Recursive CTE from a leaf up to its root. Bind order: (leafId, userId).
 * Consumers ORDER BY depth to get the root-to-leaf path.
 */
export const PATH_CTE = `
	WITH RECURSIVE path(id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at) AS (
		SELECT id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at
		FROM messages WHERE id = ? AND user_id = ?
		UNION ALL
		SELECT m.id, m.user_id, m.root_id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.created_at
		FROM messages m JOIN path p ON m.id = p.parent_id AND m.user_id = p.user_id
	)`;

/** PATH_CTE plus the root-to-leaf select. Bind order: (leafId, userId). */
export const PATH_SQL = `${PATH_CTE}
	SELECT id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at
	FROM path
	ORDER BY depth ASC`;

/**
 * One recursive walk of every non-null leaf of the user's chats.
 * Bind order: (userId, userId).
 */
export const ALL_PATHS_SQL = `
	WITH RECURSIVE path(chat_id, id, parent_id, depth, role, status, content, reasoning, created_at) AS (
		SELECT c.id, m.id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.created_at
		FROM chats c
		JOIN messages m ON m.id = c.leaf_id AND m.user_id = c.user_id
		WHERE c.user_id = ?
		UNION ALL
		SELECT p.chat_id, m.id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.created_at
		FROM messages m
		JOIN path p ON m.id = p.parent_id AND m.user_id = ?
	)
	SELECT * FROM path ORDER BY chat_id, depth`;

/**
 * True iff nodeId is on another chat's path in the same root.
 * Bind order: (userId, excludingChatId, nodeId, nodeId).
 */
export const IS_SHARED_SQL = `
	WITH RECURSIVE path(id, parent_id) AS (
		SELECT m.id, m.parent_id
		FROM chats c
		JOIN messages m ON m.id = c.leaf_id AND m.user_id = c.user_id
		WHERE c.user_id = ?
		  AND c.id != ?
		  AND c.root_id = (SELECT root_id FROM messages WHERE id = ?)
		UNION ALL
		SELECT m.id, m.parent_id
		FROM messages m
		JOIN path p ON m.id = p.parent_id
	)
	SELECT EXISTS(SELECT 1 FROM path WHERE id = ?) AS shared`;

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

export const CHATS_LIST_SQL = `
	SELECT id, user_id, root_id, leaf_id, title, created_at, updated_at
	FROM chats
	WHERE user_id = ?
	ORDER BY updated_at DESC, created_at DESC`;

type PathNodeRow = {
	chat_id: string;
	id: string;
	parent_id: string | null;
	depth: number;
	role: string;
	status: string;
	content: string;
	reasoning: string | null;
	created_at: number;
};

/** What summaryFor needs from the leaf row. */
export type LeafState = Pick<MessageRow, "status" | "created_at">;

/** What toApiMessage needs from a node row. */
export type RenderableRow = Pick<
	MessageRow,
	"id" | "role" | "content" | "reasoning" | "status" | "created_at"
>;

/**
 * Invariant: the returned array is exactly the root-to-leaf path of
 * `chat.leaf_id`, ordered by depth, with `pending: true` only on a pending
 * assistant row. Empty when leaf_id is null.
 */
export async function loadPath(db: D1Database, chat: ChatRow): Promise<ApiMessage[]> {
	if (chat.leaf_id === null) {
		return [];
	}

	const result = await db
		.prepare(PATH_SQL)
		.bind(chat.leaf_id, chat.user_id)
		.all<MessageRow>();

	return result.results.map(toApiMessage);
}

/**
 * Invariant: one path per chat of the user, keyed by chat id, in a bounded
 * number of queries (not one per chat). Pending rows are omitted because the
 * compat shape has no pending concept.
 */
export async function loadAllPaths(db: D1Database, userId: string): Promise<ApiChat[]> {
	const chatResult = await db.prepare(CHATS_LIST_SQL).bind(userId).all<ChatRow>();
	const chats = chatResult.results;
	if (chats.length === 0) {
		return [];
	}

	const pathResult = await db.prepare(ALL_PATHS_SQL).bind(userId, userId).all<PathNodeRow>();
	const byChat = new Map<string, ApiMessage[]>();
	for (const row of pathResult.results) {
		if (row.status === "pending") {
			continue;
		}
		const list = byChat.get(row.chat_id) ?? [];
		list.push(toApiMessage(row));
		byChat.set(row.chat_id, list);
	}

	return chats.map((chat) => ({
		id: chat.id,
		title: chat.title,
		createdAt: chat.created_at,
		updatedAt: chat.updated_at,
		messages: byChat.get(chat.id) ?? [],
	}));
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
 * Invariant: true iff `nodeId` lies on the path of some chat of this user
 * other than `excludingChatId`. Used by the compat PUT to decide between an
 * in-place edit and a sibling branch.
 */
export async function isShared(
	db: D1Database,
	userId: string,
	nodeId: string,
	excludingChatId: string,
): Promise<boolean> {
	const row = await db
		.prepare(IS_SHARED_SQL)
		.bind(userId, excludingChatId, nodeId, nodeId)
		.first<{ shared: number }>();
	return (row?.shared ?? 0) !== 0;
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
	if (!isRole(row.role)) {
		throw new Error(`invalid message role: ${row.role}`);
	}

	const message: ApiMessage = {
		id: row.id,
		role: row.role,
		content: row.content,
		createdAt: row.created_at,
	};
	if (row.role === "assistant" && row.reasoning) {
		message.reasoning = row.reasoning;
	}
	if (row.status === "pending") {
		message.pending = true;
	}
	return message;
}
