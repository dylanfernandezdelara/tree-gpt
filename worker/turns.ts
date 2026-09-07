/**
 * POST /api/chats/:id/turns — the one write primitive of the tree API.
 *
 * Reserve (guarded batch) → generate (streamed from OpenRouter) → complete or
 * abandon (batch). Persistence is driven by a tee branch that runs inside
 * ctx.waitUntil, so a client disconnect never loses or double-writes a reply.
 */
import type { CompletionMessage, UpstreamEvent } from "./openrouter.js";
import type {
	ApiMessage,
	ChatRow,
	ChatSummary,
	TurnRequest,
	TurnStreamEvent,
} from "./tree-types.js";

export type ReserveOutcome =
	| { ok: true; chat: ChatRow; parentId: string | null; replyId: string; rootId: string }
	| { ok: false; response: Response };

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
	void request;
	void env;
	void ctx;
	void chatId;
	throw new Error("not implemented");
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
	void db;
	void userId;
	void chatId;
	void body;
	void now;
	throw new Error("not implemented");
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
	void db;
	void userId;
	void targetChatId;
	void replyId;
	void content;
	void reasoning;
	throw new Error("not implemented");
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
	void db;
	void userId;
	void replyId;
	void fallbackLeaf;
	throw new Error("not implemented");
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
	void db;
	void userId;
	void parentId;
	throw new Error("not implemented");
}

/**
 * Persistence branch of the tee. Consumes upstream events to the end,
 * accumulates content and reasoning, then runs completeTurn or abandonTurn.
 * Resolves with the terminal event the client should receive. Never throws.
 */
export async function persistFromStream(
	events: ReadableStream<UpstreamEvent>,
	persist: {
		complete: (content: string, reasoning: string | null) => Promise<TurnStreamEvent>;
		abandon: (error: string, details?: string) => Promise<TurnStreamEvent>;
	},
): Promise<TurnStreamEvent> {
	void events;
	void persist;
	throw new Error("not implemented");
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
	void events;
	void terminal;
	throw new Error("not implemented");
}
