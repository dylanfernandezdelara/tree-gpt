/**
 * Contract for the conversation tree API. This file is the frontend's import
 * surface: every request/response shape the client needs is defined here and
 * nowhere else.
 *
 * Model: messages form an immutable tree (parent_id / root_id / depth). A chat
 * is a named pointer to one node (`leafId`). The messages a pane renders are
 * the root-to-leaf path. Fork = a second pointer into the same tree. `leafId`
 * is the chat's version: every turn moves it, rename does not.
 */

export type Role = "user" | "assistant";

/** Branch pointers per user. */
export const MAX_CHATS = 100;
/** Nodes on any root-to-leaf path (schema CHECK: depth < MAX_DEPTH). */
export const MAX_DEPTH = 80;
/** Nodes per tree, across all branches. Enforced by /turns only. */
export const MAX_MESSAGES_PER_ROOT = 400;
export const MAX_ID = 128;
export const MAX_TITLE = 200;
export const MAX_CONTENT = 8_000;
/** Display-only thinking trace; never sent upstream. */
export const MAX_REASONING = 4_000;
/** A pending reply older than this is treated as abandoned. */
export const PENDING_TIMEOUT_MS = 120_000;

/** One message on a path. `pending` is set only on an in-flight assistant leaf. */
export type ApiMessage = {
	id: string;
	role: Role;
	content: string;
	createdAt: number;
	reasoning?: string;
	pending?: true;
};

/** Chat pointer without message bodies. */
export type ChatSummary = {
	id: string;
	title: string;
	/** Null until the chat has its first message. */
	rootId: string | null;
	/** Null until the chat has its first message. CAS token for /turns. */
	leafId: string | null;
	/** True while the leaf is a pending reply younger than PENDING_TIMEOUT_MS. */
	generating: boolean;
	createdAt: number;
	updatedAt: number;
};

/** Compat shape used by the pre-tree client (GET /api/chats, PUT /api/chats/:id). */
export type ApiChat = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ApiMessage[];
};

export type TurnRequest = {
	/** Node to attach under. Null = new tree; then chat :id must not exist yet. */
	parentId: string | null;
	/** The client's view of chats.leaf_id. Stale value → 409, nothing written. */
	expectLeaf: string | null;
	/** Land the turn on a new chat pointing into the same tree; :id is untouched. */
	fork?: { chatId: string; title: string };
	/** Absent = redo: append a sibling reply under parentId (a user node). */
	userMessage?: { id: string; content: string };
	/** Idempotency key for the assistant reply. Replay never regenerates. */
	replyId: string;
	/** Ignored unless :id is being created. */
	title?: string;
	/** True = SSE response (TurnStreamEvent). Absent = JSON TurnResponse. */
	stream?: boolean;
};

export type TurnResponse =
	| { ok: true; chat: ChatSummary; messages: ApiMessage[] }
	| { ok: false; error: string; details?: string; chat?: ChatSummary };

/**
 * SSE payloads for `stream: true`, in order: zero or more reasoning/content
 * deltas, then exactly one terminal `done` or `error`. Every failure before
 * the stream opens (400/401/404/409/429/500/502) is a JSON TurnResponse.
 */
export type TurnStreamEvent =
	| { type: "reasoning"; text: string }
	| { type: "content"; text: string }
	| { type: "done"; chat: ChatSummary; messages: ApiMessage[] }
	| { type: "error"; error: string; details?: string };

export function isRole(value: unknown): value is Role {
	return value === "user" || value === "assistant";
}

export function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

export function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
