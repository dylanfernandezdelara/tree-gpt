import { describe, expect, it } from "vitest";
import { nextChromeHidden } from "./hide-on-scroll";

const mid = { maxY: 800, mobile: true as const };

describe("nextChromeHidden", () => {
	it("never hides off a phone", () => {
		expect(nextChromeHidden({ hidden: false, y: 200, lastY: 100, maxY: 800, mobile: false })).toBe(
			false,
		);
		expect(nextChromeHidden({ hidden: true, y: 200, lastY: 100, maxY: 800, mobile: false })).toBe(
			false,
		);
	});

	it("hides when scrolling down past the top", () => {
		expect(nextChromeHidden({ hidden: false, y: 40, lastY: 20, ...mid })).toBe(true);
	});

	it("shows when scrolling up", () => {
		expect(nextChromeHidden({ hidden: true, y: 20, lastY: 40, ...mid })).toBe(false);
	});

	it("shows at the top of the surface", () => {
		expect(nextChromeHidden({ hidden: true, y: 8, lastY: 20, ...mid })).toBe(false);
	});

	it("shows after a jump to the top, even a large one", () => {
		expect(nextChromeHidden({ hidden: true, y: 0, lastY: 900, maxY: 900, mobile: true })).toBe(
			false,
		);
	});

	it("ignores programmatic jumps and finger jitter", () => {
		expect(nextChromeHidden({ hidden: false, y: 800, lastY: 0, ...mid })).toBe(false);
		expect(nextChromeHidden({ hidden: true, y: 800, lastY: 0, ...mid })).toBe(true);
		expect(nextChromeHidden({ hidden: false, y: 22, lastY: 20, ...mid })).toBe(false);
	});

	it("does not hide when stick-to-bottom adds a new bubble", () => {
		expect(
			nextChromeHidden({ hidden: false, y: 500, lastY: 420, maxY: 500, mobile: true }),
		).toBe(false);
		expect(
			nextChromeHidden({ hidden: true, y: 500, lastY: 420, maxY: 500, mobile: true }),
		).toBe(true);
	});

	it("hides on a real swipe that is larger than jitter", () => {
		expect(nextChromeHidden({ hidden: false, y: 160, lastY: 40, ...mid })).toBe(true);
	});

	it("keeps the current state for a tiny move mid-thread", () => {
		expect(nextChromeHidden({ hidden: true, y: 120, lastY: 116, ...mid })).toBe(true);
	});
});
