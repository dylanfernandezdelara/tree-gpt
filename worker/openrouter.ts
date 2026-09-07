import { getSessionUser } from "./auth.js";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHAT_MODEL = "meta/muse-spark-1.3-contributor";

const MAX_TURN_CHARS = 8_000;
const MAX_HISTORY = 50;
const MAX_HISTORY_CHARS = 32_000;

// Per-user generate quota: at most MAX_GENERATES_PER_WINDOW calls per WINDOW_MS.
// Checked before any upstream call so a runaway client or compromised
// account cannot burn the server key without bound.
const WINDOW_MS = 3_600_000;
const MAX_GENERATES_PER_WINDOW = 60;

export type CompletionRole = "user" | "assistant";

export type CompletionMessage = {
	role: CompletionRole;
	content: string;
};

export type Completion = {
	model: string;
	content: string;
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
		return Response.json(
			{ ok: false, error: "Rate limit exceeded, try again later" },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
			},
		);
	}

	if (parsed.stream) {
		return requestStreamCompletion(env, parsed.messages, {
			origin: new URL(request.url).origin,
		});
	}

	const completion = await requestCompletion(env, parsed.messages, {
		origin: new URL(request.url).origin,
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
	});
}

/**
 * Fixed-window per-user quota backed by the openrouter_limits table.
 * Read-then-write races can over-admit by a call under concurrency; that
 * fail-open direction is acceptable for spend protection at this scale.
 */
async function checkRateLimit(
	db: D1Database,
	userId: string,
	now: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
	const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
	try {
		const row = await db
			.prepare(`SELECT window_start AS windowStart, count FROM openrouter_limits WHERE user_id = ?`)
			.bind(userId)
			.first<{ windowStart: number; count: number }>();

		if (!row || row.windowStart !== windowStart) {
			await db
				.prepare(
					`INSERT INTO openrouter_limits (user_id, window_start, count)
					 VALUES (?, ?, 1)
					 ON CONFLICT(user_id) DO UPDATE SET window_start = excluded.window_start, count = 1`,
				)
				.bind(userId, windowStart)
				.run();
			return { ok: true };
		}

		if (row.count >= MAX_GENERATES_PER_WINDOW) {
			return { ok: false, retryAfterMs: windowStart + WINDOW_MS - now };
		}

		await db
			.prepare(`UPDATE openrouter_limits SET count = count + 1 WHERE user_id = ?`)
			.bind(userId)
			.run();
		return { ok: true };
	} catch {
		// Limiter is best-effort spend protection, not an auth boundary:
		// a D1 failure must not break generate for legitimate users.
		return { ok: true };
	}
}

export async function requestCompletion(
	env: Env,
	messages: readonly CompletionMessage[],
	options?: { sessionId?: string; origin?: string },
): Promise<{ ok: true; value: Completion } | { ok: false; error: CompletionFailure }> {
	if (!env.OPENROUTER_API_KEY) {
		return {
			ok: false,
			error: {
				status: 500,
				message: "OPENROUTER_API_KEY is not set in .dev.vars",
			},
		};
	}

	const body: {
		model: string;
		messages: OpenRouterMessage[];
		max_tokens: number;
		reasoning: { effort: "minimal"; exclude: true };
		session_id?: string;
	} = {
		model: CHAT_MODEL,
		messages: toOpenRouterMessages(messages),
		// Muse Spark still spends some of max_tokens on hidden reasoning even
		// at "minimal". 1024 often finishes with content: null and
		// finish_reason "length". `exclude` only hides the reasoning trace
		// from the response (the model still reasons and bills for it); it
		// keeps the non-streaming reply small so the reader is not left
		// waiting on thinking bytes, and leaves nothing to store or echo.
		// `exclude` is part of the unified reasoning object all OpenRouter
		// models accept, and the live catalog lists `minimal` in this
		// model's supported_efforts with reasoning mandatory — so this is
		// the fastest legal setting, no fallback needed.
		max_tokens: 4096,
		reasoning: { effort: "minimal", exclude: true },
	};
	if (options?.sessionId) {
		body.session_id = options.sessionId;
	}

	const upstream = await fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": options?.origin ?? "http://localhost:5173",
			"X-Title": "treeGPT",
		},
		body: JSON.stringify(body),
	});

	if (!upstream.ok) {
		const details = (await upstream.text()).slice(0, 500);
		return {
			ok: false,
			error: {
				status: 502,
				message: `OpenRouter returned ${upstream.status}`,
				details,
			},
		};
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

/** Client-facing stream event: text deltas, then done (or error). */
export type StreamEvent =
	| { type: "reasoning"; text: string }
	| { type: "content"; text: string }
	| { type: "done"; model: string }
	| { type: "error"; error: string };

/** Safety cap: the trace is display-only, never echoed, so bound it. */
const MAX_STREAM_REASONING_CHARS = 8_000;

export async function requestStreamCompletion(
	env: Env,
	messages: readonly CompletionMessage[],
	options?: { sessionId?: string; origin?: string },
): Promise<Response> {
	if (!env.OPENROUTER_API_KEY) {
		return Response.json(
			{ ok: false, error: "OPENROUTER_API_KEY is not set in .dev.vars" },
			{ status: 500 },
		);
	}

	// Streaming wants the trace (no `exclude`) so the UI can show thinking
	// live. History still carries role/content only, so the input side of
	// the latency fix is unchanged.
	const upstream = await fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": options?.origin ?? "http://localhost:5173",
			"X-Title": "treeGPT",
		},
		body: JSON.stringify({
			model: CHAT_MODEL,
			messages: toOpenRouterMessages(messages),
			max_tokens: 4096,
			reasoning: { effort: "minimal" },
			stream: true,
			...(options?.sessionId ? { session_id: options.sessionId } : {}),
		}),
	});

	if (!upstream.ok || !upstream.body) {
		const details = (await upstream.text()).slice(0, 500);
		return Response.json(
			{ ok: false, error: `OpenRouter returned ${upstream.status}`, details },
			{ status: 502 },
		);
	}

	const stream = translateStream(upstream.body);
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

