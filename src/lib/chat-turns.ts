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
		.map((m) => ({ role: m.role, content: m.content }));
}
