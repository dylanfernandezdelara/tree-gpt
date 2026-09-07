import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type UIEvent,
} from "react";
import type { Chat } from "../types";
import { ArrowDownIcon } from "./Icons";
import { MessageView } from "./Message";

const DISCLAIMER = "treeGPT can make mistakes. Check important info.";

/** How far (px) from the bottom still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 24;
/** Gap between the composer and the bottom edge of the thread area. */
const COMPOSER_MARGIN = 16;
/** Composer height before it is measured: 52px pill + margin. */
const INITIAL_INSET = 52 + COMPOSER_MARGIN;

type Props = {
	chat: Chat;
	onRedo: (messageId: string) => void;
	/** The composer, rendered floating over the bottom of the thread. */
	composer: ReactNode;
};

/**
 * Scrollable conversation with the composer floating over it. Messages and the
 * closing disclaimer scroll behind the composer and show faded beneath it; a
 * scroll-to-bottom button appears while the reader is scrolled up.
 */
export function ChatThread({ chat, onRedo, composer }: Props) {
	const threadRef = useRef<HTMLDivElement>(null);
	const floatRef = useRef<HTMLDivElement>(null);
	const scrolledUpRef = useRef(false);
	const [scrolledUp, setScrolledUp] = useState(false);
	const [inset, setInset] = useState(INITIAL_INSET);
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
			setInset(Math.round(height) + COMPOSER_MARGIN);
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

	function handleScroll(event: UIEvent<HTMLDivElement>) {
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
						<MessageView
							key={message.id}
							message={message}
							isLast={index === count - 1}
							onRedo={() => onRedo(message.id)}
						/>
					))}
					<p className="thread__disclaimer">{DISCLAIMER}</p>
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
			<div className="composer-float" ref={floatRef}>
				{composer}
			</div>
		</div>
	);
}
