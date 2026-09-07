import { useEffect, useRef } from "react";
import type { Chat } from "../types";
import { MessageView } from "./Message";

type Props = {
	chat: Chat;
	onRedo: (messageId: string) => void;
};

export function ChatThread({ chat, onRedo }: Props) {
	const threadRef = useRef<HTMLDivElement>(null);
	const count = chat.messages.length;
	const last = chat.messages[count - 1];
	const lastId = last?.id;
	const lastPending = last?.pending === true;

	// Keep the newest turn in view when a chat opens, a message is added, or a reply lands.
	useEffect(() => {
		const thread = threadRef.current;
		if (thread) {
			thread.scrollTop = thread.scrollHeight;
		}
	}, [chat.id, count, lastId, lastPending]);

	return (
		<div className="thread" ref={threadRef}>
			<div className="thread__inner">
				{chat.messages.map((message, index) => (
					<MessageView
						key={message.id}
						message={message}
						isLast={index === count - 1}
						onRedo={() => onRedo(message.id)}
					/>
				))}
			</div>
		</div>
	);
}
