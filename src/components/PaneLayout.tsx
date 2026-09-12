import { Group, Panel, Separator } from "motion-panels/react";
import type { ReactNode } from "react";
import type { LayoutNode, PaneLeaf, SplitNode } from "../lib/layout";

type Props = {
	root: LayoutNode;
	renderPane: (pane: PaneLeaf) => ReactNode;
	/** A divider was pulled; the size is a percentage of its group. */
	onResize: (splitId: string, size: number) => void;
};

/**
 * Narrowest a pane pulls down to, in px. The divider clamps to the room the
 * other panes leave, so this never over-constrains a small screen.
 */
const MIN_PANE = 200;

/** Renders the split tree as motion panels: one group per split, a divider between its children. */
export function PaneLayout({ root, renderPane, onResize }: Props) {
	if (root.kind === "pane") {
		return <>{renderPane(root)}</>;
	}
	const [first, second] = root.children;
	// Keys live here, on the group's direct children: that is what lets React
	// move (not remount) panes on a swap and what triggers the group's glide.
	// The group itself is keyed by split: orientation is mount-only state, so
	// a new split in this slot must mount fresh rather than inherit the axis.
	return (
		<Group
			key={root.id}
			orientation={root.direction === "row" ? "horizontal" : "vertical"}
		>
			<SplitChild
				key={first.id}
				node={first}
				split={root}
				renderPane={renderPane}
				onResize={onResize}
			/>
			<Separator />
			<SplitChild
				key={second.id}
				node={second}
				split={root}
				renderPane={renderPane}
				onResize={onResize}
			/>
		</Group>
	);
}

function SplitChild({
	node,
	split,
	renderPane,
	onResize,
}: {
	node: LayoutNode;
	split: SplitNode;
	renderPane: (pane: PaneLeaf) => ReactNode;
	onResize: (splitId: string, size: number) => void;
}) {
	const content =
		node.kind === "pane" ? (
			renderPane(node)
		) : (
			<PaneLayout root={node} renderPane={renderPane} onResize={onResize} />
		);
	// The panel keeps the pane's flex layout so a chat fills it as before.
	const style = { display: "flex" };
	if (split.children[split.sized].id !== node.id) {
		return (
			<Panel key={node.id} style={style}>
				{content}
			</Panel>
		);
	}
	return (
		<Panel
			key={node.id}
			size={`${split.size}%` as `${number}%`}
			defaultSize="50%"
			minSize={MIN_PANE}
			onSizeChange={(size) => onResize(split.id, typeof size === "string" ? Number.parseFloat(size) : Number.NaN)}
			style={style}
		>
			{content}
		</Panel>
	);
}
