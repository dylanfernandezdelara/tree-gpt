import type { Role } from "../types";

export type ChatResponse =
	| { ok: true; model: string; message: string }
	| { ok: false; error: string; details?: string };

export type ChatTurn = { role: Role; content: string };

/**
 * POST /api/openrouter
 *
 * Sends the whole conversation as `messages` (oldest first, ending with the
 * new user turn) plus `message`, a copy of that last user turn, which is the
 * field the current Worker reads. See "API contract" in README.md.
 *
 * Throws on network failure or abort; returns `{ ok: false }` for server errors.
 */
export async function sendChat(
	messages: ChatTurn[],
	signal: AbortSignal,
): Promise<ChatResponse> {
	const last = messages[messages.length - 1];
	const response = await fetch("/api/openrouter", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: last?.content ?? "", messages }),
		signal,
	});

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// Some failures (proxies, gateways) answer without a JSON body.
	}
	const parsed = body === null ? null : parseChatResponse(body);
	if (parsed?.ok) {
		return parsed;
	}

	// Known statuses get a message that says what to do next; anything else
	// falls back to whatever the Worker reported.
	if (response.status === 401) {
		return { ok: false, error: "Your session expired. Reload the page to sign in again." };
	}
	if (response.status === 429) {
		return { ok: false, error: rateLimitMessage(response.headers.get("Retry-After")) };
	}
	if (parsed) {
		return parsed;
	}
	return { ok: false, error: `The server returned ${response.status}.` };
}

/** The Worker caps generations per hour and sends Retry-After in seconds. */
function rateLimitMessage(retryAfter: string | null): string {
	const seconds = Number(retryAfter);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return "You've reached the hourly message limit. Try again later.";
	}
	const minutes = Math.ceil(seconds / 60);
	if (minutes >= 60) {
		return "You've reached the hourly message limit. Try again in about an hour.";
	}
	return `You've reached the hourly message limit. Try again in ${minutes} minute${
		minutes === 1 ? "" : "s"
	}.`;
}

export function parseChatResponse(data: unknown): ChatResponse {
	if (typeof data !== "object" || data === null || !("ok" in data)) {
		return { ok: false, error: "Unexpected response from /api/openrouter" };
	}

	if (data.ok === true && "model" in data && "message" in data) {
		if (typeof data.model === "string" && typeof data.message === "string") {
			// Legacy servers may include reasoningDetails; it is ignored.
			return { ok: true, model: data.model, message: data.message };
		}
	}

	if (data.ok === false && "error" in data && typeof data.error === "string") {
		return {
			ok: false,
			error: data.error,
			details:
				"details" in data && typeof data.details === "string"
					? data.details
					: undefined,
		};
	}

	return { ok: false, error: "Unexpected response from /api/openrouter" };
}
