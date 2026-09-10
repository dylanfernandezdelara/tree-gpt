import {
	CHAT_MODELS,
	DEFAULT_EFFORT,
	DEFAULT_MODEL,
	MODEL_EFFORTS,
	isEffortId,
	isModelId,
	type EffortId,
	type ModelId,
} from "../../worker/tree-types";
import type { Bookmark, Chat, ForkOrigin, Message } from "../types";
import { createPane, listPanes, validateLayout, type LayoutNode } from "./layout";

/**
 * Browser-side persistence.
 *
 * - `treegpt.ui.v1`: sidebar state, pane layout, and fork-tree state per namespace.
 * - `treegpt.chats.<namespace>.v1`: chats kept on this device. Used for guests,
 *   and as a per-user fallback while the /api/chats backend is unavailable.
 *   Chats that live on the server are never written here.
 * - `treegpt.bookmarks.<namespace>.v1`: saved passages. The Worker has no
 *   bookmarks table yet, so these live only on this device.
 * - `treegpt.lineage.<namespace>.v1`: fork lineage mirrored locally. The Worker
 *   does not store `origin` yet, so chats loaded from the server come back
 *   without it; this keeps the fork tree and fork links working until it does.
 */

export const GUEST_NAMESPACE = "guest";

const UI_KEY = "treegpt.ui.v1";
const LEGACY_KEY = "treegpt.state.v1";
const TITLE_MAX = 40;
const DEFAULT_BOOKMARKS_WIDTH = 440;

type StoredLayout = { root: unknown; focusedPaneId: string };

/** How the sidebar lists chats: the fork tree, or one flat recent-first list. */
export type SidebarView = "tree" | "flat";
export type SidebarTree = { view: SidebarView; expanded: string[] };

type UiState = {
	sidebarOpen: boolean;
	/** Pre-split-screen layout: the one open chat per namespace. Read for migration only. */
	activeChatId: Record<string, string | null>;
	layout: Record<string, StoredLayout>;
	/** Global model preference. Unknown or missing values read as DEFAULT_MODEL. */
	model: ModelId;
	sidebarTree: Record<string, SidebarTree>;
	/** Width of the bookmarks list, in px. */
	bookmarksWidth: number;
	/** Reasoning effort per model. Unknown or unsupported values read as that model's default. */
	effort: Record<ModelId, EffortId>;
};

function chatsKey(namespace: string): string {
	return `treegpt.chats.${namespace}.v1`;
}

function lineageKey(namespace: string): string {
	return `treegpt.lineage.${namespace}.v1`;
}

function bookmarksKey(namespace: string): string {
	return `treegpt.bookmarks.${namespace}.v1`;
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
	const sidebarTree: Record<string, SidebarTree> = {};
	if (typeof record.sidebarTree === "object" && record.sidebarTree !== null) {
		for (const [ns, saved] of Object.entries(record.sidebarTree as Record<string, unknown>)) {
			if (typeof saved !== "object" || saved === null) {
				continue;
			}
			const entry = saved as Record<string, unknown>;
			sidebarTree[ns] = {
				view: entry.view === "flat" ? "flat" : "tree",
				expanded: Array.isArray(entry.expanded)
					? entry.expanded.filter((id): id is string => typeof id === "string")
					: [],
			};
		}
	}
	const storedEffort =
		typeof record.effort === "object" && record.effort !== null
			? (record.effort as Record<string, unknown>)
			: {};
	const effort = Object.fromEntries(
		CHAT_MODELS.map((model) => {
			const stored = storedEffort[model.id];
			return [
				model.id,
				isEffortId(stored) && MODEL_EFFORTS[model.id].includes(stored)
					? stored
					: DEFAULT_EFFORT[model.id],
			];
		}),
	) as Record<ModelId, EffortId>;
	return {
		sidebarOpen: typeof record.sidebarOpen === "boolean" ? record.sidebarOpen : false,
		activeChatId: active,
		layout,
		model: isModelId(record.model) ? record.model : DEFAULT_MODEL,
		sidebarTree,
		bookmarksWidth:
			typeof record.bookmarksWidth === "number" && record.bookmarksWidth > 0
				? record.bookmarksWidth
				: DEFAULT_BOOKMARKS_WIDTH,
		effort,
	};
}

export function loadBookmarksWidth(): number {
	return loadUi().bookmarksWidth;
}

export function saveBookmarksWidth(width: number): void {
	writeJson(UI_KEY, { ...loadUi(), bookmarksWidth: Math.round(width) });
}

/** Saved passages for a namespace, newest first. */
export function loadBookmarks(namespace: string): Bookmark[] {
	const parsed = readJson(bookmarksKey(namespace));
	if (!Array.isArray(parsed)) {
		return [];
	}
	const out: Bookmark[] = [];
	for (const value of parsed) {
		const bookmark = parseBookmark(value);
		if (bookmark) {
			out.push(bookmark);
		}
	}
	return out;
}

