import type { ChatTurn } from "./api";
import { newId } from "./id";
import { persistableFields } from "./storage";
import type { Message } from "../types";

/** A user message plus the placeholder for its reply. */
export function newExchange(content: string): { now: number; userMessage: Message; reply: Message } {
	const now = Date.now();
	return {
		now,
		userMessage: { id: newId(), role: "user", content, createdAt: now },
		// Strictly later than the question: the Worker orders messages by
		// created_at and breaks ties on the random message id, so sharing a
		// timestamp lets the reply come back above the question.
		reply: { id: newId(), role: "assistant", content: "", createdAt: now + 1, pending: true },
	};
}

/**
 * Messages copied into a branched chat: finished turns only, with fresh ids
 * because message ids are unique across every chat on the backend.
 */
export function copyMessages(messages: Message[]): Message[] {
	return messages
		.filter((m) => !m.pending && !m.error)
		.map((m) => ({ id: newId(), ...persistableFields(m) }));
}

/** Last message that survives into a fork, for recording where it diverged. */
export function lastPersistedId(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message.pending && !message.error) {
			return message.id;
		}
	}
	return null;
}

/** Conversation turns to send upstream: finished messages only. */
export function toTurns(messages: Message[]): ChatTurn[] {
	return messages
		.filter((m) => !m.pending && !m.error)
		.map((m) => ({
			role: m.role,
			content: m.content,
		}));
}

/**
 * The passage a reply was started from, as a turn the model can attribute.
 *
 * The excerpt is DISPLAYED as the assistant text it was lifted from, but sent
 * that way it is just the model repeating a fragment of its own last answer --
 * nothing marks it as the thing being asked about, and "what does this word
 * mean?" comes back as "which word?". The user is the one pointing at it, so
 * on the wire it is a user turn, quoted, immediately before the question.
 */
export function quoteTurn(quote: string): ChatTurn {
	return {
		role: "user",
		content: `Quoting from your last message:\n\n> ${quote.replace(/\n/g, "\n> ")}`,
	};
}

/**
 * Turns for a chat that opened with a quoted excerpt.
 *
 * The excerpt is the one place a conversation holds two assistant turns in a
 * row: it was inserted straight after the answer it was lifted from, and every
 * other reply follows a question. That signature finds it without tracking an
 * index, so the attribution survives later sends, a reload, a regenerate, and
 * promotion to a full pane. A chat with no such pair is left alone.
 */
export function toReplyTurns(messages: Message[], quote?: string): ChatTurn[] {
	const turns = toTurns(messages);
	if (!quote) {
		return turns;
	}
	const at = turns.findIndex(
		(turn, index) =>
			index > 0 &&
			turn.role === "assistant" &&
			turns[index - 1]?.role === "assistant" &&
			turn.content === quote,
	);
	return at === -1 ? turns : turns.map((turn, index) => (index === at ? quoteTurn(quote) : turn));
}
