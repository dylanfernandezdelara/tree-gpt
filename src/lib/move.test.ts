import { describe, expect, it } from "vitest";
import { dropAbility, pointerTargetAt, type LayoutNode, type PaneRect } from "./layout";

const rect = (paneId: string, x: number, headerHeight = 40): PaneRect => ({
	paneId,
	x,
	y: 0,
	width: 400,
	height: 800,
	headerHeight,
});

describe("pointerTargetAt", () => {
	const panes = [rect("a", 0), rect("b", 414)];

	it("swaps on the header band and zones the body", () => {
		expect(pointerTargetAt(panes, 500, 20, "a")).toEqual({ paneId: "b", target: "swap" });
		expect(pointerTargetAt(panes, 424, 400, "a")).toEqual({ paneId: "b", target: "left" });
		expect(pointerTargetAt(panes, 804, 400, "a")).toEqual({ paneId: "b", target: "right" });
		expect(pointerTargetAt(panes, 614, 400, "a")).toEqual({ paneId: "b", target: "center" });
	});

	it("ignores the moving pane itself, so dropping home cancels", () => {
		expect(pointerTargetAt(panes, 200, 400, "a")).toBeNull();
	});

	it("bridges the divider seam between two panes", () => {
		// The 14px strip at x 400-414 belongs to neither rect, but a pointer
		// crossing it must not flicker the preview off.
		expect(pointerTargetAt(panes, 407, 400, "c")?.paneId).toBe("a");
	});

	it("finds nothing outside every pane", () => {
		expect(pointerTargetAt(panes, 2000, 400, "c")).toBeNull();
	});

	it("zones the whole pane when it shows no header", () => {
		const panes = [rect("a", 0, 0)];
		expect(pointerTargetAt(panes, 200, 10, "c")).toEqual({ paneId: "a", target: "top" });
	});
});

describe("pane drop abilities", () => {
	const root: LayoutNode = {
		kind: "split",
		id: "s0",
		direction: "row",
		size: 50,
		sized: 0,
		children: [
			{ kind: "pane", id: "a", chatId: "a" },
			{ kind: "pane", id: "b", chatId: "b" },
		],
	};

	it("lets a pane land anywhere on another pane, including the middle", () => {
		expect(dropAbility(root, "b", { kind: "pane", paneId: "a" })).toEqual({
			sides: { left: true, right: true, top: true, bottom: true, center: true },
			swap: true,
		});
	});

	it("accepts nothing from the pane itself", () => {
		expect(dropAbility(root, "a", { kind: "pane", paneId: "a" })).toEqual({
			sides: { left: false, right: false, top: false, bottom: false, center: false },
			swap: false,
		});
	});
});
