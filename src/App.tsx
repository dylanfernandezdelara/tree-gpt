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
import {
	clearChat,
	findPane,
	listPanes,
	MAX_PANES,
	removePane,
	setPaneChat,
	splitPane,
	type DropSide,
	type LayoutNode,
} from "./lib/layout";
import {
	loadLayout,
	loadLocalChats,
	loadSidebarOpen,
	newId,
	persistableFields,
	saveLayout,
	saveLocalChats,
	saveSidebarOpen,
	titleFromMessage,
} from "./lib/storage";
import type { Chat, Message } from "./types";

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
	layout: LayoutNode;
	focusedPaneId: string;
};

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
	/** Composer text per pane id. */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	/** Chats with a reply in flight (one request per chat; chats run concurrently). */
	const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
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
					"[treeGPT] /api/chats is not available; keeping this account's chats on this device for now.",
				);
				chats = loadLocalChats(ns);
				kind = "local";
			}
			if (kind === "remote") {
				syncRef.current = new RemoteSync(chats);
			}
			const layout = loadLayout(ns, new Set(chats.map((chat) => chat.id)));
			setPendingIds(new Set());
			setDrafts({});
			setStore({ ns, kind, chats, layout: layout.root, focusedPaneId: layout.focusedPaneId });
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

	const chats = active?.chats ?? NO_CHATS;
	const layout = active?.layout ?? null;
	const panes = useMemo(() => (layout ? listPanes(layout) : []), [layout]);
	const focusedPane = panes.find((pane) => pane.id === active?.focusedPaneId) ?? panes[0] ?? null;
	const sortedChats = useMemo(
		() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
		[chats],
	);
	const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);

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
		updateStore((prev) => (prev.focusedPaneId === paneId ? prev : { ...prev, focusedPaneId: paneId }));
	}

	/** A chat id we can actually show; anything unknown opens as a new chat. */
	function resolveChatId(prev: Store, chatId: string | null): string | null {
		return chatId !== null && prev.chats.some((chat) => chat.id === chatId) ? chatId : null;
	}

	/** Show a chat (or an empty new chat) in a pane and focus it. */
	function openInPane(paneId: string, chatId: string | null) {
		updateStore((prev) => ({
			...prev,
			layout: setPaneChat(prev.layout, paneId, resolveChatId(prev, chatId)),
			focusedPaneId: paneId,
		}));
	}

	function dropOnPane(paneId: string, side: DropSide, chatId: string | null) {
		if (side === "center") {
			openInPane(paneId, chatId);
			return;
		}
		updateStore((prev) => {
			if (listPanes(prev.layout).length >= MAX_PANES || !findPane(prev.layout, paneId)) {
				return prev;
			}
			const { root, newPaneId } = splitPane(
				prev.layout,
				paneId,
				side,
				resolveChatId(prev, chatId),
			);
			return { ...prev, layout: root, focusedPaneId: newPaneId };
		});
	}

	function closePane(paneId: string) {
		updateStore((prev) => {
			const root = removePane(prev.layout, paneId);
			const remaining = listPanes(root);
			const focusedPaneId = remaining.some((pane) => pane.id === prev.focusedPaneId)
				? prev.focusedPaneId
				: remaining[0].id;
			return { ...prev, layout: root, focusedPaneId };
		});
		setDrafts((prev) => {
			if (!(paneId in prev)) {
				return prev;
			}
			const next = { ...prev };
			delete next[paneId];
			return next;
		});
	}

	function setDraft(paneId: string, value: string) {
		setDrafts((prev) => ({ ...prev, [paneId]: value }));
	}

	async function request(chatId: string, replyId: string, history: ChatTurn[]) {
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
			const result = await sendChatStream(history, controller.signal, applyUpdate);
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
		const pane = findPane(active.layout, paneId);
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
			listPanes(active.layout).filter((other) => other.chatId === chat.id).length > 1;
		const { now, userMessage, reply } = newExchange(content);
		setDraft(paneId, "");

		if (chat && shared) {
			const history: ChatTurn[] = [...toTurns(chat.messages), { role: "user", content }];
			const branched: Chat = {
				id: newId(),
				title: titleFromMessage(content),
				messages: [...copyMessages(chat.messages), userMessage, reply],
				createdAt: now,
				updatedAt: now,
			};
			updateStore((prev) => ({
				...prev,
				chats: [branched, ...prev.chats],
				layout: setPaneChat(prev.layout, paneId, branched.id),
			}));
			void request(branched.id, reply.id, history);
		} else if (chat) {
			const history: ChatTurn[] = [...toTurns(chat.messages), { role: "user", content }];
			updateChat(chat.id, (current) => ({
				...current,
				updatedAt: now,
				messages: [...current.messages, userMessage, reply],
			}));
			void request(chat.id, reply.id, history);
		} else {
			const created: Chat = {
				id: newId(),
				title: titleFromMessage(content),
				messages: [userMessage, reply],
				createdAt: now,
				updatedAt: now,
			};
			updateStore((prev) => ({
				...prev,
				chats: [created, ...prev.chats],
				layout: setPaneChat(prev.layout, paneId, created.id),
			}));
			void request(created.id, reply.id, [{ role: "user", content }]);
		}
	}

	/** Re-request an assistant reply using the conversation up to that point. */
	function redo(paneId: string, messageId: string) {
		if (!active) {
			return;
		}
		const pane = findPane(active.layout, paneId);
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
		setReply(chat.id, messageId, {
			content: "",
			pending: true,
			error: false,
			reasoning: undefined,
		});
		void request(chat.id, messageId, history);
	}

	function stop(paneId: string) {
		const pane = active ? findPane(active.layout, paneId) : null;
		if (pane?.chatId) {
			pendingRef.current.get(pane.chatId)?.abort();
		}
	}

	function newChat() {
		if (focusedPane) {
			openInPane(focusedPane.id, null);
		}
	}

	function selectChat(chatId: string) {
		if (focusedPane) {
			openInPane(focusedPane.id, chatId);
		}
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
		updateStore((prev) => ({
			...prev,
			chats: prev.chats.filter((chat) => chat.id !== id),
			layout: clearChat(prev.layout, id),
		}));
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
			/>
			<main className="main">
				<header className="main__header">
					{sidebarOpen ? null : (
						<>
							<IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
								<SidebarIcon />
							</IconButton>
							<IconButton label="New chat" onClick={newChat}>
								<ComposeIcon />
							</IconButton>
						</>
					)}
					<div className="main__header-spacer" />
					{sidebarOpen ? null : (
						<UserMenu user={user} placement="down" compact onLogOut={logOut} />
					)}
				</header>
				<div className="main__body">
					{layout ? (
						<PaneLayout
							root={layout}
							renderPane={(pane) => {
								const chat = pane.chatId ? (chatById.get(pane.chatId) ?? null) : null;
								const streaming = chat ? pendingIds.has(chat.id) : false;
								return (
									<ChatPane
										key={pane.id}
										pane={pane}
										chat={chat}
										focused={pane.id === focusedPane?.id}
										multi={panes.length > 1}
										draft={drafts[pane.id] ?? ""}
										streaming={streaming}
										busy={streaming}
										onFocus={() => focusPane(pane.id)}
										onClose={() => closePane(pane.id)}
										onDraftChange={(value) => setDraft(pane.id, value)}
										onSend={() => send(pane.id)}
										onStop={() => stop(pane.id)}
										onRedo={(messageId) => redo(pane.id, messageId)}
										onDrop={(side, chatId) => dropOnPane(pane.id, side, chatId)}
									/>
								);
							}}
						/>
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
		reply: { id: newId(), role: "assistant", content: "", createdAt: now, pending: true },
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
						console.warn(`[treeGPT] Failed to delete chat ${id} on the server.`);
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
					console.warn(`[treeGPT] Failed to save chat ${chat.id} on the server.`);
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
