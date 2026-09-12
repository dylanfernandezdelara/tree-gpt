import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { messagesUpTo } from "../lib/fork";
import {
	dropSideAt,
	hasDragPayload,
	readDragPayload,
	type DragPayload,
	type DropAbility,
	type DropSide,
	type PaneLeaf,
} from "../lib/layout";
import { registerLift, settleMove } from "../lib/paneLift";
import { visualScale } from "../lib/zoom";
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

/** Pixels the pointer must travel before a header press becomes a move; clicks pass through below it. */
const MOVE_THRESHOLD = 5;

type Props = {
	pane: PaneLeaf;
	chat: Chat | null;
	focused: boolean;
	/** Drop preview driven by a pointer move in flight (native drags preview on their own). */
	movePreview: DropTarget | null;
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
	/** Pointer-move session: lift, hover, release-to-commit, cancel. */
	onMoveStart: (paneId: string) => void;
	onMoveOver: (x: number, y: number) => void;
	/** The pointer lifted; commits when over a legal target. Answers what happened. */
	onMoveEnd: () => "commit" | "cancel";
	onMoveCancel: () => void;
	/** Something was dropped on this pane. */
	onDrop: (target: DropTarget, payload: DragPayload) => void;
};

/** One conversation view; also a drag handle and a drop target. */
export function ChatPane({
	pane,
	chat,
	focused,
	movePreview,
	showHeader,
	draft,
	streaming,
	busy,
	model,
	onModelChange,
	effort,
	onEffortChange,
	ability,
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
	onMoveStart,
	onMoveOver,
	onMoveEnd,
	onMoveCancel,
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
	const sectionRef = useRef<HTMLElement>(null);

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
	 * caret back here would undo it -- the Fork button, for one, hands focus to
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

	// --- the pane body: edges split, the middle opens a chat in place or swaps a pane ---

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

	/**
	 * Move this pane with the pointer: past a small threshold the real section
	 * lifts out of its slot and follows the cursor until release, Escape, or
	 * focus loss. The lift is imperative (no renders per move); only the drop
	 * target flows through state. Clicks, double-clicks, and the rename input
	 * pass through untouched below the threshold.
	 */
	function handleHeaderPointerDown(event: ReactPointerEvent<HTMLElement>) {
		if (!event.isPrimary || event.button !== 0 || editingTitle) {
			return;
		}
		if ((event.target as HTMLElement).closest("button, input")) {
			return;
		}
		const maybeSection = sectionRef.current;
		if (!maybeSection) {
			return;
		}
		const section: HTMLElement = maybeSection;
		const startX = event.clientX;
		const startY = event.clientY;
		const header = event.currentTarget;
		const pointerId = event.pointerId;
		// Rects and pointer deltas arrive in visual (post-zoom) pixels; the
		// inline geometry below is pre-zoom CSS pixels, so everything written
		// back is divided out or the pane lands short by the zoom factor.
		const scale = visualScale(section);
		let active = false;
		let finished = false;

		function lift() {
			const box = section.getBoundingClientRect();
			// First: starting the move grounds strays from prior sessions.
			// Only then register this lift, or grounding would clear it.
			onMoveStart(pane.id);
			registerLift(section);
			section.classList.add("pane--moving");
			section.style.width = `${box.width / scale}px`;
			section.style.height = `${box.height / scale}px`;
			section.style.left = `${box.left / scale}px`;
			section.style.top = `${box.top / scale}px`;
			section.style.transform = "translate(0px, 0px)";
			active = true;
			// Keeps the release landing here even off-window or mid-fling.
			try {
				header.setPointerCapture(pointerId);
			} catch {
				// The pointer is already gone; the button check below ends it.
			}
		}

		function move(pointer: PointerEvent) {
			if (pointer.pointerId !== pointerId) {
				return;
			}
			if ((pointer.buttons & 1) === 0) {
				// The button went up somewhere unreachable (off-window before
				// the threshold, when no capture holds the gesture). Past the
				// threshold this still lands the pane; it never abandons it.
				if (active) {
					finish(false);
				} else {
					cleanup();
				}
				return;
			}
			if (!active) {
				if (
					Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < MOVE_THRESHOLD
				) {
					return;
				}
				lift();
			}
			// A re-render can rewrite className mid-gesture (a focus change does);
			// re-assert the lift so the pane never falls back into flow.
			if (!section.classList.contains("pane--moving")) {
				section.classList.add("pane--moving");
			}
			section.style.transform = `translate(${(pointer.clientX - startX) / scale}px, ${(pointer.clientY - startY) / scale}px)`;
			onMoveOver(pointer.clientX, pointer.clientY);
		}

		function finish(commit: boolean) {
			if (finished) {
				return;
			}
			finished = true;
			cleanup();
			if (!active) {
				return;
			}
			// A press-and-release still dispatches a click; swallow it so the
			// drop does not also focus a composer. The guard lives 350ms: the
			// gesture's own click lands within a frame or two of the release,
			// while any later real click passes through. (A zero-delay removal
			// would run before the click dispatches and swallow nothing.)
			const kill = (evt: Event) => {
				evt.stopPropagation();
				evt.preventDefault();
			};
			window.addEventListener("click", kill, { capture: true, once: true });
			window.setTimeout(
				() => window.removeEventListener("click", kill, { capture: true }),
				350,
			);
			if (!commit) {
				onMoveCancel();
				settleMove(section, false);
				return;
			}
			settleMove(section, onMoveEnd() === "commit");
		}

		function cleanup() {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key);
			window.removeEventListener("blur", blur);
			header.removeEventListener("lostpointercapture", dropped);
			try {
				if (header.hasPointerCapture(pointerId)) {
					header.releasePointerCapture(pointerId);
				}
			} catch {
				// Already released; implicit release on pointerup covers it.
			}
		}
		function up(pointer: PointerEvent) {
			if (pointer.pointerId !== pointerId || pointer.button !== 0) {
				return;
			}
			finish(true);
		}
		function cancel(pointer: PointerEvent) {
			if (pointer.pointerId !== pointerId) {
				return;
			}
			finish(false);
		}
		function key(event: KeyboardEvent) {
			if (event.key === "Escape") {
				finish(false);
			}
		}
		function blur() {
			finish(false);
		}
		function dropped(pointer: PointerEvent) {
			// Capture died, but the gesture may be fine: touch browsers yank and
			// re-deal it mid-gesture (the compositor's scroll check runs ~30ms in)
			// with no pointercancel and moves still flowing. So take it back and
			// carry on; only a dead pointer lands the pane. A real takeover ends
			// in pointercancel, which finishes through the cancel path.
			if (pointer.pointerId !== pointerId || !active) {
				return;
			}
			try {
				header.setPointerCapture(pointer.pointerId);
			} catch {
				finish(false);
			}
		}
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("keydown", key);
		window.addEventListener("blur", blur);
		header.addEventListener("lostpointercapture", dropped);
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
	// Native drags preview from hover state, pointer moves from props; only one
	// gesture is ever in flight.
	const nativePreview = dropSide && accepts(dropSide) ? dropSide : null;
	const moveSide =
		movePreview && movePreview !== "swap" && accepts(movePreview) ? movePreview : null;
	const previewSide = nativePreview ?? moveSide;
	const swapLit = (headerHover && ability.swap) || movePreview === "swap";

	/*
	 * A pending fork shows only what it will carry. Until the first send this
	 * pane still holds the SOURCE chat, so without this the reader sees every
	 * turn after the passage they forked from -- turns the new conversation
	 * will not have. The anchor is per pane, so the source pane is unaffected.
	 */
	const shown = useMemo(
		() =>
			chat && thread ? { ...chat, messages: messagesUpTo(chat.messages, thread.messageId) } : chat,
		[chat, thread],
	);

	/*
	 * Forks that diverged below the cut belong to the path being left behind.
	 * ChatThread drops any fork whose anchor is missing from the conversation
	 * to the END of the thread -- a sensible fallback for a regenerated
	 * message, but in a truncated view it would park exactly the forks we just
	 * hid at the bottom of the pane. Filter them out here instead.
	 */
	const shownForks = useMemo(() => {
		if (!shown || !thread) {
			return forks;
		}
		const ids = new Set(shown.messages.map((message) => message.id));
		return forks.filter((fork) => {
			const at = fork.origin?.parentMessageId;
			return at !== undefined && at !== null && ids.has(at);
		});
	}, [forks, shown, thread]);

	const title = chat ? chat.title : "New chat";
	const headerClass = ["pane__header", swapLit ? "pane__header--target" : ""]
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
						label="Clear forked passage"
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
			ref={sectionRef}
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
					// A move handle for the pointer session; still a native drop
					// target, so sidebar chats keep dropping here to swap.
					onPointerDown={handleHeaderPointerDown}
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
					<IconButton label="Close pane" className="pane__close" onClick={onClose}>
						<CloseIcon />
					</IconButton>
				</div>
			) : null}
			{shown && shown.messages.length > 0 ? (
				<ChatThread
					chat={shown}
					onRedo={onRedo}
					composer={composer}
					forks={shownForks}
					onOpenFork={onOpenFork}
					onThread={onThread}
					onBookmark={onBookmark}
					highlight={highlight}
					focused={focused}
				/>
			) : (
				<EmptyState paneId={pane.id}>
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
		</section>
	);
}