export function saveBookmarks(namespace: string, bookmarks: readonly Bookmark[]): void {
	writeJson(bookmarksKey(namespace), bookmarks);
}

function parseBookmark(value: unknown): Bookmark | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const b = value as Record<string, unknown>;
	if (
		typeof b.id !== "string" ||
		typeof b.chatId !== "string" ||
		typeof b.messageId !== "string" ||
		typeof b.quote !== "string" ||
		typeof b.createdAt !== "number"
	) {
		return null;
	}
	return {
		id: b.id,
		chatId: b.chatId,
		messageId: b.messageId,
		quote: b.quote,
		createdAt: b.createdAt,
	};
}

/** Defaults to the fork tree with every row closed. */
export function loadSidebarTree(namespace: string): SidebarTree {
	return loadUi().sidebarTree[namespace] ?? { view: "tree", expanded: [] };
}

export function saveSidebarTree(namespace: string, tree: SidebarTree): void {
	const ui = loadUi();
	writeJson(UI_KEY, { ...ui, sidebarTree: { ...ui.sidebarTree, [namespace]: tree } });
}

/**
 * Fork lineage held on this device, keyed by chat id. Merged into chats that
 * arrive without an `origin` so lineage survives a server round-trip.
 */
export function loadLineage(namespace: string): Record<string, ForkOrigin> {
	const parsed = readJson(lineageKey(namespace));
	if (typeof parsed !== "object" || parsed === null) {
		return {};
	}
	const out: Record<string, ForkOrigin> = {};
	for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
		const origin = parseOrigin(value);
		if (origin) {
			out[chatId] = origin;
		}
	}
	return out;
}

export function saveLineage(namespace: string, lineage: Record<string, ForkOrigin>): void {
	writeJson(lineageKey(namespace), lineage);
}

export function parseOrigin(value: unknown): ForkOrigin | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const o = value as Record<string, unknown>;
	if (typeof o.parentChatId !== "string" || (o.kind !== "branch" && o.kind !== "thread")) {
		return undefined;
	}
	return {
		parentChatId: o.parentChatId,
		kind: o.kind,
		parentMessageId: typeof o.parentMessageId === "string" ? o.parentMessageId : null,
		...(typeof o.quote === "string" ? { quote: o.quote } : {}),
	};
}

export function loadSidebarOpen(): boolean {
	return loadUi().sidebarOpen;
}

export function saveSidebarOpen(open: boolean): void {
	writeJson(UI_KEY, { ...loadUi(), sidebarOpen: open });
}

export function loadSelectedModel(): ModelId {
	return loadUi().model;
}

export function saveSelectedModel(model: ModelId): void {
	writeJson(UI_KEY, { ...loadUi(), model });
}

export function loadModelEfforts(): Record<ModelId, EffortId> {
	return loadUi().effort;
}

export function loadModelEffort(model: ModelId): EffortId {
	return loadUi().effort[model];
}

export function saveModelEffort(model: ModelId, effort: EffortId): void {
	const ui = loadUi();
	writeJson(UI_KEY, { ...ui, effort: { ...ui.effort, [model]: effort } });
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
	return Array.isArray(parsed)
		? parsed.filter(isChat).map(dropTransient).map(orderMessages)
		: [];
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
	"role" | "content" | "createdAt" | "reasoning" | "citations" | "toolCalls"
> {
	const reasoning =
		message.role === "assistant" && message.reasoning ? message.reasoning : undefined;
	return {
		role: message.role,
		content: message.content,
		createdAt: message.createdAt,
		...(reasoning ? { reasoning } : {}),
		...(message.role === "assistant"
			? { citations: message.citations ?? [], toolCalls: message.toolCalls ?? [] }
			: {}),
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
 * Messages in the order they were sent. Older exchanges were written with the
 * question and its reply sharing a timestamp, and the Worker breaks that tie on
 * the random message id, so a reply can come back above its question. A user
 * turn always precedes the assistant turn it triggered.
 */
export function orderMessages(chat: Chat): Chat {
	const messages = [...chat.messages].sort((a, b) => {
		if (a.createdAt !== b.createdAt) {
			return a.createdAt - b.createdAt;
		}
		if (a.role === b.role) {
			return 0;
		}
		return a.role === "user" ? -1 : 1;
	});
	const unchanged = messages.every((message, i) => message === chat.messages[i]);
	return unchanged ? chat : { ...chat, messages };
}

/**
 * Persistable form of a chat: replies that are still loading or failed are
 * dropped, and each message carries only the fields in the API contract.
 */
export function dropTransient(chat: Chat): Chat {
	const origin = parseOrigin(chat.origin);
	return {
		id: chat.id,
		title: chat.title,
		createdAt: chat.createdAt,
		updatedAt: chat.updatedAt,
		messages: chat.messages
			.filter((m) => !m.pending && !m.error)
			.map((m) => ({ id: m.id, ...persistableFields(m) })),
		...(origin ? { origin } : {}),
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
