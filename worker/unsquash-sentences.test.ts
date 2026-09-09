import { describe, expect, it } from "vitest";
import { createContentAssembler, unsquashSentences } from "./unsquash-sentences.js";

/** Same running prefix the complete-reply path uses. */
function appendAll(chunks: string[]): string {
	let prefix = "";
	for (const chunk of chunks) {
		prefix = unsquashSentences(prefix + chunk);
	}
	return prefix;
}

/** Live stream: concatenating assembler deltas must match the full repair. */
function assembleAll(chunks: string[]): { visible: string; deltas: string[] } {
	const assembler = createContentAssembler();
	const deltas: string[] = [];
	for (const chunk of chunks) {
		const delta = assembler.push(chunk);
		if (delta.length > 0) {
			deltas.push(delta);
		}
	}
	const tail = assembler.flush();
	if (tail.length > 0) {
		deltas.push(tail);
	}
	return { visible: deltas.join(""), deltas };
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
		{
			name: "smash at the start of the reply",
			chunks: ["Hello.World is here"],
			want: "Hello. World is here",
		},
		{
			name: "short prose word before the period",
			chunks: ["Yes.The kickoff is tonight"],
			want: "Yes. The kickoff is tonight",
		},
		{
			name: "next sentence starts with I",
			chunks: ["tonight's games.I think the 49ers cover"],
			want: "tonight's games. I think the 49ers cover",
		},
		{
			name: "next sentence starts with I'd",
			chunks: ["games.I'd take the over"],
			want: "games. I'd take the over",
		},
		{
			name: "next sentence starts with A",
			chunks: ["games.A late score decided it"],
			want: "games. A late score decided it",
		},
		{
			name: "question smash",
			chunks: ["really?Yes it is"],
			want: "really? Yes it is",
		},
		{
			name: "single newline after a period (Muse sentence break)",
			chunks: ["tonight's games.\nTomorrow's opener is set"],
			want: "tonight's games. Tomorrow's opener is set",
		},
		{
			name: "CRLF sentence break",
			chunks: ["tonight's games.\r\nTomorrow's opener is set"],
			want: "tonight's games. Tomorrow's opener is set",
		},
		{
			name: "literal backslash-n after a period",
			chunks: ["tonight's games.\\nTomorrow's opener is set"],
			want: "tonight's games. Tomorrow's opener is set",
		},
		{
			name: "blank line stays a paragraph break",
			chunks: ["First paragraph ends here.\n\nSecond paragraph starts here."],
			want: "First paragraph ends here.\n\nSecond paragraph starts here.",
		},
		{
			name: "title/body newline is not a sentence smash",
			chunks: [
				"**2. Split to chase a tangent**\nFork the whole chat to explore a side-question.",
			],
			want: "**2. Split to chase a tangent**\nFork the whole chat to explore a side-question.",
		},
		{
			name: "numbered list stays",
			chunks: ["1. First item\n2. Second item"],
			want: "1. First item\n2. Second item",
		},
		{
			name: "fenced code is not repaired",
			chunks: ["See this:\n\n```\nreturn games.\nTomorrow\n```\nDone."],
			want: "See this:\n\n```\nreturn games.\nTomorrow\n```\nDone.",
		},
		{
			name: "quoted next sentence",
			chunks: ['He stopped.\"The'],
			want: 'He stopped. "The',
		},
		{
			name: "curly-quoted next sentence",
			chunks: ["He stopped.“The crowd roared."],
			want: "He stopped. “The crowd roared.",
		},
		{
			name: "ellipsis smash",
			chunks: ["wait...Tomorrow"],
			want: "wait... Tomorrow",
		},
		{
			name: "unicode sentence punct and capital",
			chunks: ["Voilà.Émile est là"],
			want: "Voilà. Émile est là",
		},
		{
			name: "We after a period does not need an I/A special case",
			chunks: ["games.We win"],
			want: "games. We win",
		},
		{
			name: "inline code is not repaired",
			chunks: ["Use `games.Tomorrow` in the snippet."],
			want: "Use `games.Tomorrow` in the snippet.",
		},
		{
			name: "list after a period keeps the newline",
			chunks: ["Pick one.\n- First\n- Second"],
			want: "Pick one.\n- First\n- Second",
		},
		{
			name: "heading after a period keeps the newline",
			chunks: ["Intro.\n# Title"],
			want: "Intro.\n# Title",
		},
		{
			name: "unicode line separator after a period",
			chunks: ["games.\u2028Tomorrow"],
			want: "games. Tomorrow",
		},
	])("$name", ({ chunks, want }) => {
		expect(appendAll(chunks)).toBe(want);
		expect(unsquashSentences(chunks.join(""))).toBe(want);
		expect(assembleAll(chunks).visible).toBe(want);
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
		expect(assembleAll(chunks).visible).toBe(want);
	});
});

describe("createContentAssembler", () => {
	it("holds a newline after a period until the next sentence arrives", () => {
		const { deltas, visible } = assembleAll(["tonight's games.", "\n", "Tomorrow"]);
		expect(visible).toBe("tonight's games. Tomorrow");
		expect(deltas.join("").includes("\n")).toBe(false);
	});

	it("releases a held newline when the next chunk is another blank line", () => {
		expect(assembleAll(["First paragraph ends here.", "\n", "\n", "Second"]).visible).toBe(
			"First paragraph ends here.\n\nSecond",
		);
	});

	it("flushes a trailing newline at end of stream", () => {
		expect(assembleAll(["games.", "\n"]).visible).toBe("games.\n");
	});

	it("forwards a newline-only chunk that is not a sentence break", () => {
		expect(assembleAll(["**Title**", "\n", "Body"]).visible).toBe("**Title**\nBody");
	});
});
