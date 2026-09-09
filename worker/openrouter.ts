import { getSessionUser } from "./auth.js";
import {
	DEFAULT_EFFORT,
	DEFAULT_MODEL,
	MODEL_EFFORTS,
	isEffortId,
	isModelId,
	isRole,
	type Citation,
	type EffortId,
	type ModelId,
	type ToolCall,
} from "./tree-types.js";
import {
	createSearchAccumulator,
	finalizeSearchMeta,
	searchFingerprint,
	snapshotSearchMeta,
	ingestOpenRouterPayload,
	searchMetaFromPayload,
} from "./search-meta.js";
import { systemPrompt } from "./system-prompt.js";
import { unsquashSentences } from "./unsquash-sentences.js";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter server tool. Nested `parameters` — a top-level `engine` makes Muse emit client `tool_calls`. */
export const WEB_SEARCH_TOOL = {
	type: "openrouter:web_search",
	parameters: {
		engine: "exa",
		mode: "fast",
		max_results: 5,
		max_uses: 3,
		max_total_results: 10,
		max_characters: 2000,
	},
} as const;

export const MAX_TOOL_CALLS = 3;

const MAX_TURN_CHARS = 8_000;
const MAX_HISTORY = 50;
const MAX_HISTORY_CHARS = 32_000;

// Generate quotas, checked before any upstream call so a runaway client or
// compromised account cannot burn the server key without bound. Per user:
// MAX_GENERATES_PER_WINDOW calls per WINDOW_MS. Account-wide:
// MAX_GLOBAL_GENERATES_PER_WINDOW across every user, a circuit breaker so a
// wave of throwaway sign-ins cannot scale spend linearly. Both are fixed
// windows aligned to WINDOW_MS.
const WINDOW_MS = 3_600_000;
const MAX_GENERATES_PER_WINDOW = 60;
const MAX_GLOBAL_GENERATES_PER_WINDOW = 1_000;

/** Reported to clients instead of the raw key-configuration problem. */
const NOT_CONFIGURED = "Chat is not configured on this server";

/**
 * Atomic fixed-window increment: resets the counter when the stored window is
 * stale, bumps it otherwise, and returns the new count in one statement so
 * concurrent requests cannot both observe the pre-increment value.
 */
const BUMP_USER_LIMIT_SQL = `
	INSERT INTO openrouter_limits (user_id, window_start, count) VALUES (?, ?, 1)
	ON CONFLICT(user_id) DO UPDATE SET
		count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
		window_start = excluded.window_start
	RETURNING count`;

const BUMP_GLOBAL_LIMIT_SQL = `
	INSERT INTO openrouter_global_limits (id, window_start, count) VALUES (1, ?, 1)
	ON CONFLICT(id) DO UPDATE SET
		count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
		window_start = excluded.window_start
	RETURNING count`;

export type CompletionRole = "user" | "assistant";

export type CompletionMessage = {
	role: CompletionRole;
	content: string;
};

export type Completion = {
	model: string;
	content: string;
	citations?: Citation[];
	toolCalls?: ToolCall[];
};

export type CompletionFailure = {
	status: 500 | 502;
	message: string;
	details?: string;
};

