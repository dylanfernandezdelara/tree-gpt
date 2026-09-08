import { useEffect, useMemo, useRef, useState } from "react";
import { LoginPage } from "./LoginPage";
import { ChatPane } from "./components/ChatPane";
import { IconButton } from "./components/IconButton";
import { ComposeIcon, SidebarIcon } from "./components/Icons";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { UserMenu } from "./components/UserMenu";
import { sendChatStream, type ChatTurn, type StreamUpdate } from "./lib/api";
import { authClient, sessionUser, type AuthUser } from "./lib/auth-client";
import { deleteChat as deleteRemoteChat, listChats, upsertChat } from "./lib/chatsApi";
import { BookmarksView } from "./components/BookmarksView";
import {
	addBookmark,
	dropBookmarksForChat,
	openBookmarkPane,
	removeBookmark as removeFromList,
} from "./lib/bookmarks";
import { ancestorIds, childrenByParent } from "./lib/forest";
import {
	clearChat,
	dropAbility,
	findPane,
	listPanes,
	movePane,
	NO_DROPS,
	placeBeside,
	squarestSplit,
	removePane,
	setPaneChat,
	splitPane,
	swapPanes,
	type DragPayload,
	type DropSide,
	type LayoutNode,
	type PaneLeaf,
} from "./lib/layout";
import {
	loadBookmarks,
	loadBookmarksWidth,
	loadLayout,
	loadLineage,
	loadLocalChats,
	loadModelEfforts,
	loadSelectedModel,
	loadSidebarOpen,
	loadSidebarTree,
	newId,
	persistableFields,
	saveBookmarks,
	saveBookmarksWidth,
	saveLayout,
	saveLineage,
	saveLocalChats,
	saveModelEffort,
	saveSelectedModel,
	saveSidebarOpen,
	saveSidebarTree,
	titleFromMessage,
	type SidebarTree,
} from "./lib/storage";
import type { Bookmark, Chat, ForkOrigin, Message } from "./types";
import type { EffortId, ModelId } from "../worker/tree-types";

const SYNC_DEBOUNCE_MS = 500;
const NO_CHATS: Chat[] = [];

/**
 * The chats currently on screen. `ns` identifies whose they are ("user:<id>");
 * `kind` says where they persist. A store is loaded whenever the signed-in
 * user changes, so chats from one namespace never leak into another.
 * `layout` is the split-pane tree and `focusedPaneId` the pane that sidebar
 * actions target.
 */
type Store = {
	ns: string;
	kind: "local" | "remote";
	chats: Chat[];
	/** Which workspace is on screen. Both keep their own windows. */
	view: "chats" | "bookmarks";
	layout: LayoutNode;
	focusedPaneId: string;
	bookmarks: Bookmark[];
	/** Bookmarks screen: at most two windows, stacked. Null until one opens. */
	bookmarkLayout: LayoutNode | null;
	bookmarkFocusedPaneId: string | null;
};

/** The windows of whichever workspace is showing. */
function layoutOf(store: Store): LayoutNode | null {
	return store.view === "chats" ? store.layout : store.bookmarkLayout;
}

function focusedOf(store: Store): string | null {
	return store.view === "chats" ? store.focusedPaneId : store.bookmarkFocusedPaneId;
}

function withLayout(store: Store, root: LayoutNode, focusedPaneId?: string): Store {
	return store.view === "chats"
		? { ...store, layout: root, focusedPaneId: focusedPaneId ?? store.focusedPaneId }
		: {
				...store,
				bookmarkLayout: root,
				bookmarkFocusedPaneId: focusedPaneId ?? store.bookmarkFocusedPaneId,
			};
}

/** A highlighted passage a pane will fork from once something is sent. */
type ThreadAnchor = { messageId: string; quote: string };

const NO_FORKS: Chat[] = [];
const NO_BOOKMARKS: Bookmark[] = [];

function App() {
	const session = authClient.useSession();
	const user = sessionUser(session.data);

	if (session.isPending) {
		return (
			<div className="login-page">
				<p className="login-page__status">Checking session…</p>
			</div>
		);
	}

	if (!user) {
		return <LoginPage />;
	}

	return <ChatApp user={user} />;
}

