/**
 * POST /api/chats/:id/turns — reserve (guarded batch) → generate → complete or
 * abandon. Persistence tees the OpenRouter stream inside ctx.waitUntil.
 */
import { ensureDomainUser, getSessionUser } from "./auth.js";
import {
	capHistory,
	checkRateLimit,
	openStreamCompletion,
	rateLimitResponse,
	sseResponse,
	type CompletionMessage,
	type UpstreamEvent,
} from "./openrouter.js";
import {
	fail,
	loadChatRow,
	loadMessageRow,
	loadPath,
	loadPathRows,
	loadSummary,
	summaryFor,
	type ChatRow,
	type MessageRow,
} from "./tree.js";
import { parseTurnRequest, type ParsedTurn } from "./turn-request.js";
import {
	MAX_CHATS,
	MAX_DEPTH,
	MAX_MESSAGES_PER_ROOT,
	MAX_REASONING,
	PENDING_TIMEOUT_MS,
	type ApiMessage,
	type ChatSummary,
	type TurnRequest,
	type TurnStreamEvent,
} from "./tree-types.js";

const REPLY_ABANDONED = "Reply was abandoned before it finished";

export type ReserveOutcome =
	| { ok: true; chat: ChatRow; parentId: string; replyId: string; rootId: string }
	| { ok: false; response: Response };

export type TurnTerminal = Extract<TurnStreamEvent, { type: "done" | "error" }>;

export type ReserveCase =
	| { kind: "append"; chatId: string; userId: string; expectLeaf: string | null; cutoff: number }
	| { kind: "fork"; chatId: string; userId: string; expectLeaf: string | null; cutoff: number; forkChatId: string }
	| { kind: "create-missing"; chatId: string }
	| { kind: "create-empty"; chatId: string; userId: string };

export type TurnPlan = {
	targetChatId: string;
	sourceChat: ChatRow | null;
	parent: MessageRow | null;
	prevLeaf: MessageRow | null;
	fallbackLeaf: string | null;
	reserveCase: ReserveCase;
	pointer: "update" | "insert";
	guard: { sql: string; binds: unknown[] };
	rootId: string;
	replyParentId: string;
	userDepth: number;
	replyDepth: number;
	title: string;
};

type PersistFns = {
	complete: (content: string, reasoning: string | null) => Promise<TurnTerminal>;
	abandon: (error: string, details?: string) => Promise<TurnTerminal>;
};

/** Auth, parse, replyId short-circuit, quota, then reserve / generate / complete. */
export async function handleTurnRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	chatId: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return fail(405, "Use POST");
	}

	const user = await getSessionUser(request, env);
	if (!user) {
		return fail(401, "Unauthorized");
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return fail(400, "Invalid JSON body");
	}

	const parsed = parseTurnRequest(raw);
	if (!parsed.ok) {
		return fail(400, parsed.error);
	}
	const body = parsed.value;
	const now = Date.now();
	const targetChatId = body.fork ? body.fork.chatId : chatId;

	const existingReply = await loadMessageRow(env.DB, user.id, body.replyId);
	if (existingReply) {
		return replyOutcome(env.DB, user.id, targetChatId, existingReply, now);
	}

	const planned = await planTurn(env.DB, user.id, chatId, body, now);
	if (!planned.ok) {
		return planned.response;
	}
	const { plan } = planned;

	const limit = await checkRateLimit(env.DB, user.id, now);
	if (!limit.ok) {
		return rateLimitResponse(limit.retryAfterMs);
	}

	if (body.parentId === null && !plan.sourceChat) {
		await ensureDomainUser(env.DB, user);
	}

	const reserved = await reserveTurn(env.DB, user.id, body, plan, now);
	if (!reserved.ok) {
		return reserved.response;
	}

	const history = await historyFor(env.DB, user.id, reserved.parentId);
	const opened = await openStreamCompletion(env, history, {
		sessionId: reserved.rootId,
		origin: new URL(request.url).origin,
		model: body.model,
		effort: body.effort,
	});
	if (!opened.ok) {
		await abandonTurn(env.DB, user.id, reserved.replyId, plan.fallbackLeaf);
		return fail(opened.error.status, opened.error.message, { details: opened.error.details });
	}

	const persist: PersistFns = {
		complete: async (content, reasoning) => {
			const committed = await completeTurn(env.DB, user.id, plan.targetChatId, reserved.replyId, content, reasoning);
			if (!committed.ok) {
				return { type: "error", error: REPLY_ABANDONED };
			}
			return { type: "done", chat: committed.chat, messages: committed.messages };
		},
		abandon: async (error, details) => {
			await abandonTurn(env.DB, user.id, reserved.replyId, plan.fallbackLeaf);
			return details === undefined ? { type: "error", error } : { type: "error", error, details };
		},
	};

	const [clientBranch, persistBranch] = opened.events.tee();
	const terminal = persistFromStream(persistBranch, persist);
	ctx.waitUntil(terminal);

	if (body.stream) {
		return sseResponse(toTurnStream(clientBranch, terminal));
	}

	void clientBranch.cancel().catch(() => {});

	const result = await terminal;
	switch (result.type) {
		case "done":
			return Response.json({ ok: true, chat: result.chat, messages: result.messages });
		case "error":
			return fail(result.error === REPLY_ABANDONED ? 409 : 502, result.error, {
				details: result.details,
			});
		default: {
			const unseen: never = result;
			return unseen;
		}
	}
}

