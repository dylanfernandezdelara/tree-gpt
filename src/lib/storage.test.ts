import { describe, expect, it } from "vitest";
import type { Chat } from "../types";
import { dropTransient, isChat, isMessage, persistableFields } from "./storage";

const legacyBlobMessage = {
	id: "m2",
	role: "assistant",
	content: "hello",
	createdAt: 2,
	reasoningDetails: [{ type: "reasoning.text", text: "old thinking" }],
};

const thinkingMessage = {
	id: "m3",
	role: "assistant",
	content: "hi",
	createdAt: 3,
	reasoning: "Considering the question.",
};

describe("thinking-trace persistence", () => {
	it("accepts legacy blobs and display-only reasoning", () => {
		expect(isMessage(legacyBlobMessage)).toBe(true);
		expect(isMessage(thinkingMessage)).toBe(true);
		expect(
			isChat({
				id: "c",
				title: "t",
				messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1 }, thinkingMessage],
				createdAt: 1,
				updatedAt: 2,
			}),
		).toBe(true);
	});

	it("strips legacy blobs but keeps the display-only trace", () => {
		expect(persistableFields(legacyBlobMessage as never)).toEqual({
			role: "assistant",
			content: "hello",
			createdAt: 2,
		});
		expect(persistableFields(thinkingMessage as never)).toEqual({
			role: "assistant",
			content: "hi",
			createdAt: 3,
			reasoning: "Considering the question.",
		});
		// User messages never carry thinking, even if present.
		expect(
			persistableFields({ id: "m", role: "user", content: "x", createdAt: 1, reasoning: "y" }),
		).toEqual({ role: "user", content: "x", createdAt: 1 });
	});

	it("dropTransient keeps thinking for rendering", () => {
		const chat = dropTransient({
			id: "c",
			title: "t",
			messages: [
				{ id: "m1", role: "user", content: "hi", createdAt: 1 },
				legacyBlobMessage,
				thinkingMessage,
			],
			createdAt: 1,
			updatedAt: 2,
		} as unknown as Chat);
		expect(JSON.stringify(chat).includes("reasoningDetails")).toBe(false);
		expect(chat.messages).toHaveLength(3);
		expect(chat.messages[2]).toMatchObject({ reasoning: "Considering the question." });
	});
});
