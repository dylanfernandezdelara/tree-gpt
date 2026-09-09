import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { copyMessages, lastPersistedId, newExchange, toTurns } from "./chat-turns";

function message(partial: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message {
	return { createdAt: 1, ...partial };
}

describe("newExchange", () => {
	it("stamps the reply one millisecond after the question", () => {
		const { now, userMessage, reply } = newExchange("hello");
		expect(userMessage).toMatchObject({ role: "user", content: "hello", createdAt: now });
		expect(reply).toMatchObject({
			role: "assistant",
			content: "",
			createdAt: now + 1,
			pending: true,
		});
		expect(reply.id).not.toBe(userMessage.id);
	});
});

describe("copyMessages / lastPersistedId / toTurns", () => {
	const finished = message({ id: "m1", role: "user", content: "q" });
	const thinking = message({
		id: "m2",
		role: "assistant",
		content: "a",
		reasoning: "think",
		citations: [],
		toolCalls: [],
	});
	const pending = message({ id: "m3", role: "assistant", content: "", pending: true });
	const failed = message({ id: "m4", role: "assistant", content: "no", error: true });

	it("copies finished turns with fresh ids and persistable fields only", () => {
		const copied = copyMessages([finished, thinking, pending, failed]);
		expect(copied).toHaveLength(2);
		expect(copied[0].id).not.toBe("m1");
		expect(copied[1]).toMatchObject({
			role: "assistant",
			content: "a",
			reasoning: "think",
			citations: [],
			toolCalls: [],
		});
		expect(copied[1]).not.toHaveProperty("pending");
		expect(copied[1].id).not.toBe("m2");
	});

	it("records the last finished message as the fork point", () => {
		expect(lastPersistedId([finished, thinking, pending])).toBe("m2");
		expect(lastPersistedId([pending, failed])).toBeNull();
	});

	it("sends only finished role+content upstream", () => {
		expect(toTurns([finished, thinking, pending, failed])).toEqual([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
		]);
	});

	it("repairs smashed assistant sentences before they go back upstream", () => {
		const smashed = message({
			id: "m5",
			role: "assistant",
			content: "tonight's games.\nTomorrow's opener is set.",
		});
		expect(toTurns([finished, smashed])).toEqual([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "tonight's games. Tomorrow's opener is set." },
		]);
	});
});
