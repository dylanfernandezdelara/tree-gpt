import { getSessionUser } from "./auth.js";
import {
	optionalReasoning,
	parseReasoningDetails,
	reasoningDetailsSize,
	type ReasoningDetails,
} from "./reasoning.js";

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
	reasoningDetails?: ReasoningDetails;
};

export type Completion = {
	model: string;
	content: string;
	reasoningDetails?: ReasoningDetails;
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
		reasoningDetails: completion.value.reasoningDetails,
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
		reasoning: { effort: "medium" };
		session_id?: string;
	} = {
		model: CHAT_MODEL,
		messages: toOpenRouterMessages(messages),
		// Muse Spark spends most of max_tokens on hidden reasoning. 1024 often
		// finishes with content: null and finish_reason "length".
		max_tokens: 4096,
		reasoning: { effort: "medium" },
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

function parseCompletionRequest(
	body: unknown,
): { ok: true; messages: CompletionMessage[] } | { ok: false; error: string } {
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

	if (!("messages" in body) || body.messages === undefined) {
		return { ok: true, messages: [{ role: "user", content: message }] };
	}

	const history = parseMessages(body.messages);
	if (!history.ok) {
		return history;
	}

	if (history.messages.length === 0) {
		return { ok: true, messages: [{ role: "user", content: message }] };
	}

	return { ok: true, messages: history.messages };
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

		const reasoning = parseAssistantReasoning(item.role, item);
		if (!reasoning.ok) {
			return reasoning;
		}

		parsed.push({
			role: item.role,
			content,
			...optionalReasoning(item.role, reasoning.value),
		});
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
		total += next.content.length + reasoningDetailsSize(next.reasoningDetails);
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

function parseAssistantReasoning(
	role: CompletionRole,
	item: object,
): { ok: true; value?: ReasoningDetails } | { ok: false; error: string } {
	const raw = "reasoningDetails" in item ? item.reasoningDetails : undefined;
	const parsed = parseReasoningDetails(raw);
	if (!parsed.ok) {
		return parsed;
	}
	if (role !== "assistant" && parsed.value) {
		return { ok: false, error: "reasoningDetails is only valid on assistant messages" };
	}
	return parsed;
}

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

	const rawDetails = "reasoning_details" in message ? message.reasoning_details : undefined;
	if (rawDetails !== undefined && rawDetails !== null) {
		const details = parseReasoningDetails(rawDetails);
		if (!details.ok) {
			return null;
		}
		return {
			completion: {
				model: payload.model,
				content,
				...optionalReasoning("assistant", details.value),
			},
			finishReason,
		};
	}

	return {
		completion: { model: payload.model, content },
		finishReason,
	};
}

type OpenRouterMessage = {
	role: CompletionRole;
	content: string;
	reasoning_details?: ReasoningDetails;
};

function toOpenRouterMessages(messages: readonly CompletionMessage[]): OpenRouterMessage[] {
	return messages.map((message) => {
		const next: OpenRouterMessage = { role: message.role, content: message.content };
		if (message.role === "assistant" && message.reasoningDetails) {
			next.reasoning_details = message.reasoningDetails;
		}
		return next;
	});
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
