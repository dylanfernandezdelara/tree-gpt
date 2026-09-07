import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AuthUser } from "../lib/auth-client";
import { buildForest, type ChatNode } from "../lib/forest";
import { useAutoHideScrollbar } from "../lib/use-auto-hide-scrollbar";
import { writeDragPayload, type DragPayload } from "../lib/layout";
import type { SidebarView } from "../lib/storage";
import type { Chat } from "../types";
import { IconButton } from "./IconButton";
import {
	BookmarkIcon,
	ChevronIcon,
	ComposeIcon,
	ListIcon,
	MoreIcon,
	PencilIcon,
	SidebarIcon,
	TreeIcon,
	TrashIcon,
} from "./Icons";
import { UserMenu } from "./UserMenu";

type Props = {
	chats: Chat[];
	activeChatId: string | null;
	open: boolean;
	onToggle: () => void;
	onNewChat: () => void;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	/** Signed-in user, or null when signed out. */
	user: AuthUser | null;
	onLogOut: () => void;
	/** The bookmarks screen is showing instead of the conversation workspace. */
	bookmarksOpen: boolean;
	onShowBookmarks: () => void;
	/** "tree" nests forks under their parent; "flat" lists everything by recency. */
	view: SidebarView;
	/** Chat ids whose forks are showing, in tree view. */
	expanded: string[];
	onToggleView: () => void;
	onToggleRow: (chatId: string) => void;
	onDragStart: (payload: DragPayload) => void;
	onDragEnd: () => void;
};

export function Sidebar({
	chats,
	activeChatId,
	open,
	onToggle,
	onNewChat,
	onSelect,
	onRename,
	onDelete,
	user,
	onLogOut,
	bookmarksOpen,
	onShowBookmarks,
	view,
	expanded,
	onToggleView,
	onToggleRow,
	onDragStart,
	onDragEnd,
}: Props) {
	const navRef = useRef<HTMLElement>(null);

	useAutoHideScrollbar(navRef);

	const tree = view === "tree" ? buildForest(chats) : null;
	const openRows = new Set(expanded);
	const rowProps = {
		activeChatId,
		openRows,
		onSelect,
		onRename,
		onDelete,
		onToggleRow,
		onDragStart,
		onDragEnd,
	};
	return (
		<aside className={`sidebar${open ? "" : " sidebar--closed"}`} aria-hidden={!open}>
			<div className="sidebar__inner">
				<div className="sidebar__header">
					<span className="sidebar__brand">Fork</span>
					<IconButton label="Close sidebar" onClick={onToggle}>
						<SidebarIcon />
					</IconButton>
				</div>
				<nav className="sidebar__nav" ref={navRef} aria-label="Chat history">
					<button
						type="button"
						className={`sidebar__row${
							activeChatId === null && !bookmarksOpen ? " sidebar__row--active" : ""
						}`}
						onClick={onNewChat}
						draggable
						onDragStart={(event) => {
							const payload: DragPayload = { kind: "chat", chatId: null };
							writeDragPayload(event.dataTransfer, payload, "New chat");
							onDragStart(payload);
						}}
						onDragEnd={onDragEnd}
					>
						<ComposeIcon />
						<span>New chat</span>
					</button>
					<button
						type="button"
						className={`sidebar__row${bookmarksOpen ? " sidebar__row--active" : ""}`}
						onClick={onShowBookmarks}
						aria-current={bookmarksOpen ? "page" : undefined}
					>
						<BookmarkIcon />
						<span>Bookmarks</span>
					</button>
					{chats.length > 0 ? (
						<>
							<div className="sidebar__section">
								<h2 className="sidebar__section-label">Chats</h2>
								<IconButton
									label={view === "tree" ? "Expand all" : "Collapse forks"}
									className="sidebar__section-toggle"
									onClick={onToggleView}
								>
									{view === "tree" ? <ListIcon /> : <TreeIcon />}
								</IconButton>
							</div>
							<ul className="sidebar__list">
								{tree
									? tree.map((node) => <ChatTreeRow key={node.chat.id} node={node} {...rowProps} />)
									: chats.map((chat) => (
											<ChatRow
												key={chat.id}
												chat={chat}
												active={chat.id === activeChatId}
												hasForks={false}
												expanded={false}
												onToggleRow={onToggleRow}
												onSelect={() => onSelect(chat.id)}
												onDragStart={onDragStart}
												onDragEnd={onDragEnd}
												onRename={(title) => onRename(chat.id, title)}
												onDelete={() => onDelete(chat.id)}
											/>
										))}
							</ul>
						</>
					) : null}
				</nav>
				{user ? (
					<div className="sidebar__footer">
						<UserMenu user={user} placement="up" onLogOut={onLogOut} />
					</div>
				) : null}
			</div>
		</aside>
	);
}

