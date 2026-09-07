import { useRef, type PointerEvent, type ReactNode } from "react";
import { useAutoHideScrollbar } from "../lib/use-auto-hide-scrollbar";
import { visualScale } from "../lib/zoom";
import type { Bookmark, Chat } from "../types";
import { IconButton } from "./IconButton";
import { BookmarkFilledIcon } from "./Icons";

const MIN_WIDTH = 280;
/** Never let the list crowd out the conversation. */
const MAX_FRACTION = 0.7;

type Props = {
	bookmarks: Bookmark[];
	chatsById: Map<string, Chat>;
	/** Chats currently on screen, so their rows read as selected. */
	openChatIds: ReadonlySet<string>;
	width: number;
	onWidthChange: (width: number) => void;
	onOpen: (bookmark: Bookmark) => void;
	onRemove: (id: string) => void;
	/** The conversation window, or nothing when none is open yet. */
	children: ReactNode;
	hasPanes: boolean;
};

/**
 * Saved passages, filling the screen until one is opened; the conversation it
 * came from then takes the right, behind a draggable border.
 */
export function BookmarksView({
	bookmarks,
	chatsById,
	openChatIds,
	width,
	onWidthChange,
	onOpen,
	onRemove,
	children,
	hasPanes,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useAutoHideScrollbar(listRef);

	function handleResize(event: PointerEvent<HTMLDivElement>) {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
			return;
		}
		const root = rootRef.current;
		if (!root) {
			return;
		}
		// clientX is in visual pixels; the width written back is in CSS pixels.
		const scale = visualScale(root);
		const next = (event.clientX - root.getBoundingClientRect().left) / scale;
		onWidthChange(Math.min(Math.max(next, MIN_WIDTH), root.offsetWidth * MAX_FRACTION));
	}

	function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	}

	return (
		<div className="bookmarks" ref={rootRef}>
			<div
				ref={listRef}
				className={`bookmarks__list${hasPanes ? "" : " bookmarks__list--full"}`}
				style={hasPanes ? { width } : undefined}
			>
				<div className="bookmarks__header">
					<h2 className="bookmarks__title">Bookmarks</h2>
					<span className="bookmarks__count">{bookmarks.length}</span>
				</div>
				{bookmarks.length === 0 ? (
					<p className="bookmarks__empty">
						Highlight any passage in a conversation and choose Bookmark to save it here.
					</p>
				) : (
					<ul className="bookmarks__rows">
						{bookmarks.map((bookmark) => (
							<li key={bookmark.id}>
								<div
									className={`bookmark-row${
										openChatIds.has(bookmark.chatId) ? " bookmark-row--open" : ""
									}`}
								>
									<button
										type="button"
										className="bookmark-row__open"
										onClick={() => onOpen(bookmark)}
										title={bookmark.quote}
									>
										<span className="bookmark-row__chat">
											{chatsById.get(bookmark.chatId)?.title ?? "Deleted chat"}
										</span>
										<span className="bookmark-row__date">{formatDate(bookmark.createdAt)}</span>
										<span className="bookmark-row__snippet">{bookmark.quote}</span>
									</button>
									<IconButton
										label="Remove bookmark"
										className="bookmark-row__toggle"
										onClick={() => onRemove(bookmark.id)}
									>
										<BookmarkFilledIcon />
									</IconButton>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
			{hasPanes ? (
				<>
					<div
						className="bookmarks__resizer"
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize bookmarks list"
						onPointerDown={handleResize}
						onPointerMove={handleResizeMove}
						onPointerUp={handleResizeEnd}
						onPointerCancel={handleResizeEnd}
					/>
					<div className="bookmarks__panes">{children}</div>
				</>
			) : null}
		</div>
	);
}

/** Today shows a time, anything older shows a short date. */
function formatDate(at: number): string {
	const date = new Date(at);
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	return sameDay
		? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
		: date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
