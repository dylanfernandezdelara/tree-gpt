import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types";
import { RemoteSync, SYNC_DEBOUNCE_MS } from "./remote-sync";

const { upsertChat, deleteChat } = vi.hoisted(() => ({
	upsertChat: vi.fn<(chat: Chat) => Promise<boolean>>(),
	deleteChat: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock("./chatsApi", () => ({
	upsertChat,
	deleteChat,
}));

function chat(id: string, title = id): Chat {
	return { id, title, messages: [], createdAt: 1, updatedAt: 1 };
}

describe("RemoteSync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		upsertChat.mockReset().mockResolvedValue(true);
		deleteChat.mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not write the chats it was constructed with", async () => {
		const initial = chat("a");
		const sync = new RemoteSync([initial]);
		sync.reconcile([initial]);
		await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
		expect(upsertChat).not.toHaveBeenCalled();
		expect(deleteChat).not.toHaveBeenCalled();
		sync.dispose();
	});

	it("debounces an upsert and sends the latest object", async () => {
		const sync = new RemoteSync([]);
		const first = chat("a", "one");
		const second = chat("a", "two");
		sync.reconcile([first]);
		sync.reconcile([second]);
		expect(upsertChat).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
		expect(upsertChat).toHaveBeenCalledOnce();
		expect(upsertChat).toHaveBeenCalledWith(second);
		sync.dispose();
	});

	it("deletes an id that disappeared", async () => {
		const gone = chat("gone");
		const sync = new RemoteSync([gone]);
		sync.reconcile([]);
		await Promise.resolve();
		expect(deleteChat).toHaveBeenCalledWith("gone");
		expect(upsertChat).not.toHaveBeenCalled();
		sync.dispose();
	});

	it("drops pending upserts on dispose and ignores later reconciles", async () => {
		const sync = new RemoteSync([]);
		sync.reconcile([chat("a")]);
		sync.dispose();
		sync.reconcile([chat("b")]);
		await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
		expect(upsertChat).not.toHaveBeenCalled();
		expect(deleteChat).not.toHaveBeenCalled();
	});
});
