import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type UIEvent,
} from "react";
import { useAutoHideScrollbar } from "../lib/use-auto-hide-scrollbar";
import { visualScale } from "../lib/zoom";
import type { Chat } from "../types";
import { ArrowDownIcon, BookmarkIcon, ForkIcon } from "./Icons";
import { MessageView } from "./Message";

/** How far (px) from the bottom still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 24;
/** Gap between the composer and the bottom edge of the thread area. */
const COMPOSER_MARGIN = 16;
/** Composer height before it is measured: 52px pill + margin. */
const INITIAL_INSET = 52 + COMPOSER_MARGIN;

/** A selection sitting inside one message, offered as a threading anchor. */
type Anchor = { messageId: string; quote: string; left: number; top: number };

type Props = {
	chat: Chat;
	onRedo: (messageId: string) => void;
	/** The composer, rendered floating over the bottom of the thread. */
	composer: ReactNode;
	/** Chats forked from this one, each shown under the message it diverged at. */
	forks: Chat[];
	onOpenFork: (chatId: string) => void;
	/** Fork this conversation from a highlighted passage. */
	onThread: (messageId: string, quote: string) => void;
	/** Save a highlighted passage to the bookmarks screen. */
	onBookmark: (messageId: string, quote: string) => void;
	/** Scroll to a message and tint a passage; replays when `nonce` changes. */
	highlight: { messageId: string; quote: string; nonce: number } | null;
	/** This pane has focus, so it may show its scrollbar for any scroll. */
	focused: boolean;
};

/** Paints without touching the DOM, so React's markdown output is untouched. */
const HIGHLIGHT_NAME = "treegpt-bookmark";
const HIGHLIGHT_MS = 2500;

/**
 * Scrollable conversation with the composer floating over it. Messages scroll
 * behind the composer and show faded beneath it; a scroll-to-bottom button
 * appears while the reader is scrolled up.
 */
