/**
 * Split-pane layout: a binary tree of panes, each showing one chat (or an
 * empty "new chat"). Pure functions; every update returns a new tree and
 * leaves untouched subtrees as the same object.
 */

import { newId } from "./id";

export type PaneLeaf = { kind: "pane"; id: string; chatId: string | null };
export type SplitDirection = "row" | "column";
export type SplitNode = {
	kind: "split";
	id: string;
	direction: SplitDirection;
	/** Percentage of the group the sized child holds; the other child fills the rest. */
	size: number;
	/** Which child is the sized one. It follows the pane across swaps, so a swapped pane keeps its width instead of remounting. */
	sized: 0 | 1;
	children: [LayoutNode, LayoutNode];
};
export type LayoutNode = PaneLeaf | SplitNode;

export type DropSide = "left" | "right" | "top" | "bottom" | "center";

/** What is being dragged: a chat out of the sidebar, or a pane by its header. */
export type DragPayload =
	| { kind: "chat"; chatId: string | null }
	| { kind: "pane"; paneId: string };

/** Drag-and-drop payload type for chats dragged out of the sidebar. */
export const DRAG_MIME = "application/x-treegpt-chat";
/**
 * A pane may never become narrower or shorter than a quarter of the screen,
 * so each axis supports at most 2^2 = 4 divisions. That bounds the layout to
 * a 4x4 grid: every pane covers at least 1/16 of the area, so at most 16 fit.
 */
export const MAX_AXIS_DEPTH = 2;
/** Implied by MAX_AXIS_DEPTH; kept as an explicit guard. */
export const MAX_PANES = 16;
/** Fraction of a pane's width/height that counts as an edge zone. */
const EDGE_FRACTION = 0.25;
/** Percentage a fresh split gives its sized child: an even half, as before. */
const DEFAULT_SIZE = 50;
/** Stored sizes stay strictly inside the group; the divider clamps tighter at render. */
const MIN_SIZE = 1;
const MAX_SIZE = 99;

