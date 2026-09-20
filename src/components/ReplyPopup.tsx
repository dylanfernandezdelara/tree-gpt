import { useEffect, useRef } from "react";
import type { Chat } from "../types";
import { Composer } from "./Composer";
import { IconButton } from "./IconButton";
import { ForkIcon } from "./Icons";
import { MessageView } from "./Message";

type Props = {
	/** The fork behind this popup, once the first send has created it. */
	chat: Chat | null;
	/** How many messages the fork inherited; everything after is the new exchange. */
	carried: number;
	/** The highlighted passage this reply began from, previewed until it sends. */
	quote?: string;
	draft: string;
	streaming: boolean;
	busy: boolean;
	onDraftChange: (value: string) => void;
	onSend: () => void;
	/** Retry a reply that failed. The only action a compact turn still shows. */
	onRedo: (messageId: string) => void;
	onStop: () => void;
	/** Promote to a full pane, where the carried conversation shows in full. */
	onPromote: () => void;
	onClose: () => void;
};

/**
 * A short conversation inside the message it hangs from. Shows only the turns
 * added beyond what the fork carried, so it reads like a texting window rather
 * than a second copy of the conversation above it.
 */
export function ReplyPopup({
	chat,
	carried,
	quote,
	draft,
	streaming,
	busy,
	onDraftChange,
	onSend,
	onRedo,
	onStop,
	onPromote,
	onClose,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);

	// Click-away closes it. Pointerdown rather than click, so it cannot be
	// swallowed by something that stops the later event.
	useEffect(() => {
		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [onClose]);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const exchange = chat ? chat.messages.slice(carried) : [];

	return (
		<div className="reply" ref={rootRef}>
			{exchange.length > 0 ? (
				<div className="reply__thread">
					{exchange.map((message, index) => (
						<MessageView
							key={message.id}
							message={message}
							isLast={index === exchange.length - 1}
							compact
							onRedo={() => onRedo(message.id)}
							onFork={() => {}}
							onReply={() => {}}
						/>
					))}
				</div>
			) : null}
			{quote && !chat ? (
				/*
				 * A preview of what this reply is about, only until the first
				 * send makes the passage the opening message above. Keeping it
				 * afterwards would show the passage twice in a box this small.
				 */
				<div className="reply__quote">
					<p className="reply__quote-text">{quote}</p>
				</div>
			) : null}
			<div className="reply__composer">
				<Composer
					value={draft}
					onChange={onDraftChange}
					onSend={onSend}
					onStop={onStop}
					streaming={streaming}
					busy={busy}
					autoFocus
				/>
				<IconButton
					label="Fork to new chat"
					title="Fork to new chat"
					className="reply__promote"
					disabled={!chat}
					onClick={onPromote}
				>
					<ForkIcon />
				</IconButton>
			</div>
		</div>
	);
}
