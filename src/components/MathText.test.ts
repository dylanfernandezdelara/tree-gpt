import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MathText } from "./MathText";

const render = (text: string, inline?: boolean) => renderToStaticMarkup(createElement(MathText, { text, inline }));

describe("MathText", () => {
	it("returns text without math untouched", () => {
		expect(render("a *b* $5 & <c>")).toBe("a *b* $5 &amp; &lt;c&gt;");
	});

	it("sets display math as a block, or inline for one-line previews", () => {
		const text = "Roots of $ax^2$:\n$$x = \\frac{-b}{2a}$$";
		expect(render(text)).toContain("katex-display");
		const preview = render(text, true);
		expect(preview).not.toContain("katex-display");
		expect(preview.split('class="katex"').length - 1).toBe(2);
	});

	it("shows malformed TeX as an inline error, not a crash", () => {
		expect(render("bad $\\frac{a$ here")).toContain("katex-error");
	});

	it("keeps a display block apart from the words around it in a preview", () => {
		const text = renderToStaticMarkup(createElement(MathText, { text: "are:\n$$x$$\nSo", inline: true }))
			.replace(/<span class="katex">[\s\S]*?<\/math><\/span>/g, "")
			.replace(/<[^>]+>/g, "");
		expect(text.split(/\s+/).filter(Boolean)).toEqual(["are:", "x", "So"]);
	});
});
