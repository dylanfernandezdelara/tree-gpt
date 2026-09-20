import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import {
	copyMessages,
	lastPersistedId,
	newExchange,
	quoteTurn,
	toReplyTurns,
	toTurns,
} from "./chat-turns";

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
});

describe("reply turns", () => {
	const carried = [
		message({ id: "m1", role: "user", content: "Question 1" }),
		message({ id: "m2", role: "assistant", content: "Answer 1 mentions obstreperous." }),
	];
	const excerpt = message({ id: "m3", role: "assistant", content: "obstreperous" });
	const asked = [
		message({ id: "m4", role: "user", content: "what does this word mean?" }),
		message({ id: "m5", role: "assistant", content: "Noisy and unruly." }),
	];

	it("attributes the passage to the user rather than the model", () => {
		expect(quoteTurn("obstreperous")).toEqual({
			role: "user",
			content: "Quoting from your last message:\n\n> obstreperous",
		});
	});

	it("keeps a multi-line passage inside the quote block", () => {
		expect(quoteTurn("first\nsecond").content).toBe(
			"Quoting from your last message:\n\n> first\n> second",
		);
	});

	it("rewrites the excerpt however many turns the reply has run for", () => {
		const turns = toReplyTurns(
			[...carried, excerpt, ...asked, message({ id: "m6", role: "user", content: "and then?" })],
			"obstreperous",
		);
		expect(turns.map((turn) => turn.role)).toEqual([
			"user",
			"assistant",
			"user",
			"user",
			"assistant",
			"user",
		]);
		expect(turns[2]).toEqual(quoteTurn("obstreperous"));
		// Everything around it is untouched.
		expect(turns[3]).toEqual({ role: "user", content: "what does this word mean?" });
	});

	it("leaves a reply that never had a passage alone", () => {
		const messages = [...carried, ...asked];
		expect(toReplyTurns(messages, undefined)).toEqual(toTurns(messages));
	});

	it("leaves an ordinary fork alone, whatever its origin quoted", () => {
		// No excerpt was inserted, so no two assistant turns sit together and
		// the answer the passage came from must survive as the model's own.
		const messages = [...carried, ...asked];
		expect(toReplyTurns(messages, "Answer 1 mentions obstreperous.")).toEqual(toTurns(messages));
	});

	it("skips a pending reply rather than reading it as the excerpt", () => {
		const messages = [
			...carried,
			message({ id: "m9", role: "assistant", content: "", pending: true }),
			excerpt,
			...asked,
		];
		expect(toReplyTurns(messages, "obstreperous")[2]).toEqual(quoteTurn("obstreperous"));
	});
});
