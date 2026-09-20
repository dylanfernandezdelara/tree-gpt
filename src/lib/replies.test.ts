import { describe, expect, it } from "vitest";
import { clearInline, dropInlineFor, listableChats, markInline, replyKey } from "./replies";
import type { Chat } from "../types";

const chat = (id: string, parentChatId?: string): Chat => ({
	id,
	title: id,
	messages: [],
	createdAt: 0,
	updatedAt: 0,
	...(parentChatId
		? { origin: { parentChatId, kind: "thread" as const, parentMessageId: null } }
		: {}),
});

describe("replyKey", () => {
	it("separates the same message in two panes", () => {
		expect(replyKey("p1", "m1")).not.toBe(replyKey("p2", "m1"));
	});
});

describe("markInline / clearInline", () => {
	it("adds an id once, however often it is marked", () => {
		expect(markInline(markInline([], "a"), "a")).toEqual(["a"]);
	});

	it("drops an id when the reply is promoted", () => {
		expect(clearInline(["a", "b"], "a")).toEqual(["b"]);
	});

	it("leaves the set alone when the id is absent", () => {
		expect(clearInline(["a"], "zzz")).toEqual(["a"]);
	});

	it("does not mutate the input", () => {
		const ids = ["a"];
		markInline(ids, "b");
		clearInline(ids, "a");
		expect(ids).toEqual(["a"]);
	});
});

describe("dropInlineFor", () => {
	it("removes the deleted chat and the replies hanging off it", () => {
		const chats = [chat("parent"), chat("r1", "parent"), chat("r2", "other")];
		expect(dropInlineFor(["parent", "r1", "r2"], chats, "parent")).toEqual(["r2"]);
	});
});

describe("listableChats", () => {
	it("hides inline replies from the list", () => {
		expect(listableChats([chat("a"), chat("r1", "a")], ["r1"]).map((c) => c.id)).toEqual(["a"]);
	});

	it("returns everything when nothing is inline", () => {
		expect(listableChats([chat("a"), chat("b")], [])).toHaveLength(2);
	});
});
