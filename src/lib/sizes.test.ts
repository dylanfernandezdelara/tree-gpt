import { describe, expect, it } from "vitest";
import {
	setSplitSize,
	splitPane,
	swapPanes,
	validateLayout,
	type LayoutNode,
} from "./layout";

const pane = (id: string): LayoutNode => ({ kind: "pane", id, chatId: id });
const split = (
	id: string,
	a: LayoutNode,
	b: LayoutNode,
	size = 50,
	sized: 0 | 1 = 0,
): LayoutNode => ({ kind: "split", id, direction: "row", size, sized, children: [a, b] });
const asSplit = (node: LayoutNode) => {
	if (node.kind !== "split") {
		throw new Error("expected a split");
	}
	return node;
};

describe("split sizes", () => {
	it("opens a fresh split at an even half with the first child sized", () => {
		const { root } = splitPane(pane("only"), "only", "right", "new");
		const node = asSplit(root);
		expect(node.size).toBe(50);
		expect(node.sized).toBe(0);
	});

	it("resizes a split and leaves the rest of the tree alone", () => {
		const root = split("s0", split("s1", pane("a"), pane("b")), pane("c"));
		const next = asSplit(setSplitSize(root, "s1", 30));
		expect(asSplit(next.children[0]).size).toBe(30);
		expect(next.size).toBe(50);
		expect(next.children[1]).toBe((root as Extract<LayoutNode, { kind: "split" }>).children[1]);
	});

	it("clamps sizes inside the group and ignores garbage", () => {
		const root = split("s0", pane("a"), pane("b"));
		expect(asSplit(setSplitSize(root, "s0", 0)).size).toBe(1);
		expect(asSplit(setSplitSize(root, "s0", 150)).size).toBe(99);
		expect(setSplitSize(root, "s0", Number.NaN)).toBe(root);
		expect(setSplitSize(root, "missing", 30)).toBe(root);
	});
});

describe("swap keeps sizes on the panes", () => {
	it("flips the sized slot when siblings trade places", () => {
		const root = split("s0", pane("a"), pane("b"), 30, 0);
		const next = asSplit(swapPanes(root, "a", "b"));
		expect(next.children.map((child) => child.id)).toEqual(["b", "a"]);
		expect(next.sized).toBe(1);
		expect(next.size).toBe(30);
	});

	it("flips back when they trade again", () => {
		const root = split("s0", pane("a"), pane("b"), 30, 1);
		const next = asSplit(swapPanes(root, "b", "a"));
		expect(next.children.map((child) => child.id)).toEqual(["b", "a"]);
		expect(next.sized).toBe(0);
	});

	it("leaves both splits' geometry alone across splits", () => {
		const root = split(
			"s0",
			split("s1", pane("a"), pane("b"), 30, 0),
			split("s2", pane("c"), pane("d"), 70, 1),
		);
		const next = asSplit(swapPanes(root, "a", "d"));
		const left = asSplit(next.children[0]);
		const right = asSplit(next.children[1]);
		expect(left.children.map((child) => child.id)).toEqual(["d", "b"]);
		expect(right.children.map((child) => child.id)).toEqual(["c", "a"]);
		expect([left.size, left.sized]).toEqual([30, 0]);
		expect([right.size, right.sized]).toEqual([70, 1]);
	});
});

describe("validateLayout sizes", () => {
	const chats = new Set(["a", "b"]);

	it("reads layouts saved before dividers as an even half", () => {
		const node = validateLayout(
			{
				kind: "split",
				id: "s0",
				direction: "row",
				children: [
					{ kind: "pane", id: "a", chatId: "a" },
					{ kind: "pane", id: "b", chatId: "b" },
				],
			},
			chats,
		);
		expect(node).toMatchObject({ size: 50, sized: 0 });
	});

	it("keeps valid sizes and repairs the rest without dropping the tree", () => {
		const node = asSplit(
			validateLayout(
				{
					kind: "split",
					id: "s0",
					direction: "row",
					size: 250,
					sized: 2,
					children: [
						{ kind: "pane", id: "a", chatId: "a" },
						{ kind: "pane", id: "b", chatId: "b" },
					],
				},
				chats,
			)!,
		);
		expect(node.size).toBe(99);
		expect(node.sized).toBe(0);
	});
});