export async function handleOpenRouterRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	// Accident-prevention: only signed-in users may spend the server key.
	// The session check ties every generate call to an authenticated caller;
	// it does not hide the live turn from the Worker or OpenRouter.
	const user = await getSessionUser(request, env);
	if (!user) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	if (request.method !== "POST") {
		return Response.json({ ok: false, error: "Use POST" }, { status: 405 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = parseCompletionRequest(body);
	if (!parsed.ok) {
		return Response.json({ ok: false, error: parsed.error }, { status: 400 });
	}

	// Only validated requests that would reach OpenRouter consume quota.
	const limit = await checkRateLimit(env.DB, user.id, Date.now());
	if (!limit.ok) {
		return rateLimitResponse(limit.retryAfterMs);
	}

	if (parsed.stream) {
		return requestStreamCompletion(env, parsed.messages, {
			origin: new URL(request.url).origin,
			model: parsed.model,
			effort: parsed.effort,
		});
	}

	const completion = await requestCompletion(env, parsed.messages, {
		origin: new URL(request.url).origin,
		model: parsed.model,
		effort: parsed.effort,
	});
	if (!completion.ok) {
		return Response.json(
			{
				ok: false,
				error: completion.error.message,
				details: completion.error.details,
			},
			{ status: completion.error.status },
		);
	}

	return Response.json({
		ok: true,
		model: completion.value.model,
		message: completion.value.content,
		...(completion.value.citations ? { citations: completion.value.citations } : {}),
		...(completion.value.toolCalls ? { toolCalls: completion.value.toolCalls } : {}),
	});
}

/**
 * Fixed-window quotas backed by openrouter_limits (per user) and
 * openrouter_global_limits (account-wide). Each check is a single atomic
 * upsert that returns the post-increment count, so a burst of concurrent
 * requests cannot slip past the ceiling. The per-user check runs first so a
 * throttled user does not eat into the shared window.
 */
export async function checkRateLimit(
	db: D1Database,
	userId: string,
	now: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
	const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
	const retryAfterMs = windowStart + WINDOW_MS - now;
	try {
		const user = await db
			.prepare(BUMP_USER_LIMIT_SQL)
			.bind(userId, windowStart)
			.first<{ count: number }>();
		if (user && user.count > MAX_GENERATES_PER_WINDOW) {
			return { ok: false, retryAfterMs };
		}

		const global = await db
			.prepare(BUMP_GLOBAL_LIMIT_SQL)
			.bind(windowStart)
			.first<{ count: number }>();
		if (global && global.count > MAX_GLOBAL_GENERATES_PER_WINDOW) {
			return { ok: false, retryAfterMs };
		}

		return { ok: true };
	} catch (error) {
		// Limiter is best-effort spend protection, not an auth boundary:
		// a D1 failure must not break generate for legitimate users.
		console.error("Rate limiter unavailable, admitting request", error);
		return { ok: true };
	}
}

export type CompletionOptions = {
	sessionId?: string;
	origin?: string;
	model?: ModelId;
	effort?: EffortId;
};

/**
 * Reasoning settings for an explicit (model, effort) pair. Both models take
 * plain `effort` levels; only the valid sets differ (see MODEL_EFFORTS).
 * Callers must validate first — this maps, it does not check.
 */
export function reasoningFor(
	model: ModelId,
	stream: boolean,
	effort?: EffortId,
): Record<string, string | number | boolean> {
	const exclude: Record<string, boolean> = stream ? {} : { exclude: true };
	return { effort: effort ?? DEFAULT_EFFORT[model], ...exclude };
}

function fetchOpenRouter(
	env: Env,
	messages: readonly CompletionMessage[],
	options: CompletionOptions | undefined,
	init: { model: ModelId; stream: boolean; signal?: AbortSignal },
): Promise<Response> {
	const body: {
		model: string;
		messages: OpenRouterMessage[];
		max_tokens: number;
		reasoning: Record<string, string | number | boolean>;
		tools: readonly [typeof WEB_SEARCH_TOOL];
		max_tool_calls: typeof MAX_TOOL_CALLS;
		stream?: boolean;
		stream_options?: { include_usage: true };
		session_id?: string;
	} = {
		model: init.model,
		messages: toOpenRouterMessages(messages, Date.now()),
		// Muse Spark still spends some of max_tokens on hidden reasoning even
		// at "minimal". 1024 often finishes with content: null and
		// finish_reason "length". `exclude` only hides the reasoning trace
		// from the response (the model still reasons and bills for it); it
		// keeps the non-streaming reply small so the reader is not left
		// waiting on thinking bytes, and leaves nothing to store or echo.
		// `exclude` is part of the unified reasoning object all OpenRouter
		// models accept.
		max_tokens: 4096,
		reasoning: reasoningFor(init.model, init.stream, options?.effort),
		tools: [WEB_SEARCH_TOOL],
		// Top-level sibling of `tools`. Omit it and OpenRouter defaults to 30.
		max_tool_calls: MAX_TOOL_CALLS,
	};
	if (init.stream) {
		body.stream = true;
		// Chat Completions omits `usage` on SSE unless asked. Without it,
		// `web_search_requests` never arrives and a search with no citations
		// produces no chip.
		body.stream_options = { include_usage: true };
	}
	if (options?.sessionId) {
		body.session_id = options.sessionId;
	}

	return fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": options?.origin ?? "http://localhost:5173",
			"X-Title": "treeGPT",
		},
		body: JSON.stringify(body),
		signal: init.signal,
	});
}

