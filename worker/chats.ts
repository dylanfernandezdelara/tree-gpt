/**
 * Compat routes for the pre-tree client: full-document GET list and PUT.
 * Shapes are frozen; the storage underneath is the message tree. These go
 * away once the UI is on /turns (see tree-routes.ts, turns.ts).
 *
 * PUT reconciles the linear document onto the tree in one D1 batch:
 * longest common id-prefix, then append / truncate / diverge / in-place
 * edit. A node shared with another chat cannot be edited in place through
 * this route (the client id is already taken), so that is a 409.
 */
import { ensureDomainUser, getSessionUser } from "./auth.js";
import {
	CHAT_COLUMNS,
	fail,
	gcRoot,
	loadPathRows,
	toApiMessage,
	type ChatRow,
	type MessageRow,
} from "./tree.js";
import {
	sanitizeCitations,
	sanitizeToolCalls,
	storedSearchJson,
} from "./search-meta.js";
import {
	MAX_CHATS,
	MAX_CONTENT,
	MAX_DEPTH,
	MAX_REASONING,
	MAX_TITLE,
	PENDING_TIMEOUT_MS,
	isId,
	isRole,
	isTimestamp,
	type ApiChat,
	type ApiMessage,
	type Role,
} from "./tree-types.js";

const SELECT_CHAT = `SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`;
const SELECT_CHAT_COUNT = `SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`;
const SELECT_LEAF_STATUS = `SELECT status, created_at FROM messages WHERE id = ? AND user_id = ?`;

export const CHATS_LIST_SQL = `
	SELECT ${CHAT_COLUMNS}
	FROM chats
	WHERE user_id = ?
	ORDER BY updated_at DESC, created_at DESC`;

/**
 * One recursive walk of every non-null leaf of the user's chats.
 * Bind order: (userId, userId).
 */
