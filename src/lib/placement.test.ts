import { describe, expect, it } from "vitest";
import { listPanes, placeBeside, rightNeighbor, type LayoutNode } from "./layout";

const pane = (id: string): LayoutNode => ({ kind: "pane", id, chatId: id });
const split = (
	id: string,
	direction: "row" | "column",
	a: LayoutNode,
	b: LayoutNode,
): LayoutNode => ({ kind: "split", id, direction, children: [a, b] });

/** Four equal columns, the widest a row can get under the 4x4 rule. */
const fourColumns = split(
	"s0",
	"row",
	split("s1", "row", pane("a"), pane("b")),
	split("s2", "row", pane("c"), pane("d")),
);

const chatIdOf = (root: LayoutNode, paneId: string) =>
	listPanes(root).find((p) => p.id === paneId)?.chatId;

describe("rightNeighbor", () => {
	it("finds the pane on the right, across split boundaries", () => {
		expect(rightNeighbor(fourColumns, "a")?.id).toBe("b");
		expect(rightNeighbor(fourColumns, "b")?.id).toBe("c");
	});

	it("is null in the rightmost column", () => {
		expect(rightNeighbor(fourColumns, "d")).toBeNull();
	});
});

describe("placeBeside", () => {
	it("splits to the right when there is room", () => {
		const placed = placeBeside(pane("only"), "only", "new");
		const panes = listPanes(placed.root);
		expect(panes).toHaveLength(2);
		expect(panes[1].id).toBe(placed.paneId);
		expect(panes[1].chatId).toBe("new");
		expect(panes[0].chatId).toBe("only");
	});

	it("reuses the pane on the right once the row is full", () => {
		const placed = placeBeside(fourColumns, "a", "new");
		expect(listPanes(placed.root)).toHaveLength(4);
		expect(placed.paneId).toBe("b");
		expect(chatIdOf(placed.root, "b")).toBe("new");
		expect(chatIdOf(placed.root, "a")).toBe("a");
	});

	it("splits downward from the rightmost column", () => {
		const placed = placeBeside(fourColumns, "d", "new");
		expect(listPanes(placed.root)).toHaveLength(5);
		expect(chatIdOf(placed.root, placed.paneId)).toBe("new");
		expect(chatIdOf(placed.root, "d")).toBe("d");
	});

	it("takes over the pane itself when there is no room left", () => {
		// "d" is in the rightmost column and already stacked two deep.
		const full = split(
			"s0",
			"row",
			split("s1", "row", pane("a"), pane("b")),
			split(
				"s2",
				"row",
				pane("c"),
				split("v1", "column", split("v2", "column", pane("d"), pane("x")), pane("y")),
			),
		);
		const placed = placeBeside(full, "d", "new");
		expect(placed.paneId).toBe("d");
		expect(listPanes(placed.root)).toHaveLength(6);
		expect(chatIdOf(placed.root, "d")).toBe("new");
	});

	it("leaves the layout alone when the pane is gone", () => {
		const placed = placeBeside(fourColumns, "missing", "new");
		expect(placed.root).toBe(fourColumns);
	});
});
