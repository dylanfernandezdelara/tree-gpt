/**
 * POST /api/chats/:id/turns — the one write primitive of the tree API.
 *
 * Reserve (guarded batch) → generate (streamed from OpenRouter) → complete or
 * abandon (batch). Persistence is driven by a tee branch that runs inside
 * ctx.waitUntil, so a client disconnect never loses or double-writes a reply.
 */
import { ensureDomainUser, getSessionUser } from "./auth.js";
import {
	capHistory,
	checkRateLimit,
	encodeSse,
	openStreamCompletion,
	type CompletionMessage,
	type UpstreamEvent,
} from "./openrouter.js";
import { PATH_CTE, loadPath, summaryFor } from "./tree.js";
import { parseTurnRequest, type ParsedTurn } from "./turn-request.js";
import type {
	ApiMessage,
	ChatRow,
	ChatSummary,
	MessageRow,
	TurnRequest,
	TurnStreamEvent,
} from "./tree-types.js";
import {
	MAX_CHATS,
	MAX_DEPTH,
	MAX_MESSAGES_PER_ROOT,
	MAX_REASONING,
	PENDING_TIMEOUT_MS,
	isRole,
} from "./tree-types.js";

export type ReserveOutcome =
	| { ok: true; chat: ChatRow; parentId: string | null; replyId: string; rootId: string }
	| { ok: false; response: Response };


type PersistFns = {
	complete: (content: string, reasoning: string | null) => Promise<TurnStreamEvent>;
	abandon: (error: string, details?: string) => Promise<TurnStreamEvent>;
};

type ReserveCase =
	| { kind: "append"; chatId: string; userId: string; expectLeaf: string | null; cutoff: number }
	| {
			kind: "fork";
			chatId: string;
			userId: string;
			expectLeaf: string | null;
			cutoff: number;
			forkChatId: string;
	  }
	| { kind: "create-missing"; chatId: string }
	| { kind: "create-empty"; chatId: string; userId: string };

/**
 * Entry point. Auth, body parsing, replyId short-circuit, quota, then the
 * reserve / generate / complete protocol. Never regenerates for a replyId that
 * already exists.
 */