export function ChatThread({
	chat,
	onRedo,
	composer,
	forks,
	onOpenFork,
	onThread,
	onBookmark,
	highlight,
	focused,
}: Props) {
	const threadRef = useRef<HTMLDivElement>(null);
	const floatRef = useRef<HTMLDivElement>(null);
	const scrolledUpRef = useRef(false);
	const [scrolledUp, setScrolledUp] = useState(false);
	const [inset, setInset] = useState(INITIAL_INSET);
	const [anchor, setAnchor] = useState<Anchor | null>(null);

	useAutoHideScrollbar(threadRef, focused);

	/**
	 * Forks hang under the message they diverged at, so the branch point is
	 * visible in the conversation. Any whose anchor is missing from this chat
	 * (an older fork, or the message was since removed) falls to the end.
	 */
	const { byMessage, trailing } = useMemo(() => {
		const ids = new Set(chat.messages.map((message) => message.id));
		const map = new Map<string, Chat[]>();
		const rest: Chat[] = [];
		for (const fork of forks) {
			const at = fork.origin?.parentMessageId;
			if (!at || !ids.has(at)) {
				rest.push(fork);
				continue;
			}
			const list = map.get(at);
			if (list) {
				list.push(fork);
			} else {
				map.set(at, [fork]);
			}
		}
		return { byMessage: map, trailing: rest };
	}, [forks, chat.messages]);
	const count = chat.messages.length;
	const last = chat.messages[count - 1];
	const lastId = last?.id;
	const lastPending = last?.pending === true;

	const report = useCallback((thread: HTMLDivElement) => {
		const next =
			thread.scrollHeight - thread.scrollTop - thread.clientHeight > BOTTOM_THRESHOLD;
		if (next !== scrolledUpRef.current) {
			scrolledUpRef.current = next;
			setScrolledUp(next);
		}
	}, []);

	// Keep the newest turn in view when a chat opens, a message is added, or a reply lands.
	useEffect(() => {
		const thread = threadRef.current;
		if (thread) {
			thread.scrollTop = thread.scrollHeight;
			report(thread);
		}
	}, [chat.id, count, lastId, lastPending, report]);

	// Track the composer's height so padding and the fade follow a growing textarea.
	useEffect(() => {
		const float = floatRef.current;
		if (!float || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const height = entries[0]?.contentRect.height ?? 0;
			// An unfocused pane has no composer, and collapsing the space it will
			// come back into would shift the whole conversation on every focus
			// change. Keep the last real measurement instead.
			if (height > 0) {
				setInset(Math.round(height) + COMPOSER_MARGIN);
			}
		});
		observer.observe(float);
		return () => observer.disconnect();
	}, []);

	// If the composer grew while the reader was at the bottom, stay at the bottom.
	useEffect(() => {
		const thread = threadRef.current;
		if (thread && !scrolledUpRef.current) {
			thread.scrollTop = thread.scrollHeight;
		}
	}, [inset]);

	// Jump to a bookmarked passage. Declared after the scroll-to-bottom effect
	// so it wins on the commit where the conversation opens.
	useEffect(() => {
		const thread = threadRef.current;
		if (!thread || !highlight) {
			return;
		}
		const message = thread.querySelector<HTMLElement>(
			`[data-message-id="${CSS.escape(highlight.messageId)}"]`,
		);
		if (!message) {
			return;
		}
		message.scrollIntoView({ block: "center" });
		const range = findQuote(message, highlight.quote);
		const highlights = (
			CSS as unknown as { highlights?: Map<string, unknown> & { delete(k: string): void } }
		).highlights;
		const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
		if (range && highlights && Ctor) {
			highlights.set(HIGHLIGHT_NAME, new Ctor(range));
			const timer = window.setTimeout(() => highlights.delete(HIGHLIGHT_NAME), HIGHLIGHT_MS);
			return () => {
				window.clearTimeout(timer);
				highlights.delete(HIGHLIGHT_NAME);
			};
		}
		// Older browsers: tint the whole message instead of the passage.
		message.classList.add("turn--highlight");
		const timer = window.setTimeout(
			() => message.classList.remove("turn--highlight"),
			HIGHLIGHT_MS,
		);
		return () => {
			window.clearTimeout(timer);
			message.classList.remove("turn--highlight");
		};
	}, [highlight]);

	/**
	 * Offer the Thread action only for a selection that lies wholly inside one
	 * message of THIS pane, so panes showing the same chat cannot both react.
	 */
	useEffect(() => {
		function read() {
			const thread = threadRef.current;
			const selection = window.getSelection();
			if (!thread || !selection || selection.isCollapsed || selection.rangeCount === 0) {
				setAnchor(null);
				return;
			}
			const quote = selection.toString().trim();
			const range = selection.getRangeAt(0);
			const start = messageOf(range.startContainer, thread);
			const end = messageOf(range.endContainer, thread);
			if (!quote || !start || start !== end) {
				setAnchor(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			// The rect is in visual pixels; the pill is placed in CSS pixels.
			const scale = visualScale(thread);
			setAnchor({
				messageId: start,
				quote,
				left: (rect.left + rect.width / 2) / scale,
				top: rect.top / scale,
			});
		}
		document.addEventListener("selectionchange", read);
		document.addEventListener("mouseup", read);
		return () => {
			document.removeEventListener("selectionchange", read);
			document.removeEventListener("mouseup", read);
		};
	}, []);

	useEffect(() => {
		if (!anchor) {
			return;
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setAnchor(null);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [anchor]);

	function act(run: (messageId: string, quote: string) => void) {
		if (!anchor) {
			return;
		}
		run(anchor.messageId, anchor.quote);
		window.getSelection()?.removeAllRanges();
		setAnchor(null);
	}

	function handleScroll(event: UIEvent<HTMLDivElement>) {
		setAnchor(null);
		report(event.currentTarget);
	}

	function scrollToBottom() {
		threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
	}

	return (
		<div className="thread-area" style={{ "--composer-inset": `${inset}px` } as CSSProperties}>
			<div className="thread" ref={threadRef} onScroll={handleScroll}>
				<div className="thread__inner">
					{chat.messages.map((message, index) => (
						<Fragment key={message.id}>
							<MessageView
								message={message}
								isLast={index === count - 1}
								onRedo={() => onRedo(message.id)}
							/>
							<ForkLinks forks={byMessage.get(message.id)} onOpen={onOpenFork} />
						</Fragment>
					))}
					<ForkLinks forks={trailing} onOpen={onOpenFork} />
				</div>
			</div>
			<div className="thread-fade" aria-hidden="true" />
			{scrolledUp ? (
				<button
					type="button"
					className="scroll-to-bottom"
					aria-label="Scroll to bottom"
					title="Scroll to bottom"
					onClick={scrollToBottom}
				>
					<ArrowDownIcon />
				</button>
			) : null}
			{anchor ? (
				<div
					className="selection-bar"
					style={{ left: anchor.left, top: anchor.top }}
					onMouseDown={(event) => event.preventDefault()}
				>
					<button type="button" className="selection-action" onClick={() => act(onThread)}>
						<ForkIcon />
						Thread
					</button>
					<span className="selection-bar__divider" aria-hidden="true" />
					<button type="button" className="selection-action" onClick={() => act(onBookmark)}>
						<BookmarkIcon />
						Bookmark
					</button>
				</div>
			) : null}
			<div className="composer-float" ref={floatRef}>
				{composer}
			</div>
		</div>
	);
}

/** Links to the conversations forked at one point in this chat. */
function ForkLinks({ forks, onOpen }: { forks?: Chat[]; onOpen: (chatId: string) => void }) {
	if (!forks || forks.length === 0) {
		return null;
	}
	return (
		<div className="forks">
			{forks.map((fork) => (
				<button
					key={fork.id}
					type="button"
					className="fork-link"
					onClick={() => onOpen(fork.id)}
					title={`Open ${fork.title}`}
				>
					<ForkIcon />
					<span className="fork-link__title">{fork.title}</span>
				</button>
			))}
		</div>
	);
}

/** A range over the first occurrence of `quote` inside a message, if present. */
function findQuote(message: HTMLElement, quote: string): Range | null {
	const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		const index = node.textContent?.indexOf(quote) ?? -1;
		if (index >= 0) {
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + quote.length);
			return range;
		}
		node = walker.nextNode();
	}
	return null;
}

/** The id of the message containing a node, when it is inside this thread. */
function messageOf(node: Node, thread: HTMLElement): string | null {
	const element = node instanceof Element ? node : node.parentElement;
	if (!element || !thread.contains(element)) {
		return null;
	}
	return element.closest<HTMLElement>("[data-message-id]")?.dataset.messageId ?? null;
}
