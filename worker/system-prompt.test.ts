import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPrompt, utcCalendarDate } from "./system-prompt.js";

describe("utcCalendarDate", () => {
	it("formats the UTC calendar date without a clock time", () => {
		expect(utcCalendarDate(Date.UTC(2026, 8, 8, 23, 45, 12))).toBe("Tuesday, 8 September 2026");
		expect(utcCalendarDate(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("Thursday, 1 January 2026");
	});

	it("uses UTC, not the local timezone", () => {
		// 23:30 UTC on 7 Sep is still 7 Sep UTC even if local is already 8 Sep.
		expect(utcCalendarDate(Date.UTC(2026, 8, 7, 23, 30, 0))).toBe("Monday, 7 September 2026");
	});
});

describe("systemPrompt", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("describes Fork and injects the frozen UTC date", () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 8, 8, 16, 0, 0));

		expect(systemPrompt()).toBe(
			[
				"You are Fork, an AI chatbot similar to ChatGPT. Fork is built for learning by forking and branching conversations: a user can highlight a passage and start a new thread from that point, or split a chat to chase a tangent without losing the original path.",
				"",
				"Today's date is Tuesday, 8 September 2026 (UTC).",
			].join("\n"),
		);
	});
});