export const ALL_PATHS_SQL = `
	WITH RECURSIVE path(chat_id, id, parent_id, depth, role, status, content, reasoning, citations, tool_calls, created_at) AS (
		SELECT c.id, m.id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.citations, m.tool_calls, m.created_at
		FROM chats c
		JOIN messages m ON m.id = c.leaf_id AND m.user_id = c.user_id
		WHERE c.user_id = ?
		UNION ALL
		SELECT p.chat_id, m.id, m.parent_id, m.depth, m.role, m.status, m.content, m.reasoning, m.citations, m.tool_calls, m.created_at
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
const INSERT_MESSAGE = `INSERT INTO messages (id, user_id, root_id, parent_id, depth, role, status, content, reasoning, citations, tool_calls, created_at) SELECT ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?`;
const UPDATE_CHAT = `UPDATE chats SET leaf_id = ?, root_id = ?, title = ?, created_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND leaf_id IS ?`;
const INSERT_CHAT = `INSERT INTO chats (id, user_id, root_id, leaf_id, title, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?`;
const DELETE_STALE_PENDING = `DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`;

/** CAS: existing chat still points at the leaf we loaded. Bind: (chatId, userId, leafId). */
const CHAT_LEAF_GUARD = `EXISTS (SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND leaf_id IS ?)`;
/** CAS: chat id is still unused. Bind: (chatId). */
const CHAT_ABSENT_GUARD = `NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)`;

type ReconcileGuard = { sql: string; binds: unknown[] };

type ReconcilePlan = {
	statements: D1PreparedStatement[];
	pointerIndex: number;
	gcRootId: string | null;
};

type ExistingNode = {
	id: string;
	parent_id: string | null;
	role: string;
	content: string;
	reasoning: string | null;
	citations: string | null;
	tool_calls: string | null;
};

type InPlaceEdit = {
	id: string;
	content: string;
	reasoning: string | null;
	citations?: string | null;
	toolCalls?: string | null;
};

type PathNodeRow = {
	chat_id: string;
	id: string;
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
 * Invariant: true iff `nodeId` lies on the path of some chat of this user
 * other than `excludingChatId`. Used by the compat PUT to refuse in-place
 * edits of nodes another chat also renders.
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

export async function handleChatsRequest(
	request: Request,
	env: Env,
	chatId: string | null,
): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return fail(401, "Unauthorized");
	}

	if (chatId === null) {
		if (request.method !== "GET") {
			return fail(405, "Use GET");
		}
		return listCallerChats(env.DB, user.id);
	}

	if (request.method === "PUT") {
		return replaceChat(request, env, user, chatId);
	}

	return fail(405, "Use PUT");
}

async function listCallerChats(db: D1Database, userId: string): Promise<Response> {
	try {
		const chats = await loadAllPaths(db, userId);
		return Response.json({ chats });
	} catch {
		return fail(500, "Could not load chats");
	}
}

async function replaceChat(
	request: Request,
	env: Env,
	user: { id: string; email: string },
	chatId: string,
): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return fail(400, "Invalid JSON body");
	}

	const parsed = parseChat(body);
	if (!parsed.ok) {
		return fail(400, parsed.error);
	}

	if (parsed.chat.id !== chatId) {
		return fail(400, "Chat id must match the URL");
	}

	const existing = await env.DB.prepare(SELECT_CHAT).bind(chatId).first<ChatRow>();

	if (existing && existing.user_id !== user.id) {
		return fail(404, "Not found");
	}

	if (!existing) {
		const countRow = await env.DB.prepare(SELECT_CHAT_COUNT)
			.bind(user.id)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_CHATS) {
			return fail(400, "Chat limit reached");
		}
	}

	await ensureDomainUser(env.DB, user);

	let stalePendingLeafId: string | null = null;
	if (existing?.leaf_id) {
		const leaf = await env.DB.prepare(SELECT_LEAF_STATUS)
			.bind(existing.leaf_id, user.id)
			.first<{ status: string; created_at: number }>();
		if (leaf?.status === "pending") {
			if (Date.now() - leaf.created_at < PENDING_TIMEOUT_MS) {
				return fail(409, "Chat is generating");
			}
			stalePendingLeafId = existing.leaf_id;
		}
	}

	const incoming = parsed.chat.messages;
	const path = existing ? await loadDonePath(env.DB, existing, user.id) : [];

	const prefix = await resolvePrefixEdits(env.DB, user.id, chatId, path, incoming);
	if (!prefix.ok) {
		return fail(prefix.status, prefix.error);
	}

	const plan = buildReconcileBatch(
		env.DB,
		user.id,
		parsed.chat,
		existing,
		path,
		prefix.k,
		prefix.edits,
		prefix.skipInsert,
		stalePendingLeafId,
	);

	try {
		const results = await env.DB.batch(plan.statements);
		if ((results[plan.pointerIndex]?.meta.changes ?? 0) === 0) {
			return fail(409, "Chat changed, reload");
		}
		if (plan.gcRootId) {
			await env.DB.batch(gcRoot(env.DB, user.id, plan.gcRootId));
		}
	} catch {
		return fail(500, "Could not save chat");
	}

	return Response.json({ chat: parsed.chat });
}

async function loadDonePath(
	db: D1Database,
	chat: ChatRow,
	userId: string,
): Promise<MessageRow[]> {
	if (!chat.leaf_id) {
		return [];
	}
	return loadPathRows(db, userId, chat.leaf_id, { doneOnly: true });
}

/**
 * Longest common id-prefix, then walk it for content/reasoning edits.
 * A shared node cannot be mutated in place, and the client id is already
 * taken so it cannot be re-inserted as a sibling either: 409.
 */
async function resolvePrefixEdits(
	db: D1Database,
	userId: string,
	chatId: string,
	path: MessageRow[],
	incoming: ApiMessage[],
): Promise<
	| { ok: true; k: number; edits: InPlaceEdit[]; skipInsert: Map<string, InPlaceEdit | null> }
	| { ok: false; status: 400 | 409; error: string }
> {
	const k = longestCommonPrefix(path, incoming);
	const edits: InPlaceEdit[] = [];
	for (let i = 0; i < k; i += 1) {
		const row = path[i];
		const message = incoming[i];
		if (row === undefined || message === undefined) {
			break;
		}
		if (!messageFieldsChanged(row, message)) {
			continue;
		}
		if (await isShared(db, userId, row.id, chatId)) {
			return {
				ok: false,
				status: 409,
				error: "Message is shared with another chat and cannot be edited here",
			};
		}
		edits.push(editFromMessage(message, row.id));
	}

	const tail = incoming.slice(k);
	const existingById = await loadExistingNodes(
		db,
		userId,
		tail.map((message) => message.id),
	);
	const pathIds = new Set(path.map((row) => row.id));
	const skipInsert = new Map<string, InPlaceEdit | null>();

	for (let j = k; j < incoming.length; j += 1) {
		const message = incoming[j];
		if (message === undefined) {
			continue;
		}
		const existingNode = existingById.get(message.id);
		if (!existingNode) {
			continue;
		}
		if (pathIds.has(message.id)) {
			return { ok: false, status: 400, error: "message ids must be unique" };
		}
		const parent = intendedParent(incoming, j);
		if (existingNode.parent_id !== parent || existingNode.role !== message.role) {
			return { ok: false, status: 400, error: "message ids must be unique" };
		}
		// Client re-sent an id that already lives on this user (typically an
		// orphaned tail after redo-then-redo). Parent+role match: skip INSERT
		// (avoids the PK) and UPDATE content/reasoning when they differ.
		if (messageFieldsChanged(existingNode, message)) {
			skipInsert.set(message.id, editFromMessage(message, message.id));
		} else {
			skipInsert.set(message.id, null);
		}
	}

	return { ok: true, k, edits, skipInsert };
}

async function loadExistingNodes(
	db: D1Database,
	userId: string,
	ids: string[],
): Promise<Map<string, ExistingNode>> {
	if (ids.length === 0) {
		return new Map();
	}
	const placeholders = ids.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT id, parent_id, role, content, reasoning, citations, tool_calls FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
		)
		.bind(userId, ...ids)
		.all<ExistingNode>();
	return new Map(result.results.map((row) => [row.id, row]));
}

function reconcileGuard(existing: ChatRow | null, chatId: string, userId: string): ReconcileGuard {
	if (existing) {
		return { sql: CHAT_LEAF_GUARD, binds: [chatId, userId, existing.leaf_id] };
	}
	return { sql: CHAT_ABSENT_GUARD, binds: [chatId] };
}

function buildReconcileBatch(
	db: D1Database,
	userId: string,
	chat: ApiChat,
	existing: ChatRow | null,
	path: MessageRow[],
	k: number,
	edits: InPlaceEdit[],
	skipInsert: Map<string, InPlaceEdit | null>,
	stalePendingLeafId: string | null,
): ReconcilePlan {
	const incoming = chat.messages;
	const statements: D1PreparedStatement[] = [];
	const guard = reconcileGuard(existing, chat.id, userId);

	for (const edit of edits) {
		const update = messageUpdate(edit, userId, false);
		statements.push(
			db.prepare(`${update.sql} AND ${guard.sql}`).bind(...update.params, ...guard.binds),
		);
	}

	const rootId = pointerRootId(path, incoming, k);
	const leafId = pointerLeafId(incoming);

	// Case A (append) and Case C (divergence) share this insert loop:
	// parent of node j is M[j-1] (null at j === 0, which is a new root).
	// Case B (truncate) and Case D (no structural change) skip it.
	for (let j = k; j < incoming.length; j += 1) {
		const message = incoming[j];
		if (message === undefined) {
			continue;
		}
		const reattached = skipInsert.get(message.id);
		if (skipInsert.has(message.id)) {
			if (reattached) {
				const update = messageUpdate(reattached, userId, true);
				statements.push(
					db.prepare(`${update.sql} AND ${guard.sql}`).bind(...update.params, ...guard.binds),
				);
			}
			continue;
		}
		statements.push(
			db
				.prepare(`${INSERT_MESSAGE} WHERE ${guard.sql}`)
				.bind(
					message.id,
					userId,
					rootId ?? message.id,
					intendedParent(incoming, j),
					j,
					message.role,
					message.content,
					storedReasoning(message),
					storedSearchJson(message.citations) ?? null,
					storedSearchJson(message.toolCalls) ?? null,
					message.createdAt,
					...guard.binds,
				),
		);
	}

	const pointerIndex = statements.length;
	if (existing) {
		statements.push(
			db
				.prepare(UPDATE_CHAT)
				.bind(
					leafId,
					rootId,
					chat.title,
					chat.createdAt,
					chat.updatedAt,
					chat.id,
					userId,
					existing.leaf_id,
				),
		);
	} else {
		// Nodes first so chats.leaf_id FK can resolve.
		statements.push(
			db
				.prepare(`${INSERT_CHAT} WHERE ${guard.sql}`)
				.bind(
					chat.id,
					userId,
					rootId,
					leafId,
					chat.title,
					chat.createdAt,
					chat.updatedAt,
					...guard.binds,
				),
		);
	}

	// Stale pending leaf (older than PENDING_TIMEOUT_MS): drop it after the
	// pointer has moved off it. Skip if the client re-attached that id.
	if (stalePendingLeafId && !incoming.some((message) => message.id === stalePendingLeafId)) {
		statements.push(
			db.prepare(DELETE_STALE_PENDING).bind(stalePendingLeafId, userId),
		);
	}

	// Pointer left its old root (cleared chat or fully diverged document):
	// reclaim after the CAS pointer write actually moves the row.
	const gcRootId =
		existing?.root_id && existing.root_id !== rootId ? existing.root_id : null;

	return { statements, pointerIndex, gcRootId };
}

function longestCommonPrefix(path: MessageRow[], incoming: ApiMessage[]): number {
	const limit = Math.min(path.length, incoming.length);
	let k = 0;
	while (k < limit) {
		const row = path[k];
		const message = incoming[k];
		if (row === undefined || message === undefined || row.id !== message.id) {
			break;
		}
		k += 1;
	}
	return k;
}

function messageFieldsChanged(
	row: { content: string; reasoning: string | null; citations?: string | null; tool_calls?: string | null },
	message: ApiMessage,
): boolean {
	if (row.content !== message.content || (row.reasoning ?? undefined) !== message.reasoning) {
		return true;
	}
	if (message.citations !== undefined && (row.citations ?? null) !== (storedSearchJson(message.citations) ?? null)) {
		return true;
	}
	if (message.toolCalls !== undefined && (row.tool_calls ?? null) !== (storedSearchJson(message.toolCalls) ?? null)) {
		return true;
	}
	return false;
}

function editFromMessage(message: ApiMessage, id: string): InPlaceEdit {
	const edit: InPlaceEdit = {
		id,
		content: message.content,
		reasoning: storedReasoning(message),
	};
	if (message.citations !== undefined) {
		edit.citations = storedSearchJson(message.citations) ?? null;
	}
	if (message.toolCalls !== undefined) {
		edit.toolCalls = storedSearchJson(message.toolCalls) ?? null;
	}
	return edit;
}

function messageUpdate(
	edit: InPlaceEdit,
	userId: string,
	markDone: boolean,
): { sql: string; params: unknown[] } {
	const sets = ["content = ?", "reasoning = ?"];
	const params: unknown[] = [edit.content, edit.reasoning];
	if (edit.citations !== undefined) {
		sets.push("citations = ?");
		params.push(edit.citations);
	}
	if (edit.toolCalls !== undefined) {
		sets.push("tool_calls = ?");
		params.push(edit.toolCalls);
	}
	if (markDone) {
		sets.push("status = 'done'");
	}
	return {
		sql: `UPDATE messages SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
		params: [...params, edit.id, userId],
	};
}

