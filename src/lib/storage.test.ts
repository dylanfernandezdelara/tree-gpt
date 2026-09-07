import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types";
import {
	dropTransient,
	isChat,
	isMessage,
	loadSelectedModel,
	loadSidebarOpen,
	persistableFields,
	saveSelectedModel,
	saveSidebarOpen,
} from "./storage";

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

describe("model preference", () => {
	function memoryStorage(initial: Record<string, string> = {}) {
		const store = new Map(Object.entries(initial));
		return {
			getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
		};
	}

	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.stubGlobal("localStorage", memoryStorage());
	});

	it("defaults to Muse Spark when nothing is stored", () => {
		expect(loadSelectedModel()).toBe("meta/muse-spark-1.3-contributor");
	});

	it("round-trips each allowlisted model", () => {
		for (const model of [
			"meta/muse-spark-1.3-contributor",
			"openai/gpt-5.6-luna",
			"qwen/qwen3.7-flash",
		] as const) {
			saveSelectedModel(model);
			expect(loadSelectedModel()).toBe(model);
		}
	});

	it("falls back to Muse Spark for unknown or malformed values", () => {
		vi.stubGlobal("localStorage", memoryStorage({ "treegpt.ui.v1": JSON.stringify({ model: "openai/gpt-4o" }) }));
		expect(loadSelectedModel()).toBe("meta/muse-spark-1.3-contributor");

		vi.stubGlobal("localStorage", memoryStorage({ "treegpt.ui.v1": JSON.stringify({ model: 42 }) }));
		expect(loadSelectedModel()).toBe("meta/muse-spark-1.3-contributor");

		vi.stubGlobal("localStorage", memoryStorage({ "treegpt.ui.v1": "not json" }));
		expect(loadSelectedModel()).toBe("meta/muse-spark-1.3-contributor");
	});

	it("preserves the rest of the UI state when saving the model", () => {
		saveSidebarOpen(false);
		saveSelectedModel("openai/gpt-5.6-luna");
		expect(loadSidebarOpen()).toBe(false);
		expect(loadSelectedModel()).toBe("openai/gpt-5.6-luna");
	});
});