function ChatApp({ user }: { user: AuthUser }) {
	const [store, setStore] = useState<Store | null>(null);
	const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
	const [model, setModel] = useState(loadSelectedModel);
	/** Reasoning effort per model. Each model remembers its own setting. */
	const [efforts, setEfforts] = useState(loadModelEfforts);
	/** Model + effort locked to each chat at its first send. Fresh chats use the preferences. */
	const [chatLocks, setChatLocks] = useState<Record<string, { model: ModelId; effort: EffortId }>>(
		{},
	);
	/** Composer text per pane id. */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	/** Chats with a reply in flight (one request per chat; chats run concurrently). */
	const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
	/** What is being dragged right now; drives every pane's drop preview. */
	const [drag, setDrag] = useState<DragPayload | null>(null);
	/** Pending threads per pane; transient like drafts. */
	const [threads, setThreads] = useState<Record<string, ThreadAnchor>>({});
	/**
	 * Bumped to replay the focus ring when nothing else about the focused pane
	 * changed, e.g. a fork link pointing at the pane you are already on.
	 */
	const [flashNonce, setFlashNonce] = useState(0);
	/** Which pane should scroll to a saved passage, and which passage. */
	const [highlight, setHighlight] = useState<{
		paneId: string;
		messageId: string;
		quote: string;
		nonce: number;
	} | null>(null);
	const [bookmarksWidth, setBookmarksWidth] = useState(loadBookmarksWidth);
	const [sidebarTree, setSidebarTree] = useState<SidebarTree>({ view: "tree", expanded: [] });
	const pendingRef = useRef(new Map<string, AbortController>());
	const syncRef = useRef<RemoteSync | null>(null);

	const namespace = `user:${user.id}`;
	// A store from another namespace is stale while the new one loads.
	const active = store && store.ns === namespace ? store : null;

	// Load the right chat store whenever the signed-in user changes.
	useEffect(() => {
		const ns = namespace;
		const controller = new AbortController();
		for (const pending of pendingRef.current.values()) {
			pending.abort();
		}
		pendingRef.current.clear();
		syncRef.current?.dispose();
		syncRef.current = null;

		async function load() {
			let chats: Chat[];
			let kind: Store["kind"];
			const remote = await listChats(controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			if (remote) {
				chats = remote;
				kind = "remote";
			} else {
				console.warn(
					"[Fork] /api/chats is not available; keeping this account's chats on this device for now.",
				);
				chats = loadLocalChats(ns);
				kind = "local";
			}
			// The Worker does not persist `origin` yet, so fill it from the local
			// mirror. A server-provided origin always wins.
			const lineage = loadLineage(ns);
			chats = chats.map((chat) =>
				chat.origin ?? !lineage[chat.id] ? chat : { ...chat, origin: lineage[chat.id] },
			);
			if (kind === "remote") {
				syncRef.current = new RemoteSync(chats);
			}
			const layout = loadLayout(ns, new Set(chats.map((chat) => chat.id)));
			setPendingIds(new Set());
			setDrafts({});
			setThreads({});
			setFlashNonce(0);
			setSidebarTree(loadSidebarTree(ns));
			setStore({
				ns,
				kind,
				chats,
				view: "chats",
				layout: layout.root,
				focusedPaneId: layout.focusedPaneId,
				bookmarks: loadBookmarks(ns),
				bookmarkLayout: null,
				bookmarkFocusedPaneId: null,
			});
		}
		void load();
		return () => controller.abort();
	}, [namespace]);

	// Persist: local stores write the chats; remote stores push changes; every store remembers its layout.
	useEffect(() => {
		if (!store) {
			return;
		}
		if (store.kind === "local") {
			saveLocalChats(store.ns, store.chats);
		} else {
			syncRef.current?.reconcile(store.chats);
		}
		saveLayout(store.ns, store.layout, store.focusedPaneId);
	}, [store]);

	useEffect(() => {
		saveSidebarOpen(sidebarOpen);
	}, [sidebarOpen]);

	useEffect(() => {
		saveSelectedModel(model);
	}, [model]);

	useEffect(() => {
		saveBookmarksWidth(bookmarksWidth);
	}, [bookmarksWidth]);

	useEffect(() => {
		if (active) {
			saveSidebarTree(active.ns, sidebarTree);
		}
	}, [active, sidebarTree]);

	const chats = active?.chats ?? NO_CHATS;
	const view = active?.view ?? "chats";
	const bookmarks = active?.bookmarks ?? NO_BOOKMARKS;
	const activeLayout = active ? layoutOf(active) : null;
	const panes = useMemo(() => (activeLayout ? listPanes(activeLayout) : []), [activeLayout]);
	const focusedPaneId = active ? focusedOf(active) : null;
	const focusedPane = panes.find((pane) => pane.id === focusedPaneId) ?? panes[0] ?? null;
	const openChatIds = useMemo(
		() => new Set(panes.map((pane) => pane.chatId).filter((id): id is string => id !== null)),
		[panes],
	);
	const sortedChats = useMemo(
		() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
		[chats],
	);
	const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);
	/** Forks of each chat, newest first, for the links under a conversation. */
	const forksOf = useMemo(() => childrenByParent(sortedChats), [sortedChats]);

	function updateStore(update: (prev: Store) => Store) {
		setStore((prev) => (prev ? update(prev) : prev));
	}

	function updateChat(id: string, update: (chat: Chat) => Chat) {
		updateStore((prev) => ({
			...prev,
			chats: prev.chats.map((chat) => (chat.id === id ? update(chat) : chat)),
		}));
	}

	function setReply(chatId: string, replyId: string, patch: Partial<Message>) {
		updateChat(chatId, (chat) => ({
			...chat,
			messages: chat.messages.map((m) => (m.id === replyId ? { ...m, ...patch } : m)),
		}));
	}

	function focusPane(paneId: string) {
		updateStore((prev) => {
			if (focusedOf(prev) === paneId) {
				return prev;
			}
			const root = layoutOf(prev);
			return root ? withLayout(prev, root, paneId) : prev;
		});
	}

	/** A chat id we can actually show; anything unknown opens as a new chat. */
	function resolveChatId(prev: Store, chatId: string | null): string | null {
		return chatId !== null && prev.chats.some((chat) => chat.id === chatId) ? chatId : null;
	}

	/**
	 * Something was dropped on a pane. A chat opens or splits; a pane swaps
	 * (header) or moves (edge). The ability is re-checked here so a stale hover
	 * preview can never apply an illegal change.
	 */
	function dropOnPane(paneId: string, target: DropSide | "swap", payload: DragPayload) {
		setDrag(null);
		updateStore((prev) => {
			// Rearranging is a conversation-workspace affair; the bookmarks screen
			// is capped at two stacked windows.
			const root = prev.view === "chats" ? prev.layout : null;
			if (!root || !findPane(root, paneId)) {
				return prev;
			}
			const ability = dropAbility(root, paneId, payload);
			const allowed = target === "swap" ? ability.swap : ability.sides[target];
			if (!allowed) {
				return prev;
			}
			if (payload.kind === "chat") {
				const chatId = resolveChatId(prev, payload.chatId);
				if (target === "swap" || target === "center") {
					return withLayout(prev, setPaneChat(root, paneId, chatId), paneId);
				}
				const split = splitPane(root, paneId, target, chatId);
				return withLayout(prev, split.root, split.newPaneId);
			}
			if (target === "swap") {
				return withLayout(prev, swapPanes(root, payload.paneId, paneId));
			}
			if (target === "center") {
				return prev;
			}
			return withLayout(prev, movePane(root, payload.paneId, paneId, target), payload.paneId);
		});
	}

	function closePane(paneId: string) {
		updateStore((prev) => {
			const current = layoutOf(prev);
			if (!current) {
				return prev;
			}
			// Closing the bookmarks screen's only window returns to the full-width
			// list; the chat workspace always keeps at least one window.
			if (prev.view === "bookmarks") {
				return { ...prev, bookmarkLayout: null, bookmarkFocusedPaneId: null };
			}
			const root = removePane(current, paneId);
			const remaining = listPanes(root);
			const focused = focusedOf(prev);
			const focusedPaneId = remaining.some((pane) => pane.id === focused)
				? (focused ?? remaining[0].id)
				: remaining[0].id;
			return withLayout(prev, root, focusedPaneId);
		});
		setDrafts((prev) => {
			if (!(paneId in prev)) {
				return prev;
			}
			const next = { ...prev };
			delete next[paneId];
			return next;
		});
		clearThread(paneId);
	}

	/** Reveal a chat's ancestors so a new fork is visible in the tree. */
	function revealInTree(chats: Chat[], chatId: string) {
		const ids = ancestorIds(chats, chatId);
		if (ids.length === 0) {
			return;
		}
		setSidebarTree((prev) => ({
			...prev,
			expanded: [...new Set([...prev.expanded, ...ids])],
		}));
	}

	/**
	 * Open a conversation beside a pane: to the right when there is room,
	 * otherwise reusing the pane already there, then below, then in place.
	 */
	function placeChat(paneId: string, chatId: string | null, anchor?: ThreadAnchor) {
		const prefer = preferredSplit(paneId);
		updateStore((prev) => {
			const placed =
				prev.view === "chats"
					? placeBeside(prev.layout, paneId, chatId, prefer)
					: openBookmarkPane(prev.bookmarkLayout, prev.bookmarkFocusedPaneId, chatId ?? "");
			if (anchor) {
				setThreads((current) => ({ ...current, [placed.paneId]: anchor }));
			}
			return withLayout(prev, placed.root, placed.paneId);
		});
	}

	/**
	 * Fork from a highlighted passage. The new pane shows the SAME chat, so the
	 * existing "open in two panes" rule forks it on the next send; the anchor
	 * only decides how that fork is recorded.
	 */
	/**
	 * Which way a pane should divide, from its shape on screen. The layout tree
	 * knows how a pane was reached, not how wide the window is, so this reads the
	 * rendered element; an unmeasurable pane falls back to the old rightward split.
	 */
	function preferredSplit(paneId: string): "right" | "bottom" {
		const element = document.querySelector<HTMLElement>(
			`[data-pane-id="${CSS.escape(paneId)}"]`,
		);
		return element ? squarestSplit(element.clientWidth, element.clientHeight) : "right";
	}

	function startThread(paneId: string, messageId: string, quote: string) {
		const pane = activeLayout ? findPane(activeLayout, paneId) : null;
		if (!pane?.chatId) {
			return;
		}
		placeChat(paneId, pane.chatId, { messageId, quote });
	}

	function clearThread(paneId: string) {
		setThreads((prev) => {
			if (!(paneId in prev)) {
				return prev;
			}
			const next = { ...prev };
			delete next[paneId];
			return next;
		});
	}

	/**
	 * Focus the pane already showing a chat, if there is one. Opening a second
	 * copy would silently arm the branch-on-send rule, so every path that
	 * "opens" a chat checks here first.
	 */
	function focusChatIfOpen(chatId: string): boolean {
		const open = activeLayout
			? listPanes(activeLayout).find((pane) => pane.chatId === chatId)
			: undefined;
		if (!open) {
			return false;
		}
		updateStore((prev) => ({ ...prev, focusedPaneId: open.id }));
		setFlashNonce((n) => n + 1);
		return true;
	}

	/** Follow a fork link: reveal the fork if it is already open, else open it beside. */
	function openFork(paneId: string, chatId: string) {
		if (!active || focusChatIfOpen(chatId)) {
			return;
		}
		placeChat(paneId, chatId);
	}

	function toggleForkRow(chatId: string) {
		setSidebarTree((prev) => ({
			...prev,
			expanded: prev.expanded.includes(chatId)
				? prev.expanded.filter((id) => id !== chatId)
				: [...prev.expanded, chatId],
		}));
	}

	/** Collapse shows the tree with every row closed; expand flattens it. */
	function toggleSidebarView() {
		setSidebarTree((prev) =>
			prev.view === "tree" ? { view: "flat", expanded: [] } : { view: "tree", expanded: [] },
		);
	}

	function setDraft(paneId: string, value: string) {
		setDrafts((prev) => ({ ...prev, [paneId]: value }));
	}

	function configFor(chatId: string): { model: ModelId; effort: EffortId } {
		return chatLocks[chatId] ?? { model, effort: efforts[model] };
	}

	/** First send wins: later calls for the same chat are no-ops. */
	function lockConfig(chatId: string, value: { model: ModelId; effort: EffortId }): void {
		setChatLocks((prev) => (prev[chatId] === undefined ? { ...prev, [chatId]: value } : prev));
	}

	function changeEffort(effort: EffortId): void {
		saveModelEffort(model, effort);
		setEfforts((prev) => ({ ...prev, [model]: effort }));
	}

	async function request(
		chatId: string,
		replyId: string,
		history: ChatTurn[],
		config: { model: ModelId; effort: EffortId },
	) {
		pendingRef.current.get(chatId)?.abort();
		const controller = new AbortController();
		pendingRef.current.set(chatId, controller);
		setPendingIds((prev) => new Set(prev).add(chatId));
		let reasoning = "";
		let content = "";
		const applyUpdate = (update: StreamUpdate) => {
			if (update.type === "reasoning") {
				reasoning += update.text;
			} else {
				content += update.text;
			}
			const snapshot = { content, reasoning };
			setReply(chatId, replyId, {
				content: snapshot.content,
				...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
			});
		};
		try {
			const result = await sendChatStream(history, controller.signal, applyUpdate, {
				model: config.model,
				effort: config.effort,
			});
			if (result.ok && content.trim()) {
				updateChat(chatId, (chat) => ({ ...chat, updatedAt: Date.now() }));
				setReply(chatId, replyId, {
					content,
					pending: false,
					error: false,
					...(reasoning ? { reasoning } : {}),
				});
			} else if (result.ok) {
				setReply(chatId, replyId, {
					content: "OpenRouter returned an empty reply.",
					pending: false,
					error: true,
				});
			} else {
				const text = result.details ? `${result.error}: ${result.details}` : result.error;
				setReply(chatId, replyId, { content: text, pending: false, error: true });
			}
		} catch {
			if (controller.signal.aborted) {
				// Stopped by the reader: drop the placeholder, keep their message.
				updateChat(chatId, (chat) => ({
					...chat,
					messages: chat.messages.filter((m) => m.id !== replyId),
				}));
			} else {
				setReply(chatId, replyId, {
					content: "Couldn't reach the server. Check your connection and try again.",
					pending: false,
					error: true,
				});
			}
		} finally {
			if (pendingRef.current.get(chatId) === controller) {
				pendingRef.current.delete(chatId);
				setPendingIds((prev) => {
					const next = new Set(prev);
					next.delete(chatId);
					return next;
				});
			}
		}
	}

	function send(paneId: string) {
		if (!active) {
			return;
		}
		const pane = activeLayout ? findPane(activeLayout, paneId) : null;
		const content = (drafts[paneId] ?? "").trim();
		if (!pane || !content) {
			return;
		}
		const chat = pane.chatId ? (chatById.get(pane.chatId) ?? null) : null;
		if (chat && pendingRef.current.has(chat.id)) {
			return;
		}
		// The same chat open in another pane: branch instead of appending, so the
		// other panes keep the original conversation.
		const shared =
			chat !== null &&
			activeLayout !== null &&
			listPanes(activeLayout).filter((other) => other.chatId === chat.id).length > 1;
		// A threading anchor forks on its own. The bookmarks screen holds one
		// window, so a thread there reuses the pane and `shared` never holds;
		// without this the fork would silently append to the parent instead.
		const anchor = threads[paneId];
		const { now, userMessage, reply } = newExchange(content);
		setDraft(paneId, "");

		if (chat && (shared || anchor)) {
			// A fork continues the same conversation, so it inherits the
			// source chat's locked config rather than the preferences.
			const config = configFor(chat.id);
			const history: ChatTurn[] = [...toTurns(chat.messages), { role: "user", content }];
			const carried = copyMessages(chat.messages);
			// A thread diverges at the highlighted message; a plain branch at the
			// last turn carried over. Both refer to the parent's message ids.
			const origin: ForkOrigin = anchor
				? {
						parentChatId: chat.id,
						kind: "thread",
						parentMessageId: anchor.messageId,
						quote: anchor.quote,
					}
				: {
						parentChatId: chat.id,
						kind: "branch",
						parentMessageId: lastPersistedId(chat.messages),
					};
			const branched: Chat = {
				id: newId(),
				title: titleFromMessage(content),
				messages: [...carried, userMessage, reply],
				createdAt: now,
				updatedAt: now,
				origin,
			};
			clearThread(paneId);
			lockConfig(branched.id, config);
			updateStore((prev) => {
				const chats = [branched, ...prev.chats];
				saveLineage(prev.ns, { ...loadLineage(prev.ns), [branched.id]: origin });
				revealInTree(chats, branched.id);
				return {
					...withLayout(prev, setPaneChat(layoutOf(prev) ?? prev.layout, paneId, branched.id)),
					chats,
				};
			});
			void request(branched.id, reply.id, history, config);
		} else if (chat) {
			const config = configFor(chat.id);
			lockConfig(chat.id, config);
			const history: ChatTurn[] = [...toTurns(chat.messages), { role: "user", content }];
			updateChat(chat.id, (current) => ({
				...current,
				updatedAt: now,
				messages: [...current.messages, userMessage, reply],
			}));
			void request(chat.id, reply.id, history, config);
		} else {
			const created: Chat = {
				id: newId(),
				title: titleFromMessage(content),
				messages: [userMessage, reply],
				createdAt: now,
				updatedAt: now,
			};
			const config = { model, effort: efforts[model] };
			lockConfig(created.id, config);
			updateStore((prev) => ({
				...withLayout(prev, setPaneChat(layoutOf(prev) ?? prev.layout, paneId, created.id)),
				chats: [created, ...prev.chats],
			}));
			void request(created.id, reply.id, [{ role: "user", content }], config);
		}
	}

	/** Re-request an assistant reply using the conversation up to that point. */
	function redo(paneId: string, messageId: string) {
		if (!active) {
			return;
		}
		const pane = activeLayout ? findPane(activeLayout, paneId) : null;
		const chat = pane?.chatId ? (chatById.get(pane.chatId) ?? null) : null;
		if (!chat || pendingRef.current.has(chat.id)) {
			return;
		}
		const index = chat.messages.findIndex((m) => m.id === messageId);
		if (index < 0) {
			return;
		}
		const history = toTurns(chat.messages.slice(0, index));
		if (history.length === 0) {
			return;
		}
		const config = configFor(chat.id);
		lockConfig(chat.id, config);
		setReply(chat.id, messageId, {
			content: "",
			pending: true,
			error: false,
			reasoning: undefined,
		});
		void request(chat.id, messageId, history, config);
	}

	function stop(paneId: string) {
		const pane = activeLayout ? findPane(activeLayout, paneId) : null;
		if (pane?.chatId) {
			pendingRef.current.get(pane.chatId)?.abort();
		}
	}

	function showBookmarks() {
		updateStore((prev) => (prev.view === "bookmarks" ? prev : { ...prev, view: "bookmarks" }));
	}

	function addBookmarkFrom(paneId: string, messageId: string, quote: string) {
		updateStore((prev) => {
			const root = layoutOf(prev);
			const pane = root ? findPane(root, paneId) : null;
			if (!pane?.chatId) {
				return prev;
			}
			const next = addBookmark(prev.bookmarks, {
				id: newId(),
				chatId: pane.chatId,
				messageId,
				quote,
				createdAt: Date.now(),
			});
			saveBookmarks(prev.ns, next);
			return { ...prev, bookmarks: next };
		});
	}

	function deleteBookmark(id: string) {
		updateStore((prev) => {
			const next = removeFromList(prev.bookmarks, id);
			saveBookmarks(prev.ns, next);
			return { ...prev, bookmarks: next };
		});
	}

	/** Open a saved passage: stack its conversation and jump to the passage. */
	function openBookmark(bookmark: Bookmark) {
		updateStore((prev) => {
			if (!prev.chats.some((chat) => chat.id === bookmark.chatId)) {
				return prev;
			}
			const placed = openBookmarkPane(
				prev.bookmarkLayout,
				prev.bookmarkFocusedPaneId,
				bookmark.chatId,
			);
			setHighlight({
				paneId: placed.paneId,
				messageId: bookmark.messageId,
				quote: bookmark.quote,
				nonce: Date.now(),
			});
			return {
				...prev,
				view: "bookmarks",
				bookmarkLayout: placed.root,
				bookmarkFocusedPaneId: placed.paneId,
			};
		});
	}

	/** The sidebar always drives the conversation workspace. */
	function chatsTarget(store: Store): PaneLeaf {
		const panesList = listPanes(store.layout);
		return panesList.find((pane) => pane.id === store.focusedPaneId) ?? panesList[0];
	}

	function newChat() {
		if (!active) {
			return;
		}
		const target = chatsTarget(active);
		updateStore((prev) => ({
			...prev,
			view: "chats",
			layout: setPaneChat(prev.layout, target.id, null),
			focusedPaneId: target.id,
		}));
	}

	function selectChat(chatId: string) {
		if (!active) {
			return;
		}
		// Always lands in the conversation workspace, whichever screen you were on.
		const open = listPanes(active.layout).find((pane) => pane.chatId === chatId);
		if (open) {
			updateStore((prev) => ({ ...prev, view: "chats", focusedPaneId: open.id }));
			setFlashNonce((n) => n + 1);
			return;
		}
		const target = chatsTarget(active);
		updateStore((prev) => ({
			...prev,
			view: "chats",
			layout: setPaneChat(prev.layout, target.id, chatId),
			focusedPaneId: target.id,
		}));
	}

	async function logOut() {
		try {
			await authClient.signOut();
		} catch {
			// The session store refreshes on its own; nothing else to do here.
		}
	}

	function renameChat(id: string, title: string) {
		updateChat(id, (chat) => ({ ...chat, title }));
	}

	function deleteChat(id: string) {
		pendingRef.current.get(id)?.abort();
		updateStore((prev) => {
			const lineage = loadLineage(prev.ns);
			delete lineage[id];
			saveLineage(prev.ns, lineage);
			// A deleted conversation takes its bookmarks with it, in storage too;
			// otherwise they come back orphaned on the next load.
			const bookmarks = dropBookmarksForChat(prev.bookmarks, id);
			if (bookmarks.length !== prev.bookmarks.length) {
				saveBookmarks(prev.ns, bookmarks);
			}
			return {
				...prev,
				chats: prev.chats.filter((chat) => chat.id !== id),
				layout: clearChat(prev.layout, id),
				bookmarkLayout: prev.bookmarkLayout ? clearChat(prev.bookmarkLayout, id) : null,
				bookmarks,
			};
		});
	}

	/** One conversation window, used by both workspaces. */
	function renderPane(pane: PaneLeaf) {
		const chat = pane.chatId ? (chatById.get(pane.chatId) ?? null) : null;
		const streaming = chat ? pendingIds.has(chat.id) : false;
		return (
			<ChatPane
				key={pane.id}
				pane={pane}
				chat={chat}
				focused={pane.id === focusedPane?.id}
				// A lone chat-screen window has nothing to close to; the bookmarks
				// screen's single window closes back to the full-width list.
				showHeader={panes.length > 1 || view === "bookmarks"}
				draft={drafts[pane.id] ?? ""}
				streaming={streaming}
				busy={streaming}
				model={model}
				onModelChange={setModel}
				effort={efforts[model]}
				onEffortChange={changeEffort}
				// The bookmarks screen holds one window, so nothing there accepts a drag.
				ability={
					view === "chats" && activeLayout ? dropAbility(activeLayout, pane.id, drag) : NO_DROPS
				}
				dragging={drag?.kind === "pane" && drag.paneId === pane.id}
				dropEffect={drag?.kind === "pane" ? "move" : "copy"}
				forks={(chat && forksOf.get(chat.id)) || NO_FORKS}
				thread={threads[pane.id] ?? null}
				highlight={highlight?.paneId === pane.id ? highlight : null}
				flashKey={
					// A single full-screen chat has no other pane to distinguish it
					// from, so it never rings.
					panes.length > 1 && pane.id === focusedPane?.id
						? `${pane.chatId ?? "empty"}#${flashNonce}`
						: null
				}
				onFocus={() => focusPane(pane.id)}
				onClose={() => closePane(pane.id)}
				onDraftChange={(value) => setDraft(pane.id, value)}
				onSend={() => send(pane.id)}
				onStop={() => stop(pane.id)}
				onRedo={(messageId) => redo(pane.id, messageId)}
				onOpenFork={(chatId) => openFork(pane.id, chatId)}
				onThread={(messageId, quote) => startThread(pane.id, messageId, quote)}
				onBookmark={(messageId, quote) => addBookmarkFrom(pane.id, messageId, quote)}
				onClearThread={() => clearThread(pane.id)}
				onDragStart={setDrag}
				onDragEnd={() => setDrag(null)}
				onDrop={(target, payload) => dropOnPane(pane.id, target, payload)}
			/>
		);
	}

	return (
		<div className="app">
			<Sidebar
				chats={sortedChats}
				activeChatId={focusedPane?.chatId ?? null}
				open={sidebarOpen}
				onToggle={() => setSidebarOpen((open) => !open)}
				onNewChat={newChat}
				onSelect={selectChat}
				onRename={renameChat}
				onDelete={deleteChat}
				user={user}
				onLogOut={logOut}
				bookmarksOpen={view === "bookmarks"}
				onShowBookmarks={showBookmarks}
				view={sidebarTree.view}
				expanded={sidebarTree.expanded}
				onToggleView={toggleSidebarView}
				onToggleRow={toggleForkRow}
				onDragStart={setDrag}
				onDragEnd={() => setDrag(null)}
			/>
			<main className="main">
				{/* Only worth its height when the sidebar is away and it holds the controls. */}
				{sidebarOpen ? null : (
					<header className="main__header">
						<IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
							<SidebarIcon />
						</IconButton>
						<IconButton label="New chat" onClick={newChat}>
							<ComposeIcon />
						</IconButton>
						<div className="main__header-spacer" />
						<UserMenu user={user} placement="down" compact onLogOut={logOut} />
					</header>
				)}
				<div className="main__body">
					{view === "bookmarks" ? (
						<BookmarksView
							bookmarks={bookmarks}
							chatsById={chatById}
							openChatIds={openChatIds}
							width={bookmarksWidth}
							onWidthChange={setBookmarksWidth}
							onOpen={openBookmark}
							onRemove={deleteBookmark}
							hasPanes={activeLayout !== null}
						>
							{activeLayout ? <PaneLayout root={activeLayout} renderPane={renderPane} /> : null}
						</BookmarksView>
					) : activeLayout ? (
						<PaneLayout root={activeLayout} renderPane={renderPane} />
					) : null}
				</div>
			</main>
		</div>
	);
}