export async function requestCompletion(
	env: Env,
	messages: readonly CompletionMessage[],
	options?: CompletionOptions,
): Promise<{ ok: true; value: Completion } | { ok: false; error: CompletionFailure }> {
	if (!env.OPENROUTER_API_KEY) {
		return { ok: false, error: missingKeyFailure() };
	}

	const model = options?.model ?? DEFAULT_MODEL;
	const upstream = await fetchOpenRouter(env, messages, options, { model, stream: false });

	if (!upstream.ok) {
		return { ok: false, error: await upstreamFailure(upstream) };
	}

	const payload: unknown = await upstream.json();
	const parsed = parseCompletion(payload);
	if (!parsed) {
		return {
			ok: false,
			error: {
				status: 502,
				message: "Unexpected OpenRouter response shape",
			},
		};
	}
	if (!parsed.completion.content.trim()) {
		return {
			ok: false,
			error: {
				status: 502,
				message: "OpenRouter returned an empty reply",
				details: parsed.finishReason
					? `finish_reason=${parsed.finishReason}`
					: undefined,
			},
		};
	}

	return { ok: true, value: parsed.completion };
}

/** Client-facing stream event: text deltas, live search snapshots, then done (or error). */
export type StreamEvent =
	| { type: "reasoning"; text: string }
	| { type: "content"; text: string }
	| { type: "search"; citations?: Citation[]; toolCalls?: ToolCall[] }
	| { type: "done"; model: string; citations?: Citation[]; toolCalls?: ToolCall[] }
	| { type: "error"; error: string };

/**
 * What translateStream yields: client events plus keep-alive heartbeats.
 * Heartbeats exist only so encodeSse can keep the connection warm while
 * opening OpenRouter and through silent SSE; object consumers ignore them.
 */
export type UpstreamEvent = StreamEvent | { type: "heartbeat" };

/** Safety cap: the trace is display-only, never echoed, so bound it. */
const MAX_STREAM_REASONING_CHARS = 8_000;

/** Keep-alive while waiting on OpenRouter or a silent stretch of its SSE. */
const STREAM_HEARTBEAT_MS = 1_000;

/**
 * Starts a streaming completion and returns the translated event objects.
 * Callers that need SSE bytes pipe through encodeSse(); callers that need to
 * observe the reply (persist it) consume the objects directly.
 *
 * The Worker Response must exist before the OpenRouter fetch resolves.
 * Awaiting that fetch in the handler left the isolate with no body: the
 * edge canceled it as hung (and iOS Safari dropped it on a slow TTFB),
 * which is the empty-reply bug. Heartbeats start immediately so the
 * stream is never idle.
 */
export async function openStreamCompletion(
	env: Env,
	messages: readonly CompletionMessage[],
	options?: CompletionOptions,
): Promise<
	{ ok: true; events: ReadableStream<UpstreamEvent> } | { ok: false; error: CompletionFailure }
> {
	if (!env.OPENROUTER_API_KEY) {
		return { ok: false, error: missingKeyFailure() };
	}

	const model = options?.model ?? DEFAULT_MODEL;
	// Streaming wants the trace (no `exclude`) so the UI can show thinking
	// live. History still carries role/content only. The fetch stays inside
	// translateStream so heartbeats start before OpenRouter answers.
	return {
		ok: true,
		events: translateStream(async (signal) => {
			const upstream = await fetchOpenRouter(env, messages, options, {
				model,
				stream: true,
				signal,
			});
			if (!upstream.ok || !upstream.body) {
				return { ok: false, error: (await upstreamFailure(upstream)).message };
			}
			return { ok: true, body: upstream.body };
		}, model),
	};
}

function missingKeyFailure(): CompletionFailure {
	console.error("OPENROUTER_API_KEY is not set; refusing to generate");
	return { status: 500, message: NOT_CONFIGURED };
}

/**
 * Upstream error bodies describe the server's OpenRouter account (credit
 * state, key labels, provider diagnostics), so they go to the Worker log
 * only. Clients get the status code, which is enough to act on.
 */
