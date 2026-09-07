import { useRef, useState, type DragEvent } from "react";
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
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./Icons";
import { ModelSelector } from "./ModelSelector";
import type { ModelId } from "../../worker/tree-types";

/** Where a drop would land: an edge or middle of the body, or the header. */
type DropTarget = DropSide | "swap";

type Props = {
	pane: PaneLeaf;
	chat: Chat | null;
	focused: boolean;
	/** More than one pane is open: show the pane header with its close button. */
	multi: boolean;
	draft: string;
	streaming: boolean;
	busy: boolean;
	/** Global model preference, rendered below this pane's composer. */
	model: ModelId;
	onModelChange: (model: ModelId) => void;
	/** What this pane accepts from the drag in progress. */
	ability: DropAbility;
	/** This pane is the one being dragged. */
	dragging: boolean;
	/** How to label the drag for the cursor: panes move, sidebar chats copy. */
	dropEffect: "move" | "copy";
	onFocus: () => void;
	onClose: () => void;
	onDraftChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	onRedo: (messageId: string) => void;
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
	multi,
	draft,
	streaming,
	busy,
	model,
	onModelChange,
	ability,
	dragging,
	dropEffect,
	onFocus,
	onClose,
	onDraftChange,
	onSend,
	onStop,
	onRedo,
	onDragStart,
	onDragEnd,
	onDrop,
}: Props) {
	// dragenter/dragleave fire for every child; count depth so the preview doesn't flicker.
	const bodyDepthRef = useRef(0);
	const headerDepthRef = useRef(0);
	const [dropSide, setDropSide] = useState<DropSide | null>(null);
	const [headerHover, setHeaderHover] = useState(false);

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

	const composer = (
		<Composer
			value={draft}
			onChange={onDraftChange}
			onSend={onSend}
			onStop={onStop}
			streaming={streaming}
			busy={busy}
			autoFocus={focused}
		/>
	);

	return (
		<section
			className={`pane${focused ? " pane--focused" : ""}`}
			data-pane-id={pane.id}
			onMouseDownCapture={onFocus}
			onFocusCapture={onFocus}
			onDragEnter={handleBodyDragEnter}
			onDragOver={handleBodyDragOver}
			onDragLeave={handleBodyDragLeave}
			onDrop={handleBodyDrop}
		>
			{multi ? (
				<div
					className={headerClass}
					draggable
					onDragStart={handleHeaderDragStart}
					onDragEnd={onDragEnd}
					onDragEnter={handleHeaderDragEnter}
					onDragOver={handleHeaderDragOver}
					onDragLeave={handleHeaderDragLeave}
					onDrop={handleHeaderDrop}
				>
					<span className="pane__title" title={title}>
						{title}
					</span>
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
				<ChatThread chat={chat} onRedo={onRedo} composer={composer} />
			) : (
				<EmptyState>
					<div className="composer-stack">
						{composer}
						<ModelSelector value={model} onChange={onModelChange} />
					</div>
				</EmptyState>
			)}
			<div
				className={`pane__drop${previewSide ? ` pane__drop--visible pane__drop--${previewSide}` : ""}`}
				aria-hidden="true"
			/>
		</section>
	);
}
