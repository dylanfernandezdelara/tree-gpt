import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { MessageView } from "./Message";

function render(message: Message) {
	return renderToStaticMarkup(
		createElement(MessageView, { message, isLast: true, onRedo: () => {} }),
	);
}

function count(html: string, needle: string) {
	return html.split(needle).length - 1;
}

const searched: Message = {
	id: "m2",
	role: "assistant",
	content: "Carlos Alcaraz won.",
	createdAt: 2,
	toolCalls: [
		{
			id: "web_search",
			name: "web_search",
			query: "US Open winner today",
			state: "output-available",
		},
	],
	citations: [{ url: "https://www.example.com/us-open", title: "US Open results" }],
};

/** Strings from the retired homemade rows, badge pills and stock AI Elements chrome. */
const retired = [
	"thinking-dot",
	"<summary",
	"Used 1 sources",
	"Completed",
	"Chain of Thought",
	"Web search",
	">Sources<",
	'aria-label="Composing…"',
];

describe("MessageView chain of thought", () => {
	it("opens with a Searching header, the searching orb and the query as a step", () => {
		const html = render({
			...searched,
			content: "",
			citations: undefined,
			pending: true,
			toolCalls: [{ ...searched.toolCalls![0], state: "input-available" }],
		});
		expect(html).toContain(">Searching<");
		expect(html).toContain(">US Open winner today<");
		expect(html).toContain("lucide-search");
		expect(html).not.toContain(">Thinking<");
		expect(html).not.toContain(">Thought<");
		// The header glyph is the searching orb, not the landed brain icon.
		expect(html).toContain("<canvas");
		expect(html).toContain('aria-label="Searching…"');
		expect(html).not.toContain("lucide-brain");
		// The header is the only status word; no duplicate step says Searching.
		expect(count(html, ">Searching<")).toBe(1);
		for (const text of retired) {
			expect(html).not.toContain(text);
		}
	});

	it("lists every search and each visited URL as its own step alongside the draft", () => {
		const html = render({
			...searched,
			content: "Carlos",
			pending: true,
			citations: [
				searched.citations![0],
				{ url: "https://www.usopen.org/scores" },
			],
			toolCalls: [
				{ id: "a", name: "web_search", query: "US Open winner", state: "output-available" },
				{ id: "b", name: "web_search", query: "US Open final score", state: "input-available" },
			],
		});
		expect(html).toContain(">Searching<");
		expect(html).toContain(">US Open winner<");
		expect(html).toContain(">US Open final score<");
		// Citations are plain links on the rail: title when known, hostname otherwise.
		expect(html).toContain(">US Open results</a>");
		expect(html).toContain(">usopen.org</a>");
		expect(html).toContain('href="https://www.example.com/us-open"');
		expect(html).toContain('href="https://www.usopen.org/scores"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain("lucide-globe");
		expect(html).toContain("text-muted-foreground");
		expect(html).toContain("leading-6");
		// Official spacing, not the tight override.
		expect(html).toContain("space-y-3");
		expect(html).not.toContain("mt-0 space-y-2");
		expect(html).toContain("Carlos");
		expect(html).toContain("markdown--live");
		for (const text of retired) {
			expect(html).not.toContain(text);
		}
	});

	it("shows only the Thinking header and orb with no activity yet", () => {
		const html = render({
			...searched,
			content: "",
			toolCalls: undefined,
			citations: undefined,
			pending: true,
		});
		expect(html).toContain(">Thinking<");
		expect(count(html, ">Thinking<")).toBe(1);
		expect(html).not.toContain("Searching<");
		expect(html).not.toContain("lucide-search");
		expect(html).not.toContain("lucide-globe");
		expect(html).not.toContain("lucide-lightbulb");
		// Pending always shows the searching orb, never composing.
		expect(html).toContain("<canvas");
		expect(html).toContain('aria-label="Searching…"');
		expect(html).not.toContain('aria-label="Composing…"');
	});

	it("shows each reasoning paragraph as a lightbulb step under a Thinking header", () => {
		const html = render({
			...searched,
			content: "",
			toolCalls: undefined,
			citations: undefined,
			reasoning: "Identifying the winner.\n\nChecking the final score.",
			pending: true,
		});
		expect(html).toContain(">Thinking<");
		expect(count(html, ">Thinking<")).toBe(1);
		expect(html).toContain("Identifying the winner.");
		expect(html).toContain("Checking the final score.");
		expect(count(html, "lucide-lightbulb")).toBe(2);
		expect(html).toContain("leading-6");
		expect(html).not.toContain("Searching<");
	});

	it("collapses to a single Thought row once the reply lands", () => {
		const html = render({ ...searched, reasoning: "Check the result." });
		expect(html).toContain(">Thought<");
		expect(html).not.toContain(">Searching<");
		expect(html).not.toContain(">Thinking<");
		expect(html).toContain("Carlos Alcaraz won.");
		expect(html).not.toContain("error-box");
		// Landed: brain icon, no orb, no live shimmer.
		expect(html).toContain("lucide-brain");
		expect(html).not.toContain("<canvas");
		expect(html).not.toContain("markdown--live");
		for (const text of retired) {
			expect(html).not.toContain(text);
		}
		// Base UI may omit closed panel content from static markup; when it is
		// there, it must be the same steps the live view showed.
		if (html.includes("US Open winner today")) {
			expect(html).toContain(">US Open winner today<");
			expect(html).toContain(">US Open results</a>");
			expect(html).toContain('href="https://www.example.com/us-open"');
		}
		expect(html.indexOf(">Thought<")).toBeLessThan(html.indexOf("Carlos Alcaraz won."));
	});

	it("keeps a line break after a bold title so Muse sections do not smash", () => {
		const html = render({
			id: "m3",
			role: "assistant",
			createdAt: 3,
			content:
				"**2. Split to chase a tangent**\nFork the whole chat to explore a \"what if?\" or side-question.",
		});
		expect(html).toMatch(/tangent<\/strong><br\s*\/?>\s*Fork the whole chat/);
		expect(html).not.toContain("tangent</strong> Fork");
	});

	it("omits the chain entirely on a plain landed reply", () => {
		const html = render({ ...searched, toolCalls: undefined, citations: undefined });
		expect(html).toContain("Carlos Alcaraz won.");
		expect(html).not.toContain("Thought");
		expect(html).not.toContain("collapsible");
	});

	it("shows no chain chrome on error replies", () => {
		const html = render({ ...searched, content: "Upstream failed", error: true });
		expect(html).toContain("Upstream failed");
		expect(html).toContain("Retry");
		expect(html).not.toContain("Thought");
		expect(html).not.toContain("Searching");
		expect(html).not.toContain("Searched");
		expect(html).not.toContain("Sources");
		expect(html).not.toContain("Chain of Thought");
	});
});
