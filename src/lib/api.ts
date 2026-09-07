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

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		return { ok: false, error: `Server returned ${response.status} with no JSON body` };
	}
	return parseChatResponse(data);
}

export function parseChatResponse(data: unknown): ChatResponse {
	if (typeof data !== "object" || data === null || !("ok" in data)) {
		return { ok: false, error: "Unexpected response from /api/openrouter" };
	}

	if (data.ok === true && "model" in data && "message" in data) {
		if (typeof data.model === "string" && typeof data.message === "string") {
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