export async function handleTurnRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	chatId: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ ok: false, error: "Use POST" }, { status: 405 });
	}

	const user = await getSessionUser(request, env);
	if (!user) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = parseTurnRequest(raw);
	if (!parsed.ok) {
		return Response.json({ ok: false, error: parsed.error }, { status: 400 });
	}
	const body = parsed.value;
	const now = Date.now();
	const targetChatId = body.fork ? body.fork.chatId : chatId;

	const existingReply = await loadMessageRow(env.DB, user.id, body.replyId);
	if (existingReply) {
		return respondExistingReply(env.DB, user.id, targetChatId, existingReply, body, now);
	}

	const sourceChat = await loadChatRow(env.DB, user.id, chatId);
	const shaped = await validateShape(env.DB, user.id, body, sourceChat);
	if (!shaped.ok) {
		return shaped.response;
	}

	const limit = await checkRateLimit(env.DB, user.id, now);
	if (!limit.ok) {
		return Response.json(
			{ ok: false, error: "Rate limit exceeded, try again later" },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
			},
		);
	}

	if (body.parentId === null && !sourceChat) {
		await ensureDomainUser(env.DB, user);
	}

	const previousLeaf = sourceChat?.leaf_id ?? null;
	const fallbackLeaf = await resolveFallbackLeaf(env.DB, user.id, body, previousLeaf, now);

	const reserved = await reserveTurn(env.DB, user.id, chatId, body, now);
	if (!reserved.ok) {
		return reserved.response;
	}

	if (!reserved.parentId) {
		await abandonTurn(env.DB, user.id, reserved.replyId, fallbackLeaf);
		return Response.json({ ok: false, error: "Reserve did not produce a reply parent" }, { status: 500 });
	}

	const history = await historyFor(env.DB, user.id, reserved.parentId);
	const opened = await openStreamCompletion(env, history, {
		sessionId: reserved.rootId,
		origin: new URL(request.url).origin,
	});
	if (!opened.ok) {
		await abandonTurn(env.DB, user.id, reserved.replyId, fallbackLeaf);
		return Response.json(
			{
				ok: false,
				error: opened.error.message,
				details: opened.error.details,
			},
			{ status: opened.error.status },
		);
	}

	const persist: PersistFns = {
		complete: async (content, reasoning) => {
			const committed = await completeTurn(
				env.DB,
				user.id,
				targetChatId,
				reserved.replyId,
				content,
				reasoning,
			);
			return { type: "done", chat: committed.chat, messages: committed.messages };
		},
		abandon: async (error, details) => {
			await abandonTurn(env.DB, user.id, reserved.replyId, fallbackLeaf);
			return details === undefined ? { type: "error", error } : { type: "error", error, details };
		},
	};

	const [clientBranch, persistBranch] = opened.events.tee();
	const terminal = persistFromStream(persistBranch, persist);
	ctx.waitUntil(terminal);

	if (body.stream) {
		return new Response(toTurnStream(clientBranch, terminal).pipeThrough(encodeSse()), {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	try {
		await clientBranch.cancel();
	} catch {
		// Client branch unused on the JSON path.
	}

	const result = await terminal;
	if (result.type === "done") {
		return Response.json({ ok: true, chat: result.chat, messages: result.messages });
	}
	if (result.type === "error") {
		return Response.json(
			{ ok: false, error: result.error, details: result.details },
			{ status: 502 },
		);
	}
	return Response.json({ ok: false, error: "Unexpected terminal event" }, { status: 500 });
}

/**
 * Invariant: every statement in the batch carries the guard for its case
 * (append/redo: leaf CAS; fork: leaf CAS + fork chat absent; create: chat
 * absent), so a lost race writes zero rows. `meta.changes === 0` on the chat
 * statement is the conflict signal.
 */
export async function reserveTurn(
	db: D1Database,
	userId: string,
	chatId: string,
	body: TurnRequest,
	now: number,
): Promise<ReserveOutcome> {
	const targetChatId = body.fork ? body.fork.chatId : chatId;
	const cutoff = now - PENDING_TIMEOUT_MS;
	const sourceChat = await loadChatRow(db, userId, chatId);
	const previousLeaf = sourceChat?.leaf_id ?? null;
	const fallbackLeaf = await resolveFallbackLeaf(db, userId, body, previousLeaf, now);

	const parent = body.parentId ? await loadMessageRow(db, userId, body.parentId) : null;
	if (body.parentId && !parent) {
		return { ok: false, response: jsonError(404, "Parent not found") };
	}

	const reserveCase = resolveReserveCase(chatId, userId, body, sourceChat, cutoff);
	if (!reserveCase) {
		const conflict = await replayReply(db, userId, targetChatId, body, fallbackLeaf, now);
		if (conflict) {
			return { ok: false, response: conflict };
		}
		return {
			ok: false,
			response: await conflictWithChat(db, userId, targetChatId, "Chat changed, reload", now),
		};
	}

	const rootId = parent ? parent.root_id : requiredUserMessage(body).id;
	const replyParentId = body.userMessage ? body.userMessage.id : body.parentId;
	if (!replyParentId) {
		return { ok: false, response: jsonError(400, "parentId is required for redo") };
	}
	const replyDepth = parent ? parent.depth + (body.userMessage ? 2 : 1) : 1;
	const userDepth = parent ? parent.depth + 1 : 0;
	const title =
		body.fork?.title ??
		(typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New chat");

	const prevLeafRow = previousLeaf ? await loadMessageRow(db, userId, previousLeaf) : null;
	const deleteStalePending =
		!body.fork &&
		prevLeafRow !== null &&
		prevLeafRow.status === "pending" &&
		prevLeafRow.created_at < cutoff;

	const guard = guardFragment(reserveCase);
	const statements: D1PreparedStatement[] = [];

	if (body.userMessage) {
		statements.push(
			db
				.prepare(
					`INSERT INTO messages (id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at)
					 SELECT ?, ?, ?, ?, ?, 'user', 'done', ?, NULL, ?
					 WHERE ${guard.sql}`,
				)
				.bind(
					body.userMessage.id,
					userId,
					rootId,
					body.parentId,
					userDepth,
					body.userMessage.content,
					now,
					...guard.binds,
				),
		);
	}

	statements.push(
		db
			.prepare(
				`INSERT INTO messages (id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at)
				 SELECT ?, ?, ?, ?, ?, 'assistant', 'pending', '', NULL, ?
				 WHERE ${guard.sql}`,
			)
			.bind(body.replyId, userId, rootId, replyParentId, replyDepth, now, ...guard.binds),
	);

	const pointerIndex = statements.length;
	statements.push(pointerStatement(db, reserveCase, {
		targetChatId,
		userId,
		rootId,
		replyId: body.replyId,
		title,
		now,
		sourceChatId: chatId,
	}));

	if (deleteStalePending && previousLeaf) {
		statements.push(
			db
				.prepare(`DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`)
				.bind(previousLeaf, userId),
		);
	}

	let results: D1Result[];
	try {
		results = await db.batch(statements);
	} catch {
		const replayed = await replayReply(db, userId, targetChatId, body, fallbackLeaf, now);
		if (replayed) {
			return { ok: false, response: replayed };
		}
		return {
			ok: false,
			response: await conflictWithChat(db, userId, targetChatId, "Chat changed, reload", now),
		};
	}

	const pointerMeta = results[pointerIndex];
	const changes = pointerMeta?.meta.changes ?? 0;
	if (changes === 0) {
		const replayed = await replayReply(db, userId, targetChatId, body, fallbackLeaf, now);
		if (replayed) {
			return { ok: false, response: replayed };
		}
		return {
			ok: false,
			response: await conflictWithChat(db, userId, targetChatId, "Chat changed, reload", now),
		};
	}

	const chat = await loadChatRow(db, userId, targetChatId);
	if (!chat) {
		return { ok: false, response: jsonError(500, "Reserved chat is missing") };
	}

	return { ok: true, chat, parentId: replyParentId, replyId: body.replyId, rootId };
}

/**
 * Invariant: only flips a row that is still pending; content is non-empty and
 * reasoning is capped at MAX_REASONING. Returns the committed path.
 */
export async function completeTurn(
	db: D1Database,
	userId: string,
	targetChatId: string,
	replyId: string,
	content: string,
	reasoning: string | null,
): Promise<{ chat: ChatSummary; messages: ApiMessage[] }> {
	const now = Date.now();
	const capped =
		reasoning && reasoning.length > 0 ? reasoning.slice(0, MAX_REASONING) : null;
	await db
		.prepare(
			`UPDATE messages SET status = 'done', content = ?, reasoning = ? WHERE id = ? AND user_id = ? AND status = 'pending'`,
		)
		.bind(content, capped, replyId, userId)
		.run();
	await db
		.prepare(`UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(now, targetChatId, userId)
		.run();

	const chat = await loadChatRow(db, userId, targetChatId);
	if (!chat) {
		throw new Error("Chat not found after complete");
	}
	const leaf = chat.leaf_id ? await loadMessageRow(db, userId, chat.leaf_id) : null;
	return { chat: summaryFor(chat, leaf, now), messages: await loadPath(db, chat) };
}

/**
 * Invariant: the user's node survives; the pending reply is deleted and the
 * pointer moves back to `fallbackLeaf` (the user node for send, the previous
 * leaf for redo). Idempotent when the reply is already gone.
 */
export async function abandonTurn(
	db: D1Database,
	userId: string,
	replyId: string,
	fallbackLeaf: string | null,
): Promise<void> {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE chats SET leaf_id = ?, root_id = CASE WHEN ? IS NULL THEN NULL ELSE root_id END, updated_at = ? WHERE user_id = ? AND leaf_id = ?`,
			)
			.bind(fallbackLeaf, fallbackLeaf, now, userId, replyId),
		db
			.prepare(`DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`)
			.bind(replyId, userId),
	]);
}

/**
 * Invariant: the upstream history is the root-to-`parentId` path as
 * role/content pairs, passed through capHistory. Reasoning is never included.
 */
export async function historyFor(
	db: D1Database,
	userId: string,
	parentId: string,
): Promise<CompletionMessage[]> {
	const result = await db
		.prepare(
			`${PATH_CTE}
			 SELECT role, content FROM path WHERE status = 'done' ORDER BY depth`,
		)
		.bind(parentId, userId)
		.all<{ role: string; content: string }>();

	const messages: CompletionMessage[] = [];
	for (const row of result.results) {
		if (!isRole(row.role)) {
			continue;
		}
		messages.push({ role: row.role, content: row.content });
	}
	return capHistory(messages);
}

/**
 * Persistence branch of the tee. Consumes upstream events to the end,
 * accumulates content and reasoning, then runs completeTurn or abandonTurn.
 * Resolves with the terminal event the client should receive. Never throws.
 */
export async function persistFromStream(
	events: ReadableStream<UpstreamEvent>,
	persist: PersistFns,
): Promise<TurnStreamEvent> {
	try {
		let content = "";
		let reasoning = "";
		const reader = events.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				switch (value.type) {
					case "heartbeat":
						break;
					case "reasoning": {
						if (reasoning.length < MAX_REASONING) {
							reasoning += value.text.slice(0, MAX_REASONING - reasoning.length);
						}
						break;
					}
					case "content":
						content += value.text;
						break;
					case "done":
						break;
					case "error":
						return await persist.abandon(value.error);
					default: {
						const unseen: never = value;
						void unseen;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		if (!content.trim()) {
			return await persist.abandon("OpenRouter returned an empty reply");
		}
		return await persist.complete(content, reasoning || null);
	} catch {
		try {
			return await persist.abandon("Stream interrupted");
		} catch {
			return { type: "error", error: "Stream interrupted" };
		}
	}
}

/**
 * Client branch of the tee. Forwards reasoning/content/heartbeat events,
 * drops upstream's own terminal event, and when upstream ends emits the
 * terminal event resolved by `terminal` (the persistence branch's promise).
 */
export function toTurnStream(
	events: ReadableStream<UpstreamEvent>,
	terminal: Promise<TurnStreamEvent>,
): ReadableStream<TurnStreamEvent | { type: "heartbeat" }> {
	const reader = events.getReader();
	return new ReadableStream<TurnStreamEvent | { type: "heartbeat" }>({
		async start(controller) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					switch (value.type) {
						case "reasoning":
						case "content":
						case "heartbeat":
							controller.enqueue(value);
							break;
						case "done":
						case "error":
							break;
						default: {
							const unseen: never = value;
							void unseen;
						}
					}
				}
			} catch {
				// Source failed; still emit the persistence terminal.
			}

			let final: TurnStreamEvent;
			try {
				final = await terminal;
			} catch {
				final = { type: "error", error: "Stream interrupted" };
			}
			try {
				controller.enqueue(final);
				controller.close();
			} catch {
				// Consumer already gone; persistence already ran on its own branch.
			}
		},
		async cancel() {
			try {
				await reader.cancel();
			} catch {
				// Reader already settled.
			}
		},
	});
}

