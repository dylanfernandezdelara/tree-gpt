import type { Chat } from "../types";
import { deleteChat as deleteRemoteChat, upsertChat } from "./chatsApi";

export const SYNC_DEBOUNCE_MS = 500;

/**
 * Pushes changes to /api/chats. Compares each chat by reference against the
 * last version it sent, so any mutation shows up as an upsert and any missing
 * id as a delete. Upserts are debounced and serialized per chat.
 */
export class RemoteSync {
	private known: Map<string, Chat>;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private queues = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(initial: Chat[]) {
		this.known = new Map(initial.map((chat) => [chat.id, chat]));
	}

	reconcile(chats: Chat[]): void {
		if (this.disposed) {
			return;
		}
		const seen = new Set<string>();
		for (const chat of chats) {
			seen.add(chat.id);
			if (this.known.get(chat.id) !== chat) {
				this.known.set(chat.id, chat);
				this.scheduleUpsert(chat);
			}
		}
		for (const id of [...this.known.keys()]) {
			if (!seen.has(id)) {
				this.known.delete(id);
				this.cancelTimer(id);
				this.enqueue(id, async () => {
					if (!(await deleteRemoteChat(id))) {
						console.warn(`[Fork] Failed to delete chat ${id} on the server.`);
					}
				});
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const id of [...this.timers.keys()]) {
			this.cancelTimer(id);
		}
	}

	private scheduleUpsert(chat: Chat): void {
		this.cancelTimer(chat.id);
		const timer = globalThis.setTimeout(() => {
			this.timers.delete(chat.id);
			const latest = this.known.get(chat.id);
			if (!latest) {
				return;
			}
			this.enqueue(chat.id, async () => {
				if (!(await upsertChat(latest))) {
					console.warn(`[Fork] Failed to save chat ${chat.id} on the server.`);
				}
			});
		}, SYNC_DEBOUNCE_MS);
		this.timers.set(chat.id, timer);
	}

	private cancelTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer !== undefined) {
			globalThis.clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	private enqueue(id: string, task: () => Promise<void>): void {
		const previous = this.queues.get(id) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.queues.set(id, next);
	}
}
