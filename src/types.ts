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

export type Chat = {
	id: string;
	title: string;
	messages: Message[];
	createdAt: number;
	updatedAt: number;
};

export type PersistedState = {
	chats: Chat[];
	activeChatId: string | null;
	sidebarOpen: boolean;
};
