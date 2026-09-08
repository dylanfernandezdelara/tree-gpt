import { describe, expect, it } from "vitest";
import { BLURBS, blurbFor } from "./blurbs";
import { newId } from "./id";

describe("BLURBS", () => {
	it("gives every entry an icon, a title and a body", () => {
		expect(BLURBS.length).toBeGreaterThan(0);
		for (const blurb of BLURBS) {
			expect(blurb.title.trim()).not.toBe("");
			expect(blurb.body.trim()).not.toBe("");
			expect(typeof blurb.Icon).toBe("function");
		}
	});
});

describe("blurbFor", () => {
	it("always returns the same blurb for one pane", () => {
		// A split remounts the pane; its tip must survive that unchanged.
		const id = newId();
		const first = blurbFor(id);
		for (let i = 0; i < 50; i++) {
			expect(blurbFor(id)).toBe(first);
		}
	});

	it("picks independently across panes", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			seen.add(blurbFor(newId()).title);
		}
		expect(seen.size).toBe(BLURBS.length);
	});

	it("spreads roughly evenly over many panes", () => {
		const counts = new Map<string, number>();
		const draws = 3000;
		for (let i = 0; i < draws; i++) {
			const title = blurbFor(newId()).title;
			counts.set(title, (counts.get(title) ?? 0) + 1);
		}
		// No bucket should be starved or dominant; a fair share is 1/3 here.
		for (const blurb of BLURBS) {
			const share = (counts.get(blurb.title) ?? 0) / draws;
			expect(share).toBeGreaterThan(0.25);
			expect(share).toBeLessThan(0.42);
		}
	});

	it("handles an empty id without throwing", () => {
		expect(BLURBS).toContain(blurbFor(""));
	});
});