/** Shape + CAS + quota-free reads. Reserve runs this plan without reloading rows. */
export async function planTurn(
	db: D1Database,
	userId: string,
	chatId: string,
	body: ParsedTurn,
	now: number,
): Promise<{ ok: true; plan: TurnPlan } | { ok: false; response: Response }> {
	const sourceChat = await loadChatRow(db, userId, chatId);
	const cutoff = now - PENDING_TIMEOUT_MS;
	const targetChatId = body.fork ? body.fork.chatId : chatId;

	if (body.parentId === null) {
		if (sourceChat && sourceChat.leaf_id !== null) {
			const leaf = await loadMessageRow(db, userId, sourceChat.leaf_id);
			return { ok: false, response: attachedConflict("Chat already exists", sourceChat, leaf, now) };
		}
		if (body.fork) {
			return { ok: false, response: fail(400, "fork is not allowed when creating a chat") };
		}
		if (!sourceChat && (await countChats(db, userId)) >= MAX_CHATS) {
			return { ok: false, response: fail(400, "Chat limit reached") };
		}
		if (!body.userMessage) {
			return { ok: false, response: fail(400, "parentId is required for redo") };
		}
		const reserveCase = reserveCaseFor(chatId, userId, body, sourceChat, cutoff);
		return { ok: true, plan: finishPlan({
			targetChatId,
			sourceChat,
			parent: null,
			prevLeaf: null,
			fallbackLeaf: body.userMessage.id,
			reserveCase,
			rootId: body.userMessage.id,
			replyParentId: body.userMessage.id,
			userDepth: 0,
			replyDepth: 1,
			title: body.title ?? "New chat",
		}) };
	}

	if (!sourceChat) {
		return { ok: false, response: fail(404, "Not found") };
	}
	if (sourceChat.leaf_id !== body.expectLeaf) {
		// Cheap early CAS so a stale client is not charged quota. Reserve re-checks atomically.
		const leaf = sourceChat.leaf_id ? await loadMessageRow(db, userId, sourceChat.leaf_id) : null;
		return { ok: false, response: attachedConflict("Chat changed, reload", sourceChat, leaf, now) };
	}

	const parent = await loadMessageRow(db, userId, body.parentId);
	if (!parent) {
		return { ok: false, response: fail(404, "Parent not found") };
	}
	if (sourceChat.root_id === null || parent.root_id !== sourceChat.root_id) {
		return { ok: false, response: fail(400, "Parent is not in this chat") };
	}
	if (parent.status !== "done") {
		return { ok: false, response: fail(409, "Parent reply is not finished") };
	}
	if (!body.userMessage && parent.role !== "user") {
		return { ok: false, response: fail(400, "Redo requires a user message parent") };
	}

	const replyDepth = parent.depth + (body.userMessage ? 2 : 1);
	if (replyDepth >= MAX_DEPTH) {
		return { ok: false, response: fail(400, "Conversation is too deep") };
	}

	const nodesToAdd = body.userMessage ? 2 : 1;
	const rootCount = await db
		.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND root_id = ?`)
		.bind(userId, parent.root_id)
		.first<{ n: number }>();
	if ((rootCount?.n ?? 0) + nodesToAdd > MAX_MESSAGES_PER_ROOT) {
		return { ok: false, response: fail(400, "Tree is too large") };
	}

	if (body.fork) {
		const existingFork = await db
			.prepare(`SELECT id FROM chats WHERE id = ?`)
			.bind(body.fork.chatId)
			.first<{ id: string }>();
		if (existingFork) {
			const forkSummary = await loadSummary(db, userId, body.fork.chatId, now);
			return {
				ok: false,
				response: forkSummary
					? fail(409, "Fork target already exists", { chat: forkSummary })
					: fail(409, "Fork target already exists"),
			};
		}
		if ((await countChats(db, userId)) >= MAX_CHATS) {
			return { ok: false, response: fail(400, "Chat limit reached") };
		}
	}

	const previousLeaf = sourceChat.leaf_id;
	let prevLeaf: MessageRow | null = null;
	if (previousLeaf === parent.id) {
		prevLeaf = parent;
	} else if (previousLeaf !== null) {
		prevLeaf = await loadMessageRow(db, userId, previousLeaf);
	}
	const stalePrev = prevLeaf?.status === "pending" && prevLeaf.created_at < now - PENDING_TIMEOUT_MS;
	const fallbackLeaf = body.userMessage
		? body.userMessage.id
		: body.fork || !previousLeaf || stalePrev
			? body.parentId
			: previousLeaf;
	return { ok: true, plan: finishPlan({
		targetChatId,
		sourceChat,
		parent,
		prevLeaf,
		fallbackLeaf,
		reserveCase: reserveCaseFor(chatId, userId, body, sourceChat, cutoff),
		rootId: parent.root_id,
		replyParentId: body.userMessage ? body.userMessage.id : body.parentId,
		userDepth: parent.depth + 1,
		replyDepth,
		title: body.fork?.title ?? body.title ?? "New chat",
	}) };
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
	body: TurnRequest,
	plan: TurnPlan,
	now: number,
): Promise<ReserveOutcome> {
	const { guard } = plan;
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
					plan.rootId,
					body.parentId,
					plan.userDepth,
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
			.bind(body.replyId, userId, plan.rootId, plan.replyParentId, plan.replyDepth, now, ...guard.binds),
	);

	const pointerIndex = statements.length;
	statements.push(pointerStatement(db, plan, userId, body.replyId, now));

	const prev = plan.prevLeaf;
	if (!body.fork && prev && prev.status === "pending" && prev.created_at < now - PENDING_TIMEOUT_MS) {
		statements.push(
			db
				.prepare(`DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`)
				.bind(prev.id, userId),
		);
	}

	let results: D1Result[];
	try {
		results = await db.batch(statements);
	} catch {
		return { ok: false, response: await replayOrConflict(db, userId, plan.targetChatId, body.replyId, now) };
	}
	if ((results[pointerIndex]?.meta.changes ?? 0) === 0) {
		return { ok: false, response: await replayOrConflict(db, userId, plan.targetChatId, body.replyId, now) };
	}

	const chat = await loadChatRow(db, userId, plan.targetChatId);
	if (!chat) {
		return { ok: false, response: fail(500, "Reserved chat is missing") };
	}

	return { ok: true, chat, parentId: plan.replyParentId, replyId: body.replyId, rootId: plan.rootId };
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
): Promise<{ ok: true; chat: ChatSummary; messages: ApiMessage[] } | { ok: false }> {
	const now = Date.now();
	const capped =
		reasoning && reasoning.length > 0 ? reasoning.slice(0, MAX_REASONING) : null;
	const results = await db.batch([
		db
			.prepare(
				`UPDATE messages SET status = 'done', content = ?, reasoning = ? WHERE id = ? AND user_id = ? AND status = 'pending'`,
			)
			.bind(content, capped, replyId, userId),
		db
			.prepare(
				`UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND user_id = ? AND status = 'done')`,
			)
			.bind(now, targetChatId, userId, replyId, userId),
	]);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		return { ok: false };
	}

	const chat = await loadSummary(db, userId, targetChatId, now);
	if (!chat) {
		throw new Error("Chat not found after complete");
	}
	return {
		ok: true,
		chat,
		messages: await loadPath(db, { user_id: userId, leaf_id: chat.leafId }),
	};
}

/**
 * Invariant: the user node survives; the pending reply is deleted and the
 * pointer moves to `fallbackLeaf`. Idempotent if the reply is already gone.
 * Will not un-point a reply that already completed.
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
				`UPDATE chats SET leaf_id = ?, root_id = CASE WHEN ? IS NULL THEN NULL ELSE root_id END, updated_at = ? WHERE user_id = ? AND leaf_id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND user_id = ? AND status = 'pending')`,
			)
			.bind(fallbackLeaf, fallbackLeaf, now, userId, replyId, replyId, userId),
		db
			.prepare(`DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'`)
			.bind(replyId, userId),
	]);
}

