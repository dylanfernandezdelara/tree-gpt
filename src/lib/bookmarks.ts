import { createPane, listPanes, setPaneChat, type LayoutNode } from "./layout";
import type { Bookmark } from "../types";

/** Newest first. A passage already saved from the same message is ignored. */
export function addBookmark(list: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
	const duplicate = list.some(
		(existing) =>
			existing.chatId === bookmark.chatId &&
			existing.messageId === bookmark.messageId &&
			existing.quote === bookmark.quote,
	);
	return duplicate ? [...list] : [bookmark, ...list];
}

export function removeBookmark(list: readonly Bookmark[], id: string): Bookmark[] {
	return list.filter((bookmark) => bookmark.id !== id);
}

/** Bookmarks cannot outlive the conversation they point into. */
export function dropBookmarksForChat(list: readonly Bookmark[], chatId: string): Bookmark[] {
	return list.filter((bookmark) => bookmark.chatId !== chatId);
}

/**
 * Show a chat on the bookmarks screen, which holds ONE window: open the first
 * one, reuse the window already showing that chat, else take the window over.
 * Never splits, so the reading list always faces a single conversation.
 */
export function openBookmarkPane(
	root: LayoutNode | null,
	focusedPaneId: string | null,
	chatId: string,
): { root: LayoutNode; paneId: string } {
	if (!root) {
		const pane = createPane(chatId);
		return { root: pane, paneId: pane.id };
	}
	const panes = listPanes(root);
	const showing = panes.find((pane) => pane.chatId === chatId);
	if (showing) {
		return { root, paneId: showing.id };
	}
	const target = panes.find((pane) => pane.id === focusedPaneId) ?? panes[panes.length - 1];
	return { root: setPaneChat(root, target.id, chatId), paneId: target.id };
}
