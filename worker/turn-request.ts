/** Body validation for POST /api/chats/:id/turns. Shape only; no DB access. */
import type { EffortId, ModelId, TurnRequest } from "./tree-types.js";
import {
	DEFAULT_EFFORT,
	DEFAULT_MODEL,
	MAX_CONTENT,
	MAX_TITLE,
	MODEL_EFFORTS,
	isEffortId,
	isId,
	isModelId,
} from "./tree-types.js";

export type ParsedTurn = TurnRequest & { stream: boolean; model: ModelId; effort: EffortId };

export function parseTurnRequest(body: unknown): { ok: true; value: ParsedTurn } | { ok: false; error: string } {
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "Invalid JSON body" };
	}

	if (!("parentId" in body) || (body.parentId !== null && !isId(body.parentId))) {
		return { ok: false, error: "parentId is invalid" };
	}
	if (!("expectLeaf" in body) || (body.expectLeaf !== null && !isId(body.expectLeaf))) {
		return { ok: false, error: "expectLeaf is invalid" };
	}
	if (!("replyId" in body) || !isId(body.replyId)) {
		return { ok: false, error: "replyId is invalid" };
	}

	let fork: TurnRequest["fork"];
	if ("fork" in body && body.fork !== undefined) {
		if (typeof body.fork !== "object" || body.fork === null) {
			return { ok: false, error: "fork is invalid" };
		}
		if (!("chatId" in body.fork) || !isId(body.fork.chatId)) {
			return { ok: false, error: "fork.chatId is invalid" };
		}
		if (!("title" in body.fork) || typeof body.fork.title !== "string") {
			return { ok: false, error: "fork.title must be a string" };
		}
		const forkTitle = body.fork.title.trim();
		if (!forkTitle) {
			return { ok: false, error: "fork.title must not be empty" };
		}
		if (forkTitle.length > MAX_TITLE) {
			return { ok: false, error: "fork.title is too long" };
		}
		fork = { chatId: body.fork.chatId, title: forkTitle };
	}

	let userMessage: TurnRequest["userMessage"];
	if ("userMessage" in body && body.userMessage !== undefined) {
		if (typeof body.userMessage !== "object" || body.userMessage === null) {
			return { ok: false, error: "userMessage is invalid" };
		}
		if (!("id" in body.userMessage) || !isId(body.userMessage.id)) {
			return { ok: false, error: "userMessage.id is invalid" };
		}
		if (!("content" in body.userMessage) || typeof body.userMessage.content !== "string") {
			return { ok: false, error: "userMessage content must be a string" };
		}
		const content = body.userMessage.content.trim();
		if (!content) {
			return { ok: false, error: "userMessage content must not be empty" };
		}
		if (content.length > MAX_CONTENT) {
			return { ok: false, error: "userMessage content is too long" };
		}
		userMessage = { id: body.userMessage.id, content };
	}

	let title: string | undefined;
	if ("title" in body && body.title !== undefined) {
		if (typeof body.title !== "string") {
			return { ok: false, error: "title must be a string" };
		}
		const trimmed = body.title.trim() || "New chat";
		if (trimmed.length > MAX_TITLE) {
			return { ok: false, error: "title is too long" };
		}
		title = trimmed;
	}

	let stream = false;
	if ("stream" in body && body.stream !== undefined) {
		if (typeof body.stream !== "boolean") {
			return { ok: false, error: "stream must be a boolean" };
		}
		stream = body.stream;
	}

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

	if (!userMessage && body.parentId === null) {
		return { ok: false, error: "parentId is required for redo" };
	}
	if (body.parentId === null && fork) {
		return { ok: false, error: "fork is not allowed when creating a chat" };
	}
	if (userMessage && userMessage.id === body.replyId) {
		return { ok: false, error: "userMessage.id must differ from replyId" };
	}

	return {
		ok: true,
		value: {
			parentId: body.parentId,
			expectLeaf: body.expectLeaf,
			replyId: body.replyId,
			...(fork ? { fork } : {}),
			...(userMessage ? { userMessage } : {}),
			...(title ? { title } : {}),
			stream,
			model,
			effort,
		},
	};
}