/**
 * Re-emits OpenRouter SSE as our minimal StreamEvent protocol. Upstream
 * `reasoning_details` deltas become display-only `reasoning` text: they are
 * never stored server-side and never echoed on later turns.
 */
function translateStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffer = "";
	let model = CHAT_MODEL;
	let reasoningSent = 0;
	let closed = false;

	function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent) {
		if (!closed) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
		}
	}

	function handleFrame(
		controller: ReadableStreamDefaultController<Uint8Array>,
		frame: string,
	) {
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
				emit(controller, { type: "error", error: "OpenRouter returned an error" });
				closed = true;
				return;
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
					emit(controller, { type: "reasoning", text });
				}
			}
			if (delta.content) {
				emit(controller, { type: "content", text: delta.content });
			}
		}
	}

	const reader = upstream.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (closed) {
				controller.close();
				return;
			}
			try {
				const { done, value } = await reader.read();
				if (done) {
					const tail = buffer;
					buffer = "";
					if (tail.trim()) {
						handleFrame(controller, tail);
					}
					if (!closed) {
						emit(controller, { type: "done", model });
					}
					controller.close();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					handleFrame(controller, frame);
					if (closed) {
						break;
					}
				}
				if (closed) {
					controller.close();
				}
			} catch {
				if (!closed) {
					emit(controller, { type: "error", error: "Stream interrupted" });
				}
				controller.close();
			}
		},
		async cancel() {
			closed = true;
			try {
				await reader.cancel();
			} catch {
				// Reader already settled; nothing to unwind.
			}
		},
	});
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
	if ("content" in delta && typeof delta.content === "string" && delta.content) {
		out.content = delta.content;
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
): { ok: true; messages: CompletionMessage[]; stream: boolean } | { ok: false; error: string } {
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

	if (!("messages" in body) || body.messages === undefined) {
		return { ok: true, messages: [{ role: "user", content: message }], stream };
	}

	const history = parseMessages(body.messages);
	if (!history.ok) {
		return history;
	}

	if (history.messages.length === 0) {
		return { ok: true, messages: [{ role: "user", content: message }], stream };
	}

	return { ok: true, messages: history.messages, stream };
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
		// blobs. They are accepted and dropped: plain chat never sends
		// `tools`, so OpenRouter has no tool-use continuity to preserve and
		// echoing old thinking only slows the next reply.
		parsed.push({ role: item.role, content });
	}

	return { ok: true, messages: capHistory(parsed) };
}

function capHistory(messages: CompletionMessage[]): CompletionMessage[] {
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

function isRole(value: unknown): value is CompletionRole {
	return value === "user" || value === "assistant";
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

	const content = "content" in message ? messageText(message.content) : null;
	if (content === null) {
		return null;
	}

	const finishReason =
		"finish_reason" in first && typeof first.finish_reason === "string"
			? first.finish_reason
			: undefined;

	// Any reasoning_details OpenRouter returns (e.g. when `exclude` is not
	// honored) are deliberately dropped: there is no tool loop to continue,
	// and keeping them would only bloat the next request.
	return {
		completion: { model: payload.model, content },
		finishReason,
	};
}

type OpenRouterMessage = {
	role: CompletionRole;
	content: string;
};

function toOpenRouterMessages(messages: readonly CompletionMessage[]): OpenRouterMessage[] {
	return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Muse Spark returns content: null when reasoning consumes the token budget.
 * Some models also return content as an array of text parts.
 */
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
