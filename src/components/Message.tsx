import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { GlobeIcon, LightbulbIcon, SearchIcon } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import type { Citation, Message, ToolCall } from "../types";
import { IconButton } from "./IconButton";
import {
	CheckIcon,
	CopyIcon,
	RegenerateIcon,
} from "./Icons";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "./ai-elements/chain-of-thought";

/** GFM plus hard breaks: Muse writes `**Title**\\nBody` and CommonMark would
 *  otherwise collapse that single newline into a space ("tangent Fork"). */
const remarkPlugins = [remarkGfm, remarkBreaks];

type Props = {
	message: Message;
	isLast: boolean;
	/** Re-request this reply (regenerate, or retry after an error). */
	onRedo: () => void;
};

export function MessageView({ message, isLast, onRedo }: Props) {
	if (message.role === "user") {
		return (
			<div className="turn turn--user" data-message-id={message.id}>
				<div className="bubble">{message.content}</div>
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

	const content = message.content;

	if (message.pending) {
		return (
			<div className="turn turn--assistant" aria-busy="true" aria-live="polite">
				<Thinking message={message} />
				{content ? (
					<div className="markdown markdown--live">
						<Markdown remarkPlugins={remarkPlugins}>{content}</Markdown>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="turn turn--assistant" data-message-id={message.id}>
			<Thinking message={message} />
			<div className="markdown">
				<Markdown remarkPlugins={remarkPlugins}>{content}</Markdown>
			</div>
			<AssistantActions content={content} isLast={isLast} onRedo={onRedo} />
		</div>
	);
}

/** Roomier line-height so wrapped step labels read as prose, not a cramped chip. */
const stepClass = "leading-6";

/**
 * Thinking + search trace for one assistant turn, live or landed, as one
 * linear rail: reasoning paragraphs, then each search query, then each
 * visited URL. The header (with the orb while live) is the only status word;
 * steps are real activity only. Open while streaming, collapsed to a single
 * "Thought" row once the reply lands.
 */
function Thinking({ message }: { message: Message }) {
	const pending = message.pending === true;
	const toolCalls = message.toolCalls ?? [];
	const citations = message.citations ?? [];
	const paragraphs = reasoningParagraphs(message.reasoning);
	const searching = toolCalls.some((call) => call.state === "input-available");

	if (!pending && toolCalls.length === 0 && citations.length === 0 && paragraphs.length === 0) {
		return null;
	}

	const header = pending ? (searching ? "Searching" : "Thinking") : "Thought";
	// Live turns always get the searching orb; a landed "Thought" keeps the brain icon.
	const icon = pending ? (
		<ThinkingOrb state="searching" size={20} theme="light" className="shrink-0" />
	) : undefined;

	return (
		<ChainOfThought className="mb-3" defaultOpen={pending}>
			<ChainOfThoughtHeader icon={icon}>{header}</ChainOfThoughtHeader>
			<ChainOfThoughtContent className="space-y-3">
				{paragraphs.map((paragraph, index) => (
					<ChainOfThoughtStep
						key={`reasoning-${index}`}
						icon={LightbulbIcon}
						status={pending && !message.content ? "active" : "complete"}
						className={stepClass}
						label={<span className="[overflow-wrap:anywhere]">{paragraph}</span>}
					/>
				))}
				{toolCalls.map((call) => (
					<ChainOfThoughtStep
						key={call.id}
						icon={SearchIcon}
						status={searchStatus(call)}
						className={stepClass}
						label={searchLabel(call)}
					/>
				))}
				{citations.map((citation) => (
					<ChainOfThoughtStep
						key={citation.url}
						icon={GlobeIcon}
						status={pending ? "active" : "complete"}
						className={stepClass}
						label={<CitationLink citation={citation} />}
					/>
				))}
			</ChainOfThoughtContent>
		</ChainOfThought>
	);
}

/** Split display reasoning on blank lines / newlines into one step per paragraph. */
function reasoningParagraphs(reasoning: string | undefined): string[] {
	if (!reasoning) {
		return [];
	}
	return reasoning
		.split(/\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

function searchStatus(call: ToolCall): "active" | "complete" | "pending" {
	switch (call.state) {
		case "input-available":
			return "active";
		case "output-available":
			return "complete";
		case "output-error":
			return "pending";
		default: {
			const exhaustive: never = call.state;
			return exhaustive;
		}
	}
}

/** The query itself when we have one; otherwise a short state word. */
function searchLabel(call: ToolCall): string {
	if (call.query) {
		return call.state === "output-error" ? `Search failed: ${call.query}` : call.query;
	}
	switch (call.state) {
		case "input-available":
			return "Searching the web";
		case "output-available":
			return "Searched the web";
		case "output-error":
			return "Search failed";
		default: {
			const exhaustive: never = call.state;
			return exhaustive;
		}
	}
}

function hostname(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function CitationLink({ citation }: { citation: Citation }) {
	return (
		<a
			href={citation.url}
			target="_blank"
			rel="noopener noreferrer"
			className="text-muted-foreground underline-offset-4 [overflow-wrap:anywhere] hover:text-foreground hover:underline"
		>
			{citation.title ?? hostname(citation.url)}
		</a>
	);
}

type ActionsProps = { content: string; isLast: boolean; onRedo: () => void };

function AssistantActions({ content, isLast, onRedo }: ActionsProps) {
	const [copied, setCopied] = useState(false);

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
			{isLast ? (
				<IconButton label="Regenerate" className="actions__button" onClick={onRedo}>
					<RegenerateIcon />
				</IconButton>
			) : null}
		</div>
	);
}
