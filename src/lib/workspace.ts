import type { Bookmark, Chat } from "../types";
import type { LayoutNode } from "./layout";

/**
 * The chats currently on screen. `ns` identifies whose they are ("user:<id>");
 * `kind` says where they persist. A store is loaded whenever the signed-in
 * user changes, so chats from one namespace never leak into another.
 * `layout` is the split-pane tree and `focusedPaneId` the pane that sidebar
 * actions target.
 */
export type Store = {
	ns: string;
	kind: "local" | "remote";
	chats: Chat[];
	/** Which workspace is on screen. Both keep their own windows. */
	view: "chats" | "bookmarks";
	layout: LayoutNode;
	focusedPaneId: string;
	bookmarks: Bookmark[];
	/** Bookmarks screen: at most two windows, stacked. Null until one opens. */
	bookmarkLayout: LayoutNode | null;
	bookmarkFocusedPaneId: string | null;
};

/** The windows of whichever workspace is showing. */
export function layoutOf(store: Store): LayoutNode | null {
	return store.view === "chats" ? store.layout : store.bookmarkLayout;
}

export function focusedOf(store: Store): string | null {
	return store.view === "chats" ? store.focusedPaneId : store.bookmarkFocusedPaneId;
}

export function withLayout(store: Store, root: LayoutNode, focusedPaneId?: string): Store {
	return store.view === "chats"
		? { ...store, layout: root, focusedPaneId: focusedPaneId ?? store.focusedPaneId }
		: {
				...store,
				bookmarkLayout: root,
				bookmarkFocusedPaneId: focusedPaneId ?? store.bookmarkFocusedPaneId,
			};
}