async function validateShape(
	db: D1Database,
	userId: string,
	body: ParsedTurn,
	sourceChat: ChatRow | null,
): Promise<{ ok: true } | { ok: false; response: Response }> {
	if (body.parentId === null) {
		if (sourceChat && sourceChat.leaf_id !== null) {
			const leaf = await loadMessageRow(db, userId, sourceChat.leaf_id);
			return {
				ok: false,
				response: Response.json(
					{
						ok: false,
						error: "Chat already exists",
						chat: summaryFor(sourceChat, leaf, Date.now()),
					},
					{ status: 409 },
				),
			};
		}
		if (body.fork) {
			return { ok: false, response: jsonError(400, "fork is not allowed when creating a chat") };
		}
		if (!sourceChat) {
			const countRow = await db
				.prepare(`SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`)
				.bind(userId)
				.first<{ n: number }>();
			if ((countRow?.n ?? 0) >= MAX_CHATS) {
				return { ok: false, response: jsonError(400, "Chat limit reached") };
			}
		}
		return { ok: true };
	}

	if (!sourceChat) {
		return { ok: false, response: jsonError(404, "Not found") };
	}
	if (sourceChat.leaf_id !== body.expectLeaf) {
		// Cheap early CAS so an obviously stale client is not charged quota.
		// The reserve batch re-checks this atomically.
		const leaf = sourceChat.leaf_id ? await loadMessageRow(db, userId, sourceChat.leaf_id) : null;
		return {
			ok: false,
			response: Response.json(
				{
					ok: false,
					error: "Chat changed, reload",
					chat: summaryFor(sourceChat, leaf, Date.now()),
				},
				{ status: 409 },
			),
		};
	}

	const parent = await loadMessageRow(db, userId, body.parentId);
	if (!parent) {
		return { ok: false, response: jsonError(404, "Parent not found") };
	}
	if (sourceChat.root_id === null || parent.root_id !== sourceChat.root_id) {
		return { ok: false, response: jsonError(400, "Parent is not in this chat") };
	}
	if (parent.status !== "done") {
		// Attaching under an unfinished reply would either race its completion
		// or be cascaded away when the stale row is deleted.
		return { ok: false, response: jsonError(409, "Parent reply is not finished") };
	}
	if (!body.userMessage && parent.role !== "user") {
		return { ok: false, response: jsonError(400, "Redo requires a user message parent") };
	}

	const replyDepth = parent.depth + (body.userMessage ? 2 : 1);
	if (replyDepth >= MAX_DEPTH) {
		return { ok: false, response: jsonError(400, "Conversation is too deep") };
	}

	const nodesToAdd = body.userMessage ? 2 : 1;
	const rootCount = await db
		.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND root_id = ?`)
		.bind(userId, parent.root_id)
		.first<{ n: number }>();
	if ((rootCount?.n ?? 0) + nodesToAdd > MAX_MESSAGES_PER_ROOT) {
		return { ok: false, response: jsonError(400, "Tree is too large") };
	}

	if (body.fork) {
		const existingFork = await db
			.prepare(`SELECT id FROM chats WHERE id = ?`)
			.bind(body.fork.chatId)
			.first<{ id: string }>();
		if (existingFork) {
			const forkChat = await loadChatRow(db, userId, body.fork.chatId);
			const leaf = forkChat?.leaf_id ? await loadMessageRow(db, userId, forkChat.leaf_id) : null;
			return {
				ok: false,
				response: Response.json(
					{
						ok: false,
						error: "Fork target already exists",
						...(forkChat ? { chat: summaryFor(forkChat, leaf, Date.now()) } : {}),
					},
					{ status: 409 },
				),
			};
		}
		const countRow = await db
			.prepare(`SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`)
			.bind(userId)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_CHATS) {
			return { ok: false, response: jsonError(400, "Chat limit reached") };
		}
	}

	return { ok: true };
}

async function respondExistingReply(
	db: D1Database,
	userId: string,
	targetChatId: string,
	reply: MessageRow,
	body: TurnRequest,
	now: number,
): Promise<Response> {
	if (reply.status === "done") {
		const chat = await loadChatRow(db, userId, targetChatId);
		if (!chat) {
			return jsonError(404, "Not found");
		}
		const leaf = chat.leaf_id ? await loadMessageRow(db, userId, chat.leaf_id) : null;
		return Response.json({
			ok: true,
			chat: summaryFor(chat, leaf, now),
			messages: await loadPath(db, chat),
		});
	}

	if (reply.status === "pending" && now - reply.created_at < PENDING_TIMEOUT_MS) {
		return conflictWithChat(db, userId, targetChatId, "Reply is still generating", now);
	}

	const chat = await loadChatRow(db, userId, targetChatId);
	const previousLeaf = chat && chat.leaf_id !== reply.id ? chat.leaf_id : body.parentId;
	const fallback = await resolveFallbackLeaf(db, userId, body, previousLeaf, now);
	await abandonTurn(db, userId, reply.id, fallback);
	return conflictWithChat(db, userId, targetChatId, "Reply timed out", now);
}

async function replayReply(
	db: D1Database,
	userId: string,
	targetChatId: string,
	body: TurnRequest,
	fallbackLeaf: string | null,
	now: number,
): Promise<Response | null> {
	const reply = await loadMessageRow(db, userId, body.replyId);
	if (!reply) {
		return null;
	}
	if (reply.status === "done") {
		const chat = await loadChatRow(db, userId, targetChatId);
		if (!chat) {
			return jsonError(404, "Not found");
		}
		const leaf = chat.leaf_id ? await loadMessageRow(db, userId, chat.leaf_id) : null;
		return Response.json({
			ok: true,
			chat: summaryFor(chat, leaf, now),
			messages: await loadPath(db, chat),
		});
	}
	if (reply.status === "pending" && now - reply.created_at < PENDING_TIMEOUT_MS) {
		return conflictWithChat(db, userId, targetChatId, "Reply is still generating", now);
	}
	await abandonTurn(db, userId, reply.id, fallbackLeaf);
	return conflictWithChat(db, userId, targetChatId, "Reply timed out", now);
}

async function resolveFallbackLeaf(
	db: D1Database,
	userId: string,
	body: TurnRequest,
	previousLeaf: string | null,
	now: number,
): Promise<string | null> {
	if (body.userMessage) {
		return body.userMessage.id;
	}
	if (body.fork) {
		return body.parentId;
	}
	if (!previousLeaf) {
		return body.parentId;
	}
	const prev = await loadMessageRow(db, userId, previousLeaf);
	if (prev?.status === "pending" && prev.created_at < now - PENDING_TIMEOUT_MS) {
		return body.parentId;
	}
	return previousLeaf;
}

function resolveReserveCase(
	chatId: string,
	userId: string,
	body: TurnRequest,
	sourceChat: ChatRow | null,
	cutoff: number,
): ReserveCase | null {
	if (body.fork) {
		if (!sourceChat) {
			return null;
		}
		return {
			kind: "fork",
			chatId,
			userId,
			expectLeaf: body.expectLeaf,
			cutoff,
			forkChatId: body.fork.chatId,
		};
	}
	if (body.parentId === null) {
		if (!sourceChat) {
			return { kind: "create-missing", chatId };
		}
		if (sourceChat.leaf_id === null) {
			return { kind: "create-empty", chatId, userId };
		}
		return null;
	}
	if (!sourceChat) {
		return null;
	}
	return { kind: "append", chatId, userId, expectLeaf: body.expectLeaf, cutoff };
}

function guardFragment(reserveCase: ReserveCase): { sql: string; binds: unknown[] } {
	switch (reserveCase.kind) {
		case "append":
			return {
				sql: `EXISTS (SELECT 1 FROM chats c JOIN messages l ON l.id = c.leaf_id WHERE c.id = ? AND c.user_id = ? AND c.leaf_id IS ? AND (l.status = 'done' OR l.created_at < ?))`,
				binds: [reserveCase.chatId, reserveCase.userId, reserveCase.expectLeaf, reserveCase.cutoff],
			};
		case "fork":
			return {
				sql: `EXISTS (SELECT 1 FROM chats c JOIN messages l ON l.id = c.leaf_id WHERE c.id = ? AND c.user_id = ? AND c.leaf_id IS ? AND (l.status = 'done' OR l.created_at < ?)) AND NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)`,
				binds: [
					reserveCase.chatId,
					reserveCase.userId,
					reserveCase.expectLeaf,
					reserveCase.cutoff,
					reserveCase.forkChatId,
				],
			};
		case "create-missing":
			return {
				sql: `NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)`,
				binds: [reserveCase.chatId],
			};
		case "create-empty":
			return {
				sql: `EXISTS (SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND leaf_id IS NULL)`,
				binds: [reserveCase.chatId, reserveCase.userId],
			};
		default: {
			const unseen: never = reserveCase;
			void unseen;
			return { sql: "0", binds: [] };
		}
	}
}

function pointerStatement(
	db: D1Database,
	reserveCase: ReserveCase,
	args: {
		targetChatId: string;
		userId: string;
		rootId: string;
		replyId: string;
		title: string;
		now: number;
		sourceChatId: string;
	},
): D1PreparedStatement {
	switch (reserveCase.kind) {
		case "append": {
			const guard = guardFragment(reserveCase);
			return db
				.prepare(
					`UPDATE chats SET leaf_id = ?, root_id = COALESCE(root_id, ?), updated_at = ?
					 WHERE id = ? AND user_id = ? AND ${guard.sql}`,
				)
				.bind(
					args.replyId,
					args.rootId,
					args.now,
					args.sourceChatId,
					args.userId,
					...guard.binds,
				);
		}
		case "create-empty": {
			const guard = guardFragment(reserveCase);
			return db
				.prepare(
					`UPDATE chats SET leaf_id = ?, root_id = COALESCE(root_id, ?), updated_at = ?
					 WHERE id = ? AND user_id = ? AND ${guard.sql}`,
				)
				.bind(args.replyId, args.rootId, args.now, args.sourceChatId, args.userId, ...guard.binds);
		}
		case "fork": {
			const guard = guardFragment(reserveCase);
			return db
				.prepare(
					`INSERT INTO chats (id, user_id, root_id, leaf_id, title, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
				)
				.bind(
					args.targetChatId,
					args.userId,
					args.rootId,
					args.replyId,
					args.title,
					args.now,
					args.now,
					...guard.binds,
				);
		}
		case "create-missing": {
			const guard = guardFragment(reserveCase);
			return db
				.prepare(
					`INSERT INTO chats (id, user_id, root_id, leaf_id, title, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
				)
				.bind(
					args.targetChatId,
					args.userId,
					args.rootId,
					args.replyId,
					args.title,
					args.now,
					args.now,
					...guard.binds,
				);
		}
		default: {
			const unseen: never = reserveCase;
			void unseen;
			return db.prepare(`SELECT 1 WHERE 0`);
		}
	}
}

async function loadChatRow(db: D1Database, userId: string, chatId: string): Promise<ChatRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, root_id, leaf_id, title, created_at, updated_at FROM chats WHERE id = ? AND user_id = ?`,
		)
		.bind(chatId, userId)
		.first<ChatRow>();
	return row ?? null;
}

async function loadMessageRow(db: D1Database, userId: string, messageId: string): Promise<MessageRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at FROM messages WHERE id = ? AND user_id = ?`,
		)
		.bind(messageId, userId)
		.first<MessageRow>();
	return row ?? null;
}

async function conflictWithChat(
	db: D1Database,
	userId: string,
	chatId: string,
	error: string,
	now: number,
): Promise<Response> {
	const chat = await loadChatRow(db, userId, chatId);
	const leaf = chat?.leaf_id ? await loadMessageRow(db, userId, chat.leaf_id) : null;
	return Response.json(
		{ ok: false, error, ...(chat ? { chat: summaryFor(chat, leaf, now) } : {}) },
		{ status: 409 },
	);
}

function jsonError(status: number, error: string): Response {
	return Response.json({ ok: false, error }, { status });
}

function requiredUserMessage(body: TurnRequest): { id: string; content: string } {
	if (!body.userMessage) {
		throw new Error("userMessage is required for this reserve case");
	}
	return body.userMessage;
}