async function upstreamFailure(upstream: Response): Promise<CompletionFailure> {
	let body = "";
	try {
		body = (await upstream.text()).slice(0, 500);
	} catch {
		// Body already consumed or unreadable; the status is still worth logging.
	}
	console.error(`OpenRouter returned ${upstream.status}`, body);
	return { status: 502, message: `OpenRouter returned ${upstream.status}` };
}

export async function requestStreamCompletion(
	env: Env,
	messages: readonly CompletionMessage[],
	options?: CompletionOptions,
): Promise<Response> {
	const opened = await openStreamCompletion(env, messages, options);
	if (!opened.ok) {
		return Response.json(
			{ ok: false, error: opened.error.message, details: opened.error.details },
			{ status: opened.error.status },
		);
	}
	return sseResponse(opened.events);
}

export function rateLimitResponse(retryAfterMs: number): Response {
	return Response.json(
		{ ok: false, error: "Rate limit exceeded, try again later" },
		{
			status: 429,
			headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
		},
	);
}

/** Wraps an event object stream as a text/event-stream Response. */
export function sseResponse<T extends { type: string }>(events: ReadableStream<T>): Response {
	return new Response(events.pipeThrough(encodeSse()), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

/** Event objects → SSE bytes. Heartbeats become comment frames. */
export function encodeSse<T extends { type: string }>(): TransformStream<T, Uint8Array> {
	const encoder = new TextEncoder();
	return new TransformStream<T, Uint8Array>({
		transform(event, controller) {
			if (event.type === "heartbeat") {
				controller.enqueue(encoder.encode(`:thinking\n\n`));
				return;
			}
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
		},
	});
}

type OpenedUpstream =
	| { ok: true; body: ReadableStream<Uint8Array> }
	| { ok: false; error: string };

/**
 * Opens upstream, then re-emits OpenRouter SSE as our StreamEvent protocol.
 * Heartbeats start before `open` resolves so the Worker Response is never
 * idle (the empty-reply hang). Empty frames also heartbeat through long
 * encrypted-reasoning stretches. `reasoning_details` become display-only
 * `reasoning` text: never stored server-side, never echoed on later turns.
 */
function translateStream(
	open: (signal: AbortSignal) => Promise<OpenedUpstream>,
	fallbackModel: string = DEFAULT_MODEL,
): ReadableStream<UpstreamEvent> {
	const decoder = new TextDecoder();
	const abort = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let buffer = "";
	let model = fallbackModel;
	let reasoningSent = 0;
	let finished = false;
	const searchAcc = createSearchAccumulator();
	let lastSearchFingerprint = "";
	let emittedContent = "";

	return new ReadableStream<UpstreamEvent>({
		// Pump from start(), not pull(): resolving pulls without enqueueing
		// (long encrypted-reasoning stretches with no displayable frames)
		// stalls delivery, idles the response, and the edge closes it.
		async start(controller) {
			const emit = (event: UpstreamEvent) => {
				if (!finished) {
					controller.enqueue(event);
				}
			};
			const heartbeat = () => {
				emit({ type: "heartbeat" });
			};
			const finish = (event: StreamEvent) => {
				if (!finished) {
					finished = true;
					controller.enqueue(event);
				}
				try {
					controller.close();
				} catch {
					// Consumer already gone; nothing to unwind.
				}
			};
			const beat = setInterval(heartbeat, STREAM_HEARTBEAT_MS);
			heartbeat();
			try {
				const opened = await open(abort.signal);
				if (!opened.ok) {
					finish({ type: "error", error: opened.error });
					return;
				}
				reader = opened.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";
					for (const frame of frames) {
						const collected = collectFrameEvents(frame);
						if (collected.length === 0) {
							heartbeat();
							continue;
						}
						for (const event of collected) {
							if (event === "upstream-error") {
								finish({ type: "error", error: "OpenRouter returned an error" });
								try {
									await reader.cancel();
								} catch {
									// Already settled; nothing to unwind.
								}
								return;
							}
							emit(event);
						}
					}
				}
				if (buffer.trim()) {
					for (const event of collectFrameEvents(buffer)) {
						if (event !== "upstream-error") {
							emit(event);
						}
					}
					buffer = "";
				}
				finish({ type: "done", model, ...finalizeSearchMeta(searchAcc) });
			} catch {
				if (!abort.signal.aborted) {
					finish({ type: "error", error: "Stream interrupted" });
				}
			} finally {
				clearInterval(beat);
				if (!finished) {
					try {
						controller.close();
					} catch {
						// Consumer already gone.
					}
				}
			}
		},
		async cancel() {
			finished = true;
			abort.abort();
			try {
				await reader?.cancel();
			} catch {
				// Reader already settled; nothing to unwind.
			}
		},
	});

	function collectFrameEvents(frame: string): (StreamEvent | "upstream-error")[] {
		const events: (StreamEvent | "upstream-error")[] = [];
		for (const line of frame.split("\n")) {
			const data = line.startsWith("data:") ? line.slice(5).trim() : "";
			if (!data || data === "[DONE]") {
				continue;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(data);
			} catch {
				continue;
			}
			if (typeof payload !== "object" || payload === null) {
				continue;
			}
			if ("model" in payload && typeof payload.model === "string") {
				model = payload.model;
			}
			if ("error" in payload) {
				return ["upstream-error"];
			}
			ingestOpenRouterPayload(searchAcc, payload);
			const search = snapshotSearchMeta(searchAcc);
			const fingerprint = searchFingerprint(search);
			if (search && fingerprint !== lastSearchFingerprint) {
				lastSearchFingerprint = fingerprint;
				events.push({ type: "search", ...search });
			}
			const delta = readDelta(payload);
			if (!delta) {
				continue;
			}
			if (delta.reasoning && reasoningSent < MAX_STREAM_REASONING_CHARS) {
				const room = MAX_STREAM_REASONING_CHARS - reasoningSent;
				const text = delta.reasoning.slice(0, room);
				reasoningSent += text.length;
				if (text) {
					events.push({ type: "reasoning", text });
				}
			}
			if (delta.content) {
				const assembled = unsquashSentences(emittedContent + delta.content);
				const text = assembled.slice(emittedContent.length);
				emittedContent = assembled;
				events.push({ type: "content", text });
			}
		}
		return events;
	}
}

function readDelta(payload: object): { content?: string; reasoning?: string } | null {
	if (!("choices" in payload) || !Array.isArray(payload.choices)) {
		return null;
	}
	const first = payload.choices[0];
	if (typeof first !== "object" || first === null || !("delta" in first)) {
		return null;
	}
	const delta = first.delta;
	if (typeof delta !== "object" || delta === null) {
		return null;
	}
	const out: { content?: string; reasoning?: string } = {};
	if ("content" in delta) {
		const content = messageText(delta.content);
		if (content) {
			out.content = content;
		}
	}
	const texts: string[] = [];
	if ("reasoning" in delta && typeof delta.reasoning === "string" && delta.reasoning) {
		texts.push(delta.reasoning);
	}
	if ("reasoning_details" in delta && Array.isArray(delta.reasoning_details)) {
		for (const item of delta.reasoning_details) {
			if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") {
				texts.push(item.text);
			}
		}
	}
	if (texts.length > 0) {
		out.reasoning = texts.join("");
	}
	return out.content || out.reasoning ? out : null;
}

