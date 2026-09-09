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

/**
 * Allowlisted chat models. The Worker is authoritative: any `model` outside
 * this catalog is rejected with 400 before quota or upstream work. The UI
 * imports this list so the selector cannot drift from the backend.
 *
 * Prices are per million tokens (live OpenRouter catalog, Sep 2026):
 * - Muse Spark 1.3 Contributor: $0.10 in / $0.20 out (default)
 * - GPT-5.6 Luna: $0.20 in / $1.20 out
 */
export const CHAT_MODELS = [
	{ id: "meta/muse-spark-1.3-contributor", label: "Muse Spark 1.3" },
	{ id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
] as const;

export type ModelId = (typeof CHAT_MODELS)[number]["id"];

export const DEFAULT_MODEL: ModelId = "meta/muse-spark-1.3-contributor";

export function isModelId(value: unknown): value is ModelId {
	return (
		typeof value === "string" && CHAT_MODELS.some((model) => model.id === value)
	);
}

/**
 * User-selectable reasoning efforts, verified live against the providers
 * (Sep 2026) — not just the catalog. Muse is mandatory-reasoning over
 * minimal..xhigh (`none` 400s; the catalog also lists `max` but Meta's
 * provider rejects it with "supported values: [minimal, low, medium, high,
 * xhigh]"). Luna takes none..max in full (`minimal` is not a Luna level).
 * `none` (labeled Off) disables reasoning where offered.
 */
export const EFFORTS = [
	{ id: "none", label: "Off" },
	{ id: "minimal", label: "Minimal" },
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "XHigh" },
	{ id: "max", label: "Max" },
] as const;

export type EffortId = (typeof EFFORTS)[number]["id"];

export const MODEL_EFFORTS: Record<ModelId, readonly EffortId[]> = {
	"meta/muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],
	"openai/gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
};

export const DEFAULT_EFFORT: Record<ModelId, EffortId> = {
	"meta/muse-spark-1.3-contributor": "minimal",
	"openai/gpt-5.6-luna": "none",
};

export function isEffortId(value: unknown): value is EffortId {
	return (
		typeof value === "string" && EFFORTS.some((effort) => effort.id === value)
	);
}

export function effortLabel(id: EffortId): string {
	return EFFORTS.find((effort) => effort.id === id)?.label ?? id;
}

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
/** Display-only search sources; never sent upstream. */
export const MAX_CITATIONS = 8;
/** Display-only search tool chips; never sent upstream. */
export const MAX_STORED_TOOL_CALLS = 3;
/** Cap on each stored search JSON column. */
export const MAX_SEARCH_JSON = 4_000;

export type Citation = {
	url: string;
	title?: string;
};

export type ToolCallState = "input-available" | "output-available" | "output-error";

export type ToolCall = {
	id: string;
	name: "web_search";
	query?: string;
	state: ToolCallState;
};
/** A pending reply older than this is treated as abandoned. */
export const PENDING_TIMEOUT_MS = 120_000;

/** One message on a path. `pending` is set only on an in-flight assistant leaf. */
export type ApiMessage = {
	id: string;
	role: Role;
	content: string;
	createdAt: number;
	reasoning?: string;
	citations?: Citation[];
	toolCalls?: ToolCall[];
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
	/** Used only when a new chat row is created (parentId null, :id absent); ignored otherwise. */
	title?: string;
	/** True = SSE response (TurnStreamEvent). Absent = JSON TurnResponse. */
	stream?: boolean;
	/** Allowlisted model id. Omitted = DEFAULT_MODEL (Muse Spark 1.3). */
	model?: ModelId;
	/** Reasoning effort. Must be in MODEL_EFFORTS[model]; omitted = DEFAULT_EFFORT[model]. */
	effort?: EffortId;
};

export type TurnResponse =
	| { ok: true; chat: ChatSummary; messages: ApiMessage[] }
	| { ok: false; error: string; details?: string; chat?: ChatSummary };

/**
 * SSE payloads for `stream: true`, in order: zero or more reasoning/content
 * deltas and live search snapshots, then exactly one terminal `done` or
 * `error`. Every failure before the stream opens
 * (400/401/404/409/429/500/502) is a JSON TurnResponse.
 */
export type TurnStreamEvent =
	| { type: "reasoning"; text: string }
	| { type: "content"; text: string }
	| { type: "search"; citations?: Citation[]; toolCalls?: ToolCall[] }
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
