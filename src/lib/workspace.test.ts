import { describe, expect, it } from "vitest";
import { createPane } from "./layout";
import { focusedOf, layoutOf, withLayout, type Store } from "./workspace";

function store(view: Store["view"]): Store {
	const chats = createPane("c1");
	const bookmarks = createPane("c2");
	return {
		ns: "user:1",
		kind: "remote",
		chats: [],
		view,
		layout: chats,
		focusedPaneId: chats.id,
		bookmarks: [],
		bookmarkLayout: bookmarks,
		bookmarkFocusedPaneId: bookmarks.id,
	};
}

describe("workspace layout", () => {
	it("reads the conversation windows while that workspace is showing", () => {
		const chats = store("chats");
		expect(layoutOf(chats)).toBe(chats.layout);
		expect(focusedOf(chats)).toBe(chats.focusedPaneId);
	});

	it("reads the bookmarks windows while that workspace is showing", () => {
		const bookmarks = store("bookmarks");
		expect(layoutOf(bookmarks)).toBe(bookmarks.bookmarkLayout);
		expect(focusedOf(bookmarks)).toBe(bookmarks.bookmarkFocusedPaneId);
	});

	it("writes layout only on the workspace that is showing", () => {
		const next = createPane("c3");
		const chats = withLayout(store("chats"), next, next.id);
		expect(chats.layout).toBe(next);
		expect(chats.focusedPaneId).toBe(next.id);
		expect(chats.bookmarkLayout?.kind).toBe("pane");
		expect(chats.bookmarkLayout).not.toBe(next);

		const marks = withLayout(store("bookmarks"), next, next.id);
		expect(marks.bookmarkLayout).toBe(next);
		expect(marks.bookmarkFocusedPaneId).toBe(next.id);
		expect(marks.layout).not.toBe(next);
	});

	it("keeps the current focus when a layout write omits it", () => {
		const chats = store("chats");
		const next = createPane("c3");
		expect(withLayout(chats, next).focusedPaneId).toBe(chats.focusedPaneId);
	});
});
