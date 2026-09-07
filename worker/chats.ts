import { ensureDomainUser, getSessionUser } from "./auth.js";

const MAX_ID = 128;
const MAX_TITLE = 200;
const MAX_CHATS = 100;
const MAX_MESSAGES = 80;
const MAX_CONTENT = 8_000;

type Role = "user" | "assistant";

type ApiMessage = {
	id: string;
	role: Role;
	content: string;
	createdAt: number;
};

type ApiChat = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ApiMessage[];
};

type ChatRow = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
};

type MessageRow = {
	id: string;
	chat_id: string;
	role: string;
	content: string;
	created_at: number;
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

	if (request.method === "DELETE") {
		return removeChat(env.DB, user.id, chatId);
	}

	return Response.json({ ok: false, error: "Use PUT or DELETE" }, { status: 405 });
}

async function listCallerChats(db: D1Database, userId: string): Promise<Response> {
	try {
		return await loadCallerChats(db, userId);
	} catch {
		return Response.json({ ok: false, error: "Could not load chats" }, { status: 500 });
	}
}

async function loadCallerChats(db: D1Database, userId: string): Promise<Response> {
	const chatResult = await db
		.prepare(
			`SELECT id, title, created_at, updated_at
			 FROM chats
			 WHERE user_id = ?
			 ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId)
		.all<ChatRow>();

	const messageResult = await db
		.prepare(
			`SELECT m.id, m.chat_id, m.role, m.content, m.created_at
			 FROM messages m
			 INNER JOIN chats c ON c.id = m.chat_id
			 WHERE c.user_id = ?
			 ORDER BY m.created_at ASC, m.id ASC`,
		)
		.bind(userId)
		.all<MessageRow>();

	const byChat = new Map<string, ApiMessage[]>();
	for (const row of messageResult.results) {
		if (!isRole(row.role)) {
			continue;
		}
		const list = byChat.get(row.chat_id) ?? [];
		list.push({
			id: row.id,
			role: row.role,
			content: row.content,
			createdAt: row.created_at,
		});
		byChat.set(row.chat_id, list);
	}

	const chats: ApiChat[] = chatResult.results.map((row) => ({
		id: row.id,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		messages: byChat.get(row.id) ?? [],
	}));

	return Response.json({ chats });
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

	const existing = await env.DB.prepare(`SELECT user_id FROM chats WHERE id = ?`)
		.bind(chatId)
		.first<{ user_id: string }>();

	if (existing && existing.user_id !== user.id) {
		return Response.json({ ok: false, error: "Not found" }, { status: 404 });
	}

	if (!existing) {
		const countRow = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`,
		)
			.bind(user.id)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_CHATS) {
			return Response.json({ ok: false, error: "Chat limit reached" }, { status: 400 });
		}
	}

	await ensureDomainUser(env.DB, user);

	const chat = parsed.chat;
	const statements: D1PreparedStatement[] = [
		existing
			? env.DB.prepare(
					`UPDATE chats
					 SET title = ?, created_at = ?, updated_at = ?
					 WHERE id = ? AND user_id = ?`,
				).bind(chat.title, chat.createdAt, chat.updatedAt, chat.id, user.id)
			: env.DB.prepare(
					`INSERT INTO chats (id, user_id, title, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				).bind(chat.id, user.id, chat.title, chat.createdAt, chat.updatedAt),
		env.DB.prepare(`DELETE FROM messages WHERE chat_id = ?`).bind(chat.id),
	];

	for (const message of chat.messages) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO messages (id, chat_id, role, content, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			).bind(message.id, chat.id, message.role, message.content, message.createdAt),
		);
	}

	try {
		await env.DB.batch(statements);
	} catch {
		return Response.json({ ok: false, error: "Could not save chat" }, { status: 500 });
	}

	return Response.json({ chat });
}

async function removeChat(
	db: D1Database,
	userId: string,
	chatId: string,
): Promise<Response> {
	const result = await db
		.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`)
		.bind(chatId, userId)
		.run();

	if (result.meta.changes === 0) {
		return Response.json({ ok: false, error: "Not found" }, { status: 404 });
	}

	return Response.json({ ok: true });
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

	// Legacy clients may still send reasoningDetails blobs. They are accepted
	// and dropped: nothing upstream or in storage uses them anymore.
	return {
		ok: true,
		value: {
			id: item.id,
			role: item.role,
			content,
			createdAt: item.createdAt,
		},
	};
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRole(value: unknown): value is Role {
	return value === "user" || value === "assistant";
}

