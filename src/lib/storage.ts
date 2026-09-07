import type { Chat, Message } from "../types";

/**
 * Browser-side persistence.
 *
 * - `treegpt.ui.v1`: sidebar state and the last open chat per namespace.
 * - `treegpt.chats.<namespace>.v1`: chats kept on this device. Used for guests,
 *   and as a per-user fallback while the /api/chats backend is unavailable.
 *   Chats that live on the server are never written here.
 */

export const GUEST_NAMESPACE = "guest";

const UI_KEY = "treegpt.ui.v1";
const LEGACY_KEY = "treegpt.state.v1";
const TITLE_MAX = 40;

type UiState = {
	sidebarOpen: boolean;
	activeChatId: Record<string, string | null>;
};

function chatsKey(namespace: string): string {
	return `treegpt.chats.${namespace}.v1`;
}

function readJson(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as unknown) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be unavailable (private mode, quota). The app keeps working in memory.
	}
}

function loadUi(): UiState {
	const parsed = readJson(UI_KEY);
	const record =
		typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const active: Record<string, string | null> = {};
	if (typeof record.activeChatId === "object" && record.activeChatId !== null) {
		for (const [ns, id] of Object.entries(record.activeChatId as Record<string, unknown>)) {
			active[ns] = typeof id === "string" ? id : null;
		}
	}
	return {
		sidebarOpen: typeof record.sidebarOpen === "boolean" ? record.sidebarOpen : true,
		activeChatId: active,
	};
}

export function loadSidebarOpen(): boolean {
	return loadUi().sidebarOpen;
}

export function saveSidebarOpen(open: boolean): void {
	writeJson(UI_KEY, { ...loadUi(), sidebarOpen: open });
}

export function loadActiveChatId(namespace: string): string | null {
	return loadUi().activeChatId[namespace] ?? null;
}

export function saveActiveChatId(namespace: string, id: string | null): void {
	const ui = loadUi();
	writeJson(UI_KEY, { ...ui, activeChatId: { ...ui.activeChatId, [namespace]: id } });
}

export function loadLocalChats(namespace: string): Chat[] {
	const parsed = readJson(chatsKey(namespace));
	return Array.isArray(parsed) ? parsed.filter(isChat).map(dropTransient) : [];
}

export function saveLocalChats(namespace: string, chats: Chat[]): void {
	writeJson(chatsKey(namespace), chats.map(dropTransient));
}

export function newId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sidebar title for a chat, taken from its first user message. */
export function titleFromMessage(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) {
		return "New chat";
	}
	if (collapsed.length <= TITLE_MAX) {
		return collapsed;
	}
	const cut = collapsed.slice(0, TITLE_MAX);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace >= TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

export function isMessage(value: unknown): value is Message {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const m = value as Record<string, unknown>;
	return (
		typeof m.id === "string" &&
		(m.role === "user" || m.role === "assistant") &&
		typeof m.content === "string" &&
		typeof m.createdAt === "number"
	);
}

export function isChat(value: unknown): value is Chat {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const c = value as Record<string, unknown>;
	return (
		typeof c.id === "string" &&
		typeof c.title === "string" &&
		Array.isArray(c.messages) &&
		c.messages.every(isMessage) &&
		typeof c.createdAt === "number" &&
		typeof c.updatedAt === "number"
	);
}

/**
 * Persistable form of a chat: replies that are still loading or failed are
 * dropped, and each message carries only the fields in the API contract.
 */
export function dropTransient(chat: Chat): Chat {
	return {
		id: chat.id,
		title: chat.title,
		createdAt: chat.createdAt,
		updatedAt: chat.updatedAt,
		messages: chat.messages
			.filter((m) => !m.pending && !m.error)
			.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })),
	};
}

/** One-time move from the pre-namespace storage layout. */
function migrateLegacyState(): void {
	const legacy = readJson(LEGACY_KEY);
	if (typeof legacy !== "object" || legacy === null) {
		return;
	}
	const record = legacy as Record<string, unknown>;
	if (Array.isArray(record.chats)) {
		saveLocalChats(GUEST_NAMESPACE, record.chats.filter(isChat));
	}
	const ui = loadUi();
	writeJson(UI_KEY, {
		sidebarOpen: typeof record.sidebarOpen === "boolean" ? record.sidebarOpen : ui.sidebarOpen,
		activeChatId: {
			...ui.activeChatId,
			[GUEST_NAMESPACE]: typeof record.activeChatId === "string" ? record.activeChatId : null,
		},
	});
	try {
		localStorage.removeItem(LEGACY_KEY);
	} catch {
		// ignore
	}
}

migrateLegacyState();