function storedReasoning(message: ApiMessage): string | null {
	return message.role === "assistant" && message.reasoning ? message.reasoning : null;
}

function intendedParent(incoming: ApiMessage[], j: number): string | null {
	if (j === 0) {
		return null;
	}
	const parent = incoming[j - 1];
	return parent === undefined ? null : parent.id;
}

function pointerLeafId(incoming: ApiMessage[]): string | null {
	const last = incoming[incoming.length - 1];
	return last === undefined ? null : last.id;
}

function pointerRootId(path: MessageRow[], incoming: ApiMessage[], k: number): string | null {
	if (k > 0) {
		return path[0]?.id ?? null;
	}
	return incoming[0]?.id ?? null;
}

function parseChat(
	body: unknown,
): { ok: true; chat: ApiChat } | { ok: false; error: string } {
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Invalid JSON body" };
	}

	if (!("id" in body) || !isId(body.id)) {
		return { ok: false, error: "id is invalid" };
	}
	if (!("title" in body) || typeof body.title !== "string") {
		return { ok: false, error: "title must be a string" };
	}
	if (!("createdAt" in body) || !isTimestamp(body.createdAt)) {
		return { ok: false, error: "createdAt must be a timestamp" };
	}
	if (!("updatedAt" in body) || !isTimestamp(body.updatedAt)) {
		return { ok: false, error: "updatedAt must be a timestamp" };
	}
	if (!("messages" in body) || !Array.isArray(body.messages)) {
		return { ok: false, error: "messages must be an array" };
	}
	if (body.messages.length > MAX_DEPTH) {
		return { ok: false, error: "too many messages" };
	}

	const title = body.title.trim() || "New chat";
	if (title.length > MAX_TITLE) {
		return { ok: false, error: "title is too long" };
	}

	const seen = new Set<string>();
	const messages: ApiMessage[] = [];
	for (const item of body.messages) {
		const message = parseMessage(item);
		if (!message.ok) {
			return message;
		}
		if (seen.has(message.value.id)) {
			return { ok: false, error: "message ids must be unique" };
		}
		seen.add(message.value.id);
		messages.push(message.value);
	}

	return {
		ok: true,
		chat: {
			id: body.id,
			title,
			createdAt: body.createdAt,
			updatedAt: body.updatedAt,
			messages,
		},
	};
}

