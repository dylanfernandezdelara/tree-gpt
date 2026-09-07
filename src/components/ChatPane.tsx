import { useRef, useState, type DragEvent } from "react";
import {
	dropSideAt,
	hasDragPayload,
	readDragPayload,
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
	onFocus: () => void;
	onClose: () => void;
	onDraftChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	onRedo: (messageId: string) => void;
	/** A chat (or "new chat" as null) was dropped on this pane. */
	onDrop: (side: DropSide, chatId: string | null) => void;
};

/** One conversation view; also a drop target for splitting. */
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
	onFocus,
	onClose,
	onDraftChange,
	onSend,
	onStop,
	onRedo,
	onDrop,
}: Props) {
	// dragenter/dragleave fire for every child; count depth so the overlay doesn't flicker.
	const dragDepthRef = useRef(0);
	const [dropSide, setDropSide] = useState<DropSide | null>(null);

	function sideFromEvent(event: DragEvent<HTMLElement>): DropSide {
		const rect = event.currentTarget.getBoundingClientRect();
		return dropSideAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
	}

	function handleDragEnter(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		dragDepthRef.current += 1;
		setDropSide(sideFromEvent(event));
	}

	function handleDragOver(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		const side = sideFromEvent(event);
		setDropSide((previous) => (previous === side ? previous : side));
	}

	function handleDragLeave(event: DragEvent<HTMLElement>) {
		if (!hasDragPayload(event.dataTransfer)) {
			return;
		}
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) {
			setDropSide(null);
		}
	}

	function handleDrop(event: DragEvent<HTMLElement>) {
		const payload = readDragPayload(event.dataTransfer);
		dragDepthRef.current = 0;
		setDropSide(null);
		if (!payload) {
			return;
		}
		event.preventDefault();
		onDrop(sideFromEvent(event), payload.chatId);
	}

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
	const title = chat ? chat.title : "New chat";

	return (
		<section
			className={`pane${focused ? " pane--focused" : ""}`}
			data-pane-id={pane.id}
			onMouseDownCapture={onFocus}
			onFocusCapture={onFocus}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{multi ? (
				<div className="pane__header">
					<span className="pane__title" title={title}>
						{title}
					</span>
					<IconButton label="Close pane" className="pane__close" onClick={onClose}>
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
				className={`pane__drop${dropSide ? ` pane__drop--visible pane__drop--${dropSide}` : ""}`}
				aria-hidden="true"
			/>
		</section>
	);
}