type TreeRowProps = {
	node: ChatNode;
	activeChatId: string | null;
	openRows: ReadonlySet<string>;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	onToggleRow: (chatId: string) => void;
	onDragStart: (payload: DragPayload) => void;
	onDragEnd: () => void;
};

/** One chat and, when opened, the chats forked from it. */
function ChatTreeRow({ node, ...rest }: TreeRowProps) {
	const { chat, children } = node;
	const showChildren = children.length > 0 && rest.openRows.has(chat.id);
	return (
		<>
			<ChatRow
				chat={chat}
				active={chat.id === rest.activeChatId}
				hasForks={children.length > 0}
				expanded={showChildren}
				onToggleRow={rest.onToggleRow}
				onSelect={() => rest.onSelect(chat.id)}
				onDragStart={rest.onDragStart}
				onDragEnd={rest.onDragEnd}
				onRename={(title) => rest.onRename(chat.id, title)}
				onDelete={() => rest.onDelete(chat.id)}
			/>
			{showChildren ? (
				<li className="sidebar__branch">
					<ul className="sidebar__children">
						{children.map((child) => (
							<ChatTreeRow key={child.chat.id} node={child} {...rest} />
						))}
					</ul>
				</li>
			) : null}
		</>
	);
}

type RowProps = {
	chat: Chat;
	active: boolean;
	/** This chat has forks, so it gets a chevron. */
	hasForks: boolean;
	expanded: boolean;
	onToggleRow: (chatId: string) => void;
	onSelect: () => void;
	onDragStart: (payload: DragPayload) => void;
	onDragEnd: () => void;
	onRename: (title: string) => void;
	onDelete: () => void;
};

function ChatRow({
	chat,
	active,
	hasForks,
	expanded,
	onToggleRow,
	onSelect,
	onDragStart,
	onDragEnd,
	onRename,
	onDelete,
}: RowProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(chat.title);
	const rowRef = useRef<HTMLLIElement>(null);

	useEffect(() => {
		if (!menuOpen) {
			return;
		}
		function onMouseDown(event: MouseEvent) {
			if (rowRef.current && !rowRef.current.contains(event.target as Node)) {
				setMenuOpen(false);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);

	function startRename() {
		setDraft(chat.title);
		setEditing(true);
		setMenuOpen(false);
	}

	function commitRename() {
		const title = draft.trim();
		if (title && title !== chat.title) {
			onRename(title);
		}
		setEditing(false);
	}

	function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			event.preventDefault();
			commitRename();
		} else if (event.key === "Escape") {
			event.preventDefault();
			setEditing(false);
		}
	}

	const className = [
		"chat-row",
		active ? "chat-row--active" : "",
		menuOpen ? "chat-row--menu-open" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<li ref={rowRef} className={className}>
			{editing ? (
				<input
					className="chat-row__input"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={handleInputKey}
					onBlur={commitRename}
					aria-label="Chat title"
					autoFocus
				/>
			) : (
				<button
					type="button"
					className="chat-row__title"
					onClick={onSelect}
					title={chat.title}
					aria-current={active ? "page" : undefined}
					draggable
					onDragStart={(event) => {
						const payload: DragPayload = { kind: "chat", chatId: chat.id };
						writeDragPayload(event.dataTransfer, payload, chat.title);
						onDragStart(payload);
					}}
					onDragEnd={onDragEnd}
				>
					{chat.title}
				</button>
			)}
			<IconButton
				label="Chat options"
				className="chat-row__more"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onClick={() => setMenuOpen((value) => !value)}
			>
				<MoreIcon />
			</IconButton>
			{hasForks ? (
				<IconButton
					label={expanded ? "Hide forks" : "Show forks"}
					className={`chat-row__toggle${expanded ? " chat-row__toggle--open" : ""}`}
					aria-expanded={expanded}
					onClick={() => onToggleRow(chat.id)}
				>
					<ChevronIcon />
				</IconButton>
			) : null}
			{menuOpen ? (
				<div className="chat-menu" role="menu">
					<button type="button" role="menuitem" className="chat-menu__item" onClick={startRename}>
						<PencilIcon />
						Rename
					</button>
					<button
						type="button"
						role="menuitem"
						className="chat-menu__item chat-menu__item--danger"
						onClick={() => {
							setMenuOpen(false);
							onDelete();
						}}
					>
						<TrashIcon />
						Delete
					</button>
				</div>
			) : null}
		</li>
	);
}