function parseMessage(
	item: unknown,
): { ok: true; value: ApiMessage } | { ok: false; error: string } {
	if (typeof item !== "object" || item === null) {
		return { ok: false, error: "messages items must be objects" };
	}
	if (!("id" in item) || !isId(item.id)) {
		return { ok: false, error: "message id is invalid" };
	}
	if (!("role" in item) || !isRole(item.role)) {
		return { ok: false, error: "message role must be user or assistant" };
	}
	if (!("content" in item) || typeof item.content !== "string") {
		return { ok: false, error: "message content must be a string" };
	}
	if (!("createdAt" in item) || !isTimestamp(item.createdAt)) {
		return { ok: false, error: "message createdAt must be a timestamp" };
	}

	const content = item.content.trim();
	if (!content) {
		return { ok: false, error: "message content must not be empty" };
	}
	if (content.length > MAX_CONTENT) {
		return { ok: false, error: "message content is too long" };
	}

	// Display-only thinking trace: kept for rendering, never sent upstream.
	// Liberal parsing (drop wrong types, truncate long traces) so a display
	// garnish can never reject an otherwise valid chat. Legacy
	// reasoningDetails blobs are accepted and dropped.
	const reasoning =
		item.role === "assistant" && "reasoning" in item && typeof item.reasoning === "string"
			? item.reasoning.slice(0, MAX_REASONING)
			: undefined;
	const citations =
		item.role === "assistant" && "citations" in item
			? sanitizeCitations(item.citations)
			: undefined;
	const toolCalls =
		item.role === "assistant" && ("toolCalls" in item || "tool_calls" in item)
			? sanitizeToolCalls("toolCalls" in item ? item.toolCalls : item.tool_calls)
			: undefined;
	return {
		ok: true,
		value: {
			id: item.id,
			role: item.role,
			content,
			createdAt: item.createdAt,
			...(reasoning ? { reasoning } : {}),
			...(citations !== undefined ? { citations } : {}),
			...(toolCalls !== undefined ? { toolCalls } : {}),
		},
	};
}