function parseCompletionRequest(
	body: unknown,
):
	| { ok: true; messages: CompletionMessage[]; stream: boolean; model: ModelId; effort: EffortId }
	| { ok: false; error: string } {
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Invalid JSON body" };
	}

	if (!("message" in body) || typeof body.message !== "string") {
		return { ok: false, error: "message must be a string" };
	}

	const message = body.message.trim();
	if (!message) {
		return { ok: false, error: "message must not be empty" };
	}
	if (message.length > MAX_TURN_CHARS) {
		return { ok: false, error: "message is too long" };
	}

	const stream = "stream" in body && body.stream === true;

	let model: ModelId = DEFAULT_MODEL;
	if ("model" in body && body.model !== undefined) {
		if (!isModelId(body.model)) {
			return { ok: false, error: "model is not supported" };
		}
		model = body.model;
	}

	let effort: EffortId = DEFAULT_EFFORT[model];
	if ("effort" in body && body.effort !== undefined) {
		if (!isEffortId(body.effort)) {
			return { ok: false, error: "effort is not supported" };
		}
		if (!MODEL_EFFORTS[model].includes(body.effort)) {
			return { ok: false, error: "effort is not supported by this model" };
		}
		effort = body.effort;
	}

	if (!("messages" in body) || body.messages === undefined) {
		return { ok: true, messages: [{ role: "user", content: message }], stream, model, effort };
	}

	const history = parseMessages(body.messages);
	if (!history.ok) {
		return history;
	}

	if (history.messages.length === 0) {
		return { ok: true, messages: [{ role: "user", content: message }], stream, model, effort };
	}

	return { ok: true, messages: history.messages, stream, model, effort };
}

