import { afterEach, describe, expect, it } from "vitest";
import {
	clearThreadViews,
	clampScrollTop,
	rememberThreadView,
	scrollTopForMount,
	takeThreadView,
} from "./thread-view";

afterEach(() => {
	clearThreadViews();
});

describe("scrollTopForMount", () => {
	it("does not jump the source chat to the bottom after a fork remount", () => {
		// Mid-thread, then the layout split remounts this pane.
		const saved = { scrollTop: 640, quote: { messageId: "m2", quote: "tangent" } };
		expect(scrollTopForMount(saved, 4000, 800)).toBe(640);
		expect(scrollTopForMount(saved, 4000, 800)).not.toBe(4000);
	});

	it("keeps a source thread at the top, not only mid-scroll", () => {
		expect(scrollTopForMount({ scrollTop: 0 }, 4000, 800)).toBe(0);
	});

	it("still opens a new fork pane at the bottom", () => {
		rememberThreadView("source", { scrollTop: 640 });
		expect(scrollTopForMount(takeThreadView("fork"), 1800, 700)).toBe(1800);
	});

	it("clamps a saved offset when the remounted pane is shorter", () => {
		expect(scrollTopForMount({ scrollTop: 9999 }, 1000, 400)).toBe(600);
	});
});

describe("takeThreadView", () => {
	it("returns the source snapshot once, including the forked passage", () => {
		rememberThreadView("source", {
			scrollTop: 640,
			quote: { messageId: "m2", quote: "tangent" },
		});
		expect(takeThreadView("source")).toEqual({
			scrollTop: 640,
			quote: { messageId: "m2", quote: "tangent" },
		});
		expect(takeThreadView("source")).toBeUndefined();
	});

	it("does not hand the source scroll to the newly opened fork pane", () => {
		rememberThreadView("source", { scrollTop: 640 });
		expect(takeThreadView("fork")).toBeUndefined();
		expect(takeThreadView("source")?.scrollTop).toBe(640);
	});

	it("keeps a quote when a remount only re-saves scrollTop", () => {
		rememberThreadView("source", {
			scrollTop: 200,
			quote: { messageId: "m1", quote: "hello" },
		});
		rememberThreadView("source", { scrollTop: 210 });
		expect(takeThreadView("source")).toEqual({
			scrollTop: 210,
			quote: { messageId: "m1", quote: "hello" },
		});
	});
});

describe("clampScrollTop", () => {
	it("does not invert a valid mid-thread offset", () => {
		expect(clampScrollTop(420, 4000, 800)).toBe(420);
	});
});
