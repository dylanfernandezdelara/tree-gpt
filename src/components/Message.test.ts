import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { MessageView } from "./Message";

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

describe("MessageView search UI", () => {
	it("renders a completed Tool chip and Sources under the reply", () => {
		const html = renderToStaticMarkup(
			createElement(MessageView, { message: searched, isLast: true, onRedo: () => {} }),
		);
		expect(html).toContain("Web search");
		expect(html).toContain("Completed");
		expect(html).toContain("US Open winner today");
		expect(html).toContain("Used 1 sources");
		expect(html).toContain("Carlos Alcaraz won.");
	});
});
