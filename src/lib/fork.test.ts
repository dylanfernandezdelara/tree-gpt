import { describe, expect, it } from "vitest";
import { messagesUpTo } from "./fork";

const msg = (id: string) => ({ id });
const convo = [msg("q1"), msg("a1"), msg("q2"), msg("a2"), msg("q3"), msg("a3")];

describe("messagesUpTo", () => {
	it("keeps the anchored message and drops everything after it", () => {
		expect(messagesUpTo(convo, "a1").map((m) => m.id)).toEqual(["q1", "a1"]);
	});

	it("keeps everything when the anchor is the last message", () => {
		expect(messagesUpTo(convo, "a3")).toHaveLength(convo.length);
	});

	it("keeps just the first message when that is the anchor", () => {
		expect(messagesUpTo(convo, "q1").map((m) => m.id)).toEqual(["q1"]);
	});

	it("keeps everything for a plain branch, which has no anchor", () => {
		expect(messagesUpTo(convo, null)).toHaveLength(convo.length);
	});

	it("keeps everything when the anchor has since disappeared", () => {
		// Regenerating a reply replaces its id; losing the conversation would be
		// far worse than carrying a few turns too many.
		expect(messagesUpTo(convo, "gone")).toHaveLength(convo.length);
	});

	it("does not mutate or alias the input", () => {
		const result = messagesUpTo(convo, null);
		expect(result).not.toBe(convo);
		expect(convo).toHaveLength(6);
	});

	it("handles an empty conversation", () => {
		expect(messagesUpTo([], "a1")).toEqual([]);
	});
});
