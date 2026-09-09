import { describe, expect, it } from "vitest";
import { nextChromeHidden } from "./hide-on-scroll";

describe("nextChromeHidden", () => {
	it("never hides off a phone", () => {
		expect(nextChromeHidden({ hidden: false, y: 200, lastY: 100, mobile: false })).toBe(false);
		expect(nextChromeHidden({ hidden: true, y: 200, lastY: 100, mobile: false })).toBe(false);
	});

	it("hides when scrolling down past the top", () => {
		expect(nextChromeHidden({ hidden: false, y: 40, lastY: 20, mobile: true })).toBe(true);
	});

	it("shows when scrolling up", () => {
		expect(nextChromeHidden({ hidden: true, y: 20, lastY: 40, mobile: true })).toBe(false);
	});

	it("shows at the top of the surface", () => {
		expect(nextChromeHidden({ hidden: true, y: 8, lastY: 20, mobile: true })).toBe(false);
	});

	it("ignores programmatic jumps and finger jitter", () => {
		expect(nextChromeHidden({ hidden: false, y: 800, lastY: 0, mobile: true })).toBe(false);
		expect(nextChromeHidden({ hidden: false, y: 22, lastY: 20, mobile: true })).toBe(false);
	});

	it("hides on a real swipe that is larger than jitter", () => {
		expect(nextChromeHidden({ hidden: false, y: 160, lastY: 40, mobile: true })).toBe(true);
	});

	it("keeps the current state for a tiny move mid-thread", () => {
		expect(nextChromeHidden({ hidden: true, y: 120, lastY: 116, mobile: true })).toBe(true);
	});
});
