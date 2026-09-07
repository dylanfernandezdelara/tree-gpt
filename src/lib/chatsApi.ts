import type { Chat } from "../types";
import { dropTransient, isChat } from "./storage";

/**
 * Server-side chat storage for signed-in users. See "API contract" in README.md.
 *
 *   GET    /api/chats      -> { chats: Chat[] }   the caller's chats, with messages
 *   PUT    /api/chats/:id  <- Chat               create or replace (client-generated id)
 *   DELETE /api/chats/:id  -> { ok: true }
 *
 * All calls rely on the Better Auth session cookie.
 */

/** The caller's chats, or null when the endpoint is unavailable (stub, 401, network). */
export async function listChats(signal: AbortSignal): Promise<Chat[] | null> {
	try {
		const response = await fetch("/api/chats", {
			headers: { Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			return null;
		}
		const data: unknown = await response.json();
		if (typeof data !== "object" || data === null || !("chats" in data)) {
			return null;
		}
		const chats = data.chats;
		return Array.isArray(chats) ? chats.filter(isChat) : null;
	} catch {
		return null;
	}
}

export async function upsertChat(chat: Chat): Promise<boolean> {
	try {
		const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(dropTransient(chat)),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function deleteChat(id: string): Promise<boolean> {
	try {
		const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		return response.ok;
	} catch {
		return false;
	}
}
