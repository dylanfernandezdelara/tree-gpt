import { ForkIcon, SidebarIcon, TreeIcon } from "../components/Icons";

/**
 * Shown on an empty chat, one at random per window, so the screen teaches
 * something about Fork instead of just greeting. Each icon is the one that
 * feature already uses elsewhere, so the symbol is learned alongside the idea.
 */
export const BLURBS = [
	{
		Icon: ForkIcon,
		title: "Fork a tangent",
		body: "Highlight any part of a reply and press Fork to branch a new conversation from it.",
	},
	{
		Icon: SidebarIcon,
		title: "Work side by side",
		body: "Drag a chat from the sidebar onto the edge of a window to split the screen.",
	},
	{
		Icon: TreeIcon,
		title: "Many paths",
		body: "Fork turns any passage into its own conversation, so you can chase a tangent and still come back.",
	},
] as const;

export type Blurb = (typeof BLURBS)[number];

/**
 * The blurb for one window, derived from its pane id rather than drawn on
 * mount. Splitting or rearranging moves a pane to a new position in the React
 * tree, which remounts it -- a pick held in state would be redrawn every time,
 * so a window's tip would change out from under the reader. Hashing the id
 * instead fixes each window's tip for as long as that window exists, while a
 * newly created pane gets a fresh id and so an independent tip.
 */
export function blurbFor(paneId: string): Blurb {
	// FNV-1a: cheap, and spreads UUIDs evenly enough across a handful of buckets.
	let hash = 0x811c9dc5;
	for (let i = 0; i < paneId.length; i++) {
		hash ^= paneId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return BLURBS[hash % BLURBS.length];
}
