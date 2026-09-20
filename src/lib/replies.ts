import type { Chat } from "../types";

/**
 * Which forks are still shown inline, as reply popups inside the message they
 * hang from, rather than as panes of their own.
 *
 * A reply IS a fork -- same chat, same `origin`, same carried context -- so the
 * only difference is where it is drawn. Promoting one to a pane just drops its
 * id from this set, and the pane then shows the whole conversation like any
 * other fork.
 */
export function markInline(ids: readonly string[], chatId: string): string[] {
	return ids.includes(chatId) ? [...ids] : [...ids, chatId];
}

/** Promoting a reply to a pane, or discarding it. */
export function clearInline(ids: readonly string[], chatId: string): string[] {
	return ids.filter((id) => id !== chatId);
}

/** A deleted chat takes its inline replies with it. */
export function dropInlineFor(
	ids: readonly string[],
	chats: readonly Chat[],
	chatId: string,
): string[] {
	const gone = new Set(
		chats.filter((chat) => chat.origin?.parentChatId === chatId).map((chat) => chat.id),
	);
	gone.add(chatId);
	return ids.filter((id) => !gone.has(id));
}

/**
 * A popup belongs to a pane AND a message: the same chat can be open in two
 * panes, and each gets its own.
 */
export function replyKey(paneId: string, messageId: string): string {
	return `${paneId}:${messageId}`;
}

/**
 * The chats the sidebar and the fork tree should list. Inline replies are
 * hidden until promoted, so a one-word lookup does not land in the chat list.
 * Lookups by id must still resolve them, so only this list is filtered.
 */
export function listableChats(chats: readonly Chat[], inline: readonly string[]): Chat[] {
	if (inline.length === 0) {
		return [...chats];
	}
	const hidden = new Set(inline);
	return chats.filter((chat) => !hidden.has(chat.id));
}
