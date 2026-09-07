import { useEffect, useMemo, useRef, useState } from "react";
import { LoginPage } from "./LoginPage";
import { ChatThread } from "./components/ChatThread";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { IconButton } from "./components/IconButton";
import { ComposeIcon, SidebarIcon } from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import { UserMenu } from "./components/UserMenu";
import { sendChat, type ChatTurn } from "./lib/api";
import { authClient, sessionUser, type AuthUser } from "./lib/auth-client";
import { deleteChat as deleteRemoteChat, listChats, upsertChat } from "./lib/chatsApi";
import { placeholderReply } from "./lib/placeholder";
import {
	GUEST_NAMESPACE,
	loadActiveChatId,
	loadLocalChats,
	loadSidebarOpen,
	newId,
	saveActiveChatId,
	saveLocalChats,
	saveSidebarOpen,
	titleFromMessage,
} from "./lib/storage";
import type { Chat, Message } from "./types";

const DISCLAIMER = "treeGPT can make mistakes. Check important info.";
const SYNC_DEBOUNCE_MS = 500;
const NO_CHATS: Chat[] = [];

/**
 * The chats currently on screen. `ns` identifies whose they are ("guest" or
 * "user:<id>"); `kind` says where they persist. A store is loaded whenever
 * the signed-in user changes, so chats from one namespace never leak into
 * another.
 */
