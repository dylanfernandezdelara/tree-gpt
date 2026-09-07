import type { ReactNode } from "react";
import type { LayoutNode, PaneLeaf } from "../lib/layout";

type Props = {
	root: LayoutNode;
	renderPane: (pane: PaneLeaf) => ReactNode;
};

/** Renders the split tree: nested 50/50 flex rows and columns down to the panes. */
export function PaneLayout({ root, renderPane }: Props) {
	if (root.kind === "pane") {
		return <>{renderPane(root)}</>;
	}
	return (
		<div className={`split split--${root.direction}`}>
			{root.children.map((child) => (
				<div key={child.id} className="split__cell">
					<PaneLayout root={child} renderPane={renderPane} />
				</div>
			))}
		</div>
	);
}
