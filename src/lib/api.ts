import { sanitizeCitations, sanitizeToolCalls } from "../../worker/search-meta";
import type { Citation, EffortId, ModelId, ToolCall } from "../../worker/tree-types";
import type { Role } from "../types";

export type ChatResponse =
	| { ok: true; model: string; message: string }
	| { ok: false; error: string; details?: string };

export type ChatTurn = { role: Role; content: string };

export type StreamUpdate =
	| { type: "reasoning"; text: string }
	| { type: "content"; text: string }
	| { type: "search"; citations?: Citation[]; toolCalls?: ToolCall[] };

export type StreamResult =
	| { ok: true; model: string; citations?: Citation[]; toolCalls?: ToolCall[] }
	| { ok: false; error: string; details?: string };

/**
 * POST /api/openrouter with `stream: true`. Sends the whole conversation as
 * `messages` (oldest first, ending with the new user turn) plus `message`, a
 * copy of that last user turn, which is the field the current Worker reads.
 * See "API contract" in README.md. Resolves when the worker closes the
 * stream; text arrives incrementally through onUpdate. Throws on network
 * failure or abort (the caller decides what to keep).
 */
export async function sendChatStream(
	messages: ChatTurn[],
	signal: AbortSignal,
	onUpdate: (update: StreamUpdate) => void,
	options?: { model?: ModelId; effort?: EffortId },
): Promise<StreamResult> {
	const last = messages[messages.length - 1];
	const response = await fetch("/api/openrouter", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message: last?.content ?? "",
			messages,
			stream: true,
			...(options?.model ? { model: options.model } : {}),
			...(options?.effort ? { effort: options.effort } : {}),
		}),
		signal,
	});

	const contentType = response.headers.get("Content-Type") ?? "";
	if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			// Some failures (proxies, gateways) answer without a JSON body.
		}
		const parsed = body === null ? null : parseChatResponse(body);
		if (parsed && !parsed.ok) {
			return parsed;
		}
		if (response.status === 401) {
			return { ok: false, error: "Your session expired. Reload the page to sign in again." };
		}
		if (response.status === 429) {
			return { ok: false, error: rateLimitMessage(response.headers.get("Retry-After")) };
		}
		if (parsed) {
			return { ok: false, error: "Unexpected response from /api/openrouter" };
		}
		return { ok: false, error: `The server returned ${response.status}.` };
	}

	return consumeStream(response.body, onUpdate);
}

async function consumeStream(
	body: ReadableStream<Uint8Array>,
	onUpdate: (update: StreamUpdate) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let model = "";
	let citations: Citation[] | undefined;
	let toolCalls: ToolCall[] | undefined;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const result = handleStreamFrame(frame, onUpdate);
			if (result) {
				if (result.type === "done") {
					model = result.model;
					citations = result.citations;
					toolCalls = result.toolCalls;
				} else {
					await reader.cancel();
					return { ok: false, error: result.error };
				}
			}
		}
	}
	if (model) {
		return {
			ok: true,
			model,
			...(citations && citations.length > 0 ? { citations } : {}),
			...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
		};
	}
	return { ok: false, error: "The stream ended without a reply." };
}

function handleStreamFrame(
	frame: string,
	onUpdate: (update: StreamUpdate) => void,
):
	| { type: "done"; model: string; citations?: Citation[]; toolCalls?: ToolCall[] }
	| { type: "error"; error: string }
	| null {
	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const data = line.slice(5).trim();
		if (!data) {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			continue;
		}
		if (typeof event !== "object" || event === null || !("type" in event)) {
			continue;
		}
		if (event.type === "reasoning" || event.type === "content") {
			if ("text" in event && typeof event.text === "string" && event.text) {
				onUpdate({ type: event.type, text: event.text });
			}
			continue;
		}
		if (event.type === "search") {
			const citations = "citations" in event ? sanitizeCitations(event.citations) : [];
			const toolCalls = "toolCalls" in event ? sanitizeToolCalls(event.toolCalls) : [];
			if (citations.length > 0 || toolCalls.length > 0) {
				onUpdate({
					type: "search",
					...(citations.length > 0 ? { citations } : {}),
					...(toolCalls.length > 0 ? { toolCalls } : {}),
				});
			}
			continue;
		}
		if (event.type === "done" && "model" in event && typeof event.model === "string") {
			const citations = "citations" in event ? sanitizeCitations(event.citations) : [];
			const toolCalls = "toolCalls" in event ? sanitizeToolCalls(event.toolCalls) : [];
			return {
				type: "done",
				model: event.model,
				...(citations.length > 0 ? { citations } : {}),
				...(toolCalls.length > 0 ? { toolCalls } : {}),
			};
		}
		if (event.type === "error" && "error" in event && typeof event.error === "string") {
			return { type: "error", error: event.error };
		}
	}
	return null;
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