type Store = {
	ns: string;
	kind: "local" | "remote";
	chats: Chat[];
	activeChatId: string | null;
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
	const [draft, setDraft] = useState("");
	const [pendingChatId, setPendingChatId] = useState<string | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const syncRef = useRef<RemoteSync | null>(null);

	const namespace = `user:${user.id}`;
	// A store from another namespace is stale while the new one loads.
	const active = store && store.ns === namespace ? store : null;

	// Load the right chat store whenever the signed-in user changes.
	useEffect(() => {
		if (namespace === null) {
			return;
		}
		const ns = namespace;
		const controller = new AbortController();
		controllerRef.current?.abort();
		syncRef.current?.dispose();
		syncRef.current = null;

		async function load() {
			let chats: Chat[];
			let kind: Store["kind"];
			if (ns === GUEST_NAMESPACE) {
				chats = loadLocalChats(ns);
				kind = "local";
			} else {
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
			}
			if (kind === "remote") {
				syncRef.current = new RemoteSync(chats);
			}
			const remembered = loadActiveChatId(ns);
			setStore({
				ns,
				kind,
				chats,
				activeChatId: chats.some((c) => c.id === remembered) ? remembered : null,
			});
		}
		void load();
		return () => controller.abort();
	}, [namespace]);

	// Persist: local stores write the chats; remote stores push changes; every store remembers its open chat.
	useEffect(() => {
		if (!store) {
			return;
		}
		if (store.kind === "local") {
			saveLocalChats(store.ns, store.chats);
		} else {
			syncRef.current?.reconcile(store.chats);
		}
		saveActiveChatId(store.ns, store.activeChatId);
	}, [store]);

	useEffect(() => {
		saveSidebarOpen(sidebarOpen);
	}, [sidebarOpen]);

	const chats = active?.chats ?? NO_CHATS;
	const activeChatId = active?.activeChatId ?? null;
	const sortedChats = useMemo(
		() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
		[chats],
	);
	const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;

	function updateChats(update: (chats: Chat[]) => Chat[]) {
		setStore((prev) => (prev ? { ...prev, chats: update(prev.chats) } : prev));
	}

	function updateChat(id: string, update: (chat: Chat) => Chat) {
		updateChats((list) => list.map((chat) => (chat.id === id ? update(chat) : chat)));
	}

	function setActiveChatId(id: string | null) {
		setStore((prev) => (prev ? { ...prev, activeChatId: id } : prev));
	}

	function setReply(chatId: string, replyId: string, patch: Partial<Message>) {
		updateChat(chatId, (chat) => ({
			...chat,
			messages: chat.messages.map((m) => (m.id === replyId ? { ...m, ...patch } : m)),
		}));
	}

	async function request(chatId: string, replyId: string, history: ChatTurn[]) {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		setPendingChatId(chatId);
		try {
			const content = await fetchReply(history, controller.signal);
			updateChat(chatId, (chat) => ({ ...chat, updatedAt: Date.now() }));
			setReply(chatId, replyId, { content, pending: false, error: false });
		} catch {
			// Only an abort gets here: drop the placeholder and keep the user's message.
			updateChat(chatId, (chat) => ({
				...chat,
				messages: chat.messages.filter((m) => m.id !== replyId),
			}));
		} finally {
			if (controllerRef.current === controller) {
				controllerRef.current = null;
				setPendingChatId(null);
			}
		}
	}

	function send() {
		const content = draft.trim();
		if (!active || !content || pendingChatId !== null) {
			return;
		}
		const now = Date.now();
		const userMessage: Message = { id: newId(), role: "user", content, createdAt: now };
		const reply: Message = {
			id: newId(),
			role: "assistant",
			content: "",
			createdAt: now,
			pending: true,
		};
		setDraft("");

		if (activeChat) {
			const history: ChatTurn[] = [...toTurns(activeChat.messages), { role: "user", content }];
			updateChat(activeChat.id, (chat) => ({
				...chat,
				updatedAt: now,
				messages: [...chat.messages, userMessage, reply],
			}));
			void request(activeChat.id, reply.id, history);
		} else {
			const chat: Chat = {
				id: newId(),
				title: titleFromMessage(content),
				messages: [userMessage, reply],
				createdAt: now,
				updatedAt: now,
			};
			setStore((prev) =>
				prev ? { ...prev, chats: [chat, ...prev.chats], activeChatId: chat.id } : prev,
			);
			void request(chat.id, reply.id, [{ role: "user", content }]);
		}
	}

	/** Re-request an assistant reply using the conversation up to that point. */
	function redo(messageId: string) {
		if (!activeChat || pendingChatId !== null) {
			return;
		}
		const index = activeChat.messages.findIndex((m) => m.id === messageId);
		if (index < 0) {
			return;
		}
		const history = toTurns(activeChat.messages.slice(0, index));
		if (history.length === 0) {
			return;
		}
		setReply(activeChat.id, messageId, { content: "", pending: true, error: false });
		void request(activeChat.id, messageId, history);
	}

	function stop() {
		controllerRef.current?.abort();
	}

	function newChat() {
		setActiveChatId(null);
		setDraft("");
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
		if (pendingChatId === id) {
			controllerRef.current?.abort();
		}
		setStore((prev) =>
			prev
				? {
						...prev,
						chats: prev.chats.filter((chat) => chat.id !== id),
						activeChatId: prev.activeChatId === id ? null : prev.activeChatId,
					}
				: prev,
		);
	}

	const composer = (
		<Composer
			value={draft}
			onChange={setDraft}
			onSend={send}
			onStop={stop}
			streaming={pendingChatId !== null && pendingChatId === activeChatId}
			busy={pendingChatId !== null || active === null}
		/>
	);

	return (
		<div className="app">
			<Sidebar
				chats={sortedChats}
				activeChatId={activeChatId}
				open={sidebarOpen}
				onToggle={() => setSidebarOpen((open) => !open)}
				onNewChat={newChat}
				onSelect={setActiveChatId}
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
				{activeChat && activeChat.messages.length > 0 ? (
					<>
						<ChatThread chat={activeChat} onRedo={redo} />
						<div className="composer-area">
							<p className="disclaimer">{DISCLAIMER}</p>
							{composer}
						</div>
					</>
				) : (
					<EmptyState>{composer}</EmptyState>
				)}
			</main>
		</div>
	);
}

/**
 * Ask the backend for a reply. TEMPORARY: while the backend is not wired up,
 * a failed call is replaced with placeholder text so the UI can be exercised.
 * Aborts still propagate.
 */
async function fetchReply(history: ChatTurn[], signal: AbortSignal): Promise<string> {
	let failure: string;
	try {
		const result = await sendChat(history, signal);
		if (result.ok) {
			return result.message;
		}
		failure = result.details ? `${result.error}: ${result.details}` : result.error;
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}
		failure = error instanceof Error ? error.message : String(error);
	}
	console.warn(`[treeGPT] /api/openrouter failed (${failure}); showing a placeholder reply.`);
	return placeholderReply(history, signal);
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
