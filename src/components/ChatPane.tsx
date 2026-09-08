import {
	useEffect,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import {
	dropSideAt,
	hasDragPayload,
	readDragPayload,
	writeDragPayload,
	type DragPayload,
	type DropAbility,
	type DropSide,
	type PaneLeaf,
} from "../lib/layout";
import type { Chat } from "../types";
import { ChatThread } from "./ChatThread";
import { Composer } from "./Composer";
import { EffortSelector } from "./EffortSelector";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./Icons";
import { ModelSelector } from "./ModelSelector";
import type { EffortId, ModelId } from "../../worker/tree-types";

/** Where a drop would land: an edge or middle of the body, or the header. */
type DropTarget = DropSide | "swap";

type Props = {
	pane: PaneLeaf;
	chat: Chat | null;
	focused: boolean;
	/** Show the title bar with its close button and drag handle. */
	showHeader: boolean;
	draft: string;
	streaming: boolean;
	busy: boolean;
	/** Global model preference, rendered below this pane's composer. */
	model: ModelId;
	onModelChange: (model: ModelId) => void;
	/** Effort for the selected model, locked with it at the chat's first send. */
	effort: EffortId;
	onEffortChange: (effort: EffortId) => void;
	/** What this pane accepts from the drag in progress. */
	ability: DropAbility;
	/** This pane is the one being dragged. */
	dragging: boolean;
	/** How to label the drag for the cursor: panes move, sidebar chats copy. */
	dropEffect: "move" | "copy";
	/** Chats forked from this pane's chat, listed under the last message. */
	forks: Chat[];
	/** The passage this pane will fork from once something is sent. */
	thread: { messageId: string; quote: string } | null;
	/** Scroll to a bookmarked passage and tint it; replays when `nonce` changes. */
	highlight: { messageId: string; quote: string; nonce: number } | null;
	/**
	 * Non-null only while this pane has focus, and changes whenever the ring
	 * should replay: focus arriving here, or its chat being swapped out.
	 */
	flashKey: string | null;
	onFocus: () => void;
	onClose: () => void;
	/** Commit a new title for this pane's chat. */
	onRename: (title: string) => void;
	onDraftChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	onRedo: (messageId: string) => void;
	onOpenFork: (chatId: string) => void;
	onThread: (messageId: string, quote: string) => void;
	onBookmark: (messageId: string, quote: string) => void;
	onClearThread: () => void;
	onDragStart: (payload: DragPayload) => void;
	onDragEnd: () => void;
	/** Something was dropped on this pane. */
	onDrop: (target: DropTarget, payload: DragPayload) => void;
};

/** One conversation view; also a drag handle and a drop target. */
export function ChatPane({
	pane,
	chat,
	focused,
	showHeader,
	draft,
	streaming,
	busy,
	model,
	onModelChange,
	effort,
	onEffortChange,
	ability,
	dragging,
	dropEffect,
	forks,
	thread,
	highlight,
	flashKey,
	onFocus,
	onClose,
	onRename,
	onDraftChange,
	onSend,
	onStop,
	onRedo,
	onOpenFork,
	onThread,
	onBookmark,
	onClearThread,
	onDragStart,
	onDragEnd,
	onDrop,
}: Props) {
	// dragenter/dragleave fire for every child; count depth so the preview doesn't flicker.
	const bodyDepthRef = useRef(0);
	const headerDepthRef = useRef(0);
	const [dropSide, setDropSide] = useState<DropSide | null>(null);
	const [headerHover, setHeaderHover] = useState(false);
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	/** Off-screen stand-in used as the drag image, so a drag shows the name alone. */
	const chipRef = useRef<HTMLSpanElement>(null);

	// A pane opened for threading should be ready to type in straight away,
	// including when an existing pane was reused and so never remounted.
	useEffect(() => {
		if (thread) {
			inputRef.current?.focus();
		}
	}, [thread]);

	/**
	 * Clicking anywhere in a pane should leave the caret in its composer, so a
	 * newly focused window can be typed into without a second click. Runs on
	 * click rather than mousedown so a drag that highlighted a passage keeps its
	 * selection instead of losing it to the textarea.
	 *
	 * Controls are exempt: a control click already did something, and pulling the
	 * caret back here would undo it -- the Thread button, for one, hands focus to
	 * the pane it just opened.
	 */
	function startRename() {
		if (!chat) {
			return;
		}
		setTitleDraft(chat.title);
		setEditingTitle(true);
	}

	function commitRename() {
		const next = titleDraft.trim();
		if (chat && next && next !== chat.title) {
			onRename(next);
		}
		setEditingTitle(false);
	}

	function handleTitleKey(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			event.preventDefault();
			commitRename();
		} else if (event.key === "Escape") {
			event.preventDefault();
			setEditingTitle(false);
		}
	}

	function handlePaneClick(event: ReactMouseEvent<HTMLElement>) {
		if (
			(event.target as HTMLElement).closest("button, a, input, textarea, select, .pane__title")
		) {
			return;
		}
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) {
			return;
		}
		inputRef.current?.focus();
	}

	function accepts(target: DropTarget): boolean {
		return target === "swap" ? ability.swap : ability.sides[target];
	}

	function sideFromEvent(event: DragEvent<HTMLElement>): DropSide {
		const rect = event.currentTarget.getBoundingClientRect();
		return dropSideAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
	}

	// --- the pane body: edges split, the middle opens a chat in place ---

	function handleBodyDragEnter(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		bodyDepthRef.current += 1;
		setDropSide(sideFromEvent(event));
	}

	function handleBodyDragOver(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		const side = sideFromEvent(event);
		event.dataTransfer.dropEffect = accepts(side) ? dropEffect : "none";
		setDropSide((previous) => (previous === side ? previous : side));
	}

	function handleBodyDragLeave(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		bodyDepthRef.current = Math.max(0, bodyDepthRef.current - 1);
		if (bodyDepthRef.current === 0) {
			setDropSide(null);
		}
	}

	function handleBodyDrop(event: DragEvent<HTMLElement>) {
		const payload = readDragPayload(event.dataTransfer);
		bodyDepthRef.current = 0;
		setDropSide(null);
		if (!payload) {
			return;
		}
		event.preventDefault();
		const side = sideFromEvent(event);
		if (accepts(side)) {
			onDrop(side, payload);
		}
	}

	// --- the header: a drag handle, and a drop target that swaps panes ---

	function handleHeaderDragStart(event: DragEvent<HTMLElement>) {
		const payload: DragPayload = { kind: "pane", paneId: pane.id };
		writeDragPayload(event.dataTransfer, payload, title);
		// Without this the browser drags a snapshot of the whole header bar.
		if (chipRef.current) {
			event.dataTransfer.setDragImage(chipRef.current, 16, 18);
		}
		onDragStart(payload);
	}

	function handleHeaderDragEnter(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		headerDepthRef.current += 1;
		setHeaderHover(true);
	}

	function handleHeaderDragOver(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = ability.swap ? dropEffect : "none";
		setHeaderHover(true);
	}

	function handleHeaderDragLeave(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.stopPropagation();
		headerDepthRef.current = Math.max(0, headerDepthRef.current - 1);
		if (headerDepthRef.current === 0) {
			setHeaderHover(false);
		}
	}

	function handleHeaderDrop(event: DragEvent<HTMLElement>) {
		const payload = readDragPayload(event.dataTransfer);
		headerDepthRef.current = 0;
		setHeaderHover(false);
		if (!payload) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (ability.swap) {
			onDrop("swap", payload);
		}
	}

	// A refused target simply shows nothing; the drop is ignored either way.
	const previewSide = dropSide && accepts(dropSide) ? dropSide : null;
	const title = chat ? chat.title : "New chat";
	const headerClass = [
		"pane__header",
		dragging ? "pane__header--dragging" : "",
		headerHover && ability.swap ? "pane__header--target" : "",
	]
		.filter(Boolean)
		.join(" ");

	// Only the focused pane offers a composer; the others are read-only until
	// they are clicked, which is what focuses them.
	const composer = !focused ? null : (
		<div className="composer-rise">
			{thread ? (
				<div className="thread-quote">
					<p className="thread-quote__text">{thread.quote}</p>
					<IconButton
						label="Clear threaded passage"
						className="thread-quote__clear"
						onClick={onClearThread}
					>
						<CloseIcon />
					</IconButton>
				</div>
			) : null}
			<Composer
				value={draft}
				onChange={onDraftChange}
				onSend={onSend}
				onStop={onStop}
				streaming={streaming}
				busy={busy}
				autoFocus={focused}
				inputRef={inputRef}
			/>
		</div>
	);

	return (
		<section
			className={`pane${focused ? " pane--focused" : ""}${
				showHeader ? " pane--headed" : ""
			}`}
			data-pane-id={pane.id}
			onMouseDownCapture={onFocus}
			onFocusCapture={onFocus}
			onClick={handlePaneClick}
			onDragEnter={handleBodyDragEnter}
			onDragOver={handleBodyDragOver}
			onDragLeave={handleBodyDragLeave}
			onDrop={handleBodyDrop}
		>
			{showHeader ? (
				<div
					className={headerClass}
					// Dragging while renaming would hijack text selection in the input.
					draggable={!editingTitle}
					onDragStart={handleHeaderDragStart}
					onDragEnd={onDragEnd}
					onDragEnter={handleHeaderDragEnter}
					onDragOver={handleHeaderDragOver}
					onDragLeave={handleHeaderDragLeave}
					onDrop={handleHeaderDrop}
				>
					{editingTitle ? (
						<input
							className="pane__title-input"
							value={titleDraft}
							onChange={(event) => setTitleDraft(event.target.value)}
							onKeyDown={handleTitleKey}
							onBlur={commitRename}
							aria-label="Chat title"
							autoFocus
						/>
					) : (
						<span
							className="pane__title"
							title={chat ? `${title} — double-click to rename` : title}
							onDoubleClick={startRename}
						>
							{title}
						</span>
					)}
					<IconButton
						label="Close pane"
						className="pane__close"
						draggable={false}
						onDragStart={(event) => event.preventDefault()}
						onClick={onClose}
					>
						<CloseIcon />
					</IconButton>
				</div>
			) : null}
			{chat && chat.messages.length > 0 ? (
				<ChatThread
					chat={chat}
					onRedo={onRedo}
					composer={composer}
					forks={forks}
					onOpenFork={onOpenFork}
					onThread={onThread}
					onBookmark={onBookmark}
					highlight={highlight}
					focused={focused}
				/>
			) : (
				<EmptyState>
					{composer ? (
						<div className="composer-stack">
							{composer}
							<div className="picker-row">
								<ModelSelector value={model} onChange={onModelChange} />
								<EffortSelector model={model} value={effort} onChange={onEffortChange} />
							</div>
						</div>
					) : null}
				</EmptyState>
			)}
			<div
				className={`pane__drop${previewSide ? ` pane__drop--visible pane__drop--${previewSide}` : ""}`}
				aria-hidden="true"
			/>
			{/* Remounted on every new key, which replays the one-shot ring. Only the
			    focused pane is ever given a key, so the ring always marks focus. */}
			{flashKey === null ? null : <span key={flashKey} className="pane__flash" aria-hidden="true" />}
			{/* Rendered off-screen: setDragImage refuses a hidden element. */}
			<span className="pane__drag-chip" ref={chipRef} aria-hidden="true">
				{title}
			</span>
		</section>
	);
}
