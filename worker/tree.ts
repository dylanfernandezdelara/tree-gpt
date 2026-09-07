/**
 * Shared read/GC primitives over the message tree. Every query here is
 * scoped by user_id; callers never see another user's rows.
 */
import type { ApiChat, ApiMessage, ChatRow, ChatSummary, MessageRow } from "./tree-types.js";

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

/**
 * Invariant: the returned array is exactly the root-to-leaf path of
 * `chat.leaf_id`, ordered by depth, with `pending: true` only on a pending
 * assistant row. Empty when leaf_id is null.
 */
export async function loadPath(db: D1Database, chat: ChatRow): Promise<ApiMessage[]> {
	void db;
	void chat;
	throw new Error("not implemented");
}

/**
 * Invariant: one path per chat of the user, keyed by chat id, in a bounded
 * number of queries (not one per chat). Pending rows are omitted because the
 * compat shape has no pending concept.
 */
export async function loadAllPaths(db: D1Database, userId: string): Promise<ApiChat[]> {
	void db;
	void userId;
	throw new Error("not implemented");
}

/**
 * Invariant: `generating` is true only when the leaf is a pending assistant
 * row younger than PENDING_TIMEOUT_MS as of `now`.
 */
export function summaryFor(chat: ChatRow, leaf: MessageRow | null, now: number): ChatSummary {
	void chat;
	void leaf;
	void now;
	throw new Error("not implemented");
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
	void db;
	void userId;
	void nodeId;
	void excludingChatId;
	throw new Error("not implemented");
}

/**
 * Invariant: returns the statements that delete every message of `rootId`
 * that is not on the path of any remaining chat of this user pointing into
 * that root. Must run after the pointer delete in the same batch (leaf_id is
 * ON DELETE RESTRICT).
 */
export function gcRoot(db: D1Database, userId: string, rootId: string): D1PreparedStatement[] {
	void db;
	void userId;
	void rootId;
	throw new Error("not implemented");
}

/** Row → wire shape. Exported so turns.ts and chats.ts render identically. */
export function toApiMessage(row: MessageRow): ApiMessage {
	void row;
	throw new Error("not implemented");
}