function parseMessages(
	raw: unknown,
): { ok: true; messages: CompletionMessage[] } | { ok: false; error: string } {
	if (!Array.isArray(raw)) {
		return { ok: false, error: "messages must be an array" };
	}

	const parsed: CompletionMessage[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) {
			return { ok: false, error: "messages items must be objects" };
		}
		if (!("role" in item) || !isRole(item.role)) {
			return { ok: false, error: "messages items must have role user or assistant" };
		}
		if (!("content" in item) || typeof item.content !== "string") {
			return { ok: false, error: "messages items must have content" };
		}

		const content = item.content.trim();
		if (!content) {
			return { ok: false, error: "messages content must not be empty" };
		}
		if (content.length > MAX_TURN_CHARS) {
			return { ok: false, error: "messages content is too long" };
		}

		// Legacy clients (and stored chats) may still carry reasoningDetails
		// blobs. They are accepted and dropped: we send OpenRouter server
		// tools each request but never persist or replay tool state, so
		// echoing old thinking only slows the next reply.
		parsed.push({ role: item.role, content });
	}

	return { ok: true, messages: capHistory(parsed) };
}

/** Last MAX_HISTORY turns, trimmed from the front to MAX_HISTORY_CHARS. */
export function capHistory(messages: CompletionMessage[]): CompletionMessage[] {
	const recent =
		messages.length > MAX_HISTORY ? messages.slice(messages.length - MAX_HISTORY) : messages;

	let total = 0;
	let start = recent.length;
	while (start > 0) {
		const next = recent[start - 1];
		if (!next) {
			break;
		}
		total += next.content.length;
		if (total > MAX_HISTORY_CHARS) {
			break;
		}
		start -= 1;
	}

	return recent.slice(start);
}

type ParsedUpstream = {
	completion: Completion;
	finishReason?: string;
};

function parseCompletion(payload: unknown): ParsedUpstream | null {
	if (typeof payload !== "object" || payload === null) {
		return null;
	}

	if (!("model" in payload) || typeof payload.model !== "string") {
		return null;
	}

	if (!("choices" in payload) || !Array.isArray(payload.choices)) {
		return null;
	}

	const first = payload.choices[0];
	if (typeof first !== "object" || first === null || !("message" in first)) {
		return null;
	}

	const message = first.message;
	if (typeof message !== "object" || message === null) {
		return null;
	}

	const raw = "content" in message ? messageText(message.content) : null;
	if (raw === null) {
		return null;
	}
	const content = unsquashSentences(raw);

	const finishReason =
		"finish_reason" in first && typeof first.finish_reason === "string"
			? first.finish_reason
			: undefined;

	// Any reasoning_details OpenRouter returns (e.g. when `exclude` is not
	// honored) are deliberately dropped: there is no tool loop to continue,
	// and keeping them would only bloat the next request.
	const search = searchMetaFromPayload(payload);
	return {
		completion: { model: payload.model, content, ...search },
		finishReason,
	};
}

type OpenRouterMessage = {
	role: "system" | CompletionRole;
	content: string;
};

function toOpenRouterMessages(
	messages: readonly CompletionMessage[],
	now: number,
): OpenRouterMessage[] {
	return [
		{ role: "system", content: systemPrompt(now) },
		...messages.map((message) => ({ role: message.role, content: message.content })),
	];
}

/** OpenRouter `content`: string, null while reasoning, or text / output_text parts. */
function messageText(content: unknown): string | null {
	if (typeof content === "string") {
		return content;
	}
	if (content === null || content === undefined) {
		return "";
	}
	if (!Array.isArray(content)) {
		return null;
	}

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.join("");
}
