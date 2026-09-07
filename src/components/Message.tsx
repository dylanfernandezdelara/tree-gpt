import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types";
import { IconButton } from "./IconButton";
import {
	CheckIcon,
	CopyIcon,
	RegenerateIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
} from "./Icons";

type Props = {
	message: Message;
	isLast: boolean;
	/** Re-request this reply (regenerate, or retry after an error). */
	onRedo: () => void;
};

export function MessageView({ message, isLast, onRedo }: Props) {
	if (message.role === "user") {
		return (
			<div className="turn turn--user">
				<div className="bubble">{message.content}</div>
			</div>
		);
	}

	if (message.pending) {
		return (
			<div className="turn turn--assistant" aria-busy="true" aria-live="polite">
				<span className="thinking-dot" />
			</div>
		);
	}

	if (message.error) {
		return (
			<div className="turn turn--assistant">
				<div className="error-box" role="alert">
					<span className="error-box__text">{message.content}</span>
					<button type="button" className="error-box__retry" onClick={onRedo}>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="turn turn--assistant">
			<div className="markdown">
				<Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
			</div>
			<AssistantActions content={message.content} isLast={isLast} onRedo={onRedo} />
		</div>
	);
}

type ActionsProps = { content: string; isLast: boolean; onRedo: () => void };

function AssistantActions({ content, isLast, onRedo }: ActionsProps) {
	const [copied, setCopied] = useState(false);
	const [rating, setRating] = useState<"up" | "down" | null>(null);

	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = window.setTimeout(() => setCopied(false), 1500);
		return () => window.clearTimeout(timer);
	}, [copied]);

	async function copy() {
		try {
			await navigator.clipboard.writeText(content);
			setCopied(true);
		} catch {
			// Clipboard access can be blocked (insecure context, permissions).
		}
	}

	return (
		<div className={`actions${isLast ? " actions--visible" : ""}`}>
			<IconButton label={copied ? "Copied" : "Copy"} className="actions__button" onClick={copy}>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</IconButton>
			<IconButton
				label="Good response"
				className="actions__button"
				aria-pressed={rating === "up"}
				onClick={() => setRating(rating === "up" ? null : "up")}
			>
				<ThumbsUpIcon />
			</IconButton>
			<IconButton
				label="Bad response"
				className="actions__button"
				aria-pressed={rating === "down"}
				onClick={() => setRating(rating === "down" ? null : "down")}
			>
				<ThumbsDownIcon />
			</IconButton>
			{isLast ? (
				<IconButton label="Regenerate" className="actions__button" onClick={onRedo}>
					<RegenerateIcon />
				</IconButton>
			) : null}
		</div>
	);
}
