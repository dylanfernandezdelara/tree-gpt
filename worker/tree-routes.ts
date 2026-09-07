/**
 * Tree-native routes: summaries, single-chat path, rename, delete.
 *
 *   GET    /api/chats?summary=1   → { chats: ChatSummary[] }
 *   GET    /api/chats/:id         → { chat: ChatSummary, messages: ApiMessage[] }
 *   PATCH  /api/chats/:id         → { chat: ChatSummary }
 *   DELETE /api/chats/:id         → { ok: true }
 *
 * The compat GET list and PUT stay in chats.ts; /turns lives in turns.ts.
 */
import { getSessionUser } from "./auth.js";
import { gcRoot, loadPath, summaryFor } from "./tree.js";
import { MAX_TITLE, type ChatRow, type MessageRow } from "./tree-types.js";

type SummaryJoinRow = ChatRow & {
	leaf_status: string | null;
	leaf_created_at: number | null;
};

/**
 * Invariant: every response is scoped to the session user; another user's
 * chat id is indistinguishable from a missing one (404).
 */
export async function handleTreeRequest(
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
			return fail(405, "Method not allowed");
		}
		return listSummaries(env.DB, user.id);
	}

	switch (request.method) {
		case "GET":
			return getChat(env.DB, user.id, chatId);
		case "PATCH":
			return patchChat(request, env.DB, user.id, chatId);
		case "DELETE":
			return deleteChat(env.DB, user.id, chatId);
		default:
			return fail(405, "Method not allowed");
	}
}

async function listSummaries(db: D1Database, userId: string): Promise<Response> {
	const now = Date.now();
	const result = await db
		.prepare(
			`SELECT
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
			 LEFT JOIN messages leaf ON leaf.id = c.leaf_id
			 WHERE c.user_id = ?
			 ORDER BY c.updated_at DESC, c.created_at DESC`,
		)
		.bind(userId)
		.all<SummaryJoinRow>();

	const chats = result.results.map((row) =>
		summaryFor(
			row,
			row.leaf_status !== null && row.leaf_created_at !== null
				? { status: row.leaf_status, created_at: row.leaf_created_at }
				: null,
			now,
		),
	);
	return Response.json({ chats });
}

async function getChat(db: D1Database, userId: string, chatId: string): Promise<Response> {
	const chat = await loadChat(db, userId, chatId);
	if (!chat) {
		return fail(404, "Not found");
	}
	const leaf = await loadLeaf(db, chat);
	return Response.json({
		chat: summaryFor(chat, leaf, Date.now()),
		messages: await loadPath(db, chat),
	});
}

async function patchChat(
	request: Request,
	db: D1Database,
	userId: string,
	chatId: string,
): Promise<Response> {
	const parsed = await parseTitleBody(request);
	if (!parsed.ok) {
		return fail(400, parsed.error);
	}

	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
		)
		.bind(parsed.title, now, chatId, userId)
		.run();

	if (result.meta.changes === 0) {
		return fail(404, "Not found");
	}

	const chat = await loadChat(db, userId, chatId);
	if (!chat) {
		return fail(404, "Not found");
	}
	const leaf = await loadLeaf(db, chat);
	return Response.json({ chat: summaryFor(chat, leaf, now) });
}

async function deleteChat(db: D1Database, userId: string, chatId: string): Promise<Response> {
	const chat = await loadChat(db, userId, chatId);
	if (!chat) {
		return fail(404, "Not found");
	}

	const statements: D1PreparedStatement[] = [
		db.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`).bind(chatId, userId),
	];
	if (chat.root_id !== null) {
		statements.push(...gcRoot(db, userId, chat.root_id));
	}

	try {
		await db.batch(statements);
	} catch {
		return fail(500, "Could not delete chat");
	}

	return Response.json({ ok: true });
}

async function loadChat(db: D1Database, userId: string, chatId: string): Promise<ChatRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, root_id, leaf_id, title, created_at, updated_at
			 FROM chats
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(chatId, userId)
		.first<ChatRow>();
	return row ?? null;
}

async function loadLeaf(db: D1Database, chat: ChatRow): Promise<MessageRow | null> {
	if (chat.leaf_id === null) {
		return null;
	}
	const row = await db
		.prepare(
			`SELECT id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at
			 FROM messages
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(chat.leaf_id, chat.user_id)
		.first<MessageRow>();
	return row ?? null;
}

async function parseTitleBody(
	request: Request,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { ok: false, error: "Invalid JSON body" };
	}
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Invalid JSON body" };
	}
	if (!("title" in body) || typeof body.title !== "string") {
		return { ok: false, error: "title must be a string" };
	}
	const title = body.title.trim();
	if (!title) {
		return { ok: false, error: "title must not be empty" };
	}
	if (title.length > MAX_TITLE) {
		return { ok: false, error: "title is too long" };
	}
	return { ok: true, title };
}

function fail(status: number, error: string): Response {
	return Response.json({ ok: false, error }, { status });
}
