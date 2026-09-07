export type Role = "user" | "assistant";

export type Message = {
	id: string;
	role: Role;
	content: string;
	createdAt: number;
	/**
	 * Display-only thinking trace, streamed live and never sent upstream.
	 * Assistant-only; absent on older messages.
	 */
	reasoning?: string;
	/** Assistant reply that has not arrived yet. */
	pending?: boolean;
	/** The request for this reply failed; `content` holds the error text. */
	error?: boolean;
};

/** How a chat came to exist, when it was forked from another one. */
export type ForkOrigin = {
	parentChatId: string;
	/** "branch": a duplicated pane was typed in. "thread": text was highlighted. */
	kind: "branch" | "thread";
	/**
	 * Message in the PARENT where the fork diverged. Copied messages are given
	 * fresh ids, so this always refers to the parent's id space.
	 */
	parentMessageId: string | null;
	/** "thread" only: the text the user highlighted. */
	quote?: string;
};

/** A passage the user saved out of a conversation. */
export type Bookmark = {
	id: string;
	chatId: string;
	messageId: string;
	/** Snapshot of the highlighted text, so a regenerated reply cannot change it. */
	quote: string;
	createdAt: number;
};

export type Chat = {
	id: string;
	title: string;
	messages: Message[];
	createdAt: number;
	updatedAt: number;
	/** Absent for a chat that was started from scratch. */
	origin?: ForkOrigin;
};
