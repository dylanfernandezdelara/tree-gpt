import { describe, expect, it } from "vitest";
import type { Chat } from "../types";
import { dropTransient, isChat, isMessage, persistableFields } from "./storage";

const legacyAssistant = {
	id: "m2",
	role: "assistant",
	content: "hello",
	createdAt: 2,
	reasoningDetails: [{ type: "reasoning.text", text: "old thinking" }],
};

describe("reasoningDetails stripping", () => {
	it("accepts legacy messages carrying blobs", () => {
		expect(isMessage(legacyAssistant)).toBe(true);
		expect(
			isChat({
				id: "c",
				title: "t",
				messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1 }, legacyAssistant],
				createdAt: 1,
				updatedAt: 2,
			}),
		).toBe(true);
	});

	it("persistableFields and dropTransient strip the blob", () => {
		expect(persistableFields(legacyAssistant as never)).toEqual({
			role: "assistant",
			content: "hello",
			createdAt: 2,
		});

		const chat = dropTransient({
			id: "c",
			title: "t",
			messages: [
				{ id: "m1", role: "user", content: "hi", createdAt: 1 },
				legacyAssistant,
			],
			createdAt: 1,
			updatedAt: 2,
		} as unknown as Chat);
		expect(JSON.stringify(chat).includes("reasoningDetails")).toBe(false);
		expect(chat.messages).toHaveLength(2);
	});
});
