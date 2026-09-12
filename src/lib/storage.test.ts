import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types";
import {
	dropTransient,
	isChat,
	isMessage,
	loadLocalChats,
	loadModelEffort,
	loadModelEfforts,
	loadSelectedModel,
	loadSidebarOpen,
	loadSidebarOpenPreference,
	persistableFields,
	resolveSidebarOpen,
	saveModelEffort,
	saveSelectedModel,
	saveSidebarOpen,
	SIDEBAR_PREF_REV,
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
			citations: [],
			toolCalls: [],
		});
		expect(persistableFields(thinkingMessage as never)).toEqual({
			role: "assistant",
			content: "hi",
			createdAt: 3,
			reasoning: "Considering the question.",
			citations: [],
			toolCalls: [],
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

	it("keeps display-only search metadata on assistant messages", () => {
		expect(
			persistableFields({
				id: "m",
				role: "assistant",
				content: "Alcaraz",
				createdAt: 1,
				citations: [{ url: "https://www.example.com/us-open", title: "US Open" }],
				toolCalls: [{ id: "web_search", name: "web_search", state: "output-available" }],
			}),
		).toEqual({
			role: "assistant",
			content: "Alcaraz",
			createdAt: 1,
			citations: [{ url: "https://www.example.com/us-open", title: "US Open" }],
			toolCalls: [{ id: "web_search", name: "web_search", state: "output-available" }],
		});
	});
});

describe("loadLocalChats", () => {
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

	it("repairs smashed assistant prose from guest storage", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({
				"treegpt.chats.guest.v1": JSON.stringify([
					{
						id: "c1",
						title: "games",
						createdAt: 1,
						updatedAt: 2,
						messages: [
							{ id: "m1", role: "user", content: "projections", createdAt: 1 },
							{
								id: "m2",
								role: "assistant",
								content: "tonight's games.\nTomorrow's opener is set.",
								createdAt: 2,
							},
						],
					},
				]),
			}),
		);
		expect(loadLocalChats("guest")[0]?.messages[1]?.content).toBe(
			"tonight's games. Tomorrow's opener is set.",
		);
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

	it("defaults the sidebar to open on desktop when nothing is stored", () => {
		expect(loadSidebarOpenPreference()).toBe(null);
		expect(loadSidebarOpen()).toBe(true);
		expect(loadSidebarOpen(false)).toBe(true);
	});

	it("defaults the sidebar to closed on mobile when nothing is stored", () => {
		expect(loadSidebarOpen(true)).toBe(false);
	});

	it("round-trips each allowlisted model", () => {
		for (const model of ["meta/muse-spark-1.3-contributor", "openai/gpt-5.6-luna"] as const) {
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

describe("sidebar preference", () => {
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

	it("treats a legacy auto-saved closed sidebar as unset", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({ "treegpt.ui.v1": JSON.stringify({ sidebarOpen: false }) }),
		);
		expect(loadSidebarOpenPreference()).toBe(null);
		expect(loadSidebarOpen()).toBe(true);
		expect(loadSidebarOpen(true)).toBe(false);
	});

	it("ignores a stored boolean that lacks the user-toggle revision", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({ "treegpt.ui.v1": JSON.stringify({ sidebarOpen: true }) }),
		);
		expect(loadSidebarOpenPreference()).toBe(null);
		expect(loadSidebarOpen()).toBe(true);
	});

	it("persists an explicit collapse across later loads", () => {
		saveSidebarOpen(false);
		expect(loadSidebarOpenPreference()).toBe(false);
		expect(loadSidebarOpen()).toBe(false);
		expect(loadSidebarOpen(true)).toBe(false);
	});

	it("persists an explicit expand across later loads", () => {
		saveSidebarOpen(false);
		saveSidebarOpen(true);
		expect(loadSidebarOpenPreference()).toBe(true);
		expect(loadSidebarOpen()).toBe(true);
		expect(loadSidebarOpen(true)).toBe(true);
	});

	it("keeps a collapsed preference when other UI state is written", () => {
		saveSidebarOpen(false);
		saveSelectedModel("openai/gpt-5.6-luna");
		expect(JSON.parse(localStorage.getItem("treegpt.ui.v1") ?? "{}")).toMatchObject({
			sidebarOpen: false,
			sidebarPrefRev: SIDEBAR_PREF_REV,
		});
		expect(loadSidebarOpen()).toBe(false);
	});

	it("resolves viewport defaults only when the user has never toggled", () => {
		expect(resolveSidebarOpen(null, false)).toBe(true);
		expect(resolveSidebarOpen(null, true)).toBe(false);
		expect(resolveSidebarOpen(false, false)).toBe(false);
		expect(resolveSidebarOpen(false, true)).toBe(false);
		expect(resolveSidebarOpen(true, false)).toBe(true);
		expect(resolveSidebarOpen(true, true)).toBe(true);
	});
});

describe("effort preference", () => {
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

	it("defaults each model to its own effort", () => {
		expect(loadModelEfforts()).toEqual({
			"meta/muse-spark-1.3-contributor": "minimal",
			"openai/gpt-5.6-luna": "none",
		});
	});

	it("round-trips per-model efforts independently", () => {
		saveModelEffort("meta/muse-spark-1.3-contributor", "high");
		saveModelEffort("openai/gpt-5.6-luna", "low");
		expect(loadModelEffort("meta/muse-spark-1.3-contributor")).toBe("high");
		expect(loadModelEffort("openai/gpt-5.6-luna")).toBe("low");
	});

	it("falls back to the model default for unknown or unsupported values", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({
				"treegpt.ui.v1": JSON.stringify({
					effort: {
						"meta/muse-spark-1.3-contributor": "none",
						"openai/gpt-5.6-luna": "ultra",
					},
				}),
			}),
		);
		expect(loadModelEffort("meta/muse-spark-1.3-contributor")).toBe("minimal");
		expect(loadModelEffort("openai/gpt-5.6-luna")).toBe("none");
	});
});
