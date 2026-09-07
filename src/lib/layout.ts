/**
 * Split-pane layout: a binary tree of panes, each showing one chat (or an
 * empty "new chat"). Pure functions; every update returns a new tree and
 * leaves untouched subtrees as the same object.
 */

export type PaneLeaf = { kind: "pane"; id: string; chatId: string | null };
export type SplitDirection = "row" | "column";
export type SplitNode = {
	kind: "split";
	id: string;
	direction: SplitDirection;
	children: [LayoutNode, LayoutNode];
};
export type LayoutNode = PaneLeaf | SplitNode;

export type DropSide = "left" | "right" | "top" | "bottom" | "center";
export type DragPayload = { chatId: string | null };

/** Drag-and-drop payload type for chats dragged out of the sidebar. */
export const DRAG_MIME = "application/x-treegpt-chat";
/** Beyond this many panes, split drops are ignored (center drops still work). */
export const MAX_PANES = 8;
/** Fraction of a pane's width/height that counts as an edge zone. */
const EDGE_FRACTION = 0.25;

function randomId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPane(chatId: string | null = null): PaneLeaf {
	return { kind: "pane", id: randomId(), chatId };
}

export function listPanes(root: LayoutNode): PaneLeaf[] {
	if (root.kind === "pane") {
		return [root];
	}
	return [...listPanes(root.children[0]), ...listPanes(root.children[1])];
}

export function findPane(root: LayoutNode, paneId: string): PaneLeaf | null {
	return listPanes(root).find((pane) => pane.id === paneId) ?? null;
}

export function firstPane(root: LayoutNode): PaneLeaf {
	return listPanes(root)[0];
}

function replaceLeaf(
	root: LayoutNode,
	paneId: string,
	replace: (leaf: PaneLeaf) => LayoutNode,
): LayoutNode {
	if (root.kind === "pane") {
		return root.id === paneId ? replace(root) : root;
	}
	const [first, second] = root.children;
	const nextFirst = replaceLeaf(first, paneId, replace);
	const nextSecond = replaceLeaf(second, paneId, replace);
	return nextFirst === first && nextSecond === second
		? root
		: { ...root, children: [nextFirst, nextSecond] };
}

export function setPaneChat(root: LayoutNode, paneId: string, chatId: string | null): LayoutNode {
	return replaceLeaf(root, paneId, (leaf) => (leaf.chatId === chatId ? leaf : { ...leaf, chatId }));
}

/**
 * Split a pane along one edge. The new pane takes the dropped side:
 * left/top → new pane first, right/bottom → new pane second.
 */
export function splitPane(
	root: LayoutNode,
	paneId: string,
	side: Exclude<DropSide, "center">,
	chatId: string | null,
): { root: LayoutNode; newPaneId: string } {
	const fresh = createPane(chatId);
	const direction: SplitDirection = side === "left" || side === "right" ? "row" : "column";
	const freshFirst = side === "left" || side === "top";
	const next = replaceLeaf(root, paneId, (leaf) => ({
		kind: "split",
		id: randomId(),
		direction,
		children: freshFirst ? [fresh, leaf] : [leaf, fresh],
	}));
	return { root: next, newPaneId: fresh.id };
}

/** Remove a pane; its sibling takes the parent's place. The last pane is emptied instead. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode {
	if (root.kind === "pane") {
		return root.id === paneId ? { ...root, chatId: null } : root;
	}
	const [first, second] = root.children;
	if (first.kind === "pane" && first.id === paneId) {
		return second;
	}
	if (second.kind === "pane" && second.id === paneId) {
		return first;
	}
	const nextFirst = removePane(first, paneId);
	const nextSecond = removePane(second, paneId);
	return nextFirst === first && nextSecond === second
		? root
		: { ...root, children: [nextFirst, nextSecond] };
}

/** Empty every pane showing a chat (used when the chat is deleted). */
export function clearChat(root: LayoutNode, chatId: string): LayoutNode {
	if (root.kind === "pane") {
		return root.chatId === chatId ? { ...root, chatId: null } : root;
	}
	const [first, second] = root.children;
	const nextFirst = clearChat(first, chatId);
	const nextSecond = clearChat(second, chatId);
	return nextFirst === first && nextSecond === second
		? root
		: { ...root, children: [nextFirst, nextSecond] };
}

/** Rebuild a stored layout, dropping references to chats that no longer exist. */
export function validateLayout(value: unknown, chatIds: ReadonlySet<string>): LayoutNode | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const node = value as Record<string, unknown>;
	if (node.kind === "pane") {
		if (typeof node.id !== "string") {
			return null;
		}
		const chatId = typeof node.chatId === "string" && chatIds.has(node.chatId) ? node.chatId : null;
		return { kind: "pane", id: node.id, chatId };
	}
	if (node.kind === "split") {
		if (
			typeof node.id !== "string" ||
			(node.direction !== "row" && node.direction !== "column") ||
			!Array.isArray(node.children) ||
			node.children.length !== 2
		) {
			return null;
		}
		const first = validateLayout(node.children[0], chatIds);
		const second = validateLayout(node.children[1], chatIds);
		if (!first || !second) {
			return null;
		}
		return { kind: "split", id: node.id, direction: node.direction, children: [first, second] };
	}
	return null;
}

/** Which drop zone a pointer at (x, y) inside a pane of the given size is over. */
export function dropSideAt(x: number, y: number, width: number, height: number): DropSide {
	if (width <= 0 || height <= 0) {
		return "center";
	}
	const nx = Math.min(Math.max(x / width, 0), 1);
	const ny = Math.min(Math.max(y / height, 0), 1);
	const dx = Math.min(nx, 1 - nx);
	const dy = Math.min(ny, 1 - ny);
	if (dx > EDGE_FRACTION && dy > EDGE_FRACTION) {
		return "center";
	}
	if (dx < dy) {
		return nx < 0.5 ? "left" : "right";
	}
	return ny < 0.5 ? "top" : "bottom";
}

export function writeDragPayload(
	dataTransfer: DataTransfer,
	payload: DragPayload,
	label: string,
): void {
	dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
	dataTransfer.setData("text/plain", label);
	dataTransfer.effectAllowed = "copy";
}

export function hasDragPayload(dataTransfer: DataTransfer): boolean {
	return Array.from(dataTransfer.types).includes(DRAG_MIME);
}

export function readDragPayload(dataTransfer: DataTransfer): DragPayload | null {
	const raw = dataTransfer.getData(DRAG_MIME);
	if (!raw) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return null;
		}
		const chatId = (parsed as Record<string, unknown>).chatId;
		return { chatId: typeof chatId === "string" ? chatId : null };
	} catch {
		return null;
	}
}
