import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AuthUser } from "../lib/auth-client";
import { writeDragPayload, type DragPayload } from "../lib/layout";
import type { Chat } from "../types";
import { IconButton } from "./IconButton";
import { ComposeIcon, MoreIcon, PencilIcon, SidebarIcon, TrashIcon } from "./Icons";
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
	onDragStart,
	onDragEnd,
}: Props) {
	return (
		<aside className={`sidebar${open ? "" : " sidebar--closed"}`} aria-hidden={!open}>
			<div className="sidebar__inner">
				<div className="sidebar__header">
					<span className="sidebar__brand">treeGPT</span>
					<IconButton label="Close sidebar" onClick={onToggle}>
						<SidebarIcon />
					</IconButton>
				</div>
				<nav className="sidebar__nav" aria-label="Chat history">
					<button
						type="button"
						className={`sidebar__row${activeChatId === null ? " sidebar__row--active" : ""}`}
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
					{chats.length > 0 ? (
						<>
							<h2 className="sidebar__section">Chats</h2>
							<ul className="sidebar__list">
								{chats.map((chat) => (
									<ChatRow
										key={chat.id}
										chat={chat}
										active={chat.id === activeChatId}
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

type RowProps = {
	chat: Chat;
	active: boolean;
	onSelect: () => void;
	onDragStart: (payload: DragPayload) => void;
	onDragEnd: () => void;
	onRename: (title: string) => void;
	onDelete: () => void;
};

function ChatRow({
	chat,
	active,
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