/** Root-to-`parentId` role/content pairs through capHistory. No reasoning. */
export async function historyFor(
	db: D1Database,
	userId: string,
	parentId: string,
): Promise<CompletionMessage[]> {
	const rows = await loadPathRows(db, userId, parentId, { doneOnly: true });
	return capHistory(rows.map((row) => ({ role: row.role, content: row.content })));
}

/** Persistence tee branch. Accumulates deltas, then complete or abandon. Never throws. */
export async function persistFromStream(
	events: ReadableStream<UpstreamEvent>,
	persist: PersistFns,
): Promise<TurnTerminal> {
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
					case "done":
						break;
					case "reasoning":
						if (reasoning.length < MAX_REASONING) {
							reasoning += value.text.slice(0, MAX_REASONING - reasoning.length);
						}
						break;
					case "content":
						content += value.text;
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

/** Client tee branch. Forwards deltas; emits the persistence terminal at the end. */
export function toTurnStream(
	events: ReadableStream<UpstreamEvent>,
	terminal: Promise<TurnTerminal>,
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

			let final: TurnTerminal;
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

async function replyOutcome(
	db: D1Database,
	userId: string,
	targetChatId: string,
	reply: MessageRow,
	now: number,
): Promise<Response> {
	if (reply.status === "done") {
		const chat = await loadSummary(db, userId, targetChatId, now);
		if (!chat) {
			return fail(404, "Not found");
		}
		return Response.json({
			ok: true,
			chat,
			messages: await loadPath(db, { user_id: userId, leaf_id: chat.leafId }),
		});
	}

	if (reply.status === "pending" && now - reply.created_at < PENDING_TIMEOUT_MS) {
		return conflictWithChat(db, userId, targetChatId, "Reply is still generating", now);
	}

	await abandonTurn(db, userId, reply.id, await fallbackLeafFor(db, userId, reply));
	return conflictWithChat(db, userId, targetChatId, "Reply timed out", now);
}

async function replayOrConflict(
	db: D1Database,
	userId: string,
	targetChatId: string,
	replyId: string,
	now: number,
): Promise<Response> {
	const reply = await loadMessageRow(db, userId, replyId);
	if (reply) {
		return replyOutcome(db, userId, targetChatId, reply, now);
	}
	return conflictWithChat(db, userId, targetChatId, "Chat changed, reload", now);
}

async function fallbackLeafFor(
	db: D1Database,
	userId: string,
	reply: MessageRow,
): Promise<string | null> {
	if (!reply.parent_id) {
		return null;
	}
	const parent = await loadMessageRow(db, userId, reply.parent_id);
	if (!parent || parent.root_id !== reply.root_id) {
		return reply.parent_id;
	}
	if (parent.role === "user") {
		const sibling = await db
			.prepare(
				`SELECT id FROM messages WHERE parent_id = ? AND user_id = ? AND role = 'assistant' AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(reply.parent_id, userId)
			.first<{ id: string }>();
		if (sibling) {
			return sibling.id;
		}
	}
	return reply.parent_id;
}

function finishPlan(partial: Omit<TurnPlan, "pointer" | "guard">): TurnPlan {
	const pointer =
		partial.reserveCase.kind === "fork" || partial.reserveCase.kind === "create-missing"
			? "insert"
			: "update";
	return { ...partial, pointer, guard: guardFragment(partial.reserveCase) };
}

async function countChats(db: D1Database, userId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM chats WHERE user_id = ?`)
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function attachedConflict(error: string, chat: ChatRow, leaf: MessageRow | null, now: number): Response {
	return fail(409, error, { chat: summaryFor(chat, leaf, now) });
}

function reserveCaseFor(
	chatId: string,
	userId: string,
	body: TurnRequest,
	sourceChat: ChatRow | null,
	cutoff: number,
): ReserveCase {
	if (body.fork) {
		return { kind: "fork", chatId, userId, expectLeaf: body.expectLeaf, cutoff, forkChatId: body.fork.chatId };
	}
	if (body.parentId === null) {
		if (!sourceChat) {
			return { kind: "create-missing", chatId };
		}
		return { kind: "create-empty", chatId, userId };
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
				binds: [reserveCase.chatId, reserveCase.userId, reserveCase.expectLeaf, reserveCase.cutoff, reserveCase.forkChatId],
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
			return unseen;
		}
	}
}

function pointerStatement(
	db: D1Database,
	plan: TurnPlan,
	userId: string,
	replyId: string,
	now: number,
): D1PreparedStatement {
	const { guard } = plan;
	if (plan.pointer === "update") {
		return db
			.prepare(
				`UPDATE chats SET leaf_id = ?, root_id = COALESCE(root_id, ?), updated_at = ?
				 WHERE id = ? AND user_id = ? AND ${guard.sql}`,
			)
			.bind(replyId, plan.rootId, now, plan.reserveCase.chatId, userId, ...guard.binds);
	}
	return db
		.prepare(
			`INSERT INTO chats (id, user_id, root_id, leaf_id, title, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
		)
		.bind(plan.targetChatId, userId, plan.rootId, replyId, plan.title, now, now, ...guard.binds);
}

async function conflictWithChat(
	db: D1Database,
	userId: string,
	chatId: string,
	error: string,
	now: number,
): Promise<Response> {
	const chat = await loadSummary(db, userId, chatId, now);
	return fail(409, error, chat ? { chat } : {});
}
