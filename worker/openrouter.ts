const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const FREE_MODEL = "openrouter/free";

const MAX_TURN_CHARS = 8_000;
const MAX_HISTORY = 50;
const MAX_HISTORY_CHARS = 32_000;

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
		messages: readonly CompletionMessage[];
		max_tokens: number;
		session_id?: string;
	} = {
		model: FREE_MODEL,
		messages,
		max_tokens: 1024,
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

	return { ok: true, value: parsed };
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

function parseCompletion(payload: unknown): Completion | null {
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

	if (!("content" in message) || typeof message.content !== "string") {
		return null;
	}

	return { model: payload.model, content: message.content };
}