/** A user message plus the placeholder for its reply. */
function newExchange(content: string): { now: number; userMessage: Message; reply: Message } {
	const now = Date.now();
	return {
		now,
		userMessage: { id: newId(), role: "user", content, createdAt: now },
		// Strictly later than the question: the Worker orders messages by
		// created_at and breaks ties on the random message id, so sharing a
		// timestamp lets the reply come back above the question.
		reply: { id: newId(), role: "assistant", content: "", createdAt: now + 1, pending: true },
	};
}

/**
 * Messages copied into a branched chat: finished turns only, with fresh ids
 * because message ids are unique across every chat on the backend.
 */
function copyMessages(messages: Message[]): Message[] {
	return messages
		.filter((m) => !m.pending && !m.error)
		.map((m) => ({ id: newId(), ...persistableFields(m) }));
}

/** Last message that survives into a fork, for recording where it diverged. */
function lastPersistedId(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message.pending && !message.error) {
			return message.id;
		}
	}
	return null;
}

/** Conversation turns to send upstream: finished messages only. */
function toTurns(messages: Message[]): ChatTurn[] {
	return messages
		.filter((m) => !m.pending && !m.error)
		.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Pushes changes to /api/chats. Compares each chat by reference against the
 * last version it sent, so any mutation shows up as an upsert and any missing
 * id as a delete. Upserts are debounced and serialized per chat.
 */
class RemoteSync {
	private known: Map<string, Chat>;
	private timers = new Map<string, number>();
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
		const timer = window.setTimeout(() => {
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
			window.clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	private enqueue(id: string, task: () => Promise<void>): void {
		const previous = this.queues.get(id) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.queues.set(id, next);
	}
}

export default App;