function clampSize(size: number): number {
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

export function createPane(chatId: string | null = null): PaneLeaf {
	return { kind: "pane", id: newId(), chatId };
}

export function listPanes(root: LayoutNode): PaneLeaf[] {
	if (root.kind === "pane") {
		return [root];
	}
	return [...listPanes(root.children[0]), ...listPanes(root.children[1])];
}

/** Splits above a pane, per direction: how many times its width and height were halved. */
export type PaneDepth = { row: number; column: number };

export function paneDepth(root: LayoutNode, paneId: string): PaneDepth | null {
	function walk(node: LayoutNode, row: number, column: number): PaneDepth | null {
		if (node.kind === "pane") {
			return node.id === paneId ? { row, column } : null;
		}
		const nextRow = node.direction === "row" ? row + 1 : row;
		const nextColumn = node.direction === "column" ? column + 1 : column;
		return (
			walk(node.children[0], nextRow, nextColumn) ??
			walk(node.children[1], nextRow, nextColumn)
		);
	}
	return walk(root, 0, 0);
}

/** Which axes a pane can still be split along without dropping below a quarter of the screen. */
export type SplitAbility = { horizontal: boolean; vertical: boolean };

export function splitAbility(root: LayoutNode, paneId: string): SplitAbility {
	const depth = listPanes(root).length >= MAX_PANES ? null : paneDepth(root, paneId);
	if (!depth) {
		return { horizontal: false, vertical: false };
	}
	return {
		horizontal: depth.row < MAX_AXIS_DEPTH,
		vertical: depth.column < MAX_AXIS_DEPTH,
	};
}

/** Whether a split on one edge is allowed; `center` (replace) is always allowed. */
export function canSplit(root: LayoutNode, paneId: string, side: DropSide): boolean {
	if (side === "center") {
		return true;
	}
	const ability = splitAbility(root, paneId);
	return side === "left" || side === "right" ? ability.horizontal : ability.vertical;
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
 * Put an existing leaf on one edge of a pane, splitting it. The leaf takes the
 * dropped side: left/top → leaf first, right/bottom → leaf second.
 */
function attach(
	root: LayoutNode,
	paneId: string,
	side: Exclude<DropSide, "center">,
	leaf: PaneLeaf,
): LayoutNode {
	const direction: SplitDirection = side === "left" || side === "right" ? "row" : "column";
	const leafFirst = side === "left" || side === "top";
	return replaceLeaf(root, paneId, (target) => ({
		kind: "split",
		id: newId(),
		direction,
		size: DEFAULT_SIZE,
		sized: 0,
		children: leafFirst ? [leaf, target] : [target, leaf],
	}));
}

/** Split a pane along one edge, putting a new pane holding `chatId` on that side. */
export function splitPane(
	root: LayoutNode,
	paneId: string,
	side: Exclude<DropSide, "center">,
	chatId: string | null,
): { root: LayoutNode; newPaneId: string } {
	const fresh = createPane(chatId);
	return { root: attach(root, paneId, side, fresh), newPaneId: fresh.id };
}

/**
 * Move a pane onto one edge of another. It is pruned from its old position
 * first, so its former sibling expands to fill the gap. The same leaf object
 * is re-attached, keeping the pane id and therefore its draft.
 */
export function movePane(
	root: LayoutNode,
	sourceId: string,
	targetId: string,
	side: Exclude<DropSide, "center">,
): LayoutNode {
	if (sourceId === targetId) {
		return root;
	}
	const source = findPane(root, sourceId);
	if (!source) {
		return root;
	}
	const pruned = removePane(root, sourceId);
	if (!findPane(pruned, targetId)) {
		return root;
	}
	return attach(pruned, targetId, side, source);
}

/**
 * Exchange two panes' positions. One traversal on purpose: replacing them one
 * after the other would briefly leave two leaves sharing an id. Siblings take
 * their sizes with them, so each keeps its sized/filling role and neither
 * remounts; across splits the panes remount either way, so those splits keep
 * their geometry.
 */
export function swapPanes(root: LayoutNode, aId: string, bId: string): LayoutNode {
	if (aId === bId) {
		return root;
	}
	const a = findPane(root, aId);
	const b = findPane(root, bId);
	if (!a || !b) {
		return root;
	}
	function walk(node: LayoutNode): LayoutNode {
		if (node.kind === "pane") {
			if (node.id === aId) {
				return b as PaneLeaf;
			}
			return node.id === bId ? (a as PaneLeaf) : node;
		}
		const [first, second] = node.children;
		if (
			(first.id === aId && second.id === bId) ||
			(first.id === bId && second.id === aId)
		) {
			return { ...node, sized: node.sized === 0 ? 1 : 0, children: [second, first] };
		}
		const nextFirst = walk(first);
		const nextSecond = walk(second);
		return nextFirst === first && nextSecond === second
			? node
			: { ...node, children: [nextFirst, nextSecond] };
	}
	return walk(root);
}

/** Resize a split: its sized child takes `size` percent of the group. Unknown splits and non-finite sizes are ignored. */
export function setSplitSize(root: LayoutNode, splitId: string, size: number): LayoutNode {
	if (!Number.isFinite(size)) {
		return root;
	}
	const clamped = clampSize(size);
	function walk(node: LayoutNode): LayoutNode {
		if (node.kind === "pane") {
			return node;
		}
		if (node.id === splitId) {
			return node.size === clamped ? node : { ...node, size: clamped };
		}
		const [first, second] = node.children;
		const nextFirst = walk(first);
		const nextSecond = walk(second);
		return nextFirst === first && nextSecond === second
			? node
			: { ...node, children: [nextFirst, nextSecond] };
	}
	return walk(root);
}

/**
 * The pane immediately to the right, or null when this pane is in the
 * rightmost column. Walks the path back to the deepest row split that was
 * entered on its left side, then takes the first pane on the right side.
 */
export function rightNeighbor(root: LayoutNode, paneId: string): PaneLeaf | null {
	const splits: SplitNode[] = [];
	const sides: (0 | 1)[] = [];
	function find(node: LayoutNode): boolean {
		if (node.kind === "pane") {
			return node.id === paneId;
		}
		for (const side of [0, 1] as const) {
			splits.push(node);
			sides.push(side);
			if (find(node.children[side])) {
				return true;
			}
			splits.pop();
			sides.pop();
		}
		return false;
	}
	if (!find(root)) {
		return null;
	}
	for (let i = splits.length - 1; i >= 0; i--) {
		if (splits[i].direction === "row" && sides[i] === 0) {
			return firstPane(splits[i].children[1]);
		}
	}
	return null;
}

/**
 * Which way to halve a pane of this shape so both halves stay as square as
 * possible. Splitting sideways gives halves of w/2 x h, downward w x h/2, so
 * the wider pane splits sideways and the taller one splits down. A square pane
 * is a tie, broken towards "right" to match how a full screen first divides.
 */
export function squarestSplit(width: number, height: number): "right" | "bottom" {
	return width >= height ? "right" : "bottom";
}

/**
 * Put a chat next to a pane, splitting whichever way keeps both halves closest
 * to square. Falls back through replacing the pane already on the right, then
 * the other axis, and finally taking over the pane itself, so there is always
 * somewhere to land. Returns the pane the chat ended up in.
 */
export function placeBeside(
	root: LayoutNode,
	paneId: string,
	chatId: string | null,
	prefer: "right" | "bottom" = "right",
): { root: LayoutNode; paneId: string } {
	if (!findPane(root, paneId)) {
		return { root, paneId };
	}
	if (canSplit(root, paneId, prefer)) {
		const split = splitPane(root, paneId, prefer, chatId);
		return { root: split.root, paneId: split.newPaneId };
	}
	const neighbor = rightNeighbor(root, paneId);
	if (neighbor) {
		return { root: setPaneChat(root, neighbor.id, chatId), paneId: neighbor.id };
	}
	const other = prefer === "right" ? "bottom" : "right";
	if (canSplit(root, paneId, other)) {
		const split = splitPane(root, paneId, other, chatId);
		return { root: split.root, paneId: split.newPaneId };
	}
	return { root: setPaneChat(root, paneId, chatId), paneId };
}

/** Every drop target a pane offers for the drag in progress. */
export type DropAbility = {
	sides: Record<DropSide, boolean>;
	/** Dropping on this pane's header does something. */
	swap: boolean;
};

/** Accepts nothing: used where dragging must not rearrange anything. */
export const NO_DROPS: DropAbility = {
	sides: { left: false, right: false, top: false, bottom: false, center: false },
	swap: false,
};

/**
 * What the pane `targetPaneId` accepts from the drag in progress. Drives both
 * the hover preview and the drop handler, so they can never disagree.
 */
export function dropAbility(
	root: LayoutNode,
	targetPaneId: string,
	payload: DragPayload | null,
): DropAbility {
	if (!payload) {
		return NO_DROPS;
	}
	if (payload.kind === "chat") {
		const ability = splitAbility(root, targetPaneId);
		return {
			sides: {
				left: ability.horizontal,
				right: ability.horizontal,
				top: ability.vertical,
				bottom: ability.vertical,
				center: true,
			},
			swap: true,
		};
	}
	if (payload.paneId === targetPaneId) {
		return NO_DROPS;
	}
	// A move frees the source's slot first, which can reclaim depth for the target.
	const pruned = removePane(root, payload.paneId);
	const ability = findPane(pruned, targetPaneId)
		? splitAbility(pruned, targetPaneId)
		: { horizontal: false, vertical: false };
	return {
		sides: {
			left: ability.horizontal,
			right: ability.horizontal,
			top: ability.vertical,
			bottom: ability.vertical,
			// Dropping a window onto another window trades places, like the header.
			center: true,
		},
		swap: true,
	};
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
		// Layouts saved before dividers existed carry no sizes; they read as an even half.
		const size =
			typeof node.size === "number" && Number.isFinite(node.size)
				? clampSize(node.size)
				: DEFAULT_SIZE;
		const sized: 0 | 1 = node.sized === 1 ? 1 : 0;
		return {
			kind: "split",
			id: node.id,
			direction: node.direction,
			size,
			sized,
			children: [first, second],
		};
	}
	return null;
}

/** Measured box of a pane on screen, read once when a pointer move starts. */
export type PaneRect = {
	paneId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Swap-by-header band at the top; 0 when the pane shows no header. */
	headerHeight: number;
};

/** Half the divider strip: rects inflate by this so a pointer over a seam still hits a pane. */
const SEAM_HALF = 8;

/**
 * Which pane a pointer at (x, y) is over during a pane move, and what dropping
 * there would do: the header band swaps, the body splits by edge zone. The
 * moving pane itself is excluded; dropping on its own slot cancels.
 */
export function pointerTargetAt(
	rects: readonly PaneRect[],
	x: number,
	y: number,
	excludeId: string,
): { paneId: string; target: DropSide | "swap" } | null {
	for (const rect of rects) {
		if (rect.paneId === excludeId) {
			continue;
		}
		if (
			x < rect.x - SEAM_HALF ||
			x > rect.x + rect.width + SEAM_HALF ||
			y < rect.y - SEAM_HALF ||
			y > rect.y + rect.height + SEAM_HALF
		) {
			continue;
		}
		if (rect.headerHeight > 0 && y - rect.y < rect.headerHeight) {
			return { paneId: rect.paneId, target: "swap" };
		}
		return {
			paneId: rect.paneId,
			target: dropSideAt(x - rect.x, y - rect.y, rect.width, rect.height),
		};
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
	// Both are permitted: a sidebar chat is copied into a pane, a pane is moved.
	// A dropEffect outside effectAllowed makes the browser refuse the drop.
	dataTransfer.effectAllowed = "copyMove";
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
		const record = parsed as Record<string, unknown>;
		if (record.kind === "pane") {
			return typeof record.paneId === "string" ? { kind: "pane", paneId: record.paneId } : null;
		}
		if (record.kind === "chat") {
			return {
				kind: "chat",
				chatId: typeof record.chatId === "string" ? record.chatId : null,
			};
		}
		return null;
	} catch {
		return null;
	}
}
