import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { GlobeIcon, SearchIcon } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import { normalizeMath } from "../lib/math";
import type { Citation, Message, ToolCall } from "../types";
import { IconButton } from "./IconButton";
import {
	CheckIcon,
	CopyIcon,
	ForkIcon,
	ReplyIcon,
	RegenerateIcon,
} from "./Icons";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "./ai-elements/chain-of-thought";

/** GFM plus hard breaks: Muse writes `**Title**\nBody` and CommonMark would
 *  otherwise collapse that single newline into a space ("tangent Fork").
 *  remark-math + KaTeX typeset math that `normalizeMath` has put in `$`
 *  delimiters; throwOnError: false keeps malformed or half-streamed TeX from
 *  crashing the render. The KaTeX CSS rides this lazy chunk, not the login. */
const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath];
const rehypePlugins: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false }]];

type Props = {
	message: Message;
	isLast: boolean;
	/** Re-request this reply (regenerate, or retry after an error). */
	onRedo: () => void;
	/** Fork the conversation from this message, carrying everything up to it. */
	onFork: () => void;
	/** Open a reply popup inside this message. */
	onReply: () => void;
	/** Inside a reply popup: no action row, so replies cannot nest. */
	compact?: boolean;
	/** The reply popup for this message, rendered under it when open. */
	reply?: ReactNode;
};

/**
 * One turn, memoized on the message itself: chats update immutably, so an
 * unchanged message object means unchanged output, and layout-only commits
 * (swaps, resizes) skip every markdown re-parse. `onRedo` is deliberately
 * ignored -- a fresh closure each render, but the same message always redoes
 * the same way.
 */
export const MessageView = memo(
	function MessageView({ message, isLast, onRedo, onFork, onReply, compact, reply }: Props) {
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
						<Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
							{normalizeMath(content)}
						</Markdown>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="turn turn--assistant" data-message-id={message.id}>
			<Thinking message={message} />
			<div className="markdown">
				<Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
					{normalizeMath(content)}
				</Markdown>
			</div>
			{reply}
			{compact ? null : (
				<AssistantActions
					content={content}
					isLast={isLast}
					onRedo={onRedo}
					onFork={onFork}
					onReply={onReply}
				/>
			)}
		</div>
	);
	},
	(prev, next) =>
		prev.message === next.message &&
		prev.isLast === next.isLast &&
		// An open popup changes neither of the above, so it must be compared too.
		prev.reply === next.reply &&
		prev.compact === next.compact,
);

/** Roomier line-height so wrapped step labels read as prose, not a cramped chip. */
const stepClass = "leading-6";

/**
 * Thinking + search trace for one assistant turn, live or landed.
 * Reasoning is a stream of consciousness (not step chips): visible while
 * tokens arrive, then tucked into the collapsed "Thought" row. Search
 * queries and visited URLs stay on the rail as steps.
 */
function Thinking({ message }: { message: Message }) {
	const pending = message.pending === true;
	const toolCalls = message.toolCalls ?? [];
	const citations = message.citations ?? [];
	const reasoning = message.reasoning ?? "";
	const hasReasoning = reasoning.trim().length > 0;
	const searching = toolCalls.some((call) => call.state === "input-available");
	const [open, setOpen] = useState(pending);

	useEffect(() => {
		setOpen(pending);
	}, [pending]);

	if (!pending && toolCalls.length === 0 && citations.length === 0 && !hasReasoning) {
		return null;
	}

	const header = pending ? (searching ? "Searching" : "Thinking") : "Thought";
	// Live turns always get the searching orb; a landed "Thought" keeps the brain icon.
	const icon = pending ? (
		<ThinkingOrb state="searching" size={20} theme="light" className="shrink-0" />
	) : undefined;

	return (
		<ChainOfThought className="mb-3" open={pending || open} onOpenChange={setOpen}>
			<ChainOfThoughtHeader icon={icon}>{header}</ChainOfThoughtHeader>
			{pending && hasReasoning ? <ReasoningTrace text={reasoning} live /> : null}
			{(!pending && hasReasoning) || toolCalls.length > 0 || citations.length > 0 ? (
				<ChainOfThoughtContent className="space-y-3">
					{!pending && hasReasoning ? <ReasoningTrace text={reasoning} /> : null}
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
			) : null}
		</ChainOfThought>
	);
}

/** Display-only thinking trace: growing prose live, readable after the turn. */
function ReasoningTrace({ text, live }: { text: string; live?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!live) {
			return;
		}
		const node = ref.current;
		if (node) {
			node.scrollTop = node.scrollHeight;
		}
	}, [text, live]);

	return (
		<div
			ref={ref}
			className={
				live
					? "mt-2 max-h-48 overflow-y-auto text-sm leading-6 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
					: "text-sm leading-6 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
			}
		>
			{text}
		</div>
	);
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

type ActionsProps = {
	content: string;
	isLast: boolean;
	onRedo: () => void;
	onFork: () => void;
	onReply: () => void;
};

function AssistantActions({ content, isLast, onRedo, onFork, onReply }: ActionsProps) {
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
			<IconButton label="Reply" className="actions__button" onClick={onReply}>
				<ReplyIcon />
			</IconButton>
			<IconButton
				label="Fork from here"
				title="Fork from here"
				className="actions__button"
				onClick={onFork}
			>
				<ForkIcon />
			</IconButton>
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
