import { describe, expect, it } from "vitest";
import { unsquashSentences } from "./unsquash-sentences.js";

/** Same running prefix the stream uses. */
function appendAll(chunks: string[]): string {
	let prefix = "";
	for (const chunk of chunks) {
		prefix = unsquashSentences(prefix + chunk);
	}
	return prefix;
}

describe("unsquashSentences", () => {
	it.each([
		{
			name: "Muse sentence-sized smash",
			chunks: [
				"I'll pull up the latest projections for tomorrow's games.",
				"Tomorrow's 49ers-Rams opener is set — now I'll check the projections for that matchup.",
				"For tomorrow - Thursday, September 10, 2026 - fantasy is all about 1 game:",
			],
			want: "I'll pull up the latest projections for tomorrow's games. Tomorrow's 49ers-Rams opener is set — now I'll check the projections for that matchup. For tomorrow - Thursday, September 10, 2026 - fantasy is all about 1 game:",
		},
		{
			name: "Luna tokens at a sentence period",
			chunks: ["tonight's games", ".", "Tomorrow"],
			want: "tonight's games. Tomorrow",
		},
		{
			name: "already spaced",
			chunks: ["Hello", " there"],
			want: "Hello there",
		},
		{
			name: "in-chunk smash after a prose word",
			chunks: ["Hello there.Next"],
			want: "Hello there. Next",
		},
	])("$name", ({ chunks, want }) => {
		expect(appendAll(chunks)).toBe(want);
		expect(unsquashSentences(chunks.join(""))).toBe(want);
	});

	it.each([
		["The U.S. Army", ["The ", "U.", "S.", " Army"]],
		["Ph.D", ["Ph.D"]],
		["user.ID", ["user.ID"]],
		["ctx.DB", ["ctx.DB"]],
		["foo.Bar()", ["foo", ".", "Bar()"]],
		["www.OpenAI.com", ["www.OpenAI.com"]],
		["https://x.com/search?Q=test", ["https://x.com/search?Q=test"]],
		["name.Surname@x.com", ["name.Surname@x.com"]],
	])("leaves %s intact", (want, chunks) => {
		expect(appendAll(chunks)).toBe(want);
		expect(unsquashSentences(chunks.join(""))).toBe(want);
	});
});
