import type { Chat } from "../types";

/**
 * Chats arranged by fork lineage. A chat hangs under the chat it was forked
 * from; anything whose parent is missing (never forked, or the parent was
 * deleted) becomes a root, so no chat can be hidden by a broken link.
 */
export type ChatNode = { chat: Chat; children: ChatNode[] };

/**
 * The parent a chat should hang under, or null for a root. Rejects a parent
 * that is missing, is the chat itself, or sits in a cycle, so corrupt lineage
 * degrades to a flat list instead of looping forever.
 */
function resolveParentId(chat: Chat, byId: ReadonlyMap<string, Chat>): string | null {
	const parentId = chat.origin?.parentChatId;
	if (!parentId || parentId === chat.id || !byId.has(parentId)) {
		return null;
	}
	const seen = new Set<string>([chat.id]);
	let current = byId.get(parentId);
	while (current) {
		if (seen.has(current.id)) {
			return null;
		}
		seen.add(current.id);
		const next = current.origin?.parentChatId;
		current = next ? byId.get(next) : undefined;
	}
	return parentId;
}

/** Siblings keep the order they arrive in, which the caller sorts by recency. */
export function buildForest(chats: readonly Chat[]): ChatNode[] {
	const byId = new Map(chats.map((chat) => [chat.id, chat]));
	const nodes = new Map<string, ChatNode>(
		chats.map((chat) => [chat.id, { chat, children: [] }]),
	);
	const roots: ChatNode[] = [];
	for (const chat of chats) {
		const node = nodes.get(chat.id);
		if (!node) {
			continue;
		}
		const parentId = resolveParentId(chat, byId);
		const parent = parentId ? nodes.get(parentId) : undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

/** Every chat between this one and its root, nearest first. */
export function ancestorIds(chats: readonly Chat[], chatId: string): string[] {
	const byId = new Map(chats.map((chat) => [chat.id, chat]));
	const out: string[] = [];
	const seen = new Set<string>([chatId]);
	let current = byId.get(chatId);
	while (current) {
		const parentId = resolveParentId(current, byId);
		if (!parentId || seen.has(parentId)) {
			break;
		}
		seen.add(parentId);
		out.push(parentId);
		current = byId.get(parentId);
	}
	return out;
}

/** Chats grouped by the chat they were forked from. */
export function childrenByParent(chats: readonly Chat[]): Map<string, Chat[]> {
	const byId = new Map(chats.map((chat) => [chat.id, chat]));
	const out = new Map<string, Chat[]>();
	for (const chat of chats) {
		const parentId = resolveParentId(chat, byId);
		if (!parentId) {
			continue;
		}
		const list = out.get(parentId);
		if (list) {
			list.push(chat);
		} else {
			out.set(parentId, [chat]);
		}
	}
	return out;
}
