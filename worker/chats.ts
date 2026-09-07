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
import { gcRoot, isShared, loadAllPaths, PATH_CTE } from "./tree.js";
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
	type ChatRow,
	type MessageRow,
} from "./tree-types.js";

/** Array cap of the compat PUT; maps 1:1 onto the schema's depth < MAX_DEPTH. */
const MAX_MESSAGES = MAX_DEPTH;

const SELECT_CHAT = `SELECT id, user_id, root_id, leaf_id, title, created_at, updated_at FROM chats WHERE id = ?`;
const SELECT_CHAT_COUNT = `SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`;
const SELECT_LEAF_STATUS = `SELECT status, created_at FROM messages WHERE id = ? AND user_id = ?`;
const SELECT_PATH_DONE = `${PATH_CTE} SELECT * FROM path WHERE status = 'done' ORDER BY depth ASC`;
const UPDATE_MESSAGE = `UPDATE messages SET content = ?, reasoning = ? WHERE id = ? AND user_id = ?`;
const UPDATE_REATTACHED = `UPDATE messages SET content = ?, reasoning = ?, status = 'done' WHERE id = ? AND user_id = ?`;
const INSERT_MESSAGE = `INSERT INTO messages (id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)`;
const UPDATE_CHAT = `UPDATE chats SET leaf_id = ?, root_id = ?, title = ?, created_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`;
const INSERT_CHAT = `INSERT INTO chats (id, user_id, root_id, leaf_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const DELETE_STALE_PENDING = `DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`;

type ExistingNode = {
	id: string;
	parent_id: string | null;
	role: string;
	content: string;
	reasoning: string | null;
};

type InPlaceEdit = {
	id: string;
	content: string;
	reasoning: string | null;
};

export async function handleChatsRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const user = await getSessionUser(request, env);
	if (!user) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	if (url.pathname === "/api/chats") {
		if (request.method !== "GET") {
			return Response.json({ ok: false, error: "Use GET" }, { status: 405 });
		}
		return listCallerChats(env.DB, user.id);
	}

	const chatId = parseChatId(url.pathname);
	if (!chatId) {
		return Response.json({ ok: false, error: "Not found" }, { status: 404 });
	}

	if (request.method === "PUT") {
		return replaceChat(request, env, user, chatId);
	}

	return Response.json({ ok: false, error: "Use PUT" }, { status: 405 });
}

async function listCallerChats(db: D1Database, userId: string): Promise<Response> {
	try {
		const chats = await loadAllPaths(db, userId);
		return Response.json({ chats });
	} catch {
		return Response.json({ ok: false, error: "Could not load chats" }, { status: 500 });
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
		return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = parseChat(body);
	if (!parsed.ok) {
		return Response.json({ ok: false, error: parsed.error }, { status: 400 });
	}

	if (parsed.chat.id !== chatId) {
		return Response.json({ ok: false, error: "Chat id must match the URL" }, { status: 400 });
	}

	const existing = await env.DB.prepare(SELECT_CHAT).bind(chatId).first<ChatRow>();

	if (existing && existing.user_id !== user.id) {
		return Response.json({ ok: false, error: "Not found" }, { status: 404 });
	}

	if (!existing) {
		const countRow = await env.DB.prepare(SELECT_CHAT_COUNT)
			.bind(user.id)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_CHATS) {
			return Response.json({ ok: false, error: "Chat limit reached" }, { status: 400 });
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
				return Response.json({ ok: false, error: "Chat is generating" }, { status: 409 });
			}
			stalePendingLeafId = existing.leaf_id;
		}
	}

	const incoming = parsed.chat.messages;
	const path = existing ? await loadDonePath(env.DB, existing, user.id) : [];

	const prefix = await resolvePrefixEdits(env.DB, user.id, chatId, path, incoming);
	if (!prefix.ok) {
		return Response.json({ ok: false, error: prefix.error }, { status: prefix.status });
	}

	const statements = buildReconcileBatch(
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
		await env.DB.batch(statements);
	} catch {
		return Response.json({ ok: false, error: "Could not save chat" }, { status: 500 });
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
	const result = await db.prepare(SELECT_PATH_DONE).bind(chat.leaf_id, userId).all<MessageRow>();
	return result.results;
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
		if (!contentOrReasoningChanged(row, message)) {
			continue;
		}
		if (await isShared(db, userId, row.id, chatId)) {
			return {
				ok: false,
				status: 409,
				error: "Message is shared with another chat and cannot be edited here",
			};
		}
		edits.push({
			id: row.id,
			content: message.content,
			reasoning: storedReasoning(message),
		});
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
		const nextReasoning = storedReasoning(message);
		if (
			existingNode.content !== message.content ||
			(existingNode.reasoning ?? undefined) !== message.reasoning
		) {
			skipInsert.set(message.id, {
				id: message.id,
				content: message.content,
				reasoning: nextReasoning,
			});
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
			`SELECT id, parent_id, role, content, reasoning FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
		)
		.bind(userId, ...ids)
		.all<ExistingNode>();
	return new Map(result.results.map((row) => [row.id, row]));
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
): D1PreparedStatement[] {
	const incoming = chat.messages;
	const statements: D1PreparedStatement[] = [];

	for (const edit of edits) {
		statements.push(
			db.prepare(UPDATE_MESSAGE).bind(edit.content, edit.reasoning, edit.id, userId),
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
				statements.push(
					db
						.prepare(UPDATE_REATTACHED)
						.bind(reattached.content, reattached.reasoning, reattached.id, userId),
				);
			}
			continue;
		}
		statements.push(
			db
				.prepare(INSERT_MESSAGE)
				.bind(
					message.id,
					userId,
					rootId ?? message.id,
					intendedParent(incoming, j),
					j,
					message.role,
					message.content,
					storedReasoning(message),
					message.createdAt,
				),
		);
	}

	if (existing) {
		statements.push(
			db
				.prepare(UPDATE_CHAT)
				.bind(leafId, rootId, chat.title, chat.createdAt, chat.updatedAt, chat.id, userId),
		);
	} else {
		// Nodes first so chats.leaf_id FK can resolve.
		statements.push(
			db
				.prepare(INSERT_CHAT)
				.bind(chat.id, userId, rootId, leafId, chat.title, chat.createdAt, chat.updatedAt),
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
	// reclaim whatever no remaining chat reaches in that root.
	if (existing?.root_id && existing.root_id !== rootId) {
		statements.push(...gcRoot(db, userId, existing.root_id));
	}

	return statements;
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

function contentOrReasoningChanged(row: MessageRow, message: ApiMessage): boolean {
	return row.content !== message.content || (row.reasoning ?? undefined) !== message.reasoning;
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

function parseChatId(pathname: string): string | null {
	const prefix = "/api/chats/";
	if (!pathname.startsWith(prefix)) {
		return null;
	}

	let raw = pathname.slice(prefix.length);
	try {
		raw = decodeURIComponent(raw);
	} catch {
		return null;
	}

	if (raw.includes("/") || !isId(raw)) {
		return null;
	}

	return raw;
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
	if (body.messages.length > MAX_MESSAGES) {
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
	return {
		ok: true,
		value: {
			id: item.id,
			role: item.role,
			content,
			createdAt: item.createdAt,
			...(reasoning ? { reasoning } : {}),
		},
	};
}
