import type { Chat, Message } from "../types";
import { createPane, listPanes, validateLayout, type LayoutNode } from "./layout";

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

type StoredLayout = { root: unknown; focusedPaneId: string };

type UiState = {
	sidebarOpen: boolean;
	/** Pre-split-screen layout: the one open chat per namespace. Read for migration only. */
	activeChatId: Record<string, string | null>;
	layout: Record<string, StoredLayout>;
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
	const layout: Record<string, StoredLayout> = {};
	if (typeof record.layout === "object" && record.layout !== null) {
		for (const [ns, saved] of Object.entries(record.layout as Record<string, unknown>)) {
			if (typeof saved === "object" && saved !== null && "root" in saved) {
				const focused = (saved as Record<string, unknown>).focusedPaneId;
				layout[ns] = { root: saved.root, focusedPaneId: typeof focused === "string" ? focused : "" };
			}
		}
	}
	return {
		sidebarOpen: typeof record.sidebarOpen === "boolean" ? record.sidebarOpen : true,
		activeChatId: active,
		layout,
	};
}

export function loadSidebarOpen(): boolean {
	return loadUi().sidebarOpen;
}

export function saveSidebarOpen(open: boolean): void {
	writeJson(UI_KEY, { ...loadUi(), sidebarOpen: open });
}

/**
 * The pane layout for a namespace. Falls back to a single pane holding the
 * chat that was open before split screens existed, or an empty pane.
 */
export function loadLayout(
	namespace: string,
	chatIds: ReadonlySet<string>,
): { root: LayoutNode; focusedPaneId: string } {
	const ui = loadUi();
	const saved = ui.layout[namespace];
	let root = saved ? validateLayout(saved.root, chatIds) : null;
	if (!root) {
		const legacy = ui.activeChatId[namespace];
		root = createPane(legacy && chatIds.has(legacy) ? legacy : null);
	}
	const panes = listPanes(root);
	const focusedPaneId =
		saved && panes.some((pane) => pane.id === saved.focusedPaneId)
			? saved.focusedPaneId
			: panes[0].id;
	return { root, focusedPaneId };
}

export function saveLayout(namespace: string, root: LayoutNode, focusedPaneId: string): void {
	const ui = loadUi();
	writeJson(UI_KEY, { ...ui, layout: { ...ui.layout, [namespace]: { root, focusedPaneId } } });
}

export function loadLocalChats(namespace: string): Chat[] {
	const parsed = readJson(chatsKey(namespace));
	return Array.isArray(parsed) ? parsed.filter(isChat).map(dropTransient) : [];
}

export function saveLocalChats(namespace: string, chats: Chat[]): void {
	writeJson(chatsKey(namespace), chats.map(dropTransient));
}

export { newId } from "./id";

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
	// Legacy stored messages may carry a reasoningDetails blob; it is ignored
	// (and stripped by dropTransient) rather than rejected.
	return (
		typeof m.id === "string" &&
		(m.role === "user" || m.role === "assistant") &&
		typeof m.content === "string" &&
		typeof m.createdAt === "number"
	);
}

export function persistableFields(message: Message): Pick<
	Message,
	"role" | "content" | "createdAt" | "reasoning"
> {
	const reasoning =
		message.role === "assistant" && message.reasoning ? message.reasoning : undefined;
	return {
		role: message.role,
		content: message.content,
		createdAt: message.createdAt,
		...(reasoning ? { reasoning } : {}),
	};
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
			.map((m) => ({ id: m.id, ...persistableFields(m) })),
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
