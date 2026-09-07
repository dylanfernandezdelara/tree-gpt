import { describe, expect, it } from "vitest";
import type { Chat, Message } from "../types";
import { orderMessages } from "./storage";

function chat(messages: Message[]): Chat {
	return { id: "c", title: "c", createdAt: 0, updatedAt: 0, messages };
}

const msg = (id: string, role: Message["role"], createdAt: number): Message => ({
	id,
	role,
	content: id,
	createdAt,
});

describe("orderMessages", () => {
	it("puts the question above the reply when they share a timestamp", () => {
		// What the Worker can hand back: same created_at, tie broken on message id.
		const out = orderMessages(chat([msg("a", "assistant", 100), msg("u", "user", 100)]));
		expect(out.messages.map((m) => m.id)).toEqual(["u", "a"]);
	});

	it("orders by timestamp first", () => {
		const out = orderMessages(
			chat([msg("u2", "user", 200), msg("a1", "assistant", 101), msg("u1", "user", 100)]),
		);
		expect(out.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
	});

	it("keeps same-role messages in the order given", () => {
		const out = orderMessages(chat([msg("first", "user", 50), msg("second", "user", 50)]));
		expect(out.messages.map((m) => m.id)).toEqual(["first", "second"]);
	});

	it("returns the same object when nothing moves", () => {
		const input = chat([msg("u", "user", 1), msg("a", "assistant", 2)]);
		expect(orderMessages(input)).toBe(input);
	});

	it("leaves a long conversation with distinct timestamps untouched", () => {
		const messages = Array.from({ length: 8 }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", i),
		);
		const out = orderMessages(chat(messages));
		expect(out.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
	});
});
