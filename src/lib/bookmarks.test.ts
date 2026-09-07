import { describe, expect, it } from "vitest";
import type { Bookmark } from "../types";
import { listPanes, type LayoutNode } from "./layout";
import { addBookmark, dropBookmarksForChat, openBookmarkPane, removeBookmark } from "./bookmarks";

const mark = (id: string, chatId = "c1", messageId = "m1", quote = "q"): Bookmark => ({
	id,
	chatId,
	messageId,
	quote,
	createdAt: 0,
});

describe("addBookmark", () => {
	it("puts the newest first", () => {
		const out = addBookmark([mark("old", "c1", "m1", "first")], mark("new", "c1", "m2", "second"));
		expect(out.map((b) => b.id)).toEqual(["new", "old"]);
	});

	it("ignores the same passage saved twice", () => {
		const first = mark("a", "c1", "m1", "same words");
		const again = mark("b", "c1", "m1", "same words");
		expect(addBookmark([first], again).map((b) => b.id)).toEqual(["a"]);
	});

	it("keeps the same words saved from a different message", () => {
		const first = mark("a", "c1", "m1", "same words");
		const other = mark("b", "c1", "m2", "same words");
		expect(addBookmark([first], other)).toHaveLength(2);
	});
});

describe("removeBookmark / dropBookmarksForChat", () => {
	it("removes one by id", () => {
		expect(removeBookmark([mark("a"), mark("b")], "a").map((b) => b.id)).toEqual(["b"]);
	});

	it("drops every bookmark of a deleted chat", () => {
		const list = [mark("a", "c1"), mark("b", "c2"), mark("c", "c1")];
		expect(dropBookmarksForChat(list, "c1").map((b) => b.id)).toEqual(["b"]);
	});
});

describe("openBookmarkPane", () => {
	it("creates the first window", () => {
		const { root, paneId } = openBookmarkPane(null, null, "c1");
		const panes = listPanes(root);
		expect(panes).toHaveLength(1);
		expect(panes[0].chatId).toBe("c1");
		expect(panes[0].id).toBe(paneId);
	});

	it("takes over the window instead of splitting", () => {
		const first = openBookmarkPane(null, null, "c1");
		const second = openBookmarkPane(first.root, first.paneId, "c2");
		const panes = listPanes(second.root);
		expect(panes).toHaveLength(1);
		expect(panes[0].chatId).toBe("c2");
		// The same window, so its draft and thread anchor follow the reader.
		expect(second.paneId).toBe(first.paneId);
	});

	it("leaves the window alone when it already shows that chat", () => {
		const first = openBookmarkPane(null, null, "c1");
		const again = openBookmarkPane(first.root, first.paneId, "c1");
		expect(again.root).toBe(first.root);
		expect(again.paneId).toBe(first.paneId);
	});

	it("never opens a second window however often it is called", () => {
		let state: { root: LayoutNode | null; paneId: string | null } = { root: null, paneId: null };
		for (const chatId of ["a", "b", "c", "d", "e"]) {
			state = openBookmarkPane(state.root, state.paneId, chatId);
		}
		expect(listPanes(state.root!)).toHaveLength(1);
		expect(listPanes(state.root!)[0].chatId).toBe("e");
	});
});
